import {
  SCOPE_CUT_UNKNOWN_NOTICE_PREFIX,
  SCOPE_CUT_WINDOWS,
  type ScopeCutAdvice,
  type ScopeCutFacts,
  type ScopeCutVerdict,
} from "./model.ts";

/**
 * 「做不完怎么砍」的纯函数实现。
 *
 * 硬约束（违反即不合格）：
 * 1. 只依据传入事实；事实不足返回 `unknown` 并说明缺什么，绝不编造进度。
 * 2. 不产生完成百分比、完成状态或「还剩 N% 工作」。本模块只引用
 *    调用方传入的计数事实与剩余毫秒，不把计数换算成任何完成度。
 * 3. `cut` 每条都是具体动作（砍什么、降级成什么、什么时候停下来）。
 * 4. `sayToTeam` 平和、可执行、不指责。
 * 5. 无副作用、无 Date.now()、无随机、无 I/O；同一输入永远同一输出。
 */

/** 事实不足的单条说明。 */
interface FactGap {
  readonly field: string;
  readonly reason: string;
}

const EMPTY = "";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : EMPTY;
}

/** 把剩余毫秒说成人话。只说区间，不编造精度。 */
function describeRemaining(remainingMs: number): string {
  const hours = remainingMs / (60 * 60 * 1_000);
  if (remainingMs <= 0) return "剩余时间已经是 0";
  if (hours < 0.5) return "不到半小时";
  if (hours < 1) return "不到 1 小时";
  if (hours < 2) return "约 1 个多小时";
  if (hours < 36) return `约 ${Math.round(hours)} 小时`;
  return `约 ${Math.round(hours / 24)} 天`;
}

/**
 * 识别阶段。识别不了返回 `"unknown"`，此时不叠加任何阶段专项建议——
 * 宁可少说一句，也不假装知道团队在哪个阶段。
 */
type StageBand = "early" | "build" | "submit" | "pitch" | "unknown";

function detectStageBand(stage: string): StageBand {
  const text = stage.toLowerCase();
  if (text === EMPTY) return "unknown";
  if (/提交|交件|deliver|submission|submit|截止/.test(text)) return "submit";
  if (/路演|演示|demo|pitch|答辩|展示/.test(text)) return "pitch";
  if (/开发|实现|编码|building|build|coding|dev/.test(text)) return "build";
  if (/报名|选题|组队|立项|报名中|ideation|kickoff|setup|plan/.test(text)) return "early";
  return "unknown";
}

function unknownAdvice(gaps: readonly FactGap[], fallbackGoal: string, fallbackStage: string): ScopeCutAdvice {
  const missing = gaps.map(gap => `${gap.field}（${gap.reason}）`).join("、");
  const focus = fallbackGoal === EMPTY ? "先把目标和最小成果写下来" : `先把目标一句话说清：${fallbackGoal}`;
  return {
    verdict: "unknown",
    keep: [
      `先补事实再谈取舍：${missing}。`,
      "顺手做一件不依赖这些数据的事：把「最小成果」写成一句话——现有成果里删掉哪一块，这个项目仍然算交得出东西。",
    ],
    cut: [
      "在事实补齐前，先不要删代码或撤功能；缺少依据的取舍会把能交的东西一起砍掉。",
      `先冻结新增范围：下一个新功能暂停进主线，${focus}。`,
    ],
    sayToTeam:
      fallbackStage === EMPTY
        ? "我这边还缺一组关键数字（剩余时间和任务统计），先按最小成果对齐一下：我们删掉哪一块仍然算交付得出东西。"
        : `我们还在「${fallbackStage}」，但我这边缺一组关键数字（剩余时间和任务统计），先按最小成果对齐一下：删掉哪一块仍然算交付得出东西。`,
    notice: `${SCOPE_CUT_UNKNOWN_NOTICE_PREFIX}缺少 ${missing}。这不是"没有进度"，只是本模块读不到可依据的事实；补齐后可以立刻重算，不会推断你现在的进度。`,
  };
}

/**
 * 由只读事实给出取舍建议。
 *
 * @param facts 只读事实。不修改入参，不返回入参的引用。
 * @returns 判断、守住什么、砍什么、对队友说的一句话、依据说明。
 */
