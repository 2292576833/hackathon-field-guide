import { buildTaskBoard, unmetDependencies, type TaskBoardItem } from "./task-board.ts";
import type { CurrentPlanningView, PlanningTask, TaskKind, TaskStatus } from "./types.ts";

export interface TaskGuidance {
  planReady: boolean;
  items: TaskBoardItem[];
  readyTasks: PlanningTask[];
}

/** Read-only guidance from the saved plan; no suggestion creates a task or changes its status. */
export function buildTaskGuidance(current: CurrentPlanningView | null, options: { activeMembershipIds: readonly string[]; membershipId: string }): TaskGuidance {
  const planReady = Boolean(current?.plan && current.evaluation?.structuralValid && !current.inputVersionsChanged);
  const tasks = current?.tasks ?? [];
  const scheduledIds = new Set(current?.evaluation?.likely.scheduled.map(value => value.taskId) ?? []);
  const taskNeeds = Object.fromEntries(tasks.map(task => [task.id, task.status === "todo" && !scheduledIds.has(task.id)
    ? [current?.evaluation?.likely.issues.find(issue => issue.taskIds.includes(task.id))?.message ?? "当前还不能安排这项任务的工作时间，请核对成员时间、工时与截止。"]
    : []]));
  const items = buildTaskBoard(tasks, { planReady, activeMembershipIds: options.activeMembershipIds, taskNeeds });
  const readyTasks = items.filter(item => planReady && item.group === "ready" && item.task.ownerMembershipId === options.membershipId && scheduledIds.has(item.task.id)).map(item => item.task);
  return { planReady, items, readyTasks };
}

export interface DependencyGuidance {
  id: string;
  title: string;
  ownerMembershipId: string | null;
  missing: boolean;
  status: TaskStatus | null;
  statusLabel: string;
  checkLabel: string;
}

const dependencyStatusLabels: Record<TaskStatus, string> = {
  todo: "未开始",
  in_progress: "正在做",
  blocked: "遇到阻塞",
  review: "待检查",
  done: "已报完成",
  cancelled: "已删减",
};

/** Only a currently completed task with an actual acceptance satisfies its handoff. */
export function dependencyGuidance(task: PlanningTask, tasks: readonly PlanningTask[]): DependencyGuidance[] {
  const directory = new Map(tasks.map(value => [value.id, value]));
  return unmetDependencies(task, tasks).map(dependency => {
    const predecessor = directory.get(dependency.id);
    if (!predecessor) return { ...dependency, status: null, statusLabel: "前置任务缺失", checkLabel: "检查状态未知，请管理员核对依赖。" };
    const checkLabel = predecessor.acceptance
      ? "保留检查记录，但当前状态不满足前置条件，请核对。"
      : predecessor.status === "done"
        ? "缺少检查记录，不能解除等待。"
        : predecessor.status === "review"
          ? "成果待检查，尚未通过。"
          : predecessor.status === "cancelled"
            ? "已删减，不能作为已检查的前置成果。"
            : "尚无检查通过记录。";
    return { ...dependency, status: predecessor.status, statusLabel: dependencyStatusLabels[predecessor.status], checkLabel };
  });
}

export interface TaskResourceGuidance {
  title: string;
  href: string;
  purpose: string;
}

/** Fixed, existing entry points explain their use without reading or sharing private material. */
export function taskResourceGuidance(kind: TaskKind, projectId: string): TaskResourceGuidance[] {
  const space = `/app/projects/${encodeURIComponent(projectId)}`;
  const projectQuery = `projectId=${encodeURIComponent(projectId)}`;
  const delivery = { title: "GitHub 保存与运行", href: `${space}/delivery`, purpose: "把代码成果保存到仓库，再核对当前版本能否运行；保存、运行检查与正式提交分别记录。" };
  const resources = { title: "工具与资料", href: "/resources", purpose: "按当前任务找已审核的工具和参考资料，先核对用途、使用条件与许可。" };
  switch (kind) {
    case "implementation":
    case "debugging":
    case "integration":
    case "testing":
      return [delivery, resources];
    case "material":
      return [
        { title: "整理展示 PPT", href: `/ppt?${projectQuery}`, purpose: "整理演示结构与必交材料；PPT 记录仍属本人，采用空间资料需主动确认，分享也需本人选择。" },
        { title: "准备路演讲稿", href: `/roadshow?${projectQuery}`, purpose: "准备讲稿、练习表达与演示顺序；讲稿记录仍属本人，采用空间资料需主动确认，分享也需本人选择。" },
        { title: "找设计与展示灵感", href: "/inspiration", purpose: "参考官网中的视觉、组件和动效思路；先看分析状态与来源，浏览不代表获得素材使用许可。" },
      ];
    case "learning":
      return [resources, { title: "AI 技能与用法", href: "/skills", purpose: "按正在使用的 AI 工具查具体任务用法、前置条件和兼容证据；复制命令、安装与实际试做分别确认。" }];
    case "submission":
      return [{ title: "核对作品并记录提交", href: `${space}/delivery`, purpose: "核对当前版本保存、运行与必交材料，再按官方要求提交并记录回执；保存或运行通过不代表已正式提交。" }];
    case "handoff":
      return [
        { title: "本空间共享资料", href: `${space}/resources`, purpose: "查看队友主动共享的成果说明与资料，把可接手内容和使用条件交代清楚。" },
        { title: "本空间保存与运行记录", href: `${space}/delivery`, purpose: "核对队友交接的仓库版本与运行记录；接手任务仍以当前前置成果的检查记录为准。" },
      ];
  }
}
