import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { admin, draft, executionFixture } from "./source-test-fixtures.ts";
import { assertExpectedRevision } from "./source-domain.ts";
import { assertRunLease } from "./run-domain.ts";
import type { WorkerRunState } from "./run-domain.ts";
import { createSourceWorker, SOURCE_CRAWL_ADAPTER_VERSION, sourceWorkerFailureCategory } from "./source-worker.ts";
import type { SourceCandidateIngestionInput, SourceCandidateIngestionPort, SourceJsonModelPort, SourceWorkerNetworkPorts } from "./source-worker.ts";
import { SOURCE_ANALYSIS_SCHEMA_VERSION } from "./source-extraction.ts";

const content = "星火黑客松 主办方：星火社区 参赛资格不限。团队 1–4 人。提交截止：2026年10月30日 18:00 Asia/Shanghai 必须提交演示视频。";
const rawExtraction = () => ({ metadata: { name: "星火黑客松", nameExcerpt: "星火黑客松", organizer: "星火社区", organizerExcerpt: "主办方：星火社区" }, facts: [{ key: "eligibility", statement: "参赛资格不限。", excerpt: "参赛资格不限。" }], dates: [{ name: "提交截止", stageType: "submission", rawText: "2026年10月30日 18:00", excerpt: "提交截止：2026年10月30日 18:00 Asia/Shanghai", timeZone: "Asia/Shanghai", dateOnly: false }], requirements: [{ label: "演示视频", necessity: "required", excerpt: "必须提交演示视频。" }], unknowns: [] });
const rawAnalysis = () => ({ summary: "可先准备演示视频，规则与费用仍待人工核验。", observations: [{ statement: "参赛资格不限。", excerpt: "参赛资格不限。" }], suggestions: [{ text: "安排演示视频脚本准备", basisExcerpt: "必须提交演示视频。" }], unknowns: [{ field: "fees", question: "请核对费用" }] });
const usage = { inputTokens: 100, outputTokens: 80, estimatedCostMicros: 30, currency: "USD" as const };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const credential = "fixture-credential";

/** The bridge double verifies authoritative run/source in one fixture transaction;
 * production uses the root M03 SQL bridge, not this in-memory result map. */
