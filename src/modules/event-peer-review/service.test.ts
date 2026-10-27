import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import {
  DEFAULT_EVENT_COMMUNITY, type EventCommunityConfig,
  type HostedEventAccessPort, type HostedEventScope, type OrganizerPrincipal,
} from "../../shared/organizer-contracts.ts";
import { createEventPeerReviewService } from "./service.ts";
import type { EventPeerReviewSourcePort, PeerReviewDisclosure, PeerReviewWork } from "./model.ts";

/**
 * 数值互评服务的行为验收（每例一个隔离的内存 PGlite）。
 *
 * 覆盖：三层门禁缺一即 403 且零行落库、非参赛者/自评/维度/量纲错误、修改的版本规则、
 * 幂等、撤回与重提、参与率门槛、匿名投影、跨赛事读不到、归档只读、举报只记事实，
 * 以及"与评审分列"——提交互评前后评审侧原始汇总逐字段不变、只写 epr_ 自己的表。
 */
const currentTime = "2026-10-16T08:00:00.000Z";
const users = ["alice", "bob", "carol", "dave", "erin", "member", "outsider"];
const dimensions = [{ id: "d1", label: "创意" }, { id: "d2", label: "完成度" }];

function community(overrides: Partial<EventCommunityConfig> = {}): EventCommunityConfig {
  return { ...DEFAULT_EVENT_COMMUNITY, workShowcase: true, peerReview: true, peerReviewScale: "1-5", peerReviewDimensions: [...dimensions], peerReviewPassRate: 0.3, ...overrides };
}

