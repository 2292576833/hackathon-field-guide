import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createDatabase } from "./database.ts";
import { createBudgetedModel, createOpenAICompatibleModel, type AiExecutionContext } from "./ai.ts";
import { AI_SCHEMA_SQL, PostgresAiLedger, createAiWorker, createStandardAiHandlers, type AiBudgetPolicy, type AiModuleHandler } from "./ai-jobs.ts";

async function serverFixture(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
function success(response: ServerResponse, includeUsage = true) {
  response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "fixture-response", model: "test-model", choices: [{ finish_reason: "stop", message: { content: '{"draft":"供人工检查"}' } }], ...(includeUsage ? { usage: { prompt_tokens: 12, completion_tokens: 8 } } : {}) }));
}
const prices: AiBudgetPolicy = { dailyProjectCallLimit: 10, dailyProjectBudgetMicroUsd: 1_000_000, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 };
async function fixture(options: { baseUrl: string; policy?: AiBudgetPolicy; timeoutMs?: number; maxAttempts?: number; clock?: () => Date; leaseMs?: number; modelAssertActor?: (context: AiExecutionContext) => Promise<void> }) {
  const database = await createDatabase({});
  // Isolated real PGlite schema. Domain jobs below are explicitly test fixtures,
  // not a substitute for the production module services and their authorization.
  for (const statement of AI_SCHEMA_SQL.split(";").filter(item => item.trim())) await database.query(statement);
  await database.query("CREATE TABLE fixture_ai_jobs(id text PRIMARY KEY,project_id text,actor_id text,revision integer,status text,created_at timestamptz,result jsonb,error_code text)");
  await database.query("INSERT INTO fixture_ai_jobs VALUES('fixture-job','fixture-project','fixture-actor',1,'queued',now(),NULL,NULL)");
  const ledger = new PostgresAiLedger(database, options.policy ?? prices);
  const transport = createOpenAICompatibleModel({ baseUrl: options.baseUrl, apiKey: "unit-test-only-key", model: "test-model", allowInsecureLoopback: true, maxOutputTokens: 100, timeoutMs: options.timeoutMs ?? 1000 });
  const model = createBudgetedModel({ model: transport, ledger, maxOutputTokens: 100, maxAttempts: options.maxAttempts ?? 2, clock: options.clock, assertActor: options.modelAssertActor });
  const list = async (status: string) => (await database.query<{ id: string; project_id: string; actor_id: string; revision: number; status: string; created_at: Date }>("SELECT * FROM fixture_ai_jobs WHERE status=$1", [status])).rows.map(row => ({ id: row.id, projectId: row.project_id, actorId: row.actor_id, revision: row.revision, status: row.status, createdAt: new Date(row.created_at).toISOString() }));
  const handler: AiModuleHandler = {
    kind: "fixture_module", listQueued: () => list("queued"), listRunning: () => list("running"),
    async execute(id) {
      const claimed = await database.query("UPDATE fixture_ai_jobs SET status='running',revision=revision+1 WHERE id=$1 AND status='queued' RETURNING id", [id]);
      if (!claimed.rowCount) return { status: (await database.query<{ status: string }>("SELECT status FROM fixture_ai_jobs WHERE id=$1", [id])).rows[0]!.status };
      try {
        const output = await model.completeJSON({ systemPrompt: "仅整理给定资料。", input: { privateAnswer: "PRIVATE_TEST_ANSWER_NEVER_IN_LEDGER" }, promptVersion: "fixture-v1", outputExample: { draft: "无法确认" } }, new AbortController().signal);
        await database.query("UPDATE fixture_ai_jobs SET status='succeeded',result=$2::jsonb WHERE id=$1", [id, JSON.stringify(output.content)]);
        return { status: "succeeded" };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "MODEL_FAILED";
        await database.query("UPDATE fixture_ai_jobs SET status='failed',error_code=$2 WHERE id=$1", [id, code]);
        return { status: "failed", errorCode: code };
      }
    },
    async recover(id) { return { status: (await database.query<{ status: string }>("SELECT status FROM fixture_ai_jobs WHERE id=$1", [id])).rows[0]!.status }; },
  };
  const makeWorker = () => createAiWorker({ database, ledger, handlers: [handler], clock: options.clock, leaseMs: options.leaseMs });
  return { database, ledger, model, handler, makeWorker };
}
test("two real database workers claim once, settle actual usage and never persist original input in the ledger", async () => {
  let calls = 0;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl });
  try {
    const result = await Promise.all([f.makeWorker().runOnce(), f.makeWorker().runOnce()]);
    assert.equal(calls, 1); assert.equal(result.filter(item => item.processed).length, 1);
    const attempts = (await f.database.query("SELECT * FROM ai_usage_attempts")).rows;
    assert.equal(attempts.length, 1); assert.equal(attempts[0]!.status, "settled"); assert.equal(attempts[0]!.usage_verified, true);
    assert.equal(Number(attempts[0]!.charged_micro_usd), 28);
    assert.doesNotMatch(JSON.stringify(attempts), /PRIVATE_TEST_ANSWER|unit-test-only-key|供人工检查/);
    const buckets = (await f.database.query("SELECT * FROM ai_budget_buckets")).rows;
    assert.equal(buckets[0]!.calls, 1); assert.equal(Number(buckets[0]!.reserved_micro_usd), 0); assert.equal(Number(buckets[0]!.charged_micro_usd), 28);
    assert.equal((await f.makeWorker().runOnce()).processed, false, "a completed domain job is not replayed");
  } finally { await f.database.close(); await server.close(); }
});
test("explicit 429 retries reserve each request and preserve rejection plus success accounting", async () => {
  let calls = 0;
  const server = await serverFixture((_request, response) => { calls++; if (calls === 1) { response.statusCode = 429; response.setHeader("retry-after", "0"); response.end(); } else success(response); });
  const f = await fixture({ baseUrl: server.baseUrl });
  try {
    assert.equal((await f.makeWorker().runOnce()).status, "succeeded"); assert.equal(calls, 2);
    const attempts = (await f.database.query<{ external_state: string; charged_micro_usd: number | string }>("SELECT external_state,charged_micro_usd FROM ai_usage_attempts ORDER BY created_at,id")).rows;
    assert.deepEqual(attempts.map(row => row.external_state), ["rejected", "response_received"]); assert.deepEqual(attempts.map(row => Number(row.charged_micro_usd)), [0, 28]);
    assert.equal((await f.database.query<{ calls: number }>("SELECT calls FROM ai_budget_buckets")).rows[0]!.calls, 2);
  } finally { await f.database.close(); await server.close(); }
});
test("daily call cap stops a safe retry before the next HTTP request", async () => {
  let calls = 0;
  const server = await serverFixture((_request, response) => { calls++; response.statusCode = 429; response.setHeader("retry-after", "0"); response.end(); });
  const f = await fixture({ baseUrl: server.baseUrl, policy: { ...prices, dailyProjectCallLimit: 1 } });
  try {
    const result = await f.makeWorker().runOnce(); assert.equal(result.status, "failed"); assert.equal(result.errorCode, "AI_BUDGET_EXCEEDED"); assert.equal(calls, 1);
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts")).rows.length, 1);
    await assert.rejects(f.ledger.generationBudget().reserve({ jobId: "admission", projectId: "fixture-project", actorId: "fixture-actor", occurredAt: new Date().toISOString() }), error => typeof error === "object" && error !== null && "code" in error && error.code === "AI_BUDGET_EXCEEDED");
  } finally { await f.database.close(); await server.close(); }
});
test("server error or timeout is unknown, retains conservative charge and is never automatically retried", async () => {
  for (const scenario of ["server_error", "timeout"] as const) {
    let calls = 0;
    const server = await serverFixture((_request, response) => { calls++; if (scenario === "server_error") { response.statusCode = 503; response.end(); } });
    const f = await fixture({ baseUrl: server.baseUrl, timeoutMs: 50, maxAttempts: 3 });
    try {
      const result = await f.makeWorker().runOnce(); assert.equal(result.status, "unknown"); assert.equal(calls, 1);
      const attempt = (await f.database.query<{ charged_micro_usd: number | string; reserved_micro_usd: number | string; external_state: string; usage_verified: boolean }>("SELECT * FROM ai_usage_attempts")).rows[0]!;
      assert.equal(attempt.external_state, "unknown"); assert.equal(attempt.usage_verified, false); assert.ok(Number(attempt.charged_micro_usd) > 0); assert.equal(Number(attempt.charged_micro_usd), Number(attempt.reserved_micro_usd));
      assert.equal((await f.makeWorker().runOnce()).processed, false);
    } finally { await f.database.close(); await server.close(); }
  }
});
test("unconfigured pricing remains null, while an amount budget without rates is rejected", async () => {
  const server = await serverFixture((_request, response) => success(response, false));
  const f = await fixture({ baseUrl: server.baseUrl, policy: { dailyProjectCallLimit: 2 } });
  try {
    assert.throws(() => new PostgresAiLedger(f.database, { dailyProjectCallLimit: 2, dailyProjectBudgetMicroUsd: 10_000 }));
    assert.equal((await f.makeWorker().runOnce()).status, "succeeded");
    const attempt = (await f.database.query("SELECT * FROM ai_usage_attempts")).rows[0]!;
    assert.equal(attempt.cost_configured, false); assert.equal(attempt.reserved_micro_usd, null); assert.equal(attempt.charged_micro_usd, null); assert.equal(attempt.usage_verified, false);
  } finally { await f.database.close(); await server.close(); }
});
test("amount cap rejects a request before dispatch rather than undercharging missing or reserved cost", async () => {
  let calls = 0;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl, policy: { ...prices, dailyProjectBudgetMicroUsd: 1 } });
  try {
    const result = await f.makeWorker().runOnce(); assert.equal(result.status, "failed"); assert.equal(result.errorCode, "AI_BUDGET_EXCEEDED");
    assert.equal(calls, 0); assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts")).rows.length, 0);
  } finally { await f.database.close(); await server.close(); }
});
test("standard five-module registrations discover metadata and skip already registered revisions without exposing private bodies", async () => {
  const database = await createDatabase({});
  try {
    for (const statement of AI_SCHEMA_SQL.split(";").filter(item => item.trim())) await database.query(statement);
    // Minimal queue projection fixtures deliberately isolate root SQL wiring;
    // actual domain schemas, services and final write guards are tested by their modules.
    await database.query("CREATE TABLE m03_analysis_runs(id text,revision integer,body jsonb)");
    await database.query("CREATE TABLE assessments_scoring_jobs(id text,project_id text,user_id text,revision integer,created_at timestamptz,status text)");
    await database.query("CREATE TABLE m07_documents(id text,project_id text,owner_id text,revision integer,created_at timestamptz,body jsonb,kind text)");
    await database.query("CREATE TABLE assessments_assignment_jobs(id text,project_id text,user_id text,revision integer,created_at timestamptz,status text)");
    await database.query("CREATE TABLE planning_generation_jobs(id text,project_id text,actor_id text,revision integer,created_at timestamptz,status text)");
    const at = new Date().toISOString();
    await database.query("INSERT INTO m03_analysis_runs VALUES('events',1,$1::jsonb)", [JSON.stringify({ projectId: "project", actorId: "actor", queuedAt: at, status: "queued", privateText: "DO_NOT_PROJECT_PRIVATE_BODY" })]);
    await database.query("INSERT INTO assessments_scoring_jobs VALUES('scoring','project','actor',1,$1::timestamptz,'queued')", [at]);
    await database.query("INSERT INTO m07_documents VALUES('retro','project','actor',1,$1::timestamptz,$2::jsonb,'generation_job')", [at, JSON.stringify({ status: "queued", privateText: "DO_NOT_PROJECT_PRIVATE_BODY" })]);
    await database.query("INSERT INTO assessments_assignment_jobs VALUES('assignments','project','actor',1,$1::timestamptz,'queued')", [at]);
    await database.query("INSERT INTO planning_generation_jobs VALUES('planning','project','actor',1,$1::timestamptz,'queued')", [at]);
    const completed = async () => ({ status: "succeeded" as const });
    const handlers = createStandardAiHandlers({ database,
      events: { processAnalysisRun: completed, recoverExpiredAnalysisRun: completed } as unknown as Parameters<typeof createStandardAiHandlers>[0]["events"],
      assessments: { processScoringJob: completed, recoverExpiredScoringJob: completed } as unknown as Parameters<typeof createStandardAiHandlers>[0]["assessments"],
      retrospectives: { runGeneration: completed, recoverExpiredGeneration: completed } as unknown as Parameters<typeof createStandardAiHandlers>[0]["retrospectives"],
      assignments: { execute: completed, recover: completed } as unknown as NonNullable<Parameters<typeof createStandardAiHandlers>[0]["assignments"]>,
      planningGeneration: { processGenerationJob: completed, recoverExpiredGenerationJob: completed } as unknown as NonNullable<Parameters<typeof createStandardAiHandlers>[0]["planningGeneration"]>,
    });
    assert.equal(handlers.length, 5);
    for (const handler of handlers) {
      const metadata = await handler.listQueued(20);
      assert.equal(metadata.length, 1); assert.equal(metadata[0]!.projectId, "project"); assert.equal(metadata[0]!.actorId, "actor");
      assert.doesNotMatch(JSON.stringify(metadata), /DO_NOT_PROJECT_PRIVATE_BODY/);
    }
    const worker = createAiWorker({ database, ledger: new PostgresAiLedger(database, prices), handlers });
    assert.equal(await worker.discover(), 5); assert.equal(await worker.discover(), 0);
    for (const handler of handlers) assert.equal((await handler.listQueued(20)).length, 0, "registered/stuck domain rows cannot starve a later queue batch");
  } finally { await database.close(); }
});
test("expired lease fences a late model response and conservatively closes an outstanding reservation", async () => {
  let currentTime = Date.now(), arrived!: () => void, release!: () => void;
  const arrivedPromise = new Promise<void>(resolve => { arrived = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const server = await serverFixture((_request, response) => { arrived(); void releasePromise.then(() => success(response)); });
  const f = await fixture({ baseUrl: server.baseUrl, clock: () => new Date(currentTime), leaseMs: 1000, timeoutMs: 5000 });
  try {
    const execution = f.makeWorker().runOnce();
    await arrivedPromise; currentTime += 2000;
    assert.equal(await f.makeWorker().recoverExpired(), 1);
    release();
    const result = await execution; assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "AI_LEASE_LOST");
    const domain = (await f.database.query<{ result: unknown; error_code: string }>("SELECT result,error_code FROM fixture_ai_jobs")).rows[0]!;
    assert.equal(domain.result, null); assert.equal(domain.error_code, "AI_LEASE_LOST");
    const stored = (await f.database.query<{ status: string; external_state: string }>("SELECT status,external_state FROM ai_execution_jobs")).rows[0]!;
    assert.equal(stored.status, "unknown"); assert.equal(stored.external_state, "unknown");
    assert.equal((await f.database.query<{ count: string }>("SELECT count(*) AS count FROM ai_usage_attempts WHERE status='reserved'")).rows[0]!.count, 0);
    const reconciled = (await f.database.query<{ charged_micro_usd: number | string; usage_verified: boolean }>("SELECT charged_micro_usd,usage_verified FROM ai_usage_attempts")).rows[0]!;
    assert.equal(reconciled.usage_verified, true, "a late response can refine actual cost while its content stays fenced");
    assert.equal(Number(reconciled.charged_micro_usd), 28);
  } finally { release(); await f.database.close(); await server.close(); }
});

test("periodic recovery settles a terminal inline execution's orphan reservation once without replaying HTTP", async () => {
  let calls = 0;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl });
  try {
    const at = new Date().toISOString();
    await f.database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,created_at,updated_at) VALUES('inline-orphan','navigator','inline-orphan',1,'fixture-project','fixture-actor','running',1,'inline','orphan-lease',$1::timestamptz,$2::timestamptz,$2::timestamptz)", [new Date(Date.parse(at) + 60_000).toISOString(), at]);
    await f.ledger.reserve({ id: "orphan-attempt", executionId: "inline-orphan", leaseToken: "orphan-lease", projectId: "fixture-project", actorId: "fixture-actor", modelVersion: "test-model", promptVersion: "orphan-fixture", inputTokenUpperBound: 100, maxOutputTokens: 50, occurredAt: at });
    // Simulate process interruption after execution status committed but before accounting closed.
    await f.database.query("UPDATE ai_execution_jobs SET status='unknown',external_state='unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE id='inline-orphan'");
    await f.makeWorker().recoverExpired(); await f.makeWorker().recoverExpired();
    const attempt = (await f.database.query<{ status: string; usage_verified: boolean; charged_micro_usd: number | string }>("SELECT status,usage_verified,charged_micro_usd FROM ai_usage_attempts WHERE id='orphan-attempt'")).rows[0]!;
    assert.equal(attempt.status, "settled"); assert.equal(attempt.usage_verified, false); assert.equal(Number(attempt.charged_micro_usd), 200);
    const bucket = (await f.database.query<{ calls: number; reserved_micro_usd: number | string; charged_micro_usd: number | string }>("SELECT calls,reserved_micro_usd,charged_micro_usd FROM ai_budget_buckets")).rows[0]!;
    assert.equal(bucket.calls, 1); assert.equal(Number(bucket.reserved_micro_usd), 0); assert.equal(Number(bucket.charged_micro_usd), 200);
    assert.equal(calls, 0, "accounting recovery cannot replay a provider request");
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs WHERE id='inline-orphan'")).rows[0]!.status, "unknown");
  } finally { await f.database.close(); await server.close(); }
});

