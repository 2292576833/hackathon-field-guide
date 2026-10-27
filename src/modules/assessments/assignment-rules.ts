import { DomainError } from "../../shared/errors.ts";
import type { AssignmentChange, AssignmentContextSnapshot, AssignmentGap, AssignmentInputSnapshot, ProjectMemberSnapshot, ProposedAssignment, TeamAssessmentSummary } from "./types.ts";
import { array, invalid, keys, object, optionalId, string, strings } from "./validation.ts";

export interface AssignmentDraftData {
  readonly assignments: readonly ProposedAssignment[];
  readonly gaps: readonly AssignmentGap[];
  readonly assumptions: readonly string[];
  readonly validationIssues: readonly string[];
}
export function validateAssignmentDraft(value: unknown, context: AssignmentContextSnapshot, summaries: readonly TeamAssessmentSummary[]): AssignmentDraftData {
  const draft = object(value, "分工草案");
  keys(draft, ["assignments", "gaps", "assumptions"], "分工草案");
  const active = new Set(context.members.filter((member) => member.status === "active").map((member) => member.membershipId));
  const validationIssues: string[] = [];
  const tracks = context.officialTracks;
  const selectedTrackNeedsReview = tracks?.needsReview === true && (tracks.selectedTrackId !== null || (context.trackSelectionRevision ?? 0) > 0);
  if (selectedTrackNeedsReview) validationIssues.push("项目选择的官方赛道需要复核；可以先编辑通用准备草案，复核后再确认分工。");
  const assignments = array(draft.assignments, "任务", 100).map((entry) => {
    const data = object(entry, "分工任务");
    keys(data, ["clientTaskId", "title", "priority", "ownerMembershipId", "helperMembershipIds", "deliverable", "acceptanceCriteria", "dependencyTaskIds", "proposedDeadlineRef", "reason", "evidenceLevel"], "分工任务");
    const clientTaskId = string(data.clientTaskId, "任务 ID", 200);
    const ownerMembershipId = optionalId(data.ownerMembershipId, "负责人");
    const helperMembershipIds = strings(data.helperMembershipIds, "协助者", 30, 200);
    if ((ownerMembershipId !== null && !active.has(ownerMembershipId)) || helperMembershipIds.some((id) => !active.has(id))) invalid("负责人和协助者必须是本项目的活跃项目成员。");
    if (ownerMembershipId !== null && helperMembershipIds.includes(ownerMembershipId)) invalid("负责人不能同时重复列为协助者。");
    if (!["must", "optional"].includes(data.priority as string)) invalid("任务优先级不支持。");
    if (!["self_reported", "assessed", "missing", "verified"].includes(data.evidenceLevel as string)) invalid("任务依据类型不支持。");
    if (data.evidenceLevel === "verified") throw new DomainError("UNVERIFIED_EVIDENCE", "尚未接入交付证据核验，不能标为已验证依据。");
    if (data.evidenceLevel === "assessed" && !summaries.some((summary) => summary.membershipId === ownerMembershipId && summary.criterionScores.some((criterion) => criterion.state === "scored"))) invalid("测评依据必须来自负责人当前明确共享的已评分项。");
    if (ownerMembershipId === null) validationIssues.push(`${clientTaskId} 尚无负责人。`);
    const acceptanceCriteria = strings(data.acceptanceCriteria, "验收条件", 30, 2000);
    if (acceptanceCriteria.length === 0) invalid("每项任务至少需要一条验收条件。");
    return {
      clientTaskId,
      title: string(data.title, "任务标题", 300),
      priority: data.priority as "must" | "optional",
      ownerMembershipId,
      helperMembershipIds,
      deliverable: string(data.deliverable, "交付物", 2000),
      acceptanceCriteria,
      dependencyTaskIds: strings(data.dependencyTaskIds, "任务依赖", 100, 200),
      proposedDeadlineRef: optionalId(data.proposedDeadlineRef, "建议截止点"),
      reason: string(data.reason, "分工理由", 2000),
      evidenceLevel: data.evidenceLevel as ProposedAssignment["evidenceLevel"],
    };
  });
  const taskIds = new Set(assignments.map((assignment) => assignment.clientTaskId));
  if (taskIds.size !== assignments.length) invalid("分工任务 ID 不能重复。");
  if (assignments.length === 0) validationIssues.push("草案尚无任务。");
  for (const assignment of assignments) {
    if (assignment.dependencyTaskIds.some((id) => !taskIds.has(id) || id === assignment.clientTaskId)) invalid("任务依赖必须引用草案中的其他任务。");
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("任务依赖存在循环，请先调整依赖。");
    if (visited.has(id)) return;
    visiting.add(id);
    assignments.find((entry) => entry.clientTaskId === id)!.dependencyTaskIds.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  taskIds.forEach(visit);
  const gaps = array(draft.gaps, "能力缺口", 30).map((entry) => {
    const data = object(entry, "能力缺口");
    keys(data, ["taskArea", "reason", "suggestions"], "能力缺口");
    const suggestions = strings(data.suggestions, "缺口建议", 10, 2000);
    if (suggestions.length === 0) invalid("缺口至少需要一个可执行建议。");
    return { taskArea: string(data.taskArea, "缺口领域", 300), reason: string(data.reason, "缺口理由", 2000), suggestions };
  });
  const assumptions = strings(draft.assumptions, "分工假设", 30, 2000);
  const trackAssumptions: string[] = [];
  if (!tracks || tracks.catalogStatus === "unknown") trackAssumptions.push("官方赛道尚未核对；先安排通用准备，不表示已符合特定赛道的资格或材料要求。");
  else if (tracks.catalogStatus === "none") trackAssumptions.push("主办方未细分赛道，按当前已知要求安排通用准备。");
  else if (tracks.catalogStatus === "conflict") trackAssumptions.push("官方赛道资料仍有冲突；先安排通用准备，参赛资格和对应材料需要核对。");
  else if (tracks.selectedTrackId === null) trackAssumptions.push("项目尚未选择官方赛道，先安排通用准备；特定赛道要求待选择后复核。");
  return { assignments, gaps, assumptions: [...new Set([...assumptions, ...trackAssumptions, "建议期限与时间可行性由时间规划模块另行校验。", "测评得分不转换为开发速度；未测评成员仍可手动安排。"])], validationIssues };
}
export function assignmentChanges(previous: readonly ProposedAssignment[], next: readonly ProposedAssignment[]): readonly AssignmentChange[] {
  const changes: AssignmentChange[] = [];
  for (const task of next) {
    const old = previous.find((entry) => entry.clientTaskId === task.clientTaskId);
    if (!old) { changes.push({ clientTaskId: task.clientTaskId, kind: "added", fields: [] }); continue; }
    const fields = (Object.keys(task) as (keyof ProposedAssignment)[]).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(task[key]));
    if (fields.length) changes.push({ clientTaskId: task.clientTaskId, kind: "modified", fields });
  }
  previous.filter((task) => !next.some((entry) => entry.clientTaskId === task.clientTaskId)).forEach((task) => changes.push({ clientTaskId: task.clientTaskId, kind: "removed", fields: [] }));
  return changes;
}
function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
/** JSONB does not preserve object key insertion order. Only declared domain fields
 * enter the fingerprint; arrays representing member/reference sets use stable ID order.
 */
