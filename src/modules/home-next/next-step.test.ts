// 首页"下一步"（规划27 第 2 期 2.1）：由登录态与本人事实推出下一步。
// 关键约束：区分首次到访与继续参赛；未读取（undefined）不得当 0 用；不产生完成百分比。
import assert from "node:assert/strict";
import test from "node:test";
import { buildHomeNextStep, buildResultsNextStep, buildUnreadNextStep } from "./next-step.ts";
import { isNextStepKind, type HomeNextInput, type HomeProjectFacts, type NextStep } from "./model.ts";

/** 只给"已读取"的读取态；`undefined` 表示尚未读取，用它显式表达。 */
interface Counts {
  readonly pendingTasks?: number | undefined;
  readonly blockedTasks?: number | undefined;
  readonly reviewingTasks?: number | undefined;
}
interface ProjectOverrides extends Counts {
  readonly id?: string;
  readonly name?: string;
  readonly stage?: string;
  readonly goal?: string;
  readonly minimumDeliverable?: string;
}
interface InputOverrides extends Counts {
  readonly signedIn?: boolean;
  readonly hasStartedJourney?: boolean;
  readonly selectedEventId?: string | null;
  readonly projects?: readonly HomeProjectFacts[];
}

/** 三个数字都读到了。 */
const READ_ZERO: Counts = { pendingTasks: 0, blockedTasks: 0, reviewingTasks: 0 };

/**
 * `??` 会把显式传的 `null` 当成"没传"，而本契约里 "null / undefined" 与
 * "有值" 是三种不同的意思。所以用 `in` 判断字段是否真的出现过。
 */
function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function project(over: ProjectOverrides = {}): HomeProjectFacts {
  return {
    id: over.id ?? "p1",
    name: over.name ?? "破壁者战队",
    stage: over.stage ?? "active",
    goal: over.goal ?? "做一个能演示的原型",
    minimumDeliverable: over.minimumDeliverable ?? "可点击的首页",
    pendingTasks: over.pendingTasks,
    blockedTasks: over.blockedTasks,
    reviewingTasks: over.reviewingTasks,
  };
}

function input(over: InputOverrides = {}): HomeNextInput {
  return {
    signedIn: pick(over.signedIn, true),
    hasStartedJourney: pick(over.hasStartedJourney, true),
    selectedEventId: pick<string | null>(over.selectedEventId, "e1"),
    projects: pick(over.projects, [project(READ_ZERO)]),
  };
}

/** 未读取：三个数字都不传。 */
function unreadProject(over: ProjectOverrides = {}): HomeProjectFacts {
  return project({ ...over, pendingTasks: undefined, blockedTasks: undefined, reviewingTasks: undefined });
}

const ALL_HREFS = [
  "/login", "/events", "/app", "/app/projects/p1", "/app/projects/p1#project-goal",
  "/app/projects/p1/plan", "/app/projects/p1/delivery", "/app/projects/p1/retrospective",
  "/competitions/e1/results",
];

function assertShape(step: NextStep): void {
  assert.ok(isNextStepKind(step.kind), `kind 不在契约内：${step.kind}`);
  assert.ok(step.title.trim().length > 0, "title 不能为空");
  assert.ok(step.why.trim().length > 0, "why 不能为空");
  assert.ok(step.href.startsWith("/"), `href 必须是站内路径：${step.href}`);
}
function assertNoPercentage(step: NextStep): void {
  const text = step.title + step.why;
  for (const bad of ["%", "％", "完成度", "已完成 1", "进度 "]) {
    assert.ok(!text.includes(bad), `不得出现完成度表达：${bad}（${text}）`);
  }
}

// ---------------------------------------------------------------- 必测：未登录

test("未登录 → 先登录（sign_in），指向真实登录页", () => {
  const step = buildHomeNextStep(input({ signedIn: false, hasStartedJourney: false, selectedEventId: null, projects: [] }));
  assert.equal(step.kind, "sign_in");
  assert.equal(step.href, "/login");
  assertShape(step);
  assertNoPercentage(step);
});

