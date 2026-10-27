import { test, expect, type Locator, type Page } from "@playwright/test";
import type { MemberAvailability, Project, ProjectMember } from "../../src/modules/projects/model.ts";
import type { CurrentPlanningView, PlanningInput, PlanVersion, ProgressUpdate, TaskKind, TaskStatus } from "../../src/modules/planning/types.ts";
import type { TaskProposal } from "../../src/modules/planning/service.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

// All state and sessions belong to isolatedWorkspace's in-memory database. The
// loopback server only renders the page; API calls never open production storage.
interface ProjectDetail { project: Project; membership: ProjectMember; members: ProjectMember[] }
const ids = {
  demo: "v2-demo", video: "v2-video", parallel: "v2-parallel",
  debugging: "v2-debugging", handoff: "v2-handoff", integration: "v2-integration", testing: "v2-testing", submission: "v2-submission",
};
const titles = { demo: "做出可操作的 Demo", video: "录制真实演示视频", parallel: "准备视频介绍词" };
const moreLabel = "任务详情、检查与更多操作";
const progressLabel = "这次完成了什么 / 进度说明";
const evidenceLabel = "成果链接或记录依据（每行一项）";
const remainingEstimate = { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "隔离夹具人工试做估算" };

async function createSpace(f: IsolatedWorkspace, owner: FixtureIdentity) {
  return f.request<Project>("projects", "POST", {
    name: "任务交接隔离验收空间", timezone: "Asia/Shanghai", goal: "让新人完成一条可操作的网页流程",
    minimumDeliverable: "可操作的 Demo 和演示材料", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  }, owner, 201);
}

async function prepareTasks(f: IsolatedWorkspace) {
  const manager = await f.login("tasks-v2-manager@example.test", "管理员小林");
  const maker = await f.login("tasks-v2-maker@example.test", "开发队友小陈");
  const presenter = await f.login("tasks-v2-presenter@example.test", "演示队友小周");
  const project = await createSpace(f, manager);
  const beforeJoin = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, manager);
  const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", {
    expectedRevision: beforeJoin.project.revision, role: "member", maxUses: 2,
  }, manager, 201);
  for (const peer of [maker, presenter]) await f.request(`invitations/${invitation.token}/accept`, "POST", {}, peer);
  const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const endsAt = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
  for (const peer of [manager, maker, presenter]) await f.request(`projects/${project.id}/my-availability`, "PUT", {
    expectedRevision: 0, timezone: "UTC", windows: [{ id: `window-${peer.userId}`, startsAt, endsAt, effectiveMinutes: 480 }],
  }, peer);
  const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, manager);
  const input = await f.request<PlanningInput>(`projects/${project.id}/planning-input`, "GET", undefined, manager);
  const membership = (peer: FixtureIdentity) => detail.members.find(member => member.userId === peer.userId)!.membershipId;
  const task = (id: string, title: string, kind: TaskKind, peer: FixtureIdentity, dependencyTaskIds: string[] = []): TaskProposal => ({
    id, projectId: project.id, title, priority: "must", kind, ownerMembershipId: membership(peer), helperEfforts: [],
    deliverable: "队友能实际查看和检查的成果", acceptanceCriteria: ["核心流程可按说明复现"], reviewerMembershipId: membership(manager),
    durationEstimate: remainingEstimate, dependencyTaskIds, deadlineRef: input.deadlines[0]!.id, requirementRefs: [], resourceRefs: [],
    splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  });
  const tasks: TaskProposal[] = [
    task(ids.demo, titles.demo, "implementation", maker),
    task(ids.video, titles.video, "material", presenter, [ids.demo]),
    { ...task(ids.parallel, titles.parallel, "learning", presenter), reviewerMembershipId: null },
    ...(["debugging", "handoff", "integration", "testing", "submission"] as const).map(kind => task(ids[kind], `核对 ${kind} 成果`, kind, manager)),
  ];
  // Cover every configured required phase through the real draft validator.
  for (const kind of input.requiredTaskKinds) if (!tasks.some(value => value.kind === kind)) tasks.push(task(`v2-required-${kind}`, `核对必交 ${kind} 成果`, kind, manager));
  const draft = await f.request<PlanVersion>(`projects/${project.id}/plan-versions`, "POST", {
    tasks, buffers: [{ deadlineId: input.deadlines[0]!.id, reservedMinutes: 20, basis: "给正式提交保留时间" }],
    reason: "区分真实依赖与可并行准备", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "tasks-v2-draft",
  }, manager, 201);
  expect(draft.status).toBe("ready");
  await f.request(`projects/${project.id}/plan-versions/${draft.id}/apply`, "POST", {
    expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "tasks-v2-apply",
  }, manager);
  return { project, manager, maker, presenter, tasks };
}

