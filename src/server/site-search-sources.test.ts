import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import { ResourceService } from "../modules/resources/service.ts";
import type { Resource, ResourceInput } from "../modules/resources/domain.ts";
import type { ApprovedResourceReview } from "../modules/resources/ports.ts";
import { MemoryResourceRepository } from "../modules/resources/testing/memory-repository.ts";
import { INITIAL_SKILLS } from "../modules/skills/seed.ts";
import type { DiscoveryCard } from "./discovery.ts";
import type { InspirationFeed } from "./inspiration.ts";
import { inspirationSeed } from "./inspiration-catalog.ts";
import { createSiteSearchSourceReader, type SiteSearchSourceDependencies } from "./site-search-sources.ts";

const now = "2026-10-09T02:00:00.000Z";
const reviewer: Actor = { userId: "source-reader-fixture-reviewer", platformRoles: ["reviewer"] };
function resourceInput(overrides: Partial<ResourceInput> = {}): ResourceInput {
  return {
    name: "公开表单工具夹具", officialUrl: "https://example.invalid/forms", type: "ui_visual", stageTags: ["development"],
    useTags: ["form"], stackTags: ["react"], prerequisites: ["basic_code"], summary: "公开审核版本说明", suitableFor: "表单原型队伍",
    notSuitableFor: "不能代替规则核对", quickStart: ["阅读公开文档", "试一个表单"], costType: "unknown", costNote: "费用未核实",
    costSourceUrl: null, costVerifiedAt: null, licenseStatus: "unknown", licenseNote: "许可未核实", licenseSourceUrl: null,
    licenseVerifiedAt: null, verifiedAt: "2026-10-09T01:00:00.000Z", linkStatus: "available", displayOrder: 1, ...overrides,
  };
}
function resourceFixture() {
  const reviews = new Map<string, ApprovedResourceReview>(); let sequence = 0;
  const service = new ResourceService({ repository: new MemoryResourceRepository(), clock: { now: () => new Date(now) },
    ids: { next: () => `source-resource-${++sequence}` }, reviews: { async getApprovedReview(id) { return reviews.get(id) ?? null; } } });
  async function publish(input: ResourceInput = resourceInput()) {
    const draft = await service.createDraft(reviewer, input);
    const pending = await service.requestReview(reviewer, draft.id, draft.revision);
    const review: ApprovedResourceReview = { id: `fixture-review-${pending.id}`, resourceId: pending.id, resourceVersion: pending.version,
      reviewerId: reviewer.userId, result: "approved", checkedAt: now, sourceLinks: [pending.officialUrl] };
    reviews.set(review.id, review);
    return service.publish(reviewer, pending.id, pending.revision, review.id);
  }
  return { service, publish };
}
function dependencies(overrides: Partial<SiteSearchSourceDependencies> = {}): SiteSearchSourceDependencies {
  return {
    resources: { async list() { return { items: [], nextCursor: null }; } },
    discoveries: { async list() { return { items: [], nextCursor: null, version: "fixture-version" }; } },
    skills: { async list() { return { items: [], nextCursor: null }; } },
    inspiration: { async snapshot() { return { items: [], pendingItems: [], status: { kind: "dsh", message: "隔离夹具" } }; } },
    ...overrides,
  };
}
function discovery(id: string, overrides: Partial<DiscoveryCard> = {}): DiscoveryCard {
  return {
    id: id.repeat(64), revision: 2, verificationStatus: "unverified", provider: "dsh", canonicalUrl: "https://example.invalid/hackathon",
    title: "DSH已保存赛事夹具", summary: "隔离赛事分析说明", analysis: { fit: ["愿意做原型的人"], risks: ["资格待核对"], preparation: ["缩小范围"], unknowns: ["地点未知"] },
    sources: [{ title: "搜索引用夹具", url: "https://example.invalid/hackathon", excerpt: "报名截止未知", fetchedAt: now, sourceKind: "indexed_excerpt" }],
    registrationWindow: { status: "unknown", closesAt: null, closesOn: null, evidence: ["报名截止未知"], checkedAt: now },
    discoveredAt: now, lastAnalyzedAt: now, ...overrides,
  };
}
function publicResource(overrides: Partial<Resource> = {}): Resource {
  return { ...resourceInput(), id: "resource-1", version: 1, revision: 3, publicationStatus: "published", reviewId: "fixture-review",
    publishedAt: now, withdrawnReason: null, externalLinkBlocked: false, createdAt: now, updatedAt: now, recordedBy: "not-indexed-reviewer", ...overrides };
}

test("empty public sources produce no fabricated results and receive only the four read calls", async () => {
  const calls: string[] = [];
  const deps = dependencies();
  for (const name of ["resources", "discoveries", "skills", "inspiration"] as const) {
    const port = deps[name];
    deps[name] = new Proxy(port, { get(target, key, receiver) {
      assert.ok(key === "list" || key === "snapshot", "reader must not request a write, worker or private-data method");
      calls.push(`${name}:${String(key)}`); return Reflect.get(target, key, receiver);
    } }) as never;
  }
  assert.deepEqual(await createSiteSearchSourceReader(deps).readPublicDocuments(), []);
  assert.deepEqual(calls.sort(), ["discoveries:list", "inspiration:snapshot", "resources:list", "skills:list"]);
});

