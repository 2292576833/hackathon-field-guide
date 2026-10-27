import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createResourceCatalogCli, resourceCatalogEntryHash } from "./catalog-cli.ts";
import type { CatalogImportScope, CatalogReviewRecord, CatalogReviewVerification, ResourceCatalogCheckpoint, ResourceCatalogCliDependencies, ResourceCatalogEntry } from "./catalog-types.ts";
import type { ResourceInput, ResourceRecord } from "./domain.ts";
import { ResourceService } from "./service.ts";
import { MemoryResourceRepository } from "./testing/memory-repository.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const EARLIER = "2026-10-08T10:00:00.000Z";
const actor: Actor = {userId: "trusted-reviewer", platformRoles: ["reviewer"]};
const user: Actor = {userId: "ordinary-user", platformRoles: ["user"]};

function entry(candidateKey = "form-starter", overrides: Partial<ResourceInput> = {}): ResourceCatalogEntry {
  return {candidateKey, catalogVersion: "2026-10-08-v1", verificationDate: "2026-10-08", reviewStatus: "candidate",
    input: {name: "Form starter", officialUrl: "https://resource.example.invalid/docs", type: "ui_visual", stageTags: ["development"], useTags: ["form"],
      stackTags: ["react"], prerequisites: ["basic_code"], summary: "帮助新人制作表单", suitableFor: "需要表单界面的队伍", notSuitableFor: "仍需自行核对赛事规则",
      quickStart: ["查看官方文档"], costType: "unknown", costNote: "费用尚未核验", costSourceUrl: null, costVerifiedAt: null,
      licenseStatus: "unknown", licenseNote: "许可尚未核验", licenseSourceUrl: null, licenseVerifiedAt: null,
      verifiedAt: EARLIER, linkStatus: "available", displayOrder: 1, ...overrides},
    evidence: [{field: "purpose", url: "https://resource.example.invalid/docs", checkedAt: EARLIER, note: "仅查阅官方文档的功能说明"}],
    remainingChecks: ["按实际赛事规则核对使用限制"]};
}
const reviewArgs = ["--import", "--review", "--review-reason", "本人核验官方入口，费用和许可未知并明示", "--confirm-links", "--ack-unknown"];

interface FullReview extends CatalogReviewRecord {
  resourceVersion: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  verification: CatalogReviewVerification | null;
  reason: string | null;
}
interface State {
  resources: Map<string, ResourceRecord>;
  checkpoints: Map<string, ResourceCatalogCheckpoint>;
  reviews: Map<string, FullReview>;
}

