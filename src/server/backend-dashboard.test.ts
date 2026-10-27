import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { ApplicationConfig } from "./config.ts";
import { createDatabase } from "./database.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import { readBackendDashboard } from "./backend-dashboard.ts";
import { createDiscoveryCoverage } from "./discovery-coverage.ts";
import { randomUUID } from "node:crypto";

const at = "2026-10-08T12:00:00.000Z", day = at.slice(0, 10);
const admin: Actor = { userId: "operator", platformRoles: ["user", "admin"] };
const clock = { now: () => new Date(at) };
const baseConfig: ApplicationConfig = { mode: "local", origin: "http://localhost:3000", codePepper: "FIXTURE_PRIVATE_PEPPER", emailFrom: "development@localhost.invalid" };
async function fixture() {
  const database = await createDatabase({});
  await database.migrate();
  await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES('operator','operator@example.test','PRIVATE_DISPLAY_NAME','UTC',ARRAY['user','admin']::text[],$1::timestamptz,$1::timestamptz),('ordinary','ordinary@example.test','普通账号','UTC',ARRAY['user']::text[],$1::timestamptz,$1::timestamptz)", [at]);
  return { database, read: (config = baseConfig, actor: Actor | null = admin) => readBackendDashboard({ database, config, clock }, actor) };
}
function configured(): ApplicationConfig {
  const budget = { dailyProjectCallLimit: 10, dailyProjectBudgetMicroUsd: 1000, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 };
  return { ...baseConfig, mode: "connected", databaseUrl: "postgresql://PRIVATE_DATABASE_CREDENTIAL@invalid/dashboard", resendKey: "PRIVATE_EMAIL_KEY",
    ai: { baseUrl: "https://invalid.example/v1", apiKey: "PRIVATE_AI_KEY", model: "PRIVATE_MODEL_NAME", budget, workerPollMs: 2000, workerLeaseMs: 120000, maxAttempts: 1 },
    dsh: { apiKey: "PRIVATE_DSH_KEY", modelVersion: "PRIVATE_DSH_MODEL", promptVersion: "PRIVATE_PROMPT_VERSION", workingDirectory: "PRIVATE_CLI_PATH", runtimePackageDirectory: "PRIVATE_RUNTIME_PATH", currency: "USD", inputCostMicrosPerMillionTokens: 1_000_000, outputCostMicrosPerMillionTokens: 2_000_000, budget, sourceBudget: { ...budget, dailyProjectCallLimit: 20 }, maxTokens: 1000 },
    github: { options: { appId: 123, clientId: "PRIVATE_CLIENT_ID", clientSecret: "PRIVATE_GITHUB_SECRET", appSlug: "private-app", origin: baseConfig.origin, callbackUrl: `${baseConfig.origin}/callback` }, credentialKey: "PRIVATE_CIPHER_KEY", keyId: "PRIVATE_KEY_ID", previousKeys: { previous: "PRIVATE_OLD_KEY" } },
    discovery: { searchKey: "PRIVATE_SEARCH_KEY", worker: { workerId: "PRIVATE_WORKER_ID", userAgent: "fixture", queries: ["PRIVATE_SEARCH_QUERY"], minimumIntervalMs: 900000, recrawlAfterMs: 86400000, maxResultsPerQuery: 5, maxPagesPerCycle: 3, maxCycleDurationMs: 360000, fetchTimeoutMs: 15000, maxPageBytes: 262144, searchCostMicrosPerCall: 100, modelCostReservationMicrosPerCall: 100, limits: { maxSearchCallsPerDay: 100, maxModelCallsPerDay: 50, maxEstimatedCostMicrosPerDay: 1_000_000, currency: "USD" } } },
    inspiration: { workerId: "PRIVATE_INSPIRATION_WORKER", userAgent: "isolated-dashboard", minimumIntervalMs: 60_000, recrawlAfterMs: 86_400_000, maxCycleDurationMs: 60_000, fetchTimeoutMs: 1000, maxPageBytes: 65_536,
      modelCostReservationMicrosPerCall: 100, limits: { maxSearchCallsPerDay: 0, maxModelCallsPerDay: 24, maxEstimatedCostMicrosPerDay: 100_000, currency: "USD" } },
  };
}
const forbidden = (error: unknown) => error instanceof DomainError && error.code === "FORBIDDEN" && error.status === 403;

test("dashboard requires a currently active verified database admin rather than cached actor roles", async () => {
  const f = await fixture();
  try {
    let transactions = 0;
    const noAnonymousQuery: DatabasePort = { query: () => { throw new Error("anonymous query"); }, transaction: work => { transactions++; return f.database.transaction(work); } };
    await assert.rejects(readBackendDashboard({ database: noAnonymousQuery, config: baseConfig, clock }, null), forbidden);
    assert.equal(transactions, 0);
    await assert.rejects(f.read(baseConfig, { userId: "ordinary", platformRoles: ["user", "admin"] }), forbidden);
    await assert.rejects(f.read(baseConfig, { userId: "missing", platformRoles: ["admin"] }), forbidden);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='operator'");
    await assert.rejects(f.read(), forbidden);
    await f.database.query("UPDATE auth_users SET status='active',platform_roles=ARRAY['user']::text[] WHERE id='operator'");
    await assert.rejects(f.read(), forbidden);
    await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin']::text[] WHERE id='operator'");
    assert.equal((await f.read(baseConfig, { userId: "operator", platformRoles: ["user"] })).quotaDay, day, "fresh database grant is authoritative");
  } finally { await f.database.close(); }
});

