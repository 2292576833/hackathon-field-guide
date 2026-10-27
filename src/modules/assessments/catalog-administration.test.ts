import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PILOT_QUESTION_SET, PILOT_RUBRIC } from "./catalog.ts";
import { createAssessmentCatalogAdministration, createAssessmentCatalogHttpHandlers } from "./catalog-administration.ts";
import type { CatalogReviewDetails } from "./catalog-administration.ts";
import { PostgresAssessmentRepository, PostgresQuestionCatalog } from "./postgres.ts";
import { AssessmentService } from "./service.ts";
import type { QuestionSet } from "./types.ts";

// Real embedded PostgreSQL and the proposed module migrations; no remote PG or human review is claimed.
let engine: PGlite;
let database: DatabasePort;
let sequence = 0;
const REVIEWER: Actor = { userId: "test-reviewer", platformRoles: ["reviewer"] };
const ADMIN: Actor = { userId: "test-admin", platformRoles: ["admin"] };
const MEMBER: Actor = { userId: "test-user", platformRoles: ["user"] };
const PROJECT_MANAGER: Actor = { userId: "test-project-manager", platformRoles: ["user"] };
const clock = { now: () => new Date("2026-10-08T02:00:00.000Z") };
const ids = { next: () => `catalog-fixture-${++sequence}` };
const REVIEW_NOTE = "测试审核说明：已逐题检查新人任务说明、允许工具、评分项引用、每个行为锚点与证据不足规则；科学校准尚未完成。";

function executor(query: (sql: string, parameters: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
  return { async query<Row>(sql: string, parameters: readonly unknown[] = []) {
    const result = await query(sql, [...parameters]);
    return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
  } };
}
before(async () => {
  engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./sql/001-assessments.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("./sql/003-assessment-catalog-review.sql", import.meta.url), "utf8"));
  const direct = executor((sql, parameters) => engine.query(sql, parameters));
  database = {
    query: direct.query,
    transaction: (work) => engine.transaction((transaction) => work(executor((sql, parameters) => transaction.query(sql, parameters)))),
  };
});
after(async () => { await engine?.close(); });

function fixture() {
  const service = createAssessmentCatalogAdministration({ database, clock, ids });
  const questionSet: QuestionSet = { ...structuredClone(PILOT_QUESTION_SET), id: `catalog-question-fixture-${++sequence}` };
  const input = { questionSet, rubric: PILOT_RUBRIC };
  return { service, input, id: questionSet.id };
}
function errorCode(code: string, status?: number) {
  return (error: unknown): boolean => { assert.ok(error instanceof DomainError); assert.equal(error.code, code); if (status !== undefined) assert.equal(error.status, status); return true; };
}
function storedDetails({ created: _created, ...details }: CatalogReviewDetails & { readonly created: boolean }): CatalogReviewDetails { return details; }
function databaseConstraint(error: unknown): boolean { assert.equal((error as { code?: string }).code, "23514"); return true; }
async function reviewedFixture() {
  const current = fixture(); const seeded = await current.service.seedDraft(REVIEWER, current.input);
  const reviewed = await current.service.reviewQuestionSet(REVIEWER, current.id, seeded.review.revision, REVIEW_NOTE);
  return { ...current, reviewed };
}

test("default pilot seed stays draft, has no invented reviewer/publication, and idempotent replay never overwrites", async () => {
  const service = createAssessmentCatalogAdministration({ database, clock, ids });
  const seed = await service.seedDraft(REVIEWER);
  assert.equal(seed.created, true); assert.equal(seed.questionSet.status, "draft"); assert.equal(PILOT_QUESTION_SET.status, "draft");
  assert.equal(seed.review.revision, 1); assert.equal(seed.review.reviewedBy, null); assert.equal(seed.review.reviewedAt, null);
  assert.equal(seed.review.publishedAt, null); assert.equal(seed.audit.length, 1); assert.equal(seed.audit[0]!.action, "seeded");
  assert.ok(seed.audit[0]!.note.includes("尚未通过本次人工审核"));
  const repeat = await service.seedDraft(ADMIN);
  assert.equal(repeat.created, false); assert.deepEqual(repeat.review, seed.review); assert.deepEqual(repeat.audit, seed.audit);
  assert.deepEqual(await service.listPublishedQuestionSets(MEMBER), []);
  const queue = await service.listReviewQueue(REVIEWER);
  assert.equal(queue.find((entry) => entry.questionSetId === PILOT_QUESTION_SET.id)?.status, "draft");
});

