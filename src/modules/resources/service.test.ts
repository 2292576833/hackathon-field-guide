import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { normalizeResourceQuery, verificationState } from "./domain.ts";
import type { Resource, ResourceInput } from "./domain.ts";
import type { ApprovedResourceReview, ProjectResourceShareInput, ResourceCorrectionPort } from "./ports.ts";
import { ResourceService } from "./service.ts";
import type { ResourceServiceDependencies } from "./service.ts";
import { MemoryResourceRepository } from "./testing/memory-repository.ts";

const reviewer: Actor = {userId: "reviewer-1", platformRoles: ["reviewer"]};
const alice: Actor = {userId: "alice", platformRoles: ["user"]};
const bob: Actor = {userId: "bob", platformRoles: ["user"]};
const NOW = "2026-10-08T12:00:00.000Z";
const VERIFIED = "2026-10-08T10:00:00.000Z";
const CHECKED = "2026-10-08T11:00:00.000Z";

function input(overrides: Partial<ResourceInput> = {}): ResourceInput {
  return {
    name: "Form starter", officialUrl: "https://resource.example.invalid/docs", type: "ui_visual",
    stageTags: ["development"], useTags: ["form"], stackTags: ["react"], prerequisites: ["basic_code"],
    summary: "帮助新人实现表单界面", suitableFor: "需要表单组件的队伍", notSuitableFor: "仍需独立检查赛事规则和可访问性",
    quickStart: ["查看官方文档", "先试一个最小组件"], costType: "unknown", costNote: "费用尚未核验",
    costSourceUrl: null, costVerifiedAt: null, licenseStatus: "unknown", licenseNote: "许可尚未核验",
    licenseSourceUrl: null, licenseVerifiedAt: null, verifiedAt: VERIFIED, linkStatus: "available", displayOrder: 1,
    ...overrides,
  };
}

function fixture(options: Partial<Omit<ResourceServiceDependencies, "repository" | "reviews" | "clock" | "ids">> = {}) {
  const repository = new MemoryResourceRepository();
  const reviews = new Map<string, ApprovedResourceReview>();
  let sequence = 0;
  let now = new Date(NOW);
  const service = new ResourceService({repository, reviews: {async getApprovedReview(id) { return reviews.get(id) ?? null; }},
    clock: {now: () => new Date(now)}, ids: {next: () => `generated-${String(++sequence).padStart(4, "0")}`}, ...options});
  function approve(resource: Resource, overrides: Partial<ApprovedResourceReview> = {}) {
    const review: ApprovedResourceReview = {id: `review-${resource.id}-v${resource.version}`, resourceId: resource.id,
      resourceVersion: resource.version, reviewerId: reviewer.userId, result: "approved", checkedAt: CHECKED,
      sourceLinks: [resource.officialUrl, ...resource.costSourceUrl ? [resource.costSourceUrl] : [], ...resource.licenseSourceUrl ? [resource.licenseSourceUrl] : []], ...overrides};
    reviews.set(review.id, review);
    return review;
  }
  async function published(overrides: Partial<ResourceInput> = {}) {
    const draft = await service.createDraft(reviewer, input(overrides));
    const pending = await service.requestReview(reviewer, draft.id, draft.revision);
    const review = approve(pending);
    return service.publish(reviewer, pending.id, pending.revision, review.id);
  }
  return {service, repository, reviews, approve, published, setNow(value: string) { now = new Date(value); }};
}

