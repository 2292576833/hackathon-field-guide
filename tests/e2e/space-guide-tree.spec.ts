import { test, expect, type Page } from "@playwright/test";
import type { Project, ProjectMember } from "../../src/modules/projects/model.ts";
import type { CurrentPlanningView, PlanningInput, PlanVersion, TaskKind, TaskStatus } from "../../src/modules/planning/types.ts";
import type { TaskProposal } from "../../src/modules/planning/service.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });

interface ProjectDetail { project: Project; membership: ProjectMember; members: ProjectMember[] }
const summaries = [
  "先确定作品目标，按需邀请队友", "核对报名、官方赛道和比赛要求",
  "选职责、填时间，确认分工与计划", "按依赖执行任务，交成果并检查",
  "准备演示，核对正式提交", "留下复盘，选择复用或归档",
];
const guide = (page: Page) => page.getByRole("region", { name: "团队空间指引树", exact: true });
const nodes = (page: Page) => guide(page).locator("ol > li > details");
const board = (page: Page) => page.getByRole("region", { name: "团队任务板", exact: true });

async function openGuide(page: Page) {
  // The mission workbench keeps the full guide as an optional folded tool.
  const summary = page.locator("summary").filter({ hasText: "参赛指引树与各阶段工具" });
  await expect(summary).toBeVisible();
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
  await expect(guide(page)).toBeVisible();
}

async function createSpace(f: IsolatedWorkspace, owner: FixtureIdentity, completeGoal = false) {
  return f.request<Project>("projects", "POST", {
    name: "隔离练习：团队空间完整指引", timezone: "Asia/Shanghai",
    goal: completeGoal ? "帮助新人完成可操作的 AI 作品" : "",
    minimumDeliverable: completeGoal ? "一个能实际使用和展示的 Demo" : "",
    deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  }, owner, 201);
}

async function fingerprint(f: IsolatedWorkspace, projectId: string) {
  return {
    project: (await f.database.query("SELECT * FROM projects_project WHERE id=$1", [projectId])).rows,
    plan: (await f.database.query("SELECT * FROM planning_states WHERE project_id=$1", [projectId])).rows,
    guide: (await f.database.query("SELECT * FROM user_onboarding ORDER BY user_id")).rows,
    usage: (await f.database.query("SELECT id FROM ai_usage_attempts")).rows,
  };
}