test("empty snapshot shows unconfigured services, unstarted workers and no implicit discovery row", async () => {
  const f = await fixture();
  try {
    const before = (await f.database.query("SELECT id FROM operations_discovery_state")).rowCount;
    const result = await f.read();
    assert.equal(result.generatedAt, at); assert.equal(result.quotaDay, day); assert.equal(result.quotaTimezone, "UTC");
    assert.equal(result.services.length, 6);
    assert.deepEqual(result.services[0], { id: "database", configured: true, connectivity: "reachable" });
    for (const service of result.services.slice(1)) { assert.equal(service.configured, false); assert.equal(service.connectivity, "not_checked"); }
    for (const worker of result.workers) { assert.equal(worker.status, "not_started"); assert.equal(worker.lastSeenAt, null); assert.equal(worker.ageMs, null); assert.equal(worker.configured, !["ai","source","discovery","inspiration"].includes(worker.kind)); }
    assert.equal(result.discovery.state, null); assert.equal(result.discovery.phase, "not_started"); assert.equal(result.discovery.limits, null);
    assert.equal(result.discovery.coverage, null);
    assert.equal(result.workers.length, 9); assert.equal(result.inspiration.configured, false); assert.equal(result.inspiration.state, null); assert.equal(result.inspiration.cards, 0); assert.equal(result.inspiration.limits, null);
    assert.equal(result.queues.ai.total, 0); assert.equal(result.queues.domainWaiting.totalQueued, 0); assert.equal(result.queues.sourceRuns.total, 0);
    assert.equal(result.aiBudget.calls, 0); assert.equal(result.aiBudget.completeTotalMicroUsd, "0");
    assert.equal((await f.database.query("SELECT id FROM operations_discovery_state")).rowCount, before);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DISPLAY_NAME|operator@example|FIXTURE_PRIVATE_PEPPER/);
  } finally { await f.database.close(); }
});

test("configured external services remain untested and budgets expose scope caps without credentials or network calls", async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  try {
    let externalCalls = 0;
    globalThis.fetch = async () => { externalCalls++; throw new Error("external call forbidden"); };
    const result = await f.read(configured());
    assert.equal(externalCalls, 0);
    for (const service of result.services) { assert.equal(service.configured, true); assert.equal(service.connectivity, service.id === "database" ? "reachable" : "not_checked"); }
    assert.equal(result.discovery.configured, true); assert.equal(result.discovery.phase, "not_started");
    assert.equal(result.discovery.coverage?.targetHours, 5); assert.equal(result.discovery.coverage?.quotaDay, day);
    assert.equal(result.discovery.coverage?.cycles, 0); assert.equal(result.discovery.coverage?.activeMs, 0);
    assert.equal(result.discovery.coverage?.firstStartedAt, null); assert.equal(result.discovery.coverage?.spanMs, 0);
    assert.equal(result.workers.every(worker => worker.status === "not_started" && worker.configured), true);
    assert.deepEqual(result.budgetPolicies.genericAi, { scope: "project", dailyCallLimit: 10, dailyBudgetMicroUsd: "1000", pricingConfigured: true });
    assert.equal(result.budgetPolicies.dshSources?.scope, "source"); assert.equal(result.budgetPolicies.dshProjects?.scope, "project_or_user");
    assert.equal(result.discovery.limits?.maxEstimatedCostMicrosPerDay, "1000000");
    assert.equal(result.inspiration.configured, true); assert.equal(result.inspiration.phase, "not_started"); assert.equal(result.inspiration.limits?.maxModelCallsPerDay, 24);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|apiKey|databaseUrl|clientSecret|credentialKey|codePepper|runtimePackageDirectory|queries/);
  } finally { globalThis.fetch = originalFetch; await f.database.close(); }
});

test("inspiration heartbeat, independent durable allowance and card inventory are admin-only and expose no model content or credentials", async () => {
  const f = await fixture();
  try {
    await f.database.query("INSERT INTO operations_discovery_state(id,quota_day,search_calls,model_calls,estimated_cost_micros,paused,next_eligible_at,last_completed_at,last_error_code) VALUES('event-discovery',$1,2,3,500,false,$2::timestamptz,$3::timestamptz,NULL),('inspiration-catalog',$1,0,23,99900,true,$2::timestamptz,$3::timestamptz,'INSPIRATION_MODEL_REQUIRES_REVIEW')", [day, "2026-10-08T12:01:00Z", at]);
    await f.database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at,last_completed_at,error_code) VALUES('PRIVATE_INSPIRATION_PROCESS','inspiration','idle',$1::timestamptz,$1::timestamptz,NULL)", [at]);
    await f.database.query("INSERT INTO inspiration_cards(id,revision,content_hash,content,last_analyzed_at) VALUES('isolated-inspiration',1,'PRIVATE_HASH',$1::jsonb,$2::timestamptz)", [JSON.stringify({ description: "PRIVATE_DSH_MODEL_DESCRIPTION", credential: "PRIVATE_NEVER_RETURN" }), at]);
    const result = await f.read(configured());
    assert.equal(result.inspiration.configured, true); assert.equal(result.inspiration.phase, "paused"); assert.equal(result.inspiration.cards, 1);
    assert.equal(result.inspiration.state?.modelCalls, 23); assert.equal(result.inspiration.state?.estimatedCostMicros, "99900"); assert.equal(result.inspiration.state?.lastErrorCode, "INSPIRATION_MODEL_REQUIRES_REVIEW");
    assert.equal(result.inspiration.limits?.maxModelCallsPerDay, 24); assert.equal(result.inspiration.limits?.maxEstimatedCostMicrosPerDay, "100000");
    assert.equal(result.inspiration.minimumIntervalMs, 60000);
    assert.equal(result.workers.find(worker => worker.kind === "inspiration")?.status, "idle"); assert.equal(result.workers.find(worker => worker.kind === "inspiration")?.configured, true);
    assert.equal(result.discovery.state?.modelCalls, 3); assert.equal(result.discovery.state?.estimatedCostMicros, "500"); assert.equal(result.aiBudget.calls, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|description|credential|worker_id|content_hash|lease_token|queries/);
    await assert.rejects(f.read(configured(), { userId: "ordinary", platformRoles: ["user", "admin"] }), forbidden);
    const state = (await f.database.query<{ paused: boolean }>("SELECT paused FROM operations_discovery_state WHERE id='inspiration-catalog'")).rows[0]!;
    assert.equal(state.paused, true, "reading dashboard facts must not change a paused scheduler");
  } finally { await f.database.close(); }
});

