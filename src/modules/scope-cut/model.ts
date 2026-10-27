/**
 * 范围调整（规划27 第 4.3 项「做不完怎么砍」）。
 *
 * 本模块只做一件事：把调用方**已经读到**的只读事实，翻译成可执行的取舍建议。
 * 它不读库、不写库、不导入其它模块，也不产生任何完成状态或完成百分比——
 * 「完成」永远只由既有真实记录判定（宪法原则 X）。
 */

/** 任务统计。只接收计数事实，不接收任务细节，避免本模块越权解释任务语义。 */
export interface ScopeCutTaskCounts {
  /** 团队登记的任务总数。 */
  readonly total: number;
  /** 已经由真实记录判定为完成的任务数。 */
  readonly done: number;
  /** 当前被阻塞、需要外部帮助或决策的任务数。 */
  readonly blocked: number;
  /** 当前正在做的任务数。 */
  readonly inProgress: number;
}

/**
 * 输入契约：全部是调用方读到的只读事实，当前时刻由 `remainingMs` 表达。
 *
 * 为什么是「剩余毫秒」而不是「截止时刻」：本模块不做日期/时区运算，
 * 现在几点、剩下多少时间必须由调用方算好并传入，本模块不调用 Date.now()。
 */
export interface ScopeCutFacts {
  /** 当前目标（团队自己写的，一句话）。 */
  readonly goal: string;
  /** 最小成果：交付底线。这是「砍到哪里为止」的唯一支点。 */
  readonly minimumDeliverable: string;
  /**
   * 距下一个真实截止还剩多少毫秒。必须由调用方传入。
   * 负数、NaN、Infinity 都视为事实不足，而不是「已经过点了」的结论。
   */
  readonly remainingMs: number;
  /** 阶段文本（例如「开发」「提交」）。识别不了时照常给建议，只是不叠加阶段专项建议。 */
  readonly stage: string;
  /** 任务计数事实。缺失任何一项都视为事实不足。 */
  readonly tasks: ScopeCutTaskCounts;
}

/** 判断结论。`unknown` 表示事实不足，此时 `notice` 会说明缺什么。 */
export type ScopeCutVerdict = "on_track" | "at_risk" | "must_cut" | "unknown";

/** 输出契约。keep/cut 都是给团队看的可执行建议，不是命令。 */
export interface ScopeCutAdvice {
  readonly verdict: ScopeCutVerdict;
  /** 必须守住的（含最小成果本身与阻塞处理）。 */
  readonly keep: readonly string[];
  /** 可以砍或降级的，每条都是具体动作。 */
  readonly cut: readonly string[];
  /** 给队友的一句话：平和、可执行、不指责。 */
  readonly sayToTeam: string;
  /** 依据说明，含事实不足时缺什么。 */
  readonly notice: string;
}

/** 建议里提到的时窗刻度。集中在此，便于测试与主会话引用。 */
export const SCOPE_CUT_WINDOWS = {
  /** 少于 6 小时且仍有未结算工作 → must_cut。 */
  criticalMs: 6 * 60 * 60 * 1_000,
  /** 少于 24 小时仍有未结算工作 → at_risk。 */
  riskMs: 24 * 60 * 60 * 1_000,
  /** 少于 48 小时且存在阻塞 → at_risk。 */
  blockedRiskMs: 48 * 60 * 60 * 1_000,
} as const;

/** 事实不足时的统一提示：只说明缺什么，不推测现状。 */
export const SCOPE_CUT_UNKNOWN_NOTICE_PREFIX = "暂时给不出取舍建议：";