async function rejectsCode(action: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test("访客可公开阅读，草稿不可见；收藏的所有入口要求登录", async () => {
  const f = fixture();
  const resource = await f.published();
  const draft = await f.service.createDraft(reviewer, input({name: "私人草稿"}));
  assert.deepEqual((await f.service.list()).items.map(value => value.id), [resource.id]);
  assert.equal((await f.service.detail(resource.id)).name, resource.name);
  await rejectsCode(f.service.detail(draft.id), "RESOURCE_NOT_FOUND", 404);
  await rejectsCode(f.service.bookmark(alice, draft.id), "RESOURCE_NOT_BOOKMARKABLE", 409);
  for (const action of [f.service.listBookmarks(null), f.service.bookmark(null, resource.id), f.service.updateBookmark(null, "bookmark", 1, "用途"), f.service.removeBookmark(null, "bookmark"), f.service.shareBookmark(null, "bookmark", "project")]) {
    await rejectsCode(action, "AUTHENTICATION_REQUIRED", 401);
  }
});

test("资源编辑、送审、发布、撤下均只接受审核人员或管理员", async () => {
  const f = fixture();
  const resource = await f.published();
  for (const action of [f.service.createDraft(alice, input()), f.service.updateDraft(alice, resource.id, resource.revision, input()),
    f.service.requestReview(alice, resource.id, resource.revision), f.service.publish(alice, resource.id, resource.revision, "review"),
    f.service.withdraw(alice, resource.id, resource.revision, "原因", false)]) await rejectsCode(action, "RESOURCE_REVIEW_FORBIDDEN", 403);
  const admin: Actor = {userId: "admin", platformRoles: ["admin"]};
  assert.equal((await f.service.createDraft(admin, input())).publicationStatus, "draft");
  assert.equal((await f.service.detail(resource.id)).revision, resource.revision);
});

test("受控标签、HTTP(S) 链接和已发生时间在写入前校验", async () => {
  const f = fixture();
  await rejectsCode(f.service.createDraft(reviewer, input({useTags: ["uncontrolled"] as unknown as ResourceInput["useTags"]})), "INVALID_RESOURCE_TAG");
  for (const officialUrl of ["javascript:alert(1)", "file:///tmp/data", "https://user:secret@example.invalid/"]) {
    await rejectsCode(f.service.createDraft(reviewer, input({officialUrl})), "INVALID_RESOURCE_URL");
  }
  for (const verifiedAt of ["2026-10-08T10:00:00", "2026-10-09T10:00:00Z"]) {
    await rejectsCode(f.service.createDraft(reviewer, input({verifiedAt})), "INVALID_RESOURCE_TIME");
  }
  await rejectsCode(f.service.createDraft(reviewer, input({verifiedAt: null})), "RESOURCE_LINK_EVIDENCE_REQUIRED");
  assert.equal((await f.service.list()).items.length, 0);
});

test("确认费用或许可必须有来源和核验时间，未知不冒充免费或可商用", async () => {
  const f = fixture();
  await rejectsCode(f.service.createDraft(reviewer, input({costType: "free_plan"})), "RESOURCE_COST_EVIDENCE_REQUIRED");
  await rejectsCode(f.service.createDraft(reviewer, input({costType: "free_plan", costSourceUrl: "https://resource.example.invalid/pricing"})), "RESOURCE_COST_EVIDENCE_REQUIRED");
  await rejectsCode(f.service.createDraft(reviewer, input({licenseStatus: "source_verified"})), "RESOURCE_LICENSE_EVIDENCE_REQUIRED");
  const unknown = await f.published();
  const free = await f.published({name: "Free tier", costType: "free_plan", costNote: "仅确认有免费方案", costSourceUrl: "https://resource.example.invalid/pricing", costVerifiedAt: VERIFIED});
  assert.deepEqual((await f.service.list({costType: "free_plan"})).items.map(value => value.id), [free.id]);
  assert.deepEqual((await f.service.list({costType: "unknown"})).items.map(value => value.id), [unknown.id]);
  assert.equal((await f.service.detail(unknown.id)).licenseStatus, "unknown");
});

test("搜索名称、简介与受控标签；多项筛选共同生效，百分号下划线为普通文本", async () => {
  const f = fixture();
  const target = await f.published({name: "100%_Form", summary: "Plain summary", prerequisites: ["account"]});
  await f.published({name: "100XForm", type: "inspiration", stackTags: ["stack_agnostic"], stageTags: ["design"], useTags: ["layout"]});
  assert.deepEqual((await f.service.list({search: "%_"})).items.map(value => value.id), [target.id]);
  assert.deepEqual((await f.service.list({search: "REACT", type: "ui_visual", stage: "development", stack: "react", use: "form", prerequisite: "account", costType: "unknown"})).items.map(value => value.id), [target.id]);
  assert.equal((await f.service.list({search: "plain"})).items[0]?.id, target.id);
  assert.equal((await f.service.list({search: "不存在"})).items.length, 0);
  assert.equal((await f.service.list({stack: "vue"})).items.length, 0);
});

test("列表和收藏通过多取一条分页，排序平局按 ID 稳定，查询参数受控", async () => {
  const f = fixture();
  const z = await f.published({name: "Zulu", displayOrder: 2, verifiedAt: "2026-10-07T10:00:00Z"});
  const a = await f.published({name: "Alpha", displayOrder: 1});
  const b = await f.published({name: "Beta", displayOrder: 1});
  const first = await f.service.list({limit: 1});
  assert.deepEqual(first.items.map(value => value.id), [a.id]);
  assert.equal(first.nextCursor, "1");
  const second = await f.service.list({limit: 2, cursor: first.nextCursor!});
  assert.deepEqual(second.items.map(value => value.id), [b.id, z.id]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await f.service.list({sort: "name"})).items.map(value => value.id), [a.id, b.id, z.id]);
  assert.deepEqual((await f.service.list({sort: "verified"})).items.map(value => value.id), [a.id, b.id, z.id]);
  for (const resource of [z, a, b]) await f.service.bookmark(alice, resource.id);
  const bookmarks = await f.service.listBookmarks(alice, {limit: 2});
  assert.equal(bookmarks.items.length, 2);
  assert.equal(bookmarks.nextCursor, "2");
  assert.equal((await f.service.listBookmarks(alice, {limit: 2, cursor: "2"})).nextCursor, null);
  for (const query of [{limit: 0}, {limit: 51}, {cursor: "-1"}, {cursor: "1000001"}, {cursor: "1x"}]) await rejectsCode(f.service.list(query), "INVALID_RESOURCE_QUERY");
});

