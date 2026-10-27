import type { BufferPolicy, PlanChange, PlanningInput, PlanningTask, ValidationResult } from "./types.ts";

const taskFields = ["title", "priority", "kind", "ownerMembershipId", "helperEfforts", "deliverable", "acceptanceCriteria", "reviewerMembershipId", "durationEstimate", "dependencyTaskIds", "deadlineRef", "requirementRefs", "resourceRefs", "resourceContentRefs", "skillRefs", "splittable", "contextSwitchMinutes", "waitMinutes", "status", "cancellationReason"] as const;
const majorFields: readonly string[] = ["priority", "ownerMembershipId", "helperEfforts", "deliverable", "acceptanceCriteria", "deadlineRef", "requirementRefs", "dependencyTaskIds", "status", "resourceContentRefs", "skillRefs"];
function skillReferences(value: PlanningTask["skillRefs"]): string {
  return JSON.stringify([...(value ?? [])].sort((a, b) => `${a.reference.kind}:${a.reference.id}`.localeCompare(`${b.reference.kind}:${b.reference.id}`)), (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function diffPlans(before: readonly PlanningTask[], after: readonly PlanningTask[], oldBuffers: readonly BufferPolicy[], newBuffers: readonly BufferPolicy[]): PlanChange[] {
  const changes: PlanChange[] = [];
  const oldTasks = new Map(before.map(task => [task.id, task]));
  const newTasks = new Map(after.map(task => [task.id, task]));
  for (const task of before) {
    if (!newTasks.has(task.id)) changes.push({ taskId: task.id, action: "removed", fields: [], before: task, after: null, major: true, impact: task.priority === "must" ? "影响最小作品或必交材料，必须处理。" : "删减可选范围；历史进度仍保留。" });
  }
  for (const task of after) {
    const old = oldTasks.get(task.id);
    if (!old) {
      changes.push({ taskId: task.id, action: "added", fields: [], before: null, after: task, major: task.priority === "must", impact: "新增工作将占用负责人和协助者容量。" });
      continue;
    }
    const fields = taskFields.filter(field => field === "skillRefs" ? skillReferences(old.skillRefs) !== skillReferences(task.skillRefs) : JSON.stringify(old[field]) !== JSON.stringify(task[field]));
    if (fields.length) changes.push({ taskId: task.id, action: "changed", fields, before: Object.fromEntries(fields.map(field => [field, old[field]])), after: Object.fromEntries(fields.map(field => [field, task[field]])), major: fields.some(field => majorFields.includes(field)), impact: task.status === "cancelled" ? "拟删减该任务；须保留必交项和后继依赖。" : fields.includes("resourceRefs") || fields.includes("resourceContentRefs") ? "资源选择或固定内容版本改变；请确认学习、接入成本和验收条件。" : "负责人、范围或安排的变更需要重新检查容量与依赖。" });
  }
  if (JSON.stringify(oldBuffers) !== JSON.stringify(newBuffers)) changes.push({ taskId: null, action: "buffer_changed", fields: ["buffers"], before: oldBuffers, after: newBuffers, major: true, impact: "提交前可用工作时间改变，缓冲不计作开发容量。" });
  return changes;
}

export function diffPlanInputs(before: PlanningInput | undefined, after: PlanningInput, tasks: readonly PlanningTask[]): PlanChange[] {
  if (!before) return [];
  const fields = ["deadlines", "requirements", "members", "availability", "projectRevision", "projectFactsVersion", "requirementVersionId", "assignmentVersionId", "trackSelectionRevision", "memberIntentionRefs", "availabilityVersions", "resourceContentVersions", "projectArchived", "projectReadOnly", "assumptions", "requiredTaskKinds"] as const;
  return fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map(field => ({ taskId: null, action: "input_changed", fields: [field], before: before[field], after: after[field], major: true,
    impact: field === "deadlines" ? `来源截止点、时区或确认状态改变；影响${tasks.filter(task => task.status !== "cancelled").length}项在计划内的任务，需要重新核对交付安排。` : field === "requirements" ? "赛事必交要求改变，需核对材料任务及最小范围。" : field === "availability" || field === "availabilityVersions" || field === "members" ? "人员或可工作时间改变，容量与安排已重新计算。" : "输入依据或版本改变，需结合任务与风险检查新的安排。" }));
}

export function diffSchedules(before: ValidationResult | null | undefined, after: ValidationResult): PlanChange[] {
  if (!before) return [];
  const previous = new Map(before.likely.scheduled.map(task => [task.taskId, task]));
  const changes: PlanChange[] = [];
  for (const task of after.likely.scheduled) {
    const old = previous.get(task.taskId);
    if (old && JSON.stringify(old) !== JSON.stringify(task)) changes.push({ taskId: task.taskId, action: "changed", fields: ["schedule"], before: old, after: task, major: true, impact: "按当前时间、窗口和依赖计算的工作段或完成时间改变。" });
  }
  if (before.feasibility !== after.feasibility || JSON.stringify(before.issues) !== JSON.stringify(after.issues)) changes.push({ taskId: null, action: "changed", fields: ["feasibility", "issues"], before: { feasibility: before.feasibility, issues: before.issues }, after: { feasibility: after.feasibility, issues: after.issues }, major: true, impact: "可行性或未解决约束改变，应用前须逐项检查。" });
  return changes;
}
