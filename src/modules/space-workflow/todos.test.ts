// 待办清单（规划27 第1期）：纯派生、有结束条件、不出现内部状态、红色仅真阻塞。
import assert from "node:assert/strict";
import test from "node:test";
import { buildSpaceTodos, type SpaceTodoInput } from "./todos.ts";
import type { LifecycleInput } from "./model.ts";

const now = "2026-10-12T04:00:00.000Z";
function project(over: Record<string, unknown> = {}) {
  return { id: "p1", name: "破壁者战队", teamId: null, eventId: "e1", createdBy: "u1", goal: "", minimumDeliverable: "",
    stage: "draft", timezone: "Asia/Shanghai", deadline: null, deadlineSource: "unknown", revision: 1, createdAt: now, updatedAt: now, ...over } as never;
}
function member(over: Record<string, unknown> = {}) {
  return { membershipId: "m1", projectId: "p1", userId: "u1", role: "manager", status: "active", revision: 1, joinedAt: now, leftAt: null, ...over } as never;
}
function detail(over: { project?: unknown; membership?: unknown } = {}) {
  return { project: (over.project ?? project()) as never, membership: (over.membership ?? member()) as never, members: [member({ displayName: "我" })] as never };
}
/** 全部"未读取"——约束要求这种状态不进待办，而是进 unread。 */
const allUnread = { rules: { status: "unread" }, tracks: { status: "unread" }, intention: { status: "unread" }, availability: { status: "unread" } } as const;
const emptyPlan = { plan: null, tasks: [], tasksRevision: 0, evaluation: null, staleInputs: false, inputVersionsChanged: false, lastProgressAt: null } as never;
function base(over: Partial<SpaceTodoInput> = {}): SpaceTodoInput {
  // 注意展开顺序：调用方显式传入的 detail 必须最后生效，不能被这里按 current 重建的 detail 覆盖
  // （否则 goal 会被置空、任务工作台落到 needs_review，测不到"当前计划"的分支）。
  const derived = over.current && (over.current as { plan?: unknown }).plan ? detail({ project: project({ goal: "完成工具主流程", minimumDeliverable: "可体验原型" }) }) : detail();
  const { detail: explicitDetail, ...rest } = over;
  // detail 写在 rest 之前：rest 里已没有 detail 键，但这样顺序仍然明确——调用方传入的优先。
  return { detail: explicitDetail ?? derived, current: emptyPlan, ...allUnread, ...rest } as SpaceTodoInput;
}
function task(over: Record<string, unknown> = {}) {
  return { id: "t1", projectId: "p1", title: "完成首页原型", kind: "engineering", status: "todo", priority: "must",
    ownerMembershipId: "m1", reviewerMembershipId: null, dependencyTaskIds: [], deliverable: "可演示原型",
    acceptanceCriteria: ["能打开首页"], deadlineRef: "d1", blocker: null, acceptance: null, helperEfforts: [], revision: 1, ...over };
}
function withTasks(tasks: unknown[], over: Record<string, unknown> = {}) {
  return { plan: { id: "v1", projectId: "p1", version: 1, status: "applied", appliedAt: now, createdAt: now,
    inputSnapshot: { projectId: "p1", deadlines: [], availability: [], assignmentVersionId: null } }, tasks, tasksRevision: 1, evaluation: { structuralValid: true, likely: { scheduled: [], issues: [] } },
    staleInputs: false, inputVersionsChanged: false, lastProgressAt: now, ...over } as never;
}

test("未读取的事实不进待办，而进 unread（不把未知当待办）", () => {
  const view = buildSpaceTodos(base());
  assert.ok(view.unread.length > 0, "应说明读取状态");
  assert.ok(view.todos.every(todo => todo.kind !== "fill" || !todo.title.includes("尚未")), "待办里不得出现内部状态");
  for (const todo of view.todos) assert.ok(todo.doneWhen.trim().length > 0, "每条待办必须有结束条件");
});

test("每条待办都有结束条件，且不出现内部状态字样", () => {
  const view = buildSpaceTodos(base({ current: withTasks([task({ status: "in_progress" })]), ...allUnread }));
  assert.ok(view.todos.length > 0);
  for (const todo of view.todos) {
    assert.ok(todo.doneWhen.trim().length > 0, todo.id + " 缺少结束条件");
    const text = todo.title + todo.doneWhen;
    for (const bad of ["尚未读取", "未知", "需要复核", "不把未知"]) assert.ok(!text.includes(bad), `${todo.id} 出现内部状态：${bad}`);
  }
});