/** Transaction cloning + M08 structural test port. No PostgreSQL or external link request runs here. */
function fixture(entries: readonly ResourceCatalogEntry[] = [entry()]) {
  let state: State = {resources: new Map(), checkpoints: new Map(), reviews: new Map()};
  let identity: Actor = actor;
  let now = NOW;
  let entitySequence = 0;
  let requestSequence = 0;
  let actorLoads = 0;
  let scopes = 0;
  let tail = Promise.resolve();
  const calls: string[] = [];
  const fail = {decide: false, publish: false, checkpoint: false};
  function requireReviewer(value: Actor) {
    if (!value?.userId || !value.platformRoles.some(role => role === "reviewer" || role === "admin")) throw new DomainError("OPERATIONS_FORBIDDEN", "需要审核权限。", {status: 403});
  }
  const dependencies: ResourceCatalogCliDependencies = {entries, loadTrustedActor: async () => { actorLoads += 1; return identity; },
    clock: {now: () => new Date(now)}, requestIds: {next: () => `request-${++requestSequence}`},
    async runEach<T>(work: (scope: CatalogImportScope) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      scopes += 1;
      const pending = structuredClone(state);
      const repository = new MemoryResourceRepository([...pending.resources.values()]);
      const ids = new Set(pending.resources.keys());
      const service = new ResourceService({repository, clock: {now: () => new Date(now)}, ids: {next: () => `resource-${++entitySequence}`},
        reviews: {async getApprovedReview(reviewId) {
          const review = pending.reviews.get(reviewId);
          return review?.status === "approved" ? {id: review.id, resourceId: review.resourceId, resourceVersion: review.resourceVersion, reviewerId: review.reviewedBy!,
            checkedAt: review.reviewedAt!, result: "approved", sourceLinks: [review.verification!.link.checkedUrl, review.verification!.fees.sourceUrl, review.verification!.license.sourceUrl].filter((url): url is string => url !== null)} : null;
        }}});
      const scope: CatalogImportScope = {
        resources: {
          async createDraft(value, input) { calls.push("resources.createDraft"); const draft = await service.createDraft(value, input); ids.add(draft.id); return draft; },
          async getDraft(value, id) { calls.push("resources.getDraft"); return service.getDraft(value, id); },
          async updateDraft(value, id, revision, input) { calls.push("resources.updateDraft"); return service.updateDraft(value, id, revision, input); },
          async requestReview(value, id, revision) { calls.push("resources.requestReview"); return service.requestReview(value, id, revision); },
          // If the CLI casts away its content port to publish directly, the fixture rejects it.
          ...{publish: async () => { calls.push("resources.publish-BYPASS"); throw new Error("CLI must publish through M08"); }},
        },
        checkpoints: {
          async lock(key) { calls.push("checkpoint.lock"); return structuredClone(pending.checkpoints.get(key) ?? null); },
          async insert(checkpoint) { calls.push("checkpoint.insert"); assert.ok(!pending.checkpoints.has(checkpoint.candidateKey)); pending.checkpoints.set(checkpoint.candidateKey, structuredClone(checkpoint)); },
          async save(checkpoint, expectedRevision) {
            calls.push("checkpoint.save");
            assert.equal(pending.checkpoints.get(checkpoint.candidateKey)?.revision, expectedRevision);
            pending.checkpoints.set(checkpoint.candidateKey, structuredClone(checkpoint));
            if (fail.checkpoint) { fail.checkpoint = false; throw new Error("checkpoint unavailable"); }
          },
        },
        reviews: {
          async register(value, input) {
            calls.push("m08.register"); requireReviewer(value);
            const resource = await service.getDraft(value, input.resourceId);
            assert.equal(resource.revision, input.expectedResourceRevision);
            const existing = [...pending.reviews.values()].find(review => review.resourceId === resource.id && review.resourceRevision === resource.revision);
            if (existing) return structuredClone(existing);
            const review: FullReview = {id: `review-${++entitySequence}`, resourceId: resource.id, resourceRevision: resource.revision, resourceVersion: resource.version,
              revision: 1, status: "pending", reviewedBy: null, reviewedAt: null, verification: null, reason: null};
            pending.reviews.set(review.id, review);
            return structuredClone(review);
          },
          async decide(value, id, input) {
            calls.push("m08.decide"); requireReviewer(value);
            const review = pending.reviews.get(id)!;
            assert.equal(review.revision, input.expectedRevision);
            assert.equal(review.resourceRevision, input.expectedResourceRevision);
            assert.equal(input.decision, "approved");
            assert.ok(input.verification);
            const current = await service.getDraft(value, review.resourceId);
            assert.equal(current.linkStatus, "available");
            assert.equal(current.officialUrl, input.verification.link.checkedUrl);
            assert.equal(current.costType === "unknown" ? "unknown" : "verified", input.verification.fees.status);
            assert.equal(current.licenseStatus === "unknown" ? "unknown" : "verified", input.verification.license.status);
            const approved: FullReview = {...review, revision: review.revision + 1, status: "approved", reviewedBy: value.userId, reviewedAt: now, reason: input.reason, verification: structuredClone(input.verification)};
            pending.reviews.set(id, approved);
            if (fail.decide) { fail.decide = false; throw new Error("M08 decision unavailable"); }
            return structuredClone(approved);
          },
          async publish(value, id, input) {
            calls.push("m08.publish"); requireReviewer(value);
            const review = pending.reviews.get(id)!;
            assert.equal(review.status, "approved");
            assert.equal(review.revision, input.expectedRevision);
            assert.equal(review.resourceRevision, input.expectedResourceRevision);
            // This server-owned fixture method simulates M08's publication adapter, not a CLI bypass.
            await service.publish(value, review.resourceId, review.resourceRevision, review.id);
            const published: FullReview = {...review, revision: review.revision + 1, status: "published"};
            pending.reviews.set(id, published);
            if (fail.publish) { fail.publish = false; throw new Error("M08 publication unavailable"); }
            return structuredClone(published);
          },
          async getDetail(value, id) { calls.push("m08.getDetail"); requireReviewer(value); const review = pending.reviews.get(id); assert.ok(review); return {review: structuredClone(review)}; },
        },
      };
      try {
        const result = await work(scope);
        for (const id of ids) {
          const record = await repository.getRecord(id);
          assert.ok(record);
          pending.resources.set(id, record);
        }
        state = pending;
        return result;
      } finally { release(); }
    },
  };
  return {calls, fail, cli: createResourceCatalogCli(dependencies), createCli(selected: readonly ResourceCatalogEntry[]) { return createResourceCatalogCli({...dependencies, entries: selected}); },
    state: () => state, counts: () => ({actorLoads, scopes}), actor(value: Actor) { identity = value; }, clock(value: string) { now = value; }};
}