test("only trusted platform reviewers/admins can administer the catalog; project manager grants no publication permission", async () => {
  const current = fixture(); const seed = await current.service.seedDraft(REVIEWER, current.input);
  for (const actor of [MEMBER, PROJECT_MANAGER]) {
    await assert.rejects(current.service.seedDraft(actor, current.input), errorCode("FORBIDDEN", 403));
    await assert.rejects(current.service.listReviewQueue(actor), errorCode("FORBIDDEN", 403));
    await assert.rejects(current.service.getCatalogDetails(actor, current.id), errorCode("FORBIDDEN", 403));
    await assert.rejects(current.service.reviewQuestionSet(actor, current.id, 1, REVIEW_NOTE), errorCode("FORBIDDEN", 403));
    await assert.rejects(current.service.publishQuestionSet(actor, current.id, 1, "发布"), errorCode("FORBIDDEN", 403));
    await assert.rejects(current.service.retireQuestionSet(actor, current.id, 1, "停用"), errorCode("FORBIDDEN", 403));
  }
  await assert.rejects(current.service.listPublishedQuestionSets({ userId: "", platformRoles: ["admin"] }), errorCode("UNAUTHENTICATED", 401));
  assert.deepEqual(await current.service.getCatalogDetails(REVIEWER, current.id), storedDetails(seed));
});

test("review → publication → retirement persists CAS actor/note/audit facts and enables a real PostgreSQL-backed attempt", async () => {
  const current = await reviewedFixture(); const { service, id } = current;
  assert.equal(current.reviewed.questionSet.status, "reviewed"); assert.equal(current.reviewed.review.reviewedBy, REVIEWER.userId);
  assert.equal((await service.listPublishedQuestionSets(MEMBER)).some((set) => set.id === id), false);
  const published = await service.publishQuestionSet(ADMIN, id, current.reviewed.review.revision, "测试发布确认：保留未校准限制，允许试用此固定题组。");
  assert.equal(published.questionSet.status, "published"); assert.equal(published.review.revision, 3);
  assert.equal(published.review.publishedBy, ADMIN.userId); assert.equal(published.review.reviewedBy, REVIEWER.userId);
  assert.deepEqual(published.questionSet.limitations, PILOT_QUESTION_SET.limitations); assert.deepEqual(published.rubric, PILOT_RUBRIC);
  assert.deepEqual(published.audit.map((entry) => [entry.revision, entry.action, entry.actorId]), [[1, "seeded", REVIEWER.userId], [2, "reviewed", REVIEWER.userId], [3, "published", ADMIN.userId]]);
  assert.equal((await service.listPublishedQuestionSets(MEMBER)).some((set) => set.id === id), true);
  assert.equal((await service.listReviewQueue(ADMIN)).some((entry) => entry.questionSetId === id), false);
  const catalog = new PostgresQuestionCatalog(database);
  assert.equal((await catalog.getQuestionSet(id))!.status, "published");
  const assessment = new AssessmentService({
    repository: new PostgresAssessmentRepository(database), catalog, clock, ids,
    projectAccess: { getMembership: async () => ({ projectId: "catalog-test-project", membershipId: "catalog-test-membership", userId: MEMBER.userId, status: "active", role: "member" }) },
    assignmentContext: { getSnapshot: async () => ({ projectId: "catalog-test-project", projectRevision: 1, membershipRevision: 1, requirementVersionId: null,
      members: [{ membershipId: "catalog-test-membership", userId: MEMBER.userId, status: "active", role: "member", memberAvailabilityVersionId: null }] }) },
  });
  const attempt = await assessment.createAttempt(MEMBER, "catalog-test-project", id);
  assert.equal(attempt.status, "draft"); assert.equal(attempt.questionSetSnapshot.status, "published");
  const retired = await service.retireQuestionSet(REVIEWER, id, 3, "测试停用：新题组版本待审核，旧回答及量规继续保留。");
  assert.equal(retired.questionSet.status, "retired"); assert.equal(retired.review.revision, 4);
  assert.equal(retired.audit[3]!.previousStatus, "published"); assert.equal(retired.audit[3]!.nextStatus, "retired");
  assert.equal((await service.listPublishedQuestionSets(MEMBER)).some((set) => set.id === id), false);
  await assert.rejects(assessment.createAttempt(MEMBER, "catalog-test-project", id), errorCode("QUESTION_SET_UNAVAILABLE"));
  assert.equal((await assessment.getPrivateReport(MEMBER, attempt.id)).attempt.questionSetSnapshot.status, "published");
  const replay = await service.seedDraft(ADMIN, current.input);
  assert.equal(replay.created, false); assert.deepEqual(replay.review, retired.review); assert.deepEqual(replay.audit, retired.audit);
});