test("real ResourceService exposes only published public snapshot while draft edits and withdrawal stay out", async () => {
  const f = resourceFixture();
  const published = await f.publish();
  await f.service.createDraft(reviewer, resourceInput({ name: "未公开秘密草稿", summary: "不可被导航员读取" }));
  const edited = await f.service.updateDraft(reviewer, published.id, published.revision, resourceInput({ summary: "未发布改稿不能泄露" }));
  const reader = createSiteSearchSourceReader(dependencies({ resources: f.service }));
  const first = await reader.readPublicDocuments();
  assert.equal(first.length, 1); assert.equal(first[0]!.summary, published.summary);
  assert.equal(first[0]!.href, `/resources/${published.id}`);
  assert.equal(first[0]!.scope, "public"); assert.equal(first[0]!.updatedAt, published.updatedAt);
  assert.doesNotMatch(JSON.stringify(first), /未公开秘密|不能泄露|recordedBy|source-reader-fixture-reviewer/);
  await f.service.withdraw(reviewer, published.id, edited.revision, "隔离测试下架", true);
  assert.deepEqual(await reader.readPublicDocuments(), []);
});

test("resource defense excludes draft, withdrawn, blocked and unsafe IDs even if a port returns them", async () => {
  const items = [publicResource(), publicResource({ id: "draft", publicationStatus: "draft" }),
    publicResource({ id: "withdrawn", publicationStatus: "withdrawn" }), publicResource({ id: "blocked", externalLinkBlocked: true }),
    publicResource({ id: "../private" })];
  const docs = await createSiteSearchSourceReader(dependencies({ resources: { async list() { return { items, nextCursor: null }; } } })).readPublicDocuments();
  assert.deepEqual(docs.map(value => value.id), ["resource:resource-1"]);
  assert.match(JSON.stringify(docs[0]!.body), /费用未核实/);
  assert.match(JSON.stringify(docs[0]!.body), /许可未核实/);
});

test("all projections are bounded; resources use two 50-item pages and discoveries one 60-item request", async () => {
  const calls: unknown[] = [];
  const sample = INITIAL_SKILLS[0]!;
  const reader = createSiteSearchSourceReader(dependencies({
    resources: { async list(query = {}) {
      calls.push(query); const offset = Number(query.cursor ?? 0);
      return { items: Array.from({ length: 70 }, (_, index) => publicResource({ id: `bounded-${offset + index}` })), nextCursor: String(offset + 50) };
    } },
    discoveries: { async list(query = {}) { calls.push(query); return { items: [], nextCursor: "never-follow", version: "fixture-version" }; } },
    skills: { async list() { return { items: Array.from({ length: 130 }, (_, index) => {
      const id = `bounded-skill-${index}`;
      return { ...sample, id, versions: [{ ...sample.versions[0]!, id: `${id}@fixed`, skillId: id }] };
    }), nextCursor: null }; } },
    inspiration: { async snapshot() { return { items: [], pendingItems: Array.from({ length: 90 }, (_, index) => ({
      ...inspirationSeed[0]!, id: `bounded-inspiration-${index}`,
    })), status: { kind: "dsh", message: "隔离候选身份夹具" } }; } },
  }));
  const docs = await reader.readPublicDocuments();
  assert.equal(docs.length, 260);
  assert.equal(docs.filter(value => value.id.startsWith("resource:")).length, 100);
  assert.equal(docs.filter(value => value.id.startsWith("skill:")).length, 100);
  assert.equal(docs.filter(value => value.id.startsWith("inspiration:")).length, 60);
  assert.equal(calls.length, 3);
  assert.ok(calls.some(value => JSON.stringify(value) === JSON.stringify({ limit: 50 })));
  assert.ok(calls.some(value => JSON.stringify(value) === JSON.stringify({ limit: 50, cursor: "50" })));
  assert.ok(calls.some(value => JSON.stringify(value) === JSON.stringify({ limit: 60 })));
});

test("DSH discoveries retain unknown/closed/past facts and point to real card participation rather than official event detail", async () => {
  const items = [discovery("a"), discovery("b", {
    registrationWindow: { status: "closed", closesAt: "2026-01-01T00:00:00.000Z", closesOn: null, evidence: ["报名已截止"], checkedAt: now },
    eventWindow: { status: "past", startsAt: "2026-01-02T00:00:00.000Z", startsOn: null, evidence: ["比赛开赛2026-01-02"], checkedAt: now },
  }), discovery("c", { provider: "not-dsh" as never }), discovery("d", { id: "../private" })];
  const docs = await createSiteSearchSourceReader(dependencies({ discoveries: { async list() { return { items, nextCursor: null, version: "fixture-version" }; } } })).readPublicDocuments();
  assert.equal(docs.length, 2);
  for (const doc of docs) {
    assert.equal(doc.sourceType, "DSH赛事线索（未人工核验）");
    assert.equal(doc.href, `/participation?event=${doc.id.slice("discovery:".length)}`);
    assert.equal(doc.updatedAt, now); assert.match(JSON.stringify(doc.body), /未读取全文/);
  }
  assert.match(JSON.stringify(docs[0]!.body), /报名截止尚未核实/);
  assert.match(JSON.stringify(docs[1]!.body), /报名已截止/);
  assert.match(JSON.stringify(docs[1]!.body), /日期已过/);
});