test("worker completion cannot claim success when module finalization crosses the central lease after model accounting", async () => {
  let currentTime = Date.now(), calls = 0;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl, clock: () => new Date(currentTime), leaseMs: 1000 });
  try {
    // The provider returns inside its lease; then local finalization/lock waiting
    // outlives the coordinator lease before its final CAS. No HTTP retry occurs.
    const handler: AiModuleHandler = { ...f.handler, async execute(id) {
      const result = await f.handler.execute(id); currentTime += 2000; return result;
    } };
    const worker = createAiWorker({ database: f.database, ledger: f.ledger, handlers: [handler], clock: () => new Date(currentTime), leaseMs: 1000 });
    const result = await worker.runOnce();
    assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "AI_LEASE_LOST"); assert.equal(calls, 1);
    assert.notEqual((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "succeeded");
    await worker.recoverExpired();
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "unknown");
    const usage = (await f.database.query<{ usage_verified: boolean; charged_micro_usd: number | string }>("SELECT usage_verified,charged_micro_usd FROM ai_usage_attempts")).rows[0]!;
    assert.equal(usage.usage_verified, true); assert.equal(Number(usage.charged_micro_usd), 28);
    assert.equal((await worker.runOnce()).processed, false); assert.equal(calls, 1);
  } finally { await f.database.close(); await server.close(); }
});