test("publication requires explicit prior review; blank notes and stale revisions never alter catalog facts", async () => {
  const current = fixture(); const seeded = await current.service.seedDraft(REVIEWER, current.input);
  await assert.rejects(current.service.publishQuestionSet(REVIEWER, current.id, 1, "跳过审核"), errorCode("CATALOG_STATE_CONFLICT", 409));
  await assert.rejects(current.service.retireQuestionSet(REVIEWER, current.id, 1, "尚未发布"), errorCode("CATALOG_STATE_CONFLICT", 409));
  await assert.rejects(current.service.reviewQuestionSet(REVIEWER, current.id, 1, "  "), errorCode("INVALID_INPUT"));
  assert.deepEqual(await current.service.getCatalogDetails(REVIEWER, current.id), storedDetails(seeded));
  const reviewed = await current.service.reviewQuestionSet(REVIEWER, current.id, 1, REVIEW_NOTE);
  await assert.rejects(current.service.publishQuestionSet(ADMIN, current.id, 1, "过期审批"), errorCode("VERSION_CONFLICT", 409));
  assert.deepEqual(await current.service.getCatalogDetails(REVIEWER, current.id), reviewed);
});

test("same-ID imports cannot change seeded content or fixed rubrics, and invalid catalogs never reach PostgreSQL", async () => {
  const current = fixture(); const seed = await current.service.seedDraft(REVIEWER, current.input);
  await assert.rejects(current.service.seedDraft(REVIEWER, { ...current.input, questionSet: { ...current.input.questionSet, difficultyLabel: "覆盖同版本内容" } }), errorCode("CATALOG_ID_CONFLICT", 409));
  await assert.rejects(current.service.seedDraft(REVIEWER, { ...current.input, rubric: { ...PILOT_RUBRIC, limitations: ["试图覆盖量规"] } }), errorCode("CATALOG_ID_CONFLICT", 409));
  await assert.rejects(current.service.seedDraft(REVIEWER, { ...current.input, questionSet: { ...current.input.questionSet, status: "published" } }), errorCode("CATALOG_DRAFT_REQUIRED"));
  await assert.rejects(current.service.seedDraft(REVIEWER, { ...current.input, questionSet: { ...current.input.questionSet, maxFollowUps: 4 } }), errorCode("INVALID_QUESTION_CATALOG"));
  await assert.rejects(current.service.seedDraft(REVIEWER, { ...current.input, rubric: { ...PILOT_RUBRIC, criteria: PILOT_RUBRIC.criteria.map((criterion, index) => index ? criterion : { ...criterion, anchors: [] }) } }), errorCode("INVALID_QUESTION_CATALOG"));
  assert.deepEqual(await current.service.getCatalogDetails(REVIEWER, current.id), storedDetails(seed));
});