async function current(f: IsolatedWorkspace, projectId: string, peer: FixtureIdentity) {
  return f.request<CurrentPlanningView>(`projects/${projectId}/plans/current`, "GET", undefined, peer);
}

async function report(f: IsolatedWorkspace, projectId: string, taskId: string, peer: FixtureIdentity, status: TaskStatus, note: string) {
  const snapshot = await current(f, projectId, peer);
  const task = snapshot.tasks.find(value => value.id === taskId)!;
  return f.request<ProgressUpdate>(`projects/${projectId}/tasks/${taskId}/progress`, "POST", {
    expectedRevision: task.revision, status, remainingEstimate, blocker: status === "blocked" ? note : null,
    note, evidenceRefs: status === "done" ? ["https://example.test/isolated-acceptance-evidence"] : [],
    idempotencyKey: `tasks-v2-${taskId}-${task.revision}-${status}`,
  }, peer, 201);
}

function board(page: Page) { return page.getByRole("region", { name: "团队任务板", exact: true }); }
function card(page: Page, taskId: string) { return page.locator(`#task-${taskId}`); }
function details(task: Locator) { return task.locator("details").filter({ hasText: moreLabel }).first(); }
async function expand(task: Locator) {
  const panel = details(task);
  if (!(await panel.evaluate(element => (element as HTMLDetailsElement).open))) await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");
  return panel;
}
async function reloadProgress(page: Page) { await board(page).getByRole("button", { name: "读取最新进度", exact: true }).click(); }
function noExternalEffects(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect(f.apiReads.filter(value => value.startsWith("POST ") && /generation|navigator\/messages|roadshow|ppt|github|install/.test(value))).toEqual([]);
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

test("a space without an applied plan gives starting links and no empty task filters", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const manager = await f.login("empty-tasks-v2@example.test", "第一次参赛的队友"), project = await createSpace(f, manager);
    const page = await f.page(manager, 375); await page.goto(`/app/projects/${project.id}/plan`);
    const region = board(page);
    await expect(region.getByText("还没有生效计划。", { exact: false })).toBeVisible();
    await expect(region.getByRole("link", { name: "选择我的职责", exact: true })).toHaveAttribute("href", `/app/projects/${project.id}/assessment`);
    await expect(region.getByRole("link", { name: "填写可用时间", exact: true })).toHaveAttribute("href", `/app/projects/${project.id}/team`);
    await expect(region.getByRole("button", { name: "与我有关", exact: true })).toHaveCount(0);
    await expect(region.getByRole("button", { name: "全队任务", exact: true })).toHaveCount(0);
    await expect(region.locator('[aria-label="按状态查看"]')).toHaveCount(0);
    await noHorizontalOverflow(page); noExternalEffects(f);
  } finally { await f.close(); }
});

