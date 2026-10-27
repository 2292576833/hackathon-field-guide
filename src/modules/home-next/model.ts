/**
 * home-next · 首页"下一步"的类型契约（规划27 第 2 期 2.1）。
 *
 * 本模块只做**纯逻辑**：由登录态与本人只读事实推出"我现在该干吗"。
 * 它不读库、不发请求、不写任何状态，也不新增完成状态或百分比
 * （宪法 v1.16.0 原则 X 第 8/9 条：主页只作路标，下一步必须指向具体动作）。
 */

/** 首页主路可能给出的下一步。每一项都必须能在站内点开继续。 */
export type NextStepKind =
  | "sign_in"
  | "find_event"
  | "create_space"
  | "set_goal"
  | "do_tasks"
  | "wrap_up"
  | "read_results"
  | "unread";

export interface NextStep {
  readonly kind: NextStepKind;
  /** 一句话告诉用户"现在做什么"。 */
  readonly title: string;
  /** 为什么是这一步；只用已读取的事实，不含完成度百分比。 */
  readonly why: string;
  /** 站内真实路径。 */
  readonly href: string;
}

/**
 * 本人某个参赛空间的最小事实。
 *
 * `pendingTasks` / `blockedTasks` / `reviewingTasks` 为 `undefined` 表示
 * **尚未读取**，与"读到了 0"严格不同：未读取时不得当 0 用，也不得据此推荐。
 */
export interface HomeProjectFacts {
  readonly id: string;
  readonly name: string;
  /** 项目阶段；取值与 M02 `ProjectStage` 一致，未知字符串按普通进行中处理。 */
  readonly stage: string;
  readonly goal: string;
  readonly minimumDeliverable: string;
  readonly pendingTasks?: number;
  readonly blockedTasks?: number;
  readonly reviewingTasks?: number;
}

export interface HomeNextInput {
  readonly signedIn: boolean;
  /** 本人是否已经走过一次参赛指引（用于区分首次到访与继续参赛）。 */
  readonly hasStartedJourney: boolean;
  /** 已选定的赛事；`null` 表示还没选。 */
  readonly selectedEventId: string | null;
  /** 本人当前可见的参赛空间；尚未读取时传空数组（不要传 `undefined`）。 */
  readonly projects: readonly HomeProjectFacts[];
}

const KINDS: readonly NextStepKind[] = [
  "sign_in", "find_event", "create_space", "set_goal", "do_tasks", "wrap_up", "read_results", "unread",
];

/** 运行时白名单；供接入方在渲染前防守（不是第二套事实）。 */
export function isNextStepKind(value: unknown): value is NextStepKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}