test("未登录即使有已选比赛与空间，也仍然先登录（不越权推测）", () => {
  const step = buildHomeNextStep(input({ signedIn: false }));
  assert.equal(step.kind, "sign_in");
  assert.equal(step.href, "/login");
});

// ------------------------------------------------- 必测：已登录、未开始 / 无空间

test("已登录但没开始过参赛、也没选比赛 → 找比赛（find_event）", () => {
  const step = buildHomeNextStep(input({ hasStartedJourney: false, selectedEventId: null, projects: [] }));
  assert.equal(step.kind, "find_event");
  assert.equal(step.href, "/events");
  assertShape(step);
});

test("继续参赛的人但空间都不在了 → 回空间（create_space），不重新讲第一遍", () => {
  const step = buildHomeNextStep(input({ hasStartedJourney: true, projects: [] }));
  assert.equal(step.kind, "create_space");
  assert.equal(step.href, "/app");
});

test("已登录、已选比赛、但还没有空间 → 建空间（create_space）", () => {
  const step = buildHomeNextStep(input({ hasStartedJourney: false, selectedEventId: "e1", projects: [] }));
  assert.equal(step.kind, "create_space");
  assert.equal(step.href, "/app");
});

test("已归档的空间不算可用空间：未开始的人仍去看比赛", () => {
  const step = buildHomeNextStep(input({
    hasStartedJourney: false,
    selectedEventId: null,
    projects: [project({ id: "old", stage: "archived", goal: "" })],
  }));
  assert.equal(step.kind, "find_event");
  assert.equal(step.href, "/events");
});

test("路径参数里放不下的比赛 id 不拼进 href，退回不依赖它的结论", () => {
  const step = buildHomeNextStep(input({ hasStartedJourney: false, selectedEventId: "../admin", projects: [] }));
  assert.equal(step.kind, "find_event");
  assert.equal(step.href, "/events");
});

test("空字符串 / 只有空格的比赛 id 视为「还没选比赛」（不能当有效路径）", () => {
  assert.equal(buildHomeNextStep(input({ hasStartedJourney: false, selectedEventId: "", projects: [] })).kind, "find_event");
  assert.equal(buildHomeNextStep(input({ hasStartedJourney: false, selectedEventId: "   ", projects: [] })).kind, "find_event");
});

// ------------------------------------------------------------ 必测：目标为空

test("有空间但目标为空 → 补目标（set_goal），指向该空间", () => {
  const step = buildHomeNextStep(input({ projects: [project({ goal: "", minimumDeliverable: "" })] }));
  assert.equal(step.kind, "set_goal");
  assert.equal(step.href, "/app/projects/p1#project-goal");
  assertShape(step);
});

test("最小成果为空也算目标没写清，同样 set_goal（不产生第二套判定）", () => {
  const step = buildHomeNextStep(input({ projects: [project({ goal: "做一个工具", minimumDeliverable: "" })] }));
  assert.equal(step.kind, "set_goal");
  assert.equal(step.href, "/app/projects/p1#project-goal");
});

test("有空间、目标空、任务数未读取 → 仍然 set_goal（不因未读取而卡住）", () => {
  const step = buildHomeNextStep(input({ projects: [unreadProject({ goal: "" })] }));
  assert.equal(step.kind, "set_goal");
});

// ------------------------------------------ 必测：任务数未读取（undefined）

test("有空间、目标已写、任务数未读取 → unread，且不猜成 0", () => {
  const step = buildHomeNextStep(input({ projects: [unreadProject()] }));
  assert.equal(step.kind, "unread");
  assert.equal(step.href, "/app/projects/p1/plan");
  assertShape(step);
});

