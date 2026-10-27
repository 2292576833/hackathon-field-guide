import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "./database.ts";
import { createNavigatorService, NAVIGATOR_INTRO } from "./navigator.ts";
import { createBudgetedModel, type JsonModelPort } from "./ai.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import { DomainError } from "../shared/errors.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens } from "../modules/projects/index.ts";
import type { SqlExecutor } from "../shared/persistence.ts";

test("public introduction distinguishes the tool collection from the separate DSH inspiration directory", () => {
  assert.deepEqual(NAVIGATOR_INTRO.links.find(link => link.href === "/resources"), { title: "工具与资料", href: "/resources" });
  assert.deepEqual(NAVIGATOR_INTRO.links.find(link => link.href === "/inspiration"), { title: "灵感库", href: "/inspiration" });
  assert.ok(NAVIGATOR_INTRO.sections.some(section => /工具与参考资料经过审核.*私人收藏.*主动分享.*空间资料/.test(section)));
  assert.ok(NAVIGATOR_INTRO.sections.some(section => /设计灵感.*DSH.*等待/.test(section)));
  assert.ok(NAVIGATOR_INTRO.sections.some(section => /新人教程是本站原创/.test(section)));
  assert.ok(NAVIGATOR_INTRO.links.every(link => link.href.startsWith("/") && !link.href.startsWith("//")));
});

test("navigator enforces identity, persisted request budget, provider budget and safe site links", async () => {
  const database = await createDatabase({}); const clock = { now: () => new Date("2026-10-08T10:00:00Z") };
  const actor = { userId: "navigator-test", platformRoles: ["user"] as const }; let calls = 0;
  try {
    await database.migrate();
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,'navigator@example.test','导航验收','Asia/Shanghai',$2,$2)", [actor.userId, clock.now().toISOString()]);
    const raw: JsonModelPort = { modelVersion: "test-only-model", async completeJSON() { calls++; return { content: { reply: "请先查看网站介绍。", linkIds: ["start-here"] }, usage: { inputTokens: 100, outputTokens: 15 }, requestId: null, modelVersion: "test-only-model" }; } };
    const ledger = new PostgresAiLedger(database, { dailyProjectCallLimit: 20 });
    const model = createBudgetedModel({ model: raw, ledger, clock: clock.now });
    const navigator = createNavigatorService({ database, clock, ids: { next: randomUUID }, projects: { async getProject() { throw new DomainError("NOT_FOUND", "无访问权限。", { status: 404 }); } }, model, ledger });
    await assert.rejects(navigator.reply(actor, { message: "另一个项目", pagePath: "/app", projectId: "another-project" }), { code: "NOT_FOUND" });
    assert.equal(calls, 0);
    for (let count = 0; count < 10; count++) {
      const answer = await navigator.reply(actor, { message: "如何使用网站", pagePath: "/events", history: [] });
      assert.deepEqual(answer.links, [{ title: "第一次使用情报局，从这里开始", href: "/library/start-here" }]);
      assert.equal(answer.provider, "dsh");
    }
    await assert.rejects(navigator.reply(actor, { message: "第十一次", pagePath: "/events" }), { code: "NAVIGATOR_RATE_LIMITED" });
    assert.equal(calls, 10);
    assert.equal((await database.query("SELECT * FROM ai_usage_attempts WHERE status='settled'")).rowCount, 10);
    await assert.rejects(navigator.reply({ ...actor, userId: "missing" }, { message: "你好", pagePath: "/" }), { code: "UNAUTHENTICATED" });
    await assert.rejects(navigator.reply(actor, { message: "你好", pagePath: "//evil.com" }), { code: "INVALID_NAVIGATOR_INPUT" });
    const jobs = await database.query<{ status: string }>("SELECT status FROM ai_execution_jobs");
    assert.ok(jobs.rows.every(job => job.status === "succeeded"));
  } finally { await database.close(); }
});

test("navigator tolerates harmless DSH metadata while keeping link validation strict", async () => {
  const f = await guardedFixture();
  try {
    f.setProvider(async () => ({ ...f.output(), content: { reply: "先打开参赛路线图。", linkIds: ["journey"], metadata: { trace: "ignored" } } }));
    const result = await f.navigator().reply(f.actor, { message: "我该从哪里开始", pagePath: "/events" });
    assert.equal(result.reply, "先打开参赛路线图。");
    assert.deepEqual(result.links, [{ title: "参赛路线图", href: "/journey" }]);
  } finally { await f.database.close(); }
});

