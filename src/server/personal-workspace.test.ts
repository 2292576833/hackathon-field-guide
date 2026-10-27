import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "./database.ts";
import { createPersonalWorkspace, personalRequestHash } from "./personal-workspace.ts";
import { AiProviderError, createBudgetedModel, type JsonModelPort } from "./ai.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import { DomainError } from "../shared/errors.ts";
import type { PersonalGenerationRequest } from "../shared/personal-ai.ts";
import type { SqlExecutor } from "../shared/persistence.ts";

async function fixture(dailyProjectCallLimit = 20) {
  // No live credentials, shared embedded database or external DSH request.
  const database = await createDatabase({});
  await database.migrate();
  let time = Date.parse("2026-10-10T08:00:00Z"), calls = 0;
  const clock = { now: () => new Date(time) };
  const alice = { userId: "personal-alice", platformRoles: ["user"] as const };
  const bob = { userId: "personal-bob", platformRoles: ["user"] as const };
  for (const actor of [alice, bob]) await database.query(
    "INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,'个人空间测试','Asia/Shanghai',$3,$3)",
    [actor.userId, `${actor.userId}@example.test`, clock.now().toISOString()],
  );
  const output = (): Awaited<ReturnType<JsonModelPort["completeJSON"]>> => ({
    content: { advice: "先完成可演示的核心流程。" }, usage: { inputTokens: 30, outputTokens: 12 }, requestId: null, modelVersion: "test-only-model",
  });
  let perform: JsonModelPort["completeJSON"] = async () => output();
  const raw: JsonModelPort = { modelVersion: "test-only-model", async completeJSON(request, signal) { calls++; return perform(request, signal); } };
  const ledger = new PostgresAiLedger(database, { dailyProjectCallLimit });
  const model = createBudgetedModel({ model: raw, ledger, maxAttempts: 1, clock: clock.now });
  const workspace = createPersonalWorkspace({ database, clock, ids: { next: randomUUID }, model, ledger });
  return { database, clock, alice, bob, workspace, output, setProvider(next: typeof perform) { perform = next; }, calls: () => calls,
    advance(milliseconds: number) { time += milliseconds; } };
}

function request(overrides: Partial<PersonalGenerationRequest<{ advice: string }>> = {}): PersonalGenerationRequest<{ advice: string }> {
  return { kind: "participation_plan", title: "我的参赛计划", input: { idea: "新人协作助手" }, systemPrompt: "提供具体、可执行的参赛建议。", promptVersion: "personal-test-v1",
    outputExample: { advice: "先完成核心流程。" }, validate(value) {
      if (value === null || typeof value !== "object" || typeof (value as { advice?: unknown }).advice !== "string")
        throw new DomainError("AI_RESPONSE_INVALID", "生成内容没有符合计划格式。", { status: 503 });
      return { advice: (value as { advice: string }).advice };
    }, ...overrides };
}

test("personal DSH session is durable per verified account and different accounts receive different sessions", async () => {
  const f = await fixture();
  try {
    const first = await f.workspace.session(f.alice);
    f.advance(1000);
    const again = await f.workspace.session(f.alice);
    const other = await f.workspace.session(f.bob);
    assert.equal(first.id, again.id); assert.equal(first.createdAt, again.createdAt);
    assert.notEqual(first.id, other.id); assert.equal(first.provider, "dsh");
    assert.equal((await f.database.query("SELECT id FROM personal_dsh_sessions")).rowCount, 2);
    await assert.rejects(f.workspace.session({ ...f.alice, userId: "missing" }), { code: "UNAUTHENTICATED" });
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [f.bob.userId]);
    await assert.rejects(f.workspace.session(f.bob), { code: "UNAUTHENTICATED" });
  } finally { await f.database.close(); }
});

