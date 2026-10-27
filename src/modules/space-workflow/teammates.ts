import type { CurrentPlanningView } from "../planning/types.ts";
import type { ReadState, SpaceDetail } from "./model.ts";
import type { SharedIntentionsView } from "../projects/index.ts";
import { missionTaskChecked } from "./mission-workbench.ts";

/**
 * 队友状态（规划27 第1期）：从真实任务与交接记录派生，谁在做什么、在等谁、谁卡住了。
 *
 * 约束：只读派生，不改任何事实；不显示完成百分比或"排名"；
 * 阻塞原因取队友自己写下的说明，系统不替队友编造状态。
 */
export interface TeammateStatus {
  readonly membershipId: string;
  readonly userId: string;
  readonly status: "unknown" | "blocked" | "help" | "review" | "doing" | "helping" | "assigned" | "checked" | "unassigned";
  readonly label: string;
  readonly assigned: readonly { readonly id: string; readonly title: string }[];
  readonly doing: readonly { readonly id: string; readonly title: string }[];
  /**
   * 队友**作为协助者**参与的任务（本人不是负责人）。
   *
   * 之前只看 `ownerMembershipId`，协助者在"谁在做什么"里完全隐身，可能出现两人同时帮同一件事而互不知情。
   * 这里按 `helperEfforts` 派生；负责人同时列为协助者时不重复计算（避免同一件事在卡上出现两次）。
   */
  readonly helping: readonly { readonly id: string; readonly title: string }[];
  /** 队友交出、等别人按条件检查的成果。 */
  readonly handingOff: readonly { readonly id: string; readonly title: string }[];
  /** 队友自己标记的阻塞，带本人写的说明。 */
  readonly blocked: readonly { readonly id: string; readonly title: string; readonly reason: string }[];
  readonly checkedCount: number;
  /** 队友声明愿意负责的工作（本人主动共享后才有）。 */
  readonly duties: readonly string[];
  /** 队友请求协助的问题（本人主动共享后才有）。 */
  readonly helpQuestion: string;
}

export interface TeammatesView {
  readonly teammates: readonly TeammateStatus[];
  readonly planningUnread: boolean;
  readonly notice: string;
}

export function buildTeammateStatuses(input: {
  detail: SpaceDetail;
  current: CurrentPlanningView | null;
  planningLoading?: boolean;
  planningError?: unknown;
  intentions?: ReadState<SharedIntentionsView>;
}): TeammatesView {
  const { detail, current } = input;
  const project = detail.project;
  const matchingPlan = Boolean(current?.plan && current.plan.projectId === project.id && current.plan.inputSnapshot.projectId === project.id);
  const planningUnread = current === null || Boolean(input.planningLoading) || Boolean(input.planningError) || Boolean(current?.inputVersionsChanged)
    || Boolean(current?.plan && (!matchingPlan || current.plan.status !== "applied"));
  const taskSafe = matchingPlan && current?.plan?.status === "applied" && !planningUnread;
  const tasks = taskSafe ? current!.tasks.filter(task => task.projectId === project.id && task.status !== "cancelled") : [];
  const shared = input.intentions?.status === "ready" && input.intentions.value.projectId === project.id ? input.intentions.value.intentions ?? [] : [];
  const active = detail.members.filter(member => member.projectId === project.id && member.status === "active");

  const teammates = active.map(member => {
    const own = tasks.filter(task => task.ownerMembershipId === member.membershipId);
    const sharedIntention = shared.find(item => item.userId === member.userId && item.membershipRevision === member.revision);
    const assigned = own.filter(task => task.status === "todo").map(task => ({ id: task.id, title: task.title }));
    const doing = own.filter(task => task.status === "in_progress").map(task => ({ id: task.id, title: task.title }));
    const handingOff = own.filter(task => task.status === "review" || task.status === "done" && !missionTaskChecked(task)).map(task => ({ id: task.id, title: task.title }));
    const blocked = own.filter(task => task.status === "blocked").map(task => ({ id: task.id, title: task.title, reason: task.blocker?.trim() || "还没有写明遇到什么问题。" }));
    const checkedCount = own.filter(missionTaskChecked).length;
    // 协助：只算"本人不是负责人"的那些，避免与 assigned/doing 重复计同一件事。
    const helping = tasks
      .filter(task => task.ownerMembershipId !== member.membershipId
        && (task.helperEfforts ?? []).some(effort => effort.membershipId === member.membershipId))
      .map(task => ({ id: task.id, title: task.title }));
    const helpQuestion = sharedIntention?.helpQuestion?.trim() ?? "";
    // 纯协助者（没有自己负责的任务）此前会落到"暂无安排"，与实际投入不符；这里给"协助中"。
    const status: TeammateStatus["status"] = planningUnread ? "unknown" : blocked.length ? "blocked" : helpQuestion ? "help"
      : handingOff.length ? "review" : doing.length ? "doing" : helping.length ? "helping"
      : assigned.length ? "assigned" : checkedCount ? "checked" : "unassigned";
    const labels: Record<TeammateStatus["status"], string> = { unknown: "状态待核对", blocked: "遇到问题", help: "正在求助", review: "成果待检查", doing: "正在做", helping: "正在协助", assigned: "待开始", checked: "已有检查记录", unassigned: "暂无安排" };
    return {
      membershipId: member.membershipId,
      userId: member.userId,
      status, label: labels[status], assigned, doing, helping, handingOff, blocked, checkedCount,
      duties: sharedIntention?.duties ?? [],
      helpQuestion,
    };
  });

  const notice = input.planningError ? "任务读取失败，队友状态暂时无法判断。"
    : current === null || input.planningLoading ? "任务还没读取完成，暂时看不到谁在做什么。"
    : current.inputVersionsChanged ? "空间资料有变化，队友的任务状态需要重新核对后才能判断。"
    : current.plan && !matchingPlan ? "计划与当前空间未对齐，任务状态待核对。"
    : current.plan && current.plan.status !== "applied" ? "计划尚未生效，任务状态待核对。"
    : !current.plan ? "还没有生效计划，队友暂时没有已安排的任务。"
    : "依据当前生效任务与交接记录。阻塞说明由队友本人写下，系统不替他判断。";
  return { teammates, planningUnread, notice };
}