test("编辑和送审新版本仍展示旧公开版，新审核通过才替换", async () => {
  const f = fixture();
  const old = await f.published();
  const draft = await f.service.updateDraft(reviewer, old.id, old.revision, input({name: "新名字"}));
  assert.equal(draft.version, old.version + 1);
  assert.equal((await f.service.detail(old.id)).name, old.name);
  assert.equal((await f.service.list({search: "新名字"})).items.length, 0);
  const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
  assert.equal((await f.service.detail(old.id)).version, old.version);
  const review = f.approve(pending);
  const latest = await f.service.publish(reviewer, pending.id, pending.revision, review.id);
  assert.equal((await f.service.detail(old.id)).name, latest.name);
  assert.equal((await f.service.list({search: "新名字"})).items.length, 1);
});

test("发布只接受送审中的当前内容版本及服务端批准事实", async () => {
  const f = fixture();
  const draft = await f.service.createDraft(reviewer, input());
  const premature = f.approve(draft);
  await rejectsCode(f.service.publish(reviewer, draft.id, draft.revision, premature.id), "RESOURCE_NOT_IN_REVIEW", 409);
  const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
  await rejectsCode(f.service.publish(reviewer, pending.id, pending.revision, "made-up"), "RESOURCE_REVIEW_REQUIRED", 409);
  for (const overrides of [{resourceVersion: pending.version + 1}, {resourceId: "another"}, {reviewerId: ""}, {id: "wrong-returned-id"}]) {
    const review = f.approve(pending, overrides);
    if (overrides.id) f.reviews.set(premature.id, review);
    await rejectsCode(f.service.publish(reviewer, pending.id, pending.revision, overrides.id ? premature.id : review.id), "RESOURCE_REVIEW_REQUIRED", 409);
  }
  assert.equal((await f.repository.getRecord(draft.id))?.resource.revision, pending.revision);
  await rejectsCode(f.service.detail(draft.id), "RESOURCE_NOT_FOUND", 404);
});

