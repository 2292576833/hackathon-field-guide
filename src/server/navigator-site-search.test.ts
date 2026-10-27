import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./database.ts";
import { createNavigatorService } from "./navigator.ts";
import { AiProviderError, createBudgetedModel, type JsonModelPort, type JsonModelRequest, type JsonModelResult } from "./ai.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import type { SiteSearchDocument, SiteSearchResult } from "./site-search.ts";
import { DomainError } from "../shared/errors.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens } from "../modules/projects/index.ts";

interface SearchInput {
  siteSearch: SiteSearchResult;
  links: readonly { id: string; title: string; href: string }[];
  project: { name: string; stage: string; goal: string } | null;
}
const publicDocument: SiteSearchDocument = {
  id: "resource:laser-kit", title: "镭射积木练习", href: "/resources/laser-kit",
  sourceType: "人工审核公开资源", summary: "镭射积木练习用于制作可以交给队友操作的练习原型。",
  body: ["仅限隔离验收的资料快照，不是线上发布资料。", "镭射积木练习需要先安装练习环境，再运行给定样例。"],
  keywords: ["镭射积木练习"], updatedAt: "2026-10-09T01:00:00Z", scope: "public",
};

async function fixture() {
  const database = await createDatabase({}); await database.migrate();
  const clock = { now: () => new Date("2026-10-09T02:00:00Z") };
  const owner = { userId: "site-search-owner", platformRoles: ["user"] as const };
  const outsider = { userId: "site-search-outsider", platformRoles: ["user"] as const };
  for (const actor of [owner, outsider]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,'站内检索验收','UTC',$3,$3)", [actor.userId, `${actor.userId}@example.test`, clock.now().toISOString()]);
  const projects = new ProjectsService({ repository: new PostgresProjectsRepository(database), clock, ids: { next: randomUUID }, tokens: createInvitationTokens(),
    identity: { async getVerifiedEmail(userId) { return (await database.query<{ email: string }>("SELECT email FROM auth_users WHERE id=$1 AND status='active'", [userId])).rows[0]?.email ?? null; } } });
  const project = await projects.createProject(owner, { name: "椰树解谜练习队", goal: "椰树解谜", minimumDeliverable: "椰树解谜原型", timezone: "UTC" });
  // A test-only public snapshot port. All authorization, jobs, usage and project
  // changes below use the real isolated PostgreSQL services, without live data.
  await database.query("CREATE TABLE navigator_search_fixture(id text PRIMARY KEY, document jsonb NOT NULL)");
  const store = async (documents: readonly SiteSearchDocument[]) => {
    await database.transaction(async sql => {
      await sql.query("DELETE FROM navigator_search_fixture");
      for (const document of documents) await sql.query("INSERT INTO navigator_search_fixture(id,document) VALUES($1,$2::jsonb)", [document.id, JSON.stringify(document)]);
    });
  };
  await store([publicDocument]);
  let sourceReads = 0, failRead: ((read: number) => boolean) | null = null;
  const siteSources = { async readPublicDocuments(): Promise<readonly SiteSearchDocument[]> {
    sourceReads++;
    if (failRead?.(sourceReads)) throw new Error("isolated catalog read fault");
    return (await database.query<{ document: SiteSearchDocument }>("SELECT document FROM navigator_search_fixture ORDER BY id")).rows.map(row => row.document);
  } };
  const requests: JsonModelRequest[] = [];
  const output = (linkIds: readonly string[] = []): JsonModelResult => ({ content: { reply: "这是隔离模型的回答，请从所列站内资料继续核对。", linkIds }, usage: { inputTokens: 100, outputTokens: 15 }, requestId: null, modelVersion: "test-only-site-search" });
  let perform: JsonModelPort["completeJSON"] = async request => {
    const input = request.input as SearchInput;
    return output(input.siteSearch.items.slice(0, 1).map(item => item.id));
  };
  const raw: JsonModelPort = { modelVersion: "test-only-site-search", async completeJSON(request, signal) { requests.push(request); return perform(request, signal); } };
  const ledger = new PostgresAiLedger(database, { dailyProjectCallLimit: 20, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000 });
  const model = createBudgetedModel({ model: raw, ledger, clock: clock.now });
  const navigator = (provider: JsonModelPort | null = model) => createNavigatorService({ database, projects, clock, ids: { next: randomUUID }, model: provider, ledger, siteSources });
  return { database, clock, owner, outsider, projects, project, store, siteSources, requests, ledger, output, navigator,
    setProvider: (value: typeof perform) => { perform = value; }, failSource: (value: typeof failRead) => { failRead = value; }, sourceReads: () => sourceReads };
}