async function fixture(t: TestContext) {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.waitReady;
  await pg.exec("CREATE TABLE auth_users(id text PRIMARY KEY);\n" +
    "CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));\n" +
    "CREATE TABLE event_registration_teams(event_id text NOT NULL, id text NOT NULL, PRIMARY KEY(event_id, id));");
  for (const userId of users) await pg.query("INSERT INTO auth_users(id) VALUES($1)", [userId]);
  for (const [eventId, org] of [["event-a", "org-a"], ["event-b", "org-b"], ["event-off", "org-a"], ["event-noreview", "org-a"], ["event-archived", "org-a"]] as const) {
    await pg.query("INSERT INTO organizer_hosted_events(id, organization_id) VALUES($1,$2)", [eventId, org]);
  }
  for (const [eventId, teamId] of [["event-a", "team-a"], ["event-a", "team-b"], ["event-a", "team-c"], ["event-a", "team-d"], ["event-b", "team-b"], ["event-off", "team-b"], ["event-noreview", "team-b"], ["event-archived", "team-x"]] as const) {
    await pg.query("INSERT INTO event_registration_teams(event_id, id) VALUES($1,$2)", [eventId, teamId]);
  }
  // 评审侧的原始汇总（外部事实）：本模块提交互评**不得**改动它。
  await pg.exec("CREATE TABLE fake_judging_scores(snapshot_id text PRIMARY KEY, team_id text NOT NULL, total integer NOT NULL, rank integer NOT NULL);");
  await pg.query("INSERT INTO fake_judging_scores(snapshot_id, team_id, total, rank) VALUES('snap-a2','team-a',80,1),('snap-b1','team-b',72,2)");
  await pg.exec(await readFile(new URL("./migrations/001-event-peer-review.sql", import.meta.url), "utf8"));

  const writes: string[] = [];
  function executor(query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(statement: string, params: readonly unknown[] = []) {
      if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(statement)) writes.push(statement);
      const result = await query(statement, [...params]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const database: DatabasePort = { ...executor((sql, params) => pg.query(sql, params)), transaction: work => pg.transaction(tx => work(executor((sql, params) => tx.query(sql, params)))) };

  const scope = (eventId: string, organizationId: string, status: HostedEventScope["status"], config: EventCommunityConfig): HostedEventScope => ({
    eventId, organizationId, organizationName: "机构" + organizationId, title: "赛事" + eventId, status, revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: "2026-10-10T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z",
    registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: "2026-10-14T00:00:00.000Z",
    modules: { registration: true, teams: true, judging: true, schedule: false, accommodation: false, mealVouchers: false, icebreaking: false },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
    community: config,
  });
  const scopes = new Map<string, HostedEventScope>([
    ["event-a", scope("event-a", "org-a", "published", community())],
    ["event-b", scope("event-b", "org-b", "published", community())],
    ["event-off", scope("event-off", "org-a", "published", community({ workShowcase: false }))],
    ["event-noreview", scope("event-noreview", "org-a", "published", community({ peerReview: false }))],
    ["event-archived", scope("event-archived", "org-a", "archived", community())],
  ]);
  const events: HostedEventAccessPort = {
    async getEvent(_sql, eventId) { return scopes.get(eventId) ?? null; },
    async requireStaff() { throw new DomainError("STAFF_REQUIRED", "本模块没有评委侧入口。", { status: 403 }); },
  };

  const work = (id: string, teamId: string, version: number, memberUserIds: readonly string[]): PeerReviewWork =>
    ({ id, teamId, version, submittedAt: "2026-10-13T00:00:00.000Z", memberUserIds });
  const workByEvent: Record<string, PeerReviewWork[]> = {
    "event-a": [work("snap-a1", "team-a", 1, ["alice", "member"]), work("snap-a2", "team-a", 2, ["alice", "member"]),
      work("snap-b1", "team-b", 1, ["bob"]), work("snap-c1", "team-c", 1, ["carol"]), work("snap-d1", "team-d", 1, ["dave"])],
    "event-b": [work("snap-bb1", "team-b", 1, ["member"])],
    "event-off": [work("snap-o1", "team-b", 1, ["bob"])],
    "event-noreview": [work("snap-n1", "team-b", 1, ["bob"])],
    "event-archived": [work("snap-x1", "team-x", 1, ["member"])],
  };
  const disclosure = (teamId: string, scopeValue: PeerReviewDisclosure["scope"], status: PeerReviewDisclosure["status"] = "active"): PeerReviewDisclosure => ({ teamId, scope: scopeValue, status });
  const disclosureByEvent: Record<string, PeerReviewDisclosure[]> = {
    "event-a": [disclosure("team-a", "participants"), disclosure("team-b", "public"), disclosure("team-c", "private")],
    "event-b": [disclosure("team-b", "public")],
    "event-off": [disclosure("team-b", "public")],
    "event-noreview": [disclosure("team-b", "public")],
    "event-archived": [disclosure("team-x", "public")],
  };
  const participantsByEvent: Record<string, readonly string[]> = {
    "event-a": ["alice", "bob", "carol", "dave", "erin"], "event-b": ["bob"], "event-off": ["bob"],
    "event-noreview": ["bob"], "event-archived": ["alice"],
  };
  const source: EventPeerReviewSourcePort = {
    async intakeWorks(_sql, eventId) { return workByEvent[eventId] ?? []; },
    async workDisclosures(_sql, eventId) { return disclosureByEvent[eventId] ?? []; },
    async approvedParticipantIds(_sql, eventId) { return participantsByEvent[eventId] ?? []; },
  };

  const revoked = new Set<string>();
  const principal = (userId: string, platformRoles: Actor["platformRoles"] = ["user"]): OrganizerPrincipal => ({
    actor: { userId, platformRoles },
    guard: async (sql: SqlExecutor) => { const row = await sql.query("SELECT id FROM auth_users WHERE id=$1", [userId]); if (!row.rows.length || revoked.has(userId)) throw new DomainError("SESSION_REVOKED", "会话已撤销。", { status: 401 }); },
  });
  let nextId = 0, nextKey = 0;
  const service = createEventPeerReviewService({ database, clock: { now: () => new Date(currentTime) }, ids: { next: () => "epr-" + String(++nextId) }, events, source });
  const key = (): string => "retry-" + String(++nextKey);
  const submit = (eventId: string, snapshotId: string, userId: string, values: Record<string, number>, idempotencyKey = key()) =>
    service.submitMyReview(principal(userId), eventId, snapshotId, { values, idempotencyKey });
  const rowCount = async (eventId = "event-a"): Promise<number> =>
    Number((await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM epr_peer_reviews WHERE event_id=$1", [eventId])).rows[0]!.count);
  const judgeRows = async () => (await pg.query("SELECT snapshot_id, team_id, total, rank FROM fake_judging_scores ORDER BY snapshot_id")).rows;
  return { pg, service, scopes, source, principal, key, submit, rowCount, judgeRows, writes };
}

const errorCode = (code: string, status?: number) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code && (status === undefined || error.status === status);

test("三层门禁缺一即 403（不是空数组），且被拒请求零行落库", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.getWork(f.principal("bob"), "event-off", "snap-o1"), errorCode("WORK_SHOWCASE_DISABLED", 403));
  await assert.rejects(f.submit("event-off", "snap-o1", "bob", { d1: 1, d2: 1 }), errorCode("WORK_SHOWCASE_DISABLED", 403));
  await assert.rejects(f.service.getWork(f.principal("bob"), "event-noreview", "snap-n1"), errorCode("PEER_REVIEW_DISABLED", 403));
  await assert.rejects(f.submit("event-noreview", "snap-n1", "bob", { d1: 1, d2: 1 }), errorCode("PEER_REVIEW_DISABLED", 403));
  // 队伍本人选择不公开（team-c）与根本没有披露记录（team-d）都拒绝。
  await assert.rejects(f.service.getWork(f.principal("bob"), "event-a", "snap-c1"), errorCode("PEER_REVIEW_NOT_DISCLOSED", 403));
  await assert.rejects(f.submit("event-a", "snap-c1", "bob", { d1: 1, d2: 1 }), errorCode("PEER_REVIEW_NOT_DISCLOSED", 403));
  await assert.rejects(f.service.getWork(f.principal("bob"), "event-a", "snap-d1"), errorCode("PEER_REVIEW_NOT_DISCLOSED", 403));
  assert.equal(await f.rowCount("event-a"), 0);
});

test("非参赛者、自评、非当前作品、非法维度与越界取值都被拒且零行落库", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.getWork(f.principal("bob"), "event-a", "snap-a1"), errorCode("PEER_REVIEW_WORK_NOT_CURRENT", 403));
  await assert.rejects(f.submit("event-a", "snap-a2", "outsider", { d1: 1, d2: 1 }), errorCode("PEER_REVIEW_PARTICIPANT_REQUIRED", 403));
  await assert.rejects(f.submit("event-a", "snap-a2", "alice", { d1: 1, d2: 1 }), errorCode("PEER_REVIEW_SELF_REVIEW", 403));
  await assert.rejects(f.submit("event-a", "snap-a2", "bob", { d1: 1 }), errorCode("PEER_REVIEW_DIMENSION_INVALID", 422));
  await assert.rejects(f.submit("event-a", "snap-a2", "bob", { d1: 1, d2: 1, d9: 1 }), errorCode("PEER_REVIEW_DIMENSION_INVALID", 422));
  await assert.rejects(f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", { values: "x" as never, idempotencyKey: f.key() }), errorCode("PEER_REVIEW_DIMENSION_INVALID", 422));
  await assert.rejects(f.submit("event-a", "snap-a2", "bob", { d1: 9, d2: 1 }), errorCode("PEER_REVIEW_VALUE_OUT_OF_RANGE", 422));
  await assert.rejects(f.submit("event-a", "snap-a2", "bob", { d1: 2.5, d2: 1 }), errorCode("PEER_REVIEW_VALUE_OUT_OF_RANGE", 422));
  await assert.rejects(f.submit("event-a", "snap-a2", "bob", { d1: 0, d2: 1 }), errorCode("PEER_REVIEW_VALUE_OUT_OF_RANGE", 422));
  await assert.rejects(f.submit("event-a", "snap-missing", "bob", { d1: 1, d2: 1 }), errorCode("PEER_REVIEW_WORK_NOT_FOUND", 404));
  assert.equal(await f.rowCount("event-a"), 0);
  assert.equal(f.writes.some(statement => /INSERT INTO epr_peer_reviews/i.test(statement)), false, "被拒请求不能写任何一行");
});

test("观看者资格：participants 档拒绝非通过者；public 档已登录即可读，但不能评", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.getWork(f.principal("outsider"), "event-a", "snap-a2"), errorCode("PEER_REVIEW_PARTICIPANTS_ONLY", 403));
  const view = await f.service.getWork(f.principal("outsider"), "event-a", "snap-b1");
  assert.equal(view.scope, "public");
  assert.equal(view.canReview, false);
  assert.equal(view.myReview, null);
  assert.match(view.canReviewReason ?? "", /参赛者/);
  assert.equal(view.summary, null);
  assert.equal(view.threshold.met, false);
});