test("只有 blockedTasks 未读取时也不给推荐（三个数字齐全才算读到）", () => {
  const step = buildHomeNextStep(input({ projects: [project({ pendingTasks: 3, reviewingTasks: 0, blockedTasks: undefined })] }));
  assert.equal(step.kind, "unread");
});

test("未读取时不得输出任何任务数量，也不得输出百分比", () => {
  const step = buildHomeNextStep(input({ projects: [unreadProject()] }));
  assert.ok(!/\d/.test(step.title), `未读取时 title 不该出现数字：${step.title}`);
  assertNoPercentage(step);
});

test("读到的 0 与未读取严格区分：三个 0 → do_tasks（确认安排），不是 unread", () => {
  const step = buildHomeNextStep(input({ projects: [project(READ_ZERO)] }));
  assert.equal(step.kind, "do_tasks");
  assert.notEqual(step.kind, "unread");
  assert.equal(step.href, "/app/projects/p1/plan");
});

// -------------------------------------------------------------- 必测：有任务

test("有待办 → 做任务（do_tasks），报出待办件数", () => {
  const step = buildHomeNextStep(input({ projects: [project({ pendingTasks: 4, blockedTasks: 0, reviewingTasks: 0 })] }));
  assert.equal(step.kind, "do_tasks");
  assert.equal(step.href, "/app/projects/p1/plan");
  assert.ok(step.title.includes("4"), "应报出待办件数");
  assertShape(step);
  assertNoPercentage(step);
});

test("有卡住的任务 → 优先解开卡住的那件", () => {
  const step = buildHomeNextStep(input({ projects: [project({ pendingTasks: 4, blockedTasks: 2, reviewingTasks: 1 })] }));
  assert.equal(step.kind, "do_tasks");
  assert.ok(step.title.includes("2"), "应报出卡住件数");
  assert.ok(step.why.includes("卡住"));
});

test("有人在等我检查 → 先检查等你的成果", () => {
  const step = buildHomeNextStep(input({ projects: [project({ pendingTasks: 4, blockedTasks: 0, reviewingTasks: 3 })] }));
  assert.equal(step.kind, "do_tasks");
  assert.ok(step.title.includes("3"), "应报出等检查件数");
  assert.ok(step.why.includes("检查"));
});

test("多个空间时优先给收尾中的那个（同一批事实只推一条）", () => {
  const step = buildHomeNextStep(input({
    projects: [
      project({ id: "running", stage: "active", pendingTasks: 9, blockedTasks: 0, reviewingTasks: 0 }),
      project({ id: "ending", stage: "finalizing", pendingTasks: 9, blockedTasks: 0, reviewingTasks: 0 }),
    ],
  }));
  assert.equal(step.kind, "wrap_up");
  assert.equal(step.href, "/app/projects/ending/delivery");
});

// ---------------------------------------------------------- 必测：收尾阶段

test("收尾阶段（finalizing）→ 提交/复盘（wrap_up），指向交付清单", () => {
  const step = buildHomeNextStep(input({ projects: [project({ stage: "finalizing" })] }));
  assert.equal(step.kind, "wrap_up");
  assert.equal(step.href, "/app/projects/p1/delivery");
  assertShape(step);
});

test("已提交（submitted）→ wrap_up（交完再写复盘）", () => {
  const step = buildHomeNextStep(input({ projects: [project({ stage: "submitted" })] }));
  assert.equal(step.kind, "wrap_up");
});

test("复盘阶段（retrospective）→ wrap_up 指向复盘页", () => {
  const step = buildHomeNextStep(input({ projects: [project({ stage: "retrospective" })] }));
  assert.equal(step.kind, "wrap_up");
  assert.equal(step.href, "/app/projects/p1/retrospective");
});

test("收尾阶段即使任务数未读取也照样给 wrap_up（不依赖那些数字）", () => {
  const step = buildHomeNextStep(input({ projects: [unreadProject({ stage: "finalizing" })] }));
  assert.equal(step.kind, "wrap_up");
});