async function rejectsCode(action: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test("CLI 默认只预览，可选择候选且不读取身份、不打开事务、不写入", async () => {
  const f = fixture([entry("first"), entry("second")]);
  const result = await f.cli.run([]);
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.items.map(item => [item.candidateKey, item.stage, item.resourceId]), [["first", "preview", null], ["second", "preview", null]]);
  assert.deepEqual((await f.cli.run(["--keys", "second"])).items.map(item => item.candidateKey), ["second"]);
  assert.deepEqual(f.counts(), {actorLoads: 0, scopes: 0});
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().resources.size, 0);
});

test("CLI 写入使用可信 Actor，普通账号或伪造 argv 权限均不能导入", async () => {
  const f = fixture();
  for (const args of [["--import", "--role", "admin"], ["--import", "--userId", "victim"], ["--import", "--actor", '{"platformRoles":["admin"]}']]) {
    await rejectsCode(f.cli.run(args), "CATALOG_INVALID_ARGUMENTS");
  }
  assert.equal(f.counts().actorLoads, 0);
  f.actor(user);
  await rejectsCode(f.cli.run(["--import"]), "RESOURCE_REVIEW_FORBIDDEN", 403);
  f.actor(null as unknown as Actor);
  await rejectsCode(f.cli.run(["--import"]), "AUTHENTICATION_REQUIRED", 401);
  assert.equal(f.counts().scopes, 0);
  f.actor({userId: "trusted-admin", platformRoles: ["admin"]});
  await f.cli.run(["--import"]);
  assert.equal(f.state().checkpoints.get("form-starter")?.importedBy, "trusted-admin");
  assert.equal([...f.state().resources.values()][0]!.resource.recordedBy, "trusted-admin");
});

test("CLI 未确认链接时只导入草稿，网页查阅和已有候选时间不变成访问证明", async () => {
  const f = fixture();
  const result = await f.cli.run(["--import"]);
  const checkpoint = f.state().checkpoints.get("form-starter")!;
  const record = f.state().resources.get(checkpoint.resourceId)!;
  assert.equal(result.items[0]?.stage, "imported");
  assert.equal(record.resource.linkStatus, "unknown");
  assert.equal(record.resource.verifiedAt, null);
  assert.equal(record.resource.publicationStatus, "draft");
  assert.equal(record.resource.costType, "unknown");
  assert.equal(record.resource.licenseStatus, "unknown");
  assert.equal(record.publicResource, null);
  assert.equal(f.calls.filter(call => call.startsWith("m08.")).length, 0);
});

test("CLI 审核和发布必须明确参数，未知费用许可必须显式确认仍为未知", async () => {
  const f = fixture();
  for (const args of [["--review"], ["--import", "--review", "--review-reason", "核验"], ["--import", "--publish"],
    ["--import", "--review", "--confirm-links"], ["--import", "--review", "--confirm-links", "--review-reason", "核验"]]) {
    await rejectsCode(f.cli.run(args), "CATALOG_INVALID_ARGUMENTS");
  }
  assert.equal(f.state().resources.size, 0);
  assert.deepEqual(f.counts(), {actorLoads: 0, scopes: 0});
  const result = await f.cli.run(reviewArgs);
  assert.equal(result.items[0]?.stage, "approved");
  const review = [...f.state().reviews.values()][0]!;
  assert.deepEqual(review.verification?.fees, {status: "unknown", sourceUrl: null});
  assert.deepEqual(review.verification?.license, {status: "unknown", sourceUrl: null});
  assert.equal(f.calls.filter(call => call === "m08.publish").length, 0);
  assert.equal([...f.state().resources.values()][0]!.publicResource, null);
});