test("history and generated artifacts remain private and clearing one chat keeps artifacts and other conversations", async () => {
  const f = await fixture();
  try {
    await f.database.transaction(async sql => {
      await f.workspace.append(sql, f.alice, undefined, "Alice 的个人想法", "Alice 的私人建议");
      await f.workspace.append(sql, f.alice, "project-fixture", "Alice 的队伍讨论", "队伍建议");
      await f.workspace.append(sql, f.bob, undefined, "Bob 的个人想法", "Bob 的私人建议");
    });
    const saved = await f.workspace.generate(f.alice, request());
    assert.equal(saved.sessionId, (await f.workspace.session(f.alice)).id);
    assert.deepEqual((await f.workspace.conversation(f.alice)).messages.map(message => message.content), ["Alice 的个人想法", "Alice 的私人建议"]);
    assert.deepEqual((await f.workspace.conversation(f.bob)).messages.map(message => message.content), ["Bob 的个人想法", "Bob 的私人建议"]);
    assert.equal((await f.workspace.list(f.bob, "participation_plan")).length, 0);
    await assert.rejects(f.workspace.get(f.bob, saved.id), { code: "ARTIFACT_NOT_FOUND" });
    await f.workspace.clearConversation(f.alice);
    assert.deepEqual((await f.workspace.conversation(f.alice)).messages, []);
    assert.equal((await f.workspace.conversation(f.alice, "project-fixture")).messages.length, 2);
    assert.equal((await f.workspace.conversation(f.bob)).messages.length, 2);
    assert.equal((await f.workspace.get(f.alice, saved.id)).id, saved.id);
  } finally { await f.database.close(); }
});

test("one account cannot start parallel generation or clear an active session, while another account can generate", async () => {
  const f = await fixture();
  let release!: () => void, begun!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { begun = resolve; });
  f.setProvider(async () => { if (f.calls() === 1) { begun(); await waiting; } return f.output(); });
  const first = f.workspace.generate(f.alice, request());
  try {
    await started;
    assert.equal((await f.workspace.session(f.alice)).busy, true);
    await assert.rejects(f.workspace.generate(f.alice, request({ kind: "roadshow" })), { code: "DSH_SESSION_BUSY" });
    await assert.rejects(f.workspace.clearConversation(f.alice), { code: "DSH_SESSION_BUSY" });
    assert.equal((await f.workspace.generate(f.bob, request())).provider, "dsh");
    assert.equal(f.calls(), 2);
    release(); await first;
    assert.equal((await f.workspace.session(f.alice)).busy, false);
  } finally { release(); await first.catch(() => {}); await f.database.close(); }
});

test("suspension during generation rejects generated output without persisting an artifact", async () => {
  const f = await fixture();
  try {
    f.setProvider(async () => { await f.database.query("UPDATE auth_users SET status='suspended',revision=revision+1 WHERE id=$1", [f.alice.userId]); return f.output(); });
    await assert.rejects(f.workspace.generate(f.alice, request()), { code: "UNAUTHENTICATED" });
    assert.equal(f.calls(), 1);
    assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount, 0);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "failed");
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts WHERE status='reserved'")).rowCount, 0);
    assert.equal((await f.database.query<{ active_job_id: string | null }>("SELECT active_job_id FROM personal_dsh_sessions WHERE user_id=$1", [f.alice.userId])).rows[0]!.active_job_id, null);
  } finally { await f.database.close(); }
});

test("revoking the website login during DSH execution rejects output even while the account stays active", async () => {
  const f = await fixture();
  try {
    const digest = createHash("sha256").update("test-fixture-session-only").digest("hex");
    await f.database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES('personal-auth-session',$1,$2,$3::timestamptz,$3::timestamptz,$4::timestamptz)",
      [f.alice.userId, digest, f.clock.now().toISOString(), new Date(f.clock.now().getTime()+60_000).toISOString()]);
    let checks = 0;
    const guard = async (sql: SqlExecutor) => {
      checks++;
      const active = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [digest, f.alice.userId, f.clock.now().toISOString()]);
      if (!active.rowCount) throw new DomainError("UNAUTHENTICATED", "登录已经结束。", { status: 401 });
    };
    f.setProvider(async () => { await f.database.query("UPDATE auth_sessions SET revoked_at=$1::timestamptz WHERE id='personal-auth-session'", [f.clock.now().toISOString()]); return f.output(); });
    await assert.rejects(f.workspace.generate(f.alice, request(), guard), { code: "UNAUTHENTICATED" });
    assert.equal(checks, 2); assert.equal(f.calls(), 1);
    assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount, 0);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [f.alice.userId])).rows[0]!.status, "active");
  } finally { await f.database.close(); }
});

