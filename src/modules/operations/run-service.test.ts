import test from "node:test";
import assert from "node:assert/strict";
import { admin, draft, executionFixture, ordinaryUser, reviewer } from "./source-test-fixtures.ts";
import type { ApprovedWorkerTask } from "./run-domain.ts";

type Fixture = Awaited<ReturnType<typeof executionFixture>>;
const credential = "fixture-credential";
async function enqueue(fixture: Fixture, key = "crawl-key", extra: { maxAttempts?: number; timeoutMs?: number } = {}) {
  return fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: draft.sampleUrl, adapterVersion: "fixture-adapter-v1", idempotencyKey: key, ...extra });
}
async function validateCrawl(fixture: Fixture, task: ApprovedWorkerTask) {
  let revision = task.revision;
  for (const step of ["normalizing", "extracting", "validating"] as const) revision = (await fixture.workers.advance(credential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, step })).revision;
  return fixture.workers.complete(credential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, resultRef: "fixture-result-ref" });
}
async function completedCrawl(fixture: Fixture, key = "crawl-key") {
  const run = await enqueue(fixture, key);
  await validateCrawl(fixture, await fixture.workers.claim(credential, run.id));
  return run.id;
}
const analysisInput = (crawlRunId: string, key = "analysis-key") => ({ crawlRunId, inputHash: "validated-hash", schemaVersion: "event-schema-v1", modelVersion: "fixture-model-v1", promptVersion: "extract-v1", idempotencyKey: key });