test("CLI 审核发布按 M09 送审和 M08 注册决定发布的顺序，身份与核验时间真实传递", async () => {
  const f = fixture();
  const result = await f.cli.run([...reviewArgs, "--publish"]);
  const checkpoint = f.state().checkpoints.get("form-starter")!;
  const record = f.state().resources.get(checkpoint.resourceId)!;
  const review = f.state().reviews.get(checkpoint.reviewId!)!;
  assert.equal(result.items[0]?.stage, "published");
  assert.equal(record.publicResource?.publicationStatus, "published");
  assert.equal(record.publicResource?.reviewId, review.id);
  assert.equal(record.resource.verifiedAt, NOW);
  assert.equal(review.reviewedBy, actor.userId);
  assert.equal(review.reviewedAt, NOW);
  assert.deepEqual(f.calls.filter(call => ["resources.createDraft", "resources.updateDraft", "resources.requestReview", "m08.register", "m08.decide", "m08.publish"].includes(call)),
    ["resources.createDraft", "resources.updateDraft", "resources.requestReview", "m08.register", "m08.decide", "m08.publish"]);
  assert.ok(!f.calls.includes("resources.publish-BYPASS"));
  assert.equal(checkpoint.resourceRevision, record.resource.revision);
  assert.equal(checkpoint.reviewRevision, review.revision);
});

test("CLI 已确认费用许可只引用目录相应证据，未知确认不会伪造官方结论", async () => {
  const known = entry("known", {costType: "free_and_paid", costSourceUrl: "https://resource.example.invalid/pricing", costVerifiedAt: EARLIER,
    licenseStatus: "source_verified", licenseSourceUrl: "https://resource.example.invalid/license", licenseVerifiedAt: EARLIER});
  const withEvidence: ResourceCatalogEntry = {...known, evidence: [...known.evidence,
    {field: "cost", url: known.input.costSourceUrl!, checkedAt: EARLIER, note: "官方套餐页面同时说明免费和付费"},
    {field: "license", url: known.input.licenseSourceUrl!, checkedAt: EARLIER, note: "官方许可说明，按页面限制使用"}]};
  const f = fixture([withEvidence]);
  await f.cli.run(reviewArgs.filter(arg => arg !== "--ack-unknown"));
  const review = [...f.state().reviews.values()][0]!;
  assert.deepEqual(review.verification?.fees, {status: "verified", sourceUrl: known.input.costSourceUrl});
  assert.deepEqual(review.verification?.license, {status: "verified", sourceUrl: known.input.licenseSourceUrl});
  const missing = fixture([known]);
  await rejectsCode(missing.cli.run(reviewArgs), "CATALOG_EVIDENCE_REQUIRED", 409);
  assert.equal(missing.state().checkpoints.get("known")?.stage, "imported");
  assert.equal(missing.state().reviews.size, 0);
});

test("CLI 持久检查点阻止重复导入，同 key 的不同目录版本或内容返回 409", async () => {
  const original = entry();
  const f = fixture([original]);
  const [first, second] = await Promise.all([f.cli.run(["--import"]), f.cli.run(["--import"])]);
  assert.equal(first.items[0]?.resourceId, second.items[0]?.resourceId);
  assert.equal(second.items[0]?.reused, true);
  assert.equal(f.state().resources.size, 1);
  assert.equal(f.calls.filter(call => call === "resources.createDraft").length, 1);
  const saved = structuredClone(f.state().checkpoints.get(original.candidateKey));
  await rejectsCode(f.createCli([{...original, catalogVersion: "new-version"}]).run(["--import"]), "CATALOG_ENTRY_CONFLICT", 409);
  await rejectsCode(f.createCli([{...original, input: {...original.input, name: "changed-content"}}]).run(["--import"]), "CATALOG_ENTRY_CONFLICT", 409);
  assert.deepEqual(f.state().checkpoints.get(original.candidateKey), saved);
  assert.equal(f.state().resources.size, 1);
  f.clock("2026-10-08T13:00:00.000Z");
  assert.equal((await f.cli.run(["--import", "--confirm-links"])).items[0]?.resourceId, first.items[0]?.resourceId);
  assert.equal(resourceCatalogEntryHash(original), resourceCatalogEntryHash({...original, input: Object.fromEntries(Object.entries(original.input).reverse()) as unknown as ResourceInput}));
});