async function guardedFixture() {
  const database = await createDatabase({});
  await database.migrate();
  let time = Date.parse("2026-10-08T10:00:00Z"), calls = 0;
  const clock = { now: () => new Date(time) };
  const actor = { userId: "navigator-member", platformRoles: ["user"] as const };
  const owner = { userId: "navigator-owner", platformRoles: ["user"] as const };
  // Explicit verified identity fixtures; no login codes or external credentials are used.
  for (const current of [actor, owner]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,'导航测试','UTC',$3,$3)", [current.userId, `${current.userId}@example.test`, clock.now().toISOString()]);
  const projects = new ProjectsService({ repository: new PostgresProjectsRepository(database), clock, ids: { next: randomUUID }, tokens: createInvitationTokens(),
    identity: { async getVerifiedEmail(userId) { return (await database.query<{ email: string }>("SELECT email FROM auth_users WHERE id=$1 AND status='active'", [userId])).rows[0]?.email ?? null; } } });
  const project = await projects.createProject(owner, { name: "私有队伍测试", goal: "供当前成员查看的目标", timezone: "UTC" });
  const invitation = await projects.createProjectInvitation(owner, project.id, { expectedRevision: project.revision, role: "member", invitedEmail: `${actor.userId}@example.test` });
  await projects.acceptInvitation(actor, invitation.token);
  const output = (): Awaited<ReturnType<JsonModelPort["completeJSON"]>> => ({ content: { reply: "可以从当前项目查看计划。", linkIds: ["current-project"] }, usage: { inputTokens: 100, outputTokens: 15 }, requestId: null, modelVersion: "test-only-model" });
  let perform: JsonModelPort["completeJSON"] = async () => output();
  const raw: JsonModelPort = { modelVersion: "test-only-model", async completeJSON(request, signal) { calls++; return perform(request, signal); } };
  const ledger = new PostgresAiLedger(database, { dailyProjectCallLimit: 20, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000 });
  const model = createBudgetedModel({ model: raw, ledger, clock: clock.now });
  const navigator = (projectReader: Pick<ProjectsService, "getProject"> = projects) => createNavigatorService({ database, clock, ids: { next: randomUUID }, projects: projectReader, model, ledger });
  return { database, clock, actor, owner, projects, project, ledger, model, navigator, output, setProvider: (next: typeof perform) => { perform = next; }, advance: (milliseconds: number) => { time += milliseconds; }, calls: () => calls };
}
test("navigator withholds generated reply when the verified account is suspended during the provider call", async () => {
  const f = await guardedFixture();
  try {
    f.setProvider(async () => { await f.database.query("UPDATE auth_users SET status='suspended',revision=revision+1 WHERE id=$1", [f.actor.userId]); return f.output(); });
    await assert.rejects(f.navigator().reply(f.actor, { message: "帮助我开始", pagePath: "/app", projectId: f.project.id }), { code: "UNAUTHENTICATED" });
    assert.equal(f.calls(), 1);
    const result = (await f.database.query<{ status: string; error_code: string }>("SELECT status,error_code FROM ai_execution_jobs")).rows[0]!;
    assert.equal(result.status, "failed"); assert.equal(result.error_code, "UNAUTHENTICATED");
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts WHERE status='reserved'")).rows.length, 0);
  } finally { await f.database.close(); }
});

test("navigator rejects a revoked request session after generation while the account and project membership stay active", async () => {
  const f = await guardedFixture();
  try {
    // Only a nonsecret fixture digest enters SQL; no external/login credential is used.
    const digest = createHash("sha256").update("fixture-session-not-a-live-token").digest("hex");
    await f.database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES('navigator-session',$1,$2,$3::timestamptz,$3::timestamptz,$4::timestamptz)", [f.actor.userId, digest, f.clock.now().toISOString(), new Date(f.clock.now().getTime() + 60_000).toISOString()]);
    let checks = 0;
    const assertFreshSession = async (sql: SqlExecutor) => {
      checks++;
      const active = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [digest, f.actor.userId, f.clock.now().toISOString()]);
      if (!active.rows.length) throw new DomainError("UNAUTHENTICATED", "会话已结束。", { status: 401 });
    };
    f.setProvider(async () => { await f.database.query("UPDATE auth_sessions SET revoked_at=$1::timestamptz WHERE id='navigator-session'", [f.clock.now().toISOString()]); return f.output(); });
    await assert.rejects(f.navigator().reply(f.actor, { message: "帮我看当前项目", pagePath: "/app", projectId: f.project.id }, assertFreshSession), { code: "UNAUTHENTICATED" });
    assert.equal(checks, 2); assert.equal(f.calls(), 1);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [f.actor.userId])).rows[0]!.status, "active");
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM projects_project_membership WHERE project_id=$1 AND user_id=$2", [f.project.id, f.actor.userId])).rows[0]!.status, "active");
    assert.equal((await f.database.query<{ status: string; error_code: string }>("SELECT status,error_code FROM ai_execution_jobs")).rows[0]!.error_code, "UNAUTHENTICATED");
  } finally { await f.database.close(); }
});

