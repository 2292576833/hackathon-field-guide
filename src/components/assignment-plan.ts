import type { AssignmentVersion } from "../modules/assessments/types.ts";
import type { PlanningDeadline, PlanningTask, TaskKind } from "../modules/planning/types.ts";

export interface EditableEffort {
  membershipId: string;
  optimistic: string;
  likely: string;
  pessimistic: string;
  basis: string;
}
export interface EditablePlanTask {
  id: string;
  title: string;
  kind: TaskKind | "";
  priority: "must" | "optional";
  owner: string;
  helpers: EditableEffort[];
  deliverable: string;
  criteria: string;
  optimistic: string;
  likely: string;
  pessimistic: string;
  basis: string;
  deadlineRef: string;
  dependencies: string[];
  requirementRefs: string[];
  /** Keep fields outside the simple editor when continuing a saved plan. */
  sourceDefinition?: PlanningTask;
}

/** Pure conversion; this does not choose a purpose, estimate effort or apply either version. */
export function importAssignmentTasks(
  assignment: Pick<AssignmentVersion, "status" | "assignments">,
  occupiedTaskIds: readonly string[],
  deadlines: readonly PlanningDeadline[],
): { tasks: EditablePlanTask[]; skipped: number } {
  if (assignment.status !== "applied") throw new Error("只能从当前已确认的分工带入任务。");
  const occupied = new Set(occupiedTaskIds);
  const validDeadlines = new Set(deadlines.map(deadline => deadline.id));
  let skipped = 0;
  const tasks: EditablePlanTask[] = [];
  for (const task of assignment.assignments) {
    if (occupied.has(task.clientTaskId)) { skipped++; continue; }
    occupied.add(task.clientTaskId);
    tasks.push({
      id: task.clientTaskId, title: task.title, kind: "", priority: task.priority,
      owner: task.ownerMembershipId ?? "", deliverable: task.deliverable,
      criteria: task.acceptanceCriteria.join("\n"),
      helpers: task.helperMembershipIds.map(membershipId => ({ membershipId, optimistic: "", likely: "", pessimistic: "", basis: "" })),
      optimistic: "", likely: "", pessimistic: "", basis: "",
      deadlineRef: task.proposedDeadlineRef && validDeadlines.has(task.proposedDeadlineRef) ? task.proposedDeadlineRef : deadlines.length === 1 ? deadlines[0]!.id : "",
      dependencies: [...task.dependencyTaskIds], requirementRefs: [],
    });
  }
  return { tasks, skipped };
}

export function editableFromPlanTask(task: PlanningTask): EditablePlanTask {
  return {
    id: task.id, title: task.title, kind: task.kind, priority: task.priority,
    owner: task.ownerMembershipId ?? "", deliverable: task.deliverable, criteria: task.acceptanceCriteria.join("\n"),
    helpers: task.helperEfforts.map(helper => ({ membershipId: helper.membershipId, optimistic: String(helper.durationEstimate.optimisticMinutes), likely: String(helper.durationEstimate.likelyMinutes), pessimistic: String(helper.durationEstimate.pessimisticMinutes), basis: helper.durationEstimate.basis })),
    optimistic: String(task.durationEstimate.optimisticMinutes), likely: String(task.durationEstimate.likelyMinutes), pessimistic: String(task.durationEstimate.pessimisticMinutes), basis: task.durationEstimate.basis,
    deadlineRef: task.deadlineRef, dependencies: [...task.dependencyTaskIds], requirementRefs: [...task.requirementRefs], sourceDefinition: structuredClone(task),
  };
}

/** Transport accepts definitions only; progress and pinned resource versions stay server-owned. */
export function planningDefinition(task: PlanningTask) {
  const { status, remainingEstimate: _remaining, blocker: _blocker, acceptance: _acceptance, revision: _revision, updatedAt: _updated, resourceContentRefs: _content, cancellationReason, ...definition } = task;
  return { ...definition, ...(status === "cancelled" ? { cancel: true, cancellationReason } : {}) };
}