test("inspiration next-model reservation detects limit exhaustion, new quota day recovery and unresolved outcomes", async () => {
  const f = await fixture(), config = configured();
  try {
    await f.database.query("INSERT INTO operations_discovery_state(id,quota_day,model_calls,estimated_cost_micros) VALUES('inspiration-catalog',$1,24,100000)", [day]);
    assert.equal((await f.read(config)).inspiration.phase, "limited");
    await f.database.query("UPDATE operations_discovery_state SET quota_day='2026-10-07' WHERE id='inspiration-catalog'");
    assert.equal((await f.read(config)).inspiration.phase, "ready");
    await f.database.query("UPDATE operations_discovery_state SET last_error_code='INSPIRATION_MODEL_REQUIRES_REVIEW' WHERE id='inspiration-catalog'");
    assert.equal((await f.read(config)).inspiration.phase, "attention", "changing quota days must not conceal unresolved model outcomes");
    await f.database.query("UPDATE operations_discovery_state SET paused=true WHERE id='inspiration-catalog'");
    assert.equal((await f.read(config)).inspiration.phase, "paused");
  } finally { await f.database.close(); }
});

test("worker freshness uses the injected snapshot clock and one stopped instance cannot hide a healthy peer", async () => {
  const f = await fixture();
  try {
    for (const [id, kind, status, secondsAgo, error] of [
      ["ai-running", "ai", "running", 1, null], ["ai-stopped", "ai", "stopped", 0, null],
      ["source-old", "source", "running", 121, "PRIVATE_CREDENTIAL_SHAPED_AS_UPPERCASE_CODE"],
      ["discovery-idle", "discovery", "idle", 65, null],
    ] as const) await f.database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at,last_completed_at,error_code) VALUES($1,$2,$3,$4::timestamptz,$4::timestamptz,$5)", [id, kind, status, new Date(Date.parse(at) - secondsAgo * 1000).toISOString(), error]);
    const result = await f.read();
    assert.equal(result.workers.find(worker => worker.kind === "ai")?.status, "running");
    assert.equal(result.workers.find(worker => worker.kind === "source")?.status, "stale");
    assert.equal(result.workers.find(worker => worker.kind === "source")?.errorCode, "WORKER_FAILED");
    assert.equal(result.workers.find(worker => worker.kind === "discovery")?.status, "idle");
    assert.equal(result.workers.find(worker => worker.kind === "discovery")?.ageMs, 65000);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|worker_id|lease_token/);
  } finally { await f.database.close(); }
});

test("official discovery reports its fixed coverage without a Brave key or exposing its transport settings", async () => {
  const f = await fixture();
  try {
    const config = configured();
    config.sourceProxyUrl = "http://127.0.0.1:22321";
    config.discovery = { provider: "official_sources", worker: { ...config.discovery!.worker, queries: ["ethglobal", "lablab"], searchCostMicrosPerCall: 0 } };
    const result = await f.read(config);
    assert.equal(result.discovery.configured, true);
    assert.equal(result.discovery.provider, "official_sources");
    assert.deepEqual(result.discovery.sources, [{ name: "ETHGlobal", url: "https://ethglobal.com/events" }, { name: "lablab.ai", url: "https://lablab.ai/ai-hackathons" }]);
    assert.equal(result.services.find(service => service.id === "search")?.configured, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|22321|sourceProxyUrl|searchKey|apiKey|queries/);
  } finally { await f.database.close(); }
});

async function central(database: DatabasePort, id: string, occurredAt = at, kind = "m04_scoring", status = "running") {
  await database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,lease_owner,lease_token,lease_until,error_code,created_at,updated_at) VALUES($1,$2,$1,1,'PRIVATE_PROJECT','PRIVATE_ACTOR',$3,$4,$5,$6::timestamptz,$7,$8::timestamptz,$8::timestamptz)", [id, kind, status, status === "running" ? "PRIVATE_WORKER" : null, status === "running" ? `PRIVATE_LEASE_${id}` : null, status === "running" ? "2026-10-09T12:00:00.000Z" : null, status === "unknown" ? "AI_PROVIDER_UNCERTAIN" : null, occurredAt]);
  return { executionId: id, leaseToken: `PRIVATE_LEASE_${id}`, projectId: "PRIVATE_PROJECT", actorId: "PRIVATE_ACTOR" };
}

