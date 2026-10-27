import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { assertTaskSkillLearningIncluded, parseFixedSkillReference, parseTaskSkillReferences } from "../skills/index.ts";
import type { TaskSkillReference } from "../skills/index.ts";
import { diffPlanInputs, diffPlans, diffSchedules } from "./diff.ts";
import { parseTaskProposal } from "./parse.ts";
import { validateDurationEstimate, validatePlan } from "./rules.ts";
import { hasResourceReviewRisk, reviewResourceContentRefs } from "./resource-refs.ts";
import { validateGeneratedPlanningOutput, validateGenerationContext } from "./generation-model.ts";
import type { PlanningGenerationCommand, PlanningGenerationProvenance, PlanningGenerationSnapshot } from "./generation-types.ts";
import type { PlanningFactsPort, PlanningRepository, PlanningResourcePort, PlanningReviewedSkillsPort, PlanningTransaction } from "./ports.ts";
import type { Acceptance, BufferPolicy, CurrentPlanningView, DurationEstimate, InputVersions, PlanVersion, PlanningInput, PlanningIssue, PlanningResourceRef, PlanningState, PlanningTask, ProgressUpdate, TaskStatus, ValidationResult } from "./types.ts";
import { dependentTaskIds, unmetDependencies } from "./task-board.ts";

export type TaskProposal = Omit<PlanningTask, "status" | "remainingEstimate" | "blocker" | "acceptance" | "revision" | "updatedAt" | "cancellationReason" | "resourceContentRefs"> & {
  cancel?: boolean;
  reopenCancelled?: boolean;
  cancellationReason?: string | null;
  /** Request a new server-reviewed version for these IDs; no client-supplied version numbers. */
  refreshResourceRefs?: string[];
};
export interface DraftCommand {
  tasks: TaskProposal[];
  buffers: BufferPolicy[];
  reason: string;
  expectedTasksRevision: number;
  basePlanVersionId: string | null;
  idempotencyKey: string;
}
export interface ApplyCommand {
  expectedRevision: number;
  acknowledgedIssueCodes: string[];
  idempotencyKey: string;
}
export type EditDraftCommand = Omit<DraftCommand, "basePlanVersionId"> & { expectedRevision: number };
export interface ProgressCommand {
  expectedRevision: number;
  status: TaskStatus;
  remainingEstimate: DurationEstimate | null;
  blocker: string | null;
  evidenceRefs: string[];
  note: string;
  correctionOf?: string | null;
  correctionReason?: string | null;
  idempotencyKey: string;
}
export interface AcceptanceCorrectionCommand {
  expectedRevision: number;
  expectedTasksRevision: number;
  /** The current accepted progress record, never an arbitrary earlier update. */
  correctionOf: string;
  correctionReason: string;
  status: "in_progress" | "review";
  acknowledgedDependentTaskIds: string[];
  idempotencyKey: string;
}
export interface AcceptanceCorrectionRequestCommand {
  expectedRevision: number;
  acceptanceProgressId: string;
  reason: string;
  idempotencyKey: string;
}
/** Compare the draft and its task separately; identities never come from this command. */
export interface DraftTaskOwnershipCommand {
  expectedRevision: number;
  expectedTaskRevision: number;
  idempotencyKey: string;
}
export interface AssignDraftTaskCommand extends DraftTaskOwnershipCommand {
  ownerMembershipId: string | null;
}
export interface DraftTaskPool {
  plan: Pick<PlanVersion, "id" | "status" | "revision" | "reason" | "createdAt" | "basePlanVersionId" | "baseTasksRevision"> | null;
  /** Includes claimed tasks so teammates can still see who has taken the work. */
  tasks: PlanningTask[];
  inputVersionsChanged: boolean;
}
export interface PlanningServiceDependencies {
  access: ProjectAccessPort;
  facts: PlanningFactsPort;
  repository: PlanningRepository;
  resources?: PlanningResourcePort;
  reviewedSkills?: PlanningReviewedSkillsPort;
  clock: Clock;
  ids: IdGenerator;
}

export function versionsEqual(a: InputVersions, b: InputVersions): boolean {
  const keys = [...new Set([...Object.keys(a.availabilityVersions), ...Object.keys(b.availabilityVersions)])].sort();
  // PostgreSQL JSONB may reorder object keys. Compare the version facts in a
  // fixed projection, so persisting a draft cannot manufacture a conflict.
  const intentions = (value: InputVersions) => (value.memberIntentionRefs ?? []).map(item => ({ membershipId: item.membershipId, revision: item.revision }))
    .sort((left, right) => left.membershipId.localeCompare(right.membershipId));
  const projectEqual = a.projectFactsVersion !== undefined && b.projectFactsVersion !== undefined
    ? /^[a-f0-9]{64}$/.test(a.projectFactsVersion) && /^[a-f0-9]{64}$/.test(b.projectFactsVersion) && a.projectFactsVersion === b.projectFactsVersion
    : a.projectRevision === b.projectRevision;
  return projectEqual && a.requirementVersionId === b.requirementVersionId && a.assignmentVersionId === b.assignmentVersionId && (a.trackSelectionRevision ?? null) === (b.trackSelectionRevision ?? null) && JSON.stringify(intentions(a)) === JSON.stringify(intentions(b)) && (a.projectArchived ?? false) === (b.projectArchived ?? false) && (a.projectReadOnly ?? false) === (b.projectReadOnly ?? false) && keys.every(key => a.availabilityVersions[key] === b.availabilityVersions[key]);
}
function assertWritable(...snapshots: InputVersions[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.projectFactsVersion !== undefined && (typeof snapshot.projectFactsVersion !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.projectFactsVersion))) throw new DomainError("INVALID_FACTS", "项目计划依据版本无效，请重新读取空间资料。");
    if ((snapshot.projectArchived !== undefined && typeof snapshot.projectArchived !== "boolean") || (snapshot.projectReadOnly !== undefined && typeof snapshot.projectReadOnly !== "boolean")) throw new DomainError("INVALID_FACTS", "项目只读状态不合法。");
    if (snapshot.projectArchived || snapshot.projectReadOnly) throw new DomainError("PROJECT_READ_ONLY", "项目已归档或处于只读状态，不能修改计划或进度。", { status: 409, recoveryAction: "view_history" });
  }
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function skillRefsEqual(left: readonly TaskSkillReference[] | undefined, right: readonly TaskSkillReference[] | undefined): boolean {
  const normalize = (refs: readonly TaskSkillReference[] | undefined) => [...(parseTaskSkillReferences(refs) ?? [])].sort((a, b) => `${a.reference.kind}:${a.reference.id}`.localeCompare(`${b.reference.kind}:${b.reference.id}`));
  return fingerprint(normalize(left)) === fingerprint(normalize(right));
}
function conflict(latestRevision: number): never {
  throw new DomainError("VERSION_CONFLICT", "计划输入或进度已经变化，请刷新后重新校验；草案和新成果已保留。", { status: 409, latestRevision, recoveryAction: "reload_and_revalidate" });
}
function requiredText(value: unknown, name: string, max = 4000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError("INVALID_INPUT", `${name}需要填写且不能超过${max}个字符。`);
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainError("INVALID_INPUT", "需要有效的预期修订号。", { status: 400 });
}
function initialState(projectId: string): PlanningState {
  return { projectId, currentPlanVersionId: null, tasksRevision: 0, tasks: [], plans: [], progressUpdates: [], revision: 0 };
}
function findPlan(state: PlanningState, planId: string): PlanVersion {
  const plan = state.plans.find(item => item.id === planId);
  if (!plan) throw new DomainError("NOT_FOUND", "未找到该计划。", { status: 404 });
  return plan;
}
function ownershipStale(latestRevision: number): never {
  throw new DomainError("TASK_POOL_STALE", "任务草案依据或生效任务已变化，请让空间管理员先重新校验，再领取或转交。", { status: 409, latestRevision, recoveryAction: "revalidate_draft" });
}

/** Manual drafts and progress need no model, email, or GitHub provider. */
export class PlanningService {
  private dependencies: PlanningServiceDependencies;
  constructor(dependencies: PlanningServiceDependencies) { this.dependencies = dependencies; }