test("navigator passes the actual bounded public match to DSH and returns only its supplied site entrance", async () => {
  const f = await fixture();
  try {
    const result = await f.navigator().reply(f.owner, { message: "镭射积木练习", pagePath: "/resources" });
    assert.equal(f.requests.length, 1); assert.equal(f.sourceReads(), 2);
    const request = f.requests[0]!, input = request.input as SearchInput;
    assert.equal(request.promptVersion, "site-dsh-chat-v3-search");
    assert.match(request.systemPrompt, /不可信数据/);
    const match = input.siteSearch.items.find(item => item.id === publicDocument.id)!;
    assert.ok(match); assert.equal(match.title, publicDocument.title); assert.equal(match.href, publicDocument.href);
    assert.equal(match.scope, "public"); assert.equal(match.sourceType, publicDocument.sourceType);
    const body = typeof publicDocument.body === "string" ? publicDocument.body : publicDocument.body!.join(" ");
    assert.ok(match.excerpt.length > 0); assert.ok((publicDocument.summary + " " + body).includes(match.excerpt));
    assert.equal(match.updatedAt, publicDocument.updatedAt);
    assert.ok(input.links.some(link => link.id === match.id && link.href === match.href));
    assert.ok(input.siteSearch.items.length <= 6); assert.ok(Buffer.byteLength(JSON.stringify(input.siteSearch)) <= 12_288);
    assert.equal(result.provider, "dsh"); assert.deepEqual(result.siteSearch, input.siteSearch);
    assert.deepEqual(result.links, [{ title: publicDocument.title, href: publicDocument.href }]);
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts WHERE status='settled' AND usage_verified=true")).rowCount, 1);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "succeeded");
  } finally { await f.database.close(); }
});

test("no matching source remains an explicit empty search and does not admit a model-invented link ID", async () => {
  const f = await fixture();
  try {
    f.setProvider(async request => {
      const input = request.input as SearchInput;
      assert.deepEqual(input.siteSearch.items, []); assert.ok(input.siteSearch.notices.length > 0);
      assert.equal(input.siteSearch.coverage.returnedDocuments, 0);
      return f.output();
    });
    const result = await f.navigator().reply(f.owner, { message: "zzqxvunmatchedsentinel", pagePath: "/resources" });
    assert.deepEqual(result.siteSearch.items, []); assert.deepEqual(result.links, []); assert.equal(result.provider, "dsh");
    f.setProvider(async () => f.output(["resource:invented-by-model"]));
    await assert.rejects(f.navigator().reply(f.owner, { message: "zzqxvunmatchedsentinel", pagePath: "/resources" }), { code: "NAVIGATOR_RESPONSE_INVALID" });
    assert.equal(f.requests.length, 2); assert.equal(f.sourceReads(), 2, "no unmatched public document needs a final source re-read");
  } finally { await f.database.close(); }
});

test("external, encoded and private-project source links cannot enter the public model search", async () => {
  const f = await fixture();
  try {
    await f.store([
      { ...publicDocument, id: "forged-external", href: "https://evil.example.test/" },
      { ...publicDocument, id: "forged-network", href: "//evil.example.test/" },
      { ...publicDocument, id: "forged-query", href: "/resources?next=https%3A%2F%2Fevil.example.test" },
      { ...publicDocument, id: "forged-traversal", href: "/resources/%2e%2e/app" },
      { ...publicDocument, id: "forged-project", href: `/app/projects/${f.project.id}` },
      { ...publicDocument, id: "forged-private", scope: "current_project", href: `/app/projects/${f.project.id}` },
    ]);
    f.setProvider(async request => {
      const input = request.input as SearchInput;
      // "练习" may legitimately match an authored beginner guide. The forged
      // identities/text must still stay outside the actual searchable result.
      assert.ok(input.siteSearch.items.every(item => !item.id.startsWith("forged-")));
      assert.ok(!JSON.stringify(input.siteSearch).includes("镭射积木"));
      assert.ok(input.links.every(link => !link.id.startsWith("forged-")));
      return f.output();
    });
    const result = await f.navigator().reply(f.owner, { message: "镭射积木练习", pagePath: "/resources" });
    assert.equal(result.provider, "dsh"); assert.ok(result.siteSearch.items.every(item => !item.id.startsWith("forged-")));
    assert.equal(f.requests.length, 1);
  } finally { await f.database.close(); }
});