test("today's USD ledger includes actual charges, conservative estimates, unpriced usage and pending reservations without inventing a complete total", async () => {
  const f = await fixture();
  try {
    const priced = new PostgresAiLedger(f.database, { dailyProjectCallLimit: 20, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 });
    const unpriced = new PostgresAiLedger(f.database, { dailyProjectCallLimit: 20 });
    for (const [id, state, price, occurredAt] of [
      ["measured", "measured", priced, at], ["uncertain", "unknown", priced, at], ["pending", "pending", priced, at], ["unpriced", "measured", unpriced, at], ["previous-day", "measured", priced, "2026-10-07T12:00:00.000Z"],
    ] as const) {
      const context = await central(f.database, id, occurredAt);
      await price.reserve({ ...context, id: `usage-${id}`, modelVersion: "PRIVATE_MODEL", promptVersion: "PRIVATE_PROMPT", inputTokenUpperBound: 10, maxOutputTokens: 20, occurredAt });
      if (state !== "pending") await price.settle({ id: `usage-${id}`, externalState: state === "unknown" ? "unknown" : "response_received", usage: state === "unknown" ? null : { inputTokens: 12, outputTokens: 8 }, requestId: "PRIVATE_REQUEST_ID", errorCode: null, occurredAt });
    }
    const result = await f.read();
    assert.equal(result.aiBudget.calls, 4); assert.equal(result.aiBudget.attempts, 4); assert.equal(result.aiBudget.pendingAttempts, 1); assert.equal(result.aiBudget.unknownFeeAttempts, 1); assert.equal(result.aiBudget.unverifiedUsageAttempts, 1);
    assert.equal(result.aiBudget.currency, "USD"); assert.equal(result.aiBudget.amountUnit, "micro_usd");
    assert.equal(result.aiBudget.knownChargedMicroUsd, "78"); assert.equal(result.aiBudget.knownReservedMicroUsd, "50"); assert.equal(result.aiBudget.knownTotalMicroUsd, "128");
    assert.equal(result.aiBudget.completeTotalMicroUsd, null); assert.equal(result.aiBudget.includesEstimates, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROJECT|PRIVATE_ACTOR|PRIVATE_MODEL|PRIVATE_PROMPT|PRIVATE_REQUEST|PRIVATE_LEASE/);
  } finally { await f.database.close(); }
});

test("stored USD accounting retains integer precision above JavaScript's safe integer limit", async () => {
  const f = await fixture();
  try {
    await f.database.query("INSERT INTO ai_budget_buckets(project_id,period,calls,charged_micro_usd) VALUES('fixture-accounting',$1::date,0,9007199254740993)", [day]);
    const result = await f.read();
    assert.equal(result.aiBudget.knownChargedMicroUsd, "9007199254740993"); assert.equal(result.aiBudget.completeTotalMicroUsd, "9007199254740993");
  } finally { await f.database.close(); }
});

async function domainFixtures(database: DatabasePort) {
  // Projection-only fixtures in the actual migrated schemas: no service/API
  // authorization claim is inferred from these minimal private documents.
  for (const [id, status] of [["m03-queued", "queued"], ["m03-running", "running"]]) await database.query("INSERT INTO m03_analysis_runs(id,revision,body) VALUES($1,1,$2::jsonb)", [id, JSON.stringify({ id, revision: 1, status, privatePrompt: "PRIVATE_DOMAIN_PROMPT" })]);
  await database.query("INSERT INTO assessments_rubrics VALUES('fixture-rubric',1,$1::jsonb)", [JSON.stringify({ id: "fixture-rubric", version: 1 })]);
  await database.query("INSERT INTO assessments_question_sets VALUES('fixture-set',1,'fixture-rubric','draft',$1::jsonb)", [JSON.stringify({ id: "fixture-set", version: 1, rubricVersionId: "fixture-rubric" })]);
  const attempt = { id: "fixture-attempt", projectId: "PRIVATE_PROJECT", membershipId: "PRIVATE_MEMBER", userId: "PRIVATE_AUTHOR", questionSetId: "fixture-set", rubricVersionId: "fixture-rubric", status: "draft", revision: 1, latestScoreId: null, activeJobId: null, privateAnswers: "PRIVATE_RAW_ANSWERS" };
  await database.query("INSERT INTO assessments_attempts(id,project_id,membership_id,user_id,question_set_id,rubric_version_id,status,revision,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$9::timestamptz,$10::jsonb)", [attempt.id, attempt.projectId, attempt.membershipId, attempt.userId, attempt.questionSetId, attempt.rubricVersionId, attempt.status, 1, at, JSON.stringify(attempt)]);
  const scoring = { id: "fixture-scoring", attemptId: attempt.id, projectId: attempt.projectId, userId: attempt.userId, idempotencyKey: "fixture", inputFingerprint: "fixture", status: "queued", revision: 1, runNumber: 1, resultScoreId: null };
  await database.query("INSERT INTO assessments_scoring_jobs(id,attempt_id,project_id,user_id,idempotency_key,input_fingerprint,status,revision,run_number,created_at,result_score_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,$8::timestamptz,NULL,$9::jsonb)", [scoring.id, scoring.attemptId, scoring.projectId, scoring.userId, scoring.idempotencyKey, scoring.inputFingerprint, scoring.status, at, JSON.stringify(scoring)]);
  const assignment = { id: "fixture-assignment", projectId: "PRIVATE_PROJECT", userId: "PRIVATE_AUTHOR", membershipId: "PRIVATE_MEMBER", status: "queued", revision: 1 };
  await database.query("INSERT INTO assessments_assignment_jobs(id,project_id,user_id,membership_id,idempotency_key,input_fingerprint,status,revision,created_at,data) VALUES($1,$2,$3,$4,'fixture','fixture','queued',1,$5::timestamptz,$6::jsonb)", [assignment.id, assignment.projectId, assignment.userId, assignment.membershipId, at, JSON.stringify(assignment)]);
  const planning = { id: "fixture-planning", projectId: "PRIVATE_PROJECT", actorId: "PRIVATE_AUTHOR", membershipId: "PRIVATE_MEMBER", idempotencyKey: "fixture", commandFingerprint: "fixture", status: "queued", revision: 1, attempts: 0, createdAt: at, startedAt: null, finishedAt: null, leaseExpiresAt: null, resultPlanId: null, errorCode: null, snapshot: { input: { projectId: "PRIVATE_PROJECT" }, tasks: [], resourceContentRefs: [], buffers: [], tasksRevision: 0 } };
  await database.query("INSERT INTO planning_generation_jobs(id,project_id,actor_id,membership_id,idempotency_key,command_fingerprint,status,revision,attempts,created_at,body) VALUES($1,$2,$3,$4,'fixture','fixture','queued',1,0,$5::timestamptz,$6::jsonb)", [planning.id, planning.projectId, planning.actorId, planning.membershipId, at, JSON.stringify(planning)]);
  const retro = { id: "fixture-retro", kind: "generation_job", projectId: "PRIVATE_PROJECT", ownerId: "PRIVATE_AUTHOR", scope: "personal", revision: 1, createdAt: at, updatedAt: at, status: "queued", privateContent: "PRIVATE_RETROSPECTIVE" };
  await database.query("INSERT INTO m07_documents(id,kind,project_id,owner_id,scope,revision,created_at,updated_at,body) VALUES($1,$2,$3,$4,$5,1,$6::timestamptz,$6::timestamptz,$7::jsonb)", [retro.id, retro.kind, retro.projectId, retro.ownerId, retro.scope, at, JSON.stringify(retro)]);
}