async function actorPolicy(database: Awaited<ReturnType<typeof createDatabase>>, active = true) {
  // An application-owned account policy fixture keeps the generic execution
  // coordinator independent of production auth table names and schema details.
  await database.query("CREATE TABLE fixture_actor_policy(id text PRIMARY KEY,active boolean NOT NULL)");
  await database.query("INSERT INTO fixture_actor_policy VALUES('fixture-actor',$1)", [active]);
  return async (actorId: string) => {
    const result = await database.query("SELECT id FROM fixture_actor_policy WHERE id=$1 AND active", [actorId]);
    if (!result.rows.length) throw new Error("PRIVATE_ACCOUNT_ERROR_MUST_NOT_BE_RETAINED");
  };
}

test("a suspended queued actor cannot execute the module, reserve usage or dispatch a provider request", async () => {
  let calls = 0, executions = 0;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl });
  try {
    const assertActor = await actorPolicy(f.database, false);
    const handler: AiModuleHandler = { ...f.handler, async execute(id) { executions++; return f.handler.execute(id); } };
    const worker = createAiWorker({ database: f.database, ledger: f.ledger, handlers: [handler], assertActor });
    const result = await worker.runOnce();
    assert.equal(result.status, "failed"); assert.equal(result.errorCode, "AI_ACTOR_UNAVAILABLE");
    assert.equal(executions, 0); assert.equal(calls, 0);
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts")).rows.length, 0);
    const stored = (await f.database.query("SELECT status,error_code,external_state FROM ai_execution_jobs")).rows[0]!;
    assert.equal(stored.status, "failed"); assert.equal(stored.external_state, "not_sent");
    assert.doesNotMatch(JSON.stringify(stored), /PRIVATE_ACCOUNT_ERROR/);
    assert.equal((await worker.runOnce()).processed, false, "rejected coordinator jobs cannot replay the same queued domain revision");
  } finally { await f.database.close(); await server.close(); }
});

