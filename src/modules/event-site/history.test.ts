import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSitePageSpec } from "./model.ts";
import { normalizeSpec, parseSpec, serializeSpec } from "./validation.ts";
import {
  createEventSiteService, type EventSiteAccessPort, type EventSiteAuditEvent, type EventSitePublicEvent,
  type EventSiteService,
} from "./service.ts";
import { createEventSiteHandlers } from "./handlers.ts";
import {
  EVENT_SITE_REVISION_HISTORY_LIMIT, countRevisions, isRevisionHistoryReady, readRevision, recordRevision,
  type EventSiteRevisionList,
} from "./history.ts";

/**
 * P4 草稿历史与版本回退的验证。
 *
 * 数据库：临时内存 PGlite，加载**根迁移 080 原文** ＋ **本模块的迁移建议 002 原文**
 * （不复制表结构，所以 UNIQUE / 外键 / CHECK 就是建议文件里的那一套）。
 * 服务用真 SQL ＋ 注入的假权限/审计端口；不碰应用目录、不碰生产数据。
 */

let engine: PGlite;
let database: DatabasePort;
const extraEngines: PGlite[] = [];

function executor(connection: Pick<PGlite, "query">): SqlExecutor {
  return {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await connection.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

const BASE_SCHEMA = [
  "CREATE TABLE auth_users(id text PRIMARY KEY);",
  "CREATE TABLE organizer_organizations(id text PRIMARY KEY);",
  "CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL, UNIQUE(id, organization_id));",
  "INSERT INTO auth_users(id) VALUES ('manager'),('outsider'),('org-admin'),('platform-admin'),('other-manager');",
  "INSERT INTO organizer_organizations(id) VALUES ('org-a'),('org-b');",
].join("\n");

async function newEngine(withHistory: boolean): Promise<PGlite> {
  const instance = new PGlite();
  await instance.exec(BASE_SCHEMA);
  await instance.exec(await readFile(new URL("../../../migrations/080_event_site.sql", import.meta.url), "utf8"));
  if (withHistory) {
    // 直接读本模块的迁移建议原文：表结构只有这一份。
    await instance.exec(await readFile(new URL("./migrations/002-page-revisions.sql", import.meta.url), "utf8"));
  }
  return instance;
}

before(async () => {
  engine = await newEngine(true);
  database = { ...executor(engine), transaction: work => engine.transaction(transaction => work(executor(transaction))) };
});

after(async () => {
  await engine.close();
  for (const instance of extraEngines) await instance.close();
});

const AT = "2026-10-18T04:00:00.000Z";
let eventCounter = 0;
let idCounter = 0;
let codeCounter = 0;

/** 一份**带可辨认文案**的合法规格：内容变了才能证明"回退到的是那一版"。 */
function specOf(text: string): EventSitePageSpec {
  return normalizeSpec({
    version: 1,
    blocks: [{ kind: "richText", id: "r1", variant: "prose", priority: 3, collapse: false, text }],
  });
}

function principalOf(userId: string): OrganizerPrincipal {
  return { actor: { userId, platformRoles: [] }, guard: async () => undefined };
}

const events = new Map<string, EventSitePublicEvent>();
const eventManagers = new Map<string, Set<string>>();

function accessPort(): EventSiteAccessPort {
  return {
    async requireEventManager(_sql, principal, eventId): Promise<HostedEventScope> {
      if (!eventManagers.get(eventId)?.has(principal.actor.userId)) {
        throw new DomainError("ORGANIZER_FORBIDDEN", "你目前没有这家机构或这场比赛的操作权限。", { status: 403 });
      }
      const event = events.get(eventId);
      if (event === undefined) throw new DomainError("EVENT_NOT_FOUND", "没有找到这场比赛。", { status: 404 });
      return {
        organizationId: event.organizationId, organizationName: "机构", eventId: event.eventId, title: event.title,
        status: "published", revision: 1, publishedRevision: 1, timezone: "Asia/Shanghai",
        startsAt: AT, endsAt: AT, registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
        modules: { registration: true, teams: true, judging: true, schedule: true, accommodation: false, mealVouchers: false, icebreaking: false },
        registration: { reviewRequired: false, capacity: null },
        teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null }, linkedEventId: null,
      };
    },
    async requireOrganizationAdmin(): Promise<void> {
      throw new DomainError("ORGANIZER_FORBIDDEN", "只有机构管理员可以管理模板。", { status: 403 });
    },
    async requirePlatformAdmin(): Promise<void> {
      throw new DomainError("ORGANIZER_FORBIDDEN", "只有平台管理员可以执行这个操作。", { status: 403 });
    },
    async publicEvent(_sql, eventId): Promise<EventSitePublicEvent | null> {
      return events.get(eventId) ?? null;
    },
  };
}

interface Harness {
  readonly service: EventSiteService;
  readonly audit: { events: EventSiteAuditEvent[]; failing: boolean };
}

function harness(connection: DatabasePort = database): Harness {
  const audit = { events: [] as EventSiteAuditEvent[], failing: false };
  const service = createEventSiteService({
    database: connection,
    clock: { now: () => new Date(AT) },
    ids: { next: () => "id-" + String(++idCounter) },
    access: accessPort(),
    audit: {
      async record(_sql, event) {
        if (audit.failing) throw new DomainError("ORGANIZER_AUDIT_FAILED", "审计写入失败。", { status: 503 });
        audit.events.push(event);
      },
    },
    shortCodes: { next: () => "CODE" + String(++codeCounter).padStart(12, "0") },
  });
  return { service, audit };
}

async function registerEvent(organizationId = "org-a", manager = "manager"): Promise<EventSitePublicEvent> {
  eventCounter += 1;
  const eventId = "event-" + String(eventCounter);
  await database.query("INSERT INTO organizer_hosted_events(id,organization_id) VALUES($1,$2)", [eventId, organizationId]);
  const event: EventSitePublicEvent = { eventId, organizationId, title: "赛事 " + String(eventCounter), status: "published" };
  events.set(eventId, event);
  const managers = eventManagers.get(eventId) ?? new Set<string>();
  managers.add(manager);
  eventManagers.set(eventId, managers);
  return event;
}

function managerOf(event: EventSitePublicEvent, userId = "manager"): OrganizerPrincipal {
  const managers = eventManagers.get(event.eventId) ?? new Set<string>();
  managers.add(userId);
  eventManagers.set(event.eventId, managers);
  return principalOf(userId);
}

const failure = (code: string, status?: number) => (error: unknown): boolean => error instanceof DomainError
  && error.code === code && (status === undefined || error.status === status);

function revisionsOf(list: EventSiteRevisionList): number[] {
  return list.revisions.map(item => item.revision);
}

/** 存 N 次草稿（文案各不相同），返回每次的新版本号。 */
async function saveMany(h: Harness, event: EventSitePublicEvent, principal: OrganizerPrincipal, count: number): Promise<number[]> {
  const revisions: number[] = [];
  let expected = 0;
  for (let index = 1; index <= count; index += 1) {
    const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf("第 " + String(index) + " 版"), expectedRevision: expected });
    revisions.push(saved.revision);
    expected = saved.revision;
  }
  return revisions;
}