test("unscheduled domain work remains visible separately from central inventory and recent metadata is bounded", async () => {
  const f = await fixture();
  try {
    await domainFixtures(f.database);
    let result = await f.read();
    assert.equal(result.queues.ai.counts.queued, 0); assert.equal(result.queues.domainWaiting.totalQueued, 5); assert.equal(result.queues.domainWaiting.totalRunning, 1);
    assert.deepEqual(result.queues.domainWaiting.byKind.map(item => item.queued), [1, 1, 1, 1, 1, 0]);
    for (let index = 0; index < 14; index++) await central(f.database, `ai-${index}`, new Date(Date.parse(at) + index).toISOString(), index === 13 ? "PRIVATE_INVALID_KIND" : "navigator", index === 13 ? "unknown" : "failed");
    result = await f.read();
    assert.equal(result.queues.ai.total, 14); assert.equal(result.queues.ai.counts.failed, 13); assert.equal(result.queues.ai.counts.unknown, 1); assert.equal(result.queues.ai.recent.length, 12);
    assert.equal(result.queues.ai.recent[0]?.kind, "other"); assert.equal(result.queues.ai.recent[0]?.status, "unknown");
    assert.deepEqual(Object.keys(result.queues.ai.recent[0]!).sort(), ["errorCode", "id", "kind", "status", "updatedAt"]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|body|fingerprint|rawAnswers|lease_token|actor_id|user_id|owner_id/);
  } finally { await f.database.close(); }
});

test("private role-help domain work and coordinator receipts remain visible without answers or member identities", async () => {
  const f = await fixture();
  try {
    for (const status of ["queued", "running"] as const) {
      const id=`role-help-${status}`;
      const job={id,projectId:"PRIVATE_ROLE_PROJECT",userId:"PRIVATE_ROLE_AUTHOR",membershipId:"PRIVATE_ROLE_MEMBER",idempotencyKey:`PRIVATE_ROLE_KEY_${status}`,inputFingerprint:"PRIVATE_ROLE_FINGERPRINT",status,revision:1,
        createdAt:at,startedAt:status==="running"?at:null,finishedAt:null,failureCode:null,result:null,answers:{experience:"PRIVATE_ROLE_ANSWERS",interests:"PRIVATE_ROLE_INTERESTS",constraints:"PRIVATE_ROLE_CONSTRAINTS"},inputSnapshot:{privateField:"PRIVATE_ROLE_CONTEXT"}};
      await f.database.query("INSERT INTO assessments_role_help_jobs(id,project_id,user_id,membership_id,idempotency_key,input_fingerprint,status,revision,created_at,started_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8::timestamptz,$9::timestamptz,$10::jsonb)",
        [id,job.projectId,job.userId,job.membershipId,job.idempotencyKey,job.inputFingerprint,status,at,job.startedAt,JSON.stringify(job)]);
    }
    const waiting=await f.read();
    assert.equal(waiting.queues.ai.total,0,"a domain job need not have a coordinator receipt yet");
    assert.deepEqual(waiting.queues.domainWaiting.byKind.find(item=>item.kind==="m04_role_help"),{kind:"m04_role_help",queued:1,running:1});
    assert.equal(waiting.queues.domainWaiting.totalQueued,1);assert.equal(waiting.queues.domainWaiting.totalRunning,1);
    await central(f.database,"role-help-unknown",at,"m04_role_help","unknown");
    const result=await f.read();
    assert.equal(result.queues.ai.recent[0]?.kind,"m04_role_help");assert.equal(result.queues.ai.recent[0]?.status,"unknown");
    assert.deepEqual(Object.keys(result.queues.ai.recent[0]!).sort(),["errorCode","id","kind","status","updatedAt"]);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|answers|inputSnapshot|fingerprint|user_id|membershipId|actor_id|lease_token/);
    assert.equal((await f.database.query("SELECT id FROM assessments_role_help_jobs")).rowCount,2,"the dashboard remains read-only");
  } finally { await f.database.close(); }
});

