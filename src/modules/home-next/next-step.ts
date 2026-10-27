import type { HomeNextInput, HomeProjectFacts, NextStep } from "./model.ts";

/**
 * 首页"下一步"（规划27 第 2 期 2.1）· 纯函数。
 *
 * 规则来源：规划27 第 7 节（主页主路径）
 *   未登录／首次到访 → 讲整条路（找比赛）
 *   已登录、无空间    → 去看比赛 / 建一个空间
 *   有空间、目标未填  → 回去把目标写清楚
 *   有空间、计划在跑  → 你有 N 件待办，先看最急的
 *   比赛结束          → 看结果、写复盘
 *
 * 硬约束（宪法 v1.16.0 原则 X 第 4/8/9 条 + 本轮任务书）：
 *  1. 区分**首次到访**与**继续参赛**；
 *  2. `pendingTasks`/`blockedTasks`/`reviewingTasks` 为 `undefined` 时是"尚未读取"，
 *     **不得当 0 用**：能给出不依赖这些数字的结论就给（如引导补目标），
 *     否则退回 `kind: "unread"` 或指向计划页让用户自己看，绝不伪造推荐；
 *  3. 不产生完成百分比，不替用户断言"你已经完成了 X%"；
 *  4. 纯函数：无副作用、无网络、无 `Date.now()`；
 *  5. `href` 只用 `src/app/` 下真实存在的站内路径。
 */

interface NextStepDraft {
  readonly kind: NextStep["kind"];
  readonly title: string;
  readonly why: string;
  readonly href: string;
}

/** 项目阶段：收尾。与 M02 `ProjectStage` 的真实取值对齐。 */
const WRAP_UP_STAGES: readonly string[] = ["finalizing", "submitted", "retrospective"];
const ARCHIVED_STAGE = "archived";

/** 排在最前的空间：越接近收尾越优先；同阶段保持接入方给的顺序。 */
const STAGE_RANK: Readonly<Record<string, number>> = {
  finalizing: 0, submitted: 0, retrospective: 0, active: 1, preparing: 2, draft: 3,
};

function rankOf(stage: string): number {
  return STAGE_RANK[stage] ?? 4;
}

/** 已归档的空间只读，不作为"下一步"目标。 */
function selectSpace(projects: readonly HomeProjectFacts[]): HomeProjectFacts | null {
  let best: HomeProjectFacts | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const project of projects) {
    if (project.stage === ARCHIVED_STAGE) continue;
    const rank = rankOf(project.stage);
    if (rank < bestRank) { best = project; bestRank = rank; }
  }
  return best;
}

function projectHref(project: HomeProjectFacts): string {
  return `/app/projects/${encodeURIComponent(project.id)}`;
}

function isWrapUpStage(stage: string): boolean {
  return WRAP_UP_STAGES.includes(stage);
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 赛事 id 只能是单段路径参数，否则拼进 href 会指向 404。
 * 不合法时按"还没有选定比赛"处理。
 */
function usableEventId(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9._~-]+$/.test(trimmed)) return null;
  return trimmed;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function wrapUpDraft(project: HomeProjectFacts): NextStepDraft {
  if (project.stage === "retrospective") {
    return {
      kind: "wrap_up",
      title: `写下「${project.name}」这次的经验`,
      why: "这次比赛已经进入复盘阶段，把做得好和要改的地方记下来，下一次能直接复用。",
      href: `${projectHref(project)}/retrospective`,
    };
  }
  return {
    kind: "wrap_up",
    title: `把「${project.name}」推进到提交`,
    why: "这次比赛已经到收尾阶段：先对照提交清单交成果，交完再写复盘。",
    href: `${projectHref(project)}/delivery`,
  };
}

function resultsDraft(project: HomeProjectFacts): NextStepDraft {
  return {
    kind: "read_results",
    title: `看「${project.name}」的结果`,
    why: "这场比赛的提交已经完成，下一步是看结果、留下复盘经验，然后决定要不要再来一次。",
    href: `${projectHref(project)}/delivery`,
  };
}

function taskDraft(project: HomeProjectFacts): NextStepDraft {
  const href = `${projectHref(project)}/plan`;
  const blocked = count(project.blockedTasks);
  const reviewing = count(project.reviewingTasks);
  const pending = count(project.pendingTasks);
  if (blocked > 0) {
    return {
      kind: "do_tasks",
      title: `先解开卡住的 ${blocked} 件事`,
      why: `「${project.name}」里有 ${blocked} 件任务卡住了；先写清缺什么、需要谁配合，其他任务才有意义。`,
      href,
    };
  }
  if (reviewing > 0) {
    return {
      kind: "do_tasks",
      title: `去检查等你的 ${reviewing} 件成果`,
      why: `「${project.name}」里有 ${reviewing} 件成果在等人检查；有人等你，先把它看掉。`,
      href,
    };
  }
  if (pending > 0) {
    return {
      kind: "do_tasks",
      title: `从 ${pending} 件待办里挑一件开始`,
      why: `「${project.name}」里有 ${pending} 件任务还没做完，先做一件，别等下一天。`,
      href,
    };
  }
  return {
    kind: "do_tasks",
    title: `确认「${project.name}」的任务安排`,
    why: `「${project.name}」目前没有待办、没有卡住、也没有等你检查的成果；下一步是核对任务安排，缺什么就补一件。`,
    href,
  };
}