function normalizedMembers(members: readonly ProjectMemberSnapshot[], includeSharedContent = false): readonly ProjectMemberSnapshot[] {
  return members.map((member) => ({
    membershipId: member.membershipId,
    userId: member.userId,
    role: member.role,
    status: member.status,
    memberAvailabilityVersionId: member.memberAvailabilityVersionId,
    availableMinutes: member.availableMinutes ?? null,
    ...(member.sharedIntention === undefined ? {} : { sharedIntention: {
      revision: member.sharedIntention.revision, membershipRevision: member.sharedIntention.membershipRevision,
      ...(includeSharedContent && member.sharedIntention.duties !== undefined ? { duties: [...member.sharedIntention.duties].sort(compareId) } : {}),
      ...(includeSharedContent && member.sharedIntention.experience !== undefined ? { experience: member.sharedIntention.experience } : {}),
      ...(includeSharedContent && member.sharedIntention.wantsAiHelp !== undefined ? { wantsAiHelp: member.sharedIntention.wantsAiHelp } : {}),
      ...(includeSharedContent && member.sharedIntention.helpQuestion !== undefined ? { helpQuestion: member.sharedIntention.helpQuestion } : {}),
    } }),
  })).sort((left, right) => compareId(left.membershipId, right.membershipId));
}
function normalizedCollaboration(context: AssignmentContextSnapshot) {
  const tracks = context.officialTracks;
  const evidenceIds = (ids: readonly string[]) => [...ids].sort(compareId);
  return {
    officialTracks: tracks == null ? null : {
      eventId: tracks.eventId, rulesVersion: tracks.rulesVersion, confirmationRevision: tracks.confirmationRevision,
      catalogStatus: tracks.catalogStatus, selectedTrackId: tracks.selectedTrackId, needsReview: tracks.needsReview,
      tracks: tracks.tracks.map((track) => ({
        id: track.id, name: track.name,
        eligibility: track.eligibility === null ? null : { text: track.eligibility.text, evidenceIds: evidenceIds(track.eligibility.evidenceIds) },
        scoringFocus: track.scoringFocus === null ? null : { text: track.scoringFocus.text, evidenceIds: evidenceIds(track.scoringFocus.evidenceIds) },
        deliverables: track.deliverables.map((item) => ({ requirementId: item.requirementId, evidenceIds: evidenceIds(item.evidenceIds) })).sort((a, b) => compareId(a.requirementId, b.requirementId)),
        evidenceIds: evidenceIds(track.evidenceIds),
      })).sort((a, b) => compareId(a.id, b.id)),
      evidenceIds: evidenceIds(tracks.evidenceIds),
    },
    trackSelectionRevision: context.trackSelectionRevision ?? null,
    memberIntentionRefs: (context.memberIntentionRefs ?? []).map((ref) => ({ membershipId: ref.membershipId, revision: ref.revision })).sort((a, b) => compareId(a.membershipId, b.membershipId)),
    confirmedRequirements: (context.confirmedRequirements ?? []).map((item) => ({ id: item.id, text: item.text, evidenceIds: evidenceIds(item.evidenceIds) })).sort((a, b) => compareId(a.id, b.id)),
  };
}
function normalizedSummaryRefs(refs: AssignmentInputSnapshot["sharedSummaryRefs"]): AssignmentInputSnapshot["sharedSummaryRefs"] {
  return refs.map((ref) => ({ attemptId: ref.attemptId, revision: ref.revision }))
    .sort((left, right) => compareId(left.attemptId, right.attemptId) || left.revision - right.revision);
}
export function contextFingerprint(context: AssignmentContextSnapshot): string {
  return JSON.stringify({
    projectId: context.projectId,
    stage: context.stage ?? null,
    readOnly: context.readOnly === true,
    projectRevision: context.projectRevision,
    membershipRevision: context.membershipRevision,
    requirementVersionId: context.requirementVersionId,
    ...normalizedCollaboration(context),
    members: normalizedMembers(context.members),
  });
}
export function inputSnapshot(context: AssignmentContextSnapshot, summaries: readonly TeamAssessmentSummary[]): AssignmentInputSnapshot {
  return {
    projectId: context.projectId,
    ...(context.stage === undefined ? {} : { stage: context.stage }),
    readOnly: context.readOnly === true,
    projectRevision: context.projectRevision,
    membershipRevision: context.membershipRevision,
    requirementVersionId: context.requirementVersionId,
    ...normalizedCollaboration(context),
    members: normalizedMembers(context.members),
    sharedSummaryRefs: normalizedSummaryRefs(summaries.map((summary) => ({ attemptId: summary.attemptId, revision: summary.revision }))),
  };
}
/** Transient model input only. Persisted/public snapshots carry consent revision refs,
 * not shared experience/question text which could later be withdrawn by the author. */
export function modelContextSnapshot(context: AssignmentContextSnapshot): AssignmentContextSnapshot {
  return { ...inputSnapshot(context, []), members: normalizedMembers(context.members, true) };
}
export function ensureSnapshotCurrent(snapshot: AssignmentInputSnapshot, context: AssignmentContextSnapshot, summaries: readonly TeamAssessmentSummary[]): void {
  if (!isSnapshotCurrent(snapshot, context, summaries)) {
    throw new DomainError("ASSIGNMENT_INPUT_CHANGED", "比赛赛道、项目、成员意愿、可用时间或共享摘要已变化，请重新检查草案。", { status: 409, recoveryAction: "refresh_assignment_inputs" });
  }
}
export function isSnapshotCurrent(snapshot: AssignmentInputSnapshot, context: AssignmentContextSnapshot, summaries: readonly Pick<TeamAssessmentSummary, "attemptId" | "revision">[]): boolean {
  return contextFingerprint(snapshot) === contextFingerprint(context)
    && JSON.stringify(normalizedSummaryRefs(snapshot.sharedSummaryRefs)) === JSON.stringify(normalizedSummaryRefs(summaries.map((summary) => ({ attemptId: summary.attemptId, revision: summary.revision }))));
}