/* ------------------------------------------------------------------ *
 * 1. 保存即留痕
 * ------------------------------------------------------------------ */

test("建页即历史：第一次保存留一条第 1 版，内容与草稿一致", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf("第一版"), expectedRevision: 0 });
  assert.equal(saved.created, true);
  assert.equal(saved.revision, 1);
  assert.equal(saved.historyRecorded, true);
  assert.equal(saved.historyNotice, null);

  const list = await h.service.listRevisions(principal, event.eventId);
  assert.deepEqual(revisionsOf(list), [1]);
  assert.equal(list.truncated, false);
  const record = await readRevision(database, event.eventId, 1);
  assert.ok(record !== null);
  assert.equal(record.createdBy, "manager");
  assert.equal(record.createdAt, AT);
  assert.equal(serializeSpec(record.spec as EventSitePageSpec), serializeSpec(specOf("第一版")));
  assert.equal(await countRevisions(database, event.eventId), 1);
});

test("每次保存留一条历史，revision 与草稿逐一对应（含操作者与时间）", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  assert.deepEqual(await saveMany(h, event, principal, 3), [1, 2, 3]);

  // 三次保存 = 三条历史，且第 N 条的正文就是第 N 次写进草稿的那一份。
  for (const revision of [1, 2, 3]) {
    const record = await readRevision(database, event.eventId, revision);
    assert.ok(record !== null, "第 " + String(revision) + " 版历史必须存在");
    assert.equal(record.revision, revision);
    assert.equal(record.createdBy, "manager");
    assert.equal(record.createdAt, AT);
    assert.equal(serializeSpec(record.spec as EventSitePageSpec), serializeSpec(specOf("第 " + String(revision) + " 版")));
  }
  // 草稿当前内容 = 最后一版历史（"每次保存都留痕"的直接证据）。
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.revision, 3);
  const newest = await readRevision(database, event.eventId, 3);
  assert.equal(serializeSpec(newest?.spec as EventSitePageSpec), serializeSpec(view.spec as EventSitePageSpec));
  assert.equal(await countRevisions(database, event.eventId), 3);
  // 列表里没有重复版本号，也没有 spec 正文。
  const list = await h.service.listRevisions(principal, event.eventId);
  assert.deepEqual(revisionsOf(list), [3, 2, 1]);
  const keys = Object.keys(list.revisions[0]);
  assert.deepEqual(keys.sort(), ["createdAt", "createdBy", "revision"]);
  assert.equal("spec" in list.revisions[0], false, "列表绝不带 spec 正文");
});