export function adviseScopeCut(facts: ScopeCutFacts): ScopeCutAdvice {
  const goal = normalizeText(facts?.goal);
  const minimumDeliverable = normalizeText(facts?.minimumDeliverable);
  const stage = normalizeText(facts?.stage);

  const gaps: FactGap[] = [];
  for (const key of ["total", "done", "blocked", "inProgress"] as const) {
    if (facts?.tasks === undefined || facts?.tasks === null) {
      gaps.push({ field: `tasks.${key}`, reason: "任务统计整块缺失" });
      continue;
    }
    const value: unknown = facts.tasks[key];
    if (!isFiniteNumber(value)) {
      gaps.push({ field: `tasks.${key}`, reason: "缺失或不是有限数字" });
    } else if (value < 0) {
      gaps.push({ field: `tasks.${key}`, reason: "计数为负" });
    }
  }

  // 计数之间自相矛盾时不猜哪一项对，直接报事实不足。
  const countsUsable =
    isFiniteNumber(facts?.tasks?.total) &&
    isFiniteNumber(facts?.tasks?.done) &&
    isFiniteNumber(facts?.tasks?.blocked) &&
    isFiniteNumber(facts?.tasks?.inProgress) &&
    facts.tasks.total >= 0 &&
    facts.tasks.done >= 0 &&
    facts.tasks.blocked >= 0 &&
    facts.tasks.inProgress >= 0;
  if (countsUsable) {
    const { total, done, blocked, inProgress } = facts.tasks;
    if (done + blocked + inProgress > total) {
      gaps.push({
        field: "tasks",
        reason: `已完成+阻塞+进行中 大于总数（${done + blocked + inProgress} > ${total}）`,
      });
    }
    if (total === 0) {
      gaps.push({ field: "tasks.total", reason: "一条任务都还没有登记，无法据此谈取舍" });
    }
  }

  if (!isFiniteNumber(facts?.remainingMs)) {
    gaps.push({ field: "remainingMs", reason: "缺失或不是有限数字（NaN/Infinity）" });
  } else if (facts.remainingMs < 0) {
    gaps.push({ field: "remainingMs", reason: "为负，传入的截止时刻已经过去；本模块不知道那之后发生了什么" });
  }

  if (minimumDeliverable === EMPTY) {
    gaps.push({ field: "minimumDeliverable", reason: "没写最小成果；砍到哪里为止没有依据" });
  }

  if (gaps.length > 0) return unknownAdvice(gaps, goal, stage);

  const { total, done, blocked, inProgress } = facts.tasks;
  const remainingMs = facts.remainingMs;
  const unsettled = total - done;
  const notStarted = total - done - blocked - inProgress;
  const hasUnsettledWork = unsettled > 0;
  const busy = inProgress > 0 || blocked > 0;
  const remainingText = describeRemaining(remainingMs);
  const stageBand = detectStageBand(stage);
  const goalText = goal === EMPTY ? "当前目标" : goal;
  // 三种写法，按句子里嵌不嵌套挑：
  // minimumLabel 已带书名号，用于独立成句；minimumPhrase 用冒号，用于句尾；
  // minimumBare 用（），用于会被塞进另一层引号/冒号的句子里，避免套娃引号。
  const minimumLabel = `最小成果「${minimumDeliverable}」`;
  const minimumPhrase = `最小成果：${minimumDeliverable}`;
  const minimumBare = `最小成果（${minimumDeliverable}）`;

  let verdict: ScopeCutVerdict;
  if (remainingMs < SCOPE_CUT_WINDOWS.criticalMs && hasUnsettledWork) {
    verdict = "must_cut";
  } else if (
    (remainingMs < SCOPE_CUT_WINDOWS.riskMs && (hasUnsettledWork || busy)) ||
    (blocked > 0 && remainingMs < SCOPE_CUT_WINDOWS.blockedRiskMs) ||
    (notStarted > 0 && notStarted * 3 > total && remainingMs < SCOPE_CUT_WINDOWS.riskMs * 3)
  ) {
    verdict = "at_risk";
  } else {
    verdict = "on_track";
  }

  const keep: string[] = [];
  const cut: string[] = [];

  if (verdict === "on_track") {
    keep.push(
      `守住${minimumLabel}，把它当成唯一验收口径：每个改动先问一句「这属于最小成果吗」。`,
    );
    if (notStarted > 0) {
      keep.push(
        `把还没开始的部分排成一条顺序：先挑最能证明${minimumLabel}的那一件，做完一件再开下一件。`,
      );
    } else {
      keep.push(`把${minimumLabel}的演示流程跑通一遍（从打开到给出结果），确认它能独立走完。`);
    }
    cut.push(
      "把新功能先记进「提交后再做」清单，不再拆进当前主线：主线只留能直接支撑最小成果的改动。",
    );
  } else if (verdict === "at_risk") {
    keep.push(
      `把${minimumLabel}当成唯一的必须项，其余全部按「可缺席」对待。`,
    );
    keep.push(
      `留出一段时间不写新代码，只做一件事：把${minimumBare}走通，并准备演示；这段时间不再合并新功能。`,
    );
    cut.push(
      `拿目标「${goalText}」逐个对照${minimumBare}：凡是删掉后这条底线仍然成立的，今天就停手，移进「提交后再做」清单（代码留在分支或注释里，不删除）。`,
    );
    cut.push(
      "把最后一层包装先砍掉：多端适配、动画、主题/皮肤、完整的设置页，都降级成「能演示即可」的最小形态，功能逻辑不变。",
    );
    if (notStarted > 0) {
      cut.push(
        `把还没开始的部分按顺序从队尾往回砍：最不影响最小成果的那几件先标为「本轮不做」，并且只保留一件在手上。`,
      );
    }
    if (stageBand === "submit") {
      cut.push(
        "把提交材料收敛成一份：必填字段和一段能跑通的演示，额外的说明文档、截图美化、排版精修一律推后。",
      );
    }
  } else {
    keep.push(
      `只保${minimumLabel}这一条线：从现在到截止，只做能直接让它成立的事。`,
    );
    keep.push(
      "所有未收尾的改动今天就停下，回到一个能打开、能演示的状态；宁可少一块功能，不要留打不开的版本。",
    );
    cut.push(
      `拿目标「${goalText}」逐条划掉：不属于${minimumBare}的，一律改成本地或手动方式。例如实时协作降级为「一个人改、其他人刷新看」；登录/权限降级为「只跑一个演示账号」；自动同步降级为「手动导出再导入」；在线服务降级为「本机跑通并录一段演示」。`,
    );
    cut.push(
      "把剩下的时间只花在三件事上：最小成果能跑通、演示流程能完整走一遍、提交材料填完必填项。其它一律不做。",
    );
    if (stageBand === "submit") {
      cut.push("提交入口先占位：先把必填项交上去拿到提交记录，再回头补内容，不要等到最后一刻才第一次点提交。");
    }
    if (stageBand === "pitch") {
      cut.push("讲稿砍到三句话：我们做什么、最小成果里已经跑通什么、接下来最想做成什么。逐页精修一律不做。");
    }
    if (stageBand === "early") {
      cut.push("如果现在还在选题/组队阶段，先把范围砍到「一个人一个能演示的闭环」，再谈加人加功能。");
    }
  }

  if (blocked > 0) {
    keep.unshift(
      `阻塞的部分今天处理掉：给每一条指定一个人和一个明确问题，两小时内解不掉就当场降级或砍掉，不要留到最后。`,
    );
  }
  if (busy && verdict === "must_cut") {
    keep.push("正在做的部分只允许收尾，不允许再开新的改动；收尾到能演示就停。");
  }

  const sayToTeam = buildSayToTeam(verdict, remainingText, minimumDeliverable, blocked, stage);
  const notice = buildNotice(verdict, remainingText, total, done, blocked, inProgress, stage, gaps);

  return { verdict, keep, cut, sayToTeam, notice };
}