test("要我确认：队友交出成果等我检查 → 真阻塞（红色）", () => {
  const view = buildSpaceTodos(base({ current: withTasks([task({ status: "review", ownerMembershipId: "m2" })]), ...allUnread }));
  const confirm = view.todos.find(todo => todo.kind === "confirm");
  assert.ok(confirm, "应列出待确认");
  assert.equal(confirm!.urgency, "urgent");
  assert.equal(view.urgentCount, 1);
});

test("要我做：进行中的本人任务进待办；未排期的 todo 不进待办而进 unread", () => {
  const doing = buildSpaceTodos(base({ current: withTasks([task({ status: "in_progress" })]), ...allUnread }));
  assert.ok(doing.todos.some(todo => todo.kind === "do"), "进行中应进待办");
  assert.equal(doing.urgentCount, 0, "进行中不是真阻塞");

  const notScheduled = buildSpaceTodos(base({ current: withTasks([task({ status: "todo" })]), ...allUnread }));
  assert.ok(!notScheduled.todos.some(todo => todo.kind === "do"), "未排期的任务不该当成待办");
  assert.ok(notScheduled.unread.some(text => text.includes("还没有安排可执行时间")));
});

test("阻塞任务进待办并标红；前置未完成的进行中任务不误导为真阻塞", () => {
  const blocked = buildSpaceTodos(base({ current: withTasks([task({ status: "blocked", blocker: "缺接口文档" })]), ...allUnread }));
  const item = blocked.todos.find(todo => todo.kind === "do");
  assert.ok(item && item.urgency === "urgent", "卡住应标红");
  assert.equal(blocked.readonly, false);
});

test("手动待办：只有未完成的本人条目出现，且说明是私人备忘", () => {
  const view = buildSpaceTodos(base({ manual: [
    { id: "x1", title: "问一下队友接口", note: "", status: "open", completedAt: null, revision: 1 },
    { id: "x2", title: "已经做完的事", note: "", status: "done", completedAt: now, revision: 2 },
  ] }));
  const manual = view.todos.filter(todo => todo.kind === "manual");
  assert.equal(manual.length, 1);
  assert.equal(manual[0]!.manualId, "x1");
  assert.ok(manual[0]!.doneWhen.includes("私人备忘"));
  assert.equal(manual[0]!.urgency, "normal", "手动待办不该标红");
});

test("分类计数与排序：待确认优先于要我做、再要填、最后手动", () => {
  const view = buildSpaceTodos(base({
    detail: detail({ project: project({ goal: "做一个工具", minimumDeliverable: "原型" }) }),
    current: withTasks([task({ status: "review", ownerMembershipId: "m2" }), task({ id: "t2", status: "in_progress" })]),
    manual: [{ id: "x1", title: "私人备忘", note: "", status: "open", completedAt: null, revision: 1 }],
    ...allUnread }));
  const kinds = view.todos.map(todo => todo.kind);
  const firstConfirm = kinds.indexOf("confirm"), firstDo = kinds.indexOf("do"), firstManual = kinds.indexOf("manual");
  assert.ok(firstConfirm >= 0 && firstDo > firstConfirm, "待确认应排最前");
  assert.ok(firstManual > firstDo, "手动应排最后");
  assert.equal(view.counts.confirm, 1);
  assert.equal(view.counts.do, 1);
  assert.equal(view.counts.manual, 1);
});

test("归档空间只读；不产生待办建议", () => {
  const view = buildSpaceTodos(base({ detail: detail({ project: project({ stage: "archived" }) }), current: withTasks([task({ status: "in_progress" })]) }));
  assert.equal(view.readonly, true);
});

test("计划输入变化时不猜任务可以开始，改为提示重新核对", () => {
  const view = buildSpaceTodos(base({ current: withTasks([task({ status: "in_progress" })], { inputVersionsChanged: true }), ...allUnread }));
  assert.ok(!view.todos.some(todo => todo.kind === "do"), "输入变化时不该列出可做任务");
  assert.ok(view.unread.some(text => text.includes("需要重新核对")));
});

