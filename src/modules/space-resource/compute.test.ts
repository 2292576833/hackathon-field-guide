/**
 * `space-resource` 纯计算的行为测试（node:test）。
 *
 * 覆盖重点：UTC 时区无关、恰好到点的边界、未核验标记原样保留、缺数据不用 0 冒充、
 * 非法输入安全拒绝、不产生完成百分比。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computePhase, computeSpaceResource, isValidUtcInstant, parseUtcInstant } from "./compute.ts";
import type { SpaceDeadlineInput, SpaceResourceInput, SpaceResourceOutcome } from "./model.ts";

const NOW = "2026-10-12T09:00:00.000Z";

function deadline(overrides: Partial<SpaceDeadlineInput> & { id: string; instantUtc: string }): SpaceDeadlineInput {
  return {
    label: overrides.label ?? `截止 ${overrides.id}`,
    sourceText: overrides.sourceText ?? "官方页面原文",
    verified: overrides.verified ?? true,
    kind: overrides.kind ?? null,
    ...overrides,
  };
}

function compute(input: SpaceResourceInput): SpaceResourceOutcome {
  return computeSpaceResource(input);
}

function resultOf(input: SpaceResourceInput) {
  const outcome = compute(input);
  assert.equal(outcome.ok, true, `应当可计算：${JSON.stringify(outcome)}`);
  assert.ok(outcome.ok);
  return outcome.result;
}

test("UTC 解析：接受 Z 与显式偏移，并归一到同一瞬间", () => {
  assert.deepEqual(parseUtcInstant("2026-10-12T09:00:00.000Z"), {
    iso: "2026-10-12T09:00:00.000Z",
    epochMs: Date.UTC(2026, 9, 12, 9, 0, 0, 0),
  });
  assert.equal(parseUtcInstant("2026-10-12T11:00:00+02:00")?.iso, "2026-10-12T09:00:00.000Z");
  assert.equal(parseUtcInstant("2026-10-12T04:00:00-05:00")?.iso, "2026-10-12T09:00:00.000Z");
  assert.equal(parseUtcInstant("2026-10-12T09:00Z")?.iso, "2026-10-12T09:00:00.000Z");
  assert.equal(parseUtcInstant("  2026-10-12T09:00:00Z  ")?.iso, "2026-10-12T09:00:00.000Z");
  assert.equal(isValidUtcInstant("2026-10-12T09:00:00.5Z"), true);
});

test("UTC 解析：拒绝缺少时区标记、日历上不存在的日期与非法值", () => {
  const bad = [
    "2026-10-12T09:00:00",
    "2026-10-12",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-10-32T00:00:00Z",
    "2026-10-12T24:00:00Z",
    "2026-10-12T09:60:00Z",
    "2026-10-12T09:00:61Z",
    "2026-10-12T09:00:00+24:00",
    "2026-10-12T09:00:00+02:60",
    "not-a-date",
    "",
    "   ",
  ];
  for (const value of bad) {
    assert.equal(parseUtcInstant(value), null, `应当拒绝：${value}`);
    assert.equal(isValidUtcInstant(value), false, `应当拒绝：${value}`);
  }
  assert.equal(parseUtcInstant(undefined), null);
  assert.equal(parseUtcInstant(null), null);
  assert.equal(parseUtcInstant(1_760_000_000_000), null);
  assert.equal(parseUtcInstant(new Date()), null);
});

test("同一瞬间的三种写法给出相同倒计时，且回显规范化 UTC 时刻", () => {
  const base = { now: NOW, deadlines: [] as const };
  const withZ = resultOf({
    ...base,
    deadlines: [deadline({ id: "d", instantUtc: "2026-10-13T09:00:00.000Z" })],
  });
  const withPlus = resultOf({
    ...base,
    deadlines: [deadline({ id: "d", instantUtc: "2026-10-13T11:00:00+02:00" })],
  });
  const withMinus = resultOf({
    ...base,
    deadlines: [deadline({ id: "d", instantUtc: "2026-10-13T04:00:00-05:00" })],
  });
  assert.equal(withZ.next?.remainingMs, 86_400_000);
  assert.equal(withPlus.next?.remainingMs, 86_400_000);
  assert.equal(withMinus.next?.remainingMs, 86_400_000);
  assert.equal(withZ.next?.at, "2026-10-13T09:00:00.000Z");
  assert.equal(withPlus.next?.at, "2026-10-13T09:00:00.000Z");
  assert.equal(withMinus.next?.at, "2026-10-13T09:00:00.000Z");
  assert.equal(withZ.now, NOW);
});

test("跨时区：偏移描述同一瞬间时结果完全一致，不同瞬间则不同", () => {
  const sameInstant = resultOf({
    now: "2026-10-12T18:00:00+09:00",
    deadlines: [deadline({ id: "s", instantUtc: "2026-10-13T00:00:00Z" })],
  });
  assert.equal(sameInstant.now, NOW);
  assert.equal(sameInstant.next?.remainingMs, 15 * 3_600_000);

  const laterInstant = resultOf({
    now: "2026-10-12T18:00:00+00:00",
    deadlines: [deadline({ id: "s", instantUtc: "2026-10-13T00:00:00Z" })],
  });
  assert.equal(laterInstant.next?.remainingMs, 6 * 3_600_000);
  assert.notEqual(sameInstant.next?.remainingMs, laterInstant.next?.remainingMs);
});

test("恰好等于 now：算已到点、未过期，remainingMs 为 0 且不进 overdue", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "exact", instantUtc: "2026-10-12T09:00:00.000Z", label: "开赛" })],
  });
  assert.equal(result.next?.id, "exact");
  assert.equal(result.next?.remainingMs, 0);
  assert.deepEqual(result.overdue, []);
  assert.equal(result.deadlineCount, 1);
});

test("相差 1 毫秒：前一毫秒算过期，后一毫秒算还剩 1 毫秒", () => {
  const before = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "past", instantUtc: "2026-10-12T08:59:59.999Z" })],
  });
  assert.equal(before.next, undefined);
  assert.deepEqual(before.overdue.map(item => item.id), ["past"]);

  const after = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "future", instantUtc: "2026-10-12T09:00:00.001Z" })],
  });
  assert.equal(after.next?.remainingMs, 1);
  assert.deepEqual(after.overdue, []);
});

test("next 取最早未过期项；overdue 按时间升序且带原始标记", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "c", instantUtc: "2026-10-20T09:00:00Z" }),
      deadline({ id: "a", instantUtc: "2026-10-01T09:00:00Z", verified: false, sourceText: "选手群转发，未经核验" }),
      deadline({ id: "b", instantUtc: "2026-10-15T09:00:00Z" }),
      deadline({ id: "b2", instantUtc: "2026-10-05T09:00:00Z", verified: false, sourceText: "截图转述" }),
    ],
  });
  assert.equal(result.next?.id, "b");
  assert.deepEqual(result.overdue.map(item => item.id), ["a", "b2"]);
  assert.deepEqual(result.overdue.map(item => item.verified), [false, false]);
  assert.equal(result.overdue[0].sourceText, "选手群转发，未经核验");
  assert.equal(result.deadlineCount, 4);
});

test("verified: false 全程原样保留，绝不被提升为官方确认", () => {
  const unverified: SpaceDeadlineInput = deadline({
    id: "rumor",
    instantUtc: "2026-11-01T00:00:00Z",
    verified: false,
    sourceText: "社区帖子里说 11 月 1 日截止，未见官方页面",
  });
  const { next } = resultOf({ now: NOW, deadlines: [unverified] });
  assert.equal(next?.verified, false);
  assert.equal(next?.sourceText, unverified.sourceText);
  assert.equal(next?.label, unverified.label);

  const overdueView = resultOf({
    now: NOW,
    deadlines: [{ ...unverified, instantUtc: "2026-09-01T00:00:00Z" }],
  }).overdue[0];
  assert.equal(overdueView.verified, false);
  assert.equal(overdueView.sourceText, unverified.sourceText);
});

test("verified 缺省或非布尔时按未核验处理", () => {
  const missing = resultOf({
    now: NOW,
    deadlines: [
      { id: "x", label: "截止", instantUtc: "2026-11-01T00:00:00Z", sourceText: "原文" } as SpaceDeadlineInput,
    ],
  });
  assert.equal(missing.next?.verified, false);
});

test("没有任何未来截止时 next 为 undefined，不用 0 冒充", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "a", instantUtc: "2026-10-01T00:00:00Z", kind: "other" }),
      deadline({ id: "b", instantUtc: "2026-10-11T00:00:00Z", kind: "other" }),
    ],
  });
  assert.equal(result.next, undefined);
  assert.equal("next" in result, false);
  assert.equal(result.overdue.length, 2);
  assert.equal(result.phase, "after");
  assert.equal(result.phaseBasis, "after_latest");
});

test("全部截止未分类且已过期：next 仍为 undefined，phase 不猜成赛后", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "a", instantUtc: "2026-10-01T00:00:00Z" }),
      deadline({ id: "b", instantUtc: "2026-10-11T00:00:00Z" }),
    ],
  });
  assert.equal(result.next, undefined);
  assert.equal(result.overdue.length, 2);
  assert.equal(result.phase, "unknown");
  assert.deepEqual(result.unclassifiedDeadlineIds, ["a", "b"]);
});

test("没有截止数据：next 与 phase 都不猜，issues 说明缺什么", () => {
  const result = resultOf({ now: NOW, deadlines: [] });
  assert.equal(result.next, undefined);
  assert.equal(result.phase, "unknown");
  assert.equal(result.phaseBasis, "no_deadline");
  assert.equal(result.phaseLabel, "时间未知");
  assert.equal(result.deadlineCount, 0);
  assert.deepEqual(result.skippedDeadlines, []);
  assert.deepEqual(result.issues.map(item => item.reason), ["no_deadlines"]);
});

test("缺预算返回 undefined，绝不回落为 0", () => {
  const result = resultOf({ now: NOW, deadlines: [deadline({ id: "d", instantUtc: "2026-11-01T00:00:00Z" })] });
  assert.equal(result.budget, undefined);
  assert.equal("budget" in result, false);
});

test("预算正常：remainingMicros 为差额，over 为 false", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "d", instantUtc: "2026-11-01T00:00:00Z" })],
    budget: { totalMicros: 5_000_000, usedMicros: 1_250_000 },
  });
  assert.deepEqual(result.budget, {
    totalMicros: 5_000_000,
    usedMicros: 1_250_000,
    remainingMicros: 3_750_000,
    over: false,
  });
  assert.deepEqual(result.issues, []);
});

test("预算超额：remainingMicros 为负数并标记 over，不夹到 0", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "d", instantUtc: "2026-11-01T00:00:00Z" })],
    budget: { totalMicros: 1_000_000, usedMicros: 1_750_000 },
  });
  assert.equal(result.budget?.remainingMicros, -750_000);
  assert.equal(result.budget?.over, true);
});

test("预算非法：按缺数据处理并记录 issue，不产出 NaN 或 0", () => {
  const invalidValues = [
    { totalMicros: -1, usedMicros: 0 },
    { totalMicros: 1.5, usedMicros: 0 },
    { totalMicros: Number.NaN, usedMicros: 0 },
    { totalMicros: Number.POSITIVE_INFINITY, usedMicros: 0 },
    { totalMicros: 1_000, usedMicros: -5 },
  ];
  for (const budget of invalidValues) {
    const result = resultOf({
      now: NOW,
      deadlines: [deadline({ id: "d", instantUtc: "2026-11-01T00:00:00Z" })],
      budget,
    });
    assert.equal(result.budget, undefined, JSON.stringify(budget));
    assert.ok(result.issues.some(item => item.reason === "invalid_budget"), JSON.stringify(budget));
  }
});

test("阶段：赛前 / 赛中 / 赛后 及边界", () => {
  const deadlines: SpaceDeadlineInput[] = [
    deadline({ id: "reg", instantUtc: "2026-10-12T00:00:00Z", kind: "registration", label: "报名截止" }),
    deadline({ id: "start", instantUtc: "2026-10-16T00:00:00Z", kind: "start", label: "开赛" }),
    deadline({ id: "submit", instantUtc: "2026-10-25T00:00:00Z", kind: "submission", label: "提交截止" }),
  ];

  const before = resultOf({ now: "2026-10-10T00:00:00Z", deadlines });
  assert.equal(before.phase, "before");
  assert.equal(before.phaseBasis, "before_start");
  assert.equal(before.phaseLabel, "赛前");

  // 报名截止刚过、还没开赛：仍算赛前（报名关闸不等于开赛）。
  const afterReg = resultOf({ now: "2026-10-13T00:00:00Z", deadlines });
  assert.equal(afterReg.phase, "before");
  assert.deepEqual(afterReg.overdue.map(item => item.id), ["reg"]);

  // 恰好等于开赛时刻：算赛中。
  const exactStart = resultOf({ now: "2026-10-16T00:00:00Z", deadlines });
  assert.equal(exactStart.phase, "during");
  assert.equal(exactStart.phaseBasis, "during_after_start");

  const during = resultOf({ now: "2026-10-20T00:00:00Z", deadlines });
  assert.equal(during.phase, "during");

  // 恰好等于提交截止：仍未过点，算赛中。
  const exactSubmit = resultOf({ now: "2026-10-25T00:00:00Z", deadlines });
  assert.equal(exactSubmit.phase, "during");

  const after = resultOf({ now: "2026-10-25T00:00:00.001Z", deadlines });
  assert.equal(after.phase, "after");
  assert.equal(after.phaseBasis, "after_submission");
  assert.equal(after.phaseLabel, "赛后");
});

test("阶段：没有开赛时刻但有提交截止，只在过期后判赛后并对依据留痕", () => {
  const deadlines: SpaceDeadlineInput[] = [
    deadline({ id: "submit", instantUtc: "2026-10-25T00:00:00Z", kind: "submission" }),
  ];
  const during = resultOf({ now: NOW, deadlines });
  assert.equal(during.phase, "during");

  const after = resultOf({ now: "2026-10-26T00:00:00Z", deadlines });
  assert.equal(after.phase, "after");
  assert.equal(after.phaseBasis, "after_submission");

  const beforeNoSubmission = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "reg", instantUtc: "2026-11-01T00:00:00Z", kind: "registration" })],
  });
  assert.equal(beforeNoSubmission.phase, "before");
});

test("阶段：只有开赛时刻时无法判定，返回 unknown 而不是赛前", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "start", instantUtc: "2026-10-16T00:00:00Z", kind: "start" })],
  });
  assert.equal(result.phase, "unknown");
  assert.equal(result.phaseBasis, "no_deadline");
  assert.equal(result.next?.id, "start");
});

test("阶段：未分类截止参与倒计时但不参与阶段边界", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "u1", instantUtc: "2026-10-30T00:00:00Z" }),
      deadline({ id: "u2", instantUtc: "2026-10-14T00:00:00Z" }),
    ],
  });
  assert.equal(result.phase, "unknown");
  assert.deepEqual(result.unclassifiedDeadlineIds, ["u1", "u2"]);
  assert.equal(result.next?.id, "u2");
  assert.equal(result.deadlineCount, 2);
});

test("computePhase 独立可调用，边界收在函数契约上", () => {
  const midnight = Date.UTC(2026, 9, 16);
  assert.deepEqual(computePhase(midnight, []), { phase: "unknown", basis: "no_deadline" });
  const classified = [
    { kind: "start" as const, epochMs: midnight },
    { kind: "submission" as const, epochMs: Date.UTC(2026, 9, 25) },
  ];
  assert.equal(computePhase(midnight - 1, classified).phase, "before");
  assert.equal(computePhase(midnight, classified).phase, "during");
  assert.equal(computePhase(midnight, classified).basis, "during_after_start");
  assert.equal(computePhase(Date.UTC(2026, 9, 25), classified).phase, "during");
  assert.equal(computePhase(Date.UTC(2026, 9, 25) + 1, classified).phase, "after");
});

test("非法截止时刻被安全拒绝：不抛异常、不产出 NaN，并列入 skippedDeadlines", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "ok", instantUtc: "2026-11-01T00:00:00Z" }),
      deadline({ id: "bad", instantUtc: "2026-11-31T00:00:00Z", label: "来源不明" }),
      deadline({ id: "bad2", instantUtc: "2026-11-01T00:00:00", verified: false }),
    ],
  });
  assert.equal(result.next?.id, "ok");
  assert.equal(result.next?.remainingMs, Date.UTC(2026, 10, 1) - Date.UTC(2026, 9, 12, 9));
  assert.ok(Number.isFinite(result.next?.remainingMs ?? Number.NaN));
  assert.deepEqual(result.skippedDeadlines.map(item => [item.id, item.reason]), [
    ["bad", "invalid_instant"],
    ["bad2", "invalid_instant"],
  ]);
  assert.equal(result.deadlineCount, 1);
});

test("重复 ID 只保留第一个并记录冲突，保证 next/overdue 不自相矛盾", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "dup", instantUtc: "2026-10-01T00:00:00Z" }),
      deadline({ id: "dup", instantUtc: "2026-11-01T00:00:00Z" }),
    ],
  });
  assert.equal(result.deadlineCount, 1);
  assert.deepEqual(result.overdue.map(item => item.id), ["dup"]);
  assert.equal(result.next, undefined);
  assert.deepEqual(result.skippedDeadlines.map(item => item.reason), ["duplicate_id"]);
});

test("整体非法输入返回 ok: false，不抛未处理异常", () => {
  const invalidNow = compute({ now: "2026-10-12T09:00:00", deadlines: [] });
  assert.equal(invalidNow.ok, false);
  assert.ok(!invalidNow.ok);
  assert.deepEqual(invalidNow.issues.map(item => item.reason), ["invalid_now"]);

  const notObject = compute(null as unknown as SpaceResourceInput);
  assert.equal(notObject.ok, false);

  const noDeadlinesArray = compute({ now: NOW, deadlines: null as unknown as readonly SpaceDeadlineInput[] });
  assert.equal(noDeadlinesArray.ok, false);
  assert.deepEqual(noDeadlinesArray.issues.map(item => item.reason), ["invalid_input"]);
});

test("纯函数：不改动输入对象，同输入同输出", () => {
  const input: SpaceResourceInput = {
    now: NOW,
    deadlines: [deadline({ id: "d", instantUtc: "2026-11-01T00:00:00Z", kind: "submission" })],
    budget: { totalMicros: 2_000_000, usedMicros: 500_000 },
  };
  const snapshot = JSON.stringify(input);
  const first = compute(input);
  const second = compute(input);
  assert.ok(first.ok);
  assert.ok(second.ok);
  assert.deepEqual(first.result, second.result);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(Object.isFrozen(input.deadlines), false);
});

test("输出不包含完成状态或百分比字段", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [deadline({ id: "d", instantUtc: "2026-11-01T00:00:00Z", kind: "submission" })],
    budget: { totalMicros: 2_000_000, usedMicros: 500_000 },
  });
  const keys = Object.keys(result);
  for (const forbidden of ["percent", "percentage", "progress", "completion", "completed", "done", "ratio"]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  const text = JSON.stringify(result).toLowerCase();
  for (const forbidden of ["percent", "progress", "completion", "完成率", "百分比"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test("倒计时数值只用整数毫秒，负数只出现在 overdue 之外的语义里", () => {
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "past", instantUtc: "2026-10-12T08:00:00Z" }),
      deadline({ id: "future", instantUtc: "2026-10-12T10:00:00Z" }),
    ],
  });
  assert.equal(result.next?.remainingMs, 3_600_000);
  assert.ok(Number.isInteger(result.next?.remainingMs));
  assert.equal(result.budget, undefined);
  const overdueKeys = Object.keys(result.overdue[0]);
  assert.equal(overdueKeys.includes("remainingMs"), false);
});

test("顺序无关：打乱输入顺序不改变倒计时结果", () => {
  const items: SpaceDeadlineInput[] = [
    deadline({ id: "a", instantUtc: "2026-10-13T09:00:00Z", kind: "registration" }),
    deadline({ id: "b", instantUtc: "2026-10-11T09:00:00Z", kind: "other" }),
    deadline({ id: "c", instantUtc: "2026-10-18T09:00:00Z", kind: "start" }),
    deadline({ id: "d", instantUtc: "2026-10-25T09:00:00Z", kind: "submission" }),
  ];
  const forward = resultOf({ now: NOW, deadlines: items });
  const reversed = resultOf({ now: NOW, deadlines: [...items].reverse() });
  assert.deepEqual(forward, reversed);
});

test("同一天不同偏移的截止按瞬间排序，不按字符串排序", () => {
  // 字符串序里 "2026-10-13T01:00:00+09:00" 与真实瞬间无关；这里必须按瞬间比较。
  const result = resultOf({
    now: NOW,
    deadlines: [
      deadline({ id: "later", instantUtc: "2026-10-13T01:00:00+09:00" }),
      deadline({ id: "sooner", instantUtc: "2026-10-12T20:00:00Z" }),
    ],
  });
  assert.equal(result.next?.id, "sooner");
  assert.equal(result.next?.remainingMs, 11 * 3_600_000);
});
