// 队友状态（规划27 第1期）：只读派生、不显示排名与百分比、阻塞原因由本人写下。
import assert from "node:assert/strict";
import test from "node:test";
import { buildTeammateStatuses } from "./teammates.ts";

const now = "2026-10-12T04:00:00.000Z";
function project(over: Record<string, unknown> = {}) {
  return { id: "p1", name: "破壁者战队", teamId: null, eventId: "e1", createdBy: "u1", goal: "做一个工具", minimumDeliverable: "原型",
    stage: "active", timezone: "Asia/Shanghai", deadline: null, deadlineSource: "unknown", revision: 2, createdAt: now, updatedAt: now, ...over } as never;
}
function member(membershipId: string, userId: string, over: Record<string, unknown> = {}) {
  return { membershipId, projectId: "p1", userId, role: "member", status: "active", revision: 1, joinedAt: now, leftAt: null, ...over } as never;
}
const me = member("m1", "u1", { role: "manager", displayName: "我" });
const mate = member("m2", "u2", { displayName: "小队" });
function detail(members: unknown[] = [me, mate]) {
  return { project: project(), membership: me, members } as never;
}
function task(over: Record<string, unknown> = {}) {
  return { id: "t1", projectId: "p1", title: "完成首页原型", kind: "engineering", status: "todo", priority: "must",
    ownerMembershipId: "m2", reviewerMembershipId: null, dependencyTaskIds: [], deliverable: "可演示原型",
    acceptanceCriteria: ["能打开首页"], deadlineRef: "d1", blocker: null, acceptance: null, helperEfforts: [], revision: 1, ...over };
}
function plan(tasks: unknown[], over: Record<string, unknown> = {}) {
  return { plan: { id: "v1", projectId: "p1", version: 1, status: "applied", appliedAt: now, createdAt: now,
    inputSnapshot: { projectId: "p1", deadlines: [] } }, tasks, tasksRevision: 1, evaluation: { structuralValid: true, likely: { scheduled: [], issues: [] } },
    staleInputs: false, inputVersionsChanged: false, lastProgressAt: now, ...over } as never;
}
const intentions = (list: unknown[]) => ({ status: "ready", value: { projectId: "p1", projectRevision: 2, intentions: list } }) as never;

test("谁在做什么：进行中的任务归到对应队友", () => {
  const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "in_progress", ownerMembershipId: "m2" })]) });
  const found = view.teammates.find(item => item.membershipId === "m2")!;
  assert.equal(found.doing.length, 1);
  assert.equal(found.doing[0]!.title, "完成首页原型");
  assert.equal(found.blocked.length, 0);
  assert.equal(found.handingOff.length, 0);
});

test("等谁确认：队友交出、状态为待检查的任务列入 handingOff", () => {
  const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "review", ownerMembershipId: "m2" })]) });
  assert.equal(view.teammates.find(item => item.membershipId === "m2")!.handingOff.length, 1);
});

test("卡住了：阻塞任务带出队友本人写的说明；未写说明时不替他编造", () => {
  const withReason = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "blocked", ownerMembershipId: "m2", blocker: "缺接口文档" })]) });
  assert.equal(withReason.teammates.find(item => item.membershipId === "m2")!.blocked[0]!.reason, "缺接口文档");

  const noReason = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "blocked", ownerMembershipId: "m2", blocker: "  " })]) });
  assert.match(noReason.teammates.find(item => item.membershipId === "m2")!.blocked[0]!.reason, /还没有写明/);
});

test("计划未读取或输入变化时不猜队友在做什么，只给读取说明", () => {
  for (const current of [null, plan([task({ status: "in_progress" })], { inputVersionsChanged: true })]) {
    const view = buildTeammateStatuses({ detail: detail(), current });
    assert.ok(view.planningUnread, "应标记为未读取/需核对");
    for (const teammate of view.teammates) {
      assert.equal(teammate.doing.length, 0, "不能据旧结果说队友在做某件事");
      assert.equal(teammate.blocked.length, 0);
    }
  }
  const errored = buildTeammateStatuses({ detail: detail(), current: plan([]), planningError: "失败" });
  assert.match(errored.notice, /读取失败/);
});