test("留痕写入的规格与草稿逐字节一致，并且能再次通过严格闸门", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 2);
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  const record = await readRevision(database, event.eventId, 2);
  assert.ok(record !== null);
  assert.equal(serializeSpec(parseSpec(record.spec)), serializeSpec(view.spec as EventSitePageSpec));
  // 默认模块集也能留痕并被重新校验（含 items 往返）。
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: defaultPageSpec(), expectedRevision: 2 });
  assert.equal(saved.historyRecorded, true);
  const defaultRecord = await readRevision(database, event.eventId, saved.revision);
  assert.deepEqual(defaultRecord?.spec, normalizeSpec(defaultPageSpec()));
});

/* ------------------------------------------------------------------ *
 * 2. 保留窗口：每赛事最近 20 条，删除有界且可测
 * ------------------------------------------------------------------ */

test("超过保留窗口后最旧的被逐条删掉：22 次保存只留第 3–22 版", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const revisions = await saveMany(h, event, principal, EVENT_SITE_REVISION_HISTORY_LIMIT + 2);
  assert.equal(revisions.length, 22);
  assert.equal(revisions[0], 1);
  assert.equal(revisions[21], 22);

  assert.equal(await countRevisions(database, event.eventId), EVENT_SITE_REVISION_HISTORY_LIMIT);
  const list = await h.service.listRevisions(principal, event.eventId);
  const kept = revisionsOf(list);
  assert.equal(kept.length, EVENT_SITE_REVISION_HISTORY_LIMIT);
  // 逐条断言：恰好留下 3..22，一条不多一条不少，且顺序是倒序。
  assert.deepEqual(kept, revisions.slice(2).reverse());
  assert.equal(kept.includes(1), false);
  assert.equal(kept.includes(2), false);
  assert.equal(kept.includes(3), true);
  assert.equal(kept.includes(22), true);
  // 被裁掉的版本按"不存在"处理（读取与回退都不再可见）。
  assert.equal(await readRevision(database, event.eventId, 1), null);
  assert.equal(await readRevision(database, event.eventId, 2), null);
  await assert.rejects(h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: 22 }), failure("EVENT_SITE_REVISION_NOT_FOUND", 404));
});