test("the budgeted model independently denies an inactive actor before making a reservation", async () => {
  let calls = 0, assertActor!: (actorId: string) => Promise<void>;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl, modelAssertActor: context => assertActor(context.actorId) });
  try {
    assertActor = await actorPolicy(f.database, false);
    const result = await f.makeWorker().runOnce();
    assert.equal(result.status, "failed"); assert.equal(result.errorCode, "AI_ACTOR_UNAVAILABLE");
    assert.equal(calls, 0); assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts")).rows.length, 0);
    assert.equal((await f.database.query<{ result: unknown }>("SELECT result FROM fixture_ai_jobs")).rows[0]!.result, null);
  } finally { await f.database.close(); await server.close(); }
});

test("actor revocation during an HTTP request fences its draft, keeps actual cost and closes the coordinator as unknown", async () => {
  let calls = 0, assertActor!: (actorId: string) => Promise<void>, arrived!: () => void, release!: () => void;
  const arrivedPromise = new Promise<void>(resolve => { arrived = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const server = await serverFixture((_request, response) => { calls++; arrived(); void releasePromise.then(() => success(response)); });
  const f = await fixture({ baseUrl: server.baseUrl, timeoutMs: 5000, modelAssertActor: context => assertActor(context.actorId) });
  try {
    assertActor = await actorPolicy(f.database);
    const worker = createAiWorker({ database: f.database, ledger: f.ledger, handlers: [f.handler], assertActor });
    const pending = worker.runOnce();
    await arrivedPromise;
    await f.database.query("UPDATE fixture_actor_policy SET active=false WHERE id='fixture-actor'");
    release();
    const result = await pending;
    assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "AI_ACTOR_REVOKED"); assert.equal(calls, 1);
    const domain = (await f.database.query("SELECT status,result,error_code FROM fixture_ai_jobs")).rows[0]!;
    assert.equal(domain.status, "failed"); assert.equal(domain.result, null); assert.equal(domain.error_code, "AI_ACTOR_REVOKED");
    const attempt = (await f.database.query("SELECT * FROM ai_usage_attempts")).rows[0]!;
    assert.equal(attempt.status, "settled"); assert.equal(attempt.usage_verified, true); assert.equal(Number(attempt.charged_micro_usd), 28);
    assert.equal(attempt.external_state, "response_received", "actual provider response accounting remains factual despite loss of authorization");
    const execution = (await f.database.query("SELECT status,external_state FROM ai_execution_jobs")).rows[0]!;
    assert.equal(execution.status, "unknown"); assert.equal(execution.external_state, "unknown");
    assert.doesNotMatch(JSON.stringify(attempt), /PRIVATE_ACCOUNT_ERROR|PRIVATE_TEST_ANSWER|供人工检查/);
    await f.database.query("UPDATE fixture_actor_policy SET active=true WHERE id='fixture-actor'");
    assert.equal((await worker.runOnce()).processed, false); assert.equal(calls, 1, "restoring an account does not replay its previous paid request");
  } finally { release(); await f.database.close(); await server.close(); }
});

test("the worker rechecks the actor after a module completes even if its transport has no account callback", async () => {
  let calls = 0;
  const server = await serverFixture((_request, response) => { calls++; success(response); });
  const f = await fixture({ baseUrl: server.baseUrl });
  try {
    const assertActor = await actorPolicy(f.database);
    const handler: AiModuleHandler = { ...f.handler, async execute(id) {
      const result = await f.handler.execute(id);
      await f.database.query("UPDATE fixture_actor_policy SET active=false WHERE id='fixture-actor'");
      return result;
    } };
    const worker = createAiWorker({ database: f.database, ledger: f.ledger, handlers: [handler], assertActor });
    const result = await worker.runOnce();
    assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "AI_ACTOR_REVOKED");
    assert.equal((await f.database.query<{ status: string }>("SELECT status FROM ai_execution_jobs")).rows[0]!.status, "unknown");
    assert.equal(Number((await f.database.query("SELECT charged_micro_usd FROM ai_usage_attempts")).rows[0]!.charged_micro_usd), 28);
    assert.equal((await worker.runOnce()).processed, false); assert.equal(calls, 1);
  } finally { await f.database.close(); await server.close(); }
});