test("审核覆盖官方入口、费用及许可来源，核验事实不得晚于审核", async () => {
  const f = fixture();
  const draft = await f.service.createDraft(reviewer, input({costType: "free_and_paid", costSourceUrl: "https://resource.example.invalid/pricing", costVerifiedAt: VERIFIED,
    licenseStatus: "source_verified", licenseSourceUrl: "https://resource.example.invalid/license", licenseVerifiedAt: VERIFIED}));
  const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
  for (const sourceLinks of [[], [pending.officialUrl], [pending.officialUrl, pending.costSourceUrl!]]) {
    const review = f.approve(pending, {sourceLinks});
    await rejectsCode(f.service.publish(reviewer, pending.id, pending.revision, review.id), "RESOURCE_REVIEW_EVIDENCE_INVALID", 409);
  }
  const early = f.approve(pending, {checkedAt: "2026-10-08T09:00:00Z"});
  await rejectsCode(f.service.publish(reviewer, pending.id, pending.revision, early.id), "RESOURCE_REVIEW_EVIDENCE_INVALID", 409);
  const review = f.approve(pending);
  assert.equal((await f.service.publish(reviewer, pending.id, pending.revision, review.id)).publicationStatus, "published");
});

test("未核验或不可访问的入口即使有审核 ID 也不能发布", async () => {
  for (const override of [{verifiedAt: null, linkStatus: "unknown" as const}, {linkStatus: "unreachable" as const}]) {
    const f = fixture();
    const draft = await f.service.createDraft(reviewer, input(override));
    const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
    const review = f.approve(pending);
    await rejectsCode(f.service.publish(reviewer, pending.id, pending.revision, review.id), "RESOURCE_REVIEW_EVIDENCE_INVALID", 409);
  }
});

test("并发编辑只允许一个预期修订获胜，冲突带最新修订且不覆盖公开内容", async () => {
  const f = fixture();
  const resource = await f.published();
  const results = await Promise.allSettled([f.service.updateDraft(reviewer, resource.id, resource.revision, input({name: "第一份"})),
    f.service.updateDraft(reviewer, resource.id, resource.revision, input({name: "第二份"}))]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const failure = results.find(value => value.status === "rejected");
  assert.ok(failure?.status === "rejected" && failure.reason instanceof DomainError);
  assert.equal(failure.reason.code, "VERSION_CONFLICT");
  assert.equal(failure.reason.latestRevision, resource.revision + 1);
  assert.equal((await f.repository.getRecord(resource.id))?.resource.name, "第一份");
  assert.equal((await f.service.detail(resource.id)).name, resource.name);
});

test("同时重复收藏仅保留一个 ID、首次备注与首次修订；不会隐式分享", async () => {
  const shared: ProjectResourceShareInput[] = [];
  const f = fixture({projectSharing: {async addReviewedResource(_actor, value) { shared.push(value); return {id: "shared", projectId: value.projectId}; }}});
  const resource = await f.published();
  const values = await Promise.all(Array.from({length: 12}, (_, index) => f.service.bookmark(alice, resource.id, `备注 ${index}`)));
  assert.equal(new Set(values.map(value => value.id)).size, 1);
  assert.ok(values.every(value => value.purposeNote === "备注 0" && value.revision === 1));
  assert.equal((await f.service.listBookmarks(alice)).items.length, 1);
  assert.equal(shared.length, 0);
  const other = await f.service.bookmark(bob, resource.id, "Bob 的独立用途");
  assert.notEqual(other.id, values[0]?.id);
});

test("其他用户不能列出、读取、修改、删除或共享本人收藏", async () => {
  const f = fixture({projectAccess: {async getMembership() { return null; }}, projectSharing: {async addReviewedResource() { throw new Error("Should not share"); }}});
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "私人用途");
  assert.equal((await f.service.listBookmarks(bob)).items.length, 0);
  assert.equal(await f.repository.getBookmark(bookmark.id, bob.userId), null);
  await rejectsCode(f.service.updateBookmark(bob, bookmark.id, bookmark.revision, "越权"), "BOOKMARK_NOT_FOUND", 404);
  await rejectsCode(f.service.shareBookmark(bob, bookmark.id, "project-1"), "BOOKMARK_NOT_FOUND", 404);
  await f.service.removeBookmark(bob, bookmark.id);
  assert.deepEqual(await f.repository.getBookmark(bookmark.id, alice.userId), bookmark);
  await f.service.removeBookmark(alice, bookmark.id);
  await f.service.removeBookmark(alice, bookmark.id);
  assert.equal((await f.service.listBookmarks(alice)).items.length, 0);
});

