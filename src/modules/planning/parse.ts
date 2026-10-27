import { DomainError } from "../../shared/errors.ts";
import { parseTaskSkillReferences } from "../skills/index.ts";
import type { AcceptanceCorrectionCommand, AcceptanceCorrectionRequestCommand, ApplyCommand, DraftCommand, EditDraftCommand, ProgressCommand, TaskProposal } from "./service.ts";
import type { BufferPolicy, DurationEstimate, TaskKind, TaskStatus } from "./types.ts";

function invalid(field: string): never { throw new DomainError("INVALID_INPUT", `${field}格式不合法。`, { status: 400 }); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[], field: string): void {
  if (Object.keys(value).some(key => !fields.includes(key))) invalid(`${field}包含不支持的字段`);
}
function str(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 4000) invalid(field);
  return value;
}
function nullableStr(value: unknown, field: string): string | null { return value === null ? null : str(value, field); }
function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(field);
  return value;
}
function integer(value: unknown, field: string): number { const result = num(value, field); if (!Number.isSafeInteger(result)) invalid(field); return result; }
function array<T>(value: unknown, field: string, parse: (entry: unknown, field: string) => T): T[] {
  if (!Array.isArray(value) || value.length > 500) invalid(field);
  return value.map((entry, index) => parse(entry, `${field}[${index}]`));
}
function stringList(value: unknown, field: string): string[] { return array(value, field, (entry, label) => str(entry, label)); }
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(field);
  return value as T;
}
function boolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") invalid(field); return value; }