async function workerFixture() {
  const fixture = await executionFixture();
  const stored: SourceCandidateIngestionInput[] = [];
  const results = new Map<string, SourceCandidateIngestionInput>();
  const requests: string[] = [];
  const prompts: string[] = [];
  const modelSignals: AbortSignal[] = [];
  const candidates: SourceCandidateIngestionPort = {
    store: async (input, signal) => fixture.repository.transaction(async (tx) => {
      const run = await tx.getRun(input.runId, true);
      const source = await tx.getSource(input.sourceConfigId, true);
      if (!run || !source || source.status !== "enabled" || source.revision !== input.sourceRevision || run.kind !== input.kind) throw new DomainError("SOURCE_CONFIG_CHANGED", "fixture source changed", { status: 409 });
      assertExpectedRevision(run.revision, input.expectedRevision);
      assertRunLease(run, fixture.worker, input.leaseToken, fixture.clock.now());
      if (signal.aborted) throw new DomainError("SOURCE_WORKER_CANCELLED", "fixture canceled", { status: 409 });
      const ref = `persisted-${input.runId}`;
      stored.push(structuredClone(input)); results.set(ref, structuredClone(input));
      return { resultRef: ref };
    }),
    loadAnalysis: async (input, signal) => fixture.repository.transaction(async (tx) => {
      const run = await tx.getRun(input.runId, true);
      const source = await tx.getSource(input.sourceConfigId, true);
      if (!run || !source || source.status !== "enabled" || source.revision !== input.sourceRevision) throw new DomainError("SOURCE_CONFIG_CHANGED", "fixture source changed", { status: 409 });
      assertExpectedRevision(run.revision, input.expectedRevision);
      assertRunLease(run, fixture.worker, input.leaseToken, fixture.clock.now());
      if (signal.aborted) throw new DomainError("SOURCE_WORKER_CANCELLED", "fixture canceled", { status: 409 });
      const previous = stored.find((entry) => entry.runId === input.crawlRunId && entry.kind === "crawl");
      if (!previous || previous.kind !== "crawl" || previous.acquired.rawContentHash !== input.inputHash) throw new DomainError("SOURCE_EXTRACTION_INVALID", "fixture hash mismatch");
      return { inputHash: input.inputHash, targetUrl: previous.targetUrl, acquired: structuredClone(previous.acquired), candidates: structuredClone(previous.candidates) };
    }),
  };
  fixture.validation.validateCrawl = async (input) => {
    const result = results.get(input.resultRef);
    assert.equal(result?.runId, input.runId);
    if (!result || result.kind !== "crawl") throw new DomainError("INVALID_CANDIDATE_RESULT", "fixture result absent");
    return { resultRef: input.resultRef, inputHash: result.acquired.rawContentHash, eventSourceIds: [`m03-source-${input.runId}`], candidateRefs: [`m03-candidate-${input.runId}`], unchanged: false };
  };
  fixture.validation.validateAnalysis = async (input) => {
    const result = results.get(input.resultRef);
    if (!result || result.kind !== "analysis" || result.runId !== input.runId || result.inputHash !== input.inputHash) throw new DomainError("INVALID_CANDIDATE_RESULT", "fixture result absent");
    return { resultRef: input.resultRef, outputRef: `m03-analysis-${input.runId}`, ...result.model.usage };
  };
  const network: SourceWorkerNetworkPorts = {
    userAgent: "FieldBureauBot/1.0",
    dns: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async (input) => {
      requests.push(input.url);
      if (new URL(input.url).pathname === "/robots.txt") return { status: 404, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "" };
      return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/html", body: `<h1>${content}</h1><script>readCredentials()</script>` };
    } },
  };
  const model: SourceJsonModelPort = { modelVersion: "fixture-model-v1", promptVersion: "fixture-prompt-v1", generateJson: async (input) => {
    prompts.push(input.prompt); modelSignals.push(input.signal);
    assert.equal(input.input.sourceText, content);
    assert.equal(Object.hasOwn(input.input, "serviceCredential"), false);
    return { json: input.task === "source_crawl" ? rawExtraction() : rawAnalysis(), usage };
  } };
  const makeWorker = (heartbeatIntervalMs?: number) => createSourceWorker({ control: fixture.workers, serviceCredential: credential, clock: fixture.clock, candidates, model, network, ...(heartbeatIntervalMs ? { heartbeatIntervalMs } : {}) });
  const queue = (key = "executor-crawl", adapterVersion = SOURCE_CRAWL_ADAPTER_VERSION, timeoutMs?: number) => fixture.runs.enqueueCrawl(admin, { sourceConfigId: fixture.source.id, expectedSourceRevision: fixture.source.revision, targetUrl: draft.sampleUrl, adapterVersion, idempotencyKey: key, ...(timeoutMs ? { timeoutMs } : {}) });
  return { ...fixture, candidates, model, network, stored, results, requests, prompts, modelSignals, makeWorker, queue };
}

