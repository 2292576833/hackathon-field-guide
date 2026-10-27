/** Test fixtures only. Production must wire the PostgreSQL repository. */
import type { Actor, ProjectMembershipAccess } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { SqlExecutor } from "../../../shared/persistence.ts";
import type { PlanningRepository, PlanningTransaction } from "../ports.ts";
import type { DraftCommand, TaskProposal } from "../service.ts";
import { PlanningService } from "../service.ts";
import type { InputVersions, PlanningEvent, PlanningInput, PlanningState } from "../types.ts";

export const NOW = "2026-10-08T01:00:00.000Z";
export const manager: Actor = { userId: "manager", platformRoles: ["user"] };
export const member: Actor = { userId: "member", platformRoles: ["user"] };
export const outsider: Actor = { userId: "outsider", platformRoles: ["admin"] };
export function membership(userId: string, id: string, role: "member" | "manager" = "member"): ProjectMembershipAccess {
  return { membershipId: id, userId, projectId: "p1", role, status: "active" };
}
export function taskProposal(id = "t1", overrides: Partial<TaskProposal> = {}): TaskProposal {
  return { id, projectId: "p1", title: id, priority: "must", kind: "implementation", ownerMembershipId: "pm2", helperEfforts: [], deliverable: "可检查的作品", acceptanceCriteria: ["完成核心演示"], reviewerMembershipId: "pm1", durationEstimate: { optimisticMinutes: 30, likelyMinutes: 60, pessimisticMinutes: 90, basis: "成员估算" }, dependencyTaskIds: [], deadlineRef: "submit", requirementRefs: ["r1"], resourceRefs: [], splittable: true, contextSwitchMinutes: 5, waitMinutes: 0, ...overrides };
}
export function proposals(): TaskProposal[] {
  return [taskProposal(), taskProposal("integration", { kind: "integration", requirementRefs: [], dependencyTaskIds: ["t1"] }), taskProposal("testing", { kind: "testing", requirementRefs: [], dependencyTaskIds: ["integration"] }), taskProposal("submission", { kind: "submission", ownerMembershipId: "pm1", requirementRefs: [], dependencyTaskIds: ["testing"], durationEstimate: { optimisticMinutes: 10, likelyMinutes: 15, pessimisticMinutes: 30, basis: "核对平台流程" } })];
}
export function inputFixture(): PlanningInput {
  return { projectId: "p1", capturedAt: NOW, projectRevision: 1, requirementVersionId: "rv1", assignmentVersionId: "av1", availabilityVersions: { pm1: 1, pm2: 1 }, members: [membership("manager", "pm1", "manager"), membership("member", "pm2")],
    availability: ["pm1", "pm2"].map(membershipId => ({ membershipId, version: 1, confirmedAt: NOW, windows: [{ id: `w-${membershipId}`, projectId: "p1", membershipId, startsAt: "2026-10-08T09:00:00+08:00", endsAt: "2026-10-08T18:00:00+08:00", sourceTimeZone: "Asia/Shanghai", purpose: "work", version: 1 }] })),
    deadlines: [{ id: "submit", kind: "submission", instantUtc: "2026-10-08T10:00:00Z", sourceTimeZone: "Asia/Shanghai", sourceText: "10月8日18:00北京时间", verified: true }], requirements: [{ id: "r1", description: "核心作品", mandatory: true, deadlineRef: "submit" }], approvedResourceIds: [], assumptions: [], requiredTaskKinds: ["integration", "testing", "submission"] };
}

export class TestPlanningRepository implements PlanningRepository {
  state: PlanningState | null = null;
  events: PlanningEvent[] = [];
  private idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private queue: Promise<void> = Promise.resolve();
  async read(projectId: string): Promise<PlanningState | null> { return this.state?.projectId === projectId ? structuredClone(this.state) : null; }
  async transaction<T>(projectId: string, work: (state: PlanningState, tx: PlanningTransaction) => Promise<T>): Promise<T> {
    const before = this.queue; let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await before;
    const local = structuredClone(this.state ?? { projectId, currentPlanVersionId: null, tasksRevision: 0, tasks: [], plans: [], progressUpdates: [], revision: 0 });
    const events = [...this.events]; const idempotency = new Map(this.idempotency); let saved = false;
    const sql: SqlExecutor = { async query() { throw new Error("Test SQL fixture has no database"); } };
    const tx: PlanningTransaction = {
      sql,
      async getIdempotent<T>(scope: string, key: string, fingerprint: string): Promise<T | null> {
        const value = idempotency.get(`${projectId}:${scope}:${key}`);
        if (value && value.fingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "幂等键对应的内容不同。", { status: 409 });
        return value ? structuredClone(value.result) as T : null;
      },
      async putIdempotent(scope, key, fingerprint, result) { idempotency.set(`${projectId}:${scope}:${key}`, { fingerprint, result: structuredClone(result) }); },
      async save(state, expectedRevision) {
        if (state !== local || state.revision !== expectedRevision + 1) throw new Error("Test revision invariant");
        saved = true;
      },
      async emit(event) { events.push(structuredClone(event)); },
    };
    try {
      const result = await work(local, tx);
      if (saved) this.state = structuredClone(local);
      this.events = events; this.idempotency = idempotency;
      return structuredClone(result);
    } finally { release(); }
  }
}
export function setup() {
  const repository = new TestPlanningRepository(); const facts = inputFixture(); let currentNow = NOW; let sequence = 0; let lockHook: () => void = () => {};
  const service = new PlanningService({
    repository,
    access: { async getMembership(projectId, userId) { return facts.members.find(item => item.userId === userId && item.projectId === projectId) ?? null; } },
    facts: { async readInput() { return structuredClone(facts); }, async lockVersions(): Promise<InputVersions> { lockHook(); return structuredClone(facts); } },
    resources: {
      async getDisplayableApprovedIds(ids) { return ids.filter(id => facts.approvedResourceIds.includes(id)); },
      async getReviewedResources(ids) { return ids.filter(id => facts.approvedResourceIds.includes(id)).map(id => ({ id, version: facts.resourceContentVersions?.[id] ?? 1 })); },
      async validateResourceRefs(refs) {
        if (refs.some(ref => !facts.approvedResourceIds.includes(ref.resourceId) || ref.version !== (facts.resourceContentVersions?.[ref.resourceId] ?? 1))) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "模拟资源公开内容版本已变化。", { status: 409 });
        return structuredClone(refs);
      },
    },
    clock: { now() { return new Date(currentNow); } }, ids: { next() { sequence += 1; return `id-${sequence}`; } },
  });
  const draft = (overrides: Partial<DraftCommand> = {}): DraftCommand => ({ tasks: proposals(), buffers: [{ deadlineId: "submit", reservedMinutes: 60, basis: "队伍确认的提交缓冲" }], reason: "明确核心范围", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: `draft-${++sequence}`, ...overrides });
  return { repository, facts, service, draft, setNow: (now: string) => { currentNow = now; }, setLockHook: (hook: () => void) => { lockHook = hook; } };
}