export function parseDurationEstimate(value: unknown, field = "durationEstimate"): DurationEstimate {
  const v = object(value, field); exact(v, ["optimisticMinutes", "likelyMinutes", "pessimisticMinutes", "basis"], field);
  const optimisticMinutes = num(v.optimisticMinutes, `${field}.optimisticMinutes`);
  const likelyMinutes = num(v.likelyMinutes, `${field}.likelyMinutes`);
  const pessimisticMinutes = num(v.pessimisticMinutes, `${field}.pessimisticMinutes`);
  if (optimisticMinutes > likelyMinutes || likelyMinutes > pessimisticMinutes) invalid(`${field}工时区间`);
  return { optimisticMinutes, likelyMinutes, pessimisticMinutes, basis: str(v.basis, `${field}.basis`) };
}
export function parseTaskProposal(value: unknown, field = "task"): TaskProposal {
  const v = object(value, field);
  exact(v, ["id", "projectId", "title", "priority", "kind", "ownerMembershipId", "helperEfforts", "deliverable", "acceptanceCriteria", "reviewerMembershipId", "durationEstimate", "dependencyTaskIds", "deadlineRef", "requirementRefs", "resourceRefs", "skillRefs", "splittable", "contextSwitchMinutes", "waitMinutes", "cancel", "reopenCancelled", "cancellationReason", "refreshResourceRefs"], field);
  const kinds: TaskKind[] = ["implementation", "learning", "debugging", "handoff", "integration", "testing", "material", "submission"];
  return {
    id: str(v.id, `${field}.id`), projectId: str(v.projectId, `${field}.projectId`), title: str(v.title, `${field}.title`), priority: choice(v.priority, ["must", "optional"], `${field}.priority`), kind: choice(v.kind, kinds, `${field}.kind`),
    ownerMembershipId: nullableStr(v.ownerMembershipId, `${field}.ownerMembershipId`), reviewerMembershipId: nullableStr(v.reviewerMembershipId, `${field}.reviewerMembershipId`),
    helperEfforts: array(v.helperEfforts, `${field}.helperEfforts`, (entry, label) => { const helper = object(entry, label); exact(helper, ["membershipId", "durationEstimate"], label); return { membershipId: str(helper.membershipId, `${label}.membershipId`), durationEstimate: parseDurationEstimate(helper.durationEstimate, `${label}.durationEstimate`) }; }),
    deliverable: str(v.deliverable, `${field}.deliverable`), acceptanceCriteria: stringList(v.acceptanceCriteria, `${field}.acceptanceCriteria`), durationEstimate: parseDurationEstimate(v.durationEstimate, `${field}.durationEstimate`),
    dependencyTaskIds: stringList(v.dependencyTaskIds, `${field}.dependencyTaskIds`), deadlineRef: str(v.deadlineRef, `${field}.deadlineRef`), requirementRefs: stringList(v.requirementRefs, `${field}.requirementRefs`), resourceRefs: stringList(v.resourceRefs, `${field}.resourceRefs`),
    ...(v.skillRefs === undefined ? {} : { skillRefs: [...parseTaskSkillReferences(v.skillRefs)!] }),
    splittable: boolean(v.splittable, `${field}.splittable`), contextSwitchMinutes: num(v.contextSwitchMinutes, `${field}.contextSwitchMinutes`), waitMinutes: num(v.waitMinutes, `${field}.waitMinutes`),
    ...(v.cancel === undefined ? {} : { cancel: boolean(v.cancel, `${field}.cancel`) }), ...(v.cancellationReason === undefined ? {} : { cancellationReason: nullableStr(v.cancellationReason, `${field}.cancellationReason`) }),
    ...(v.reopenCancelled === undefined ? {} : { reopenCancelled: boolean(v.reopenCancelled, `${field}.reopenCancelled`) }),
    ...(v.refreshResourceRefs === undefined ? {} : { refreshResourceRefs: stringList(v.refreshResourceRefs, `${field}.refreshResourceRefs`) }),
  };
}
function parseBuffer(value: unknown, field: string): BufferPolicy {
  const v = object(value, field); exact(v, ["deadlineId", "reservedMinutes", "basis"], field);
  return { deadlineId: str(v.deadlineId, `${field}.deadlineId`), reservedMinutes: num(v.reservedMinutes, `${field}.reservedMinutes`), basis: str(v.basis, `${field}.basis`) };
}
export function parseDraftCommand(value: unknown): DraftCommand {
  const v = object(value, "草案"); exact(v, ["tasks", "buffers", "reason", "expectedTasksRevision", "basePlanVersionId", "idempotencyKey"], "草案");
  return { tasks: array(v.tasks, "tasks", parseTaskProposal), buffers: array(v.buffers, "buffers", parseBuffer), reason: str(v.reason, "reason"), expectedTasksRevision: integer(v.expectedTasksRevision, "expectedTasksRevision"), basePlanVersionId: nullableStr(v.basePlanVersionId, "basePlanVersionId"), idempotencyKey: str(v.idempotencyKey, "idempotencyKey") };
}
export function parseApplyCommand(value: unknown): ApplyCommand {
  const v = object(value, "应用"); exact(v, ["expectedRevision", "acknowledgedIssueCodes", "idempotencyKey"], "应用");
  return { expectedRevision: integer(v.expectedRevision, "expectedRevision"), acknowledgedIssueCodes: stringList(v.acknowledgedIssueCodes, "acknowledgedIssueCodes"), idempotencyKey: str(v.idempotencyKey, "idempotencyKey") };
}
export function parseEditDraftCommand(value: unknown): EditDraftCommand {
  const v = object(value, "编辑草案"); exact(v, ["tasks", "buffers", "reason", "expectedTasksRevision", "expectedRevision", "idempotencyKey"], "编辑草案");
  const parsed = parseDraftCommand({ tasks: v.tasks, buffers: v.buffers, reason: v.reason, expectedTasksRevision: v.expectedTasksRevision, idempotencyKey: v.idempotencyKey, basePlanVersionId: null });
  const { basePlanVersionId: _base, ...command } = parsed;
  return { ...command, expectedRevision: integer(v.expectedRevision, "expectedRevision") };
}
export function parseProgressCommand(value: unknown): ProgressCommand {
  const v = object(value, "进度"); exact(v, ["expectedRevision", "status", "remainingEstimate", "blocker", "evidenceRefs", "note", "correctionOf", "correctionReason", "idempotencyKey"], "进度");
  const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "review", "done", "cancelled"];
  return { expectedRevision: integer(v.expectedRevision, "expectedRevision"), status: choice(v.status, statuses, "status"), remainingEstimate: v.remainingEstimate === null ? null : parseDurationEstimate(v.remainingEstimate, "remainingEstimate"), blocker: nullableStr(v.blocker, "blocker"), evidenceRefs: stringList(v.evidenceRefs, "evidenceRefs"), note: str(v.note, "note", true),
    ...(v.correctionOf === undefined ? {} : { correctionOf: nullableStr(v.correctionOf, "correctionOf") }), ...(v.correctionReason === undefined ? {} : { correctionReason: nullableStr(v.correctionReason, "correctionReason") }), idempotencyKey: str(v.idempotencyKey, "idempotencyKey") };
}
export function parseAcceptanceCorrectionCommand(value: unknown): AcceptanceCorrectionCommand {
  const v = object(value, "验收更正"); exact(v, ["expectedRevision", "expectedTasksRevision", "correctionOf", "correctionReason", "status", "acknowledgedDependentTaskIds", "idempotencyKey"], "验收更正");
  return { expectedRevision: integer(v.expectedRevision, "expectedRevision"), expectedTasksRevision: integer(v.expectedTasksRevision, "expectedTasksRevision"), correctionOf: str(v.correctionOf, "correctionOf"), correctionReason: str(v.correctionReason, "correctionReason"), status: choice(v.status, ["in_progress", "review"], "status"), acknowledgedDependentTaskIds: stringList(v.acknowledgedDependentTaskIds, "acknowledgedDependentTaskIds"), idempotencyKey: str(v.idempotencyKey, "idempotencyKey") };
}
export function parseAcceptanceCorrectionRequestCommand(value: unknown): AcceptanceCorrectionRequestCommand {
  const v = object(value, "请求更正"); exact(v, ["expectedRevision", "acceptanceProgressId", "reason", "idempotencyKey"], "请求更正");
  return { expectedRevision: integer(v.expectedRevision, "expectedRevision"), acceptanceProgressId: str(v.acceptanceProgressId, "acceptanceProgressId"), reason: str(v.reason, "reason"), idempotencyKey: str(v.idempotencyKey, "idempotencyKey") };
}