test("本人备注采用乐观锁，并发修改不丢失已保存版本", async () => {
  const f = fixture();
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "原备注");
  const values = await Promise.allSettled([f.service.updateBookmark(alice, bookmark.id, bookmark.revision, "已保存用途"), f.service.updateBookmark(alice, bookmark.id, bookmark.revision, "旧页面用途")]);
  assert.equal(values.filter(value => value.status === "fulfilled").length, 1);
  const failure = values.find(value => value.status === "rejected");
  assert.ok(failure?.status === "rejected" && failure.reason instanceof DomainError);
  assert.equal(failure.reason.code, "VERSION_CONFLICT");
  assert.equal(failure.reason.latestRevision, 2);
  const current = await f.repository.getBookmark(bookmark.id, alice.userId);
  assert.equal(current?.purposeNote, "已保存用途");
  assert.equal(current?.revision, 2);
  assert.equal((await f.service.bookmark(alice, resource.id, "重复请求不能改备注")).purposeNote, "已保存用途");
});

test("撤下从列表及推荐移除，详情与私人收藏保留原因和禁用外链状态", async () => {
  const f = fixture();
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "继续保留参考记录");
  await f.service.withdraw(reviewer, resource.id, resource.revision, "入口存在风险", true);
  assert.equal((await f.service.list()).items.length, 0);
  assert.equal((await f.service.getReviewedResources([resource.id])).length, 0);
  await rejectsCode(f.service.validateResourceRefs([{resourceId: resource.id, version: resource.version}]), "RESOURCE_REFS_UNAVAILABLE", 409);
  const detail = await f.service.detail(resource.id);
  assert.equal(detail.publicationStatus, "withdrawn");
  assert.equal(detail.withdrawnReason, "入口存在风险");
  assert.equal(detail.externalLinkBlocked, true);
  const saved = await f.service.listBookmarks(alice);
  assert.equal(saved.items[0]?.bookmark.id, bookmark.id);
  assert.equal(saved.items[0]?.resource.publicationStatus, "withdrawn");
  await rejectsCode(f.service.bookmark(bob, resource.id), "RESOURCE_NOT_BOOKMARKABLE", 409);
  assert.equal((await f.service.updateBookmark(alice, bookmark.id, 1, "记下风险")).purposeNote, "记下风险");
});

test("撤下带待审稿的公开版保留草稿内容，并使待审版本审核失效", async () => {
  const f = fixture();
  const publicVersion = await f.published();
  const draft = await f.service.updateDraft(reviewer, publicVersion.id, publicVersion.revision, input({name: "待审的新内容"}));
  const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
  const oldReview = f.approve(pending);
  await f.service.withdraw(reviewer, pending.id, pending.revision, "重新核验入口", false);
  const working = (await f.repository.getRecord(pending.id))?.resource;
  assert.ok(working);
  assert.equal(working.name, "待审的新内容");
  assert.equal(working.publicationStatus, "draft");
  assert.equal(working.version, pending.version + 1);
  assert.equal((await f.service.detail(pending.id)).version, publicVersion.version);
  const nextPending = await f.service.requestReview(reviewer, working.id, working.revision);
  await rejectsCode(f.service.publish(reviewer, nextPending.id, nextPending.revision, oldReview.id), "RESOURCE_REVIEW_REQUIRED", 409);
  const newReview = f.approve(nextPending);
  assert.equal((await f.service.publish(reviewer, nextPending.id, nextPending.revision, newReview.id)).name, working.name);
});