test("legacy draft import can gain a seed record, but legacy publication cannot gain invented review history", async () => {
  const current = fixture();
  await database.query("INSERT INTO assessments_question_sets(id,version,rubric_version_id,status,data) VALUES ($1,1,$2,'draft',$3::jsonb)", [current.id, PILOT_RUBRIC.id, JSON.stringify(current.input.questionSet)]);
  const adopted = await current.service.seedDraft(REVIEWER, current.input);
  assert.equal(adopted.created, true); assert.equal(adopted.questionSet.status, "draft");
  assert.equal(adopted.review.reviewedAt, null); assert.deepEqual(adopted.audit.map((entry) => entry.action), ["seeded"]);
  const legacyPublished = fixture();
  await database.query("INSERT INTO assessments_question_sets(id,version,rubric_version_id,status,data) VALUES ($1,1,$2,'published',$3::jsonb)", [legacyPublished.id, PILOT_RUBRIC.id, JSON.stringify({ ...legacyPublished.input.questionSet, status: "published" })]);
  await assert.rejects(legacyPublished.service.seedDraft(ADMIN, legacyPublished.input), errorCode("CATALOG_REVIEW_METADATA_REQUIRED", 409));
  assert.equal((await database.query("SELECT question_set_id FROM assessments_catalog_reviews WHERE question_set_id=$1", [legacyPublished.id])).rowCount, 0);
  assert.equal((await legacyPublished.service.listPublishedQuestionSets(MEMBER)).some((set) => set.id === legacyPublished.id), false);
});

