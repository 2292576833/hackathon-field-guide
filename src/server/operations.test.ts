import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { EventsService } from "../modules/events/service.ts";
import { PostgresEventsRepository } from "../modules/events/postgres.ts";
import type { EventRuleVersion } from "../modules/events/domain.ts";
import type { EventReview } from "../modules/operations/event-review-types.ts";
import { criticalFieldKeys } from "../modules/operations/event-review-types.ts";
import { ResourceService } from "../modules/resources/service.ts";
import { createPostgresResourceRepository } from "../modules/resources/postgres.ts";
import type { ResourceInput } from "../modules/resources/domain.ts";
import { createDatabase } from "./database.ts";
import { createOperationsIntegration } from "./operations.ts";

const at = "2026-10-08T04:00:00.000Z";
const admin: Actor = { userId: "ops-admin", platformRoles: ["admin"] };
const reviewer: Actor = { userId: "ops-reviewer", platformRoles: ["reviewer"] };
const user: Actor = { userId: "ops-user", platformRoles: ["user"] };
function rules(eventId = "event-1"): EventRuleVersion {
  const deadline = "2026-10-20 20:00 Asia/Shanghai";
  return {
    eventId, version: 1, createdAt: at,
    metadata: { name: "真实数据库测试赛事", organizer: "测试主办方", format: "online", region: "中国", officialUrl: "https://example.test/rules" },
    sources: [{ id: "official", eventId, version: 1, sourceConfigId: null, url: "https://example.test/rules", kind: "official", contentHash: "snapshot-sha", fetchedAt: at, trustScope: "official_rules", status: "available" }],
    evidence: [
      { id: "demo-evidence", eventId, version: 1, sourceId: "official", fieldKey: "requirement.demo", excerpt: "提交演示材料。", locator: "规则/材料", rawDateText: null, verifiedBy: "forged-editor", verifiedAt: at, conflictsWith: [] },
      { id: "deadline-evidence", eventId, version: 1, sourceId: "official", fieldKey: "submission.endsAt", excerpt: `截止 ${deadline}。`, locator: "规则/日期", rawDateText: deadline, verifiedBy: "forged-editor", verifiedAt: at, conflictsWith: [] },
      { id: "submission-evidence", eventId, version: 1, sourceId: "official", fieldKey: "submission.submissionUrl", excerpt: "作品提交入口 https://example.test/submit", locator: "规则/提交", rawDateText: null, verifiedBy: "forged-editor", verifiedAt: at, conflictsWith: [] },
    ],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: `${key} 尚未说明`, status: "unknown", evidenceIds: [] })),
    stages: [{ id: "submission", stageType: "submission", name: "提交作品", startsAt: null, endsAt: { rawText: deadline, timeZone: "Asia/Shanghai", utc: "2026-10-20T12:00:00.000Z", dateOnly: false, evidenceIds: ["deadline-evidence"] }, submissionUrl: "https://example.test/submit" }],
    requirements: [{ id: "demo", label: "演示材料", necessity: "required", stageId: "submission", evidenceIds: ["demo-evidence"] }], qualityFlags: ["missing_information"],
  };
}
const resource: ResourceInput = {
  name: "测试设计资料", officialUrl: "https://example.test/design", type: "inspiration",
  stageTags: ["design"], useTags: ["layout"], stackTags: ["stack_agnostic"], prerequisites: ["browse"],
  summary: "人工精选布局资料", suitableFor: "设计起步", notSuitableFor: "未经许可复制素材", quickStart: ["浏览官方案例"],
  costType: "unknown", costNote: "未说明", costSourceUrl: null, costVerifiedAt: null,
  licenseStatus: "unknown", licenseNote: "未说明", licenseSourceUrl: null, licenseVerifiedAt: null,
  verifiedAt: at, linkStatus: "available", displayOrder: 1,
};
function matches(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }
async function fixture() {
  const database = await createDatabase({});
  await database.migrate();
  for (const actor of [admin, reviewer, user]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,$1,'Asia/Shanghai',$3::text[],$4::timestamptz,$4::timestamptz)", [actor.userId, `${actor.userId}@example.test`, [...actor.platformRoles], at]);
  }
  let failPublishAudit = false;
  let actor: Actor | null = admin;
  let csrfBlocked = false;
  let sequence = 0;
  const ids = { next: () => `operations-integration-${++sequence}` };
  const clock = { now: () => new Date(at) };
  const faultSql = (sql: SqlExecutor): SqlExecutor => ({ async query<Row>(statement: string, values?: readonly unknown[]) {
    if (failPublishAudit && statement.startsWith("INSERT INTO operations_event_review_audit") && String(values?.[4]).includes('"action":"event_published"')) throw new DomainError("TEST_AUDIT_FAILURE", "模拟发布后的审核审计失败。", { status: 503 });
    return sql.query<Row>(statement, values);
  } });
  const compositionDatabase: DatabasePort = {
    query: (sql, values) => database.query(sql, values),
    transaction: work => database.transaction(sql => work(faultSql(sql))),
  };
  const eventsRepository = new PostgresEventsRepository(compositionDatabase);
  const events = new EventsService({ repository: eventsRepository, projectAccess: { async getMembership() { return null; } }, clock, ids });
  const resources = new ResourceService({ repository: createPostgresResourceRepository(compositionDatabase), reviews: { async getApprovedReview() { return null; } }, clock, ids });
  const operations = createOperationsIntegration({ database: compositionDatabase, eventsRepository, events, resources, clock, ids,
    resolveActor: async () => actor, assertMutationAllowed: async () => { if (csrfBlocked) throw new DomainError("CSRF_REJECTED", "来源不匹配。", { status: 403 }); },
  });
  return { database, operations, events, resources, setActor(value: Actor | null) { actor = value; }, blockCsrf() { csrfBlocked = true; },
    failPublishAudit(value: boolean) { failPublishAudit = value; }, async count(table: string) {
      const result = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`); return Number(result.rows[0]!.count);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function approve(f: Fixture, review: EventReview, actor = reviewer) {
  const detail = await f.operations.services.eventReview.getDetail(actor, review.id);
  return f.operations.services.eventReview.approve(actor, review.id, { expectedRevision: review.revision, expectedCandidateRevision: detail.candidate.revision,
    checkedKeys: criticalFieldKeys, acknowledgedUnknownKeys: detail.candidate.criticalFields.filter(field => field.state === "unknown").map(field => field.key), reason: "逐项人工核验，未知事项保留明确标记。" }, "approve-request");
}
async function publish(f: Fixture, review: EventReview) {
  const detail = await f.operations.services.eventReview.getDetail(reviewer, review.id);
  return f.operations.services.eventReview.publish(reviewer, review.id, { expectedRevision: review.revision, expectedCandidateRevision: detail.candidate.revision,
    expectedPublishedVersion: detail.candidate.currentPublishedVersion, reason: "公开审核通过的规则快照。" }, "publish-request");
}
function request(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/v1/test", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("real PGlite: manual M03 evidence → M08 approve → public pointer/audits commit together", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const pending = await f.operations.services.eventReview.submitManual(admin, { content: rules() }, "manual-request");
  await assert.rejects(() => f.events.getEvent("event-1"), matches("NOT_FOUND"));
  const detail = await f.operations.services.eventReview.getDetail(reviewer, pending.id);
  f.setActor(reviewer);
  const evidenceHandler = f.operations.resolveRoute("GET", ["admin", "event-reviews", pending.id, "evidence"]);
  assert.ok(evidenceHandler);
  const evidenceResponse = await evidenceHandler(request("GET"));
  assert.equal(evidenceResponse.status, 200);
  const evidenceEnvelope = await evidenceResponse.json() as { data: { rules: EventRuleVersion; contentHash: string; candidateRevision: number } };
  assert.equal(evidenceEnvelope.data.contentHash, detail.candidate.contentHash);
  assert.equal(evidenceEnvelope.data.candidateRevision, detail.candidate.revision);
  assert.equal(evidenceEnvelope.data.rules.sources[0]?.url, "https://example.test/rules");
  assert.ok(evidenceEnvelope.data.rules.evidence.every(item => item.verifiedBy === admin.userId));
  f.setActor(user); assert.equal((await evidenceHandler(request("GET"))).status, 403);
  f.setActor(null); assert.equal((await evidenceHandler(request("GET"))).status, 401);
  f.setActor(admin);
  assert.deepEqual(detail.candidate.criticalFields.map(field => [field.key, field.state]), [["eligibility", "unknown"], ["deadlines", "unknown"], ["fees", "unknown"], ["deliverables", "known"], ["submission", "known"]]);
  const published = await publish(f, await approve(f, pending));
  assert.equal(published.status, "published");
  const event = await f.events.getEvent("event-1"); assert.equal(event.rules.version, 1);
  assert.ok(event.rules.evidence.every(evidence => evidence.verifiedBy === admin.userId));
  assert.equal(await f.count("m03_events_outbox"), 1); assert.equal(await f.count("integration_public_versions"), 1);
  const head = await f.database.query<{ published_version: number }>("SELECT published_version FROM integration_event_candidates"); assert.equal(head.rows[0]!.published_version, 1);
  assert.equal(await f.count("operations_event_review_audit"), 3);
});

test("real PGlite: failure after M03 publication rolls back pointer, metadata, outbox and M08 status", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const pending = await f.operations.services.eventReview.submitManual(admin, { content: rules() }, "manual-request");
  const approved = await approve(f, pending); f.failPublishAudit(true);
  await assert.rejects(() => publish(f, approved), matches("TEST_AUDIT_FAILURE"));
  await assert.rejects(() => f.events.getEvent("event-1"), matches("NOT_FOUND"));
  assert.equal((await f.operations.services.eventReview.getDetail(reviewer, approved.id)).review.status, "approved");
  assert.equal(await f.count("m03_events_outbox"), 0); assert.equal(await f.count("integration_public_versions"), 0);
  const meta = await f.database.query<{ published_version: number | null }>("SELECT published_version FROM integration_event_candidates"); assert.equal(meta.rows[0]!.published_version, null);
  f.failPublishAudit(false); await publish(f, approved); assert.equal(await f.count("m03_events_outbox"), 1);
});

test("real PGlite: bad source/evidence references cannot create a candidate or review", async t => {
  const f = await fixture(); t.after(() => f.database.close()); const invalid = rules(); invalid.evidence[0]!.sourceId = "missing-official-snapshot";
  await assert.rejects(() => f.operations.services.eventReview.submitManual(admin, { content: invalid }, "bad-request"), matches("INVALID_RULE_VERSION"));
  for (const table of ["m03_events", "m03_rule_versions", "integration_event_candidates", "operations_event_reviews"]) assert.equal(await f.count(table), 0);
});

test("real PGlite: candidate revision preserves creator/history, changes editor and invalidates old approval", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const pending = await f.operations.services.eventReview.submitManual(admin, { content: rules() }, "manual-request");
  const approved = await approve(f, pending); const edited = rules(); edited.metadata.name = "更新后的赛事";
  const updated = await f.operations.services.eventReview.reviseManual(reviewer, approved.id, { expectedRevision: approved.revision, expectedCandidateRevision: 1, content: edited, reason: "核对更新官方标题。" }, "revise-request");
  const detail = await f.operations.services.eventReview.getDetail(admin, updated.id);
  assert.equal(detail.candidate.createdBy, admin.userId); assert.equal(detail.candidate.lastModifiedBy, reviewer.userId); assert.equal(detail.candidate.origin, "manual"); assert.equal(detail.candidate.revision, 2);
  assert.equal(updated.status, "pending"); assert.equal(updated.reviewedBy, null);
  assert.equal(await f.count("integration_event_candidate_revisions"), 2); assert.equal(await f.count("m03_rule_versions"), 2);
  await assert.rejects(() => publish(f, approved), matches("VERSION_CONFLICT"));
  await publish(f, await approve(f, updated)); assert.equal((await f.events.getEvent("event-1")).rules.version, 2);
  await assert.rejects(() => f.database.query("UPDATE integration_event_candidate_revisions SET created_by=$1", [reviewer.userId]), /append-only/);
});

test("real PGlite: publication adapter requires an actual matching M08 approval", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const pending = await f.operations.services.eventReview.submitManual(admin, { content: rules() }, "manual-request");
  const candidate = (await f.operations.services.eventReview.getDetail(reviewer, pending.id)).candidate;
  await assert.rejects(() => f.database.transaction(tx => f.operations.services.eventReview.dependencies.events.publishCandidate(tx, {
    actor: admin, candidateId: candidate.candidateId, expectedRevision: candidate.revision, expectedContentHash: candidate.contentHash,
    expectedPublishedVersion: null, reviewId: pending.id, reviewedAt: at, reason: "直接调用", requestId: "bypass-request",
  })), matches("REVIEW_REQUIRED"));
  assert.equal(await f.count("m03_events_outbox"), 0);
  assert.equal(f.operations.resolveRoute("POST", ["admin", "events", "event-1", "publish"]), null);
});

test("real PGlite: event corrections use the one M08 queue, including formerly public versions", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const pending = await f.operations.services.eventReview.submitManual(admin, { content: rules() }, "manual-request");
  const input = { target: { kind: "event" as const, entityId: "event-1", version: 1 }, field: "fees", message: "费用页面有新说明。" };
  await assert.rejects(() => f.operations.services.corrections.submit(user, input), matches("NOT_FOUND"));
  await publish(f, await approve(f, pending));
  const correction = await f.operations.services.corrections.submit(user, input);
  assert.equal((await f.operations.services.corrections.listQueue(reviewer))[0]!.id, correction.id);
  assert.equal(await f.count("m03_event_corrections"), 0);
  await assert.rejects(() => f.operations.services.corrections.getOwn(admin, correction.id), matches("NOT_FOUND"));
  await f.operations.services.eventReview.withdraw(reviewer, { eventId: "event-1", expectedPublishedVersion: 1, reason: "官方撤下赛事。" }, "withdraw-request");
  await f.operations.services.corrections.submit(user, input); assert.equal(await f.count("operations_corrections"), 2);
});

test("real PGlite: route method/role/CSRF guards and disabled queue produce no phantom execution", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const wrongMethod = f.operations.resolveRoute("GET", ["admin", "event-reviews", "some-review", "approve"])!;
  assert.equal((await wrongMethod(request("GET"))).status, 405);
  f.setActor(user); assert.equal((await f.operations.handlers.eventReview.list(request("GET"))).status, 403);
  f.setActor(admin);
  const source = await f.operations.services.source.create(admin, { name: "已配置但未执行来源", ownerUserId: admin.userId, type: "official_rules", acquisitionMethod: "restricted_http",
    sampleUrl: "https://docs.github.com/rules", networkPolicy: { version: 1, rules: [{ hostname: "docs.github.com", pathPrefix: "/rules" }], maxRedirects: 0, maxBytes: 1000, timeoutMs: 1000, acceptedContentTypes: ["text/html"] }, minimumIntervalSeconds: 300 });
  assert.equal(source.status, "proposed");
  const crawl = f.operations.resolveRoute("POST", ["admin", "sources", source.id, "crawl"])!;
  assert.equal((await crawl(request("POST", { expectedSourceRevision: 1, targetUrl: source.sampleUrl, adapterVersion: "v1", idempotencyKey: "crawl-1" }))).status, 503);
  assert.equal(await f.count("operations_execution_runs"), 0); assert.equal(await f.count("operations_source_configs"), 1);
  f.blockCsrf(); assert.equal((await f.operations.handlers.eventReview.submitManual(request("POST", { content: rules() }))).status, 403);
  assert.equal(await f.count("integration_event_candidates"), 0);
});

test("real PGlite: M09 draft → M08 resource review → public resource, correction and publication reference", async t => {
  const f = await fixture(); t.after(() => f.database.close());
  const draft = await f.resources.createDraft(admin, resource);
  const submit = f.operations.resolveRoute("POST", ["admin", "resources", draft.id, "request-review"])!;
  const response = await submit(request("POST", { expectedRevision: draft.revision })); assert.equal(response.status, 200);
  const body = await response.json() as { data: { resource: { revision: number }; review: { id: string; revision: number } } };
  const approved = await f.operations.services.resourceReview.decide(reviewer, body.data.review.id, { expectedRevision: body.data.review.revision, expectedResourceRevision: body.data.resource.revision, decision: "approved", reason: "官方链接有效，费用许可明确未知。",
    verification: { link: { status: "available", checkedUrl: resource.officialUrl }, fees: { status: "unknown", sourceUrl: null }, license: { status: "unknown", sourceUrl: null } } }, "resource-approve");
  await f.operations.services.resourceReview.publish(reviewer, approved.id, { expectedRevision: approved.revision, expectedResourceRevision: body.data.resource.revision }, "resource-publish");
  assert.equal((await f.resources.detail(draft.id)).publicationStatus, "published"); assert.equal(await f.count("integration_public_versions"), 1);
  const correction = await f.operations.submitResourceCorrection(user, { resourceId: draft.id, kind: "cost", note: "请核查费用页面。" });
  assert.equal((await f.operations.services.corrections.listQueue(reviewer))[0]!.id, correction.id);
});