test("本人主动共享后才有意愿与求助；未共享时为空，不推断", () => {
  const shared = buildTeammateStatuses({ detail: detail(), current: plan([]), intentions: intentions([
    { userId: "u2", revision: 1, membershipRevision: 1, updatedAt: now, duties: ["开发", "设计"], helpQuestion: "帮我看看接口设计" },
  ]) });
  const mateShared = shared.teammates.find(item => item.membershipId === "m2")!;
  assert.deepEqual(mateShared.duties, ["开发", "设计"]);
  assert.equal(mateShared.helpQuestion, "帮我看看接口设计");

  const unshared = buildTeammateStatuses({ detail: detail(), current: plan([]), intentions: { status: "unread" } as never });
  const mateUnshared = unshared.teammates.find(item => item.membershipId === "m2")!;
  assert.deepEqual(mateUnshared.duties, []);
  assert.equal(mateUnshared.helpQuestion, "");
});

test("只列出活跃成员；已离开的成员不出现", () => {
  const view = buildTeammateStatuses({ detail: detail([me, mate, member("m3", "u3", { status: "left" })]), current: plan([]) });
  assert.deepEqual(view.teammates.map(item => item.membershipId).sort(), ["m1", "m2"]);
});

test("不产生排名或完成百分比字段", () => {
  const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "in_progress" })]) });
  for (const teammate of view.teammates) {
    for (const banned of ["percent", "score", "rank", "completion"]) {
      assert.ok(!(banned in teammate), `${banned} 不应出现在队友状态里`);
    }
  }
});

test("已通过检查的任务计入 checkedCount 且不再列为doing或handingOff", () => {
  const accepted = task({ status: "done", ownerMembershipId: "m2", acceptance: { acceptedByUserId: "u1", acceptedAt: now, mode: "reviewer", evidenceRefs: ["https://example.com/pr"], note: "" } });
  const view = buildTeammateStatuses({ detail: detail(), current: plan([accepted]) });
  const found = view.teammates.find(item => item.membershipId === "m2")!;
  assert.equal(found.checkedCount, 1);
  assert.equal(found.doing.length, 0);
  assert.equal(found.handingOff.length, 0, "已通过检查的不该再等人检查");
});

test("本人和新加入的活跃成员同样列出，离开和外部空间成员排除", () => {
  const members = [me, mate, member("new", "u3"), member("left", "u4", { status: "left" }), member("foreign", "u5", { projectId: "elsewhere" })];
  const view = buildTeammateStatuses({ detail: detail(members), current: plan([]) });
  assert.deepEqual(view.teammates.map(item => item.membershipId), ["m1", "m2", "new"]);
  assert.equal(view.teammates[0]!.label, "暂无安排");
});

test("已确认没有计划不同于未知、草案、过期或错误空间的计划", () => {
  const empty = buildTeammateStatuses({ detail: detail(), current: plan([], { plan: null }) });
  assert.equal(empty.planningUnread, false); assert.ok(empty.teammates.every(item => item.status === "unassigned"));
  const basis = plan([task({ status: "in_progress" })]) as unknown as Record<string, unknown>;
  for (const current of [null, { ...basis, plan: { ...(basis.plan as object), status: "ready" } }, { ...basis, plan: { ...(basis.plan as object), projectId: "p2" } },
    { ...basis, plan: { ...(basis.plan as object), inputSnapshot: { projectId: "p2" } } }, { ...basis, inputVersionsChanged: true }]) {
    const view = buildTeammateStatuses({ detail: detail(), current: current as never });
    assert.equal(view.planningUnread, true); assert.ok(view.teammates.every(item => item.label === "状态待核对"));
    assert.ok(view.teammates.every(item => item.doing.length === 0));
  }
});

test("待开始、正在做、成果待检查与有效检查记录分别显示", () => {
  for (const [status, label] of [["todo", "待开始"], ["in_progress", "正在做"], ["review", "成果待检查"], ["done", "成果待检查"]]) {
    const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status })]) });
    assert.equal(view.teammates[1]!.label, label);
  }
  const check = { acceptedByUserId: "u1", acceptedAt: now, mode: "manager", evidenceRefs: ["演示.pptx 第3版"], note: "已播放检查" };
  assert.equal(buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "done", acceptance: check })]) }).teammates[1]!.label, "已有检查记录");
  assert.equal(buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "done", acceptance: { ...check, acceptedAt: "invalid" } })]) }).teammates[1]!.label, "成果待检查");
});

