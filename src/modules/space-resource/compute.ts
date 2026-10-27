/**
 * 空间「倒计时 + 资源」纯计算。
 *
 * 硬规则（见 README「边界与取舍」）：
 * 1. 所有时刻按传入字符串的**绝对瞬间**计算（`Z` 或显式 `±HH:MM` 偏移），
 *    不使用 `getFullYear/getMonth/...` 等本机时区解释 API，因此结果与本机时区无关。
 * 2. 恰好等于 `now` 的截止点算**已到点、未过期**：`remainingMs === 0`，不进入 `overdue`。
 * 3. `verified` 与 `sourceText` 原样带出，从不推断为已核验。
 * 4. 缺数据（无未来截止、无预算）返回 `undefined`，绝不回落到 `0`。
 * 5. 非法时间字符串被安全拒绝：整体非法返回 `ok: false`，单个非法项进 `skippedDeadlines`。
 * 6. 无 `Date.now()`、无 I/O、无副作用、不产生完成百分比。
 */

import {
  SPACE_PHASE_BASIS_LABELS,
  SPACE_PHASE_LABELS,
  type SpaceBudgetInput,
  type SpaceBudgetView,
  type SpaceDeadlineInput,
  type SpaceDeadlineKind,
  type SpaceDeadlineSkip,
  type SpaceDeadlineView,
  type SpaceNextDeadlineView,
  type SpacePhase,
  type SpacePhaseBasis,
  type SpaceResourceInput,
  type SpaceResourceIssue,
  type SpaceResourceOutcome,
  type SpaceResourceResult,
} from "./model.ts";

/** 规范化 UTC 时刻形如 `2026-10-12T09:00:00.000Z`，与 `Date#toISOString()` 同一形状。 */
const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

