import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_OWNERS, AI_ACTION_KINDS, describeAiAction, isAiActionKind, parseAiAction } from "./ai-actions.ts";

test("只接受三个封闭 kind，白名单之外一律拒绝", () => {
  assert.equal(AI_ACTION_KINDS.length, 4);
  for (const kind of AI_ACTION_KINDS) assert.equal(isAiActionKind(kind), true);
  for (const bad of ["submit", "publish", "score", "", 1, null, undefined]) {
    assert.equal(isAiActionKind(bad), false);
    assert.equal(parseAiAction({ kind: bad, specialist: "enroll", title: "x" }), null);
  }
});

test("缺标题、标题过长、备注过长都整条丢弃", () => {
  assert.equal(parseAiAction({ kind: "plan_task", specialist: "enroll" }), null);
  assert.equal(parseAiAction({ kind: "plan_task", specialist: "enroll", title: "   " }), null);
  assert.equal(parseAiAction({ kind: "plan_task", specialist: "enroll", title: "x".repeat(121) }), null);
  assert.equal(parseAiAction({ kind: "plan_task", specialist: "enroll", title: "ok", note: "y".repeat(601) }), null);
  assert.deepEqual(parseAiAction({ kind: "plan_task", specialist: "enroll", title: "ok" }), { kind: "plan_task", specialist: "enroll", title: "ok" });
});

test("截止时间非法就当没有，不猜", () => {
  assert.deepEqual(parseAiAction({ kind: "plan_task", specialist: "enroll", title: "ok", dueAt: "明天" }), { kind: "plan_task", specialist: "enroll", title: "ok" });
  assert.deepEqual(parseAiAction({ kind: "plan_task", specialist: "enroll", title: "ok", dueAt: "2026-10-19T04:00:00Z" }), { kind: "plan_task", specialist: "enroll", title: "ok", dueAt: "2026-10-19T04:00:00.000Z" });
});

test("非对象输入返回 null，不抛异常", () => {
  for (const bad of [null, "plan_task", 42, [], true]) assert.equal(parseAiAction(bad), null);
});

test("描述文案只做展示，不改语义", () => {
  assert.equal(describeAiAction({ kind: "plan_task", specialist: "enroll", title: "交报名表", dueAt: "2026-10-19T04:00:00.000Z" }), "创建任务：交报名表（截止 2026-10-19 04:00）");
  assert.equal(describeAiAction({ kind: "retro_entry", specialist: "retro", title: "复盘" }), "写复盘条目：复盘");
});

test("专员只能提自己那一块的动嘴：越界一律拒绝", () => {
  assert.deepEqual(parseAiAction({ kind: "charter_fill", specialist: "space", title: "目标", charter: { goal: "跑通报名" } }), { kind: "charter_fill", specialist: "space", title: "目标", charter: { goal: "跑通报名", deliverables: [], nonGoals: [], timebox: "" } });
  assert.equal(parseAiAction({ kind: "charter_fill", specialist: "enroll", title: "目标" }), null);
  assert.equal(parseAiAction({ kind: "retro_entry", specialist: "teamup", title: "复盘" }), null);
  assert.equal(parseAiAction({ kind: "plan_task", specialist: "judging", title: "x" }), null);
  assert.equal(parseAiAction({ kind: "plan_task", specialist: "", title: "x" }), null);
  assert.deepEqual(ACTION_OWNERS.plan_task, ["enroll", "teamup", "submit"]);
});

test("charter_fill 必须带合法四栏，缺一栏就整条丢弃", () => {
  const ok = parseAiAction({ kind: "charter_fill", specialist: "space", title: "框架", charter: { goal: "跑通报名", deliverables: ["报名页"], nonGoals: ["支付"], timebox: "周六" } });
  assert.deepEqual(ok, { kind: "charter_fill", specialist: "space", title: "框架", charter: { goal: "跑通报名", deliverables: ["报名页"], nonGoals: ["支付"], timebox: "周六" } });
  assert.equal(parseAiAction({ kind: "charter_fill", specialist: "space", title: "框架" }), null);
  assert.equal(parseAiAction({ kind: "charter_fill", specialist: "space", title: "框架", charter: { goal: "" } }), null);
  assert.equal(parseAiAction({ kind: "charter_fill", specialist: "space", title: "框架", charter: { goal: "x", deliverables: "报名页" } }), null);
});
