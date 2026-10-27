/**
 * 容量对照（规划31 第1.5项）。
 *
 * 问题：`evaluation.likely.capacityMinutes`（每人可用分钟）**早已被算出来**，
 * 但全仓没有任何一处渲染它；`remainingEstimate`（剩余工时）也只作单条进度记录显示。
 * 于是"谁的活排不下、谁的窗口空着"谁也不知道，只能等 `deadline_risk` 通知才发现。
 *
 * 设计约束（宪法 v1.20.0 原则 X）：
 *  - 纯派生：只把两份**真实数字**并排显示，不写任何状态，不落库；
 *  - **不出百分比、不出排名、不出完成度**；
 *  - 事实不足（计划依据已变化、无排程、缺工时）时**不比较**，如实说明缺什么；
 *  - 估算不是承诺：本函数只做减法，不推断"来得及/来不及"。
 */

export interface MemberCapacityInput {
  readonly membershipId: string;
  /** 本人显示名，由调用方提供；本函数不做取名。 */
  readonly name: string;
}

export interface MemberCapacityRow {
  readonly membershipId: string;
  readonly name: string;
  /** 未结算任务的剩余工时合计（分钟）。 */
  readonly remainingMinutes: number;
  /** 计划里给这位成员的可用分钟；缺数据时为 null。 */
  readonly capacityMinutes: number | null;
}

export interface MemberCapacityView {
  /** 可以比较时为 "ready"；依据不足时为 "unknown" 并给出原因。 */
  readonly state: "ready" | "unknown";
  readonly rows: readonly MemberCapacityRow[];
  /** 依据不足的原因（state 为 unknown 时非空）。 */
  readonly notice: string;
}

export function buildMemberCapacity(input: {
  readonly members: readonly MemberCapacityInput[];
  readonly tasks: readonly { readonly ownerMembershipId: string | null; readonly status: string; readonly remainingEstimate?: { readonly likelyMinutes: number } | null; readonly durationEstimate?: { readonly likelyMinutes: number } }[];
  readonly capacityMinutes?: Readonly<Record<string, number>> | null;
  readonly staleInputs?: boolean;
  readonly checked?: boolean;
}): MemberCapacityView {
  if (input.staleInputs) return { state: "unknown", rows: [], notice: "计划依据已变化，暂不比较剩余工作量与可用时间。请先核对任务计划。" };
  if (!input.capacityMinutes || Object.keys(input.capacityMinutes).length === 0) {
    return { state: "unknown", rows: [], notice: "还没有可用的排程结果，暂时无法比较每个人剩余的工作量与时间。" };
  }
  if (input.members.length === 0) return { state: "unknown", rows: [], notice: "还没有可比较的活跃成员。" };

  const rows = input.members.map(member => {
    const remaining = input.tasks
      .filter(task => task.ownerMembershipId === member.membershipId && task.status !== "cancelled" && task.status !== "done")
      // 优先用本人更新过的剩余工时；没有就用当初的估算。两者都缺时按 0 计入并在下方说明。
      .reduce((total, task) => total + (task.remainingEstimate?.likelyMinutes ?? task.durationEstimate?.likelyMinutes ?? 0), 0);
    const capacity = input.capacityMinutes?.[member.membershipId];
    return { membershipId: member.membershipId, name: member.name, remainingMinutes: remaining,
      capacityMinutes: typeof capacity === "number" && Number.isFinite(capacity) ? capacity : null };
  });

  const missing = rows.filter(row => row.capacityMinutes === null).length;
  const notice = missing > 0 ? `有 ${missing} 位成员还没有可用时间记录，他们的对照留空；这不代表时间是 0。` : "";
  return { state: "ready", rows, notice };
}

/** 把分钟说成人话；不产生百分比。 */
export function describeMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "未记录";
  if (minutes <= 0) return "0 分钟";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours === 0) return `${rest} 分钟`;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
