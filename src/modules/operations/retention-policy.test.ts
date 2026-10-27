import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createRetentionPolicy, evaluateRetention, PERMANENT_RETENTION_KINDS, retentionPolicyFingerprint } from "./retention-policy.ts";
import type { RetentionArtifactKind, RetentionInspection, RetentionPolicy } from "./retention-policy.ts";
import { createRetentionService, RETENTION_MAX_PAGE_SIZE } from "./retention-policy-service.ts";
import type { RetentionCleanupAudit, RetentionCleanupPort, RetentionCleanupRequest, RetentionCleanupTransaction,
  RetentionScan, RetentionScanPage, TemporaryPayloadClearInput, TemporaryPayloadClearResult,
  VerifiedRetentionIdentity } from "./retention-policy-service.ts";
import { createRetentionWorker } from "./retention-policy-worker.ts";

const NOW = "2026-10-10T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };
const clone = <T>(value: T): T => structuredClone(value);
const serviceIdentity: VerifiedRetentionIdentity = { id: "retention-worker", kind: "operations_retention_worker",
  capabilities: ["retention_dry_run", "retention_cleanup"], sourceConfigIds: ["source-a"] };
function artifact(id = "artifact-a", patch: Partial<RetentionInspection> = {}): RetentionInspection {
  return { artifact: { id, sourceConfigId: "source-a", runId: "run-a", kind: "temporary_original_text", revision: 1,
    createdAt: "2026-08-01T12:00:00.000Z", byteLength: 500, adoptionState: "unadopted", payloadState: "present" },
  referenceState: "unreferenced", modelRequestState: "clear", runState: "terminal", ...patch };
}
/** Isolated fixture. Its body map and fake holds are never production persistence. */
class RetentionFixture implements RetentionCleanupPort, RetentionCleanupTransaction {
  policy: RetentionPolicy = createRetentionPolicy();
  artifacts = new Map<string, RetentionInspection>();
  bodies = new Map<string, string>();
  audits: RetentionCleanupAudit[] = [];
  identity: VerifiedRetentionIdentity | null = clone(serviceIdentity);
  immutableHold = { requestId: "paid-request-a", outcome: "unknown", fingerprint: "immutable-hash", attempt: 1, reservedMicros: 1000 };
  authorizations = 0;
  listCalls: RetentionScan[] = [];
  clearCalls: TemporaryPayloadClearInput[] = [];
  inspectionCalls: string[] = [];
  failAudit = false;
  beforeInspect: ((id: string) => void) | null = null;
  beforeClear: ((id: string) => void) | null = null;
  beforeAuthorize: ((count: number) => void) | null = null;
  pageOverride: RetentionScanPage | null = null;
  clearResultOverride: TemporaryPayloadClearResult | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(initial: readonly RetentionInspection[] = [artifact()]) {
    for (const value of initial) { this.artifacts.set(value.artifact.id, clone(value)); this.bodies.set(value.artifact.id, "private raw body; token=do-not-return"); }
  }
  async transaction<T>(work: (tx: RetentionCleanupTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const before = clone({ artifacts: this.artifacts, bodies: this.bodies, audits: this.audits, immutableHold: this.immutableHold });
    try { return await work(this); }
    catch (error) { this.artifacts = before.artifacts; this.bodies = before.bodies; this.audits = before.audits; this.immutableHold = before.immutableHold; throw error; }
    finally { release(); }
  }
  async authorize(credential: string): Promise<VerifiedRetentionIdentity | null> {
    this.authorizations += 1;
    this.beforeAuthorize?.(this.authorizations);
    return credential === "service-secret" ? clone(this.identity) : null;
  }
  async listExpiredTemporaryPage(input: RetentionScan): Promise<RetentionScanPage> {
    this.listCalls.push(clone(input));
    if (this.pageOverride) return clone(this.pageOverride);
    const rows = [...this.artifacts.values()].filter(value => {
      const item = value.artifact;
      if (input.allowedSourceConfigIds !== null && !input.allowedSourceConfigIds.includes(item.sourceConfigId)) return false;
      if (input.sourceConfigId && item.sourceConfigId !== input.sourceConfigId) return false;
      if (input.kind && item.kind !== input.kind) return false;
      if (item.kind !== "temporary_original_text" && item.kind !== "temporary_preview") return false;
      if (item.createdAt > input.createdAtCutoffs[item.kind]) return false;
      if (input.after && !(item.createdAt > input.after.createdAt || (item.createdAt === input.after.createdAt && item.id > input.after.artifactId))) return false;
      return true;
    }).sort((left, right) => left.artifact.createdAt < right.artifact.createdAt ? -1 : left.artifact.createdAt > right.artifact.createdAt ? 1
      : left.artifact.id < right.artifact.id ? -1 : left.artifact.id > right.artifact.id ? 1 : 0);
    return { items: clone(rows.slice(0, input.limit)), hasMore: rows.length > input.limit };
  }
  async lockAndInspectTemporaryArtifact(id: string): Promise<RetentionInspection | null> {
    this.inspectionCalls.push(id);
    this.beforeInspect?.(id);
    return clone(this.artifacts.get(id) ?? null);
  }
  async clearTemporaryPayload(input: TemporaryPayloadClearInput): Promise<TemporaryPayloadClearResult> {
    this.clearCalls.push(clone(input));
    if (this.clearResultOverride) return clone(this.clearResultOverride);
    this.beforeClear?.(input.artifactId);
    const value = this.artifacts.get(input.artifactId);
    if (!value) return { status: "kept", reason: "missing" };
    if (value.artifact.revision !== input.expectedRevision || value.artifact.createdAt !== input.expectedCreatedAt || value.artifact.kind !== input.kind) return { status: "kept", reason: "version_changed" };
    // Fixture repeats the SQL adapter's guarded final check after the inspection race.
    const decision = evaluateRetention(this.policy, value, new Date(input.clearedAt));
    if (decision.action !== "clear_temporary_payload") return { status: "kept", reason: decision.reason as Exclude<typeof decision.reason, "eligible"> };
    if (value.artifact.createdAt > input.createdAtCutoff) return { status: "kept", reason: "guard_changed" };
    this.bodies.delete(input.artifactId);
    this.artifacts.set(input.artifactId, { ...value, artifact: { ...value.artifact, revision: value.artifact.revision + 1, payloadState: "cleared" } });
    return { status: "cleared", revision: value.artifact.revision + 1, clearedBytes: value.artifact.byteLength };
  }
  async appendCleanupAudit(event: RetentionCleanupAudit): Promise<void> {
    if (this.failAudit) throw new Error("fixture audit failure");
    this.audits.push(clone(event));
  }
  patch(id: string, change: Partial<RetentionInspection>): void {
    this.artifacts.set(id, { ...this.artifacts.get(id)!, ...change });
  }
}
function fixture(initial?: readonly RetentionInspection[], policy?: RetentionPolicy) {
  const cleanup = new RetentionFixture(initial);
  if (policy) cleanup.policy = policy;
  let id = 0;
  const service = createRetentionService({ cleanup, clock, ids: { next: () => `audit-${++id}` }, ...(policy ? { policy } : {}) });
  return { cleanup, service, request: (candidates: RetentionCleanupRequest["candidates"] = [{ artifactId: "artifact-a", expectedRevision: 1 }]): RetentionCleanupRequest => ({
    expectedPolicyFingerprint: retentionPolicyFingerprint(cleanup.policy), candidates,
  }) };
}
function errorCode(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

test("default retention is provisional and each configured TTL records its origin", () => {
  const defaults = createRetentionPolicy();
  assert.deepEqual(defaults.rules.temporary_original_text, { keepDays: 30, origin: "module_default_provisional" });
  assert.deepEqual(defaults.rules.temporary_preview, { keepDays: 7, origin: "module_default_provisional" });
  const configured = createRetentionPolicy({ originalTextDays: 14 });
  assert.deepEqual(configured.rules.temporary_original_text, { keepDays: 14, origin: "deployment_config" });
  assert.equal(configured.rules.temporary_preview.origin, "module_default_provisional");
  for (const value of [0, -1, 1.1, 3651, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => createRetentionPolicy({ previewDays: value }), errorCode("INVALID_RETENTION_POLICY"));
});
test("formal evidence, immutable snapshots, reviews, unknown holds, budgets and navigation history are permanent", () => {
  for (const kind of PERMANENT_RETENTION_KINDS) {
    const value = artifact();
    const decision = evaluateRetention(createRetentionPolicy(), { ...value, artifact: { ...value.artifact, kind } }, new Date(NOW));
    assert.equal(decision.reason, "permanent_record", kind);
    assert.equal(decision.action, "keep", kind);
    assert.equal(decision.expiresAt, null, kind);
  }
});
test("temporary TTL starts at original creation and expires at exact UTC boundary", () => {
  const value = artifact();
  const policy = createRetentionPolicy({ originalTextDays: 1 });
  const input = { ...value, artifact: { ...value.artifact, createdAt: "2026-10-09T12:00:00.000Z" } };
  assert.equal(evaluateRetention(policy, input, new Date(NOW)).action, "clear_temporary_payload");
  assert.equal(evaluateRetention(policy, input, new Date(Date.parse(NOW) - 1)).reason, "not_expired");
});
test("all uncertain or protected facts fail closed", () => {
  const cases: readonly [Partial<RetentionInspection>, string][] = [
    [{ referenceState: "referenced" }, "referenced"], [{ referenceState: "unknown" }, "references_unknown"],
    [{ modelRequestState: "unknown_hold" }, "unknown_model_hold"], [{ modelRequestState: "unknown" }, "model_hold_unknown"],
    [{ runState: "active" }, "run_active"], [{ runState: "unknown" }, "run_state_unknown"],
    [{ artifact: { ...artifact().artifact, adoptionState: "adopted" } }, "adopted"],
    [{ artifact: { ...artifact().artifact, adoptionState: "unknown" } }, "adoption_unknown"],
    [{ artifact: { ...artifact().artifact, payloadState: "unknown" } }, "payload_unknown"],
    [{ artifact: { ...artifact().artifact, payloadState: "cleared" } }, "already_cleared"],
    [{ artifact: { ...artifact().artifact, revision: 0 } }, "invalid_metadata"],
  ];
  for (const [patch, reason] of cases) {
    const decision = evaluateRetention(createRetentionPolicy(), artifact("artifact-a", patch), new Date(NOW));
    assert.equal(decision.reason, reason); assert.equal(decision.action, "keep");
  }
});
test("dry-run is metadata-only, counts eligible bytes and never locks/clears/appends audits", async () => {
  const visible = artifact();
  const hostile = { ...visible, body: "private body", errorLog: "secret-log", credential: "service-secret" };
  const { cleanup, service } = fixture([hostile]);
  const holdBefore = clone(cleanup.immutableHold);
  const result = await service.preview("service-secret");
  assert.equal(result.mode, "dry_run"); assert.equal(result.eligibleBytes, 500);
  assert.equal(result.items[0].action, "clear_temporary_payload");
  assert.equal(cleanup.clearCalls.length, 0); assert.equal(cleanup.inspectionCalls.length, 0); assert.equal(cleanup.audits.length, 0);
  assert.equal(cleanup.bodies.size, 1); assert.deepEqual(cleanup.immutableHold, holdBefore);
  for (const forbidden of ["private body", "secret-log", "service-secret", "errorLog", "credential"]) assert.equal(JSON.stringify(result).includes(forbidden), false);
});
test("only verified maintenance service identity can preview/cleanup and permission precedes metadata reads", async () => {
  const { cleanup, service, request } = fixture();
  await assert.rejects(service.preview("ordinary-user"), errorCode("RETENTION_SERVICE_FORBIDDEN"));
  await assert.rejects(service.cleanup("ordinary-user", request()), errorCode("RETENTION_SERVICE_FORBIDDEN"));
  assert.equal(cleanup.listCalls.length, 0); assert.equal(cleanup.inspectionCalls.length, 0);
  cleanup.identity = { ...serviceIdentity, capabilities: ["retention_dry_run"] };
  await assert.rejects(service.cleanup("service-secret", request()), errorCode("RETENTION_SERVICE_FORBIDDEN"));
  assert.equal(cleanup.clearCalls.length, 0);
});
test("source scope is applied to scans and unauthorized source cleanup cannot disclose metadata", async () => {
  const other = artifact("artifact-b", { artifact: { ...artifact().artifact, id: "artifact-b", sourceConfigId: "source-b" } });
  const { cleanup, service, request } = fixture([artifact(), other]);
  const result = await service.preview("service-secret");
  assert.deepEqual(result.items.map(item => item.artifactId), ["artifact-a"]);
  assert.deepEqual(cleanup.listCalls[0].allowedSourceConfigIds, ["source-a"]);
  await assert.rejects(service.preview("service-secret", { sourceConfigId: "source-b" }), errorCode("RETENTION_SERVICE_FORBIDDEN"));
  await assert.rejects(service.cleanup("service-secret", request([{ artifactId: "artifact-b", expectedRevision: 1 }])), errorCode("RETENTION_SERVICE_FORBIDDEN"));
  assert.equal(cleanup.clearCalls.length, 0);
});
test("cursor is bounded, ordered, tied to policy/scope/filter, and does not duplicate rows", async () => {
  const { cleanup, service } = fixture([artifact("artifact-a"), artifact("artifact-b"), artifact("artifact-c")]);
  const first = await service.preview("service-secret", { limit: 1 });
  assert.equal(first.items[0].artifactId, "artifact-a"); assert.ok(first.nextCursor);
  const second = await service.preview("service-secret", { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].artifactId, "artifact-b"); assert.equal(second.evaluatedAt, first.evaluatedAt);
  assert.deepEqual(cleanup.listCalls[1].after, { createdAt: artifact().artifact.createdAt, artifactId: "artifact-a" });
  await assert.rejects(service.preview("service-secret", { cursor: first.nextCursor, kind: "temporary_preview" }), errorCode("INVALID_RETENTION_QUERY"));
  cleanup.identity = { ...serviceIdentity, sourceConfigIds: null };
  await assert.rejects(service.preview("service-secret", { cursor: first.nextCursor }), errorCode("INVALID_RETENTION_QUERY"));
  for (const cursor of ["bad*cursor", "a".repeat(2049), Buffer.from("{}").toString("base64url")]) await assert.rejects(service.preview("service-secret", { cursor }), errorCode("INVALID_RETENTION_QUERY"));
});
test("page size and cleanup batches reject unbounded, duplicated or invalid inputs", async () => {
  const { cleanup, service, request } = fixture();
  for (const limit of [0, -1, RETENTION_MAX_PAGE_SIZE + 1, 1.5]) await assert.rejects(service.preview("service-secret", { limit }), errorCode("INVALID_RETENTION_QUERY"));
  await assert.rejects(service.cleanup("service-secret", request([])), errorCode("INVALID_RETENTION_QUERY"));
  await assert.rejects(service.cleanup("service-secret", request(Array.from({ length: 101 }, (_, i) => ({ artifactId: `artifact-${i}`, expectedRevision: 1 })))), errorCode("INVALID_RETENTION_QUERY"));
  await assert.rejects(service.cleanup("service-secret", request([{ artifactId: "artifact-a", expectedRevision: 1 }, { artifactId: "artifact-a", expectedRevision: 1 }])), errorCode("INVALID_RETENTION_QUERY"));
  assert.equal(cleanup.clearCalls.length, 0); assert.equal(cleanup.listCalls.length, 0);
});
test("malformed root page ordering/bounds are rejected rather than trusted", async () => {
  const { cleanup, service } = fixture();
  cleanup.pageOverride = { items: [artifact("artifact-b"), artifact("artifact-a")], hasMore: false };
  await assert.rejects(service.preview("service-secret"), errorCode("RETENTION_PORT_INVALID"));
  cleanup.pageOverride = { items: [artifact("artifact-a"), artifact("artifact-b")], hasMore: false };
  await assert.rejects(service.preview("service-secret", { limit: 1 }), errorCode("RETENTION_PORT_INVALID"));
  cleanup.pageOverride = { items: [], hasMore: true };
  await assert.rejects(service.preview("service-secret"), errorCode("RETENTION_PORT_INVALID"));
});
test("root metadata kind/revision and CAS reason cannot disclose arbitrary source or log text", async () => {
  const { cleanup, service, request } = fixture();
  const valid = artifact();
  for (const patch of [{ kind: "private raw text: api-key" as RetentionArtifactKind }, { revision: "private log body" as unknown as number }]) {
    cleanup.pageOverride = { items: [{ ...valid, artifact: { ...valid.artifact, ...patch } }], hasMore: false };
    await assert.rejects(service.preview("service-secret"), errorCode("RETENTION_PORT_INVALID"));
  }
  cleanup.clearResultOverride = { status: "kept", reason: "private raw log: api-key" as never };
  await assert.rejects(service.cleanup("service-secret", request()), errorCode("RETENTION_PORT_INVALID"));
  assert.equal(cleanup.bodies.size, 1); assert.equal(cleanup.audits.length, 0);
});
test("eligible clear leaves metadata/tombstone, increments revision and appends minimal audit atomically", async () => {
  const { cleanup, service, request } = fixture();
  const holdBefore = clone(cleanup.immutableHold);
  const result = await service.cleanup("service-secret", request());
  assert.deepEqual(result.items, [{ artifactId: "artifact-a", status: "cleared", reason: "eligible", revision: 2, clearedBytes: 500 }]);
  assert.equal(result.clearedBytes, 500); assert.equal(cleanup.bodies.size, 0);
  assert.equal(cleanup.artifacts.get("artifact-a")?.artifact.payloadState, "cleared");
  assert.equal(cleanup.artifacts.get("artifact-a")?.artifact.createdAt, artifact().artifact.createdAt);
  assert.deepEqual(cleanup.immutableHold, holdBefore);
  assert.equal(cleanup.audits.length, 1); assert.equal(cleanup.audits[0].beforeRevision, 1); assert.equal(cleanup.audits[0].revision, 2);
  assert.equal(cleanup.audits[0].policyOrigin, "module_default_provisional");
  assert.equal(JSON.stringify(result).includes("service-secret"), false); assert.equal(JSON.stringify(cleanup.audits).includes("private"), false);
  const repeated = await service.cleanup("service-secret", request([{ artifactId: "artifact-a", expectedRevision: 2 }]));
  assert.equal(repeated.items[0].reason, "already_cleared"); assert.equal(cleanup.audits.length, 1);
});
test("reference inserted after dry-run is found by the lock-time inspection", async () => {
  const { cleanup, service, request } = fixture();
  await service.preview("service-secret");
  cleanup.beforeInspect = id => cleanup.patch(id, { referenceState: "referenced" });
  const result = await service.cleanup("service-secret", request());
  assert.equal(result.items[0].reason, "referenced"); assert.equal(cleanup.clearCalls.length, 0); assert.equal(cleanup.bodies.size, 1);
});
test("revision changed after dry-run is preserved without calling destructive port", async () => {
  const { cleanup, service, request } = fixture();
  cleanup.beforeInspect = id => cleanup.patch(id, { artifact: { ...cleanup.artifacts.get(id)!.artifact, revision: 2 } });
  const result = await service.cleanup("service-secret", request());
  assert.equal(result.items[0].reason, "version_changed"); assert.equal(result.items[0].revision, 2);
  assert.equal(cleanup.clearCalls.length, 0); assert.equal(cleanup.bodies.size, 1);
});
test("unknown paid-request hold after dry-run is preserved and never replays or mutates its ledger", async () => {
  const { cleanup, service, request } = fixture();
  await service.preview("service-secret");
  const holdBefore = clone(cleanup.immutableHold);
  cleanup.beforeInspect = id => cleanup.patch(id, { modelRequestState: "unknown_hold" });
  const result = await service.cleanup("service-secret", request());
  assert.equal(result.items[0].reason, "unknown_model_hold"); assert.equal(cleanup.clearCalls.length, 0);
  assert.deepEqual(cleanup.immutableHold, holdBefore); assert.equal(cleanup.bodies.size, 1);
});
test("root final CAS rechecks reference/version/hold races after service inspection", async () => {
  for (const race of ["reference", "revision", "hold"] as const) {
    const { cleanup, service, request } = fixture();
    cleanup.beforeClear = id => cleanup.patch(id, race === "reference" ? { referenceState: "referenced" }
      : race === "hold" ? { modelRequestState: "unknown_hold" } : { artifact: { ...cleanup.artifacts.get(id)!.artifact, revision: 2 } });
    const result = await service.cleanup("service-secret", request());
    assert.equal(result.items[0].status, "kept", race); assert.equal(cleanup.bodies.size, 1, race); assert.equal(cleanup.audits.length, 0, race);
    assert.equal(result.items[0].revision, null, "final guard cannot attest the current version");
  }
});
test("permanent records and unknown relationship coverage never reach destructive port", async () => {
  const kinds: readonly RetentionArtifactKind[] = [...PERMANENT_RETENTION_KINDS, "temporary_original_text"];
  const initial = kinds.map((kind, index) => artifact(`artifact-${index}`, {
    artifact: { ...artifact().artifact, id: `artifact-${index}`, kind }, referenceState: "unknown",
  }));
  const { cleanup, service, request } = fixture(initial);
  const result = await service.cleanup("service-secret", request(initial.map(value => ({ artifactId: value.artifact.id, expectedRevision: 1 }))));
  assert.ok(result.items.every(item => item.status === "kept")); assert.equal(cleanup.clearCalls.length, 0);
  assert.equal(cleanup.bodies.size, initial.length);
});
test("policy changed from preview requires a fresh dry-run", async () => {
  const { cleanup, service, request } = fixture();
  await assert.rejects(service.cleanup("service-secret", { ...request(), expectedPolicyFingerprint: "old-policy" }), errorCode("RETENTION_POLICY_CHANGED"));
  assert.equal(cleanup.authorizations, 0); assert.equal(cleanup.clearCalls.length, 0);
});
test("failed audit and mid-transaction permission revocation each roll back body removal", async () => {
  const first = fixture(); first.cleanup.failAudit = true;
  await assert.rejects(first.service.cleanup("service-secret", first.request()), /fixture audit failure/);
  assert.equal(first.cleanup.bodies.size, 1); assert.equal(first.cleanup.artifacts.get("artifact-a")?.artifact.revision, 1); assert.equal(first.cleanup.audits.length, 0);
  const second = fixture();
  second.cleanup.beforeAuthorize = count => { if (count === 3) second.cleanup.identity = null; };
  await assert.rejects(second.service.cleanup("service-secret", second.request()), errorCode("RETENTION_SERVICE_FORBIDDEN"));
  assert.equal(second.cleanup.bodies.size, 1); assert.equal(second.cleanup.artifacts.get("artifact-a")?.artifact.revision, 1); assert.equal(second.cleanup.audits.length, 0);
});
test("worker requires explicit cleanup call and prevents overlapping maintenance invocations", async () => {
  const { cleanup, service, request } = fixture();
  let releaseCredential: (value: string) => void = () => {};
  const credential = new Promise<string>(resolve => { releaseCredential = resolve; });
  const worker = createRetentionWorker({ service, getServiceCredential: () => credential });
  const preview = worker.dryRunOnce();
  await assert.rejects(worker.cleanupOnce(request()), errorCode("RETENTION_WORKER_BUSY"));
  releaseCredential("service-secret"); await preview;
  assert.equal(cleanup.clearCalls.length, 0);
  const result = await worker.cleanupOnce(request());
  assert.equal(result.clearedBytes, 500);
});