test("approved crawl executes robots, fetch, normalization, extraction and guarded candidate completion", async () => {
  const fixture = await workerFixture();
  const queued = await fixture.queue();
  const result = await fixture.makeWorker().execute(queued.id);
  assert.equal(result.status, "review_ready");
  assert.equal(fixture.requests[0], "https://events.hackathon.dev/robots.txt");
  assert.equal(fixture.requests[1], draft.sampleUrl);
  assert.equal(fixture.stored.length, 1);
  const inserted = fixture.stored[0];
  assert.equal(inserted.kind, "crawl");
  assert.equal(inserted.acquired.text.includes("readCredentials"), false);
  assert.equal(inserted.kind === "crawl" && inserted.candidates.verificationStatus, "unverified");
  assert.equal(inserted.expectedRevision, result.revision - 1);
  assert.match(fixture.prompts[0], /不可信数据/);
  const recorded = await fixture.runs.get(admin, queued.id);
  assert.deepEqual(recorded.history.map((entry) => entry.step), ["fetching", "normalizing", "extracting", "validating"]);
  assert.equal(typeof (fixture.makeWorker() as unknown as { publish?: unknown }).publish, "undefined");
});
test("robots disallow and redirect destination policy stop before unauthorized page acquisition", async () => {
  const fixture = await workerFixture();
  fixture.network.transport.request = async (input) => {
    fixture.requests.push(input.url);
    return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nDisallow: /rules" };
  };
  const queued = await fixture.queue();
  const result = await fixture.makeWorker().execute(queued.id);
  assert.equal(result.status, "failed");
  assert.equal((await fixture.runs.get(admin, queued.id)).failures[0].category, "access_denied");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.stored.length, 0);
  const redirect = await workerFixture();
  redirect.network.transport.request = async (input) => {
    redirect.requests.push(input.url);
    if (new URL(input.url).pathname === "/robots.txt") return { status: 404, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "" };
    return { status: 302, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "https://127.0.0.1/private" };
  };
  const redirected = await redirect.queue();
  const stopped = await redirect.makeWorker().execute(redirected.id);
  assert.equal(stopped.status, "failed");
  assert.equal(redirect.requests.some((url) => url.includes("127.0.0.1")), false);
});
test("each approved redirect path receives a fresh robots check before page fetching", async () => {
  const fixture = await workerFixture();
  let robotsCalls = 0;
  fixture.network.transport.request = async (input) => {
    fixture.requests.push(input.url);
    const path = new URL(input.url).pathname;
    if (path === "/robots.txt") { robotsCalls += 1; return { status: 200, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "User-agent: *\nDisallow: /rules/restricted" }; }
    return { status: 302, connectedAddress: "93.184.216.34", contentType: "text/html", body: "", location: "/rules/restricted" };
  };
  const queued = await fixture.queue();
  const result = await fixture.makeWorker().execute(queued.id);
  assert.equal(result.status, "failed");
  assert.equal(robotsCalls, 2);
  assert.equal(fixture.requests.some((url) => url.endsWith("/rules/restricted")), false);
});
test("serial heartbeats renew during model work and candidate ingestion receives latest revision", async () => {
  const fixture = await workerFixture();
  const originalModel = fixture.model.generateJson;
  fixture.model.generateJson = async (input) => { await sleep(35); return originalModel(input); };
  const queued = await fixture.queue();
  const result = await fixture.makeWorker(5).execute(queued.id);
  assert.equal(result.status, "review_ready");
  assert.ok(fixture.repository.audits.some((audit) => audit.action === "RunLeaseRenewed"));
  assert.ok(result.revision > 6);
  assert.equal(fixture.stored[0].expectedRevision, result.revision - 1);
  assert.equal((await fixture.runs.get(admin, queued.id)).failures.length, 0);
});
test("unconfigured/invalid model outputs and unsupported adapters stop without paid automatic retry", async () => {
  const invalid = await workerFixture();
  invalid.model.generateJson = async () => ({ json: { verified: true }, usage });
  const invalidRun = await invalid.queue();
  assert.equal((await invalid.makeWorker().execute(invalidRun.id)).status, "failed");
  assert.equal((await invalid.runs.get(admin, invalidRun.id)).failures[0].category, "parse_error");
  assert.equal(invalid.stored.length, 0);
  const unavailable = await workerFixture();
  unavailable.model.generateJson = async () => { throw new DomainError("DSH_NOT_CONFIGURED", "provider unavailable", { status: 503 }); };
  const unavailableRun = await unavailable.queue();
  assert.equal((await unavailable.makeWorker().execute(unavailableRun.id)).status, "failed");
  assert.equal((await unavailable.runs.get(admin, unavailableRun.id)).failures[0].category, "parse_error");
  const unsupported = await workerFixture();
  const unsupportedRun = await unsupported.queue("bad-version", "arbitrary-script-v2");
  assert.equal((await unsupported.makeWorker().execute(unsupportedRun.id)).status, "failed");
  assert.equal(unsupported.requests.length, 0);
  assert.throws(() => createSourceWorker({ control: unsupported.workers, serviceCredential: credential, clock: unsupported.clock, candidates: unsupported.candidates, network: unsupported.network, model: undefined as unknown as SourceJsonModelPort }), { code: "SOURCE_MODEL_UNCONFIGURED" });
});
test("external abort stops a started model terminally with no candidate writes or automatic paid retry", async () => {
  const fixture = await workerFixture();
  let modelEntered = () => {};
  const entered = new Promise<void>((resolve) => { modelEntered = resolve; });
  let modelSignal: AbortSignal | undefined;
  fixture.model.generateJson = async (input) => { modelSignal = input.signal; modelEntered(); return new Promise(() => {}); };
  const queued = await fixture.queue();
  const controller = new AbortController();
  const executing = fixture.makeWorker(5).execute(queued.id, { signal: controller.signal });
  await entered;
  controller.abort();
  const result = await executing;
  assert.equal(result.status, "failed");
  assert.equal(modelSignal?.aborted, true);
  assert.equal((await fixture.runs.get(admin, queued.id)).failures[0].category, "parse_error");
  assert.equal(fixture.stored.length, 0);
});
test("remote run cancellation revokes heartbeat and aborts model without overwriting cancelled state", async () => {
  const fixture = await workerFixture();
  let enter = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let modelSignal: AbortSignal | undefined;
  fixture.model.generateJson = async (input) => { modelSignal = input.signal; enter(); return new Promise(() => {}); };
  const queued = await fixture.queue();
  const executing = fixture.makeWorker(5).execute(queued.id);
  await entered;
  const running = await fixture.runs.get(admin, queued.id);
  await fixture.runs.cancel(admin, queued.id, { expectedRevision: running.revision, reason: "用户停止" });
  await assert.rejects(executing, (error: unknown) => error instanceof DomainError && ["WORKER_LEASE_LOST", "VERSION_CONFLICT"].includes(error.code));
  assert.equal(modelSignal?.aborted, true);
  assert.equal((await fixture.runs.get(admin, queued.id)).status, "cancelled");
  assert.equal(fixture.stored.length, 0);
});
test("analysis uses immutable crawl input and stores bounded model usage without fetching again", async () => {
  const fixture = await workerFixture();
  const crawl = await fixture.queue();
  await fixture.makeWorker().execute(crawl.id);
  const crawlRecord = await fixture.runs.get(admin, crawl.id);
  assert.equal(crawlRecord.kind, "crawl");
  if (crawlRecord.kind !== "crawl" || !crawlRecord.output) throw new Error("fixture crawl not complete");
  const queued = await fixture.runs.enqueueAnalysis(admin, { crawlRunId: crawl.id, inputHash: crawlRecord.output.inputHash, schemaVersion: SOURCE_ANALYSIS_SCHEMA_VERSION, modelVersion: fixture.model.modelVersion, promptVersion: fixture.model.promptVersion, idempotencyKey: "executor-analysis" });
  const fetchCount = fixture.requests.length;
  const result = await fixture.makeWorker().execute(queued.id);
  assert.equal(result.status, "succeeded");
  assert.equal(fixture.requests.length, fetchCount);
  assert.equal(fixture.stored[1].kind, "analysis");
  const analysis = await fixture.runs.get(admin, queued.id);
  assert.equal(analysis.kind === "analysis" && analysis.output?.inputTokens, usage.inputTokens);
  assert.equal(fixture.stored[1].kind === "analysis" && fixture.stored[1].analysis.verificationStatus, "unverified");
});
test("deadline aborts a stuck model terminally rather than repeating an unknown paid request", async () => {
  const fixture = await workerFixture();
  const start = fixture.clock.now().getTime();
  const wallStart = Date.now();
  fixture.clock.now = () => new Date(start + Date.now() - wallStart);
  let modelSignal: AbortSignal | undefined;
  fixture.model.generateJson = async (input) => { modelSignal = input.signal; return new Promise(() => {}); };
  const queued = await fixture.queue("deadline-crawl", SOURCE_CRAWL_ADAPTER_VERSION, 1000);
  const result = await fixture.makeWorker(10).execute(queued.id);
  assert.equal(result.status, "failed");
  assert.equal(modelSignal?.aborted, true);
  assert.equal((await fixture.runs.get(admin, queued.id)).failures[0].category, "parse_error");
  assert.equal(fixture.stored.length, 0);
});
test("failure mapping retains retry categories without leaking provider errors", () => {
  assert.equal(sourceWorkerFailureCategory(new DomainError("FETCH_RATE_LIMITED", "private response"), "fetching"), "rate_limited");
  assert.equal(sourceWorkerFailureCategory(new DomainError("FETCH_TIMEOUT", "private response"), "fetching"), "timeout");
  assert.equal(sourceWorkerFailureCategory(new Error("secret provider message"), "extracting"), "provider_unavailable");
  assert.equal(sourceWorkerFailureCategory(new DomainError("DSH_TIMEOUT", "unknown paid result"), "extracting", true), "parse_error");
});
test("DSH timeout, provider exception and unknown model outcome are terminal at attempt one", async () => {
  class AiProviderError extends Error { override name = "AiProviderError"; }
  for (const error of [new DomainError("DSH_TIMEOUT", "unknown paid outcome", { status: 503 }), new AiProviderError("request outcome unknown"), new Error("provider status unknown")]) {
    const fixture = await workerFixture();
    let requests = 0;
    fixture.model.generateJson = async () => { requests += 1; throw error; };
    const queued = await fixture.queue();
    const result = await fixture.makeWorker().execute(queued.id);
    assert.equal(result.status, "failed");
    assert.equal(result.attempt, 1);
    const failure = (await fixture.runs.get(admin, queued.id)).failures[0];
    assert.equal(failure.category, "parse_error");
    assert.equal(failure.retryable, false);
    fixture.clock.advance(300_000);
    await assert.rejects(fixture.workers.claim(credential, queued.id), { code: "RUN_NOT_CLAIMABLE" });
    assert.equal(requests, 1);
    assert.equal(fixture.stored.length, 0);
  }
});
test("public DNS, HTTP server and fetch timeout failures remain retryable before model requests", async () => {
  for (const kind of ["dns", "server", "timeout"] as const) {
    const fixture = await workerFixture();
    let modelRequests = 0;
    fixture.model.generateJson = async () => { modelRequests += 1; return { json: rawExtraction(), usage }; };
    if (kind === "dns") fixture.network.dns.resolve = async () => { throw new DomainError("FETCH_UNAVAILABLE", "public DNS unavailable", { status: 503 }); };
    else fixture.network.transport.request = async (input) => {
      if (new URL(input.url).pathname === "/robots.txt") return { status: 404, connectedAddress: "93.184.216.34", contentType: "text/plain", body: "" };
      if (kind === "timeout") throw new DomainError("FETCH_TIMEOUT", "public source timeout", { status: 503 });
      return { status: 502, connectedAddress: "93.184.216.34", contentType: "text/html", body: "" };
    };
    const queued = await fixture.queue();
    const result = await fixture.makeWorker().execute(queued.id);
    assert.equal(result.status, "queued");
    assert.equal((await fixture.runs.get(admin, queued.id)).failures[0].retryable, true);
    assert.equal(modelRequests, 0);
    assert.equal(fixture.stored.length, 0);
  }
});
