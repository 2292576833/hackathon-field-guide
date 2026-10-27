import type { CurrentPlanningView, PlanningTask } from "../planning/types.ts";
import type { MemberAvailability, MyIntentionView, ProjectOfficialTracksView } from "../projects/index.ts";
import type { LifecycleInput, ReadState, SpaceDetail, SpaceRules } from "./model.ts";
import { buildSpaceGuideTree } from "./guide-tree.ts";
import { buildMissionWorkbench, missionTaskChecked } from "./mission-workbench.ts";

/**
 * 空间待办清单（规划27 第1期）。
 *
 * 设计约束（宪法 v1.16.0 原则 X）：
 *  - 待办是**纯派生视图**：完成与否由既有事实判定，不落库、不新增完成状态；
 *  - 每一条 MUST 有本人可独立完成的明确结束条件；
 *  - MUST NOT 出现"尚未读取/未知/需要复核"等内部状态——系统未知的信息不进待办，
 *    而是通过 `unread` 提示说明读取状态并提供重新读取入口；
 *  - 只有真实阻塞（有人等本人确认、本人负责的期限临近、队友求助）标记为 urgent（红色）。
 *
 * 唯一落库的部分是本人**手动添加**的私人待办，见 `manual` 分组；它不参与任何派生事实。
 *
 * 规划31 第1.1项（孤儿任务）：生效计划之后**既不能认领也不能转交**（计划服务只在草案阶段允许改负责人），
 * 而原来的待办只列"负责人是自己"的任务——于是没有人负责的任务**谁都不会看到**，
 * 风险不是"两人重复做"而是"这件事没人做"。现在把它列进「没人接的任务」分组，
 * 让能处理的人（管理员）看得见并去改派；**不新增完成状态，也不绕过生效计划直接认领**。
 */
export type SpaceTodoKind = "fill" | "confirm" | "do" | "assign" | "manual";
export type SpaceTodoUrgency = "urgent" | "normal";

export interface SpaceTodo {
  readonly id: string;
  readonly kind: SpaceTodoKind;
  /** 需要我做什么（一句话，人话）。 */
  readonly title: string;
  /** 结束条件：本人可独立完成。 */
  readonly doneWhen: string;
  readonly href: string;
  /** 就地展开的目标节点；manual 为 null。 */
  readonly nodeId: string | null;
  readonly urgency: SpaceTodoUrgency;
  /** manual 专用：可编辑与标记完成。 */
  readonly manualId: string | null;
  /** assign 专用：任务标题，用于「没人接的任务」展示。 */
  readonly taskTitle?: string;
}

export interface SpaceManualTodo {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly status: "open" | "done";
  readonly completedAt: string | null;
  readonly revision: number;
}

export interface SpaceTodoInput {
  readonly detail: SpaceDetail;
  readonly current: CurrentPlanningView | null;
  readonly planningLoading?: boolean;
  readonly planningError?: unknown;
  readonly rules?: ReadState<SpaceRules>;
  readonly tracks?: ReadState<ProjectOfficialTracksView>;
  readonly intention?: ReadState<MyIntentionView>;
  readonly availability?: ReadState<{ availability: MemberAvailability | null; confirmationRequired: boolean }>;
  readonly manual?: readonly SpaceManualTodo[];
}

export interface SpaceTodoView {
  readonly todos: readonly SpaceTodo[];
  readonly counts: Readonly<Record<SpaceTodoKind, number>>;
  /** 真阻塞数量；只有它 > 0 才用红色提示。 */
  readonly urgentCount: number;
  /** 系统读取状态说明；不进入 todos。 */
  readonly unread: readonly string[];
  readonly readonly: boolean;
}

const KIND_ORDER: Record<SpaceTodoKind, number> = { confirm: 0, assign: 1, do: 2, fill: 3, manual: 4 };

/** 从指引树取某个节点的事实状态；拿不到就不猜。 */
function factOf(input: LifecycleInput, nodeId: string) {
  const tree = buildSpaceGuideTree(input);
  for (const step of tree.steps) for (const node of step.nodes) if (node.id === nodeId) return node;
  return null;
}
function taskHref(projectId: string, taskId: string) { return `/app/projects/${encodeURIComponent(projectId)}/plan#task-${encodeURIComponent(taskId)}`; }
function waitingOn(task: PlanningTask, tasks: readonly PlanningTask[]): boolean {
  return task.dependencyTaskIds.some(id => { const prior = tasks.find(item => item.id === id); return !prior || !missionTaskChecked(prior); });
}