test("裁剪只删本赛事、只删窗口外的行：每次插入返回被删版本号", async () => {
  const event = await registerEvent();
  // 先放 21 条（比窗口多 1 条），第 21 次插入应只删掉第 1 版。
  let pruned: readonly number[] = [];
  for (let revision = 1; revision <= EVENT_SITE_REVISION_HISTORY_LIMIT + 1; revision += 1) {
    pruned = await recordRevision(database, {
      id: "rev-" + event.eventId + "-" + String(revision), organizationId: "org-a", eventId: event.eventId,
      revision, spec: specOf("第 " + String(revision) + " 版"), createdBy: "manager", createdAt: AT,
    });
    if (revision <= EVENT_SITE_REVISION_HISTORY_LIMIT) assert.deepEqual(pruned, [], "窗口内不删任何一条");
  }
  assert.deepEqual(pruned, [1], "只删窗口外那一条，且能说出删的是第几版");
  assert.equal(await countRevisions(database, event.eventId), EVENT_SITE_REVISION_HISTORY_LIMIT);
  // 另一场赛事的历史一条都不受影响。
  const other = await registerEvent("org-b", "other-manager");
  assert.equal(await countRevisions(database, other.eventId), 0);
});

/* ------------------------------------------------------------------ *
 * 3. 列表：倒序、只有摘要、达窗口时 truncated
 * ------------------------------------------------------------------ */

test("列表按 revision 倒序且不含 spec；不足窗口时 truncated=false，达窗口时 true", async () => {
  const h = harness();
  const short = await registerEvent();
  const shortPrincipal = managerOf(short);
  await saveMany(h, short, shortPrincipal, 2);
  const small = await h.service.listRevisions(shortPrincipal, short.eventId);
  assert.deepEqual(revisionsOf(small), [2, 1]);
  assert.equal(small.truncated, false);

  const full = await registerEvent();
  const fullPrincipal = managerOf(full);
  await saveMany(h, full, fullPrincipal, EVENT_SITE_REVISION_HISTORY_LIMIT + 1);
  const capped = await h.service.listRevisions(fullPrincipal, full.eventId);
  assert.equal(capped.revisions.length, EVENT_SITE_REVISION_HISTORY_LIMIT);
  assert.equal(capped.truncated, true, "达到保留窗口上限时要如实说明");
  for (const item of capped.revisions) {
    assert.deepEqual(Object.keys(item).sort(), ["createdAt", "createdBy", "revision"]);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 权限：只有本场 event_manage 能读、能回退；跨赛事不可见
 * ------------------------------------------------------------------ */

test("列表与回退都要本场 event_manage：非本场 403，跨赛事也看不到", async () => {
  const h = harness();
  const mine = await registerEvent();
  const theirs = await registerEvent("org-b", "other-manager");
  const principal = managerOf(mine);
  await saveMany(h, mine, principal, 2);
  await saveMany(h, theirs, managerOf(theirs, "other-manager"), 5);

  // 完全没权限的人：403（不是 404，也不是空列表）。
  await assert.rejects(h.service.listRevisions(principalOf("outsider"), mine.eventId), failure("ORGANIZER_FORBIDDEN", 403));
  await assert.rejects(h.service.restoreRevision(principalOf("outsider"), mine.eventId, { revision: 1, expectedRevision: 2 }), failure("ORGANIZER_FORBIDDEN", 403));
  // 我只有 A 场权限：读/回退 B 场都是 403。
  await assert.rejects(h.service.listRevisions(principal, theirs.eventId), failure("ORGANIZER_FORBIDDEN", 403));
  await assert.rejects(h.service.restoreRevision(principal, theirs.eventId, { revision: 5, expectedRevision: 5 }), failure("ORGANIZER_FORBIDDEN", 403));

  // 我读到的是本场历史，B 场的版本号一个都不出现。
  const list = await h.service.listRevisions(principal, mine.eventId);
  assert.deepEqual(revisionsOf(list), [2, 1]);
  // 即使编号在 B 场存在（第 5 版），在 A 场回退它也是 404（编号不跨赛事复用）。
  await assert.rejects(h.service.restoreRevision(principal, mine.eventId, { revision: 5, expectedRevision: 2 }), failure("EVENT_SITE_REVISION_NOT_FOUND", 404));
});

/* ------------------------------------------------------------------ *
 * 5. 回退：新草稿版本、内容等于目标、published 不动
 * ------------------------------------------------------------------ */

test("回退产生新的草稿版本（不复用历史号），草稿内容等于目标那一版", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 3);

  const restored = await h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: 3 });
  assert.equal(restored.restoredFrom, 1);
  assert.equal(restored.revision, 4, "新版本号 = 当前 + 1，不复用 1");
  assert.equal(restored.status, "draft");
  assert.equal(restored.publishedRevision, null);
  assert.equal(restored.auditRecorded, true);
  assert.equal(restored.historyRecorded, true);

  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.revision, 4);
  assert.deepEqual(view.spec, specOf("第 1 版"), "草稿回到第 1 版的内容");

  // 历史一条都没被覆盖：1..3 还在原样，4 是这次回退产生的新草稿。
  assert.deepEqual(revisionsOf(await h.service.listRevisions(principal, event.eventId)), [4, 3, 2, 1]);
  assert.deepEqual((await readRevision(database, event.eventId, 1))?.spec, specOf("第 1 版"));
  assert.deepEqual((await readRevision(database, event.eventId, 3))?.spec, specOf("第 3 版"));
  assert.deepEqual((await readRevision(database, event.eventId, 4))?.spec, specOf("第 1 版"));
  // 审计：一次回退一条，action 与 restoredFrom 都可核对。
  const audit = h.audit.events.find(item => item.action === "page_revision_restored");
  assert.ok(audit !== undefined);
  assert.equal(audit.revision, 4);
  assert.equal(audit.detail?.restoredFrom, 1);
  assert.equal(audit.actorUserId, "manager");
});