function buildSayToTeam(
  verdict: ScopeCutVerdict,
  remainingText: string,
  minimumDeliverable: string,
  blocked: number,
  stage: string,
): string {
  const stageLead = stage === EMPTY ? "" : `我们还在「${stage}」，`;
  const blockedLead = blocked > 0 ? "先别急着加功能，卡住的那几条我们两小时内一起解，解不掉就当场降级。" : "";
  if (verdict === "on_track") {
    return `${stageLead}时间还剩${remainingText}，节奏还行。接下来我们只盯一件事：让「${minimumDeliverable}」完整跑通一遍。想加的东西先记下来，提交后再做。`;
  }
  if (verdict === "at_risk") {
    return `${stageLead}时间还剩${remainingText}。${blockedLead}我们先把「${minimumDeliverable}」守住，其它一律按「可以不要」处理：今天先把不属于它的部分停手，把演示流程走通。不是为了做得更多，是为了交得出去。`;
  }
  return `${stageLead}时间还剩${remainingText}，我们按最小成果收口：只保「${minimumDeliverable}」能打开、能演示。${blockedLead}剩下没做完的，今天统一记进「提交后再做」，不删代码也不加班补功能——先交出去，比交得多重要。`;
}

function buildNotice(
  verdict: ScopeCutVerdict,
  remainingText: string,
  total: number,
  done: number,
  blocked: number,
  inProgress: number,
  stage: string,
  gaps: readonly FactGap[],
): string {
  const basis = `依据你传入的事实：剩余时间${remainingText}，任务计数为 总数 ${total}、已完成 ${done}、阻塞 ${blocked}、进行中 ${inProgress}${
    stage === EMPTY ? "，未提供阶段" : `，阶段「${stage}」`
  }。`;
  const boundary = "本模块不推算完成度、不给完成百分比，也不替团队决定砍什么；上面的取舍是建议，最终由你们定。";
  const stageNote =
    detectStageBand(stage) === "unknown" && stage !== EMPTY
      ? `阶段「${stage}」未识别，所以没有叠加阶段专项建议。`
      : EMPTY;
  const gapNote = gaps.length > 0 ? `另有未使用的事实缺口：${gaps.map(gap => gap.field).join("、")}。` : EMPTY;
  if (verdict === "on_track") {
    return `${basis}按现有事实看不出必须现在砍的东西。${stageNote}${gapNote}${boundary}`;
  }
  if (verdict === "at_risk") {
    return `${basis}剩余时间相对未结算的任务偏紧，建议主动收范围，而不是等来不及再删。${stageNote}${gapNote}${boundary}`;
  }
  return `${basis}剩余时间已经很短且仍有未结算的任务，建议按最小成果保交付。${stageNote}${gapNote}${boundary}`;
}