test("任务记录优先级不制造在线状态；主动求助不同于任务阻塞", () => {
  const shared = intentions([{ userId: "u2", membershipRevision: 1, duties: [], helpQuestion: "帮忙看设计稿" }]);
  assert.equal(buildTeammateStatuses({ detail: detail(), current: plan([]), intentions: shared }).teammates[1]!.status, "help");
  const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "in_progress" }), task({ id: "t2", status: "review" }), task({ id: "t3", status: "blocked" })]), intentions: shared });
  assert.equal(view.teammates[1]!.label, "遇到问题");
  for (const item of view.teammates) for (const key of ["online", "offline", "lastSeen", "workingHours"]) assert.ok(!(key in item));
});

test("其他空间或旧成员版本的共享职责与求助不进入当前状态", () => {
  const shared = { projectId: "p2", projectRevision: 1, intentions: [{ userId: "u2", membershipRevision: 1, duties: ["design"], helpQuestion: "别的空间" }] };
  for (const value of [shared, { ...shared, projectId: "p1", intentions: [{ ...shared.intentions[0], membershipRevision: 0 }] }]) {
    const view = buildTeammateStatuses({ detail: detail(), current: plan([]), intentions: { status: "ready", value } as never });
    assert.deepEqual(view.teammates[1]!.duties, []); assert.equal(view.teammates[1]!.helpQuestion, "");
  }
});

test("失败、读取中与取消任务不把旧结果显示为当前工作", () => {
  for (const extra of [{ planningLoading: true }, { planningError: new Error("读取失败") }]) {
    const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "in_progress" })]), ...extra });
    assert.equal(view.teammates[1]!.status, "unknown"); assert.equal(view.teammates[1]!.doing.length, 0);
  }
  const view = buildTeammateStatuses({ detail: detail(), current: plan([task({ status: "cancelled" }), task({ id: "other", projectId: "p2", status: "in_progress" })]) });
  assert.equal(view.teammates[1]!.status, "unassigned");
});

test("状态投影不修改项目、成员、计划或共享意愿", () => {
  const input = { detail: detail(), current: plan([task({ status: "in_progress" })]), intentions: intentions([{ userId: "u2", membershipRevision: 1, duties: ["design"] }]) };
  const before = structuredClone(input); buildTeammateStatuses(input); assert.deepEqual(input, before);
});

test("协助者不再隐身：本人不是负责人但参与协助时列为协助，而不是「暂无安排」", () => {
  // 任务负责人是 m2，协助者是 m1（我）。此前只看负责人，协助者完全看不到。
  const view = buildTeammateStatuses({ detail: detail(), current: plan([
    task({ status: "in_progress", ownerMembershipId: "m2", helperEfforts: [{ membershipId: "m1", durationEstimate: { minutes: 60 } }] }),
  ]) });
  const mine = view.teammates.find(item => item.membershipId === "m1")!;
  assert.deepEqual(mine.helping.map(item => item.id), ["t1"], "协助任务应出现在协助清单里");
  assert.equal(mine.status, "helping", "纯协助者的状态应是「正在协助」，不再是「暂无安排」");
  assert.equal(mine.label, "正在协助");
  assert.equal(mine.doing.length, 0, "协助不等于自己负责的在办任务");
});

test("协助不与负责人重复计算：负责人同时被记为协助者时只算自己负责的那份", () => {
  const view = buildTeammateStatuses({ detail: detail(), current: plan([
    task({ status: "in_progress", ownerMembershipId: "m2", helperEfforts: [{ membershipId: "m2", durationEstimate: { minutes: 30 } }] }),
  ]) });
  const mateStatus = view.teammates.find(item => item.membershipId === "m2")!;
  assert.deepEqual(mateStatus.doing.map(item => item.id), ["t1"]);
  assert.deepEqual(mateStatus.helping, [], "负责人不应在协助清单里重复出现");
  assert.equal(mateStatus.status, "doing");
});

test("计划未读取或输入变化时，协助清单同样不猜", () => {
  const view = buildTeammateStatuses({ detail: detail(), current: plan([
    task({ status: "in_progress", ownerMembershipId: "m2", helperEfforts: [{ membershipId: "m1", durationEstimate: { minutes: 60 } }] }),
  ], { inputVersionsChanged: true }) });
  for (const teammate of view.teammates) {
    assert.deepEqual(teammate.helping, [], "依据不可用时不得显示协助清单");
    assert.equal(teammate.status, "unknown");
  }
});