test("a 429 does not permit another provider call after the actor is revoked before its retry", async () => {
  let calls = 0, assertActor!: (actorId: string) => Promise<void>, arrived!: () => void, release!: () => void;
  const arrivedPromise = new Promise<void>(resolve => { arrived = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const server = await serverFixture((_request, response) => {
    calls++; arrived(); void releasePromise.then(() => { response.statusCode = 429; response.setHeader("retry-after", "0"); response.end(); });
  });
  const f = await fixture({ baseUrl: server.baseUrl, timeoutMs: 5000, modelAssertActor: context => assertActor(context.actorId) });
  try {
    assertActor = await actorPolicy(f.database);
    const pending = f.makeWorker().runOnce();
    await arrivedPromise;
    await f.database.query("UPDATE fixture_actor_policy SET active=false WHERE id='fixture-actor'");
    release();
    const result = await pending;
    assert.equal(result.status, "failed"); assert.equal(result.errorCode, "AI_ACTOR_UNAVAILABLE"); assert.equal(calls, 1);
    const attempts = (await f.database.query("SELECT status,external_state,charged_micro_usd FROM ai_usage_attempts")).rows;
    assert.equal(attempts.length, 1); assert.equal(attempts[0]!.external_state, "rejected"); assert.equal(Number(attempts[0]!.charged_micro_usd), 0);
    assert.equal((await f.database.query<{ result: unknown }>("SELECT result FROM fixture_ai_jobs")).rows[0]!.result, null);
  } finally { release(); await f.database.close(); await server.close(); }
});