const KIND_VALUES = new Set<SpaceDeadlineKind>(["registration", "start", "submission", "other"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(reason: SpaceResourceIssue["reason"], message: string, id?: string): SpaceResourceIssue {
  return id === undefined ? { reason, message } : { reason, message, id };
}

function normalizeKind(value: unknown): SpaceDeadlineKind | null {
  return typeof value === "string" && KIND_VALUES.has(value as SpaceDeadlineKind)
    ? (value as SpaceDeadlineKind)
    : null;
}

/**
 * 只接受带显式时区标记的 ISO 8601 字符串，返回规范化 UTC 字符串与 epoch 毫秒。
 *
 * 拒绝的理由：`"2026-10-12T09:00:00"` 这类不带时区的字符串会被 `Date` 按**本机时区**
 * 解释，结果随机器变化。要求显式偏移，时区影响就只来自输入本身。
 */
export function parseUtcInstant(value: unknown): { readonly iso: string; readonly epochMs: number } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = UTC_INSTANT_PATTERN.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const sign = match[8] === "Z" || match[8] === "+00:00" || match[8] === "-00:00" ? 0 : match[8].startsWith("+") ? 1 : -1;
  const offsetHours = sign === 0 ? 0 : Number(match[8].slice(1, 3));
  const offsetMinutes = sign === 0 ? 0 : Number(match[8].slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) return null;

  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  if (!Number.isFinite(epochMs)) return null;

  // 回环比对拒绝日历上不存在的日期（如 2026-02-30）与依赖回卷的写法（如 24:00）。
  const candidate = new Date(epochMs);
  if (!Number.isFinite(candidate.getTime())) return null;
  const iso = candidate.toISOString();
  const expectedYear = String(year).padStart(4, "0");
  if (iso.slice(0, 10) !== `${expectedYear}-${match[2]}-${match[3]}`) return null;

  return { iso, epochMs };
}

export function isValidUtcInstant(value: unknown): boolean {
  return parseUtcInstant(value) !== null;
}

function isMicros(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 有未来截止时 phase 一定可判定。无截止返回 `"unknown"` 与 `basis: "no_deadline"`；
 * 有截止但全部无法分类时返回 `"unknown"` 与 `basis: "no_deadline"`（不假装"赛前"）。
 */
export function computePhase(
  nowMs: number,
  classified: readonly { readonly kind: SpaceDeadlineKind; readonly epochMs: number }[],
): { readonly phase: SpacePhase; readonly basis: SpacePhaseBasis } {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endKind: SpaceDeadlineKind | null = null;
  let hasSubmission = false;

  for (const item of classified) {
    if (item.kind === "start") {
      if (startMs === null || item.epochMs < startMs) startMs = item.epochMs;
      continue;
    }
    if (item.kind === "submission") hasSubmission = true;
    if (item.kind === "registration" || item.kind === "submission" || item.kind === "other") {
      if (endMs === null || item.epochMs > endMs) {
        endMs = item.epochMs;
        endKind = item.kind;
      }
    }
  }

  if (endMs === null) {
    // 只有开赛时刻、没有任何结束边界时无法判定阶段，不假装"赛前"。
    return { phase: "unknown", basis: "no_deadline" };
  }
  // 边界：恰好等于结束边界（含提交截止）仍算未过点，落在 during；
  // 只有真正晚于该瞬间才进入 after。与 next.remainingMs === 0 的"已到点未过期"同一口径。
  if (nowMs <= endMs) {
    if (startMs !== null && nowMs >= startMs) {
      return { phase: "during", basis: "during_after_start" };
    }
    if (startMs === null && hasSubmission) {
      return { phase: "during", basis: "during_no_start" };
    }
    return { phase: "before", basis: "before_start" };
  }
  if (endKind === "submission" && hasSubmission) {
    return { phase: "after", basis: "after_submission" };
  }
  return { phase: "after", basis: "after_latest" };
}

function computeBudget(
  budget: SpaceBudgetInput | null | undefined,
  issues: SpaceResourceIssue[],
): SpaceBudgetView | undefined {
  if (budget === undefined || budget === null) return undefined;
  if (!isRecord(budget)) {
    issues.push(issue("invalid_budget", "预算不是对象，按缺数据处理（remainingMicros 不回落为 0）。"));
    return undefined;
  }
  const totalMicros = budget.totalMicros;
  const usedMicros = budget.usedMicros;
  if (!isMicros(totalMicros)) {
    issues.push(issue("invalid_budget", "预算总额不是非负安全整数微单位，按缺数据处理。"));
    return undefined;
  }
  if (!isMicros(usedMicros)) {
    issues.push(issue("invalid_budget", "已用额度不是非负安全整数微单位，按缺数据处理。"));
    return undefined;
  }
  const remainingMicros = totalMicros - usedMicros;
  return { totalMicros, usedMicros, remainingMicros, over: remainingMicros < 0 };
}

function toView(
  deadline: SpaceDeadlineInput,
  parsed: { readonly iso: string; readonly epochMs: number },
  kind: SpaceDeadlineKind | null,
): SpaceDeadlineView {
  return {
    id: deadline.id,
    label: deadline.label,
    at: parsed.iso,
    sourceText: deadline.sourceText,
    verified: deadline.verified === true,
    kind,
  };
}

/**
 * 主计算入口。纯函数：同一输入总得到同一输出，不读时钟、不写日志、不碰存储。
 *
 * `ok: false` 表示**整体无法计算**（当前时刻非法、输入不是对象、deadlines 不是数组）；
 * 此时不返回任何 `result`，避免调用方把"没有结果"误读成"没有剩余"。
 */
export function computeSpaceResource(input: SpaceResourceInput): SpaceResourceOutcome {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue("invalid_input", "输入不是对象。")] };
  }

  const now = parseUtcInstant(input.now);
  if (now === null) {
    return {
      ok: false,
      issues: [issue("invalid_now", `当前时刻不是带显式时区的 ISO 8601 UTC 字符串：${String(input.now)}`)],
    };
  }

  const rawDeadlines = input.deadlines;
  if (!Array.isArray(rawDeadlines)) {
    return { ok: false, issues: [issue("invalid_input", "deadlines 不是数组。")] };
  }

  const issues: SpaceResourceIssue[] = [];
  const skipped: SpaceDeadlineSkip[] = [];
  const seenIds = new Set<string>();
  const unclassifiedDeadlineIds: string[] = [];
  const classified: { readonly kind: SpaceDeadlineKind; readonly epochMs: number }[] = [];
  const views: SpaceDeadlineView[] = [];

  for (const candidate of rawDeadlines) {
    if (!isRecord(candidate)) {
      skipped.push({ id: "", label: "", instantUtc: "", reason: "invalid_instant" });
      continue;
    }
    const deadline = candidate as unknown as SpaceDeadlineInput;
    const parsed = parseUtcInstant(deadline.instantUtc);
    if (parsed === null) {
      // 单个非法时刻只排除该项，并把它列进 skippedDeadlines：丢数据必须可见。
      skipped.push({
        id: typeof deadline.id === "string" ? deadline.id : "",
        label: typeof deadline.label === "string" ? deadline.label : "",
        instantUtc: typeof deadline.instantUtc === "string" ? deadline.instantUtc : "",
        reason: "invalid_instant",
      });
      continue;
    }
    if (!isNonEmptyString(deadline.id) || !isNonEmptyString(deadline.label)) {
      skipped.push({
        id: typeof deadline.id === "string" ? deadline.id : "",
        label: typeof deadline.label === "string" ? deadline.label : "",
        instantUtc: typeof deadline.instantUtc === "string" ? deadline.instantUtc : "",
        reason: "invalid_instant",
      });
      continue;
    }
    if (seenIds.has(deadline.id)) {
      // 重复 ID 会让 next/overdue 自相矛盾，保留首个并记录冲突。
      skipped.push({
        id: deadline.id,
        label: deadline.label,
        instantUtc: deadline.instantUtc,
        reason: "duplicate_id",
      });
      continue;
    }
    seenIds.add(deadline.id);

    const kind = normalizeKind(deadline.kind);
    if (kind === null) {
      unclassifiedDeadlineIds.push(deadline.id);
    } else {
      classified.push({ kind, epochMs: parsed.epochMs });
    }
    views.push(toView(deadline, parsed, kind));
  }

  const upcoming: SpaceNextDeadlineView[] = [];
  const overdue: SpaceDeadlineView[] = [];
  for (const item of views) {
    const parsed = parseUtcInstant(item.at);
    // views 中的 at 一定来自 parseUtcInstant，这里的空值分支只为类型收窄。
    if (parsed === null) continue;
    if (parsed.epochMs < now.epochMs) {
      overdue.push(item);
    } else {
      // 恰好等于 now 归入 upcoming，remainingMs 为 0。
      upcoming.push({ ...item, remainingMs: parsed.epochMs - now.epochMs });
    }
  }
  overdue.sort((left, right) => (parseUtcInstant(left.at)?.epochMs ?? 0) - (parseUtcInstant(right.at)?.epochMs ?? 0));
  upcoming.sort((left, right) => left.remainingMs - right.remainingMs);

  const next = upcoming.length > 0 ? upcoming[0] : undefined;
  if (views.length === 0) {
    issues.push(issue("no_deadlines", "没有可用的截止时刻：next 与 phase 都无法判定，不用 0 或「赛前」顶替。"));
  }

  const { phase, basis } = computePhase(now.epochMs, classified);
  const budget = computeBudget(input.budget, issues);

  const result: SpaceResourceResult = {
    ...(next === undefined ? {} : { next }),
    overdue,
    phase,
    phaseBasis: basis,
    phaseLabel: SPACE_PHASE_LABELS[phase],
    now: now.iso,
    ...(budget === undefined ? {} : { budget }),
    deadlineCount: views.length,
    skippedDeadlines: skipped,
    unclassifiedDeadlineIds,
    issues,
  };
  return { ok: true, result };
}

export function phaseBasisLabel(basis: SpacePhaseBasis): string {
  return SPACE_PHASE_BASIS_LABELS[basis];
}

/** 把微单位整数格式化为「1.5 美元 / 300000 微单位」这类可读文本；不参与计算。 */
export function formatMicros(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const absolute = Math.abs(micros);
  const units = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction.length === 0 ? `${sign}${units}` : `${sign}${units}.${fraction}`;
}
