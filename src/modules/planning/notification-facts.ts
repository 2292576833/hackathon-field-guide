import { createHash } from "node:crypto";
import type { CurrentPlanningView, PlanningInput, ProgressUpdate } from "./types.ts";
import type { PlanningNotificationCause, PlanningNotificationFact, PlanningNotificationSnapshot } from "./notification-types.ts";

/** Canonical keys avoid spurious notifications from JSONB property order or collection order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function revision(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function equal(a: unknown, b: unknown): boolean { return revision(a) === revision(b); }

/** Existing evaluations and immutable facts only. No model, state mutation or new completion status. */
export function derivePlanningNotificationFacts({ current, input, progress = [] }: { current: CurrentPlanningView; input: PlanningInput; progress?: readonly ProgressUpdate[] }): PlanningNotificationSnapshot {
  if (!current.plan || input.projectArchived) return { facts: [] };
  const facts: PlanningNotificationFact[] = [];
  const add = (cause: PlanningNotificationCause, source: unknown, taskId?: string, label?: string, requiresAction = true) => facts.push({ cause, sourceRevision: revision(source), requiresAction, ...(taskId ? { taskId } : {}), ...(label ? { label } : {}) });
  const before = current.plan.inputSnapshot;
  if (!equal(before.requirementVersionId, input.requirementVersionId)) add("rules_changed", [current.plan.id, input.requirementVersionId]);
  if (!equal(before.availabilityVersions, input.availabilityVersions)) add("availability_changed", [current.plan.id, input.availabilityVersions]);
  const memberIds = (value: PlanningInput) => value.members.filter(member => member.status === "active").map(member => member.membershipId).sort();
  const isActive = (membershipId: string | null) => input.members.some(member => member.status === "active" && member.membershipId === membershipId);
  const changedOwners = current.tasks.filter(task => task.status !== "done" && task.status !== "cancelled" && (!isActive(task.ownerMembershipId) || (task.reviewerMembershipId !== null && !isActive(task.reviewerMembershipId)) || task.helperEfforts.some(helper => !isActive(helper.membershipId))));
  const ownershipChanges = (current.plan.changes ?? []).filter(change => change.action === "changed" && change.fields.some(field => ["ownerMembershipId", "helperEfforts", "reviewerMembershipId"].includes(field)));
  const hasActiveOwnershipChange = ownershipChanges.some(change => current.tasks.some(task => task.id === change.taskId && !["done", "cancelled"].includes(task.status)));
  const ownerRisk = !equal(memberIds(before), memberIds(input)) || changedOwners.length > 0;
  if (ownerRisk || hasActiveOwnershipChange) add("owner_changed", ownerRisk ? [current.plan.id, memberIds(input), changedOwners.map(task => [task.id, task.ownerMembershipId, task.revision]).sort(), ownershipChanges] : [current.plan.id, "applied_owners", ownershipChanges], undefined, undefined, ownerRisk);
  if (current.inputVersionsChanged && equal(before.requirementVersionId, input.requirementVersionId) && equal(before.availabilityVersions, input.availabilityVersions) && equal(memberIds(before), memberIds(input))) {
    add("input_changed", [current.plan.id, input.projectFactsVersion ?? input.projectRevision, input.assignmentVersionId, input.trackSelectionRevision, [...(input.memberIntentionRefs ?? [])].sort((a, b) => a.membershipId.localeCompare(b.membershipId)), input.resourceContentVersions]);
  }
  for (const task of current.tasks) {
    if (task.status === "review") add("deliverable_review", [task.id, task.revision], task.id, task.title);
    if (task.status === "blocked") add("task_blocked", [task.id, task.revision], task.id, task.title);
    const request = progress.slice().reverse().find(update => update.taskId === task.id && update.correctionRequest && equal(update.correctionRequest.acceptance, task.acceptance));
    if (task.status === "done" && task.acceptance && request) add("acceptance_correction_requested", [task.id, request.id], task.id, task.title);
  }
  const deadlineIssues = (current.evaluation?.issues ?? []).filter(issue => /DEADLINE|CAPACITY|BUFFER|SCHEDULE|WINDOW|TIME_EXCEEDS/.test(issue.code) && issue.code !== "DONE_AFTER_DEADLINE");
  if (deadlineIssues.length) {
    const taskIds = [...new Set(deadlineIssues.flatMap(issue => issue.taskIds))].sort();
    add("deadline_risk", [current.plan.id, deadlineIssues.map(issue => [issue.code, [...issue.taskIds].sort(), issue.deadlineId ?? null, issue.membershipId ?? null]).sort(), taskIds.map(id => { const task = current.tasks.find(item => item.id === id); return [id, task?.revision, task?.deadlineRef]; }), input.deadlines.map(deadline => [deadline.id, deadline.instantUtc, deadline.verified]).sort(), input.availabilityVersions]);
  }
  return { facts };
}
