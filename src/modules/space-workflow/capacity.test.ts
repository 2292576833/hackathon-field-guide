// 容量对照（规划31 第1.5项）：纯派生、不出百分比、事实不足时不比较。
import assert from "node:assert/strict";
import test from "node:test";
import { buildMemberCapacity, describeMinutes } from "./capacity.ts";

const members = [{ membershipId: "m1", name: "小林" }, { membershipId: "m2", name: "小陈" }];
const task = (over: Record<string, unknown> = {}) => ({ ownerMembershipId: "m1", status: "todo",
  remainingEstimate: { likelyMinutes: 120 }, durationEstimate: { likelyMinutes: 60 }, ...over });

test("把剩余工作量与可用时间并排给出（只做减法，不给结论）", () => {
  const view = buildMemberCapacity({ members, tasks: [task({ remainingEstimate: { likelyMinutes: 40 } })], capacityMinutes: { m1: 120, m2: 240 } });
  assert.equal(view.state, "ready");
  const lin = view.rows.find(row => row.membershipId === "m1")!;
  assert.equal(lin.remainingMinutes, 40);
  assert.equal(lin.capacityMinutes, 120);
  // 不得出现任何百分比或完成度字段
  assert.deepEqual(Object.keys(lin).sort(), ["capacityMinutes", "membershipId", "name", "remainingMinutes"]);
});

test("优先用本人更新过的剩余工时；没有才退回原始估算", () => {
  const fallback = buildMemberCapacity({ members, tasks: [task({ remainingEstimate: null })], capacityMinutes: { m1: 100 } });
  assert.equal(fallback.rows.find(row => row.membershipId === "m1")!.remainingMinutes, 60, "应退回 durationEstimate");
  const prefer = buildMemberCapacity({ members, tasks: [task({ remainingEstimate: { likelyMinutes: 33 } })], capacityMinutes: { m1: 100 } });
  assert.equal(prefer.rows.find(row => row.membershipId === "m1")!.remainingMinutes, 33);
});

test("只统计未结算的任务；已取消与已完成不计入剩余工作量", () => {
  const view = buildMemberCapacity({ members,
    tasks: [task({ status: "cancelled", remainingEstimate: { likelyMinutes: 999 } }), task({ status: "done", remainingEstimate: { likelyMinutes: 999 } }), task({ status: "in_progress", remainingEstimate: { likelyMinutes: 25 } })],
    capacityMinutes: { m1: 100 } });
  assert.equal(view.rows.find(row => row.membershipId === "m1")!.remainingMinutes, 25);
});

test("事实不足时不比较：计划依据变化、没有排程、没有成员", () => {
  const stale = buildMemberCapacity({ members, tasks: [task()], capacityMinutes: { m1: 100 }, staleInputs: true });
  assert.equal(stale.state, "unknown");
  assert.match(stale.notice, /依据已变化/);
  assert.deepEqual(stale.rows, [], "依据不足时不得给出可能被误读的数字");
  const noSchedule = buildMemberCapacity({ members, tasks: [task()], capacityMinutes: {} });
  assert.equal(noSchedule.state, "unknown");
  assert.match(noSchedule.notice, /排程/);
  const noMembers = buildMemberCapacity({ members: [], tasks: [], capacityMinutes: { m1: 10 } });
  assert.equal(noMembers.state, "unknown");
});

test("缺少可用时间的成员留空而不是当成 0，并说清有几个人缺", () => {
  const view = buildMemberCapacity({ members, tasks: [task()], capacityMinutes: { m1: 120 } });
  const chen = view.rows.find(row => row.membershipId === "m2")!;
  assert.equal(chen.capacityMinutes, null, "缺数据必须是 null，不能是 0");
  assert.match(view.notice, /1 位成员/, "要说明有几个人缺记录");
  assert.match(view.notice, /不代表时间是 0/);
});

test("非法可用时间（NaN/负无穷等）不进入对照", () => {
  const view = buildMemberCapacity({ members, tasks: [], capacityMinutes: { m1: Number.NaN, m2: 60 } });
  assert.equal(view.rows.find(row => row.membershipId === "m1")!.capacityMinutes, null);
  assert.equal(view.rows.find(row => row.membershipId === "m2")!.capacityMinutes, 60);
});

test("分钟说成人话：不产生百分比", () => {
  assert.equal(describeMinutes(0), "0 分钟");
  assert.equal(describeMinutes(45), "45 分钟");
  assert.equal(describeMinutes(120), "2 小时");
  assert.equal(describeMinutes(150), "2 小时 30 分钟");
  assert.equal(describeMinutes(null), "未记录");
  assert.ok(!describeMinutes(150).includes("%"));
});

test("投影不修改输入", () => {
  const input = { members, tasks: [task()], capacityMinutes: { m1: 120 } };
  const before = structuredClone(input);
  buildMemberCapacity(input);
  assert.deepEqual(input, before);
});