test("提交与修改：修改必须带当前版本号，旧版本保留为 superseded 历史", async t => {
  const f = await fixture(t);
  const first = await f.submit("event-a", "snap-a2", "bob", { d1: 4, d2: 5 }, "key-first");
  assert.equal(first.myReview!.revision, 1);
  assert.deepEqual(first.myReview!.values, [{ dimensionId: "d1", value: 4 }, { dimensionId: "d2", value: 5 }]);
  assert.equal(first.threshold.met, false, "1/5 未达 30% 门槛");
  assert.equal(first.summary, null);
  await assert.rejects(f.submit("event-a", "snap-a2", "bob", { d1: 3, d2: 3 }), errorCode("PEER_REVIEW_REVISION_REQUIRED", 409));
  await assert.rejects(f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", { values: { d1: 3, d2: 3 }, expectedRevision: 9, idempotencyKey: f.key() }), errorCode("PEER_REVIEW_VERSION_CONFLICT", 409));
  const changed = await f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", { values: { d1: 2, d2: 2 }, expectedRevision: 1, idempotencyKey: "key-change" });
  assert.equal(changed.myReview!.revision, 2);
  const stale = await f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", { values: { d1: 1, d2: 1 }, expectedRevision: 1, idempotencyKey: "key-stale" }).then(() => null, (error: unknown) => error);
  assert.ok(errorCode("PEER_REVIEW_VERSION_CONFLICT", 409)(stale));
  assert.equal((stale as DomainError).latestRevision, 2);
  const stored = await f.pg.query<{ status: string; revision: number; values: unknown }>("SELECT status, revision, document->'values' AS values FROM epr_peer_reviews WHERE reviewer_user_id='bob' ORDER BY revision");
  assert.deepEqual(stored.rows.map(row => [row.status, row.revision]), [["superseded", 1], ["active", 2]], "旧分值保留为不可改写的历史");
  assert.deepEqual((stored.rows[0]!.values as { value: number }[]).map(item => item.value), [4, 5], "历史分值与提交时一致");
});

test("幂等：同一重试标识同输入返回当前视图，同键不同分值拒绝", async t => {
  const f = await fixture(t);
  const input = { values: { d1: 4, d2: 5 }, idempotencyKey: "fixed-key" };
  const first = await f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", input);
  const replay = await f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", input);
  assert.equal(replay.myReview!.id, first.myReview!.id);
  assert.equal(replay.myReview!.revision, 1);
  await assert.rejects(f.service.submitMyReview(f.principal("bob"), "event-a", "snap-a2", { values: { d1: 1, d2: 1 }, idempotencyKey: "fixed-key" }), errorCode("PEER_REVIEW_IDEMPOTENCY_KEY_REUSED", 409));
  assert.equal(await f.rowCount("event-a"), 1, "幂等重放不产生第二行");
});

test("撤回与重提：只有作者能撤回，撤回后版本继续加一且历史保留", async t => {
  const f = await fixture(t);
  const carol = await f.submit("event-a", "snap-b1", "carol", { d1: 5, d2: 5 }, "carol-1");
  await assert.rejects(f.service.withdrawMyReview(f.principal("bob"), "event-a", "snap-b1", { expectedRevision: carol.myReview!.revision }), errorCode("PEER_REVIEW_NOT_FOUND", 404));
  const withdrawn = await f.service.withdrawMyReview(f.principal("carol"), "event-a", "snap-b1", { expectedRevision: 1 });
  assert.equal(withdrawn.revision, 2);
  await assert.rejects(f.service.withdrawMyReview(f.principal("carol"), "event-a", "snap-b1", { expectedRevision: 1 }), errorCode("PEER_REVIEW_NOT_FOUND", 404), "已撤回的行不再是有效记录");
  const again = await f.submit("event-a", "snap-b1", "carol", { d1: 1, d2: 1 }, "carol-2");
  assert.equal(again.myReview!.revision, 3, "撤回后重提继续加一");
  await assert.rejects(f.service.withdrawMyReview(f.principal("carol"), "event-a", "snap-b1", { expectedRevision: 9 }), errorCode("PEER_REVIEW_VERSION_CONFLICT", 409));
  assert.equal(await f.rowCount("event-a"), 2, "撤回的历史行与重提的有效行都保留");
});

test("参与率门槛：未达门槛只返回门槛值本身；达标后也只按作品给平均与份数", async t => {
  const before = await fixture(t);
  const unmet = await before.service.getWork(before.principal("bob"), "event-b", "snap-bb1");
  assert.equal(unmet.threshold.met, false);
  assert.equal(unmet.threshold.code, "PEER_REVIEW_THRESHOLD_NOT_MET");
  assert.equal(unmet.threshold.requiredRate, 0.3);
  assert.equal(unmet.threshold.passRate, undefined);
  assert.equal(unmet.threshold.submittedReviewerCount, undefined);
  assert.equal(unmet.summary, null);
  const met = await before.submit("event-b", "snap-bb1", "bob", { d1: 4, d2: 5 }, "b-1");
  assert.equal(met.threshold.met, true);
  assert.equal(met.threshold.submittedReviewerCount, 1);
  assert.equal(met.threshold.approvedParticipantCount, 1);
  assert.deepEqual(met.summary!.dimensions, [{ id: "d1", label: "创意", average: 4, count: 1 }, { id: "d2", label: "完成度", average: 5, count: 1 }]);
  assert.equal(met.summary!.reviewCount, 1);
  // 其他作品不会被这份汇总污染。
  assert.equal((await before.service.getWork(before.principal("bob"), "event-a", "snap-b1")).summary, null);
});

test("匿名投影：汇总与逐条分值不含评分者身份，也不含名次字段", async t => {
  const f = await fixture(t);
  await f.submit("event-a", "snap-b1", "carol", { d1: 5, d2: 5 }, "c-1");
  await f.submit("event-a", "snap-a2", "bob", { d1: 3, d2: 3 }, "a-x");
  const view = await f.service.getWork(f.principal("bob"), "event-a", "snap-b1");
  assert.equal(view.myReview, null);
  const text = JSON.stringify(view);
  assert.ok(!text.includes("carol"), "评分者身份不得出现在投影里");
  assert.ok(!text.includes("reviewerUserId"));
  assert.ok(!text.includes('"rank"') && !text.includes('"total"'));
  assert.ok(!/"rank"|"percentile"|"percent"/.test(text));
  assert.equal(view.summary!.anonymousReviews.length, 1);
  assert.ok(typeof view.summary!.anonymousReviews[0]!.reviewId === "string");
});

test("跨赛事读不到：互评只在本场可见，另一场看不到", async t => {
  const f = await fixture(t);
  await f.submit("event-a", "snap-a2", "bob", { d1: 4, d2: 5 }, "a-1");
  const other = await f.service.getWork(f.principal("bob"), "event-b", "snap-bb1");
  assert.equal(other.myReview, null);
  assert.equal(other.summary, null);
  assert.equal(await f.rowCount("event-b"), 0);
  assert.equal(await f.rowCount("event-a"), 1);
});

test("归档赛事只读：能读既有互评，不能提交、撤回或举报", async t => {
  const f = await fixture(t);
  const view = await f.service.getWork(f.principal("alice"), "event-archived", "snap-x1");
  assert.equal(view.enabled, true);
  await assert.rejects(f.submit("event-archived", "snap-x1", "alice", { d1: 1, d2: 1 }), errorCode("PEER_REVIEW_EVENT_READ_ONLY", 403));
  await assert.rejects(f.service.withdrawMyReview(f.principal("alice"), "event-archived", "snap-x1", { expectedRevision: 1 }), errorCode("PEER_REVIEW_EVENT_READ_ONLY", 403));
  await assert.rejects(f.service.reportReview(f.principal("alice"), "event-archived", "snap-x1", "epr-1", {}), errorCode("PEER_REVIEW_EVENT_READ_ONLY", 403));
});

test("与评审分列：提交互评前后评审侧原始汇总逐字段不变，只写本模块自己的表", async t => {
  const f = await fixture(t);
  const before = await f.judgeRows();
  const view = await f.submit("event-a", "snap-a2", "bob", { d1: 4, d2: 5 }, "sep-1");
  const after = await f.judgeRows();
  assert.deepEqual(after, before, "评审侧原始汇总（分数与名次）逐字段不变");
  const text = JSON.stringify(view);
  assert.ok(!text.includes('"total"') && !text.includes('"rank"'), "互评投影里没有评审分与名次");
  assert.ok(f.writes.length > 0);
  for (const statement of f.writes) assert.match(statement, /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)\s+epr_/i, "只允许写 epr_ 自己的表：" + statement.slice(0, 60));
});

