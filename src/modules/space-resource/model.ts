/**
 * 空间「倒计时 + 资源」纯计算模块的类型。
 *
 * 唯一输入是调用方传入的最小事实：当前 UTC 时刻、截止时间数组、可选预算。
 * 本模块**不**读取赛事存储、报名存储、项目存储或任何账号权限，也不产生完成百分比。
 */

/** 倒计时所处的大阶段。无法判定时为 `"unknown"`，不用 "before" 顶替。 */
export type SpacePhase = "before" | "during" | "after" | "unknown";

/**
 * 截止时间的来源类别。
 *
 * 这是调用方传入的**来源事实**，不是本模块的推论。`null` 表示调用方无法分类
 * （例如只有一句 `sourceText`）；此时该截止仍参与 `next` / `overdue`，但不参与阶段边界。
 */
export type SpaceDeadlineKind = "registration" | "start" | "submission" | "other";

/** 判定依据的可见说明，便于界面解释"为什么现在算赛中"。 */
export type SpacePhaseBasis =
  | "no_deadline"
  | "before_start"
  | "during_after_start"
  | "during_no_start"
  | "after_submission"
  | "after_latest";

export interface SpaceDeadlineInput {
  readonly id: string;
  readonly label: string;
  /** ISO 8601 UTC 时刻，必须带 `Z` 或显式 `±HH:MM` 偏移。 */
  readonly instantUtc: string;
  /** 原始来源文字，必须原样出现在输出里。 */
  readonly sourceText: string;
  /** 只有调用方核验过才可为 `true`；本模块从不推断为已核验。 */
  readonly verified: boolean;
  /** 可选来源类别；缺省视为未分类（`null`）。 */
  readonly kind?: SpaceDeadlineKind | null;
}

/** 微单位（百万分之一）整数额度。不使用小数，避免浮点误差被当成真实额度。 */
export interface SpaceBudgetInput {
  readonly totalMicros: number;
  readonly usedMicros: number;
}

export interface SpaceResourceInput {
  /** ISO 8601 UTC 时刻。 */
  readonly now: string;
  readonly deadlines: readonly SpaceDeadlineInput[];
  readonly budget?: SpaceBudgetInput;
}

/**
 * 单个截止点的计算结果。
 *
 * `verified` 与 `sourceText` 原样带出：`verified: false` 到任何界面都必须仍显示为未核验。
 */
export interface SpaceDeadlineView {
  readonly id: string;
  readonly label: string;
  /** 规范化后的 UTC 时刻（`YYYY-MM-DDTHH:MM:SS.sssZ`）。 */
  readonly at: string;
  readonly sourceText: string;
  readonly verified: boolean;
  /** 与输入 `kind` 一致；未分类为 `null`。 */
  readonly kind: SpaceDeadlineKind | null;
}

/** 下一个尚未到期的截止点。`remainingMs` 恰为 `0` 表示"就是现在"。 */
export interface SpaceNextDeadlineView extends SpaceDeadlineView {
  readonly remainingMs: number;
}

export interface SpaceBudgetView {
  readonly totalMicros: number;
  readonly usedMicros: number;
  /** `total - used`，**不夹到 0**：超额时为负数，缺口大小可见。 */
  readonly remainingMicros: number;
  readonly over: boolean;
}

export type SpaceDeadlineSkipReason = "invalid_instant" | "duplicate_id";

/** 被排除在计算之外的截止点。缺数据要能被看见，不能安静丢掉。 */
export interface SpaceDeadlineSkip {
  readonly id: string;
  readonly label: string;
  readonly instantUtc: string;
  readonly reason: SpaceDeadlineSkipReason;
}

export type SpaceResourceIssueReason =
  | "invalid_now"
  | "invalid_input"
  | "no_deadlines"
  | "invalid_budget";

export interface SpaceResourceIssue {
  readonly reason: SpaceResourceIssueReason;
  readonly message: string;
  /** 只指向输入里的 ID，便于调用方定位。 */
  readonly id?: string;
}

export interface SpaceResourceResult {
  /**
   * 下一个未到期的截止点。**没有时为 `undefined`**（不是 0，也不是伪造的占位）。
   * 界面应据此显示"没有已知的未来截止"，而不是显示"还剩 0 天"。
   */
  readonly next?: SpaceNextDeadlineView;
  /** 已经过期的截止点，按时间升序。 */
  readonly overdue: readonly SpaceDeadlineView[];
  readonly phase: SpacePhase;
  readonly phaseBasis: SpacePhaseBasis;
  readonly phaseLabel: string;
  /** 原始传入时刻的规范化形式。 */
  readonly now: string;
  /** **缺预算数据时为 `undefined`**，绝不回落到 `0`。 */
  readonly budget?: SpaceBudgetView;
  /** 全部合法截止点数量（含已过期）。 */
  readonly deadlineCount: number;
  /** 因非法时刻或重复 ID 被排除的截止点。 */
  readonly skippedDeadlines: readonly SpaceDeadlineSkip[];
  /** 未分类、因而不参与阶段边界的截止点 ID。 */
  readonly unclassifiedDeadlineIds: readonly string[];
  /** 缺数据与非致命输入的说明；正常结果为空数组。 */
  readonly issues: readonly SpaceResourceIssue[];
}

export interface SpaceResourceInvalid {
  readonly ok: false;
  readonly issues: readonly SpaceResourceIssue[];
}

export interface SpaceResourceValid {
  readonly ok: true;
  readonly result: SpaceResourceResult;
}

export type SpaceResourceOutcome = SpaceResourceValid | SpaceResourceInvalid;

export const SPACE_PHASE_LABELS: Readonly<Record<SpacePhase, string>> = {
  before: "赛前",
  during: "赛中",
  after: "赛后",
  unknown: "时间未知",
};

export const SPACE_PHASE_BASIS_LABELS: Readonly<Record<SpacePhaseBasis, string>> = {
  no_deadline: "没有可用的截止时刻",
  before_start: "现在早于开赛时刻",
  during_after_start: "现在已过开赛时刻且未到提交截止",
  during_no_start: "没有开赛时刻，按最新截止时刻边界判定",
  after_submission: "现在已过提交截止",
  after_latest: "现在已过最晚截止时刻",
};
