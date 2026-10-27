import type { PlanningTask } from "./types.ts";

export type TaskBoardGroup = "ready" | "waiting" | "doing" | "review" | "done";
export interface TaskBoardItem {
  task: PlanningTask;
  group: TaskBoardGroup;
  waitingFor: { id: string; title: string; ownerMembershipId: string | null; missing: boolean }[];
  needs: string[];
}
/** A completion report never satisfies another task's prerequisite. */
export function unmetDependencies(task: Pick<PlanningTask, "dependencyTaskIds">, tasks: readonly PlanningTask[]): TaskBoardItem["waitingFor"] {
  const directory = new Map(tasks.map(value => [value.id, value]));
  return task.dependencyTaskIds.flatMap(id => {
    const predecessor = directory.get(id);
    if (predecessor?.status === "done" && predecessor.acceptance !== null) return [];
    return [{ id, title: predecessor?.title ?? "未找到的前置任务", ownerMembershipId: predecessor?.ownerMembershipId ?? null, missing: !predecessor }];
  });
}
/** Stable transitive impact, also used by the server for explicit correction acknowledgement. */
export function dependentTaskIds(taskId: string, tasks: readonly PlanningTask[]): string[] {
  const found = new Set<string>();
  const queue = [taskId];
  while (queue.length) {
    const predecessor = queue.shift()!;
    for (const task of tasks) if (task.id !== taskId && task.status !== "cancelled" && task.dependencyTaskIds.includes(predecessor) && !found.has(task.id)) { found.add(task.id); queue.push(task.id); }
  }
  return [...found].sort();
}
export function buildTaskBoard(tasks: readonly PlanningTask[], options: { planReady: boolean; activeMembershipIds: readonly string[]; taskNeeds?: Record<string, string[]> }): TaskBoardItem[] {
  return tasks.filter(task => task.status !== "cancelled").map(task => {
    const waitingFor = unmetDependencies(task, tasks);
    const needs: string[] = [...(options.taskNeeds?.[task.id] ?? [])];
    if (!options.planReady) needs.push("计划依据需要核对，请管理员检查比赛要求、成员时间和容量。");
    if (!task.ownerMembershipId || !options.activeMembershipIds.includes(task.ownerMembershipId)) needs.push("负责人还未确认或已离开项目。");
    if (task.status === "blocked") needs.push(task.blocker || "负责人还未填写遇到的问题。");
    if (task.status === "done" && !task.acceptance) needs.push("已完成状态缺少检查记录，请管理员核对。");
    const group: TaskBoardGroup = task.status === "done" && task.acceptance ? "done" : task.status === "review" ? "review" : task.status === "in_progress" ? "doing" : task.status === "todo" && !waitingFor.length && !needs.length ? "ready" : "waiting";
    return { task, group, waitingFor, needs };
  });
}
