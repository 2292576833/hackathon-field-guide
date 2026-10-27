import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { createDatabase } from "./database.ts";
import { createOperationsObservability } from "./operations-observability.ts";

const at = "2026-10-10T09:00:00.000Z", old = "2026-10-01T09:00:00.000Z";
async function fixture(t: TestContext) {
  const database = await createDatabase({}); t.after(() => database.close()); await database.migrate();
  let now = Date.parse(at), guards = 0;
  const clock = { now: () => new Date(now) }, advance = (ms: number) => {now += ms;};
  await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES('operator','private@example.test','PRIVATE_ACCOUNT','UTC',ARRAY['user','admin']::text[],$1::timestamptz,$1::timestamptz),('ordinary','other@example.test','other','UTC',ARRAY['user']::text[],$1::timestamptz,$1::timestamptz)", [at]);
  await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES('session','operator',$1,$2::timestamptz,$2::timestamptz,$2::timestamptz+interval '1 hour')", ["c".repeat(64), at]);
  const principal = {actor: {userId: "operator",platformRoles: ["admin" as const]}, guard: async (sql: SqlExecutor) => {
    guards++;
    if (!(await sql.query("SELECT id FROM auth_sessions WHERE id='session' AND user_id='operator' AND revoked_at IS NULL AND expires_at>$1::timestamptz FOR SHARE", [clock.now().toISOString()])).rowCount) throw new DomainError("UNAUTHENTICATED", "登录已经失效。", {status: 401});
  }};
  for (const id of ["source-a", "source-b"]) await database.query("INSERT INTO operations_source_configs(id,revision,status,data,consecutive_failures,created_at,updated_at) VALUES($1,1,'enabled',$2::jsonb,3,$3::timestamptz,$3::timestamptz)", [id, JSON.stringify({id,revision: 1,status: "enabled",credentialPolicy: "none",sampleUrl: "https://source.hackathon.dev/?token=PRIVATE_URL_SECRET",ownerUserId: "PRIVATE_OWNER"}), at]);
  const policy = {dailyProjectCallLimit: 10,dailyProjectBudgetMicroUsd: 1000,inputMicroUsdPerMillion: 1000000,outputMicroUsdPerMillion: 2000000};
  const make = (config: {database?: DatabasePort; sourceModelConfigured?: boolean; budget?: typeof policy} = {}) => createOperationsObservability({database: config.database ?? database,clock,cursorSecret: "fixture-server-only-cursor-material-long",sourceModelConfigured: config.sourceModelConfigured ?? true,sourceBudget: config.budget ?? policy,resolvePrincipal: async () => principal,requestId: () => "request"});
  async function job(id: string, source: string, status = "unknown", time = old) {
    await database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,external_state,created_at,updated_at) VALUES($1,'source',$1,1,$2,'PRIVATE_ACTOR',$3,$4,$5::timestamptz,$5::timestamptz)", [id, `source:${source}`, status, status === "unknown" ? "unknown" : "response_received", time]);
  }
  async function usage(id: string, source: string, status: "reserved" | "settled", time = old, unknown = false) {
    await database.query("INSERT INTO ai_usage_attempts(id,execution_id,project_id,actor_id,period,model_version,prompt_version,status,cost_configured,input_rate_micro_usd_per_million,output_rate_micro_usd_per_million,reserved_micro_usd,charged_micro_usd,usage_verified,external_state,created_at,settled_at) VALUES($1,$1,$2,'PRIVATE_ACTOR',$3::date,'PRIVATE_MODEL','PRIVATE_PROMPT',$4,true,1000000,2000000,100,$5,$6,$7,$8::timestamptz,$9::timestamptz)", [id, `source:${source}`, time.slice(0,10), status, status === "settled" ? 100 : null, status === "settled" && !unknown, unknown ? "unknown" : status === "settled" ? "response_received" : "not_sent", time, status === "settled" ? time : null]);
  }
  return {database, principal, clock, advance, make, job, usage, guardCount: () => guards};
}

test("actual admin source projection rechecks current account and request session before and after a read", async t => {
  const f = await fixture(t), root = f.make();
  const report = await root.service.source(f.principal, {sourceId: "source-a"});
  assert.equal(f.guardCount(), 2); assert.equal(report.source.consecutiveCrawlFailures, 3);
  assert.deepEqual(report.runtime!.worker, {scope: "all_sources",status: "not_started",lastSeenAt: null});
  assert.equal(report.runtime!.model!.completeCostMicroUsd, "0");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private@example|lease|token/);
  await assert.rejects(root.service.source({...f.principal,actor: {userId: "ordinary",platformRoles: ["admin"]}}, {sourceId: "source-a"}), {code: "FORBIDDEN"});
  await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='operator'");
  await assert.rejects(root.service.source(f.principal, {sourceId: "source-a"}), {code: "FORBIDDEN"});
  await f.database.query("UPDATE auth_users SET status='active' WHERE id='operator'");
  f.advance(3600001); await assert.rejects(root.service.source(f.principal, {sourceId: "source-a"}), {code: "UNAUTHENTICATED"});
});