test("已提交且选了比赛 → read_results 指向这场比赛的结果页", () => {
  const step = buildResultsNextStep(input({ selectedEventId: "e1", projects: [project({ stage: "submitted" })] }));
  assert.ok(step);
  assert.equal(step!.kind, "read_results");
  assert.equal(step!.href, "/competitions/e1/results");
  assertShape(step!);
});

test("没有已提交的空间 → 结果建议返回 null（不编造结果页）", () => {
  assert.equal(buildResultsNextStep(input({ projects: [project({ stage: "active", ...READ_ZERO })] })), null);
  assert.equal(buildResultsNextStep(input({ projects: [] })), null);
});

test("比赛 id 不合法时结果建议退回自己空间，不拼出坏链接", () => {
  const step = buildResultsNextStep(input({ selectedEventId: "a/b", projects: [project({ stage: "submitted" })] }));
  assert.equal(step!.href, "/app/projects/p1/delivery");
});

// ------------------------------------------------------------ 通用不变量

test("所有分支：kind 合法、href 都是站内真实路径、无百分比", () => {
  const cases: NextStep[] = [
    buildHomeNextStep(input({ signedIn: false, hasStartedJourney: false, selectedEventId: null, projects: [] })),
    buildHomeNextStep(input({ hasStartedJourney: false, selectedEventId: null, projects: [] })),
    buildHomeNextStep(input({ projects: [] })),
    buildHomeNextStep(input({ hasStartedJourney: false, projects: [] })),
    buildHomeNextStep(input({ projects: [project({ goal: "" })] })),
    buildHomeNextStep(input({ projects: [project(READ_ZERO)] })),
    buildHomeNextStep(input({ projects: [unreadProject()] })),
    buildHomeNextStep(input({ projects: [project({ pendingTasks: 2, blockedTasks: 0, reviewingTasks: 0 })] })),
    buildHomeNextStep(input({ projects: [project({ stage: "finalizing" })] })),
    buildUnreadNextStep("读取失败，请重试。"),
  ];
  const seen = new Set<string>();
  for (const step of cases) {
    assertShape(step);
    assertNoPercentage(step);
    assert.ok(ALL_HREFS.includes(step.href) || /^\/app\/projects\/[^/]+/.test(step.href), `未登记的 href：${step.href}`);
    seen.add(step.kind);
  }
  const results = buildResultsNextStep(input({ selectedEventId: "e1", projects: [project({ stage: "submitted" })] }));
  assert.ok(results);
  assertShape(results!);
  assertNoPercentage(results!);
  assert.ok(ALL_HREFS.includes(results!.href), `未登记的 href：${results!.href}`);
  seen.add(results!.kind);
  assert.ok(seen.has("sign_in") && seen.has("find_event") && seen.has("create_space")
    && seen.has("set_goal") && seen.has("do_tasks") && seen.has("wrap_up")
    && seen.has("read_results") && seen.has("unread"),
    `分支覆盖不全：${[...seen].join(",")}`);
});

test("纯函数：同一输入两次调用结果一致，且不修改传入对象", () => {
  const frozen: HomeNextInput = Object.freeze({
    signedIn: true,
    hasStartedJourney: true,
    selectedEventId: "e1",
    projects: Object.freeze([Object.freeze(project({ pendingTasks: 1, blockedTasks: 0, reviewingTasks: 0 }))]),
  });
  const first = buildHomeNextStep(frozen);
  const second = buildHomeNextStep(frozen);
  assert.deepEqual(first, second);
  assert.equal(frozen.projects[0]!.pendingTasks, 1, "不得改动传入事实");
});

test("读取失败时明确说「说不准」，而不是先给一个可能错的推荐", () => {
  const step = buildUnreadNextStep("读取失败，请重试。");
  assert.equal(step.kind, "unread");
  assert.ok(step.why.includes("读取失败"));
  assert.equal(step.href, "/app");
});