export function buildSpaceTodos(input: SpaceTodoInput): SpaceTodoView {
  const { detail, current } = input;
  const project = detail.project, membership = detail.membership;
  const base = `/app/projects/${encodeURIComponent(project.id)}`;
  const readonly = project.stage === "archived";
  const manager = membership.role === "manager";
  const todos: SpaceTodo[] = [];
  const unread: string[] = [];
  const active = membership.projectId === project.id && membership.status === "active" && detail.members.some(member => member.membershipId === membership.membershipId && member.projectId === project.id && member.status === "active");
  if (!active) return { todos: [], counts: { fill: 0, confirm: 0, do: 0, assign: 0, manual: 0 }, urgentCount: 0, unread: ["当前空间身份已变化，请重新打开我的参赛。"], readonly: true };

  // 1) 要我读：资料已读确认尚未实现（没有可见的"完成完成"动作），
  //    因此按约束**不进入待办**，避免出现没有结束条件的条目。
  //    待第 3 期实现"资料可标记已读"后再启用该分类。

  // 2) 要我填：直接复用指引树的事实判定，保证"线"与"待办"永远一致。
  const treeInput: LifecycleInput = { detail, current, planningLoading: input.planningLoading, planningError: input.planningError, rules: input.rules, tracks: input.tracks };
  const FILL_NODES: readonly { nodeId: string; title: string; doneWhen: string; href: string }[] = [
    { nodeId: "goal", title: manager ? "写清楚这次要做出什么" : "与管理员核对作品目标", doneWhen: "作品目标与最小成果已保存，团队能说清同一条核心体验。", href: `${base}#project-goal` },
    { nodeId: "official-track", title: "按主办方规定选择官方赛道", doneWhen: "已保存赛道选择，或确认主办方未细分赛道。", href: `${base}/rules` },
    { nodeId: "requirements", title: "确认比赛要求与每个截止", doneWhen: "比赛要求已核对到有记录，截止已明确。", href: `${base}/rules` },
    { nodeId: "duties-time", title: "选择我愿意负责的工作并确认时间", doneWhen: "本人职责已保存，可投入时间已确认。", href: `${base}/team` },
    { nodeId: "applied-plan", title: manager ? "核对并确认任务计划" : "查看安排，与管理员核对分工", doneWhen: "计划已确认生效；草案或 AI 建议不算生效。", href: `${base}/plan` },
  ];
  for (const entry of FILL_NODES) {
    if (readonly) continue;
    if (entry.nodeId === "duties-time" && (input.intention || input.availability)) {
      const intention = input.intention?.status === "ready" ? input.intention.value : null;
      const available = input.availability?.status === "ready" ? input.availability.value : null;
      const ownIntention = intention?.projectId === project.id && intention.membershipRevision === membership.revision && !intention.needsConfirmation && intention.intention?.projectId === project.id && intention.intention.userId === membership.userId && intention.intention.membershipRevision === membership.revision && intention.intention.duties.length > 0;
      const ownTime = available && !available.confirmationRequired && available.availability?.projectId === project.id && available.availability.userId === membership.userId && available.availability.membershipRevision === membership.revision && Number.isFinite(Date.parse(available.availability.confirmedAt));
      for (const field of [{ read: input.intention, ready: ownIntention, key: "duties", title: "选择我愿意负责的工作", condition: "本人职责已保存，是否分享由本人决定。" }, { read: input.availability, ready: ownTime, key: "time", title: "确认我能投入的时间", condition: "本人真实工作时间窗口已保存并确认。" }]) {
        if (field.read?.status !== "ready") { unread.push(`${field.title}：请先读取本人已保存的信息。`); continue; }
        if (!field.ready) todos.push({ id: `fill:${field.key}`, kind: "fill", title: field.title, doneWhen: field.condition, href: field.key === "duties" ? `${base}/assessment` : entry.href, nodeId: "duties-time", urgency: "normal", manualId: null });
      }
      continue;
    }
    const node = factOf(treeInput, entry.nodeId);
    if (!node) continue;
    if (node.fact.status === "recorded") continue;
    if (["unknown", "loading", "error"].includes(node.fact.status)) { unread.push(`${node.title}：${node.fact.explanation}`); continue; }
    if (node.fact.status === "review") { unread.push(`${node.title}：${node.fact.explanation}`); continue; }
    todos.push({ id: `fill:${entry.nodeId}`, kind: "fill", title: entry.title, doneWhen: entry.doneWhen, href: entry.href, nodeId: entry.nodeId, urgency: "normal", manualId: null });
  }

  // 3) 要我确认 + 要我做：都来自真实计划与任务状态；计划未读取时不猜。
  const workbench = buildMissionWorkbench({ detail, current, planningLoading: input.planningLoading, planningError: input.planningError,
    preparation: { rules: input.rules, tracks: input.tracks, intention: input.intention, availability: input.availability } });
  const tasks = current?.plan?.status === "applied" && current.plan.projectId === project.id && current.plan.inputSnapshot.projectId === project.id && !current.inputVersionsChanged ? current.tasks.filter(task => task.projectId === project.id) : [];
  if (current === null || input.planningError || input.planningLoading) unread.push("任务计划还未读取完成，暂时无法列出与你有关的任务。");
  else if (current.inputVersionsChanged) unread.push("空间资料或比赛要求有变化，计划需要重新核对后才能判断任务是否可以开始。");
  else if (current.plan && !readonly && workbench.state === "current") {
    const actions = new Map(workbench.actions.map(action => [action.id, action]));
    for (const task of tasks) {
      if (task.status === "cancelled" || missionTaskChecked(task)) continue;
      const canCheck = manager || task.reviewerMembershipId === membership.membershipId || task.ownerMembershipId === membership.membershipId && task.reviewerMembershipId === null;
      // 要我确认：队友交出的成果等我检查。有人等 → 真阻塞，红色。
      if (task.status === "review" && canCheck) {
        todos.push({ id: `confirm:${task.id}`, kind: "confirm", title: `检查成果：${task.title}`, doneWhen: "按任务检查条件记录检查依据并通过。", href: taskHref(project.id, task.id), nodeId: "check-unlock", urgency: "urgent", manualId: null });
        continue;
      }
      // 要我做：只列**真正已经在进行或阻塞**的本人任务，避免把未排期的草案当成待办。
      const mine = task.ownerMembershipId === membership.membershipId;
      if (!mine) continue;
      if ((task.status === "todo" || task.status === "in_progress") && actions.has(task.id)) todos.push({ id: `do:${task.id}`, kind: "do", title: actions.get(task.id)!.title, doneWhen: "交出成果并留下检查记录。", href: taskHref(project.id, task.id), nodeId: task.status === "todo" ? "start-task" : "handoff", urgency: "normal", manualId: null });
      else if (task.status === "blocked") todos.push({ id: `do:${task.id}`, kind: "do", title: `卡住了：${task.title}`, doneWhen: "写清缺什么、需要谁提供什么；解除后继续或改由他人接手。", href: taskHref(project.id, task.id), nodeId: "handoff", urgency: "urgent", manualId: null });
      else if (task.status === "todo" && !waitingOn(task, tasks)) unread.push(`任务「${task.title}」已分配给你但还没有安排可执行时间，请到任务进度核对。`);
    }
  } else if (current.plan && !readonly) unread.push(workbench.notice);

  // 3b) 没人接的任务（规划31 第1.1项）：生效计划里没有负责人，且还没结算。
  //     原来这类任务被 `if (!mine) continue;` 直接跳过，谁都不会看到——于是没人做。
  //     它**不代表本人要做**（生效计划不能凭待办认领），所以只对能改派的人（管理员）列为待办，
  //     其他人仅在 unread 里看到说明，避免误导成员去接手一个他无法接的任务。
  if (current?.plan?.status === "applied" && !readonly && workbench.state === "current") {
    const orphans = tasks.filter(task => !task.ownerMembershipId && task.status !== "cancelled" && !missionTaskChecked(task));
    if (orphans.length) {
      if (manager) {
        for (const task of orphans) {
          todos.push({ id: `assign:${task.id}`, kind: "assign",
            title: `没人接的任务：${task.title}`,
            doneWhen: "到任务进度核对容量与依赖，把负责人定下来并重新确认计划。生效计划不能凭待办直接认领，改派要走计划草案。",
            href: taskHref(project.id, task.id), nodeId: "assignment", urgency: "normal", manualId: null, taskTitle: task.title });
        }
      } else {
        unread.push(`有 ${orphans.length} 项任务还没有负责人。生效计划不能凭待办直接认领，请联系空间管理员改派。`);
      }
    }
  }

  // 4) 本人手动添加的私人待办（唯一落库部分，只有本人可见）。
  for (const item of input.manual ?? []) {
    if (item.status !== "open") continue;
    todos.push({ id: `manual:${item.id}`, kind: "manual", title: item.title, doneWhen: "本人标记完成。这是私人备忘，不代表任何交付或验收结论。", href: `${base}#space-todos`, nodeId: null, urgency: "normal", manualId: item.id });
  }

  // Keep preparation in the real workflow order rather than sorting Chinese
  // titles: a newcomer must see the missing goal before confirming a plan.
  const fillOrder = ["fill:goal", "fill:requirements", "fill:official-track", "fill:duties", "fill:time", "fill:duties-time", "fill:applied-plan"];
  todos.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || (left.kind === "fill" && right.kind === "fill" ? fillOrder.indexOf(left.id) - fillOrder.indexOf(right.id) : left.title.localeCompare(right.title)));
  const counts = { fill: 0, confirm: 0, do: 0, assign: 0, manual: 0 } as Record<SpaceTodoKind, number>;
  for (const todo of todos) counts[todo.kind] += 1;
  return { todos, counts, urgentCount: todos.filter(todo => todo.urgency === "urgent").length, unread, readonly };
}