test("all-history unknown and reservations stay source-scoped across UTC rollover while costs/calls remain daily", async t => {
  const f = await fixture(t);
  await f.job("old-unknown", "source-a"); await f.usage("old-unknown", "source-a", "settled", old, true);
  await f.job("old-reserved", "source-a", "failed"); await f.usage("old-reserved", "source-a", "reserved");
  await f.job("other-unknown", "source-b");
  await f.database.query("INSERT INTO ai_budget_buckets(project_id,period,calls,reserved_micro_usd,charged_micro_usd) VALUES('source:source-a',$1::date,2,0,100),('source:source-a',$2::date,9,0,900),('source:source-b',$1::date,10,0,1000)", [at.slice(0,10),old.slice(0,10)]);
  const first = (await f.make().service.source(f.principal, {sourceId: "source-a"})).runtime!.model!;
  assert.equal(first.calls, 2); assert.equal(first.pendingReservations, 1); assert.equal(first.unknownRequests, 1);
  assert.equal(first.admission, "unknown_request"); assert.equal(first.completeCostMicroUsd, null);
  f.advance(86400000);
  await f.database.query("UPDATE auth_sessions SET expires_at=$1::timestamptz+interval '1 hour' WHERE id='session'", [f.clock.now().toISOString()]);
  const second = (await f.make().service.source(f.principal, {sourceId: "source-a"})).runtime!.model!;
  assert.equal(second.quotaDay, "2026-10-11"); assert.equal(second.calls, 0); assert.equal(second.unknownRequests, 1); assert.equal(second.pendingReservations, 1);
  const rows = (await f.database.query<{status: string}>("SELECT status FROM ai_execution_jobs WHERE id='old-unknown'")).rows;
  assert.equal(rows[0]!.status, "unknown");
});

test("shared worker prefers a live serving heartbeat, then becomes stale; source daily cap is not a global quota", async t => {
  const f = await fixture(t);
  await f.database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at,error_code) VALUES('PRIVATE_RUNNING','source','running',$1::timestamptz-interval '1 second','PRIVATE_DIAGNOSTIC'),('PRIVATE_STOPPED','source','stopped',$1::timestamptz,NULL)", [at]);
  await f.database.query("INSERT INTO ai_budget_buckets(project_id,period,calls,reserved_micro_usd,charged_micro_usd) VALUES('source:source-b',$1::date,10,0,1000)", [at.slice(0,10)]);
  const a = (await f.make().service.source(f.principal, {sourceId: "source-a"})).runtime!;
  const b = (await f.make().service.source(f.principal, {sourceId: "source-b"})).runtime!;
  assert.equal(a.worker!.status, "running"); assert.equal(a.worker!.scope, "all_sources");
  assert.equal(a.model!.admission, "allowed"); assert.equal(b.model!.admission, "limited");
  assert.doesNotMatch(JSON.stringify(a), /PRIVATE_/);
  await f.database.query("DELETE FROM backend_worker_heartbeats WHERE worker_id='PRIVATE_STOPPED'"); f.advance(120001);
  assert.equal((await f.make().service.source(f.principal, {sourceId: "source-a"})).runtime!.worker!.status, "stale");
});

test("GET validates bounded parameters, has no worker/ledger mutation and rejects a session revoked during projection", async t => {
  const f = await fixture(t), root = f.make();
  const before = (await f.database.query("SELECT (SELECT count(*) FROM ai_budget_buckets) budget,(SELECT count(*) FROM ai_execution_jobs) jobs,(SELECT count(*) FROM backend_worker_heartbeats) workers")).rows;
  assert.equal((await root.handlers.source("source-a")(new Request("https://site.test/observability?limit=1&limit=2"))).status, 422);
  assert.equal((await root.handlers.source("source-a")(new Request("https://site.test/observability?actor=ordinary"))).status, 422);
  const response = await root.handlers.source("source-a")(new Request("https://site.test/observability"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store, private");
  assert.deepEqual((await f.database.query("SELECT (SELECT count(*) FROM ai_budget_buckets) budget,(SELECT count(*) FROM ai_execution_jobs) jobs,(SELECT count(*) FROM backend_worker_heartbeats) workers")).rows, before);
  const wrapped: DatabasePort = {query: (sql, params) => f.database.query(sql, params), transaction: work => f.database.transaction(sql => work({query: async <Row>(statement: string, parameters?: readonly unknown[]) => {
    const result = await sql.query<Row>(statement, parameters);
    if (statement.startsWith("WITH scoped_jobs")) await sql.query("UPDATE auth_sessions SET revoked_at=$1::timestamptz WHERE id='session'", [at]);
    return result;
  }}))};
  await assert.rejects(f.make({database: wrapped}).service.source(f.principal, {sourceId: "source-a"}), {code: "UNAUTHENTICATED"});
});