test("回退不动 published：线上快照与发布版本一个字节都不变，公开页照旧", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  const first = await h.service.saveDraft(principal, event.eventId, { spec: specOf("线上版"), expectedRevision: 0 });
  const published = await h.service.publish(principal, event.eventId, { expectedRevision: first.revision });
  assert.equal(published.publishedRevision, 1);
  const shortCode = first.shortCode;
  const before = await engine.query<{ published: unknown; published_revision: number; revision: number }>(
    "SELECT published,published_revision,revision FROM organizer_page_specs WHERE event_id=$1", [event.eventId],
  );
  const beforeSnapshot = JSON.stringify(before.rows[0].published);

  // 改了草稿，再回退到线上那一版的历史。
  const second = await h.service.saveDraft(principal, event.eventId, { spec: specOf("还没发布的改动"), expectedRevision: published.revision });
  const restored = await h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: second.revision });
  assert.equal(restored.revision, second.revision + 1);
  assert.equal(restored.publishedRevision, 1, "发布版本号原样回传");

  const after = await engine.query<{ published: unknown; published_revision: number; revision: number; draft: unknown }>(
    "SELECT published,published_revision,revision,draft FROM organizer_page_specs WHERE event_id=$1", [event.eventId],
  );
  assert.equal(JSON.stringify(after.rows[0].published), beforeSnapshot, "published 一个字节都没变");
  assert.equal(after.rows[0].published_revision, 1);
  assert.deepEqual(after.rows[0].draft, specOf("线上版"), "只有 draft 被回退");
  assert.equal(after.rows[0].revision, second.revision + 1);

  // 公开页仍然读已发布快照（不是被回退的草稿，也不是"最新历史"）。
  const publicView = await h.service.publicPage(shortCode);
  assert.deepEqual(publicView.spec, specOf("线上版"));
  assert.equal(publicView.publishedRevision, 1);
});

