import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { normalizeResourceQuery } from "./domain.ts";
import type { Resource, ResourceBookmark, ResourceRecord } from "./domain.ts";
import { createResourceHandlers } from "./handlers.ts";
import { createOperationsResourcePublicationAdapter, resourceContentHash } from "./integration.ts";
import type { OperationsResourceReview } from "./integration.ts";
import { createPostgresResourceRepository } from "./postgres.ts";
import { ResourceService } from "./service.ts";
import { MemoryResourceRepository } from "./testing/memory-repository.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const CHECKED = "2026-10-08T11:00:00.000Z";
const reviewer: Actor = {userId: "reviewer-session", platformRoles: ["reviewer"]};
const owner: Actor = {userId: "owner-session", platformRoles: ["user"]};

function resource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: "resource-1", version: 1, revision: 2, name: "Form starter", officialUrl: "https://resource.example.invalid/docs",
    type: "ui_visual", stageTags: ["development"], useTags: ["form"], stackTags: ["react"], prerequisites: ["basic_code"],
    summary: "帮助新人实现表单界面", suitableFor: "需要表单组件的队伍", notSuitableFor: "需自行检查赛事规则", quickStart: ["查看官方文档"],
    costType: "unknown", costNote: "费用尚未核验", costSourceUrl: null, costVerifiedAt: null,
    licenseStatus: "unknown", licenseNote: "许可尚未核验", licenseSourceUrl: null, licenseVerifiedAt: null,
    verifiedAt: "2026-10-08T10:00:00.000Z", linkStatus: "available", displayOrder: 1,
    publicationStatus: "in_review", reviewId: null, publishedAt: null, withdrawnReason: null, externalLinkBlocked: false,
    createdAt: NOW, updatedAt: NOW, recordedBy: reviewer.userId, ...overrides,
  };
}

function savedBookmark(overrides: Partial<ResourceBookmark> = {}): ResourceBookmark {
  return {id: "bookmark-1", userId: owner.userId, resourceId: "resource-1", purposeNote: "首次保存的用途", revision: 1, createdAt: NOW, updatedAt: NOW, ...overrides};
}

function bookmarkRow(value: ResourceBookmark) {
  return {id: value.id, user_id: value.userId, resource_id: value.resourceId, purpose_note: value.purposeNote,
    created_at: value.createdAt, updated_at: value.updatedAt, revision: value.revision};
}

type RecordedQuery = {statement: string; parameters: readonly unknown[]; inTransaction: boolean};
/** Records contracts and scripted rows; this fixture does not parse or execute PostgreSQL. */
class RecordingDatabase implements DatabasePort {
  readonly calls: RecordedQuery[] = [];
  readonly results: SqlResult<unknown>[] = [];
  transactions = 0;
  private transactionDepth = 0;

  enqueue(rows: readonly unknown[] = [], rowCount = rows.length): this {
    this.results.push({rows, rowCount});
    return this;
  }
  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({statement, parameters: structuredClone(parameters), inTransaction: this.transactionDepth > 0});
    assert.ok(this.results.length, `Missing scripted SQL result for: ${statement}`);
    return this.results.shift() as SqlResult<Row>;
  }
  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    this.transactionDepth += 1;
    try { return await work(this); }
    finally { this.transactionDepth -= 1; }
  }
}