test("request identity and project permission are checked before reading public search sources or calling DSH", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.navigator().reply(f.outsider, { message: "镭射积木练习", pagePath: "/app", projectId: f.project.id }), { code: "PROJECT_UNAVAILABLE" });
    await assert.rejects(f.navigator().reply(f.owner, { message: "镭射积木练习", pagePath: "/resources" }, async () => { throw new DomainError("UNAUTHENTICATED", "隔离会话已撤销", { status: 401 }); }), { code: "UNAUTHENTICATED" });
    assert.equal(f.sourceReads(), 0); assert.equal(f.requests.length, 0);
    assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts")).rowCount, 0);
  } finally { await f.database.close(); }
});

for (const change of ["withdraw", "edit", "unavailable"] as const) test(`matched public source ${change} during DSH generation withholds the whole answer as 409`, async () => {
  const f = await fixture();
  try {
    f.setProvider(async request => {
      const input = request.input as SearchInput;
      assert.ok(input.siteSearch.items.some(item => item.id === publicDocument.id));
      if (change === "withdraw") await f.store([]);
      else if (change === "edit") await f.store([{ ...publicDocument, summary: "公开资料已修订为另一种练习，不再包含旧条件。", updatedAt: "2026-10-09T02:01:00Z" }]);
      else f.failSource(read => read >= 2);
      return f.output([publicDocument.id]);
    });
    await assert.rejects(f.navigator().reply(f.owner, { message: "镭射积木练习", pagePath: "/resources" }), error => error instanceof DomainError && error.code === "NAVIGATOR_SOURCES_CHANGED" && error.status === 409);
    assert.equal(f.requests.length, 1); assert.equal(f.sourceReads(), 2);
    const job = (await f.database.query<{ status: string; error_code: string }>("SELECT status,error_code FROM ai_execution_jobs")).rows[0]!;
    assert.equal(job.status, "failed"); assert.equal(job.error_code, "NAVIGATOR_SOURCES_CHANGED");
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts WHERE status='settled' AND external_state='response_received'")).rowCount, 1, "a discarded answer still accounts the completed model request");
  } finally { await f.database.close(); }
});

test("a changed current-project goal is rechecked through M02 before its old excerpt can be returned", async () => {
  const f = await fixture();
  try {
    f.setProvider(async request => {
      const input = request.input as SearchInput;
      const own = input.siteSearch.items.find(item => item.id === "current-space-summary")!;
      assert.ok(own); assert.equal(own.scope, "current_project"); assert.match(own.excerpt, /椰树解谜/);
      const current = await f.projects.getProject(f.owner, f.project.id);
      await f.projects.editProject(f.owner, f.project.id, { expectedRevision: current.project.revision, goal: "柏树解谜新目标" });
      return f.output([own.id]);
    });
    await assert.rejects(f.navigator().reply(f.owner, { message: "椰树解谜", pagePath: `/app/projects/${f.project.id}`, projectId: f.project.id }), { code: "NAVIGATOR_SOURCES_CHANGED", status: 409 });
    assert.equal(f.requests.length, 1);
    assert.equal((await f.projects.getProject(f.owner, f.project.id)).project.goal, "柏树解谜新目标");
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "failed");
  } finally { await f.database.close(); }
});

test("the project summary sent alongside unrelated public hits is fresh even when it was not a matched search item", async () => {
  const f = await fixture();
  try {
    f.setProvider(async request => {
      const input = request.input as SearchInput;
      assert.ok(input.siteSearch.items.some(item => item.id === "site:ppt"));
      assert.ok(!input.siteSearch.items.some(item => item.id === "current-space-summary"));
      assert.equal(input.project?.goal, "椰树解谜", "the unquoted project summary still reaches the model");
      const current = await f.projects.getProject(f.owner, f.project.id);
      await f.projects.editProject(f.owner, f.project.id, { expectedRevision: current.project.revision, goal: "榕树解谜：已修改的实际目标" });
      return f.output(["site:ppt"]);
    });
    await assert.rejects(f.navigator().reply(f.owner, { message: "PPT模板", pagePath: `/app/projects/${f.project.id}`, projectId: f.project.id }), { code: "NAVIGATOR_SOURCES_CHANGED", status: 409 });
    assert.equal(f.requests.length, 1);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "failed");
  } finally { await f.database.close(); }
});

