/** TEST FIXTURE ONLY: never wire this repository into actual trial endpoints. */
import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ExecutionAudit, SourceConfig, SourceDraft } from "./source-domain.ts";
import type { CandidateValidationPort, ExecutionKind, ExecutionRun, VerifiedWorkerIdentity, WorkerIdentityPort } from "./run-domain.ts";
import type { OperationsExecutionRepository, OperationsExecutionTransaction } from "./run-repository.ts";
import { SourceService } from "./source-service.ts";
import { RunService, WorkerRunService } from "./run-service.ts";

const copy = <T>(value: T): T => structuredClone(value);
export const admin: Actor = { userId: "administrator", platformRoles: ["admin"] };
export const reviewer: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
export const ordinaryUser: Actor = { userId: "ordinary-user", platformRoles: ["user"] };
export const draft: SourceDraft = { name: "主办方规则", ownerUserId: "administrator", type: "official_rules", acquisitionMethod: "restricted_http", sampleUrl: "https://events.hackathon.dev/rules/current", minimumIntervalSeconds: 300, networkPolicy: { version: 1, rules: [{ hostname: "events.hackathon.dev", pathPrefix: "/rules" }], maxRedirects: 2, maxBytes: 1024, timeoutMs: 1000, acceptedContentTypes: ["text/html", "text/plain"] } };
export class MutableClock implements Clock {
  private time = Date.parse("2026-10-08T12:00:00Z");
  now(): Date { return new Date(this.time); }
  advance(ms: number): void { this.time += ms; }
}
export class SequenceIds implements IdGenerator {
  private number = 0;
  next(): string { this.number += 1; return `fixture-${this.number}`; }
}
export class ExecutionTestRepository implements OperationsExecutionRepository, OperationsExecutionTransaction {
  sources = new Map<string, SourceConfig>();
  runs = new Map<string, ExecutionRun>();
  aliases = new Map<string, { runId: string; fingerprint: string }>();
  audits: ExecutionAudit[] = [];
  failAudit = false;
  locks: { entity: "source" | "run"; id: string }[] = [];
  private tail: Promise<void> = Promise.resolve();
  async transaction<T>(work: (tx: OperationsExecutionTransaction) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    const before = copy({ sources: this.sources, runs: this.runs, aliases: this.aliases, audits: this.audits });
    try { return await work(this); }
    catch (error) { this.sources = before.sources; this.runs = before.runs; this.aliases = before.aliases; this.audits = before.audits; throw error; }
    finally { release(); }
  }
  async acquireLock(_key: string): Promise<void> { /* fixture serializes transactions */ }
  async getSource(id: string, lock = false): Promise<SourceConfig | null> { if (lock) this.locks.push({ entity: "source", id }); return copy(this.sources.get(id) ?? null); }
  async listSources(limit: number): Promise<readonly SourceConfig[]> { return copy([...this.sources.values()].slice(0, limit)); }
  async insertSource(source: SourceConfig): Promise<void> { if (this.sources.has(source.id)) throw new Error("duplicate source"); this.sources.set(source.id, copy(source)); }
  async saveSource(source: SourceConfig, expectedRevision: number): Promise<void> { if (this.sources.get(source.id)?.revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "fixture CAS", { status: 409 }); this.sources.set(source.id, copy(source)); }
  async reserveSourceInterval(sourceId: string, nextEligibleAt: string): Promise<void> {
    const source = this.sources.get(sourceId)!;
    const next = source.health.nextEligibleAt && source.health.nextEligibleAt > nextEligibleAt ? source.health.nextEligibleAt : nextEligibleAt;
    this.sources.set(sourceId, { ...source, health: { ...source.health, nextEligibleAt: next } });
  }
  async recordSourceHealth(sourceId: string, success: boolean, at: string): Promise<void> {
    const source = this.sources.get(sourceId)!;
    this.sources.set(sourceId, { ...source, health: { ...source.health, ...(success ? { lastSuccessAt: at, consecutiveFailures: 0 } : { lastFailureAt: at, consecutiveFailures: source.health.consecutiveFailures + 1 }) } });
  }
  async getRun(id: string, lock = false): Promise<ExecutionRun | null> { if (lock) this.locks.push({ entity: "run", id }); return copy(this.runs.get(id) ?? null); }
  async listRuns(limit: number): Promise<readonly ExecutionRun[]> { return copy([...this.runs.values()].slice(0, limit)); }
  async findIdempotentRun(actorId: string, kind: ExecutionKind, key: string): Promise<{ run: ExecutionRun; fingerprint: string } | null> { const alias = this.aliases.get(JSON.stringify([actorId, kind, key])); return alias ? { run: copy(this.runs.get(alias.runId)!), fingerprint: alias.fingerprint } : null; }
  async bindIdempotencyRun(actorId: string, kind: ExecutionKind, key: string, fingerprint: string, runId: string): Promise<void> {
    const mapKey = JSON.stringify([actorId, kind, key]);
    if (this.aliases.has(mapKey)) throw new Error("duplicate alias");
    this.aliases.set(mapKey, { runId, fingerprint });
  }
  async findActiveCrawl(sourceConfigId: string): Promise<ExecutionRun | null> { return copy([...this.runs.values()].find((run) => run.kind === "crawl" && run.sourceConfigId === sourceConfigId && ["queued", "running"].includes(run.status)) ?? null); }
  async findReusableAnalysis(sourceConfigId: string, fingerprint: string): Promise<ExecutionRun | null> { return copy([...this.runs.values()].find((run) => run.kind === "analysis" && run.sourceConfigId === sourceConfigId && run.fingerprint === fingerprint && ["queued", "running", "succeeded"].includes(run.status)) ?? null); }
  async insertRun(run: ExecutionRun): Promise<void> { if (this.runs.has(run.id)) throw new Error("duplicate run"); this.runs.set(run.id, copy(run)); }
  async saveRun(run: ExecutionRun, expectedRevision: number): Promise<void> { if (this.runs.get(run.id)?.revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "fixture CAS", { status: 409 }); this.runs.set(run.id, copy(run)); }
  async appendAudit(event: ExecutionAudit): Promise<void> { if (this.failAudit) throw new Error("fixture audit unavailable"); this.audits.push(copy(event)); }
  async findExpiredRuns(now: string, limit: number): Promise<readonly ExecutionRun[]> {
    return copy([...this.runs.values()].filter((run) => {
      const source = this.sources.get(run.sourceConfigId);
      return ["queued", "running"].includes(run.status) && ((run.status === "running" && !!run.lease && run.lease.expiresAt <= now) || source?.status !== "enabled" || (run.kind === "crawl" && run.sourceSnapshot.revision !== source?.revision));
    }).slice(0, limit));
  }
}
export async function executionFixture() {
  const repository = new ExecutionTestRepository();
  const clock = new MutableClock();
  const ids = new SequenceIds();
  const sources = new SourceService({ repository, clock, ids });
  let source = await sources.create(admin, draft);
  source = await sources.transition(admin, source.id, { expectedRevision: source.revision, status: "verifying", reason: "验证来源" });
  source = await sources.transition(admin, source.id, { expectedRevision: source.revision, status: "enabled", reason: "已核验", verification: { termsUrl: "https://events.hackathon.dev/terms", allowedUses: ["规则字段摘要"], minimumRetainedFields: ["日期", "证据引用"], notes: "人工核查允许用途" } });
  const worker: VerifiedWorkerIdentity = { id: "fixture-worker", kind: "operations_worker", capabilities: ["crawl", "analysis"], sourceConfigIds: [source.id] };
  const identities: WorkerIdentityPort = { authenticate: async (credential) => credential === "fixture-credential" ? copy(worker) : null };
  const validationCalls: string[] = [];
  const validation: CandidateValidationPort = {
    validateCrawl: async (input) => { validationCalls.push(input.runId); return { resultRef: input.resultRef, inputHash: "validated-hash", eventSourceIds: ["m03-source-v1"], candidateRefs: ["m03-candidate-v1"], unchanged: false }; },
    validateAnalysis: async (input) => { validationCalls.push(input.runId); return { resultRef: input.resultRef, outputRef: "m03-analysis-v1", inputTokens: 10, outputTokens: 20, estimatedCostMicros: 100, currency: "USD" }; },
  };
  const runs = new RunService({ repository, clock, ids });
  const workers = new WorkerRunService({ repository, clock, ids, identities, validation });
  return { repository, clock, ids, sources, source, runs, workers, identities, validation, validationCalls, worker };
}
