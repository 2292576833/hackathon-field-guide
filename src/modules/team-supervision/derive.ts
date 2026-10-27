import type { SupervisionFacts, SupervisionHint } from "./model.ts";

/** Rules from current records; never presented as model output or task completion. */
export function deriveSupervisionHints(facts: SupervisionFacts, now: Date): SupervisionHint[] {
  const tasks = new Map(facts.tasks.map(task => [task.id, task])), hints: SupervisionHint[] = [];
  for (const task of facts.tasks) {
    if (task.status === "cancelled" || task.status === "done" && task.accepted) continue;
    const add = (kind: SupervisionHint["kind"], detail: string) => hints.push({ id: `${kind}:${task.id}`, kind, taskId: task.id, title: task.title, detail });
    if (task.status === "blocked") add("blocked", task.blocker?.trim() || "已记录阻塞，原因待补充。");
    if (task.status === "review" || task.status === "done" && !task.accepted) add("review", task.reviewerMembershipId === facts.membershipId ? "成果等你检查；提交交接不等于通过。" : "成果等待有效检查。");
    if (facts.plan.status === "active" && facts.responsibility.confirmed && task.status === "todo" && task.ownerMembershipId === facts.membershipId && task.dependencyTaskIds.length && task.dependencyTaskIds.every(id => { const parent = tasks.get(id); return parent?.status === "done" && parent.accepted; }))
      add("ready", "记录中的前置成果已检查，可核对后开始。");
    const deadline = task.deadlineAt ? Date.parse(task.deadlineAt) : NaN;
    const scheduled = task.scheduledFinishAt ? Date.parse(task.scheduledFinishAt) : NaN;
    if (Number.isFinite(deadline) && deadline <= now.getTime()) add("time_risk", "已到记录的截止时间，当前还没有有效检查。");
    else if (Number.isFinite(deadline) && Number.isFinite(scheduled) && scheduled > deadline) add("time_risk", "计划安排超过记录截止，需要核对范围和时间。");
    else if (Number.isFinite(scheduled) && scheduled <= now.getTime()) add("time_risk", "已过计划安排时间，记录待核对；不能据此推断没有工作。");
  }
  return hints;
}
