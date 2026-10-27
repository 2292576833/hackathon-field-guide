import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { AppealResolutionInput, JudgingConfig, PublishedResults, ResultAppeal } from "./model.ts";
import { invalid, text } from "./validation.ts";

/**
 * 参赛者申诉（结果公布之后）。
 *
 * 依据：竞品源码把"申诉"作为公布之后独立的一步（Synnovator `.github/workflows/appeal.yml`）。
 * 我们此前只有主办方侧撤回/重开，选手没有正式通道。
 *
 * 边界（写在本文件里，避免后人误用）：
 * 1. 申诉是**新事实**，但**绝不自动改变结果**：受理只表示"我们已受理并将处理"，
 *    真正改分必须走既有撤回 → 重新开放 → 补评 → 重新锁定 → 人工公布链路。
 * 2. 一条队伍对同一版公布结果只能有一条有效申诉（撤回后可以重新提交）。
 * 3. 只允许当前仍在该作品队伍里的成员提交，不能代人提交。
 * 4. 时限由本轮 `appealWindowDays` 决定（默认 7 天），以公布时间为起点。
 */

export const defaultAppealWindowDays = 7;
export const appealDecisions = ["accepted", "rejected", "handled"] as const;
export const appealStatusNames: Record<ResultAppeal["status"], string> = {
  submitted: "待主办方处理", accepted: "已受理", rejected: "不受理", handled: "已处理", withdrawn: "已撤回",
};

const DAY_MS = 86_400_000;

export function appealWindowDays(config: JudgingConfig): number {
  const value = config.appealWindowDays ?? defaultAppealWindowDays;
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : defaultAppealWindowDays;
}

export function appealDeadline(publishedAt: Instant, windowDays: number): Instant {
  return new Date(Date.parse(publishedAt) + windowDays * DAY_MS).toISOString();
}

/** 是否还在申诉窗口内；到点即关闭（与"截止即关闭"的其他规则一致）。 */
export function canFileAppeal(publishedAt: Instant, windowDays: number, now: Instant): { ok: true; deadlineAt: Instant } | { ok: false; code: "APPEAL_WINDOW_CLOSED"; message: string; deadlineAt: Instant } {
  const deadlineAt = appealDeadline(publishedAt, windowDays);
  if (Date.parse(now) >= Date.parse(deadlineAt)) return { ok: false, code: "APPEAL_WINDOW_CLOSED", deadlineAt,
    message: `本版结果的申诉已于 ${deadlineAt} 截止（公布后 ${windowDays} 天）。如仍有疑问，请通过站内消息联系主办方。` };
  return { ok: true, deadlineAt };
}

export function appealReason(value: unknown): string { return text(value, "申诉理由", 4000); }
export function appealRequestedOutcome(value: unknown): string { return text(value ?? "", "希望的处理结果", 1000, true); }
export function appealIdempotencyKey(value: unknown): string { return text(value, "申诉重试标识", 120); }

export function resolutionOf(value: unknown): AppealResolutionInput["decision"] {
  const decision = typeof value === "string" ? value : "";
  if (!(appealDecisions as readonly string[]).includes(decision)) invalid("请选择受理、不受理或已处理。");
  return decision as AppealResolutionInput["decision"];
}

/** 只有"待主办方处理"的申诉可以被处理或撤回；其他状态保持既有结论。 */
export function isOpenAppeal(appeal: ResultAppeal): boolean { return appeal.status === "submitted"; }

export function resolveAppeal(appeal: ResultAppeal, decision: AppealResolutionInput["decision"], note: string, by: EntityId, at: Instant): ResultAppeal {
  if (!isOpenAppeal(appeal)) invalid("这条申诉已经处理过，请刷新后查看最新状态。");
  return { ...appeal, revision: appeal.revision + 1, status: decision, resolvedBy: by, resolvedAt: at, decisionNote: note };
}

export function withdrawAppeal(appeal: ResultAppeal, at: Instant): ResultAppeal {
  if (!isOpenAppeal(appeal)) invalid("只有待处理的申诉可以由本人撤回。");
  return { ...appeal, revision: appeal.revision + 1, status: "withdrawn", resolvedAt: at };
}

/** 从已公布结果里找出"这个人所属队伍"的那一行，用于校验申诉人资格。 */
export function ownRow(published: PublishedResults, snapshotIds: readonly EntityId[]): { snapshotId: EntityId; teamId: EntityId; title: string } | null {
  const row = published.rows.find(item => snapshotIds.includes(item.snapshotId));
  return row ? { snapshotId: row.snapshotId, teamId: row.teamId, title: row.title } : null;
}