test("unknown provider completion cannot be replayed for the same account and input, but does not block another account", async () => {
  const f = await fixture();
  try {
    f.setProvider(async () => { throw new AiProviderError("AI_TIMEOUT_UNCERTAIN", "unknown"); });
    await assert.rejects(f.workspace.generate(f.alice, request()), { code: "AI_TIMEOUT_UNCERTAIN" });
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "unknown");
    f.setProvider(async () => f.output());
    await assert.rejects(f.workspace.generate(f.alice, request({ title: "换标题仍是同一个请求" })), { code: "AI_PREVIOUS_REQUEST_UNKNOWN" });
    assert.equal(f.calls(), 1);
    assert.equal((await f.workspace.session(f.alice)).busy, false);
    assert.equal((await f.workspace.generate(f.bob, request())).provider, "dsh");
    assert.equal((await f.workspace.generate(f.alice, request({ input: { idea: "明确新请求" } }))).provider, "dsh");
    assert.equal(f.calls(), 3);
  } finally { await f.database.close(); }
});

test("invalid or oversized model output is never persisted and does not leave the DSH session busy", async () => {
  const f = await fixture();
  try {
    f.setProvider(async () => ({ ...f.output(), content: { wrong: "missing advice" } }));
    await assert.rejects(f.workspace.generate(f.alice, request()), { code: "AI_RESPONSE_INVALID" });
    assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount, 0);
    assert.equal((await f.workspace.session(f.alice)).busy, false);
    f.setProvider(async () => ({ ...f.output(), content: { advice: "x".repeat(100001) } }));
    await assert.rejects(f.workspace.generate(f.alice, request()), { code: "AI_RESPONSE_INVALID" });
    assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount, 0);
    assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs WHERE status='failed'")).rowCount, 2);
    assert.equal((await f.workspace.session(f.alice)).busy, false);
  } finally { await f.database.close(); }
});

test("an unknown semantic request remains blocked after refreshed context, key reordering, prompt upgrades and a new day", async () => {
  const f = await fixture();
  const first = request({ requestIdentity: { eventId: "event-1", profileRevision: 2, idea: "原型" }, input: { currentTime: "first read", weather: { fetchedAt: "first" } } });
  try {
    f.setProvider(async () => { throw new AiProviderError("AI_TIMEOUT_UNCERTAIN", "unknown"); });
    await assert.rejects(f.workspace.generate(f.alice, first), { code: "AI_TIMEOUT_UNCERTAIN" });
    f.advance(86_400_000);
    f.setProvider(async () => f.output());
    await assert.rejects(f.workspace.generate(f.alice, request({
      promptVersion: "personal-test-v2", requestIdentity: { idea: "原型", profileRevision: 2, eventId: "event-1" },
      input: { currentTime: "new read", weather: { fetchedAt: "refreshed" } },
    })), { code: "AI_PREVIOUS_REQUEST_UNKNOWN" });
    assert.equal(f.calls(), 1);
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts WHERE external_state='unknown'")).rowCount, 1);
    await f.workspace.generate(f.alice, request({ requestIdentity: { eventId: "event-1", profileRevision: 3, idea: "原型" } }));
    assert.equal(f.calls(), 2);
  } finally { await f.database.close(); }
});

test("artifact kind and identifier validation reject unsupported input before storage or model dispatch", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workspace.list(f.alice, "other" as "ppt"), { code: "INVALID_ARTIFACT_KIND" });
    for (const id of ["", "../../someone-else", "a".repeat(201)]) await assert.rejects(f.workspace.get(f.alice, id), { code: "INVALID_ARTIFACT_ID" });
    await assert.rejects(f.workspace.generate(f.alice, request({ kind: "other" as "ppt" })), { code: "INVALID_ARTIFACT_INPUT" });
    await assert.rejects(f.workspace.generate(f.alice, request({ title: " " })), { code: "INVALID_ARTIFACT_INPUT" });
    assert.equal(f.calls(), 0);
    assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("plan, roadshow and PPT requests share the account DSH budget namespace while other accounts retain their own budget", async () => {
  const f = await fixture(2);
  try {
    await f.workspace.generate(f.alice, request());
    await f.workspace.generate(f.alice, request({ kind: "roadshow" }));
    await assert.rejects(f.workspace.generate(f.alice, request({ kind: "ppt" })), { code: "AI_BUDGET_EXCEEDED" });
    await f.workspace.generate(f.bob, request({ kind: "ppt" }));
    assert.equal(f.calls(), 3);
    const buckets = await f.database.query<{ project_id: string; calls: number }>("SELECT project_id,calls FROM ai_budget_buckets ORDER BY project_id");
    assert.deepEqual(buckets.rows.map(row => [row.project_id, Number(row.calls)]), [[`navigator-user:${f.alice.userId}`, 2], [`navigator-user:${f.bob.userId}`, 1]]);
    assert.equal((await f.workspace.session(f.alice)).busy, false);
  } finally { await f.database.close(); }
});