/** 由登录态与本人事实推出首页"下一步"。纯函数：同样输入必得同样输出。 */
export function buildHomeNextStep(input: HomeNextInput): NextStep {
  const draft = decide(input);
  return { kind: draft.kind, title: draft.title, why: draft.why, href: draft.href };
}

function decide(input: HomeNextInput): NextStepDraft {
  // 1) 未登录：先登录。登录后才可能读到他本人的空间。
  if (!input.signedIn) {
    return {
      kind: "sign_in",
      title: "先登录，再看你的下一步",
      why: "登录后才能读到你自己的参赛空间、任务和比赛安排，首页才说得准。还没有账号的话，注册也在这个页面。",
      href: "/login",
    };
  }

  const projects = Array.isArray(input.projects) ? input.projects : [];
  const space = selectSpace(projects);

  // 2) 没有可操作的空间：继续参赛的人先回自己的空间，首次到访的人先看比赛。
  //    判断只看"是否已经走过一次"：空间全归档但本人从未开始参赛，仍属首次到访。
  if (space === null) {
    if (input.hasStartedJourney) {
      return {
        kind: "create_space",
        title: "回到你的参赛空间",
        why: "你已经开始参赛了，但还没有一个可用的空间。一个参赛项目就是一个共享团队空间，进去就能写目标、拉队友。",
        href: "/app",
      };
    }
    if (usableEventId(input.selectedEventId) !== null) {
      return {
        kind: "create_space",
        title: "为这场比赛建一个空间",
        why: "你已经选定了比赛，但还没有参赛空间。建一个空间才能写目标、组队和排任务。",
        href: "/app",
      };
    }
    return {
      kind: "find_event",
      title: "先找一场要参加的比赛",
      why: "第一次来就从这里开始：看有哪些比赛、报名什么时候截止、要求是什么，选定后再建空间。",
      href: "/events",
    };
  }

  // 3) 空间已有，但目标没写清：不依赖任何任务数字，也不会被"未读取"挡住。
  if (!isNonEmpty(space.goal)) {
    return {
      kind: "set_goal",
      title: `在「${space.name}」写清楚这次要做出什么`,
      why: "空间已经建好了，但作品目标还是空的。目标写清楚，队友才知道要一起做什么。",
      href: `${projectHref(space)}#project-goal`,
    };
  }
  if (!isNonEmpty(space.minimumDeliverable)) {
    return {
      kind: "set_goal",
      title: `给「${space.name}」定一个最小成果`,
      why: "目标有了，但最小成果还是空的。先定「做到什么程度就算有东西可交」，做不完时才不会慌。",
      href: `${projectHref(space)}#project-goal`,
    };
  }

  // 4) 已到收尾阶段：这一步不依赖任务数字，可以照常给。
  if (isWrapUpStage(space.stage)) return wrapUpDraft(space);

  // 5) 需要任务数字才能推荐"最急的那件"。未读取时**不猜 0**：
  //    三个数字齐全才给推荐，否则退回 unread，并把用户送到计划页自己看。
  const allCountsRead = typeof space.pendingTasks === "number"
    && typeof space.blockedTasks === "number"
    && typeof space.reviewingTasks === "number";
  if (!allCountsRead) {
    return {
      kind: "unread",
      title: `「${space.name}」的任务还没读出来`,
      why: "任务数量还没读取成功，现在说不准哪一件最急。先打开任务安排自己看，或稍后重新读取；我们不会替你猜。",
      href: `${projectHref(space)}/plan`,
    };
  }

  // 6) 真的在跑：给出待办/卡住/等检查里的最急一件。
  return taskDraft(space);
}

/**
 * 供接入方在"读取中/读取失败"时使用：明确说明现在说不准，
 * 而不是先给一个可能错的推荐。
 */
export function buildUnreadNextStep(reason: string): NextStep {
  return {
    kind: "unread",
    title: "正在读取你的参赛状态",
    why: reason.trim().length > 0 ? reason : "还没读到你的空间与任务，暂时说不准下一步；读取完成后这里会给出建议。",
    href: "/app",
  };
}

/** 赛事结果页：本次比赛选了哪一场就指向那一场的结果。 */
export function buildResultsNextStep(input: HomeNextInput): NextStep | null {
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const space = selectSpace(projects);
  if (space === null) return null;
  if (space.stage !== "submitted" && space.stage !== "retrospective") return null;
  const eventId = usableEventId(input.selectedEventId);
  if (eventId === null) return resultsDraft(space);
  return {
    kind: "read_results",
    title: "看这场比赛的结果",
    why: "你的提交已经完成，下一步是看结果、写下复盘，再决定要不要参加下一场。",
    href: `/competitions/${encodeURIComponent(eventId)}/results`,
  };
}