test("task endpoints isolate admin actions and authenticated worker source scope", async () => {
  const fixture = await executionFixture();
  for (const actor of [reviewer, ordinaryUser]) await assert.rejects(fixture.runs.enqueueCrawl(actor, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: draft.sampleUrl, adapterVersion: "v1", idempotencyKey: "key" }), { code: "SOURCE_ADMIN_REQUIRED" });
  const run = await enqueue(fixture);
  await assert.rejects(fixture.workers.claim("website-user-session", run.id), { code: "WORKER_UNAUTHENTICATED" });
  fixture.identities.authenticate = async () => ({ id: "unapproved-worker", kind: "operations_worker", capabilities: ["crawl"], sourceConfigIds: ["different-source"] });
  await assert.rejects(fixture.workers.claim(credential, run.id), { code: "WORKER_SCOPE_DENIED" });
  assert.equal((await fixture.runs.get(reviewer, run.id)).status, "queued");
});
test("crawl URL whitelist, attempt limits, frequency and idempotency guard task creation", async () => {
  const fixture = await executionFixture();
  await assert.rejects(fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: "https://another.hackathon.dev/rules", adapterVersion: "v1", idempotencyKey: "bad-url" }), { code: "UNSAFE_SOURCE_URL" });
  await assert.rejects(enqueue(fixture, "bad-attempts", { maxAttempts: 4 }), { code: "INVALID_RUN_LIMITS" });
  const [first, duplicate] = await Promise.all([enqueue(fixture), enqueue(fixture)]);
  assert.equal(first.id, duplicate.id);
  assert.equal(fixture.repository.runs.size, 1);
  await assert.rejects(fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: "https://events.hackathon.dev/rules/changed", adapterVersion: "fixture-adapter-v1", idempotencyKey: "crawl-key" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(enqueue(fixture, "second-key"), { code: "SOURCE_FREQUENCY_LIMIT" });
  fixture.clock.advance(300_000);
  await assert.rejects(enqueue(fixture, "second-key"), { code: "SOURCE_RUN_ACTIVE" });
});
test("one lease wins, task metadata is minimal, and admin reads redact the lease token", async () => {
  const fixture = await executionFixture();
  const run = await enqueue(fixture);
  const claims = await Promise.allSettled([fixture.workers.claim(credential, run.id), fixture.workers.claim(credential, run.id)]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const won = claims.find((claim) => claim.status === "fulfilled");
  assert.ok(won && won.status === "fulfilled");
  const task = won.value;
  assert.equal("ownerUserId" in task.source, false);
  assert.equal("verification" in task.source, false);
  assert.ok(task.leaseExpiresAt < task.deadlineAt);
  assert.equal(task.leaseToken.length >= 40, true);
  assert.equal((await fixture.runs.get(reviewer, run.id)).lease?.token, "[redacted]");
  await assert.rejects(fixture.workers.advance(credential, { runId: run.id, leaseToken: "wrong-token", expectedRevision: task.revision, step: "normalizing" }), { code: "WORKER_LEASE_LOST" });
  await assert.rejects(fixture.workers.advance(credential, { runId: run.id, leaseToken: task.leaseToken, expectedRevision: undefined as unknown as number, step: "normalizing" }), { code: "VERSION_CONFLICT" });
  await assert.rejects(fixture.workers.advance(credential, { runId: run.id, leaseToken: task.leaseToken, expectedRevision: task.revision, step: "validating" }), { code: "INVALID_RUN_STEP" });
  assert.equal(typeof (fixture.workers as unknown as { publish?: unknown }).publish, "undefined");
});
test("retry is bounded to three attempts and respects source interval and explicit categories", async () => {
  const fixture = await executionFixture();
  const run = await enqueue(fixture);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const task = await fixture.workers.claim(credential, run.id);
    assert.equal(task.attempt, attempt);
    const failure = await fixture.workers.fail(credential, { runId: run.id, expectedRevision: task.revision, leaseToken: task.leaseToken, category: "network_error" });
    assert.equal(failure.status, attempt < 3 ? "queued" : "failed");
    if (attempt < 3) {
      await assert.rejects(fixture.workers.claim(credential, run.id), { code: "RUN_NOT_CLAIMABLE" });
      assert.equal(Date.parse(failure.availableAt) - fixture.clock.now().getTime(), 300_000);
      fixture.clock.advance(300_000);
    }
  }
  const finished = await fixture.runs.get(admin, run.id);
  assert.equal(finished.failures.length, 3);
  assert.equal((await fixture.sources.get(admin, fixture.source.id)).health.consecutiveFailures, 3);
  await assert.rejects(fixture.workers.claim(credential, run.id), { code: "RUN_NOT_CLAIMABLE" });
  fixture.clock.advance(300_000);
  const rerun = await fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: draft.sampleUrl, adapterVersion: "fixture-adapter-v1", idempotencyKey: "manual-rerun", retryOf: run.id });
  assert.notEqual(rerun.id, run.id);
  assert.equal(rerun.retryOf, run.id);
  assert.equal((await fixture.runs.get(admin, run.id)).status, "failed");
});
test("nonretryable parser and schema failures stop immediately", async () => {
  for (const category of ["parse_error", "schema_invalid", "access_denied"] as const) {
    const fixture = await executionFixture();
    const run = await enqueue(fixture);
    const task = await fixture.workers.claim(credential, run.id);
    const failed = await fixture.workers.fail(credential, { runId: run.id, leaseToken: task.leaseToken, expectedRevision: task.revision, category });
    assert.equal(failed.status, "failed");
    assert.equal((await fixture.runs.get(admin, run.id)).failures[0].retryable, false);
  }
});
test("heartbeat preserves absolute deadline, watchdog reclaims crashed worker and rejects stale lease", async () => {
  const fixture = await executionFixture();
  const run = await enqueue(fixture, "crawl-key", { timeoutMs: 60_000 });
  const task = await fixture.workers.claim(credential, run.id);
  fixture.clock.advance(20_000);
  const heartbeat = await fixture.workers.advance(credential, { runId: run.id, leaseToken: task.leaseToken, expectedRevision: task.revision, step: "fetching" });
  assert.equal(heartbeat.deadlineAt, task.deadlineAt);
  assert.ok(heartbeat.leaseExpiresAt! > task.leaseExpiresAt);
  fixture.clock.advance(30_001);
  const reclaimed = await fixture.runs.reclaimExpired(admin);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].status, "queued");
  assert.equal(reclaimed[0].failures[0].category, "worker_lost");
  await assert.rejects(fixture.workers.advance(credential, { runId: run.id, leaseToken: task.leaseToken, expectedRevision: reclaimed[0].revision, step: "normalizing" }), { code: "WORKER_LEASE_LOST" });
  fixture.clock.advance(249_999);
  const nextTask = await fixture.workers.claim(credential, run.id);
  assert.notEqual(nextTask.leaseToken, task.leaseToken);
  assert.equal(nextTask.attempt, 2);
});
test("cancellation and source invalidation never become review_ready, and stale queued runs release their slot", async () => {
  const fixture = await executionFixture();
  const run = await enqueue(fixture);
  const task = await fixture.workers.claim(credential, run.id);
  const cancelled = await fixture.runs.cancel(admin, run.id, { expectedRevision: task.revision, reason: "停止本次获取" });
  await assert.rejects(fixture.workers.complete(credential, { runId: run.id, leaseToken: task.leaseToken, expectedRevision: cancelled.revision, resultRef: "late-result" }), { code: "WORKER_LEASE_LOST" });
  fixture.clock.advance(300_000);
  const queued = await enqueue(fixture, "new-queued");
  await fixture.sources.revise(admin, fixture.source.id, { expectedRevision: fixture.source.revision, reason: "换网络规则", config: { ...draft, networkPolicy: { ...draft.networkPolicy, version: 2 } } });
  await assert.rejects(fixture.workers.claim(credential, queued.id), { code: "SOURCE_CONFIG_CHANGED" });
  assert.equal((await fixture.runs.get(admin, queued.id)).status, "failed");
  assert.equal(await fixture.repository.findActiveCrawl(fixture.source.id), null);
  assert.equal((await fixture.runs.get(admin, queued.id)).failures[0].category, "source_changed");
});
test("watchdog terminates paused source tasks even before the lease expires", async () => {
  const fixture = await executionFixture();
  const run = await enqueue(fixture);
  await fixture.workers.claim(credential, run.id);
  await fixture.sources.transition(admin, fixture.source.id, { expectedRevision: fixture.source.revision, status: "paused", reason: "来源暂不可用" });
  const [reclaimed] = await fixture.runs.reclaimExpired(admin);
  assert.equal(reclaimed.status, "failed");
  assert.equal(reclaimed.failures.at(-1)?.category, "source_changed");
});
test("authoritative output validation creates only candidate-ready status; validation race cannot undo cancel", async () => {
  const fixture = await executionFixture();
  const crawlId = await completedCrawl(fixture);
  const completed = await fixture.runs.get(admin, crawlId);
  assert.equal(completed.status, "review_ready");
  assert.equal(completed.kind === "crawl" && completed.output?.eventSourceIds[0], "m03-source-v1");
  assert.equal(fixture.validationCalls.length, 1);
  assert.equal((await fixture.sources.get(admin, fixture.source.id)).health.lastSuccessAt, fixture.clock.now().toISOString());
  const racing = await executionFixture();
  racing.validation.validateCrawl = async (input) => {
    const current = await racing.runs.get(admin, input.runId);
    await racing.runs.cancel(admin, input.runId, { expectedRevision: current.revision, reason: "校验期间取消" });
    return { resultRef: input.resultRef, inputHash: "validated-hash", eventSourceIds: ["source-ref"], candidateRefs: ["candidate-ref"], unchanged: false };
  };
  const raceRun = await enqueue(racing);
  await assert.rejects(validateCrawl(racing, await racing.workers.claim(credential, raceRun.id)), { code: "VERSION_CONFLICT" });
  assert.equal((await racing.runs.get(admin, raceRun.id)).status, "cancelled");
});
test("analysis reuses same content/version across task limits and binds new idempotency aliases", async () => {
  const fixture = await executionFixture();
  const crawlRunId = await completedCrawl(fixture);
  const first = await fixture.runs.enqueueAnalysis(admin, analysisInput(crawlRunId));
  const second = await fixture.runs.enqueueAnalysis(admin, { ...analysisInput(crawlRunId, "alias-key"), timeoutMs: 600_000, maxAttempts: 1 });
  assert.equal(second.id, first.id);
  await assert.rejects(fixture.runs.enqueueAnalysis(admin, { ...analysisInput(crawlRunId, "alias-key"), promptVersion: "different-prompt", timeoutMs: 600_000, maxAttempts: 1 }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(fixture.runs.enqueueAnalysis(admin, { ...analysisInput(crawlRunId, "bad-limit"), maxAttempts: 4 }), { code: "INVALID_RUN_LIMITS" });
  const task = await fixture.workers.claim(credential, first.id);
  const checking = await fixture.workers.advance(credential, { runId: first.id, expectedRevision: task.revision, leaseToken: task.leaseToken, step: "validating" });
  const result = await fixture.workers.complete(credential, { runId: first.id, expectedRevision: checking.revision, leaseToken: task.leaseToken, resultRef: "analysis-ref" });
  assert.equal(result.status, "succeeded");
  const saved = await fixture.runs.get(admin, first.id);
  assert.equal(saved.kind === "analysis" && saved.output?.estimatedCostMicros, 100);
  await assert.rejects(fixture.runs.enqueueAnalysis(admin, { ...analysisInput(crawlRunId, "bad-hash"), inputHash: "unknown-hash" }), { code: "CRAWL_INPUT_NOT_READY" });
});
test("task creation and lease updates roll back together with audit failure", async () => {
  const fixture = await executionFixture();
  fixture.repository.failAudit = true;
  await assert.rejects(enqueue(fixture), /audit unavailable/);
  assert.equal(fixture.repository.runs.size, 0);
  assert.equal(fixture.repository.aliases.size, 0);
  assert.equal((await fixture.sources.get(admin, fixture.source.id)).health.nextEligibleAt, null);
  fixture.repository.failAudit = false;
  const run = await enqueue(fixture);
  fixture.repository.failAudit = true;
  await assert.rejects(fixture.workers.claim(credential, run.id), /audit unavailable/);
  assert.equal((await fixture.runs.get(admin, run.id)).status, "queued");
  assert.equal((await fixture.runs.get(admin, run.id)).attempt, 0);
});
test("claim computes a fresh lease after source-lock wait and completion rechecks lease after that wait", async () => {
  const fixture = await executionFixture();
  const run = await enqueue(fixture);
  const originalGet = fixture.repository.getSource.bind(fixture.repository);
  fixture.repository.getSource = async (id, lock = false) => {
    const source = await originalGet(id, lock);
    if (lock) fixture.clock.advance(40_000);
    return source;
  };
  const task = await fixture.workers.claim(credential, run.id);
  assert.ok(Date.parse(task.leaseExpiresAt) > fixture.clock.now().getTime());
  fixture.repository.getSource = originalGet;
  let revision = task.revision;
  for (const step of ["normalizing", "extracting", "validating"] as const) revision = (await fixture.workers.advance(credential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, step })).revision;
  fixture.repository.getSource = async (id, lock = false) => {
    const source = await originalGet(id, lock);
    if (lock) fixture.clock.advance(40_000);
    return source;
  };
  await assert.rejects(fixture.workers.complete(credential, { runId: task.runId, leaseToken: task.leaseToken, expectedRevision: revision, resultRef: "delayed-lock-result" }), { code: "WORKER_LEASE_LOST" });
  assert.equal((await fixture.runs.get(admin, run.id)).status, "running");
  assert.equal((await fixture.runs.get(admin, run.id)).revision, revision);
});