test("source/discovery/review receipts expose state counts and host-only recent results without content, URLs or leases", async () => {
  const f = await fixture();
  try {
    await f.database.query("INSERT INTO operations_source_configs(id,revision,status,data,created_at,updated_at) VALUES('fixture-source',1,'enabled',$1::jsonb,$2::timestamptz,$2::timestamptz)", [JSON.stringify({ id: "fixture-source", revision: 1, status: "enabled", credentialPolicy: "none", private: "PRIVATE_SOURCE_BODY" }), at]);
    for (let index = 0; index < 14; index++) {
      const id = `source-run-${index}`, status = index === 13 ? "review_ready" : "failed", kind = status === "review_ready" ? "crawl" : "analysis", updatedAt = new Date(Date.parse(at) + index).toISOString();
      const data = { id, revision: 1, sourceConfigId: "fixture-source", kind, status, maxAttempts: 1, attempt: 0, timeoutMs: 1000, requestedBy: "PRIVATE_OPERATOR", failures: [{ category: index === 12 ? "PRIVATE_FAILURE_MESSAGE:https://secret" : "parse_error" }], output: "PRIVATE_MODEL_JSON", lease: { token: "PRIVATE_SOURCE_LEASE" } };
      await f.database.query("INSERT INTO operations_execution_runs(id,kind,source_config_id,revision,status,fingerprint,data,available_at,created_at,updated_at) VALUES($1,$2,'fixture-source',1,$3,'fixture',$4::jsonb,$5::timestamptz,$5::timestamptz,$6::timestamptz)", [id, kind, status, JSON.stringify(data), at, updatedAt]);
    }
    await f.database.query("INSERT INTO operations_discovery_state(id,quota_day,search_calls,model_calls,estimated_cost_micros,lease_token,lease_expires_at,reservation,last_error_code) VALUES('event-discovery','2026-10-07',3,2,999,'PRIVATE_DISCOVERY_TOKEN','2026-10-08T13:00:00Z',$1::jsonb,'PRIVATE_DIAGNOSTIC:https://secret')", [JSON.stringify({ searchCalls: 1, modelCalls: 1, estimatedCostMicros: 20 })]);
    for (let index = 0; index < 14; index++) {
      const rawUrl = index === 13 ? "https://PRIVATE_URL_USER:PRIVATE_URL_PASSWORD@example.com/PRIVATE_PATH?key=PRIVATE_QUERY#PRIVATE_FRAGMENT" : `https://example.com/page-${index}`;
      await f.database.query("INSERT INTO operations_discovery_urls(scheduler_id,canonical_url,last_attempt_at,cycle_token,last_completed_at,last_error_code) VALUES('event-discovery',$1,$2::timestamptz,'PRIVATE_CYCLE_TOKEN',$2::timestamptz,$3)", [rawUrl, new Date(Date.parse(at) + index).toISOString(), index === 13 ? "PRIVATE_RAW_ERROR:https://secret" : null]);
    }
    for (const status of ["active", "withdrawn"]) await f.database.query("INSERT INTO event_discovery_cards(id,canonical_url,revision,content_hash,content,status,discovered_at,last_analyzed_at) VALUES($1,$2,1,'fixture',$3::jsonb,$4,$5::timestamptz,$5::timestamptz)", [status, `https://example.com/${status}`, JSON.stringify({ body: "PRIVATE_SOURCE_EXCERPT" }), status, at]);
    await f.database.query("INSERT INTO operations_event_reviews VALUES('event-review','event','candidate',1,'pending',$1::timestamptz,$2::jsonb)", [at, JSON.stringify({ id: "event-review", eventId: "event", candidateId: "candidate", revision: 1, status: "pending", private: "PRIVATE_EVENT_REVIEW" })]);
    await f.database.query("INSERT INTO operations_resource_reviews VALUES('resource-review','resource',1,1,'approved',$1::timestamptz,$2::jsonb)", [at, JSON.stringify({ id: "resource-review", resourceId: "resource", resourceRevision: 1, revision: 1, status: "approved", private: "PRIVATE_RESOURCE_REVIEW" })]);
    await f.database.query("INSERT INTO operations_corrections VALUES('correction','PRIVATE_OWNER',1,'received',$1::timestamptz,$2::jsonb,$3::jsonb)", [at, JSON.stringify({ private: "PRIVATE_CORRECTION" }), JSON.stringify({ id: "correction", revision: 1, status: "received" })]);
    const result = await f.read(configured());
    assert.equal(result.queues.sourceRuns.total, 14); assert.equal(result.queues.sourceRuns.counts.failed, 13); assert.equal(result.queues.sourceRuns.counts.review_ready, 1); assert.equal(result.queues.sourceRuns.recent.length, 12);
    assert.equal(result.queues.sourceRuns.recent[1]?.errorCode, "SOURCE_RUN_FAILED");
    assert.equal(result.discovery.phase, "running"); assert.equal(result.discovery.state?.quotaDay, "2026-10-07"); assert.equal(result.discovery.state?.estimatedCostMicros, "999"); assert.equal(result.discovery.state?.includesReservation, true);
    assert.equal(result.discovery.state?.lastErrorCode, "DISCOVERY_FAILED");
    assert.deepEqual(result.discovery.cards, { active: 1, withdrawn: 1 }); assert.equal(result.discovery.recentUrls.length, 12);
    assert.equal(result.discovery.recentUrls[0]?.host, "example.com"); assert.equal(result.discovery.recentUrls[0]?.errorCode, "DISCOVERY_URL_FAILED");
    assert.equal(result.reviews.events.pending, 1); assert.equal(result.reviews.resources.approved, 1); assert.equal(result.reviews.corrections.received, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https:\/\/|canonical_url|cycle_token|lease_token|requestedBy|targetUrl|sourceSnapshot/);
  } finally { await f.database.close(); }
});

test("an unresolved discovery model attempt remains visible without a completed timestamp", async () => {
  const f = await fixture();
  try {
    await f.database.query("INSERT INTO operations_discovery_state(id,quota_day) VALUES('event-discovery',$1::date)", [day]);
    await f.database.query("INSERT INTO operations_discovery_urls(scheduler_id,canonical_url,last_attempt_at,cycle_token,content_hash,last_error_code) VALUES('event-discovery','https://example.com/private-path',$1::timestamptz,'private-cycle','private-hash','DISCOVERY_MODEL_REQUIRES_REVIEW')", [at]);
    const result = await f.read();
    assert.equal(result.discovery.recentUrls[0]?.status, "needs_review");
    assert.equal(result.discovery.recentUrls[0]?.errorCode, "DISCOVERY_MODEL_REQUIRES_REVIEW");
    assert.equal(result.discovery.recentUrls[0]?.lastCompletedAt, null);
    assert.doesNotMatch(JSON.stringify(result), /private-path|private-cycle|private-hash/);
  } finally { await f.database.close(); }
});