test("事实源与指引树一致：目标已记录则不出现该待办", () => {
  const input: LifecycleInput = { detail: detail({ project: project({ goal: "做一个工具", minimumDeliverable: "原型" }) }), current: emptyPlan } as never;
  const view = buildSpaceTodos({ ...base({ detail: detail({ project: project({ goal: "做一个工具", minimumDeliverable: "原型" }) })}), current: emptyPlan, ...allUnread });
  assert.ok(!view.todos.some(todo => todo.id === "fill:goal"), "目标已填就不该再让我填目标");
  void input;
});

test("已排期且前置通过的本人任务会显示开始；未检查前置仍不推荐", () => {
  const prior = task({ id: "prior", status: "done", acceptance: { acceptedByUserId: "u1", acceptedAt: now, mode: "self_check", evidenceRefs: ["proof"], note: "已检查" } });
  const current = withTasks([prior, task({ dependencyTaskIds: ["prior"] })], { evaluation: { structuralValid: true, likely: { scheduled: [{ taskId: "t1" }], issues: [] } } });
  const view = buildSpaceTodos(base({ current }));
  assert.ok(view.todos.some(todo => todo.id === "do:t1" && todo.title.startsWith("开始")));
  const unproven = withTasks([task({ id: "prior", status: "done" }), task({ dependencyTaskIds: ["prior"] })], { evaluation: { structuralValid: true, likely: { scheduled: [{ taskId: "t1" }], issues: [] } } });
  assert.ok(!buildSpaceTodos(base({ current: unproven })).todos.some(todo => todo.id === "do:t1"));
});

test("普通成员自己的自检成果可进入检查待办，归档不推荐业务操作", () => {
  const mine = member({ role: "member" });
  const current = withTasks([task({ status: "review" })]);
  const view = buildSpaceTodos(base({ detail: { ...detail({ project: project({ goal: "目标", minimumDeliverable: "成果" }), membership: mine }), members: [mine] }, current }));
  assert.ok(view.todos.some(todo => todo.id === "confirm:t1"));
  const archived = buildSpaceTodos(base({ detail: detail({ project: project({ stage: "archived" }) }), current }));
  assert.equal(archived.todos.filter(todo => todo.kind !== "manual").length, 0);
});

test("读取期间和外空间计划不能泄漏旧任务或推荐开始", () => {
  const current = withTasks([task({ status: "in_progress" })]);
  assert.ok(!buildSpaceTodos(base({ current, planningLoading: true })).todos.some(todo => todo.kind === "do"));
  const foreign = withTasks([task({ status: "in_progress" })], { plan: { id: "foreign", projectId: "p2", status: "applied", inputSnapshot: { projectId: "p2", deadlines: [] } } });
  assert.ok(!buildSpaceTodos(base({ current: foreign })).todos.some(todo => todo.kind === "do"));
});

test("本人当前职责和时间已确认时，不从旧计划快照再次要求填写", () => {
  const view = buildSpaceTodos(base({
    intention: { status: "ready", value: { projectId: "p1", membershipRevision: 1, needsConfirmation: false, intention: { projectId: "p1", userId: "u1", membershipRevision: 1, duties: ["开发"] } } as never },
    availability: { status: "ready", value: { confirmationRequired: false, availability: { projectId: "p1", userId: "u1", membershipRevision: 1, confirmedAt: now } as never } },
  }));
  assert.ok(!view.todos.some(todo => todo.id === "fill:duties-time" || todo.id === "fill:duties" || todo.id === "fill:time"));
});

test("新人准备待办按流程排列，先目标再计划，不按中文标题排序", () => {
  const view = buildSpaceTodos(base({ detail: detail({ project: project({ goal: "", minimumDeliverable: "" }) }), current: emptyPlan }));
  const fills = view.todos.filter(todo => todo.kind === "fill");
  assert.equal(fills[0]?.id, "fill:goal");
  assert.ok(fills.findIndex(todo => todo.id === "fill:applied-plan") > fills.findIndex(todo => todo.id === "fill:goal"));
});