test("competing reviews and repeated draft seeds preserve one winner and one audit revision", async () => {
  const current = fixture();
  const seeds = await Promise.all([current.service.seedDraft(REVIEWER, current.input), current.service.seedDraft(ADMIN, current.input)]);
  assert.equal(seeds.filter((entry) => entry.created).length, 1);
  const reviews = await Promise.allSettled([
    current.service.reviewQuestionSet(REVIEWER, current.id, 1, REVIEW_NOTE),
    current.service.reviewQuestionSet(ADMIN, current.id, 1, "第二个审核人使用旧版本。"),
  ]);
  assert.equal(reviews.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = reviews.find((result) => result.status === "rejected"); assert.ok(rejection && rejection.status === "rejected");
  assert.ok(errorCode("VERSION_CONFLICT", 409)(rejection.reason));
  const result = await current.service.getCatalogDetails(ADMIN, current.id);
  assert.equal(result.review.revision, 2); assert.equal(result.audit.length, 2);
});

test("reviewed content changed through a SQL bypass cannot publish under its original approval", async () => {
  const current = await reviewedFixture();
  await database.query("UPDATE assessments_question_sets SET data=jsonb_set(data,'{difficultyLabel}',to_jsonb($2::text)) WHERE id=$1", [current.id, "旁路变更题面条件"]);
  await assert.rejects(current.service.publishQuestionSet(ADMIN, current.id, 2, "沿用旧审核"), errorCode("CATALOG_CONTENT_CHANGED", 409));
  const result = await current.service.getCatalogDetails(ADMIN, current.id);
  assert.equal(result.questionSet.status, "reviewed"); assert.equal(result.review.revision, 2); assert.equal(result.audit.length, 2);
});

test("database guards keep rubric/published body/audit immutable and reject incomplete reviewer metadata", async () => {
  const current = await reviewedFixture(); const published = await current.service.publishQuestionSet(ADMIN, current.id, 2, "测试发布固定内容。");
  await assert.rejects(database.query("UPDATE assessments_rubrics SET data=data WHERE id=$1", [PILOT_RUBRIC.id]), databaseConstraint);
  await assert.rejects(database.query("UPDATE assessments_question_sets SET data=jsonb_set(data,'{difficultyLabel}',to_jsonb($2::text)) WHERE id=$1", [current.id, "修改发布正文"]), databaseConstraint);
  await assert.rejects(database.query("UPDATE assessments_question_sets SET status='draft' WHERE id=$1", [current.id]), databaseConstraint);
  await assert.rejects(database.query("UPDATE assessments_catalog_audit SET note='覆盖审核历史' WHERE question_set_id=$1", [current.id]), databaseConstraint);
  await assert.rejects(database.query("DELETE FROM assessments_catalog_audit WHERE question_set_id=$1", [current.id]), databaseConstraint);
  const draftOnly = fixture(); await draftOnly.service.seedDraft(REVIEWER, draftOnly.input);
  await assert.rejects(database.query("UPDATE assessments_catalog_reviews SET revision=2,reviewed_at=$2 WHERE question_set_id=$1", [draftOnly.id, clock.now().toISOString()]), databaseConstraint);
  assert.deepEqual(await current.service.getCatalogDetails(ADMIN, current.id), published);
});

test("an audit insertion failure rolls back publication and reviewer metadata atomically", async () => {
  const current = await reviewedFixture();
  const faultDatabase: DatabasePort = {
    query: database.query,
    transaction: (work) => database.transaction((sql) => work({ query: async <Row>(statement: string, parameters: readonly unknown[] = []) => {
      if (statement.includes("INSERT INTO assessments_catalog_audit")) throw new Error("PRIVATE_DATABASE_DETAIL audit storage failure");
      return sql.query<Row>(statement, parameters);
    } })),
  };
  const faultService = createAssessmentCatalogAdministration({ database: faultDatabase, clock, ids });
  const handlers = createAssessmentCatalogHttpHandlers({ service: faultService, resolveActor: async () => ADMIN, requestIds: ids });
  const response = await handlers.publish(new Request("https://fixture.test/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2, note: "测试发布确认。" }) }), { questionSetId: current.id });
  assert.equal(response.status, 500); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.text()).includes("PRIVATE_DATABASE_DETAIL"), false);
  assert.deepEqual(await current.service.getCatalogDetails(ADMIN, current.id), current.reviewed);
});

test("HTTP factories enforce verified actors, strict JSON/size/method guards and expose only published public content", async () => {
  const current = fixture();
  const handler = (actor: Actor | null) => createAssessmentCatalogHttpHandlers({ service: current.service, resolveActor: async () => actor, requestIds: ids });
  const post = (data: unknown, mediaType = "application/json") => new Request("https://fixture.test/catalog", { method: "POST", headers: { "content-type": mediaType }, body: JSON.stringify(data) });
  assert.equal((await handler(null).listPublished(new Request("https://fixture.test/catalog"))).status, 401);
  assert.equal((await handler(MEMBER).seedDraft(post({}))).status, 403);
  assert.equal((await handler(REVIEWER).seedDraft(post({ questionSet: current.input.questionSet }))).status, 422);
  assert.equal((await handler(REVIEWER).seedDraft(post({ actor: ADMIN }))).status, 422);
  assert.equal((await handler(REVIEWER).seedDraft(post({}, "text/plain"))).status, 415);
  assert.equal((await handler(REVIEWER).seedDraft(post({ padding: "x".repeat(262144) }))).status, 413);
  assert.equal((await handler(REVIEWER).review(new Request("https://fixture.test/catalog"), { questionSetId: current.id })).status, 405);
  const seedResponse = await handler(REVIEWER).seedDraft(post(current.input)); assert.equal(seedResponse.status, 200);
  assert.equal((await handler(MEMBER).reviewQueue(new Request("https://fixture.test/catalog"))).status, 403);
  assert.equal((await handler(MEMBER).details(new Request("https://fixture.test/catalog"), { questionSetId: current.id })).status, 403);
  assert.equal((await handler(REVIEWER).review(post({ expectedRevision: 1, note: REVIEW_NOTE, platformRoles: ["admin"] }), { questionSetId: current.id })).status, 422);
  assert.equal((await handler(REVIEWER).review(post({ expectedRevision: 1, note: REVIEW_NOTE }), { questionSetId: current.id })).status, 200);
  assert.equal((await handler(ADMIN).publish(post({ expectedRevision: 2, note: "测试发布确认。" }), { questionSetId: current.id })).status, 200);
  const listResponse = await handler(MEMBER).listPublished(new Request("https://fixture.test/catalog")); assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as { data: QuestionSet[] };
  const publicSet = list.data.find((entry) => entry.id === current.id)!; assert.equal(publicSet.status, "published");
  for (const token of ["test-reviewer", "test-admin", "review_note", "publication_note", "contentFingerprint", REVIEW_NOTE]) assert.equal(JSON.stringify(publicSet).includes(token), false);
  assert.equal((await handler(ADMIN).retire(post({ expectedRevision: 3, note: "测试停用版本。" }), { questionSetId: current.id })).status, 200);
});