test("inspiration indexes only saved DSH analysis; pending and date-only editorial seed retain identity without invented descriptions", async () => {
  const seed = inspirationSeed[0]!;
  const analyzed = { ...seed, description: "隔离模型结果：实际已保存说明", useWhen: "隔离模型结果：适用场景", usageNote: "隔离模型结果：使用说明", checkedAt: now };
  const feed: InspirationFeed = { items: [analyzed, inspirationSeed[1]!], pendingItems: [
    { ...inspirationSeed[2]!, description: "不可泄露的静态候选说明" } as never,
    { ...seed, description: "重复候选不得覆盖真实分析" } as never,
  ], status: { kind: "dsh", message: "状态变化不属于文档正文", updatedAt: now } };
  const docs = await createSiteSearchSourceReader(dependencies({ inspiration: { async snapshot() { return feed; } } })).readPublicDocuments();
  assert.equal(docs.length, 3);
  const result = docs.find(value => value.id === `inspiration:${seed.id}`)!;
  assert.equal(result.summary, analyzed.description); assert.equal(result.updatedAt, now);
  assert.ok(docs.every(value => value.href === "/inspiration"));
  const pending = docs.filter(value => value.id !== result.id);
  assert.ok(pending.every(value => value.sourceType === "灵感候选（尚未完成DSH分析）" && value.updatedAt === undefined));
  assert.doesNotMatch(JSON.stringify(pending), /不可泄露的静态|浏览完整项目|重复候选不得|状态变化不属于/);
  feed.status.kind = "curated";
  const editorial = await createSiteSearchSourceReader(dependencies({ inspiration: { async snapshot() { return feed; } } })).readPublicDocuments();
  assert.ok(editorial.every(value => value.sourceType === "灵感候选（尚未完成DSH分析）"));
  assert.doesNotMatch(JSON.stringify(editorial), /实际已保存说明|适用场景|使用说明/);
});

test("skills index published valid fixed versions with a selecting link and explicit untested compatibility", async () => {
  const sample = INITIAL_SKILLS[0]!;
  const live = sample.versions[0]!;
  const skill = { ...sample, versions: [live, { ...live, id: `${sample.id}@withdrawn`, status: "withdrawn" as const },
    { ...live, id: `${sample.id}@malformed`, commit: "main" }] };
  const docs = await createSiteSearchSourceReader(dependencies({ skills: { async list() { return { items: [skill], nextCursor: null }; } } })).readPublicDocuments();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.id, `skill:${live.id}`);
  assert.equal(docs[0]!.href, `/skills/${sample.id}?versionId=${encodeURIComponent(live.id)}`);
  assert.equal(docs[0]!.updatedAt, live.reviewedAt);
  assert.match(JSON.stringify(docs[0]!.body), /客户端加载与示例任务尚未实测/);
  assert.match(JSON.stringify(docs[0]!.body), /不能确认用户已安装/);
  assert.match(JSON.stringify(docs[0]!.body), new RegExp(live.commit));
});

test("fresh stable projections reflect changed public content and source read failures reject instead of claiming successful revalidation", async () => {
  let row = publicResource();
  const reader = createSiteSearchSourceReader(dependencies({ resources: { async list() { return { items: [row], nextCursor: null }; } } }));
  const first = await reader.readPublicDocuments();
  assert.deepEqual(await reader.readPublicDocuments(), first);
  row = { ...row, summary: "已发布新说明", revision: 4, updatedAt: "2026-10-09T03:00:00.000Z" };
  const changed = await reader.readPublicDocuments();
  assert.equal(changed[0]!.id, first[0]!.id); assert.notDeepEqual(changed, first);
  assert.equal(changed[0]!.summary, row.summary); assert.equal(changed[0]!.updatedAt, row.updatedAt);
  const broken = createSiteSearchSourceReader(dependencies({ discoveries: { async list() { throw new Error("isolated-public-source-unavailable"); } } }));
  await assert.rejects(broken.readPublicDocuments(), /isolated-public-source-unavailable/);
});

test("a source failure is returned only after all sibling read branches finish", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let siblingFinished = false, returned = false;
  const reader = createSiteSearchSourceReader(dependencies({
    resources: { async list() { await blocked; siblingFinished = true; return { items: [], nextCursor: null }; } },
    discoveries: { async list() { throw new Error("isolated-read-failure"); } },
  }));
  const reading = reader.readPublicDocuments();
  // Observe both outcomes now, without producing an unhandled rejection.
  const completion = reading.then(() => { returned = true; }, () => { returned = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(returned, false, "failed read must not release the caller's scope while another read is pending");
    assert.equal(siblingFinished, false);
  } finally { release(); }
  await assert.rejects(reading, /isolated-read-failure/);
  await completion;
  assert.equal(siblingFinished, true); assert.equal(returned, true);
});