/* ------------------------------------------------------------------ *
 * 6. 回退的错误路径：404 / 409 / 422
 * ------------------------------------------------------------------ */

test("目标历史不存在（含 0 与已裁剪的版本）→ 404 EVENT_SITE_REVISION_NOT_FOUND", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 2);
  for (const revision of [0, 9, 123456]) {
    await assert.rejects(
      h.service.restoreRevision(principal, event.eventId, { revision, expectedRevision: 2 }),
      failure("EVENT_SITE_REVISION_NOT_FOUND", 404),
      "第 " + String(revision) + " 版不存在时必须是 404",
    );
  }
  // 失败的尝试不改变草稿，也不产生历史。
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.revision, 2);
  assert.deepEqual(view.spec, specOf("第 2 版"));
  assert.equal(await countRevisions(database, event.eventId), 2);
});

test("回退的 CAS 不符 → 409 带 latestRevision，草稿与历史都不动", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 2);
  await assert.rejects(
    h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: 1 }),
    (error: unknown) => failure("EVENT_SITE_REVISION_CONFLICT", 409)(error)
      && (error as DomainError).latestRevision === 2,
  );
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.revision, 2);
  assert.deepEqual(view.spec, specOf("第 2 版"));
  assert.equal(await countRevisions(database, event.eventId), 2);
});

test("历史内容被篡改成非法规格时回退 → 422，草稿不动（写回仍要过闸门）", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 2);
  await database.query("UPDATE organizer_page_revisions SET spec=$1::jsonb WHERE event_id=$2 AND revision=1", [
    JSON.stringify({ version: 1, blocks: [{ kind: "videoEmbed", id: "v1", variant: "x", priority: 3, collapse: false }] }),
    event.eventId,
  ]);
  await assert.rejects(
    h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: 2 }),
    failure("EVENT_SITE_REVISION_SPEC_INVALID", 422),
  );
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.revision, 2);
  assert.deepEqual(view.spec, specOf("第 2 版"));
});

/* ------------------------------------------------------------------ *
 * 7. 同事务：构造失败时两表都不变
 * ------------------------------------------------------------------ */

test("历史与草稿同事务：保存时审计失败 → 页表与历史表一起回滚", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 1);
  const before = await engine.query<{ revision: number }>("SELECT revision FROM organizer_page_specs WHERE event_id=$1", [event.eventId]);

  h.audit.failing = true;
  await assert.rejects(
    h.service.saveDraft(principal, event.eventId, { spec: specOf("不该留下"), expectedRevision: 1 }),
    failure("ORGANIZER_AUDIT_FAILED", 503),
  );
  h.audit.failing = false;

  const after = await engine.query<{ revision: number; draft: unknown }>(
    "SELECT revision,draft FROM organizer_page_specs WHERE event_id=$1", [event.eventId],
  );
  assert.equal(after.rows[0].revision, before.rows[0].revision, "版本号没有前进");
  assert.deepEqual(after.rows[0].draft, specOf("第 1 版"), "草稿没有变");
  assert.equal(await countRevisions(database, event.eventId), 1, "历史也没有多出一条");
  assert.equal(await readRevision(database, event.eventId, 2), null);
});

test("历史与草稿同事务：回退时审计失败 → 草稿与历史一起回滚", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 3);

  h.audit.failing = true;
  await assert.rejects(
    h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: 3 }),
    failure("ORGANIZER_AUDIT_FAILED", 503),
  );
  h.audit.failing = false;

  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.equal(view.revision, 3, "回退整体回滚，版本号没有前进");
  assert.deepEqual(view.spec, specOf("第 3 版"));
  assert.deepEqual(revisionsOf(await h.service.listRevisions(principal, event.eventId)), [3, 2, 1]);
  assert.equal(await readRevision(database, event.eventId, 4), null);
});

/* ------------------------------------------------------------------ *
 * 8. 迁移未应用时的诚实降级
 * ------------------------------------------------------------------ */