test("资源引用只允许当前公开审核版本，草稿不使旧引用失效，更新发布使旧引用需刷新", async () => {
  const f = fixture();
  const old = await f.published();
  const hidden = await f.service.createDraft(reviewer, input());
  assert.deepEqual((await f.service.getReviewedResources([old.id, old.id, hidden.id, "missing"])).map(value => value.id), [old.id]);
  const ref = {resourceId: old.id, version: old.version};
  assert.deepEqual(await f.service.validateResourceRefs([ref, ref]), [ref]);
  await rejectsCode(f.service.validateResourceRefs([{resourceId: hidden.id, version: 1}]), "RESOURCE_REFS_UNAVAILABLE", 409);
  const draft = await f.service.updateDraft(reviewer, old.id, old.revision, input({name: "更新"}));
  assert.deepEqual(await f.service.validateResourceRefs([ref]), [ref]);
  const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
  const review = f.approve(pending);
  const latest = await f.service.publish(reviewer, pending.id, pending.revision, review.id);
  await rejectsCode(f.service.validateResourceRefs([ref]), "RESOURCE_REFS_UNAVAILABLE", 409);
  assert.deepEqual(await f.service.validateResourceRefs([{resourceId: latest.id, version: latest.version}]), [{resourceId: latest.id, version: latest.version}]);
  await rejectsCode(f.service.validateResourceRefs([{resourceId: latest.id, version: 0}]), "INVALID_RESOURCE_REFS");
  await rejectsCode(f.service.getReviewedResources(Array(51).fill(old.id)), "INVALID_RESOURCE_REFS");
});

test("分享必须显式项目，未接入时拒绝并保留私人备注", async () => {
  const f = fixture();
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "私人备注");
  await rejectsCode(f.service.shareBookmark(alice, bookmark.id, ""), "INVALID_RESOURCE_INPUT");
  await rejectsCode(f.service.shareBookmark(alice, bookmark.id, "project-1"), "PROJECT_RESOURCE_SHARING_UNAVAILABLE", 503);
  assert.deepEqual(await f.repository.getBookmark(bookmark.id, alice.userId), bookmark);
});

test("分享检查当前活跃且匹配项目与账号的成员资格，普通成员也可共享选中资料", async () => {
  let membership: ProjectMembershipAccess | null = null;
  const shared: {actor: Actor; input: ProjectResourceShareInput}[] = [];
  const f = fixture({projectAccess: {async getMembership() { return membership; }}, projectSharing: {async addReviewedResource(actor, value) { shared.push({actor, input: value}); return {id: "shared-1", projectId: value.projectId}; }}});
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "参考表单错误提示");
  const active: ProjectMembershipAccess = {membershipId: "membership", projectId: "project-1", userId: alice.userId, role: "member", status: "active"};
  for (const value of [null, {...active, status: "left" as const}, {...active, status: "removed" as const}, {...active, userId: bob.userId}, {...active, projectId: "another-project"}]) {
    membership = value;
    await rejectsCode(f.service.shareBookmark(alice, bookmark.id, "project-1"), "PROJECT_ACCESS_FORBIDDEN", 403);
  }
  assert.equal(shared.length, 0);
  membership = active;
  assert.deepEqual(await f.service.shareBookmark(alice, bookmark.id, "project-1"), {id: "shared-1", projectId: "project-1"});
  assert.deepEqual(shared[0], {actor: alice, input: {projectId: "project-1", resourceId: resource.id, resourceVersion: resource.version, title: resource.name, url: resource.officialUrl, purposeNote: bookmark.purposeNote}});
  await f.service.withdraw(reviewer, resource.id, resource.revision, "暂停推荐", false);
  await rejectsCode(f.service.shareBookmark(alice, bookmark.id, "project-1"), "RESOURCE_NOT_SHAREABLE", 409);
  assert.equal(shared.length, 1);
  assert.equal((await f.service.listBookmarks(alice)).items[0]?.bookmark.id, bookmark.id);
});

test("M02 写入期间权限再次失效或写入失败不能报分享成功，私人收藏不变", async () => {
  let attempted = 0;
  const f = fixture({projectAccess: {async getMembership(projectId, userId) { return {membershipId: "m", projectId, userId, role: "member", status: "active"}; }},
    projectSharing: {async addReviewedResource() { attempted++; throw new DomainError("PROJECT_ACCESS_FORBIDDEN", "成员资格已变更", {status: 403}); }}});
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "保留备注");
  await rejectsCode(f.service.shareBookmark(alice, bookmark.id, "project-1"), "PROJECT_ACCESS_FORBIDDEN", 403);
  assert.equal(attempted, 1);
  assert.deepEqual(await f.repository.getBookmark(bookmark.id, alice.userId), bookmark);
});