test("a failed first fetch or recrawl remains failed without a new completed timestamp and preserves known official errors", async () => {
  const f = await fixture();
  try {
    await f.database.query("INSERT INTO operations_discovery_state(id,quota_day,last_error_code) VALUES('event-discovery',$1::date,'OFFICIAL_SOURCE_RULES_CHANGED')", [day]);
    for (const [path, completed, error] of [["first-fetch", null, "FETCH_TIMEOUT"], ["recrawl", "2026-10-07T12:00:00.000Z", "ROBOTS_DISALLOWED"], ["official-path", null, "OFFICIAL_SOURCE_LINK_REJECTED"], ["working", null, null]] as const) {
      await f.database.query("INSERT INTO operations_discovery_urls(scheduler_id,canonical_url,last_attempt_at,last_completed_at,cycle_token,last_error_code) VALUES('event-discovery',$1,$2::timestamptz,$3::timestamptz,'private-cycle',$4)", [`https://${path}.example.com/private-path`, at, completed, error]);
    }
    const result = await f.read();
    assert.equal(result.discovery.state?.lastErrorCode, "OFFICIAL_SOURCE_RULES_CHANGED");
    for (const [host, error] of [["first-fetch.example.com", "FETCH_TIMEOUT"], ["recrawl.example.com", "ROBOTS_DISALLOWED"], ["official-path.example.com", "OFFICIAL_SOURCE_LINK_REJECTED"]]) {
      const item = result.discovery.recentUrls.find(item => item.host === host);
      assert.equal(item?.status, "failed"); assert.equal(item?.errorCode, error);
    }
    assert.equal(result.discovery.recentUrls.find(item => item.host === "working.example.com")?.status, "pending");
    assert.doesNotMatch(JSON.stringify(result), /private-path|private-cycle/);
  } finally { await f.database.close(); }
});

test("SQL failure produces a safe unavailable error instead of leaking query or driver diagnostics", async () => {
  const f = await fixture();
  try {
    await f.database.query("DROP TABLE backend_worker_heartbeats");
    await assert.rejects(f.read(), error => {
      assert.ok(error instanceof DomainError); assert.equal(error.status, 503); assert.equal(error.code, "BACKEND_DASHBOARD_UNAVAILABLE");
      assert.doesNotMatch(error.message, /backend_worker_heartbeats|SELECT|auth_users|connection|password/i); assert.equal(error.cause, undefined); return true;
    });
  } finally { await f.database.close(); }
});

test("PGlite keeps authorization and snapshot in one transaction; a concurrent role withdrawal prevents the next read", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const authorized = new Promise<void>(resolve => { entered = resolve; }), continueRead = new Promise<void>(resolve => { release = resolve; });
  try {
    let first = true;
    const held: DatabasePort = { query: async () => { throw new Error("dashboard read escaped its transaction"); }, transaction: work => f.database.transaction(sql => work({ query: async <Row>(statement: string, parameters?: readonly unknown[]) => {
      const result = await sql.query<Row>(statement, parameters);
      if (first) { first = false; entered(); await continueRead; }
      return result;
    } })) };
    const pending = readBackendDashboard({ database: held, config: baseConfig, clock }, admin);
    await authorized;
    let revoked = false;
    // This is a real single-connection PGlite transaction-serialization test,
    // not a claim of PostgreSQL multi-client row-lock validation.
    const withdrawal = f.database.transaction(async sql => { await sql.query("UPDATE auth_users SET platform_roles=ARRAY['user']::text[] WHERE id='operator'"); revoked = true; });
    await delay(20); assert.equal(revoked, false);
    release(); assert.equal((await pending).quotaDay, day);
    await withdrawal; assert.equal(revoked, true);
    await assert.rejects(f.read(), forbidden);
  } finally { release(); await f.database.close(); }
});

test("dashboard projects durable current-UTC coverage in its one read-only snapshot and separates waits from processing", async () => {
  const f = await fixture();
  try {
    const service = createDiscoveryCoverage({ database: f.database, clock });
    const report = { status: "completed" as const, searched: 1, fetched: 1, saved: 1, unchanged: 0, rejected: 0, errors: [] };
    for (const [startedAt, completedAt] of [
      ["2026-10-07T06:00:00.000Z", "2026-10-07T06:30:00.000Z"],
      ["2026-10-08T07:00:00.000Z", "2026-10-08T07:00:02.000Z"],
      ["2026-10-08T11:59:57.000Z", at],
    ]) await service.record({ attemptId: randomUUID(), startedAt, completedAt, report });
    const config = configured(); config.discovery!.coverageTargetHours = 8;
    const before = (await f.database.query("SELECT * FROM operations_discovery_coverage ORDER BY quota_day")).rows;
    const statements: string[] = [];
    const guarded: DatabasePort = { query: async () => { throw new Error("snapshot escaped transaction"); },
      transaction: work => f.database.transaction(sql => work({ async query<Row>(statement: string, parameters?: readonly unknown[]) {
        statements.push(statement);
        assert.match(statement, /^(SELECT|WITH) /, "dashboard and coverage reads cannot create rows or change accounting");
        return sql.query<Row>(statement, parameters);
      } })) };
    const result = await readBackendDashboard({ database: guarded, config, clock }, admin);
    assert.equal(statements.length, 2, "authority lookup and one aggregate statement share the transaction");
    assert.match(statements[1], /^WITH /); assert.match(statements[1], /operations_discovery_coverage/);
    const coverage = result.discovery.coverage;
    assert.equal(coverage?.quotaDay, day); assert.equal(coverage?.targetHours, 8);
    assert.equal(coverage?.cycles, 2); assert.equal(coverage?.searchCalls, 2); assert.equal(coverage?.fetchedPages, 2); assert.equal(coverage?.savedCards, 2);
    assert.equal(coverage?.firstStartedAt, "2026-10-08T07:00:00.000Z"); assert.equal(coverage?.lastCompletedAt, at);
    assert.equal(coverage?.activeMs, 5000); assert.equal(coverage?.spanMs, 5 * 3_600_000);
    assert.equal("targetReached" in coverage!, false); assert.equal("completed" in coverage!, false);
    assert.doesNotMatch(JSON.stringify(coverage), /scheduler_id|attempt_id|cycle_token/);
    const tomorrow = await readBackendDashboard({ database: guarded, config, clock: { now: () => new Date("2026-10-09T00:00:01.000Z") } }, admin);
    assert.equal(tomorrow.discovery.coverage?.quotaDay, "2026-10-09"); assert.equal(tomorrow.discovery.coverage?.cycles, 0);
    assert.equal(tomorrow.discovery.coverage?.firstStartedAt, null);
    assert.deepEqual((await f.database.query("SELECT * FROM operations_discovery_coverage ORDER BY quota_day")).rows, before);
    assert.equal((await f.database.query("SELECT attempt_id FROM operations_discovery_coverage_cycles")).rows.length, 3);
    assert.equal((await f.database.query("SELECT id FROM operations_discovery_state")).rows.length, 0, "reading coverage must not initialize the paid discovery ledger");
  } finally { await f.database.close(); }
});

