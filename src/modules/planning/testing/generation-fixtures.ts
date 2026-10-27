/** Test-only generation persistence. Production uses the PostgreSQL job repository. */
import type { SqlExecutor } from "../../../shared/persistence.ts";
import { DomainError } from "../../../shared/errors.ts";
import { createPlanningGenerationService } from "../generation.ts";
import type { GeneratedPlanningProposal, PlanningGenerationCommand, PlanningGenerationJob, PlanningGenerationRepository, PlanningGenerationSnapshot, PlanningGenerationTransaction } from "../generation-types.ts";
import { NOW, proposals, setup, taskProposal } from "./fixtures.ts";

export function generatedProposal(overrides: Partial<GeneratedPlanningProposal> = {}): GeneratedPlanningProposal {
  const tasks = proposals();
  tasks.splice(3, 0, taskProposal("material", { kind: "material", requirementRefs: [], dependencyTaskIds: ["testing"], durationEstimate: { optimisticMinutes: 15, likelyMinutes: 30, pessimisticMinutes: 45, basis: "材料核对与演示说明" } }));
  tasks.find(task => task.id === "submission")!.dependencyTaskIds.push("material");
  return { tasks, reason: "保留最小作品与所有提交阶段，等待团队确认", assumptions: ["估时须由成员试做校准"], ...overrides };
}

export function generationCommand(overrides: Partial<PlanningGenerationCommand> = {}): PlanningGenerationCommand {
  return { goal: "交付可演示的最小作品", instructions: "为新手说明验收依据", resourceIds: [], buffers: [{ deadlineId: "submit", reservedMinutes: 60, basis: "队伍确认的材料与网络缓冲" }], expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "generate-first", ...overrides };
}

export class TestGenerationRepository implements PlanningGenerationRepository {
  jobs = new Map<string, PlanningGenerationJob>();
  private queue: Promise<void> = Promise.resolve();

  async read(jobId: string): Promise<PlanningGenerationJob | null> {
    return structuredClone(this.jobs.get(jobId) ?? null);
  }
  async listForProject(projectId: string, limit: number): Promise<PlanningGenerationJob[]> {
    return [...this.jobs.values()].filter(job => job.projectId === projectId).slice(0, limit).map(job => structuredClone(job));
  }
  async listQueued(limit: number) { return [...this.jobs.values()].filter(job => job.status === "queued").slice(0, limit).map(job => ({ id: job.id, projectId: job.projectId, actorId: job.actorId, revision: job.revision, status: job.status, createdAt: job.createdAt })); }
  async listRunning(limit: number) { return [...this.jobs.values()].filter(job => job.status === "running").slice(0, limit).map(job => ({ id: job.id, projectId: job.projectId, actorId: job.actorId, revision: job.revision, status: job.status, createdAt: job.createdAt })); }

  async transaction<T>(projectId: string, work: (transaction: PlanningGenerationTransaction) => Promise<T>): Promise<T> {
    const before = this.queue; let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await before;
    const jobs = structuredClone(this.jobs);
    const sql: SqlExecutor = { async query() { throw new Error("Generation fixture has no database"); } };
    const transaction: PlanningGenerationTransaction = {
      sql,
      async get(jobId) { const job = jobs.get(jobId); return job?.projectId === projectId ? structuredClone(job) : null; },
      async findRequest(actorId, idempotencyKey) { return structuredClone([...jobs.values()].find(job => job.projectId === projectId && job.actorId === actorId && job.idempotencyKey === idempotencyKey) ?? null); },
      async save(job, expectedRevision) {
        if (job.projectId !== projectId) throw new Error("Generation fixture project mismatch");
        const previous = jobs.get(job.id);
        if (expectedRevision === null ? !!previous : !previous || previous.revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "生成任务已变化。", { status: 409 });
        if (expectedRevision !== null && job.revision !== expectedRevision + 1) throw new Error("Generation fixture revision invariant");
        jobs.set(job.id, structuredClone(job));
      },
    };
    try { const result = await work(transaction); this.jobs = jobs; return structuredClone(result); } finally { release(); }
  }
}

export function modelFixture() {
  let calls = 0;
  let output: GeneratedPlanningProposal = generatedProposal();
  let hook: (snapshot: PlanningGenerationSnapshot, signal: AbortSignal) => Promise<void> = async () => {};
  const snapshots: PlanningGenerationSnapshot[] = [];
  const model = {
    modelVersion: "test-deepseek-configured", promptVersion: "planning-test-v1",
    async generate(snapshot: PlanningGenerationSnapshot, signal: AbortSignal) {
      calls += 1; snapshots.push(structuredClone(snapshot)); await hook(snapshot, signal);
      return { ...structuredClone(output), usage: { inputTokens: 101, outputTokens: 202 }, requestId: "provider-test-request", modelVersion: "test-deepseek-configured" };
    },
  };
  return { model, snapshots, calls: () => calls, setOutput: (next: GeneratedPlanningProposal) => { output = next; }, setHook: (next: typeof hook) => { hook = next; } };
}

export function generationClock() {
  let currentNow = NOW; let sequence = 0;
  return { clock: { now: () => new Date(currentNow) }, ids: { next: () => `generation-${++sequence}` }, setNow: (now: string) => { currentNow = now; } };
}

export function generationSetup(options: { timeoutMs?: number; maxAttempts?: number; withoutModel?: boolean } = {}) {
  const planning = setup(); const repository = new TestGenerationRepository(); const provider = modelFixture(); const timing = generationClock();
  const service = createPlanningGenerationService({ planning: planning.service, repository, access: { async getMembership(projectId, userId) { return planning.facts.members.find(entry => entry.projectId === projectId && entry.userId === userId) ?? null; } }, model: options.withoutModel ? undefined : provider.model, clock: timing.clock, ids: timing.ids, timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts });
  return { ...planning, planning: planning.service, service, jobs: repository, provider, setNow: (now: string) => { planning.setNow(now); timing.setNow(now); } };
}