test("纠错服务未接入时不会制造成功，接入后仅转交已校验文本", async () => {
  const f = fixture();
  const resource = await f.published();
  await rejectsCode(f.service.reportCorrection(null, {resourceId: resource.id, kind: "cost", note: "套餐可能变化"}), "RESOURCE_CORRECTIONS_UNAVAILABLE", 503);
  const calls: unknown[] = [];
  const corrections: ResourceCorrectionPort = {async submit(actor, value) { calls.push({actor, value}); return {id: "correction-1"}; }};
  const connected = fixture({corrections});
  const published = await connected.published();
  assert.deepEqual(await connected.service.reportCorrection(null, {resourceId: published.id, kind: "broken_link", note: "  无法访问入口  "}), {id: "correction-1"});
  assert.deepEqual(calls, [{actor: null, value: {resourceId: published.id, kind: "broken_link", note: "无法访问入口"}}]);
});

test("核验状态按时间派生，未知和过期不会被表示为当前事实", () => {
  const source = {...input(), verifiedAt: null} as Resource;
  assert.equal(verificationState(source, new Date(NOW)), "unknown");
  assert.equal(verificationState({...source, verifiedAt: VERIFIED}, new Date(NOW)), "current");
  assert.equal(verificationState({...source, verifiedAt: "2026-01-01T00:00:00Z"}, new Date(NOW)), "stale");
});

test("事务夹具隔离未提交写入、失败回滚，下一事务串行读取已提交状态", async () => {
  const f = fixture();
  const original = await f.service.createDraft(reviewer, input());
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const order: string[] = [];
  const first = f.repository.transaction(async unit => {
    order.push("first");
    const record = await unit.getRecord(original.id);
    assert.ok(record);
    await unit.saveRecord({...record, resource: {...record.resource, name: "未提交", revision: original.revision + 1}}, original.revision);
    entered();
    await paused;
    throw new Error("rollback-marker");
  });
  // Register the rejection handler before deliberately releasing the failure.
  const failure = assert.rejects(first, /rollback-marker/);
  await started;
  const second = f.repository.transaction(async unit => {
    order.push("second");
    const record = await unit.getRecord(original.id);
    assert.equal(record?.resource.name, original.name);
    assert.ok(record);
    await unit.saveRecord({...record, resource: {...record.resource, name: "提交成功", revision: original.revision + 1}}, original.revision);
  });
  assert.deepEqual(order, ["first"]);
  assert.equal((await f.repository.getRecord(original.id))?.resource.name, original.name);
  resume();
  await Promise.all([failure, second]);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal((await f.repository.getRecord(original.id))?.resource.name, "提交成功");
});

test("仓库读写是独立快照，读取结果不能绕过服务直接改变已保存状态", async () => {
  const f = fixture();
  const resource = await f.published();
  const value = await f.repository.getRecord(resource.id);
  assert.ok(value?.publicResource);
  value.resource.name = "篡改工作稿";
  value.publicResource.name = "篡改公开稿";
  const list = await f.repository.listPublished(normalizeResourceQuery());
  assert.ok(list[0]);
  list[0].name = "篡改列表";
  assert.equal((await f.service.detail(resource.id)).name, resource.name);
});

test("收藏与撤下并发：先收藏可保留，先撤下不得新增", async () => {
  for (const withdrawFirst of [false, true]) {
    const f = fixture();
    const resource = await f.published();
    const actions = withdrawFirst
      ? [f.service.withdraw(reviewer, resource.id, resource.revision, "撤下", false), f.service.bookmark(alice, resource.id, "用途")]
      : [f.service.bookmark(alice, resource.id, "用途"), f.service.withdraw(reviewer, resource.id, resource.revision, "撤下", false)];
    const results = await Promise.allSettled(actions);
    assert.equal(results[withdrawFirst ? 0 : 1]?.status, "fulfilled");
    assert.equal(results[withdrawFirst ? 1 : 0]?.status, withdrawFirst ? "rejected" : "fulfilled");
    assert.equal((await f.service.listBookmarks(alice)).items.length, withdrawFirst ? 0 : 1);
    assert.equal((await f.service.detail(resource.id)).publicationStatus, "withdrawn");
  }
});