test("navigator rejects an already expired session before a provider request and uses the configured smaller output cap", async () => {
  const f = await guardedFixture();
  try {
    const digest = createHash("sha256").update("fixture-expired-session").digest("hex");
    await f.database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES('expired-session',$1,$2,$3::timestamptz,$3::timestamptz,$4::timestamptz)", [f.actor.userId, digest, new Date(f.clock.now().getTime() - 2000).toISOString(), new Date(f.clock.now().getTime() - 1000).toISOString()]);
    const assertFreshSession = async (sql: SqlExecutor) => {
      const active = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [digest, f.actor.userId, f.clock.now().toISOString()]);
      if (!active.rows.length) throw new DomainError("UNAUTHENTICATED", "会话已结束。", { status: 401 });
    };
    await assert.rejects(f.navigator().reply(f.actor, { message: "帮我开始", pagePath: "/app" }, assertFreshSession), { code: "UNAUTHENTICATED" });
    assert.equal(f.calls(), 0); assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
    f.setProvider(async request => { assert.equal(request.maxOutputTokens, 300); return { ...f.output(), content: { reply: "先看介绍。", linkIds: ["start-here"] } }; });
    const limited = createNavigatorService({ database: f.database, projects: f.projects, clock: f.clock, ids: { next: randomUUID }, model: f.model, ledger: f.ledger, maxOutputTokens: 300 });
    assert.equal((await limited.reply(f.actor, { message: "网站怎么用", pagePath: "/" })).reply, "先看介绍。");
    assert.equal(f.calls(), 1);
  } finally { await f.database.close(); }
});
test("navigator withholds private project context after an actual M02 membership removal during model generation", async () => {
  const f = await guardedFixture();
  try {
    f.setProvider(async () => {
      const detail = await f.projects.getProject(f.owner, f.project.id);
      await f.projects.removeProjectMember(f.owner, f.project.id, f.actor.userId, detail.project.revision);
      return f.output();
    });
    await assert.rejects(f.navigator().reply(f.actor, { message: "我该做什么", pagePath: "/app", projectId: f.project.id }), { code: "PROJECT_UNAVAILABLE" });
    const stored = (await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!;
    assert.equal(stored.status, "failed"); assert.equal(f.calls(), 1);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM projects_project_membership WHERE project_id=$1 AND user_id=$2", [f.project.id, f.actor.userId])).rows[0]!.status, "removed");
  } finally { await f.database.close(); }
});
test("navigator completion CAS rejects a lease that expires after provider accounting and while final project facts are checked", async () => {
  const f = await guardedFixture();
  try {
    let reads = 0;
    const projectReader: Pick<ProjectsService, "getProject"> = { async getProject(actor, projectId) {
      const result = await f.projects.getProject(actor, projectId);
      if (++reads === 2) f.advance(180_001);
      return result;
    } };
    await assert.rejects(f.navigator(projectReader).reply(f.actor, { message: "帮我看下一步", pagePath: "/app", projectId: f.project.id }), { code: "AI_LEASE_LOST" });
    assert.equal(reads, 2); assert.equal(f.calls(), 1);
    const job = (await f.database.query<{ status: string; external_state: string }>("SELECT status,external_state FROM ai_execution_jobs")).rows[0]!;
    assert.equal(job.status, "unknown"); assert.equal(job.external_state, "unknown");
    const usage = (await f.database.query<{ charged_micro_usd: string | number; usage_verified: boolean }>("SELECT charged_micro_usd,usage_verified FROM ai_usage_attempts")).rows[0]!;
    assert.equal(usage.usage_verified, true); assert.equal(Number(usage.charged_micro_usd), 115);
  } finally { await f.database.close(); }
});
test("inline navigator failure settles outstanding reservations conservatively without reissuing the provider request", async () => {
  const f = await guardedFixture();
  try {
    // Simulate the safe cleanup boundary of a provider/worker interruption after reserve.
    const model: JsonModelPort = { modelVersion: "test-only-model", async completeJSON() {
      const active = (await f.database.query<{ id: string; lease_token: string; project_id: string; actor_id: string }>("SELECT id,lease_token,project_id,actor_id FROM ai_execution_jobs WHERE status='running'")).rows[0]!;
      await f.ledger.reserve({ id: "unfinished-inline-attempt", executionId: active.id, leaseToken: active.lease_token, projectId: active.project_id, actorId: active.actor_id, modelVersion: "test-only-model", promptVersion: "fixture-interruption", inputTokenUpperBound: 100, maxOutputTokens: 50, occurredAt: f.clock.now().toISOString() });
      throw new DomainError("MODEL_INTERRUPTED", "测试中断。", { status: 503 });
    } };
    const navigator = createNavigatorService({ database: f.database, projects: f.projects, clock: f.clock, ids: { next: randomUUID }, model, ledger: f.ledger });
    await assert.rejects(navigator.reply(f.actor, { message: "帮我开始", pagePath: "/app", projectId: f.project.id }), { code: "MODEL_INTERRUPTED" });
    const attempt = (await f.database.query<{ status: string; external_state: string; charged_micro_usd: string | number }>("SELECT status,external_state,charged_micro_usd FROM ai_usage_attempts")).rows[0]!;
    assert.equal(attempt.status, "settled"); assert.equal(attempt.external_state, "unknown"); assert.equal(Number(attempt.charged_micro_usd), 150);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "unknown");
    assert.equal(f.calls(), 0, "cleanup must not call the provider");
  } finally { await f.database.close(); }
});