test("a result arriving after the account execution lease expires is retained as unknown and cannot be regenerated automatically", async () => {
  const f = await fixture();
  try {
    f.setProvider(async () => { f.advance(180001); return f.output(); });
    await assert.rejects(f.workspace.generate(f.alice, request()), { code: "AI_LEASE_LOST" });
    assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount, 0);
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "unknown");
    await assert.rejects(f.workspace.generate(f.alice, request()), { code: "AI_PREVIOUS_REQUEST_UNKNOWN" });
    assert.equal(f.calls(), 1);
    assert.equal((await f.workspace.session(f.alice)).busy, false);
  } finally { await f.database.close(); }
});

test("reading a crashed DSH session reclaims only its expired UI lock, preserving the unknown request and reserved charges", async () => {
  const f = await fixture();
  try {
    const executionId = randomUUID(), leaseToken = randomUUID(), projectId = `navigator-user:${f.alice.userId}`;
    const attempted = request();
    const hash = personalRequestHash(attempted);
    await f.database.transaction(async sql => {
      await f.workspace.claim(sql, f.alice, executionId);
      await sql.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,created_at,updated_at) VALUES($1,'personal_artifact',$1,1,$2,$3,'running',1,'crashed-fixture',$4,$5::timestamptz,$6::timestamptz,$6::timestamptz)",
        [executionId, projectId, f.alice.userId, leaseToken, new Date(f.clock.now().getTime()+60_000).toISOString(), f.clock.now().toISOString()]);
      await sql.query("INSERT INTO personal_ai_requests(execution_id,user_id,request_hash,created_at) VALUES($1,$2,$3,$4::timestamptz)", [executionId, f.alice.userId, hash, f.clock.now().toISOString()]);
      await f.workspace.append(sql, f.alice, undefined, "崩溃之前的对话", "已保存的回答");
    });
    const pricedLedger = new PostgresAiLedger(f.database, { dailyProjectCallLimit: 20, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000 });
    await pricedLedger.reserve({ id: "crashed-reservation", executionId, leaseToken, projectId, actorId: f.alice.userId, modelVersion: "test-only-model", promptVersion: attempted.promptVersion,
      inputTokenUpperBound: 100, maxOutputTokens: 50, occurredAt: f.clock.now().toISOString() });
    assert.equal((await f.workspace.session(f.alice)).busy, true);
    f.advance(60_001);
    assert.equal((await f.workspace.session(f.alice)).busy, false);
    assert.equal((await f.workspace.conversation(f.alice)).session.busy, false);
    assert.deepEqual(await f.workspace.clearConversation(f.alice), { cleared: true });
    const job = (await f.database.query<{ status: string; external_state: string }>("SELECT status,external_state FROM ai_execution_jobs WHERE id=$1", [executionId])).rows[0]!;
    assert.deepEqual(job, { status: "unknown", external_state: "unknown" });
    const usage = (await f.database.query<{ status: string; reserved_micro_usd: string | number }>("SELECT status,reserved_micro_usd FROM ai_usage_attempts WHERE id='crashed-reservation'")).rows[0]!;
    assert.equal(usage.status, "reserved"); assert.equal(Number(usage.reserved_micro_usd), 150);
    const budget = (await f.database.query<{ calls: number; reserved_micro_usd: string | number; charged_micro_usd: string | number }>("SELECT calls,reserved_micro_usd,charged_micro_usd FROM ai_budget_buckets WHERE project_id=$1", [projectId])).rows[0]!;
    assert.equal(Number(budget.calls), 1); assert.equal(Number(budget.reserved_micro_usd), 150); assert.equal(Number(budget.charged_micro_usd), 0);
    await assert.rejects(f.workspace.generate(f.alice, attempted), { code: "AI_PREVIOUS_REQUEST_UNKNOWN" });
    assert.equal(f.calls(), 0);
  } finally { await f.database.close(); }
});