test("迁移未应用：保存照常生效但如实标注没有历史；列表与回退 503", async () => {
  const bare = await newEngine(false);
  extraEngines.push(bare);
  const connection: DatabasePort = { ...executor(bare), transaction: work => bare.transaction(transaction => work(executor(transaction))) };
  assert.equal(await isRevisionHistoryReady(connection), false);

  const h = harness(connection);
  // 这场赛事要建在**独立引擎**里（registerEvent 用的是主引擎）。
  eventCounter += 1;
  const eventId = "bare-event-" + String(eventCounter);
  await connection.query("INSERT INTO organizer_hosted_events(id,organization_id) VALUES($1,'org-a')", [eventId]);
  const event: EventSitePublicEvent = { eventId, organizationId: "org-a", title: "无历史的赛事", status: "published" };
  events.set(eventId, event);
  const principal = managerOf(event);
  const saved = await h.service.saveDraft(principal, event.eventId, { spec: specOf("照常保存"), expectedRevision: 0 });
  assert.equal(saved.created, true);
  assert.equal(saved.revision, 1);
  assert.equal(saved.historyRecorded, false);
  assert.ok(saved.historyNotice !== null && saved.historyNotice.includes("迁移"), "要说清楚为什么没有历史");
  // 草稿确实写进去了。
  const view = await h.service.pageForOrganizer(principal, event.eventId);
  assert.deepEqual(view.spec, specOf("照常保存"));

  await assert.rejects(h.service.listRevisions(principal, event.eventId), failure("EVENT_SITE_REVISION_HISTORY_UNAVAILABLE", 503));
  await assert.rejects(h.service.restoreRevision(principal, event.eventId, { revision: 1, expectedRevision: 1 }), failure("EVENT_SITE_REVISION_HISTORY_UNAVAILABLE", 503));
});

/* ------------------------------------------------------------------ *
 * 9. HTTP 入口（两条新 handler）
 * ------------------------------------------------------------------ */

test("HTTP：GET 历史 200（不含 spec）、POST 回退 200；未登录 401、方法不符 405、坏版本号 400", async () => {
  const h = harness();
  const event = await registerEvent();
  const principal = managerOf(event);
  await saveMany(h, event, principal, 2);
  const handlers = createEventSiteHandlers({
    service: h.service,
    async resolvePrincipal(request) {
      return request.headers.get("x-test-user") === null ? null : principalOf(request.headers.get("x-test-user") as string);
    },
    async authorizeMutation(): Promise<void> {},
    requestIds: { next: () => "req-" + String(++idCounter) },
  });
  const request = (method: string, user: string | null, body?: string): Request => new Request("https://field-guide.example/x", {
    method,
    headers: {
      ...(user === null ? {} : { "x-test-user": user }),
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(method === "GET" ? {} : { body: body ?? "{}" }),
  });

  const list = await handlers.listRevisions(request("GET", "manager"), { eventId: event.eventId });
  assert.equal(list.status, 200);
  const listBody = (await list.json()).data;
  assert.deepEqual(listBody.revisions.map((item: { revision: number }) => item.revision), [2, 1]);
  assert.equal(listBody.truncated, false);
  assert.equal(JSON.stringify(listBody).includes("\"spec\""), false, "列表响应里不能出现 spec");

  const restored = await handlers.restoreRevision(request("POST", "manager", JSON.stringify({ expectedRevision: 2 })), { eventId: event.eventId, revision: "1" });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).data.revision, 3);

  assert.equal((await handlers.listRevisions(request("GET", null), { eventId: event.eventId })).status, 401);
  assert.equal((await handlers.restoreRevision(request("GET", "manager"), { eventId: event.eventId, revision: "1" })).status, 405);
  const badRevision = await handlers.restoreRevision(request("POST", "manager", JSON.stringify({ expectedRevision: 3 })), { eventId: event.eventId, revision: "abc" });
  assert.equal(badRevision.status, 400);
  assert.equal((await badRevision.json()).error.code, "INVALID_ROUTE");
});