test("discovery reports full-round budget limits before waiting and preserves unknown holds across quota days", async () => {
  const f = await fixture();
  try {
    const config = configured();
    config.discovery = { ...config.discovery!, provider: "dsh_native", nativeQueriesPerCycle: 1, coverageTargetHours: 5,
      worker: { ...config.discovery!.worker, queries: ["PRIVATE_QUERY"], minimumIntervalMs: 300_000, maxPagesPerCycle: 1,
        searchCostMicrosPerCall: 317_031, modelCostReservationMicrosPerCall: 49_152,
        limits: { maxSearchCallsPerDay: 144, maxModelCallsPerDay: 360, maxEstimatedCostMicrosPerDay: 1_000_000, currency: "USD" } } };
    await f.database.query("INSERT INTO operations_discovery_state(id,quota_day,search_calls,model_calls,estimated_cost_micros,next_eligible_at) VALUES('event-discovery',$1,20,40,633818,'2026-10-08T12:05:00Z')", [day]);
    const limited = await f.read(config);
    assert.equal(limited.discovery.phase, "limited", "remaining 366182 microUSD cannot reserve a 366183 microUSD round");
    assert.equal(limited.discovery.limits?.maxEstimatedCostMicrosPerDay, "1000000");
    assert.equal(limited.discovery.state?.estimatedCostMicros, "633818");
    await f.database.query("UPDATE operations_discovery_state SET estimated_cost_micros=633817 WHERE id='event-discovery'");
    assert.equal((await f.read(config)).discovery.phase, "waiting", "exactly sufficient reservation leaves cadence waiting");
    await f.database.query("UPDATE operations_discovery_state SET search_calls=144 WHERE id='event-discovery'");
    assert.equal((await f.read(config)).discovery.phase, "limited");
    await f.database.query("UPDATE operations_discovery_state SET search_calls=20,model_calls=359 WHERE id='event-discovery'");
    assert.equal((await f.read(config)).discovery.phase, "limited", "one native search plus one analysis needs two model slots");
    await f.database.query("UPDATE operations_discovery_state SET model_calls=40,estimated_cost_micros=10000,last_error_code='DISCOVERY_SEARCH_REQUIRES_REVIEW' WHERE id='event-discovery'");
    const hash = "a".repeat(64);
    await f.database.query("INSERT INTO operations_discovery_search_attempts(scheduler_id,request_hash,last_attempt_at,cycle_token,last_error_code) VALUES('event-discovery',$1,$2::timestamptz,'PRIVATE_HELD_CYCLE','DISCOVERY_SEARCH_REQUIRES_REVIEW')", [hash, at]);
    const holdBefore = (await f.database.query("SELECT * FROM operations_discovery_search_attempts")).rows;
    assert.equal((await f.read(config)).discovery.phase, "attention");
    await f.database.query("UPDATE operations_discovery_state SET quota_day='2026-10-07',search_calls=144,model_calls=360,estimated_cost_micros=1000000 WHERE id='event-discovery'");
    const newDay = await f.read(config);
    assert.equal(newDay.discovery.phase, "attention", "a new quota day cannot conceal unresolved external outcomes");
    assert.equal(newDay.discovery.state?.lastErrorCode, "DISCOVERY_SEARCH_REQUIRES_REVIEW");
    await f.database.query("UPDATE operations_discovery_state SET paused=true WHERE id='event-discovery'");
    assert.equal((await f.read(config)).discovery.phase, "paused");
    await f.database.query("UPDATE operations_discovery_state SET paused=false,lease_token='PRIVATE_RUNNING_CYCLE',lease_expires_at='2026-10-08T13:00:00Z',reservation=$1::jsonb WHERE id='event-discovery'", [JSON.stringify({ searchCalls: 1, modelCalls: 2, estimatedCostMicros: 366183 })]);
    assert.equal((await f.read(config)).discovery.phase, "running");
    assert.deepEqual((await f.database.query("SELECT * FROM operations_discovery_search_attempts")).rows, holdBefore, "dashboard reads never release a held paid request");
    assert.doesNotMatch(JSON.stringify(newDay), /PRIVATE_HELD_CYCLE|PRIVATE_QUERY|request_hash/);
  } finally { await f.database.close(); }
});