  private now(): string { return this.dependencies.clock.now().toISOString(); }
  private async authorize(actor: Actor, projectId: string, manager = false): Promise<ProjectMembershipAccess> {
    const membership = await this.dependencies.access.getMembership(projectId, actor.userId);
    if (!membership || membership.status !== "active") throw new DomainError("NOT_FOUND", "未找到可访问的项目。", { status: 404 });
    if (manager && membership.role !== "manager") throw new DomainError("FORBIDDEN", "只有活跃项目管理员可以确认计划。", { status: 403 });
    return membership;
  }
  private async input(projectId: string, now: string, actor: Actor): Promise<PlanningInput> {
    const input = await this.dependencies.facts.readInput(projectId, now, actor);
    if (input.projectId !== projectId) throw new DomainError("INVALID_FACTS", "输入快照不属于当前项目。");
    return structuredClone(input);
  }
  private withResourceIssues(validation: ValidationResult, issues: PlanningIssue[]): ValidationResult {
    for (const issue of issues) if (!validation.issues.some(existing => JSON.stringify(existing) === JSON.stringify(issue))) validation.issues.push(issue);
    if (issues.some(issue => issue.severity === "error")) { validation.structuralValid = false; validation.feasibility = "infeasible"; }
    if (issues.length && validation.feasibility === "feasible") validation.feasibility = "at_risk";
    validation.staleInputs ||= hasResourceReviewRisk(issues);
    return validation;
  }
  private validateSnapshot(input: PlanningInput, tasks: PlanningTask[], buffers: BufferPolicy[], now: string, current: PlanningTask[], resourceIssues: PlanningIssue[], generatedAssumptions: readonly string[] = []): ValidationResult {
    // Relax the reference check only for preserved historical IDs; keep the factual snapshot unchanged.
    const validationInput = { ...input, assumptions: [...new Set([...input.assumptions, ...generatedAssumptions])], approvedResourceIds: [...new Set([...input.approvedResourceIds, ...current.flatMap(task => task.resourceRefs)])] };
    return this.withResourceIssues(validatePlan(validationInput, tasks, buffers, now), resourceIssues);
  }
  private async readResourceHeads(tasks: readonly Pick<PlanningTask, "resourceRefs">[], input: PlanningInput, sql?: SqlExecutor): Promise<void> {
    const ids = [...new Set(tasks.flatMap(task => task.resourceRefs))].sort();
    if (!ids.length || !this.dependencies.resources?.getReviewedResources) return;
    const found = new Map<string, number>();
    // M09 supports 50 per call. Lock the entire sorted ID set in stable batches before validating any subset.
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50);
      const resources = await this.dependencies.resources.getReviewedResources(batch, sql);
      for (const resource of resources) {
        if (!batch.includes(resource.id) || !Number.isSafeInteger(resource.version) || resource.version < 1 || found.has(resource.id)) throw new DomainError("INVALID_RESOURCE_VERSION_FACT", "资源适配返回了无效或重复的公开内容版本。");
        found.set(resource.id, resource.version);
      }
    }
    const versions = { ...input.resourceContentVersions };
    for (const id of ids) versions[id] = found.get(id) ?? null;
    input.resourceContentVersions = versions;
    input.approvedResourceIds = [...new Set([...input.approvedResourceIds.filter(id => !ids.includes(id)), ...found.keys()])];
  }
  private async checkResources(tasks: PlanningTask[], state: PlanningState, input: PlanningInput, sql: SqlExecutor, phase: "draft" | "apply", proposals: readonly TaskProposal[] = [], pending: PlanVersion["resourceReviewRequiredRefs"] = [], legacyBasis: readonly PlanningTask[] = state.tasks, legacyProvenance: PlanVersion["resourceLegacyRefs"] = []) {
    await this.readResourceHeads(tasks, input, sql);
    const history = [...state.tasks, ...state.plans.filter(plan => plan.status === "applied" || plan.status === "superseded").flatMap(plan => plan.tasks)];
    const requested = new Map(proposals.map(task => [task.id, new Set(task.refreshResourceRefs ?? [])]));
    const required: NonNullable<PlanVersion["resourceReviewRequiredRefs"]> = [];
    const legacy: NonNullable<PlanVersion["resourceLegacyRefs"]> = [];
    const validateNow: PlanningResourceRef[] = [];
    for (const task of tasks) {
      const pins = new Map((task.resourceContentRefs ?? []).map(ref => [ref.resourceId, ref]));
      for (const id of task.resourceRefs) {
        let pin = pins.get(id);
        const refresh = requested.get(task.id)?.has(id) ?? false;
        const historicalId = legacyBasis.some(old => old.id === task.id && old.resourceRefs.includes(id)) || (phase === "apply" && (legacyProvenance ?? []).some(ref => ref.taskId === task.id && ref.resourceId === id));
        const historicalPin = !!pin && history.some(old => old.id === task.id && old.resourceContentRefs?.some(ref => ref.resourceId === id && ref.version === pin!.version));
        const deferred = (pending ?? []).some(ref => ref.taskId === task.id && ref.resourceId === id && ref.version === pin?.version);
        let selectedNow = false;
        if (!pin && (!historicalId || refresh)) {
          if (phase === "apply") throw new DomainError("RESOURCE_CONTENT_VERSION_UNCONFIRMED", "新增资源草案尚未固定服务端内容版本，请编辑并重新校验。", { status: 409, recoveryAction: "refresh_resource_refs" });
          if (!this.dependencies.resources?.getReviewedResources || !this.dependencies.resources.validateResourceRefs) throw new DomainError("RESOURCE_CONTENT_VERSION_UNAVAILABLE", "资源内容版本查询尚未接入，请去掉新推荐后继续手动规划。", { status: 503 });
          const version = input.resourceContentVersions?.[id];
          if (!Number.isSafeInteger(version) || version! < 1) throw new DomainError("UNAPPROVED_RESOURCE", "新推荐只能引用当前已审核且可展示的资源 ID。", { recoveryAction: "remove_unknown_resource" });
          pin = { resourceId: id, version: version! };
          pins.set(id, pin); selectedNow = true;
        }
        if (!pin && historicalId) legacy.push({ taskId: task.id, resourceId: id });
        const needsReview = !!pin && (refresh || deferred || !historicalPin);
        if (needsReview && pin) {
          required.push({ taskId: task.id, ...pin });
          if (phase === "apply" || selectedNow || (!deferred && !historicalPin)) validateNow.push(pin);
        }
      }
      if (pins.size || task.resourceContentRefs !== undefined) task.resourceContentRefs = [...pins.values()];
    }
    if (validateNow.length) {
      if (!this.dependencies.resources?.validateResourceRefs) throw new DomainError("RESOURCE_CONTENT_VERSION_UNAVAILABLE", "资源版本审核尚未接入，不能创建或应用新引用。", { status: 503 });
      const refs = [...new Map(validateNow.map(ref => [`${ref.resourceId}:${ref.version}`, ref])).values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
      for (let start = 0; start < refs.length; start += 50) {
        const batch = refs.slice(start, start + 50);
        const checked = await this.dependencies.resources.validateResourceRefs(batch, sql);
        if (batch.some(ref => !checked.some(value => value.resourceId === ref.resourceId && value.version === ref.version))) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "部分新资源引用的公开内容版本已变化或不可用，请重新选择。", { status: 409, recoveryAction: "refresh_resource_refs" });
      }
    }
    return { issues: reviewResourceContentRefs(tasks, input), required, legacy };
  }
  private async checkSkillRefs(tasks: readonly PlanningTask[], state: PlanningState, sql: SqlExecutor): Promise<void> {
    const selected: TaskSkillReference[] = [];
    for (const task of tasks) {
      const previous = state.tasks.find(old => old.id === task.id);
      if (previous?.status === "done") {
        if (!skillRefsEqual(previous.skillRefs, task.skillRefs)) throw new DomainError("COMPLETED_TASK_CHANGED", "已验收任务的技能依据不能改写，请新增任务记录新版用途。");
        continue;
      }
      const refs = parseTaskSkillReferences(task.skillRefs);
      if (task.status !== "cancelled") assertTaskSkillLearningIncluded(refs, task.durationEstimate.likelyMinutes);
      // Exact selections already applied to this task are historical facts, including withdrawn versions.
      // Draft-only and newly adopted selections are rechecked on every write and again at apply.
      for (const item of refs ?? []) {
        const retained = (previous?.status !== "cancelled" || task.status === "cancelled") && previous?.skillRefs?.some(old => skillRefsEqual([old], [item]));
        if (!retained) selected.push(item);
      }
    }
    if (!selected.length) return;
    if (!this.dependencies.reviewedSkills) throw new DomainError("SKILL_REFERENCE_LOOKUP_UNAVAILABLE", "已审核技能版本查询尚未接入，请保留原任务或清除新技能选择后继续规划。", { status: 503 });
    const unique = [...new Map(selected.map(item => [fingerprint(item.reference), item.reference])).values()].sort((a, b) => `${a.kind}:${a.id}:${a.versionId}`.localeCompare(`${b.kind}:${b.id}:${b.versionId}`));
    for (const reference of unique) {
      const checked = await this.dependencies.reviewedSkills.get(reference, sql);
      if (fingerprint(parseFixedSkillReference(checked?.reference)) !== fingerprint(reference)) throw new DomainError("SKILL_REFERENCE_STALE", "所选技能固定版本与已审核内容不一致，请刷新目录后重新选择。", { status: 409 });
    }
  }
  private materialize(proposals: TaskProposal[], state: PlanningState, projectId: string, now: string, reason: string, resourceBasis: readonly PlanningTask[] = state.tasks): PlanningTask[] {
    if (!Array.isArray(proposals) || proposals.length > 500) throw new DomainError("INVALID_INPUT", "任务必须是最多500项的列表。");
    const previous = new Map(state.tasks.map(task => [task.id, task]));
    const result: PlanningTask[] = proposals.map(rawProposal => {
      const proposal = parseTaskProposal(rawProposal);
      if (!proposal || typeof proposal !== "object" || typeof proposal.id !== "string" || proposal.projectId !== projectId) throw new DomainError("INVALID_TASK", "任务标识与项目归属不合法。");
      const existing = previous.get(proposal.id);
      const { cancel, reopenCancelled, cancellationReason, refreshResourceRefs = [], ...definition } = proposal;
      if (cancel && reopenCancelled) throw new DomainError("INVALID_TASK", "不能同时删减与恢复同一任务。");
      if (reopenCancelled && existing?.status !== "cancelled") throw new DomainError("INVALID_TASK", "只有已删减任务可以显式恢复。");
      if (refreshResourceRefs.some(id => !proposal.resourceRefs.includes(id)) || new Set(refreshResourceRefs).size !== refreshResourceRefs.length) throw new DomainError("INVALID_RESOURCE_REFRESH", "刷新请求只能包含本任务中的唯一资源 ID。");
      if (existing?.status === "done" && refreshResourceRefs.length) throw new DomainError("COMPLETED_TASK_CHANGED", "已验收任务的历史资源依据不能重绑，请新增任务记录新版影响。");
      const basis = existing?.status === "done" ? existing : resourceBasis.find(task => task.id === proposal.id) ?? existing;
      const skillRefs = definition.skillRefs ?? basis?.skillRefs;
      const task: PlanningTask = {
        ...definition,
        ...(skillRefs === undefined ? {} : { skillRefs: structuredClone(skillRefs) }),
        status: cancel ? "cancelled" : reopenCancelled ? "todo" : existing?.status ?? "todo",
        remainingEstimate: existing?.remainingEstimate ?? null,
        blocker: reopenCancelled ? null : existing?.blocker ?? null,
        acceptance: existing?.acceptance ?? null,
        cancellationReason: cancel ? cancellationReason ?? reason : reopenCancelled ? null : existing?.cancellationReason ?? null,
        revision: existing?.revision ?? 0,
        updatedAt: now,
        ...(basis?.resourceContentRefs === undefined ? {} : { resourceContentRefs: basis.resourceContentRefs.filter(ref => proposal.resourceRefs.includes(ref.resourceId) && !refreshResourceRefs.includes(ref.resourceId)).map(ref => ({ ...ref })) }),
      };
      if (cancel && (task.priority === "must" || task.requirementRefs.some(id => state.plans.find(plan => plan.id === state.currentPlanVersionId)?.inputSnapshot.requirements.some(item => item.id === id && item.mandatory)))) throw new DomainError("REQUIRED_TASK_CANCELLED", "必需工作或规则必交材料不能直接删减。");
      if (existing?.status === "done") {
        const changes = diffPlans([existing], [task], [], []);
        if (changes.length || !skillRefsEqual(existing.skillRefs, task.skillRefs)) throw new DomainError("COMPLETED_TASK_CHANGED", "已验收工作必须保留；新增工作请建立新任务。");
        return structuredClone(existing);
      }
      return task;
    });
    for (const task of state.tasks) {
      if (result.some(item => item.id === task.id)) continue;
      if (task.priority === "must" || task.status === "done") throw new DomainError("TASK_REMOVAL_REQUIRES_REVIEW", "必须任务与已验收工作不能从草案中消失。");
      result.push({ ...structuredClone(task), status: "cancelled", cancellationReason: reason, updatedAt: now });
    }
    return result;
  }
  private async event(transaction: PlanningTransaction, type: "PlanDraftGenerated" | "PlanApplied" | "ProgressUpdated" | "PlanRiskDetected", projectId: string, aggregateId: string, version: number, now: string): Promise<void> {
    await transaction.emit({ id: this.dependencies.ids.next(), type, projectId, aggregateId, revision: version, occurredAt: now });
  }

  async getCurrent(actor: Actor, projectId: string): Promise<CurrentPlanningView> {
    await this.authorize(actor, projectId);
    const state = await this.dependencies.repository.read(projectId) ?? initialState(projectId);
    const plan = state.plans.find(item => item.id === state.currentPlanVersionId) ?? null;
    if (!plan) { await this.authorize(actor, projectId); return { plan: null, tasks: state.tasks, tasksRevision: state.tasksRevision, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: state.progressUpdates.at(-1)?.createdAt ?? null }; }
    const input = await this.input(projectId, this.now(), actor);
    await this.readResourceHeads(state.tasks, input);
    const now = this.now();
    const historicalIssues = reviewResourceContentRefs(state.tasks, input);
    const evaluation = this.validateSnapshot(input, state.tasks, plan.buffers, now, state.tasks, historicalIssues, plan.generation?.assumptions);
    const inputVersionsChanged = !versionsEqual(plan.inputSnapshot, input) || hasResourceReviewRisk(historicalIssues);
    const staleInputs = inputVersionsChanged || JSON.stringify(plan.tasks) !== JSON.stringify(state.tasks);
    evaluation.staleInputs = staleInputs;
    if (staleInputs && evaluation.feasibility === "feasible") evaluation.feasibility = "unknown";
    await this.authorize(actor, projectId);
    return { plan, tasks: state.tasks, tasksRevision: state.tasksRevision, evaluation, staleInputs, inputVersionsChanged, lastProgressAt: state.progressUpdates.at(-1)?.createdAt ?? null };
  }
  async listHistory(actor: Actor, projectId: string): Promise<PlanVersion[]> {
    await this.authorize(actor, projectId);
    const plans = (await this.dependencies.repository.read(projectId))?.plans ?? [];
    await this.authorize(actor, projectId); return plans;
  }
  async listProgress(actor: Actor, projectId: string): Promise<ProgressUpdate[]> {
    await this.authorize(actor, projectId);
    const progress = (await this.dependencies.repository.read(projectId))?.progressUpdates ?? [];
    await this.authorize(actor, projectId); return progress;
  }
  /** Read-only projection of the latest editable draft; a GET never initializes a state. */
  async getTaskPool(actor: Actor, projectId: string): Promise<DraftTaskPool> {
    await this.authorize(actor, projectId);
    const state = await this.dependencies.repository.read(projectId);
    const plan = state?.plans.slice().reverse().find(item => ["draft", "ready", "needs_changes", "stale"].includes(item.status));
    if (!plan || !state) { await this.authorize(actor, projectId); return { plan: null, tasks: [], inputVersionsChanged: false }; }
    const current = await this.input(projectId, this.now(), actor);
    await this.readResourceHeads(plan.tasks, current);
    const inputVersionsChanged = plan.status === "stale" || plan.baseTasksRevision !== state.tasksRevision || plan.basePlanVersionId !== state.currentPlanVersionId
      || !versionsEqual(plan.inputSnapshot, current) || hasResourceReviewRisk(reviewResourceContentRefs(plan.tasks, current));
    await this.authorize(actor, projectId);
    return {
      plan: { id: plan.id, status: plan.status, revision: plan.revision, reason: plan.reason, createdAt: plan.createdAt, basePlanVersionId: plan.basePlanVersionId, baseTasksRevision: plan.baseTasksRevision },
      tasks: plan.tasks, inputVersionsChanged,
    };
  }

  async claimDraftTask(actor: Actor, projectId: string, planId: string, taskId: string, command: DraftTaskOwnershipCommand): Promise<PlanVersion> {
    return this.changeDraftTaskOwner(actor, projectId, planId, taskId, "claim", command);
  }
  async releaseDraftTask(actor: Actor, projectId: string, planId: string, taskId: string, command: DraftTaskOwnershipCommand): Promise<PlanVersion> {
    return this.changeDraftTaskOwner(actor, projectId, planId, taskId, "release", command);
  }
  async assignDraftTask(actor: Actor, projectId: string, planId: string, taskId: string, command: AssignDraftTaskCommand): Promise<PlanVersion> {
    if (command.ownerMembershipId !== null) requiredText(command.ownerMembershipId, "负责人身份", 200);
    return this.changeDraftTaskOwner(actor, projectId, planId, taskId, "assign", command);
  }

  /** Atomic ownership on a draft only. Applied work, progress and acceptance stay intact. */
  private async changeDraftTaskOwner(actor: Actor, projectId: string, planId: string, taskId: string, action: "claim" | "release" | "assign", command: DraftTaskOwnershipCommand | AssignDraftTaskCommand): Promise<PlanVersion> {
    const managerOnly = action === "assign";
    await this.authorize(actor, projectId, managerOnly);
    requiredText(planId, "计划标识", 200); requiredText(taskId, "任务标识", 200);
    revision(command.expectedRevision); revision(command.expectedTaskRevision); requiredText(command.idempotencyKey, "幂等键", 200);
    const input = await this.input(projectId, this.now(), actor);
    const scope = `${actor.userId}:draft_task_${action}:${planId}:${taskId}`;
    // A fixed command projection ignores object-key ordering and never accepts a caller's own identity.
    const hash = fingerprint({ expectedRevision: command.expectedRevision, expectedTaskRevision: command.expectedTaskRevision, idempotencyKey: command.idempotencyKey,
      ...(action === "assign" ? { ownerMembershipId: (command as AssignDraftTaskCommand).ownerMembershipId } : {}) });
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      const locked = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      const membership = await this.authorize(actor, projectId, managerOnly);
      assertWritable(input, locked);
      // Replays are reads, but revoked memberships and archived spaces must not expose old results.
      const replay = await transaction.getIdempotent<PlanVersion>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      const plan = findPlan(state, planId);
      if (plan.status === "applied" || plan.status === "superseded") throw new DomainError("PLAN_IMMUTABLE", "已生效计划的负责人不能通过任务池修改，请让管理员建立新草案。", { status: 409 });
      if (!["draft", "ready", "needs_changes", "stale"].includes(plan.status)) throw new DomainError("PLAN_NOT_READY", "这份计划尚无可领取的任务草案，请等待生成完成或重新建立草案。", { status: 409 });
      const task = plan.tasks.find(item => item.id === taskId);
      if (!task) throw new DomainError("NOT_FOUND", "未找到这份草案中的任务。", { status: 404 });
      if (plan.revision !== command.expectedRevision) conflict(plan.revision);
      if (task.revision !== command.expectedTaskRevision) conflict(task.revision);
      if (plan.status === "stale" || plan.basePlanVersionId !== state.currentPlanVersionId || plan.baseTasksRevision !== state.tasksRevision
        || !versionsEqual(input, locked) || !versionsEqual(plan.inputSnapshot, locked)) ownershipStale(plan.revision);
      if (task.status !== "todo" || task.acceptance !== null) throw new DomainError("TASK_OWNERSHIP_LOCKED", "已经开始、提交检查、完成或删减的任务不能在任务池退回或转交，请由管理员核对当前工作后建立新安排。", { status: 409 });
      const actorFact = input.members.find(item => item.membershipId === membership.membershipId && item.projectId === projectId && item.userId === actor.userId && item.status === "active");
      if (!actorFact) ownershipStale(plan.revision);
      const previousOwnerMembershipId = task.ownerMembershipId;
      let ownerMembershipId: string | null;
      if (action === "claim") {
        if (task.ownerMembershipId !== null) throw new DomainError("TASK_ALREADY_CLAIMED", "这项任务已有负责人，请选择待领取的任务或联系管理员转交。", { status: 409, recoveryAction: "choose_unclaimed_task" });
        ownerMembershipId = membership.membershipId;
      } else if (action === "release") {
        if (task.ownerMembershipId === null) throw new DomainError("TASK_NOT_CLAIMED", "这项任务已经是待领取状态，请刷新任务池。", { status: 409 });
        if (membership.role !== "manager" && task.ownerMembershipId !== membership.membershipId) throw new DomainError("FORBIDDEN", "只能退回自己领取的任务；转交队友请联系空间管理员。", { status: 403 });
        ownerMembershipId = null;
      } else {
        ownerMembershipId = (command as AssignDraftTaskCommand).ownerMembershipId;
        if (ownerMembershipId === task.ownerMembershipId) throw new DomainError("TASK_OWNER_UNCHANGED", "任务负责人没有变化，无需再次保存。", { status: 409 });
      }
      if (ownerMembershipId !== null && !input.members.some(item => item.membershipId === ownerMembershipId && item.projectId === projectId && item.status === "active")) throw new DomainError("TASK_OWNER_INACTIVE", "负责人必须是当前空间的活跃成员，请刷新成员列表。", { status: 409 });
      const helperIds = task.helperEfforts.map(helper => helper.membershipId);
      if (new Set(helperIds).size !== helperIds.length || (ownerMembershipId !== null && helperIds.includes(ownerMembershipId))) throw new DomainError("INVALID_TASK_HELPER", "负责人不能同时计作协助者，协助者也不能重复；请让管理员先修改这项任务的协助安排。", { status: 409 });
      await this.readResourceHeads(plan.tasks, input, transaction.sql);
      if (hasResourceReviewRisk(reviewResourceContentRefs(plan.tasks, input))) ownershipStale(plan.revision);
      const now = this.now(); const expected = state.revision;
      task.ownerMembershipId = ownerMembershipId; task.revision += 1; task.updatedAt = now;
      const resources = await this.checkResources(plan.tasks, state, input, transaction.sql, "draft", [], plan.resourceReviewRequiredRefs, plan.tasks, plan.resourceLegacyRefs);
      await this.checkSkillRefs(plan.tasks, state, transaction.sql);
      if (hasResourceReviewRisk(resources.issues)) ownershipStale(plan.revision);
      const history = [...state.tasks, ...state.plans.filter(item => item.status === "applied" || item.status === "superseded").flatMap(item => item.tasks)];
      const validation = this.validateSnapshot(input, plan.tasks, plan.buffers, now, history, resources.issues, plan.generation?.assumptions);
      const base = state.plans.find(item => item.id === state.currentPlanVersionId);
      plan.inputSnapshot = input; plan.validation = validation;
      plan.changes = [...diffPlans(state.tasks, plan.tasks, base?.buffers ?? [], plan.buffers), ...diffPlanInputs(base?.inputSnapshot, input, plan.tasks), ...diffSchedules(base?.validation, validation)];
      plan.status = validation.structuralValid ? "ready" : "needs_changes";
      plan.resourceReviewRequiredRefs = resources.required; plan.resourceLegacyRefs = resources.legacy;
      plan.acknowledgedIssueCodes = []; plan.revision += 1; state.revision += 1;
      const finalMembership = await this.authorize(actor, projectId, managerOnly);
      if (finalMembership.membershipId !== membership.membershipId) ownershipStale(plan.revision);
      if (action === "release" && finalMembership.role !== "manager" && previousOwnerMembershipId !== finalMembership.membershipId) throw new DomainError("FORBIDDEN", "当前账号已无权退回队友的任务，请联系空间管理员。", { status: 403 });
      await transaction.save(state, expected);
      // The existing outbox revision and immutable idempotency snapshot record this checked edit.
      await this.event(transaction, "PlanDraftGenerated", projectId, plan.id, plan.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, plan);
      return plan;
    });
  }
  async getDiff(actor: Actor, projectId: string, planId: string) {
    await this.authorize(actor, projectId);
    const state = await this.dependencies.repository.read(projectId);
    if (!state) throw new DomainError("NOT_FOUND", "未找到该计划。", { status: 404 });
    const plan = findPlan(state, planId);
    const current = await this.input(projectId, this.now(), actor);
    await this.readResourceHeads(plan.tasks, current);
    const resourceIssues = reviewResourceContentRefs(plan.tasks, current);
    const staleInputs = hasResourceReviewRisk(resourceIssues) || plan.status === "stale" || (plan.status !== "applied" && plan.status !== "superseded" && (plan.baseTasksRevision !== state.tasksRevision || plan.basePlanVersionId !== state.currentPlanVersionId || !versionsEqual(plan.inputSnapshot, current)));
    return { planId, basePlanVersionId: plan.basePlanVersionId, status: staleInputs && plan.status !== "applied" && plan.status !== "superseded" ? "stale" : plan.status, revision: plan.revision, changes: plan.changes, validation: plan.validation, resourceIssues, staleInputs, reason: plan.reason };
  }

  async createDraft(actor: Actor, projectId: string, command: DraftCommand): Promise<PlanVersion> {
    return this.createDraftFromBasis(actor, projectId, command);
  }
  /** Server-only capture inside the generation repository's planning project lock. */
  async captureGenerationContext(actor: Actor, projectId: string, command: PlanningGenerationCommand, sql: SqlExecutor): Promise<PlanningGenerationSnapshot> {
    await this.authorize(actor, projectId, true);
    const input = await this.input(projectId, this.now(), actor);
    const locked = await this.dependencies.facts.lockVersions(projectId, sql, actor);
    await this.authorize(actor, projectId, true);
    assertWritable(input, locked);
    if (!versionsEqual(input, locked)) conflict(command.expectedTasksRevision);
    const state = await this.dependencies.repository.read(projectId) ?? initialState(projectId);
    if (state.tasksRevision !== command.expectedTasksRevision || state.currentPlanVersionId !== command.basePlanVersionId) conflict(state.tasksRevision);
    await this.readResourceHeads([...state.tasks, { resourceRefs: command.resourceIds }], input, sql);
    const resourceContentRefs: PlanningResourceRef[] = [];
    for (const id of command.resourceIds) {
      const version = input.resourceContentVersions?.[id];
      if (!input.approvedResourceIds.includes(id) || !Number.isSafeInteger(version) || version! < 1) throw new DomainError("UNAPPROVED_RESOURCE", "AI候选只能包含当前已审核公开资源的准确ID。", { status: 422 });
      resourceContentRefs.push({ resourceId: id, version: version! });
    }
    await this.validateGenerationResources(resourceContentRefs, sql);
    const snapshot: PlanningGenerationSnapshot = { input, tasks: state.tasks, tasksRevision: state.tasksRevision, basePlanVersionId: state.currentPlanVersionId, resourceContentRefs, buffers: structuredClone(command.buffers), goal: command.goal, instructions: command.instructions ?? "" };
    validateGenerationContext(snapshot);
    return structuredClone(snapshot);
  }
  private async validateGenerationResources(refs: readonly PlanningResourceRef[], sql: SqlExecutor): Promise<void> {
    if (!refs.length) return;
    if (!this.dependencies.resources?.getReviewedResources || !this.dependencies.resources.validateResourceRefs) throw new DomainError("RESOURCE_CONTENT_VERSION_UNAVAILABLE", "公开资源版本查询和审核尚未接入。", { status: 503 });
    // Capture/finish only accepts the original exact public versions. Never silently adopt a newer head.
    const sorted = [...refs].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
    for (let offset = 0; offset < sorted.length; offset += 50) {
      const batch = sorted.slice(offset, offset + 50);
      const checked = await this.dependencies.resources.validateResourceRefs(batch, sql);
      if (batch.some(ref => !checked.some(value => value.resourceId === ref.resourceId && value.version === ref.version))) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "生成依据中的公开资源已经改变或下架，请重新生成。", { status: 409 });
    }
  }
  /** Worker-only final version/permission gate. Caller holds the generation project transaction. */
  async assertGenerationContext(actor: Actor, projectId: string, snapshot: PlanningGenerationSnapshot, sql: SqlExecutor): Promise<void> {
    const current = await this.captureGenerationContext(actor, projectId, { goal: snapshot.goal, instructions: snapshot.instructions, resourceIds: snapshot.resourceContentRefs.map(ref => ref.resourceId), buffers: snapshot.buffers, expectedTasksRevision: snapshot.tasksRevision, basePlanVersionId: snapshot.basePlanVersionId, idempotencyKey: "generation_context_check" }, sql);
    if (!versionsEqual(snapshot.input, current.input)) conflict(current.tasksRevision);
    if (Object.entries(snapshot.input.resourceContentVersions ?? {}).some(([id, version]) => current.input.resourceContentVersions?.[id] !== version)) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "生成期间资源公开依据已变化，请按最新内容重新生成。", { status: 409 });
    await this.validateGenerationResources(snapshot.resourceContentRefs, sql);
  }
  /** Creates a checked draft only. Root must reuse the outer job executor for an atomic completion. */
  async createGeneratedDraft(actor: Actor, projectId: string, command: DraftCommand, snapshot: PlanningGenerationSnapshot, provenance: PlanningGenerationProvenance): Promise<PlanVersion> {
    validateGeneratedPlanningOutput({ tasks: command.tasks, reason: command.reason, assumptions: provenance.assumptions }, snapshot);
    if (JSON.stringify(command.buffers) !== JSON.stringify(snapshot.buffers) || command.expectedTasksRevision !== snapshot.tasksRevision || command.basePlanVersionId !== snapshot.basePlanVersionId) throw new DomainError("INVALID_GENERATED_PLAN", "生成结果不能替换已确认缓冲或任务基线。", { status: 422 });
    return this.createDraftFromBasis(actor, projectId, command, undefined, { snapshot, provenance });
  }
  private async createDraftFromBasis(actor: Actor, projectId: string, command: DraftCommand, source?: { planId: string; contentHash: string }, generated?: { snapshot: PlanningGenerationSnapshot; provenance: PlanningGenerationProvenance }): Promise<PlanVersion> {
    await this.authorize(actor, projectId, true);
    requiredText(command.reason, "变更理由"); requiredText(command.idempotencyKey, "幂等键", 200); revision(command.expectedTasksRevision);
    const input = await this.input(projectId, this.now(), actor);
    const scope = `${actor.userId}:create_draft`;
    const hash = source || generated ? fingerprint({ command, ...(source ? { source } : {}), ...(generated ? { generated } : {}) }) : fingerprint(command);
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      await this.authorize(actor, projectId, true);
      const replay = await transaction.getIdempotent<PlanVersion>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      if (state.tasksRevision !== command.expectedTasksRevision || state.currentPlanVersionId !== command.basePlanVersionId) conflict(state.tasksRevision);
      const locked = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      await this.authorize(actor, projectId, true);
      assertWritable(input, locked);
      if (!versionsEqual(input, locked)) conflict(state.tasksRevision);
      if (generated) {
        if (generated.snapshot.input.projectId !== projectId || !versionsEqual(generated.snapshot.input, locked) || generated.snapshot.tasksRevision !== state.tasksRevision || generated.snapshot.basePlanVersionId !== state.currentPlanVersionId) conflict(state.tasksRevision);
        // Lock all IDs before exact-version checks; follow the same global order as normal resource writes.
        await this.readResourceHeads([...state.tasks, { resourceRefs: generated.snapshot.resourceContentRefs.map(ref => ref.resourceId) }], input, transaction.sql);
        if (Object.entries(generated.snapshot.input.resourceContentVersions ?? {}).some(([id, version]) => input.resourceContentVersions?.[id] !== version)) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "生成期间资源公开依据已变化，请重新生成。", { status: 409 });
        await this.validateGenerationResources(generated.snapshot.resourceContentRefs, transaction.sql);
      }
      const materializedAt = this.now();
      const basis = source ? findPlan(state, source.planId) : undefined;
      const generationProvenance = generated?.provenance ?? basis?.generation;
      if (basis && source && fingerprint({ tasks: basis.tasks, buffers: basis.buffers }) !== source.contentHash) conflict(basis.revision);
      const tasks = this.materialize(command.tasks, state, projectId, materializedAt, command.reason, basis?.tasks);
      const pending = basis && basis.status !== "applied" && basis.status !== "superseded" ? basis.resourceReviewRequiredRefs : [];
      const resources = await this.checkResources(tasks, state, input, transaction.sql, "draft", command.tasks, pending, basis?.tasks ?? state.tasks);
      await this.checkSkillRefs(tasks, state, transaction.sql);
      await this.authorize(actor, projectId, true);
      const now = this.now();
      const historical = [...state.tasks, ...(basis?.tasks ?? [])];
      const validation = this.validateSnapshot(input, tasks, command.buffers, now, historical, resources.issues, generationProvenance?.assumptions);
      if (generated && !validation.structuralValid) throw new DomainError("INVALID_GENERATED_PLAN", "AI草案未通过任务、时间、成员或依赖规则校验，原计划已保留。", { status: 422, recoveryAction: "edit_manual_draft" });
      const base = state.plans.find(plan => plan.id === state.currentPlanVersionId);
      const plan: PlanVersion = {
        id: this.dependencies.ids.next(), projectId, basePlanVersionId: command.basePlanVersionId, baseTasksRevision: state.tasksRevision,
        inputSnapshot: input, tasks, buffers: structuredClone(command.buffers), validation,
        changes: [...diffPlans(state.tasks, tasks, base?.buffers ?? [], command.buffers), ...diffPlanInputs(base?.inputSnapshot, input, tasks), ...diffSchedules(base?.validation, validation)], status: validation.structuralValid ? "ready" : "needs_changes",
        reason: command.reason, createdBy: actor.userId, createdAt: now, appliedBy: null, appliedAt: null, acknowledgedIssueCodes: [], revision: 0,
        resourceReviewRequiredRefs: resources.required,
        resourceLegacyRefs: resources.legacy,
        ...(generationProvenance ? { generation: structuredClone(generationProvenance) } : {}),
      };
      const expected = state.revision;
      state.plans.push(plan); state.revision += 1;
      await transaction.save(state, expected);
      await this.event(transaction, "PlanDraftGenerated", projectId, plan.id, plan.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, plan);
      return plan;
    });
  }

  async apply(actor: Actor, projectId: string, planId: string, command: ApplyCommand): Promise<PlanVersion> {
    await this.authorize(actor, projectId, true);
    revision(command.expectedRevision); requiredText(command.idempotencyKey, "幂等键", 200);
    if (!Array.isArray(command.acknowledgedIssueCodes) || command.acknowledgedIssueCodes.some(code => typeof code !== "string")) throw new DomainError("INVALID_INPUT", "需要明确确认的风险代码列表。");
    const fresh = await this.input(projectId, this.now(), actor);
    const scope = `${actor.userId}:apply:${planId}`; const hash = fingerprint(command);
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      await this.authorize(actor, projectId, true);
      const replay = await transaction.getIdempotent<PlanVersion>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      const plan = findPlan(state, planId);
      if (plan.revision !== command.expectedRevision || plan.baseTasksRevision !== state.tasksRevision || plan.basePlanVersionId !== state.currentPlanVersionId) conflict(state.tasksRevision);
      if (plan.status !== "ready") throw new DomainError("PLAN_NOT_READY", "草案尚未通过应用检查，请先修正或重新校验。", { status: 409 });
      const versions = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      await this.authorize(actor, projectId, true);
      assertWritable(plan.inputSnapshot, fresh, versions);
      if (!versionsEqual(plan.inputSnapshot, versions) || !versionsEqual(fresh, versions)) conflict(state.tasksRevision);
      // Check current publication again; a stale resource recommendation cannot bypass review.
      const resources = await this.checkResources(plan.tasks, state, fresh, transaction.sql, "apply", [], plan.resourceReviewRequiredRefs, state.tasks, plan.resourceLegacyRefs);
      await this.checkSkillRefs(plan.tasks, state, transaction.sql);
      await this.authorize(actor, projectId, true);
      const now = this.now();
      const history = [...state.tasks, ...state.plans.filter(item => item.status === "applied" || item.status === "superseded").flatMap(item => item.tasks)];
      const validation = this.validateSnapshot(fresh, plan.tasks, plan.buffers, now, history, resources.issues, plan.generation?.assumptions);
      if (!validation.structuralValid) throw new DomainError("PLAN_INVALID", "当前草案存在结构错误，不能应用。", { recoveryAction: "edit_draft" });
      const unresolved = [...new Set(validation.issues.map(issue => issue.code))];
      if (unresolved.some(code => !command.acknowledgedIssueCodes.includes(code))) throw new DomainError("UNRESOLVED_CONSTRAINTS", "仍有未知项或不可行约束，需要逐项确认后才能应用。", { status: 409, recoveryAction: "review_issues" });
      if (validation.feasibility !== "feasible" && !unresolved.length) throw new DomainError("UNRESOLVED_CONSTRAINTS", "计划尚未证明可安排，不能静默确认。", { status: 409 });
      const old = state.plans.find(item => item.id === state.currentPlanVersionId);
      if (old) { old.status = "superseded"; old.revision += 1; }
      const expected = state.revision;
      state.tasks = plan.tasks.map(task => {
        const existing = state.tasks.find(item => item.id === task.id);
        return { ...structuredClone(task), revision: (existing?.revision ?? -1) + 1, updatedAt: now };
      });
      plan.tasks = structuredClone(state.tasks);
      plan.validation = validation; plan.status = "applied"; plan.appliedBy = actor.userId; plan.appliedAt = now;
      plan.acknowledgedIssueCodes = unresolved; plan.revision += 1;
      state.currentPlanVersionId = plan.id; state.tasksRevision += 1; state.revision += 1;
      for (const other of state.plans) if (other.id !== plan.id && other.status === "ready") { other.status = "stale"; other.revision += 1; }
      await transaction.save(state, expected);
      await this.event(transaction, "PlanApplied", projectId, plan.id, plan.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, plan);
      return plan;
    });
  }

  async editDraft(actor: Actor, projectId: string, planId: string, command: EditDraftCommand): Promise<PlanVersion> {
    await this.authorize(actor, projectId, true);
    revision(command.expectedRevision); revision(command.expectedTasksRevision);
    requiredText(command.reason, "变更理由"); requiredText(command.idempotencyKey, "幂等键", 200);
    const input = await this.input(projectId, this.now(), actor);
    const scope = `${actor.userId}:edit:${planId}`; const hash = fingerprint(command);
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      await this.authorize(actor, projectId, true);
      const replay = await transaction.getIdempotent<PlanVersion>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      const plan = findPlan(state, planId);
      if (plan.status === "applied" || plan.status === "superseded") throw new DomainError("PLAN_IMMUTABLE", "已应用历史版本不能原地修改，请建立新草案。", { status: 409 });
      if (plan.revision !== command.expectedRevision || state.tasksRevision !== command.expectedTasksRevision) conflict(state.tasksRevision);
      const locked = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      await this.authorize(actor, projectId, true);
      assertWritable(input, locked);
      if (!versionsEqual(input, locked)) conflict(state.tasksRevision);
      const tasks = this.materialize(command.tasks, state, projectId, this.now(), command.reason, plan.tasks);
      const resources = await this.checkResources(tasks, state, input, transaction.sql, "draft", command.tasks, plan.resourceReviewRequiredRefs, plan.tasks);
      await this.checkSkillRefs(tasks, state, transaction.sql);
      await this.authorize(actor, projectId, true);
      const now = this.now();
      const history = [...state.tasks, ...state.plans.filter(item => item.status === "applied" || item.status === "superseded").flatMap(item => item.tasks)];
      const validation = this.validateSnapshot(input, tasks, command.buffers, now, history, resources.issues, plan.generation?.assumptions);
      const base = state.plans.find(item => item.id === state.currentPlanVersionId);
      const expected = state.revision;
      plan.basePlanVersionId = state.currentPlanVersionId; plan.baseTasksRevision = state.tasksRevision;
      plan.tasks = tasks; plan.buffers = structuredClone(command.buffers); plan.inputSnapshot = input; plan.validation = validation;
      plan.changes = [...diffPlans(state.tasks, tasks, base?.buffers ?? [], command.buffers), ...diffPlanInputs(base?.inputSnapshot, input, tasks), ...diffSchedules(base?.validation, validation)]; plan.reason = command.reason;
      plan.status = validation.structuralValid ? "ready" : "needs_changes"; plan.revision += 1; state.revision += 1;
      plan.resourceReviewRequiredRefs = resources.required;
      plan.resourceLegacyRefs = resources.legacy;
      await transaction.save(state, expected);
      await this.event(transaction, "PlanDraftGenerated", projectId, plan.id, plan.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, plan);
      return plan;
    });
  }

  async restoreAsDraft(actor: Actor, projectId: string, historicalPlanId: string, command: Omit<DraftCommand, "tasks" | "buffers">): Promise<PlanVersion> {
    await this.authorize(actor, projectId, true);
    const state = await this.dependencies.repository.read(projectId);
    if (!state) throw new DomainError("NOT_FOUND", "未找到该历史计划。", { status: 404 });
    const historical = findPlan(state, historicalPlanId);
    const preserved = new Map(state.tasks.filter(task => task.status === "done").map(task => [task.id, task]));
    const tasks = historical.tasks.map(task => preserved.get(task.id) ?? task);
    for (const task of preserved.values()) if (!tasks.some(item => item.id === task.id)) tasks.push(task);
    return this.createDraftFromBasis(actor, projectId, { ...command, tasks: tasks.map(task => ({ ...this.toProposal(task), ...(task.status !== "cancelled" && state.tasks.some(current => current.id === task.id && current.status === "cancelled") ? { reopenCancelled: true } : {}) })), buffers: historical.buffers }, { planId: historicalPlanId, contentHash: fingerprint({ tasks: historical.tasks, buffers: historical.buffers }) });
  }
  private toProposal(task: PlanningTask): TaskProposal {
    const { status, remainingEstimate: _remaining, blocker: _blocker, acceptance: _acceptance, revision: _revision, updatedAt: _updated, cancellationReason, resourceContentRefs: _pins, ...definition } = task;
    return { ...definition, cancel: status === "cancelled", cancellationReason };
  }

  async updateProgress(actor: Actor, projectId: string, taskId: string, command: ProgressCommand): Promise<ProgressUpdate> {
    await this.authorize(actor, projectId);
    revision(command.expectedRevision); requiredText(command.idempotencyKey, "幂等键", 200);
    if (typeof command.note !== "string" || command.note.length > 4000 || !Array.isArray(command.evidenceRefs) || command.evidenceRefs.length > 50 || command.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 2000)) throw new DomainError("INVALID_INPUT", "进度说明与交付证据格式不合法。");
    if (command.remainingEstimate !== null && validateDurationEstimate(command.remainingEstimate).length) throw new DomainError("INVALID_ESTIMATE", "剩余工时必须满足非负且乐观≤常规≤保守，并说明估算依据。");
    const scope = `${actor.userId}:progress:${taskId}`; const hash = fingerprint(command);
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      const locked = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      const membership = await this.authorize(actor, projectId);
      const now = this.now();
      const replay = await transaction.getIdempotent<ProgressUpdate>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      assertWritable(locked);
      const task = state.tasks.find(item => item.id === taskId);
      if (!task) throw new DomainError("NOT_FOUND", "未找到该任务。", { status: 404 });
      const manager = membership.role === "manager";
      const owner = task.ownerMembershipId === membership.membershipId;
      const reviewer = task.reviewerMembershipId === membership.membershipId;
      if (!manager && !owner && !(reviewer && command.status === "done")) throw new DomainError("FORBIDDEN", "只能更新本人负责的任务或执行指定验收。", { status: 403 });
      if (task.revision !== command.expectedRevision) conflict(task.revision);
      const transitions: Record<TaskStatus, TaskStatus[]> = { todo: ["in_progress", "blocked", "review"], in_progress: ["in_progress", "blocked", "review"], blocked: ["blocked", "in_progress"], review: ["review", "in_progress", "blocked", "done"], done: ["done"], cancelled: [] };
      if (!transitions[task.status].includes(command.status)) throw new DomainError("INVALID_TRANSITION", "任务状态不能这样变化；完成前需要交付与验收。");
      if (task.status === "done") throw new DomainError("COMPLETED_TASK_IMMUTABLE", "已验收记录不能被普通进度覆盖；新增工作请建立新任务。");
      if (command.status === "in_progress" && task.status !== "in_progress" && unmetDependencies(task, state.tasks).length) throw new DomainError("DEPENDENCY_NOT_ACCEPTED", "前置成果还在等待检查，请先做其他已能开始的任务。", { status: 409, recoveryAction: "choose_ready_task" });
      if (command.status === "blocked") requiredText(command.blocker, "阻塞原因");
      if (command.status === "review" && !command.note.trim() && !command.evidenceRefs.length) throw new DomainError("DELIVERABLE_REQUIRED", "请补充成果说明或链接，方便队友检查。");
      if (command.correctionReason && !command.correctionOf) throw new DomainError("INVALID_CORRECTION", "更正理由需要关联本任务的原进度记录。");
      if (command.correctionOf) {
        if (!state.progressUpdates.some(update => update.id === command.correctionOf && update.taskId === taskId)) throw new DomainError("INVALID_CORRECTION", "修正必须引用本任务的已有进度记录。");
        requiredText(command.correctionReason, "修正理由");
      }
      let acceptance: Acceptance | null = null;
      if (command.status === "done") {
        if (!manager && !reviewer && !(owner && task.reviewerMembershipId === null)) throw new DomainError("FORBIDDEN", "完成需要指定验收人或项目管理员确认。", { status: 403 });
        if (!command.evidenceRefs.length || !task.acceptanceCriteria.length) throw new DomainError("ACCEPTANCE_REQUIRED", "完成需要交付证据和验收条件。");
        if (task.dependencyTaskIds.some(id => {
          const predecessor = state.tasks.find(candidate => candidate.id === id);
          return predecessor?.status !== "done" || predecessor.acceptance === null;
        })) throw new DomainError("DEPENDENCY_NOT_ACCEPTED", "前置成果尚未验收，不能确认后续任务完成。");
        requiredText(command.note, "验收依据");
        acceptance = { acceptedByUserId: actor.userId, acceptedAt: now, mode: manager ? "manager" : reviewer ? "reviewer" : "self_check", evidenceRefs: command.evidenceRefs, note: command.note };
      }
      const update: ProgressUpdate = {
        id: this.dependencies.ids.next(), projectId, taskId, actorId: actor.userId, status: command.status,
        remainingEstimate: command.status === "done" ? { optimisticMinutes: 0, likelyMinutes: 0, pessimisticMinutes: 0, basis: "已按验收条件确认" } : command.remainingEstimate ?? task.remainingEstimate,
        blocker: command.status === "blocked" ? command.blocker : null, evidenceRefs: [...command.evidenceRefs], note: command.note,
        correctionOf: command.correctionOf ?? null, correctionReason: command.correctionReason ?? null, acceptance, createdAt: now,
      };
      const expected = state.revision;
      task.status = update.status; task.remainingEstimate = update.remainingEstimate; task.blocker = update.blocker; task.acceptance = acceptance; task.updatedAt = now; task.revision += 1;
      state.progressUpdates.push(update); state.tasksRevision += 1; state.revision += 1;
      for (const plan of state.plans) if (plan.status === "ready") { plan.status = "stale"; plan.revision += 1; }
      await transaction.save(state, expected);
      await this.event(transaction, "ProgressUpdated", projectId, taskId, task.revision, now);
      if (command.status === "blocked") await this.event(transaction, "PlanRiskDetected", projectId, taskId, task.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, update);
      return update;
    });
  }

  /** A saved request never changes status, clears acceptance or releases a dependency. */
  async requestAcceptanceCorrection(actor: Actor, projectId: string, taskId: string, command: AcceptanceCorrectionRequestCommand): Promise<ProgressUpdate> {
    await this.authorize(actor, projectId);
    revision(command.expectedRevision); requiredText(command.acceptanceProgressId, "原检查记录"); requiredText(command.reason, "请求更正的理由"); requiredText(command.idempotencyKey, "幂等键", 200);
    const scope = `${actor.userId}:acceptance_correction_request:${taskId}`; const hash = fingerprint(command);
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      const locked = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      const membership = await this.authorize(actor, projectId); assertWritable(locked);
      const task = state.tasks.find(value => value.id === taskId);
      if (!task) throw new DomainError("NOT_FOUND", "未找到该任务。", { status: 404 });
      if (task.ownerMembershipId !== membership.membershipId && !task.helperEfforts.some(helper => helper.membershipId === membership.membershipId)) throw new DomainError("FORBIDDEN", "只能为本人负责或协助的任务请求更正。", { status: 403 });
      const replay = await transaction.getIdempotent<ProgressUpdate>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      if (task.revision !== command.expectedRevision) conflict(task.revision);
      if (task.status !== "done" || !task.acceptance) throw new DomainError("ACCEPTANCE_NOT_CURRENT", "此任务当前没有已通过的检查记录，请刷新后查看。", { status: 409 });
      const accepted = [...state.progressUpdates].reverse().find(update => update.taskId === taskId && update.acceptance !== null);
      if (!accepted || accepted.id !== command.acceptanceProgressId || JSON.stringify(accepted.acceptance) !== JSON.stringify(task.acceptance)) throw new DomainError("INVALID_CORRECTION", "更正请求必须引用当前检查通过的记录。", { status: 409 });
      const now = this.now(); const expected = state.revision;
      const update: ProgressUpdate = { id: this.dependencies.ids.next(), projectId, taskId, actorId: actor.userId, status: task.status, remainingEstimate: task.remainingEstimate, blocker: task.blocker, evidenceRefs: [], note: command.reason, correctionOf: accepted.id, correctionReason: command.reason, acceptance: null, createdAt: now, correctionRequest: { acceptanceProgressId: accepted.id, acceptance: structuredClone(task.acceptance) } };
      state.progressUpdates.push(update); state.revision += 1;
      await transaction.save(state, expected);
      await this.event(transaction, "PlanRiskDetected", projectId, task.id, task.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, update);
      return update;
    });
  }

  /** A separate manager operation revokes mistaken acceptance with explicit downstream review. */
  async correctAcceptance(actor: Actor, projectId: string, taskId: string, command: AcceptanceCorrectionCommand): Promise<ProgressUpdate> {
    await this.authorize(actor, projectId, true);
    revision(command.expectedRevision); revision(command.expectedTasksRevision);
    requiredText(command.correctionOf, "原验收记录"); requiredText(command.correctionReason, "更正理由"); requiredText(command.idempotencyKey, "幂等键", 200);
    if (!["in_progress", "review"].includes(command.status) || !Array.isArray(command.acknowledgedDependentTaskIds) || command.acknowledgedDependentTaskIds.some(id => typeof id !== "string" || !id.trim()) || new Set(command.acknowledgedDependentTaskIds).size !== command.acknowledgedDependentTaskIds.length) throw new DomainError("INVALID_INPUT", "需要选择重新处理状态并核对全部受影响的后续任务。");
    const scope = `${actor.userId}:acceptance_correction:${taskId}`; const hash = fingerprint(command);
    return this.dependencies.repository.transaction(projectId, async (state, transaction) => {
      const locked = await this.dependencies.facts.lockVersions(projectId, transaction.sql, actor);
      await this.authorize(actor, projectId, true); assertWritable(locked);
      const replay = await transaction.getIdempotent<ProgressUpdate>(scope, command.idempotencyKey, hash);
      if (replay) return replay;
      const task = state.tasks.find(value => value.id === taskId);
      if (!task) throw new DomainError("NOT_FOUND", "未找到该任务。", { status: 404 });
      if (state.tasksRevision !== command.expectedTasksRevision || task.revision !== command.expectedRevision) conflict(state.tasksRevision);
      if (task.status !== "done" || !task.acceptance) throw new DomainError("ACCEPTANCE_NOT_CURRENT", "此任务当前没有可更正的验收记录，请刷新任务板。", { status: 409 });
      const accepted = [...state.progressUpdates].reverse().find(update => update.taskId === taskId && update.acceptance !== null);
      if (!accepted || accepted.id !== command.correctionOf || JSON.stringify(accepted.acceptance) !== JSON.stringify(task.acceptance)) throw new DomainError("INVALID_CORRECTION", "更正必须引用本任务当前验收的进度记录。", { status: 409 });
      const impactedIds = dependentTaskIds(taskId, state.tasks);
      if (JSON.stringify(impactedIds) !== JSON.stringify([...command.acknowledgedDependentTaskIds].sort())) throw new DomainError("CORRECTION_IMPACT_UNACKNOWLEDGED", "请逐项核对受影响的后续任务；已经检查的成果会重新进入待检查。", { status: 409, recoveryAction: "review_dependent_tasks" });
      if (command.status === "in_progress" && unmetDependencies(task, state.tasks).length) throw new DomainError("DEPENDENCY_NOT_ACCEPTED", "此任务的前置成果尚未验收，可先退回待检查并核对依赖。", { status: 409 });
      const now = this.now(); const expected = state.revision;
      const previousAcceptance = structuredClone(task.acceptance);
      const impactedTasks = impactedIds.map(id => {
        const dependent = state.tasks.find(value => value.id === id)!;
        return { taskId: id, previousStatus: dependent.status, previousAcceptance: structuredClone(dependent.acceptance), status: dependent.status === "done" ? "review" as const : dependent.status === "in_progress" ? "blocked" as const : dependent.status };
      });
      const update: ProgressUpdate = {
        id: this.dependencies.ids.next(), projectId, taskId, actorId: actor.userId, status: command.status,
        remainingEstimate: null, blocker: null, evidenceRefs: [...previousAcceptance.evidenceRefs], note: command.correctionReason,
        correctionOf: accepted.id, correctionReason: command.correctionReason, acceptance: null, createdAt: now,
        acceptanceCorrection: { previousAcceptance, impactedTasks },
      };
      task.status = command.status; task.acceptance = null; task.remainingEstimate = null; task.blocker = null; task.updatedAt = now; task.revision += 1;
      state.progressUpdates.push(update);
      for (const impact of impactedTasks) {
        const dependent = state.tasks.find(value => value.id === impact.taskId)!;
        if (dependent.status === impact.status && dependent.acceptance === null) continue;
        const prior = [...state.progressUpdates].reverse().find(value => value.taskId === dependent.id);
        dependent.status = impact.status; dependent.acceptance = null;
        if (dependent.status === "blocked") dependent.blocker = `前置成果“${task.title}”的验收已更正：${command.correctionReason}`;
        dependent.remainingEstimate = null; dependent.updatedAt = now; dependent.revision += 1;
        state.progressUpdates.push({ id: this.dependencies.ids.next(), projectId, taskId: dependent.id, actorId: actor.userId, status: dependent.status, remainingEstimate: null, blocker: dependent.blocker, evidenceRefs: [...(impact.previousAcceptance?.evidenceRefs ?? [])], note: `请重新检查前置成果“${task.title}”：${command.correctionReason}`, correctionOf: prior?.id ?? null, correctionReason: command.correctionReason, acceptance: null, createdAt: now });
        await this.event(transaction, "ProgressUpdated", projectId, dependent.id, dependent.revision, now);
      }
      state.tasksRevision += 1; state.revision += 1;
      for (const plan of state.plans) if (plan.status === "ready") { plan.status = "stale"; plan.revision += 1; }
      await transaction.save(state, expected);
      await this.event(transaction, "ProgressUpdated", projectId, task.id, task.revision, now);
      await this.event(transaction, "PlanRiskDetected", projectId, task.id, task.revision, now);
      await transaction.putIdempotent(scope, command.idempotencyKey, hash, update);
      return update;
    });
  }
}