test("举报：任一可见者都能举报且只记事实，重复举报幂等，不改互评状态", async t => {
  const f = await fixture(t);
  const carol = await f.submit("event-a", "snap-b1", "carol", { d1: 5, d2: 5 }, "r-c1");
  const receipt = await f.service.reportReview(f.principal("bob"), "event-a", "snap-b1", carol.myReview!.id, { reason: "与作品无关的评价" });
  assert.equal(receipt.alreadyReported, false);
  assert.equal(receipt.reportedCount, 1);
  const again = await f.service.reportReview(f.principal("bob"), "event-a", "snap-b1", carol.myReview!.id, { reason: "再报一次" });
  assert.equal(again.alreadyReported, true);
  assert.equal(again.reportedCount, 1);
  // 举报不改互评状态。
  const view = await f.service.getWork(f.principal("carol"), "event-a", "snap-b1");
  assert.equal(view.myReview!.revision, 1);
  // 看不到这件作品的人不能举报（participants 档拒绝非通过者）。
  await assert.rejects(f.service.reportReview(f.principal("outsider"), "event-a", "snap-a2", "epr-1", {}), errorCode("PEER_REVIEW_PARTICIPANTS_ONLY", 403));
  // 不存在 / 不属于本作品的互评 404。
  await assert.rejects(f.service.reportReview(f.principal("bob"), "event-a", "snap-b1", "missing", {}), errorCode("PEER_REVIEW_NOT_FOUND", 404));
  await assert.rejects(f.service.reportReview(f.principal("bob"), "event-a", "snap-a2", carol.myReview!.id, {}), errorCode("PEER_REVIEW_NOT_FOUND", 404));
  // 公开作品对任何已登录账号开放：非参赛者也能举报。
  const opened = await f.service.reportReview(f.principal("outsider"), "event-a", "snap-b1", carol.myReview!.id, {});
  assert.equal(opened.alreadyReported, false);
  const reports = await f.pg.query<{ count: string }>("SELECT count(*)::text AS count FROM epr_review_reports");
  assert.equal(reports.rows[0]!.count, "2");
});