test("waiting shows the real owner and check state; locating a prerequisite clears filters; only acceptance releases it", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, manager, maker, presenter } = await prepareTasks(f);
    const presenterPage = await f.page(presenter, 375), makerPage = await f.page(maker), managerPage = await f.page(manager);
    await presenterPage.goto(`/app/projects/${project.id}/plan`);
    const region = board(presenterPage), waiting = card(presenterPage, ids.video), parallel = card(presenterPage, ids.parallel);
    await expect(region.getByRole("button", { name: "与我有关", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(card(presenterPage, ids.demo)).toBeHidden();
    await expect(waiting).toContainText("开发队友小陈");
    await expect(waiting).toContainText("未开始");
    await expect(waiting).toContainText("尚无检查通过记录");
    await expect(waiting.locator(`a[href="#task-${ids.parallel}"]`)).toHaveText(titles.parallel);
    await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    await expect(parallel.getByRole("button", { name: "开始做", exact: true })).toBeEnabled();
    await expect(details(parallel)).not.toHaveAttribute("open", "");
    await expect(details(parallel).getByRole("button", { name: "提交成果，请队友检查", exact: true, includeHidden: true })).toHaveCount(1);
    await expect(details(parallel).getByRole("button", { name: "提交成果，请队友检查", exact: true, includeHidden: true })).toBeHidden();
    await expect(parallel.getByText("怎样检查：", { exact: false })).toBeHidden();
    await region.getByRole("button", { name: /^等待队友 \/ 需要帮助（/ }).click();
    await expect(parallel).toBeHidden();
    await waiting.locator(`a[href="#task-${ids.demo}"]`).click();
    await expect(region.getByRole("button", { name: "全队任务", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(region.getByRole("button", { name: /^全部（/ })).toHaveAttribute("aria-pressed", "true");
    await expect(card(presenterPage, ids.demo)).toBeVisible();
    await expect(card(presenterPage, ids.demo)).toBeFocused();
    await expect(card(presenterPage, ids.demo)).toHaveAttribute("tabindex", "-1");

    await makerPage.goto(`/app/projects/${project.id}/plan`);
    const demo = card(makerPage, ids.demo);
    await expect(details(demo)).not.toHaveAttribute("open", "");
    await expect(demo.getByRole("button", { name: "提交成果，请队友检查", exact: true })).toBeHidden();
    await demo.getByRole("button", { name: "开始做", exact: true }).click();
    await demo.getByLabel(progressLabel, { exact: true }).fill("先实现核心流程，按计划开始。");
    await demo.getByRole("button", { name: "保存进度", exact: true }).click();
    await expect(demo.getByRole("button", { name: "提交成果，请队友检查", exact: true })).toBeVisible();
    await expect(demo.getByRole("button", { name: "遇到问题，请队友帮助", exact: true })).toBeHidden();
    await expand(demo);
    await demo.getByRole("button", { name: "更新进度与剩余工时", exact: true }).click();
    await demo.getByLabel(progressLabel, { exact: true }).fill("核心入口已经实现，仍需补齐完整流程。");
    await demo.getByLabel("预计还需多久（分钟，选填）", { exact: true }).fill("8");
    await demo.getByRole("button", { name: "保存进度", exact: true }).click();
    await expect(demo).toContainText("进度已保存，队友可以看到。");
    expect((await current(f, project.id, maker)).tasks.find(task => task.id === ids.demo)).toMatchObject({ status: "in_progress", remainingEstimate: { likelyMinutes: 8 } });
    await details(demo).locator("summary").click();
    await demo.getByRole("button", { name: "提交成果，请队友检查", exact: true }).click();
    await demo.getByLabel(progressLabel, { exact: true }).fill("已做出可操作的 Demo，等待实际检查。");
    await demo.getByRole("button", { name: "提交到待检查", exact: true }).click();
    await expect(demo).toContainText("成果已交到待检查，队友可以看到。");
    await reloadProgress(presenterPage);
    await expect(waiting).toContainText("成果待检查，尚未通过");
    await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    await expect(card(presenterPage, ids.demo).getByRole("button", { name: "检查通过", exact: true })).toHaveCount(0);

    await managerPage.goto(`/app/projects/${project.id}/plan`);
    const checking = card(managerPage, ids.demo);
    await checking.getByRole("button", { name: "检查通过", exact: true }).click();
    await checking.getByLabel("怎样确认满足检查条件", { exact: true }).fill("按说明复现了核心流程，结果符合条件。");
    await checking.getByLabel(evidenceLabel, { exact: true }).fill("https://example.test/isolated-demo-check");
    await checking.getByRole("button", { name: "确认检查通过", exact: true }).click();
    await expect(checking).toContainText("检查已通过，依赖此成果的任务可以继续。");
    await reloadProgress(presenterPage);
    await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeEnabled();
    expect((await current(f, project.id, presenter)).tasks.find(task => task.id === ids.demo)?.acceptance?.acceptedByUserId).toBe(manager.userId);
    await report(f, project.id, ids.parallel, presenter, "review", "已试做介绍词并形成可检查内容。");
    await reloadProgress(presenterPage);
    await parallel.getByRole("button", { name: "按条件自检通过", exact: true }).click();
    await expect(parallel).toContainText("这次由你本人按条件自检");
    await parallel.getByLabel("怎样确认满足检查条件", { exact: true }).fill("本人逐项试读并核对内容符合检查条件。");
    await parallel.getByLabel(evidenceLabel, { exact: true }).fill("https://example.test/isolated-introduction-self-check");
    await parallel.getByRole("button", { name: "确认检查通过", exact: true }).click();
    await expect(parallel).toContainText("检查已通过");
    expect((await current(f, project.id, presenter)).tasks.find(task => task.id === ids.parallel)?.acceptance?.mode).toBe("self_check");
    await noHorizontalOverflow(presenterPage); noExternalEffects(f);
  } finally { await f.close(); }
});

test("only legal ready work is suggested, and changed plan inputs remove that suggestion", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, presenter } = await prepareTasks(f);
    const page = await f.page(presenter, 375); await page.goto(`/app/projects/${project.id}/plan`);
    const waiting = card(page, ids.video);
    await expect(waiting.locator(`a[href="#task-${ids.parallel}"]`)).toBeVisible();
    await expect(waiting.locator(`a[href="#task-${ids.testing}"]`)).toHaveCount(0);
    const saved = await f.request<{ availability: MemberAvailability }>(`projects/${project.id}/my-availability`, "GET", undefined, presenter);
    await f.request(`projects/${project.id}/my-availability`, "PUT", {
      expectedRevision: saved.availability.revision, timezone: saved.availability.timezone,
      windows: saved.availability.windows.map(({ id, startsAt, endsAt, effectiveMinutes }) => ({ id, startsAt, endsAt, effectiveMinutes })),
    }, presenter);
    await reloadProgress(page);
    await expect(board(page)).toContainText("空间资料或比赛要求、分工、可用时间有更新");
    await expect(waiting.locator(`a[href="#task-${ids.parallel}"]`)).toHaveCount(0);
    await expect(waiting).toContainText("暂未找到其他已能开始的任务");
    await expect(card(page, ids.parallel).getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    expect((await current(f, project.id, presenter)).inputVersionsChanged).toBe(true);
    noExternalEffects(f);
  } finally { await f.close(); }
});

test("task details give each kind's existing resource links and explain what they help complete", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, manager } = await prepareTasks(f);
    const page = await f.page(manager, 375); await page.goto(`/app/projects/${project.id}/plan`);
    await board(page).getByRole("button", { name: "全队任务", exact: true }).click();
    const delivery = `/app/projects/${project.id}/delivery`;
    const checks: { taskId: string; href: string; purpose: RegExp }[] = [
      ...[ids.demo, ids.debugging, ids.integration, ids.testing].flatMap(taskId => [
        { taskId, href: delivery, purpose: /代码成果保存到仓库.*当前版本能否运行/ },
        { taskId, href: "/resources", purpose: /已审核.*使用条件与许可/ },
      ]),
      { taskId: ids.video, href: `/ppt?projectId=${project.id}`, purpose: /PPT.*本人.*主动确认/ },
      { taskId: ids.video, href: `/roadshow?projectId=${project.id}`, purpose: /讲稿.*本人.*主动确认/ },
      { taskId: ids.video, href: "/inspiration", purpose: /视觉、组件和动效.*使用许可/ },
      { taskId: ids.parallel, href: "/resources", purpose: /已审核.*使用条件与许可/ },
      { taskId: ids.parallel, href: "/skills", purpose: /前置条件和兼容证据.*安装与实际试做/ },
      { taskId: ids.handoff, href: `/app/projects/${project.id}/resources`, purpose: /队友主动共享.*可接手/ },
      { taskId: ids.handoff, href: delivery, purpose: /交接的仓库版本与运行记录.*检查记录/ },
      { taskId: ids.submission, href: delivery, purpose: /官方要求提交.*不代表已正式提交/ },
    ];
    for (const taskId of new Set(checks.map(value => value.taskId))) {
      const task = card(page, taskId);
      await expect(details(task)).not.toHaveAttribute("open", "");
      await expand(task);
      for (const value of checks.filter(check => check.taskId === taskId)) {
        const link = details(task).locator(`a[href="${value.href}"]`);
        await expect(link).toBeVisible();
        await expect(link.locator("..")).toContainText(value.purpose);
      }
    }
    await noHorizontalOverflow(page); noExternalEffects(f);
  } finally { await f.close(); }
});