test("only the selected authorized space summary is searched and another real private space stays absent", async () => {
  const f = await fixture();
  try {
    const other = await f.projects.createProject(f.outsider, { name: "绝密扇贝队", goal: "绝密扇贝赛道", minimumDeliverable: "绝密扇贝资料", timezone: "UTC" });
    f.setProvider(async request => {
      const input = request.input as SearchInput, sent = JSON.stringify(input);
      assert.equal(input.project?.name, f.project.name); assert.equal(input.project?.goal, f.project.goal);
      assert.ok(!sent.includes(other.id)); assert.ok(!sent.includes("绝密扇贝"));
      const own = input.siteSearch.items.find(item => item.id === "current-space-summary")!;
      assert.ok(own); assert.equal(own.href, `/app/projects/${f.project.id}`);
      assert.ok(input.siteSearch.items.filter(item => item.scope === "current_project").every(item => item.href.startsWith(`/app/projects/${f.project.id}`)));
      return f.output([own.id]);
    });
    const result = await f.navigator().reply(f.owner, { message: "椰树解谜", pagePath: `/app/projects/${f.project.id}`, projectId: f.project.id });
    assert.deepEqual(result.links, [{ title: `当前团队空间：${f.project.name}`, href: `/app/projects/${f.project.id}` }]);
    assert.equal(result.provider, "dsh"); assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(result).includes("绝密扇贝"));
  } finally { await f.database.close(); }
});

test("initial public-catalog failure retains usable static guides and tells DSH and the user the limited coverage", async () => {
  const f = await fixture();
  try {
    f.failSource(() => true);
    f.setProvider(async request => {
      const input = request.input as SearchInput;
      assert.ok(input.siteSearch.items.length > 0); assert.ok(input.siteSearch.items.every(item => item.scope === "public"));
      assert.ok(input.siteSearch.items.some(item => item.href === "/app" || item.href.startsWith("/library/")));
      assert.ok(input.siteSearch.notices.some(value => /部分.*目录.*无法读取/.test(value)));
      return f.output(input.siteSearch.items.slice(0, 1).map(item => item.id));
    });
    const result = await f.navigator().reply(f.owner, { message: "邀请队友", pagePath: "/app" });
    assert.equal(result.provider, "dsh"); assert.equal(f.requests.length, 1); assert.equal(f.sourceReads(), 1);
    assert.ok(result.siteSearch.notices.some(value => /部分.*目录.*无法读取/.test(value)));
  } finally { await f.database.close(); }
});

test("search cannot replace an unconfigured DSH or replay an unknown provider request", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.navigator(null).reply(f.owner, { message: "镭射积木练习", pagePath: "/resources" }), { code: "NAVIGATOR_NOT_CONFIGURED" });
    assert.equal(f.sourceReads(), 0); assert.equal(f.requests.length, 0);
    f.setProvider(async request => {
      assert.ok((request.input as SearchInput).siteSearch.items.some(item => item.id === publicDocument.id));
      throw new AiProviderError("AI_NETWORK_UNCERTAIN", "unknown", { retryable: true });
    });
    await assert.rejects(f.navigator().reply(f.owner, { message: "镭射积木练习", pagePath: "/resources" }), { code: "AI_NETWORK_UNCERTAIN" });
    assert.equal(f.requests.length, 1, "unknown network result is never retried despite having retrieval results");
    const job = (await f.database.query<{ status: string; external_state: string }>("SELECT status,external_state FROM ai_execution_jobs")).rows[0]!;
    assert.equal(job.status, "unknown"); assert.equal(job.external_state, "unknown");
    const attempt = (await f.database.query<{ status: string; external_state: string; usage_verified: boolean; charged_micro_usd: string | number }>("SELECT status,external_state,usage_verified,charged_micro_usd FROM ai_usage_attempts")).rows[0]!;
    assert.equal(attempt.status, "settled"); assert.equal(attempt.external_state, "unknown"); assert.equal(attempt.usage_verified, false);
    assert.ok(Number(attempt.charged_micro_usd) > 0);
  } finally { await f.database.close(); }
});