function assertBound(call: RecordedQuery, untrustedValues: readonly string[] = []): void {
  const placeholders = [...call.statement.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
  assert.ok(placeholders.length, "Expected a parameterized SQL statement");
  assert.deepEqual([...new Set(placeholders)].sort((a, b) => a - b), Array.from({length: call.parameters.length}, (_, index) => index + 1));
  for (const value of untrustedValues) assert.ok(!call.statement.includes(value), `User data was interpolated into SQL: ${value}`);
}

async function rejectsCode(action: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("SQL 公开列表只搜索发布快照，筛选和特殊搜索文本全部绑定", async () => {
  const database = new RecordingDatabase().enqueue([{public_document: resource({publicationStatus: "published"})}]);
  const repository = createPostgresResourceRepository(database);
  const search = "needle' OR 1=1 --%_\\";
  const result = await repository.listPublished(normalizeResourceQuery({search, type: "ui_visual", stage: "development", stack: "react",
    prerequisite: "basic_code", use: "form", costType: "unknown", limit: 7, cursor: "14", sort: "name"}));
  const call = database.calls[0]!;
  assert.match(call.statement, /public_document->>'publicationStatus' = 'published'/);
  assert.ok(!call.statement.includes("working_document"));
  assert.match(call.statement, /ORDER BY public_document->>'name' COLLATE "C", id LIMIT \$8 OFFSET \$9/);
  assert.deepEqual(call.parameters, ["%needle' OR 1=1 --\\%\\_\\\\%", "ui_visual", "unknown", '["development"]', '["react"]', '["basic_code"]', '["form"]', 8, 14]);
  assertBound(call, [search]);
  assert.equal(result[0]?.id, "resource-1");
});

test("SQL 详情保留下架快照，草稿查询可加行锁且 ID 不进入 SQL", async () => {
  const id = "resource' OR true --";
  const withdrawn = resource({id, publicationStatus: "withdrawn", withdrawnReason: "入口风险", externalLinkBlocked: true});
  const working = resource({id, publicationStatus: "draft", name: "未公开修改"});
  const database = new RecordingDatabase().enqueue([{public_document: withdrawn}]).enqueue([{working_document: working, public_document: withdrawn}]);
  const repository = createPostgresResourceRepository(database);
  assert.deepEqual(await repository.getPublic(id), withdrawn);
  assert.deepEqual(await repository.getRecord(id, true), {resource: working, publicResource: withdrawn});
  assert.match(database.calls[0]!.statement, /publicationStatus' IN \('published', 'withdrawn'\)/);
  assert.ok(!database.calls[0]!.statement.includes("working_document"));
  assert.match(database.calls[1]!.statement, /WHERE id = \$1 FOR UPDATE$/);
  for (const call of database.calls) { assert.deepEqual(call.parameters, [id]); assertBound(call, [id]); }
});

test("SQL 资源写入绑定 JSON 快照、采用修订 CAS，并在同一事务追加历史", async () => {
  const document = resource({name: "sentinel'; DROP TABLE resource_records; --", revision: 3});
  const record: ResourceRecord = {resource: document, publicResource: null};
  const database = new RecordingDatabase().enqueue([], 1).enqueue([], 1).enqueue([{id: document.id}], 1).enqueue([], 1).enqueue([], 0);
  const repository = createPostgresResourceRepository(database);
  await repository.insertRecord(record);
  assert.equal(await repository.saveRecord(record, 2), true);
  assert.equal(await repository.saveRecord(record, 2), false);
  assert.equal(database.calls.length, 5, "A failed CAS must not append a revision");
  assert.match(database.calls[2]!.statement, /WHERE id = \$1 AND revision = \$5 RETURNING id$/);
  assert.deepEqual(database.calls[2]!.parameters, [document.id, document.revision, JSON.stringify(document), null, 2]);
  assert.ok(database.calls.every(call => call.inTransaction));
  assert.equal(database.transactions, 3);
  for (const call of database.calls) assertBound(call, [document.name]);
});

test("SQL 重复收藏 DO NOTHING 并返回原收藏，不覆盖备注、ID 或修订", async () => {
  const existing = savedBookmark({purposeNote: "original sentinel'; UPDATE --", revision: 4});
  const duplicate = savedBookmark({id: "replacement-id", purposeNote: "不要覆盖原备注"});
  const database = new RecordingDatabase().enqueue([], 0).enqueue([bookmarkRow(existing)]);
  const result = await createPostgresResourceRepository(database).putBookmark(duplicate);
  assert.deepEqual(result, existing);
  assert.match(database.calls[0]!.statement, /ON CONFLICT \(user_id, resource_id\) DO NOTHING$/);
  assert.ok(!database.calls[0]!.statement.includes("DO UPDATE"));
  assert.deepEqual(database.calls[1]!.parameters, [duplicate.userId, duplicate.resourceId]);
  assert.ok(database.calls.every(call => call.inTransaction));
  for (const call of database.calls) assertBound(call, [duplicate.purposeNote, existing.purposeNote]);
});

test("SQL 收藏读写和列表始终限制 owner，更新同时限制预期修订", async () => {
  const value = savedBookmark({userId: "owner' OR true --", id: "bookmark'; DELETE --", purposeNote: "note'; UPDATE --", revision: 2});
  const publicResource = resource({publicationStatus: "withdrawn", withdrawnReason: "已下架"});
  const database = new RecordingDatabase().enqueue([bookmarkRow(value)]).enqueue([], 0).enqueue([], 1).enqueue([], 1)
    .enqueue([{...bookmarkRow(value), public_document: publicResource}]);
  const repository = createPostgresResourceRepository(database);
  assert.deepEqual(await repository.getBookmark(value.id, value.userId, true), value);
  assert.equal(await repository.updateBookmark(value, 1), false);
  assert.equal(await repository.updateBookmark(value, 1), true);
  await repository.removeBookmark(value.id, value.userId);
  assert.deepEqual(await repository.listBookmarks(value.userId, 5, 7), [{bookmark: value, resource: publicResource}]);
  assert.match(database.calls[0]!.statement, /WHERE id = \$1 AND user_id = \$2 FOR UPDATE$/);
  assert.match(database.calls[1]!.statement, /WHERE id = \$1 AND user_id = \$2 AND revision = \$6 RETURNING id$/);
  assert.deepEqual(database.calls[1]!.parameters, [value.id, value.userId, value.purposeNote, value.updatedAt, value.revision, 1]);
  assert.match(database.calls[3]!.statement, /WHERE id = \$1 AND user_id = \$2$/);
  assert.match(database.calls[4]!.statement, /WHERE b.user_id = \$1/);
  assert.deepEqual(database.calls[4]!.parameters, [value.userId, 8, 5]);
  assert.ok(!database.calls[4]!.statement.includes("publicationStatus"), "Withdrawn references remain in the private collection");
  for (const call of database.calls) assertBound(call, [value.userId, value.id, value.purposeNote]);
});

function handlerFixture(actor: Actor | null = owner) {
  const published = resource({publicationStatus: "published", reviewId: "approved-1", publishedAt: NOW});
  const repository = new MemoryResourceRepository([{resource: published, publicResource: published}]);
  let sequence = 0;
  const ids = {next: () => `fixture-${++sequence}`};
  const service = new ResourceService({repository, reviews: {getApprovedReview: async () => null}, clock: {now: () => new Date(NOW)}, ids,
    corrections: {submit: async () => ({id: "correction-1"})}});
  const mutations: Request[] = [];
  const resolved: Request[] = [];
  const handlers = createResourceHandlers({service, requestIds: ids,
    async resolveActor(request) { resolved.push(request); return actor; },
    async assertMutationAllowed(request) { mutations.push(request); }});
  return {handlers, service, repository, mutations, resolved, published, ids};
}

function jsonRequest(input: unknown, method = "POST"): Request {
  return new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks", {
    method, headers: {"content-type": "application/json", "x-user-id": "attacker-header"}, body: JSON.stringify(input),
  });
}

function assertPrivate(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}

test("handler 身份仅来自登录会话，拒绝请求中的伪 userId", async () => {
  const f = handlerFixture();
  const rejected = await f.handlers.createBookmark(jsonRequest({resourceId: f.published.id, purposeNote: "私人用途", userId: "victim"}));
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error.code, "UNEXPECTED_REQUEST_FIELD");
  assert.equal((await f.service.listBookmarks(owner)).items.length, 0);
  const accepted = await f.handlers.createBookmark(jsonRequest({resourceId: f.published.id, purposeNote: "私人用途"}));
  assert.equal(accepted.status, 200);
  assertPrivate(accepted);
  const saved = (await accepted.json()).data as ResourceBookmark;
  assert.equal(saved.userId, owner.userId);
  assert.notEqual(saved.userId, "attacker-header");
  assert.equal(f.resolved.length, 1);
  assert.equal(f.mutations.length, 2);
  const unexpectedQuery = await f.handlers.listBookmarks(new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks?userId=victim"));
  assert.equal(unexpectedQuery.status, 422);
  assert.equal((await unexpectedQuery.json()).error.code, "INVALID_RESOURCE_QUERY");
});

test("handler 无登录收藏入口返回 401，私人成功和失败响应均禁止共享缓存", async () => {
  const f = handlerFixture(null);
  const responses = await Promise.all([
    f.handlers.listBookmarks(new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks")),
    f.handlers.createBookmark(jsonRequest({resourceId: f.published.id})),
    f.handlers.updateBookmark(jsonRequest({expectedRevision: 1, purposeNote: "备注"}, "PATCH"), "bookmark-1"),
    f.handlers.deleteBookmark(new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks/bookmark-1", {method: "DELETE"}), "bookmark-1"),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assertPrivate(response);
    assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");
  }
  assert.equal(f.mutations.length, 3);
});

test("handler 每个变更入口先调用 CSRF 钩子，失败时不读取会话或变更数据", async () => {
  const f = handlerFixture();
  const created = await f.handlers.createBookmark(jsonRequest({resourceId: f.published.id}));
  const saved = (await created.json()).data as ResourceBookmark;
  const changed = await f.handlers.updateBookmark(jsonRequest({expectedRevision: saved.revision, purposeNote: "新备注"}, "PATCH"), saved.id);
  assert.equal(changed.status, 200);
  assertPrivate(changed);
  const removed = await f.handlers.deleteBookmark(new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks/bookmark", {method: "DELETE"}), saved.id);
  assert.equal(removed.status, 200);
  assertPrivate(removed);
  const reported = await f.handlers.reportCorrection(jsonRequest({resourceId: f.published.id, kind: "broken_link", note: "入口打不开"}));
  assert.equal(reported.status, 200);
  assertPrivate(reported);
  assert.equal(f.mutations.length, 4);

  let actorReads = 0;
  let csrfCalls = 0;
  const blocked = createResourceHandlers({service: f.service, requestIds: f.ids,
    async resolveActor() { actorReads += 1; return owner; },
    async assertMutationAllowed() { csrfCalls += 1; throw new DomainError("CSRF_REJECTED", "来源不受信任。", {status: 403}); }});
  const response = await blocked.createBookmark(jsonRequest({resourceId: f.published.id}));
  assert.equal(response.status, 403);
  assert.equal(csrfCalls, 1);
  assert.equal(actorReads, 0);
  assert.equal((await f.service.listBookmarks(owner)).items.length, 0);
});

test("handler 未知异常不暴露堆栈、数据库信息或 provider 响应", async () => {
  const f = handlerFixture();
  f.repository.listBookmarks = async () => { throw new Error("postgres credential SECRET_DO_NOT_DISCLOSE at adapter.ts:99"); };
  const response = await f.handlers.listBookmarks(new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks"));
  assert.equal(response.status, 500);
  assertPrivate(response);
  const text = await response.text();
  assert.ok(!text.includes("SECRET_DO_NOT_DISCLOSE") && !text.includes("adapter.ts") && !text.includes("stack"));
  assert.deepEqual(JSON.parse(text).error, {code: "INTERNAL_ERROR", message: "服务暂时无法完成操作，请稍后重试。"});
});

test("handler 拒绝重复筛选、非法 JSON 和过长正文，不尝试保存", async () => {
  const f = handlerFixture();
  const duplicate = await f.handlers.listResources(new Request("https://field-guide.example.invalid/api/v1/resources?stack=react&stack=vue"));
  assert.equal(duplicate.status, 422);
  assert.equal((await duplicate.json()).error.code, "INVALID_RESOURCE_QUERY");
  const invalid = await f.handlers.createBookmark(new Request("https://field-guide.example.invalid/api/v1/me/resource-bookmarks", {method: "POST", headers: {"content-type": "application/json"}, body: "{bad json"}));
  assert.equal(invalid.status, 422);
  const oversized = await f.handlers.createBookmark(jsonRequest({resourceId: f.published.id, purposeNote: "界".repeat(6000)}));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "REQUEST_TOO_LARGE");
  assert.equal((await f.service.listBookmarks(owner)).items.length, 0);
});

function integrationFixture(review: OperationsResourceReview | null = null) {
  const database = new RecordingDatabase();
  const readReviews: string[] = [];
  let sequence = 0;
  const adapter = createOperationsResourcePublicationAdapter({clock: {now: () => new Date(NOW)}, ids: {next: () => `notification-${++sequence}`},
    async readReview(tx, id) { assert.equal(tx, database); readReviews.push(id); return review; }});
  return {database, adapter, readReviews};
}

function publicationInput(current = resource()) {
  return {actor: reviewer, resourceId: current.id, expectedRevision: current.revision, expectedContentHash: resourceContentHash(current),
    expectedPublishedVersion: null, reviewOperationId: "resource-review:review-1:publish", reviewedBy: reviewer.userId,
    reviewedAt: CHECKED, reason: "人工核验官方入口，费用和许可未知。", requestId: "request-1"};
}

function approvedReview(current: Resource): OperationsResourceReview {
  const input = publicationInput(current);
  return {id: "review-1", resourceId: current.id, resourceRevision: current.revision, contentHash: input.expectedContentHash,
    status: "approved", reviewedBy: input.reviewedBy, reviewedAt: input.reviewedAt, reason: input.reason,
    verification: {link: {status: "available", checkedUrl: current.officialUrl}, fees: {status: "unknown", sourceUrl: null}, license: {status: "unknown", sourceUrl: null}}};
}

test("M08 readForReview 使用行锁，快照包含当前修订、内容摘要和旧发布版本", async () => {
  const old = resource({publicationStatus: "published", version: 1, reviewId: "old-review"});
  const current = resource({publicationStatus: "draft", name: "新草稿", version: 2, revision: 5});
  const f = integrationFixture();
  f.database.enqueue([{working_document: current, public_document: old}]);
  const snapshot = await f.adapter.readForReview(f.database, current.id);
  assert.ok(snapshot);
  assert.equal(snapshot.resourceId, current.id);
  assert.equal(snapshot.revision, 5);
  assert.equal(snapshot.contentHash, resourceContentHash(current));
  assert.equal(snapshot.publishedVersion, 1);
  assert.equal(snapshot.publicationStatus, "needs_recheck");
  assert.deepEqual(snapshot.fees, {state: "unknown", sourceUrl: null});
  assert.deepEqual(snapshot.license, {state: "unknown", sourceUrl: null});
  assert.equal(snapshot.validationErrors.length, 1);
  assert.match(f.database.calls[0]!.statement, /FOR UPDATE$/);
  assertBound(f.database.calls[0]!);
  assert.notEqual(resourceContentHash({...current, name: "另一份内容"}), snapshot.contentHash);
  assert.equal(resourceContentHash({...current, revision: 6, updatedAt: CHECKED}), snapshot.contentHash, "Revision and timestamp do not alter the content fingerprint");
});

test("M08 readForReview 映射送审状态，缺失资源不构造审核快照", async () => {
  const f = integrationFixture();
  const pending = resource();
  f.database.enqueue([{working_document: pending, public_document: null}]).enqueue([]);
  const snapshot = await f.adapter.readForReview(f.database, pending.id);
  assert.equal(snapshot?.publicationStatus, "pending_review");
  assert.deepEqual(snapshot?.validationErrors, []);
  assert.equal(snapshot?.publishedVersion, null);
  assert.equal(await f.adapter.readForReview(f.database, "missing-resource"), null);
});

test("M08 发布和下架在 SQL 执行前拒绝普通用户", async () => {
  const f = integrationFixture();
  await rejectsCode(f.adapter.publishReviewed(f.database, {...publicationInput(), actor: owner}), "RESOURCE_REVIEW_FORBIDDEN", 403);
  await rejectsCode(f.adapter.withdraw(f.database, {actor: owner, resourceId: "resource-1", expectedRevision: 2, expectedPublishedVersion: 1,
    reviewOperationId: "withdraw-operation", reason: "入口风险", at: CHECKED, requestId: "request-2"}), "RESOURCE_REVIEW_FORBIDDEN", 403);
  assert.equal(f.database.calls.length, 0);
  assert.equal(f.readReviews.length, 0);
});

test("M08 发布拒绝不存在、未批准或不匹配当前内容的审核事实", async () => {
  const current = resource();
  const approved = approvedReview(current);
  const cases: (OperationsResourceReview | null)[] = [null, {...approved, status: "pending"}, {...approved, contentHash: "stale-hash"},
    {...approved, resourceRevision: current.revision - 1}, {...approved, reviewedBy: "different-reviewer"},
    {...approved, verification: {...approved.verification!, link: {status: "available", checkedUrl: "https://different.example.invalid/"}}},
    {...approved, verification: {...approved.verification!, fees: {status: "verified", sourceUrl: current.officialUrl}}},
    {...approved, verification: {...approved.verification!, license: {status: "verified", sourceUrl: current.officialUrl}}}];
  for (const review of cases) {
    const f = integrationFixture(review);
    f.database.enqueue([]).enqueue([]).enqueue([{working_document: current, public_document: null}]);
    await rejectsCode(f.adapter.publishReviewed(f.database, publicationInput(current)), "RESOURCE_REVIEW_REQUIRED", 409);
    assert.deepEqual(f.readReviews, ["review-1"]);
    assert.ok(f.database.calls.every(call => call.statement.startsWith("SELECT")), "Invalid review must produce no resource or notification writes");
  }
});

test("M08 发布拒绝过期修订、内容 hash 和公开版本，且不读取审核", async () => {
  const current = resource();
  for (const changes of [{expectedRevision: 1}, {expectedContentHash: "stale-content"}, {expectedPublishedVersion: 7}]) {
    const f = integrationFixture(approvedReview(current));
    f.database.enqueue([]).enqueue([]).enqueue([{working_document: current, public_document: null}]);
    await rejectsCode(f.adapter.publishReviewed(f.database, {...publicationInput(current), ...changes}), "VERSION_CONFLICT", 409);
    assert.equal(f.readReviews.length, 0);
    assert.ok(f.database.calls.every(call => call.statement.startsWith("SELECT")));
  }
});

test("M08 正常发布在调用方事务内更新快照、记录幂等结果和通知，同键不同内容返回 409", async () => {
  const current = resource();
  const input = publicationInput(current);
  const f = integrationFixture(approvedReview(current));
  f.database.enqueue([]).enqueue([]).enqueue([{working_document: current, public_document: null}])
    .enqueue([{working_document: current, public_document: null}]).enqueue([{id: current.id}], 1).enqueue([], 1).enqueue([], 1).enqueue([], 1);
  const published = await f.database.transaction(tx => f.adapter.publishReviewed(tx, input));
  assert.deepEqual(published, {resourceId: current.id, publishedVersion: current.version});
  assert.equal(f.database.transactions, 1, "The adapter must use M08's executor without opening a nested transaction");
  assert.ok(f.database.calls.every(call => call.inTransaction), "History, operation record and notification must share the caller's transaction");
  const updated = JSON.parse(f.database.calls[4]!.parameters[2] as string) as Resource;
  assert.equal(updated.publicationStatus, "published");
  assert.equal(updated.revision, current.revision + 1);
  assert.equal(updated.reviewId, "review-1");
  assert.deepEqual(JSON.parse(f.database.calls[4]!.parameters[3] as string), updated);
  const operation = f.database.calls[6]!;
  assert.match(operation.statement, /^INSERT INTO resource_publication_operations/);
  assert.equal(operation.parameters[0], input.reviewOperationId);
  const inputHash = operation.parameters[1] as string;
  assert.match(inputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(operation.parameters[2] as string), published);
  assert.deepEqual(f.database.calls[7]!.parameters, ["notification-1", "ResourcePublished", current.id, current.version, NOW]);
  for (const call of f.database.calls) assertBound(call, [input.reviewOperationId, input.reason]);

  f.database.enqueue([]).enqueue([{input_hash: inputHash, result: published}]);
  assert.deepEqual(await f.database.transaction(tx => f.adapter.publishReviewed(tx, {...input, requestId: "retried-request"})), published);
  assert.equal(f.database.calls.length, 10, "A replay must not republish or notify again");
  assert.equal(f.readReviews.length, 1);

  f.database.enqueue([]).enqueue([{input_hash: inputHash, result: published}]);
  await rejectsCode(f.database.transaction(tx => f.adapter.publishReviewed(tx, {...input, reason: "改变审核理由"})), "IDEMPOTENCY_KEY_REUSED", 409);
  assert.equal(f.database.calls.length, 12);
  assert.equal(f.readReviews.length, 1);
});

test("M08 已批准核验接受等价 HTTP(S) 来源写法，费用和许可仍匹配官方来源", async () => {
  const current = resource({costType: "free_and_paid", costSourceUrl: "https://resource.example.invalid/pricing", costVerifiedAt: "2026-10-08T10:00:00.000Z",
    licenseStatus: "source_verified", licenseSourceUrl: "https://resource.example.invalid/license", licenseVerifiedAt: "2026-10-08T10:00:00.000Z"});
  const review: OperationsResourceReview = {...approvedReview(current), verification: {
    link: {status: "available", checkedUrl: "HTTPS://RESOURCE.EXAMPLE.INVALID:443/docs"},
    fees: {status: "verified", sourceUrl: "HTTPS://RESOURCE.EXAMPLE.INVALID:443/./pricing"},
    license: {status: "verified", sourceUrl: "https://resource.example.invalid:443/license"},
  }};
  const f = integrationFixture(review);
  f.database.enqueue([]).enqueue([]).enqueue([{working_document: current, public_document: null}])
    .enqueue([{working_document: current, public_document: null}]).enqueue([{id: current.id}], 1).enqueue([], 1).enqueue([], 1).enqueue([], 1);
  const result = await f.database.transaction(tx => f.adapter.publishReviewed(tx, publicationInput(current)));
  assert.deepEqual(result, {resourceId: current.id, publishedVersion: current.version});
  assert.equal(f.database.transactions, 1);
  assert.equal(f.database.calls.length, 8);
  assert.ok(f.database.calls.every(call => call.inTransaction));
  assert.equal((JSON.parse(f.database.calls[4]!.parameters[3] as string) as Resource).publicationStatus, "published");
});

test("M05 事务资源查询按稳定 ID 顺序持锁，过滤下架和草稿后保留输入顺序", async () => {
  const f = handlerFixture();
  let normalReads = 0;
  f.repository.getPublic = async () => { normalReads += 1; throw new Error("Transaction lookup must not use the root repository"); };
  const first = resource({id: "resource-a", publicationStatus: "published", reviewId: "approved-a"});
  const withdrawn = resource({id: "resource-b", publicationStatus: "withdrawn", reviewId: "approved-b", externalLinkBlocked: true});
  const draft = resource({id: "resource-c", publicationStatus: "draft"});
  const last = resource({id: "resource-z", publicationStatus: "published", reviewId: "approved-z"});
  const database = new RecordingDatabase().enqueue([{working_document: first, public_document: first}])
    .enqueue([{working_document: withdrawn, public_document: withdrawn}]).enqueue([{working_document: draft, public_document: null}])
    .enqueue([{working_document: last, public_document: last}]);
  const ids = await database.transaction(tx => f.service.getDisplayableApprovedIds([last.id, draft.id, withdrawn.id, first.id, last.id], tx));
  assert.deepEqual(ids, [last.id, first.id], "Filtering keeps the first occurrence order instead of lock acquisition order");
  assert.deepEqual(database.calls.map(call => call.parameters), [[first.id], [withdrawn.id], [draft.id], [last.id]]);
  assert.equal(database.transactions, 1, "The resource port must share the plan transaction without nesting another one");
  assert.equal(normalReads, 0);
  for (const call of database.calls) {
    assert.equal(call.statement, "SELECT working_document, public_document FROM resource_records WHERE id = $1 FOR UPDATE");
    assert.ok(call.inTransaction);
    assertBound(call);
  }
});

test("M05 事务引用校验持锁读取公开版本，接受当前引用并拒绝旧版和未发布草稿版本", async () => {
  const f = handlerFixture();
  let normalReads = 0;
  f.repository.getPublic = async () => { normalReads += 1; throw new Error("Version validation must use the supplied transaction"); };
  const published = resource({publicationStatus: "published", reviewId: "approved-v3", version: 3, revision: 8});
  const working = resource({publicationStatus: "draft", version: 4, revision: 9});
  const row = {working_document: working, public_document: published};
  const database = new RecordingDatabase().enqueue([row]).enqueue([row]).enqueue([row]);
  const ref = {resourceId: published.id, version: published.version};
  assert.deepEqual(await database.transaction(tx => f.service.validateResourceRefs([ref, ref], tx)), [ref]);
  await rejectsCode(database.transaction(tx => f.service.validateResourceRefs([{resourceId: published.id, version: 2}], tx)), "RESOURCE_REFS_UNAVAILABLE", 409);
  await rejectsCode(database.transaction(tx => f.service.validateResourceRefs([{resourceId: working.id, version: working.version}], tx)), "RESOURCE_REFS_UNAVAILABLE", 409);
  assert.equal(normalReads, 0);
  assert.equal(database.transactions, 3);
  assert.equal(database.calls.length, 3, "Duplicate references should lock the resource only once per validation");
  for (const call of database.calls) {
    assert.equal(call.statement, "SELECT working_document, public_document FROM resource_records WHERE id = $1 FOR UPDATE");
    assert.deepEqual(call.parameters, [published.id]);
    assert.ok(call.inTransaction);
    assertBound(call);
  }
});