test("a concurrent saved update preserves local note, evidence and estimate until the member explicitly adopts the latest record", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, manager, maker } = await prepareTasks(f);
    await report(f, project.id, ids.demo, maker, "in_progress", "核心功能正在实现。");
    const page = await f.page(maker); await page.goto(`/app/projects/${project.id}/plan`);
    const demo = card(page, ids.demo);
    await demo.getByRole("button", { name: "提交成果，请队友检查", exact: true }).click();
    const note = "LOCAL_DRAFT 保留当前成果说明", evidence = "https://example.test/local-draft-evidence";
    await demo.getByLabel(progressLabel, { exact: true }).fill(note);
    await demo.getByLabel(evidenceLabel, { exact: true }).fill(evidence);
    await demo.getByLabel("预计还需多久（分钟，选填）", { exact: true }).fill("7");
    await report(f, project.id, ids.demo, manager, "in_progress", "管理员补充了当前协调记录。");
    await reloadProgress(page);
    await expect(demo).toContainText("输入没有丢失");
    await expect(demo.getByLabel(progressLabel, { exact: true })).toHaveValue(note);
    await expect(demo.getByLabel(evidenceLabel, { exact: true })).toHaveValue(evidence);
    await expect(demo.getByLabel("预计还需多久（分钟，选填）", { exact: true })).toHaveValue("7");
    await expect(demo.getByRole("button", { name: "提交到待检查", exact: true })).toBeDisabled();
    await demo.getByRole("button", { name: "保留输入，按最新记录继续", exact: true }).click();
    await demo.getByRole("button", { name: "提交到待检查", exact: true }).click();
    await expect(demo).toContainText("成果已交到待检查");
    const records = await f.request<ProgressUpdate[]>(`projects/${project.id}/progress`, "GET", undefined, maker);
    expect(records.find(value => value.note === "管理员补充了当前协调记录。")).toBeDefined();
    expect(records.at(-1)).toMatchObject({ status: "review", note, evidenceRefs: [evidence], remainingEstimate: { likelyMinutes: 7 } });
    noExternalEffects(f);
  } finally { await f.close(); }
});