test("UI 同形共享请求的额外标题和链接由服务端当前公开审核快照覆盖", async () => {
  const shared: ProjectResourceShareInput[] = [];
  const f = fixture({projectAccess: {async getMembership(projectId, userId) { return {membershipId: "m", projectId, userId, role: "member", status: "active"}; }},
    projectSharing: {async addReviewedResource(_actor, value) { shared.push(value); return {id: "shared-1", projectId: value.projectId}; }}});
  const resource = await f.published({name: "已审核表单组件", officialUrl: "https://resource.example.invalid/approved"});
  await f.service.updateDraft(reviewer, resource.id, resource.revision, input({name: "尚未审核新标题", officialUrl: "https://resource.example.invalid/unreviewed"}));
  // A UI payload may carry display fields; they cannot authorize shared content.
  const request = {projectId: "project-1", resourceId: resource.id, resourceVersion: resource.version, purposeNote: "  参考错误提示  ",
    title: "客户端伪造标题", url: "javascript:alert(1)"};
  assert.deepEqual(await f.service.shareResource(alice, request), {id: "shared-1", projectId: "project-1"});
  assert.deepEqual(shared, [{projectId: "project-1", resourceId: resource.id, resourceVersion: resource.version,
    title: resource.name, url: resource.officialUrl, purposeNote: "参考错误提示"}]);
  assert.equal((await f.service.listBookmarks(alice)).items.length, 0);
});

test("共享过期内容版本返回 409，并且不调用 M02 写入", async () => {
  const shared: ProjectResourceShareInput[] = [];
  const f = fixture({projectAccess: {async getMembership(projectId, userId) { return {membershipId: "m", projectId, userId, role: "member", status: "active"}; }},
    projectSharing: {async addReviewedResource(_actor, value) { shared.push(value); return {id: "shared-1", projectId: value.projectId}; }}});
  const old = await f.published();
  const draft = await f.service.updateDraft(reviewer, old.id, old.revision, input({name: "已审核新版本"}));
  const pending = await f.service.requestReview(reviewer, draft.id, draft.revision);
  const review = f.approve(pending);
  const latest = await f.service.publish(reviewer, pending.id, pending.revision, review.id);
  await rejectsCode(f.service.shareResource(alice, {projectId: "project-1", resourceId: old.id, resourceVersion: old.version, purposeNote: "旧页面的选择"}), "RESOURCE_REFS_UNAVAILABLE", 409);
  assert.equal(shared.length, 0);
  assert.equal((await f.service.detail(old.id)).version, latest.version);
});

test("本次共享备注可以覆盖或清空，私人收藏的备注和修订保持原值", async () => {
  const shared: ProjectResourceShareInput[] = [];
  const f = fixture({projectAccess: {async getMembership(projectId, userId) { return {membershipId: "m", projectId, userId, role: "member", status: "active"}; }},
    projectSharing: {async addReviewedResource(_actor, value) { shared.push(value); return {id: `shared-${shared.length}`, projectId: value.projectId}; }}});
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "私人研究备注");
  await f.service.shareBookmark(alice, bookmark.id, "project-1", "  仅给项目的用途说明  ");
  await f.service.shareBookmark(alice, bookmark.id, "project-1", "");
  await f.service.shareBookmark(alice, bookmark.id, "project-1");
  assert.deepEqual(shared.map(value => value.purposeNote), ["仅给项目的用途说明", "", bookmark.purposeNote]);
  assert.deepEqual(await f.repository.getBookmark(bookmark.id, alice.userId), bookmark);
  assert.deepEqual((await f.service.listBookmarks(alice)).items[0]?.bookmark, bookmark);
});

test("M02 返回不匹配项目的结果时不报告共享成功，个人收藏保留", async () => {
  const f = fixture({
    projectAccess: {async getMembership(projectId, userId) { return {membershipId: "m", projectId, userId, role: "member", status: "active"}; }},
    projectSharing: {async addReviewedResource() { return {id: "wrong-share", projectId: "other-project"}; }},
  });
  const resource = await f.published();
  const bookmark = await f.service.bookmark(alice, resource.id, "私人备注");
  await rejectsCode(f.service.shareBookmark(alice, bookmark.id, "project-1"), "PROJECT_RESOURCE_SHARING_RESULT_UNKNOWN", 503);
  assert.deepEqual(await f.repository.getBookmark(bookmark.id, alice.userId), bookmark);
});