test("CLI M08 决定失败后保留已导入草稿，重试复用 ID，不残留未提交审核", async () => {
  const f = fixture();
  await f.cli.run(["--import"]);
  f.fail.decide = true;
  await assert.rejects(f.cli.run(reviewArgs), /M08 decision unavailable/);
  const imported = f.state().checkpoints.get("form-starter")!;
  assert.equal(imported.stage, "imported");
  assert.equal(f.state().resources.get(imported.resourceId)?.resource.linkStatus, "unknown");
  assert.equal(f.state().reviews.size, 0);
  const retry = await f.cli.run([...reviewArgs, "--publish"]);
  assert.equal(retry.items[0]?.resourceId, imported.resourceId);
  assert.equal(retry.items[0]?.stage, "published");
  assert.equal(f.calls.filter(call => call === "resources.createDraft").length, 1);
});

test("CLI 发布或检查点失败保留已批准阶段，恢复不重审，已发布重试不再调用 M08", async () => {
  const f = fixture();
  await f.cli.run(reviewArgs);
  const approved = structuredClone(f.state().checkpoints.get("form-starter")!);
  f.fail.publish = true;
  await assert.rejects(f.cli.run([...reviewArgs, "--publish"]), /M08 publication unavailable/);
  assert.deepEqual(f.state().checkpoints.get("form-starter"), approved);
  assert.equal(f.state().resources.get(approved.resourceId)?.publicResource, null);
  f.fail.checkpoint = true;
  await assert.rejects(f.cli.run([...reviewArgs, "--publish"]), /checkpoint unavailable/);
  assert.deepEqual(f.state().checkpoints.get("form-starter"), approved);
  assert.equal(f.state().resources.get(approved.resourceId)?.publicResource, null);
  const beforeDecision = f.calls.filter(call => call === "m08.decide").length;
  const restored = await f.cli.run([...reviewArgs, "--publish"]);
  assert.equal(restored.items[0]?.stage, "published");
  assert.equal(f.calls.filter(call => call === "m08.decide").length, beforeDecision);
  const beforeM08 = f.calls.filter(call => call.startsWith("m08.")).length;
  await f.cli.run([...reviewArgs, "--publish"]);
  assert.equal(f.calls.filter(call => call.startsWith("m08.")).length, beforeM08);
  assert.equal(f.calls.filter(call => call === "resources.createDraft").length, 1);
});

test("CLI 重试检查当前资源和审核修订，不能静默接管人工变更", async () => {
  const changedResource = fixture();
  await changedResource.cli.run(["--import"]);
  const imported = changedResource.state().checkpoints.get("form-starter")!;
  const record = changedResource.state().resources.get(imported.resourceId)!;
  record.resource = {...record.resource, name: "人工改过的标题", revision: record.resource.revision + 1};
  await rejectsCode(changedResource.cli.run(reviewArgs), "CATALOG_RESOURCE_CHANGED", 409);
  assert.equal(changedResource.calls.filter(call => call === "resources.updateDraft").length, 0);
  const changedReview = fixture();
  await changedReview.cli.run(reviewArgs);
  const approved = changedReview.state().checkpoints.get("form-starter")!;
  const review = changedReview.state().reviews.get(approved.reviewId!)!;
  changedReview.state().reviews.set(review.id, {...review, revision: review.revision + 1, status: "changes_requested"});
  await rejectsCode(changedReview.cli.run([...reviewArgs, "--publish"]), "CATALOG_REVIEW_CHANGED", 409);
  assert.equal(changedReview.calls.filter(call => call === "m08.publish").length, 0);
});