test("mistaken completion, member correction requests and manager correction keep the original records and downstream impact", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, manager, maker, presenter } = await prepareTasks(f);
    const mistaken = await report(f, project.id, ids.demo, maker, "review", "误操作报告已完成，实际还需完善。");
    const makerPage = await f.page(maker); await makerPage.goto(`/app/projects/${project.id}/plan`);
    const demo = card(makerPage, ids.demo);
    await expect(demo.getByRole("button", { name: "还需继续做 / 更正误勾", exact: true })).toBeHidden();
    await expand(demo);
    await demo.getByRole("button", { name: "还需继续做 / 更正误勾", exact: true }).click();
    await demo.getByLabel(progressLabel, { exact: true }).fill("更正误勾：核心流程尚未完整，需要继续。");
    const latestReview = await report(f, project.id, ids.demo, maker, "review", "另一条完成报告补充了最新记录，仍需核对。");
    await reloadProgress(makerPage);
    await expect(demo.getByLabel(progressLabel, { exact: true })).toHaveValue("更正误勾：核心流程尚未完整，需要继续。");
    await expect(demo.getByRole("button", { name: "保存进度", exact: true })).toBeDisabled();
    await demo.getByRole("button", { name: "保留输入，按最新记录继续", exact: true }).click();
    await demo.getByRole("button", { name: "保存进度", exact: true }).click();
    await expect(demo.getByRole("button", { name: "提交成果，请队友检查", exact: true })).toBeVisible();
    let records = await f.request<ProgressUpdate[]>(`projects/${project.id}/progress`, "GET", undefined, maker);
    expect(records.find(value => value.id === mistaken.id)?.status).toBe("review");
    expect(records.at(-1)).toMatchObject({ status: "in_progress", correctionOf: latestReview.id, correctionReason: "更正误勾：核心流程尚未完整，需要继续。" });
    await report(f, project.id, ids.demo, maker, "review", "核心流程现已完善，重新请队友检查。");
    const accepted = await report(f, project.id, ids.demo, manager, "done", "已按条件核对核心流程。");
    await report(f, project.id, ids.video, presenter, "in_progress", "已接手演示视频录制。");
    await reloadProgress(makerPage);
    await expect(demo.getByRole("button", { name: "发现问题，请求更正", exact: true })).toBeVisible();
    await expect(demo.getByRole("button", { name: "更正这次检查记录", exact: true })).toHaveCount(0);
    await demo.getByRole("button", { name: "发现问题，请求更正", exact: true }).click();
    await demo.getByLabel("为什么需要更正", { exact: true }).fill("实际演示发现边界流程仍有错误，请管理员核对。");
    await demo.getByRole("button", { name: "保存更正请求", exact: true }).click();
    await expect(demo).toContainText("当前检查和任务状态保留");
    let snapshot = await current(f, project.id, maker);
    expect(snapshot.tasks.find(value => value.id === ids.demo)?.status).toBe("done");
    expect(snapshot.tasks.find(value => value.id === ids.video)?.status).toBe("in_progress");

    const managerPage = await f.page(manager); await managerPage.goto(`/app/projects/${project.id}/plan`);
    await board(managerPage).getByRole("button", { name: "全队任务", exact: true }).click();
    const checking = card(managerPage, ids.demo);
    await expect(checking).toContainText("队友请求更正这次检查");
    await expect(checking.getByRole("button", { name: "更正这次检查记录", exact: true })).toBeHidden();
    await expand(checking);
    await checking.getByRole("button", { name: "更正这次检查记录", exact: true }).click();
    await checking.getByLabel("为什么需要更正", { exact: true }).fill("核对后确认仍有缺陷，保留原检查并重新验收。");
    await expect(checking).toContainText(titles.video);
    await expect(checking.getByRole("button", { name: "保存更正记录", exact: true })).toBeDisabled();
    await checking.getByRole("checkbox", { name: "我已核对原验收与全部后续任务，确认保留记录并重新检查。", exact: true }).check();
    await checking.getByRole("button", { name: "保存更正记录", exact: true }).click();
    await expect(checking).toContainText("原验收和后续影响保留在历史中");
    snapshot = await current(f, project.id, manager);
    expect(snapshot.tasks.find(value => value.id === ids.demo)).toMatchObject({ status: "review", acceptance: null });
    expect(snapshot.tasks.find(value => value.id === ids.video)).toMatchObject({ status: "blocked", acceptance: null });
    records = await f.request<ProgressUpdate[]>(`projects/${project.id}/progress`, "GET", undefined, manager);
    expect(records.find(value => value.id === accepted.id)?.acceptance).toEqual(accepted.acceptance);
    expect(records.find(value => value.correctionRequest)?.correctionRequest?.acceptanceProgressId).toBe(accepted.id);
    expect(records.find(value => value.acceptanceCorrection)?.acceptanceCorrection?.impactedTasks).toContainEqual(expect.objectContaining({ taskId: ids.video, previousStatus: "in_progress", status: "blocked" }));
    noExternalEffects(f);
  } finally { await f.close(); }
});