async function browseAll(page: Page) {
  await expect(nodes(page)).toHaveCount(6);
  for (let index = 0; index < summaries.length; index++) {
    const detail = nodes(page).nth(index), summary = detail.locator(":scope > summary");
    await expect(summary).toContainText(summaries[index]!);
    await summary.focus();
    const originallyOpen = await detail.evaluate(element => (element as HTMLDetailsElement).open);
    await summary.press("Enter");
    await expect.poll(() => detail.evaluate(element => (element as HTMLDetailsElement).open)).toBe(!originallyOpen);
    if (originallyOpen) await summary.press("Space");
    await expect(detail).toHaveAttribute("open", "");
    await expect(detail).toContainText(/何时做/);
    await expect(detail).toContainText(/具体动作|具体怎么做/);
    await expect(detail).toContainText(/核对条件|完成条件|完成或核对/);
    await expect(detail).toContainText(/下一步/);
    for (const toolSummary of await detail.locator("summary").filter({ hasText: "需要时用这些工具" }).all()) {
      const opened = await toolSummary.evaluate(element => (element.parentElement as HTMLDetailsElement).open);
      if (!opened) await toolSummary.click();
    }
    for (const action of await detail.getByRole("link").all()) await expect(action).toBeVisible();
  }
  await expect(guide(page).locator('input[type="checkbox"], [role="checkbox"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

function assertNoExternalEffects(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect(f.apiReads.filter(value => value.startsWith("POST ") && /generation|navigator\/messages|roadshow|ppt|github|install/.test(value))).toEqual([]);
  expect(f.apiReads.filter(value => /^GET me\/(participant-profile|participation|roadshow|ppt|presentation-projects)(?:\/|\?|$)/.test(value))).toEqual([]);
}

test("375px new space starts with its real goal, offers solo/invitation choices and a six-step keyboard-readable tree without writes", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("guide-tree-new@example.test", "第一次参赛的新队长"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375), base = `/app/projects/${project.id}`;
    const before = await fingerprint(f, project.id), start = f.apiReads.length;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(base); await openGuide(page);
    await expect(guide(page)).toContainText(/一个人也能继续|单人也能继续|一个人也可以/);
    await expect(guide(page).locator(`a[href="${base}#project-goal"]`).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "团队空间", exact: true }).getByRole("link")).toHaveCount(5);
    // This isolated account has never generated an invitation: captures cannot
    // contain an invitation token, login code or live private user data.
    await page.screenshot({ path: info.outputPath("space-guide-tree-375.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: info.outputPath("space-guide-tree-1280.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await browseAll(page);
    for (const suffix of ["rules", "assessment", "team", "plan", "delivery", "retrospective", "resources"]) {
      expect(await guide(page).locator(`a[href="${base}/${suffix}"]`).count()).toBeGreaterThan(0);
    }
    const settings = page.locator("#space-settings");
    await expect(settings).not.toHaveAttribute("open", "");
    await guide(page).locator(`a[href="${base}#space-settings"]`).first().click();
    await expect(settings).toHaveAttribute("open", "");
    await expect(settings.getByText("关联固定队伍、创建下一次团队空间、查看变更记录或离开空间。", { exact: true })).toBeVisible();
    const goal = page.locator("#project-goal");
    if (await goal.evaluate(element => (element as HTMLDetailsElement).open)) await goal.locator(":scope > summary").click();
    await expect(goal).not.toHaveAttribute("open", "");
    await guide(page).locator(`a[href="${base}#project-goal"]`).first().click();
    await expect(goal).toHaveAttribute("open", "");
    await expect(goal.getByLabel("作品要解决什么问题", { exact: true })).toBeVisible();
    await nodes(page).nth(0).locator(":scope > summary").click();
    const inviteLink = guide(page).locator(`a[href="${base}#space-invitation"]`).first();
    await expect(inviteLink).toBeVisible();
    await inviteLink.click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#space-invitation");
    const invitation = page.getByRole("dialog", { name: "邀请队友加入团队空间", exact: true });
    await expect(invitation).toBeVisible();
    await page.keyboard.press("Escape"); await expect(invitation).not.toBeVisible();
    for (const route of ["roadshow", "ppt", "github"]) {
      expect(await guide(page).locator(`a[href="/${route}?projectId=${project.id}"]`).count()).toBeGreaterThan(0);
    }
    for (const route of ["events", "resources", "inspiration", "skills", "library"]) {
      expect(await guide(page).locator(`a[href="/${route}"]`).count()).toBeGreaterThan(0);
      await expect(guide(page).locator(`a[href^="/${route}?projectId="]`)).toHaveCount(0);
    }
    await expect(guide(page)).toContainText(/报名.*核对|报名.*确认/);
    await expect(guide(page)).toContainText(/保存.*运行.*提交|保存.*检查.*提交/);
    expect(f.apiReads.slice(start).filter(value => !value.startsWith("GET "))).toEqual([]);
    expect(await fingerprint(f, project.id)).toEqual(before);
    expect(errors).toEqual([]); assertNoExternalEffects(f);
  } finally { await f.close(); }
});

test("a failed plan read remains unknown in the tree and cannot become fake completion or an empty-plan fact", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("guide-tree-failure@example.test", "查看未知进度的新人"), project = await createSpace(f, owner, true);
    const page = await f.page(owner, 375), base = `/app/projects/${project.id}`;
    // Inject only a read failure. Every other API request uses the real isolated handler.
    await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/projects/${project.id}/plans/current`, async route => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "FIXTURE_PLAN_UNAVAILABLE", message: "隔离测试读取失败" }, requestId: "guide-tree-read-fault" }) });
    });
    const before = await fingerprint(f, project.id), start = f.apiReads.length;
    await page.goto(base); await openGuide(page);
    await nodes(page).nth(2).locator(":scope > summary").click();
    await expect(guide(page)).toContainText(/任务计划读取失败|计划读取失败/);
    await expect(guide(page)).toContainText(/未知|无法确认/);
    await expect(guide(page).locator('[data-state="error"]').first()).toBeVisible();
    await expect(guide(page).locator(`a[href="${base}/plan"]`).first()).toBeVisible();
    await browseAll(page);
    expect(f.apiReads.slice(start).filter(value => !value.startsWith("GET "))).toEqual([]);
    expect(await fingerprint(f, project.id)).toEqual(before);
    assertNoExternalEffects(f);
  } finally { await f.close(); }
});

async function preparePlan(f: IsolatedWorkspace) {
  const manager = await f.login("guide-tree-manager@example.test", "检查成果的队长"), maker = await f.login("guide-tree-maker@example.test", "制作 Demo 的队友");
  const project = await createSpace(f, manager, true);
  const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", maxUses: 1 }, manager, 201);
  await f.request(`invitations/${invitation.token}/accept`, "POST", {}, maker);
  for (const peer of [manager, maker]) await f.request(`projects/${project.id}/my-availability`, "PUT", {
    expectedRevision: 0, timezone: "UTC", windows: [{ id: `guide-time-${peer.userId}`, startsAt: new Date(Date.now() + 60 * 60_000).toISOString(), endsAt: new Date(Date.now() + 9 * 60 * 60_000).toISOString(), effectiveMinutes: 480 }],
  }, peer);
  const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, manager);
  const input = await f.request<PlanningInput>(`projects/${project.id}/planning-input`, "GET", undefined, manager);
  const member = (peer: FixtureIdentity) => detail.members.find(value => value.userId === peer.userId)!.membershipId;
  const task = (id: string, title: string, kind: TaskKind, owner: FixtureIdentity, dependencyTaskIds: string[] = []): TaskProposal => ({
    id, projectId: project.id, title, priority: "must", kind, ownerMembershipId: member(owner), helperEfforts: [],
    deliverable: "隔离练习：队友可查看的真实成果", acceptanceCriteria: ["按照说明能复现核心流程"], reviewerMembershipId: member(manager),
    durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "人工练习估算" }, dependencyTaskIds,
    deadlineRef: input.deadlines[0]!.id, requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  });
  const tasks = [task("guide-demo", "制作可操作 Demo", "implementation", maker), task("guide-video", "录制真实 Demo", "material", manager, ["guide-demo"]), task("guide-script", "先准备视频脚本", "learning", manager)];
  for (const kind of input.requiredTaskKinds) if (!tasks.some(value => value.kind === kind)) tasks.push(task(`guide-${kind}`, `核对 ${kind} 成果`, kind, manager));
  const draft = await f.request<PlanVersion>(`projects/${project.id}/plan-versions`, "POST", {
    tasks, buffers: [{ deadlineId: input.deadlines[0]!.id, reservedMinutes: 20, basis: "预留实际提交时间" }], reason: "指引树验收的人工任务安排",
    expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "guide-tree-plan",
  }, manager, 201);
  expect(draft.status).toBe("ready");
  await f.request(`projects/${project.id}/plan-versions/${draft.id}/apply`, "POST", { expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "guide-tree-apply" }, manager);
  return { manager, maker, project };
}

async function report(f: IsolatedWorkspace, projectId: string, actor: FixtureIdentity, status: TaskStatus) {
  const state = await f.request<CurrentPlanningView>(`projects/${projectId}/plans/current`, "GET", undefined, actor);
  const task = state.tasks.find(value => value.id === "guide-demo")!;
  await f.request(`projects/${projectId}/tasks/guide-demo/progress`, "POST", {
    expectedRevision: task.revision, status, remainingEstimate: null, blocker: null, note: "隔离练习：按完成条件记录成果与检查",
    evidenceRefs: status === "done" ? ["https://example.test/guide-tree-human-check"] : [], idempotencyKey: `guide-tree-${status}`,
  }, actor, 201);
}

test("tree browsing leaves M05 dependencies untouched and only the real reviewed acceptance releases a waiting task", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { manager, maker, project } = await preparePlan(f), base = `/app/projects/${project.id}`;
    const page = await f.page(manager, 375);
    await page.goto(`${base}/plan`);
    const video = page.locator("#task-guide-video");
    await expect(video).toContainText("制作 Demo 的队友");
    await expect(video.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    await expect(page.locator("#task-guide-script").getByRole("button", { name: "开始做", exact: true })).toBeEnabled();
    await report(f, project.id, maker, "in_progress");
    await report(f, project.id, maker, "review");
    await board(page).getByRole("button", { name: "读取最新进度", exact: true }).click();
    await expect(video).toContainText("成果待检查，尚未通过");
    await expect(video.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    const before = await fingerprint(f, project.id), start = f.apiReads.length;
    await page.goto(base); await openGuide(page);
    // An applied manual plan does not imply the organizer's rules were confirmed.
    await expect(guide(page).locator(`a[href="${base}/rules"]`).first()).toBeVisible();
    await browseAll(page);
    await expect(guide(page)).toContainText(/依赖/); await expect(guide(page)).toContainText(/交成果|提交成果/); await expect(guide(page)).toContainText(/检查/);
    expect(f.apiReads.slice(start).filter(value => !value.startsWith("GET "))).toEqual([]);
    expect(await fingerprint(f, project.id)).toEqual(before);
    const awaiting = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, manager);
    expect(awaiting.tasks.find(value => value.id === "guide-demo")?.acceptance).toBeNull();
    await report(f, project.id, manager, "done");
    await page.goto(`${base}/plan`);
    await expect(video.getByRole("button", { name: "开始做", exact: true })).toBeEnabled();
    const accepted = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, manager);
    expect(accepted.tasks.find(value => value.id === "guide-demo")?.acceptance?.acceptedByUserId).toBe(manager.userId);
    expect(accepted.tasks.find(value => value.id === "guide-video")?.status).toBe("todo");
    assertNoExternalEffects(f);
  } finally { await f.close(); }
});