test("DSH chat accepts its own long assistant reply in the next turn and sends only authorized project facts", async () => {
  const f = await guardedFixture();
  try {
    const longReply = "这是给新人的协作建议。".repeat(230);
    assert.ok(longReply.length > 2000 && longReply.length <= 6000);
    const history = [{ role: "user", content: "如何解决 Git 冲突？" }, { role: "assistant", content: longReply }];
    f.setProvider(async request => {
      assert.equal(request.promptVersion, "site-dsh-chat-v3-search");
      assert.deepEqual((request.input as { history: unknown }).history, history);
      assert.deepEqual((request.input as { project: unknown }).project, {
        name: f.project.name, stage: f.project.stage, goal: f.project.goal,
      });
      assert.match(request.systemPrompt, /技术调试/);
      return { ...f.output(), content: { reply: "先确认冲突文件，再请相关队友一起合并。", linkIds: [] } };
    });
    const result = await f.navigator().reply(f.actor, {
      message: "按刚才的方法给出第一步", pagePath: `/app/projects/${f.project.id}/rules`, projectId: f.project.id, history,
    });
    assert.equal(result.provider, "dsh");
    assert.deepEqual(result.links, []);
    assert.equal(f.calls(), 1);
  } finally { await f.database.close(); }
});

test("DSH chat bounds multibyte history by removing complete oldest messages and rejects oversized individual entries before generation", async () => {
  const f = await guardedFixture();
  try {
    const history = Array.from({ length: 10 }, (_, index) => ({ role: "assistant" as const, content: `${index}:` + "汉".repeat(5900) }));
    f.setProvider(async request => {
      const sent = (request.input as { history: typeof history }).history;
      assert.deepEqual(sent, history.slice(-1));
      assert.ok(sent.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0) <= 32_768);
      return { ...f.output(), content: { reply: "继续处理最近一条建议。", linkIds: [] } };
    });
    await f.navigator().reply(f.actor, { message: "继续", pagePath: "/events", history });
    for (const [role, content] of [["user", "x".repeat(2001)], ["assistant", "x".repeat(6001)]] as const) {
      await assert.rejects(f.navigator().reply(f.actor, { message: "继续", pagePath: "/events", history: [{ role, content }] }), { code: "INVALID_NAVIGATOR_INPUT" });
    }
    assert.equal(f.calls(), 1);
  } finally { await f.database.close(); }
});