test("已读取但未选的官方赛道也排在作品目标之后", () => {
  const rules = { confirmation: { projectId: "p1", eventId: "e1", rulesVersion: 1, revision: 1 }, rules: { eventId: "e1", version: 1, createdAt: now,
    metadata: { name: "测试赛", organizer: "测试主办方", format: "unknown", region: "", officialUrl: "https://example.test/official" },
    sources: [], evidence: [], facts: [], qualityFlags: [], stages: [], requirements: [], officialTracks: { status: "none", evidenceIds: [], tracks: [] } } };
  const tracks = { projectId: "p1", needsReview: false, rules: { eventId: "e1", rulesVersion: 1, confirmationRevision: 1, latestPublishedRulesVersion: 1,
    catalog: { status: "none", evidenceIds: [], tracks: [] }, requirements: [] }, selection: null, history: [] };
  const view = buildSpaceTodos(base({ rules: { status: "ready", value: rules as never }, tracks: { status: "ready", value: tracks as never } }));
  const fills = view.todos.filter(todo => todo.kind === "fill");
  assert.ok(fills.some(todo => todo.id === "fill:official-track"));
  assert.equal(fills[0]?.id, "fill:goal");
});

test("孤儿任务：生效计划里没有负责人时，管理员看到「没人接的任务」而不是被静默跳过", () => {
  // 生效计划之后不能凭待办认领（计划服务只在草案阶段允许改负责人），
  // 所以这类任务原来被 `if (!mine) continue;` 直接跳过——谁都不会看到，于是没人做。
  const view = buildSpaceTodos(base({ current: withTasks([task({ id: "orphan", ownerMembershipId: null, title: "写演示脚本" })]), ...allUnread }));
  const assign = view.todos.filter(todo => todo.kind === "assign");
  assert.equal(assign.length, 1, "管理员应看到一条没人接的任务");
  assert.match(assign[0]!.title, /没人接的任务/);
  assert.match(assign[0]!.title, /写演示脚本/);
  assert.ok(assign[0]!.doneWhen.trim().length > 0, "必须有结束条件");
  assert.match(assign[0]!.doneWhen, /计划草案/, "结束条件要说清改派要走草案，不能凭待办直接认领");
  assert.equal(view.counts.assign, 1);
  assert.equal(assign[0]!.urgency, "normal", "没人接不是阻塞，不得标红");
});

test("孤儿任务：普通成员只看到说明，不会被引导去做一个他无法接的任务", () => {
  // 两点都要对：members 里必须有**身份一致的本人**；project 必须有目标与最小成果，
  // 否则任务工作台会落到 unavailable / needs_review，分支根本不执行（我在这里先后踩过两次）。
  const me2 = member({ membershipId: "m2", userId: "u2", role: "member", displayName: "我" });
  const memberDetail = { project: project({ goal: "完成工具主流程", minimumDeliverable: "可体验原型" }), membership: me2, members: [me2] } as never;
  const view = buildSpaceTodos(base({ detail: memberDetail, current: withTasks([task({ id: "orphan", ownerMembershipId: null, title: "写演示脚本" })]), ...allUnread }));
  assert.equal(view.todos.filter(todo => todo.kind === "assign").length, 0, "普通成员不列没人接的待办");
  assert.ok(view.unread.some(text => text.includes("还没有负责人")), "但要在说明里告诉他");
  assert.ok(view.unread.some(text => text.includes("管理员改派")), "并说明正确路径");
});

test("孤儿任务：已有负责人或已结算的任务不算没人接", () => {
  const owned = buildSpaceTodos(base({ current: withTasks([task({ id: "owned", ownerMembershipId: "m1" })]), ...allUnread }));
  assert.equal(owned.todos.filter(todo => todo.kind === "assign").length, 0, "有负责人就不算孤儿");
  const cancelled = buildSpaceTodos(base({ current: withTasks([task({ id: "gone", ownerMembershipId: null, status: "cancelled" })]), ...allUnread }));
  assert.equal(cancelled.todos.filter(todo => todo.kind === "assign").length, 0, "已取消的任务不算没人接");
});

test("孤儿任务：计划依据失效时不猜，也不列没人接的待办", () => {
  const view = buildSpaceTodos(base({ current: withTasks([task({ id: "orphan", ownerMembershipId: null })], { inputVersionsChanged: true }), ...allUnread }));
  assert.equal(view.todos.filter(todo => todo.kind === "assign").length, 0, "依据不可用时不列孤儿任务");
  assert.ok(view.unread.some(text => text.includes("重新核对")), "应说明为什么看不到");
});