test("the board reads saved snapshots every ten visible seconds, pauses hidden reads and clears cards when current membership is removed", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, manager, maker } = await prepareTasks(f);
    const page = await f.page(maker); await page.clock.install();
    await page.goto(`/app/projects/${project.id}/plan`);
    await expect(card(page, ids.demo)).toBeVisible();
    const progressReads = () => f.apiReads.filter(value => value === `GET projects/${project.id}/progress`).length;
    await expect(board(page).getByText(/最近读取：.*（北京时间）/)).toBeVisible();
    const beforeTick = progressReads();
    await page.clock.fastForward(10_001);
    await expect.poll(progressReads).toBeGreaterThan(beforeTick);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenReads = progressReads();
    await page.clock.fastForward(60_000);
    expect(progressReads()).toBe(hiddenReads);
    const latest = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, manager);
    await f.request(`projects/${project.id}/members/${maker.userId}`, "DELETE", { expectedRevision: latest.project.revision }, manager);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(progressReads).toBeGreaterThan(hiddenReads);
    await expect(board(page)).toContainText("任务和进度已清除");
    await expect(board(page).locator('[id^="task-"]')).toHaveCount(0);
    await expect(board(page).getByRole("button", { name: "全队任务", exact: true })).toHaveCount(0);
    for (const endpoint of ["plans/current", "progress"]) {
      const denied = await f.raw(`projects/${project.id}/${endpoint}`, "GET", undefined, maker);
      expect([403, 404]).toContain(denied.status);
    }
    noExternalEffects(f);
  } finally { await f.close(); }
});
