import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { JudgingConfig, ResultAppeal } from "./model.ts";
import { appealDeadline, appealWindowDays, canFileAppeal, defaultAppealWindowDays, isOpenAppeal, ownRow, resolutionOf, resolveAppeal, withdrawAppeal } from "./appeal.ts";

const config = (appealWindowDays?: number): JudgingConfig => ({ title: "决赛", criteria: [{ id: "idea", label: "想法", weight: 100, min: 0, max: 10 }],
  minJudges: 1, missingPolicy: "exclude_incomplete", tiePolicy: "shared_rank", ...(appealWindowDays === undefined ? {} : { appealWindowDays }) });
const publishedAt = "2026-10-15T00:00:00.000Z";
const appeal = (overrides: Partial<ResultAppeal> = {}): ResultAppeal => ({ id: "appeal-1", organizationId: "org", eventId: "A", roundId: "round", publishedResultId: "result-1",
  resultVersion: 1, teamId: "team-a", snapshotId: "receipt-1", authorUserId: "alice", revision: 1, status: "submitted", reason: "分数与我们收到的反馈不一致，希望核对第二位评委的评分。",
  requestedOutcome: "重新核对后给出说明", filedAt: publishedAt, deadlineAt: appealDeadline(publishedAt, 7), resolvedBy: null, resolvedAt: null, decisionNote: null, idempotencyKey: "key-1", ...overrides });
const failure = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

test("申诉时限默认 7 天，可按轮次配置并夹在 1–90 天内", () => {
  assert.equal(appealWindowDays(config()), defaultAppealWindowDays);
  assert.equal(appealWindowDays(config(14)), 14);
  // 非法或越界值回退到默认，而不是把窗口放成无限期。
  assert.equal(appealWindowDays(config(0)), defaultAppealWindowDays);
  assert.equal(appealWindowDays(config(365)), defaultAppealWindowDays);
});

test("窗口按公布时间计算：截止前一秒可提交，到点即关闭", () => {
  const windowDays = 7;
  assert.equal(appealDeadline(publishedAt, windowDays), "2026-10-22T00:00:00.000Z");
  const open = canFileAppeal(publishedAt, windowDays, "2026-10-21T23:59:59.000Z");
  assert.equal(open.ok, true);
  const closed = canFileAppeal(publishedAt, windowDays, "2026-10-22T00:00:00.000Z");
  assert.equal(closed.ok, false);
  if (!closed.ok) { assert.equal(closed.code, "APPEAL_WINDOW_CLOSED"); assert.match(closed.message, /已.*截止/); }
});

test("处理决定只接受受理、不受理、已处理", () => {
  assert.equal(resolutionOf("accepted"), "accepted");
  assert.equal(resolutionOf("rejected"), "rejected");
  assert.equal(resolutionOf("handled"), "handled");
  for (const invalid of ["withdrawn", "submitted", "", 42, null]) assert.throws(() => resolutionOf(invalid), failure("JUDGING_INVALID_INPUT"));
});

test("只有待处理的申诉可以被处理；处理后不能再次改写", () => {
  const open = appeal();
  assert.equal(isOpenAppeal(open), true);
  const resolved = resolveAppeal(open, "handled", "已核对第二位评委的评分记录，分数无误，说明已回复队伍。", "staff", "2026-10-16T00:00:00.000Z");
  assert.equal(resolved.status, "handled"); assert.equal(resolved.revision, 2);
  assert.equal(resolved.resolvedBy, "staff"); assert.equal(resolved.resolvedAt, "2026-10-16T00:00:00.000Z");
  assert.match(resolved.decisionNote!, /已回复队伍/);
  assert.throws(() => resolveAppeal(resolved, "accepted", "再改一次", "staff", "2026-10-17T00:00:00.000Z"), failure("JUDGING_INVALID_INPUT"));
  assert.throws(() => withdrawAppeal(resolved, "2026-10-17T00:00:00.000Z"), failure("JUDGING_INVALID_INPUT"));
});

test("提交人可以撤回答待处理的申诉，撤回后状态与版本保持可追溯", () => {
  const withdrawn = withdrawAppeal(appeal(), "2026-10-16T00:00:00.000Z");
  assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.revision, 2);
  assert.equal(withdrawn.reason, appeal().reason, "撤回不得改写原始理由");
});

test("只在已公布结果里属于本人队伍的那一行上建立申诉范围", () => {
  const published = { id: "result-1", rows: [
    { snapshotId: "receipt-1", teamId: "team-a", title: "作品甲", submittedJudgeCount: 2, missingJudges: 0, total: 80, rank: 1 },
    { snapshotId: "receipt-2", teamId: "team-b", title: "作品乙", submittedJudgeCount: 2, missingJudges: 0, total: 70, rank: 2 },
  ] } as unknown as Parameters<typeof ownRow>[0];
  assert.deepEqual(ownRow(published, ["receipt-2"]), { snapshotId: "receipt-2", teamId: "team-b", title: "作品乙" });
  assert.equal(ownRow(published, ["receipt-9"]), null, "不属于本人队伍的作品不能成为申诉对象");
});
