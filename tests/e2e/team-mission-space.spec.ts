import { expect, test, type Page, type Route } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import type { CurrentPlanningView, PlanningTask } from "../../src/modules/planning/types.ts";
import type { AssistantContextCoverage, AssistantConversation, AssistantMessage, TeamAssistantContextSnapshot } from "../../src/modules/team-assistant/model.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });
const at = "2026-10-09T13:00:00.000Z";
const workbench = (page: Page) => page.getByRole("region", { name: "团队协作工作台", exact: true });
const spaceAssistant = (page: Page) => page.getByRole("dialog", { name: "我的空间 AI 助手", exact: true });
async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status < 400 ? { data } : data) });
}
async function createSpace(f: IsolatedWorkspace, identity: FixtureIdentity, goal = false) {
  return f.request<Project>("projects", "POST", { name: "隔离练习：任务式 AI 黑客松", timezone: "Asia/Shanghai", goal: goal ? "帮助新人完成 AI 作品" : "", minimumDeliverable: goal ? "一条能体验的核心流程" : "", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString() }, identity, 201);
}
function poolTask(projectId: string): PlanningTask {
  return { id: "fixture-script", projectId, title: "隔离草案：准备演示故事线", priority: "optional", kind: "material", ownerMembershipId: null, helperEfforts: [], deliverable: "一页问题与解决流程的说明", acceptanceCriteria: ["队友能用说明复述核心体验"], reviewerMembershipId: null, durationEstimate: { optimisticMinutes: 10, likelyMinutes: 20, pessimisticMinutes: 30, basis: "隔离界面人工估算" }, remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "fixture-deadline", requirementRefs: [], resourceRefs: [], splittable: true, contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: at };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function projectFingerprint(f: IsolatedWorkspace, projectId: string) {
  return { project: (await f.database.query("SELECT * FROM projects_project WHERE id=$1", [projectId])).rows, planning: (await f.database.query("SELECT * FROM planning_states WHERE project_id=$1", [projectId])).rows };
}
async function mockAssistant(page: Page, f: IsolatedWorkspace, projectId: string, initial: Partial<AssistantConversation> = {}) {
  const base = `/api/v1/projects/${projectId}/assistant`;
  let conversation: AssistantConversation = { projectId, revision: 0, messages: [], pending: null, configured: true, provider: "dsh", ...initial };
  const context: TeamAssistantContextSnapshot = { projectId, fingerprint: "fixture-context-only", facts: { goal: "隔离练习：完成核心流程", ownResponsibilities: ["开发"], tasks: [] }, sources: [{ id: "fixture-project", label: "隔离夹具：本空间事实", href: `/app/projects/${projectId}` }], missing: ["隔离夹具没有实际 API 验证"], links: [], capturedAt: at };
  await page.route(url => url.origin === f.origin && url.pathname === `${base}/conversation`, route => json(route, conversation));
  await page.route(url => url.origin === f.origin && url.pathname === `${base}/context`, route => json(route, context));
  return { base, get: () => conversation, set: (next: AssistantConversation) => { conversation = next; } };
}

test("375px mission workspace has three keyboard tabs, findable invitation and an explicitly unapplied task pool without progress writes", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("mission-empty@example.test", "第一次参赛的队长"), project = await createSpace(f, owner), page = await f.page(owner, 375);
    const base = `/app/projects/${project.id}`, before = await projectFingerprint(f, project.id), start = f.apiReads.length;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    // Only the draft pool is a UI projection fixture. The current-plan GET still
    // uses the real isolated handler and has no applied plan.
    await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/projects/${project.id}/task-pool`, route => json(route, {
      plan: { id: "fixture-draft", status: "draft", revision: 1, reason: "人工练习草案", createdAt: at, basePlanVersionId: null, baseTasksRevision: 0 }, tasks: [poolTask(project.id)], inputVersionsChanged: false,
    }));
    await page.goto(base); const bench = workbench(page), tabs = bench.getByRole("tablist", { name: "团队协作主要工作区", exact: true });
    await expect(bench).toBeVisible(); await expect(tabs.getByRole("tab")).toHaveCount(3);
    await expect(bench.getByRole("tabpanel", { name: "我的下一步", exact: true })).toContainText(/先说清楚这次至少做出什么/);
    await expect(bench).toContainText(/一人也可|一个人也/);
    await expect(bench.locator(`a[href="${base}#project-goal"]`).first()).toBeVisible();
    for (const tab of await tabs.getByRole("tab").all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const mine = tabs.getByRole("tab", { name: "我的下一步", exact: true }), tasks = tabs.getByRole("tab", { name: "团队任务", exact: true }), feed = tabs.getByRole("tab", { name: "团队动态", exact: true });
    await mine.focus(); await mine.press("ArrowRight"); await expect(tasks).toBeFocused(); await expect(tasks).toHaveAttribute("aria-selected", "true");
    const pool = bench.getByRole("region", { name: "未生效任务词条池", exact: true });
    await expect(pool).toBeVisible(); await expect(pool).toContainText("隔离草案：准备演示故事线"); await expect(pool).toContainText("未生效草案");
    await expect(pool.getByRole("button", { name: "我来负责", exact: true })).toBeVisible();
    await expect(pool).toContainText(/领取只登记负责人/); await expect(bench.getByText("本计划必做成果已齐", { exact: true })).toHaveCount(0);
    await tasks.press("End"); await expect(feed).toBeFocused(); await expect(feed).toHaveAttribute("aria-selected", "true");
    await expect(bench.getByRole("region", { name: "团队动态", exact: true })).toContainText(/还没有团队动态/);
    await feed.press("Home"); await expect(mine).toBeFocused(); await expect(mine).toHaveAttribute("aria-selected", "true");
    const invite = page.getByRole("button", { name: "邀请队友", exact: true }); await expect(invite).toBeVisible(); await invite.click();
    const inviteDialog = page.getByRole("dialog", { name: "邀请队友加入团队空间", exact: true }); await expect(inviteDialog).toBeVisible(); await page.keyboard.press("Escape"); await expect(inviteDialog).not.toBeVisible();
    await noOverflow(page); await bench.screenshot({ path: info.outputPath("mission-workbench-375.png") });
    await page.setViewportSize({ width: 1280, height: 900 }); await noOverflow(page); await bench.screenshot({ path: info.outputPath("mission-workbench-1280.png") });
    expect(f.apiReads.slice(start).filter(value => !value.startsWith("GET "))).toEqual([]); expect(await projectFingerprint(f, project.id)).toEqual(before);
    expect(errors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("space assistant and navigator remain separate, preserve local drafts and never publish a private reply automatically", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("mission-private@example.test", "本人使用空间助手的新人"), project = await createSpace(f, owner, true), page = await f.page(owner, 375), start = f.apiReads.length;
    const assistant = await mockAssistant(page, f, project.id); let sends = 0;
    const coverage: AssistantContextCoverage = { contextFingerprint: "fixture-context-only", memoryFingerprint: "fixture-memory-only", memory: { retainedCount: 4, selectedCount: 2, description: "隔离UI夹具：选择相关与最近本人记忆，未调用真实模型。" }, sources: [{ id: "fixture-navigator", label: "隔离夹具：本人导航员记忆" }], missing: ["实际代码没有验证"], capturedAt: at };
    const replyText = "隔离UI私人回答：先交出一个可复现的核心流程，再请队友核对。";
    await page.route(url => url.origin === f.origin && url.pathname === `${assistant.base}/messages`, async route => {
      sends++; const body = route.request().postDataJSON(); expect(body.message).toBe("我负责开发，现在先交什么？"); expect(body.expectedRevision).toBe(0);
      const message: AssistantMessage = { id: "fixture-private-response", role: "assistant", content: replyText, createdAt: at, provider: "dsh", links: [], coverage };
      assistant.set({ ...assistant.get(), revision: 1, messages: [{ id: "fixture-question", role: "user", content: body.message, createdAt: at, provider: null, links: [], coverage: null }, message], pending: { requestId: body.requestId, message: body.message, status: "succeeded", errorCode: null, createdAt: at } });
      await json(route, { message, revision: 1, requestId: body.requestId, provider: "dsh" });
    });
    await page.goto(`/app/projects/${project.id}`); const bench = workbench(page), launch = bench.getByRole("button", { name: "打开我的空间 AI 助手", exact: true });
    await expect(launch).toBeVisible(); await launch.click(); const dialog = spaceAssistant(page); await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: "你的参赛导航员", exact: true })).not.toBeVisible();
    const question = dialog.getByLabel("现在需要什么帮助？", { exact: true }); await question.fill("尚未发送的个人草稿");
    await dialog.getByRole("button", { name: "关闭助手", exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(launch).toBeFocused();
    await page.getByRole("button", { name: "问问导航员", exact: true }).click(); const navigator = page.getByRole("dialog", { name: "你的参赛导航员", exact: true }); await expect(navigator).toBeVisible(); await expect(dialog).not.toBeVisible();
    await navigator.getByRole("button", { name: "关闭导航员", exact: true }).click(); await launch.click(); await expect(question).toHaveValue("尚未发送的个人草稿");
    await question.fill("我负责开发，现在先交什么？"); await dialog.getByRole("button", { name: "问空间助手", exact: true }).click();
    await expect(dialog).toContainText(replyText); await expect(dialog).toContainText("DSH 回答已保存为本空间私人记录。");
    await dialog.getByText("本次回答的资料与记忆覆盖", { exact: true }).click(); await expect(dialog).toContainText("本次按问题选取 2 条本人记忆"); await expect(dialog).toContainText("隔离夹具：本人导航员记忆");
    await expect(dialog.getByRole("button", { name: "选择片段分享给队友", exact: true })).toBeVisible(); await noOverflow(page); await dialog.screenshot({ path: info.outputPath("mission-private-assistant-375.png") });
    await dialog.getByRole("button", { name: "关闭助手", exact: true }).click();
    const tabs = bench.getByRole("tablist", { name: "团队协作主要工作区", exact: true }); await tabs.getByRole("tab", { name: "团队动态", exact: true }).click();
    const feed = bench.getByRole("region", { name: "团队动态", exact: true }); await expect(feed).toContainText("还没有团队动态。"); await expect(feed).not.toContainText(replyText);
    expect(sends).toBe(1); expect(f.apiReads.slice(start).filter(value => /^(POST|PATCH|DELETE) .*team-feed/.test(value))).toEqual([]);
    expect(f.apiReads.slice(start).filter(value => value === "POST navigator/messages")).toEqual([]); expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rows).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("unknown DSH outcomes remain visible, preserve input and require status checking instead of automatic retries", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("mission-unknown@example.test", "核对未知请求的新人"), project = await createSpace(f, owner, true), page = await f.page(owner, 375);
    const assistant = await mockAssistant(page, f, project.id); let sends = 0, reads = 0;
    await page.route(url => url.origin === f.origin && url.pathname === `${assistant.base}/conversation`, route => { reads++; return json(route, assistant.get()); });
    await page.route(url => url.origin === f.origin && url.pathname === `${assistant.base}/messages`, async route => {
      sends++; const body = route.request().postDataJSON(); assistant.set({ ...assistant.get(), pending: { requestId: body.requestId, message: body.message, status: "unknown", errorCode: "DSH_REQUEST_UNKNOWN", createdAt: at } });
      await json(route, { error: { code: "DSH_REQUEST_UNKNOWN", message: "隔离故障夹具：DSH 请求结果未知，请先核对保存状态。" }, requestId: "fixture-unknown" }, 503);
    });
    await page.goto(`/app/projects/${project.id}`); const launch = workbench(page).getByRole("button", { name: "打开我的空间 AI 助手", exact: true }); await launch.click(); const dialog = spaceAssistant(page);
    const question = dialog.getByLabel("现在需要什么帮助？", { exact: true }); await question.fill("这次请求结果未知时应该怎么办？"); await dialog.getByRole("button", { name: "问空间助手", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("DSH 请求结果未知"); await expect(dialog).toContainText("上一次请求结果尚未核清。"); await expect(question).toHaveValue("这次请求结果未知时应该怎么办？");
    await expect(dialog.getByRole("button", { name: "问空间助手", exact: true })).toBeDisabled(); expect(sends).toBe(1); const previousReads = reads;
    await dialog.getByRole("button", { name: "核对保存状态", exact: true }).click(); await expect.poll(() => reads).toBeGreaterThan(previousReads); expect(sends).toBe(1);
    await expect(dialog).toContainText(/同一问题不会自动重发|同一问题不会.*重发/); await noOverflow(page); await dialog.screenshot({ path: info.outputPath("mission-unknown-assistant-375.png") });
    await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); await launch.click(); await expect(question).toHaveValue("这次请求结果未知时应该怎么办？"); await expect(dialog.getByRole("button", { name: "问空间助手", exact: true })).toBeDisabled(); expect(sends).toBe(1);
    expect(f.apiReads.filter(value => /^(POST|PATCH|DELETE) .*team-feed/.test(value))).toEqual([]); expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rows).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("one independent primary task remains a real parallel option while the member waits for another person's Demo", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const manager = await f.login("mission-parallel-admin@example.test", "制作 Demo 的队友"), member = await f.login("mission-parallel-member@example.test", "先准备脚本的成员"), project = await createSpace(f, manager, true);
    const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", maxUses: 1 }, manager, 201);
    await f.request(`invitations/${invitation.token}/accept`, "POST", {}, member);
    const detail = await f.request<{ project: Project; membership: { membershipId: string }; members: { membershipId: string; userId: string }[] }>(`projects/${project.id}`, "GET", undefined, member);
    const mine = detail.membership.membershipId, managerMembership = detail.members.find(value => value.userId === manager.userId)!.membershipId, page = await f.page(member, 375);
    const demo = { ...poolTask(project.id), id: "fixture-demo", title: "制作可体验 Demo", priority: "must" as const, kind: "implementation" as const, ownerMembershipId: managerMembership, status: "in_progress" as const };
    const video = { ...poolTask(project.id), id: "fixture-video", title: "录制真实 Demo", ownerMembershipId: mine, dependencyTaskIds: [demo.id] };
    const script = { ...poolTask(project.id), id: "fixture-parallel-script", title: "先准备演示脚本", ownerMembershipId: mine };
    const tasks = [demo, video, script], schedule = { scheduled: tasks.map(task => ({ taskId: task.id, startsAt: at, finishesAt: at, allocations: [] })), issues: [], capacityMinutes: {} };
    const evaluation = { structuralValid: true, feasibility: "feasible" as const, issues: [], likely: schedule, pessimistic: schedule, checkedAt: at, staleInputs: false };
    const current: CurrentPlanningView = { plan: { id: "fixture-plan", projectId: project.id, basePlanVersionId: null, baseTasksRevision: 1, inputSnapshot: { projectId: project.id, capturedAt: at, projectRevision: detail.project.revision, requirementVersionId: "fixture-event:1:1", assignmentVersionId: null, availabilityVersions: {}, members: [], availability: [], deadlines: [], requirements: [], approvedResourceIds: [], assumptions: [], requiredTaskKinds: [] }, tasks, buffers: [], validation: evaluation, changes: [], status: "applied", reason: "隔离UI任务投影", createdBy: manager.userId, createdAt: at, appliedBy: manager.userId, appliedAt: at, acknowledgedIssueCodes: [], revision: 1 }, tasks, tasksRevision: 1, evaluation, staleInputs: false, inputVersionsChanged: false, lastProgressAt: at };
    const catalog = { status: "none", evidenceIds: ["fixture-no-track"], tracks: [] };
    await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/projects/${project.id}/plans/current`, route => json(route, current));
    await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/projects/${project.id}/rules`, route => json(route, { confirmation: { projectId: project.id, eventId: "fixture-event", rulesVersion: 1, revision: 1, analysisId: null, confirmedBy: manager.userId, confirmedAt: at }, rules: { eventId: "fixture-event", version: 1, createdAt: at, metadata: { name: "隔离练习赛事", organizer: "界面测试", format: "unknown", region: "", officialUrl: "https://example.test/fixture-official" }, sources: [], evidence: [], facts: [], qualityFlags: [], stages: [], requirements: [], officialTracks: catalog } }));
    await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/projects/${project.id}/official-tracks`, route => json(route, { projectId: project.id, projectRevision: detail.project.revision, canManage: false, readonly: false, needsReview: false, rules: { eventId: "fixture-event", rulesVersion: 1, confirmationRevision: 1, latestPublishedRulesVersion: 1, catalog, requirements: [] }, selection: { projectId: project.id, eventId: "fixture-event", rulesVersion: 1, confirmationRevision: 1, trackId: null, trackName: null, catalogStatus: "none", revision: 1, selectedBy: manager.userId, selectedAt: at, reason: "夹具明示没有細分赛道" }, history: [] }));
    const start = f.apiReads.length; await page.goto(`/app/projects/${project.id}`);
    const bench = workbench(page), minePanel = bench.getByRole("tabpanel", { name: "我的下一步", exact: true });
    await expect(minePanel.getByRole("heading", { name: "开始：先准备演示脚本", exact: true })).toBeVisible();
    await expect(minePanel.getByRole("region", { name: "我遇到的问题和前置等待", exact: true })).toContainText("录制真实 Demo");
    await expect(minePanel).toContainText("制作可体验 Demo"); await expect(minePanel).not.toContainText("当前没有可确认的并行任务。");
    await noOverflow(page); await bench.screenshot({ path: info.outputPath("mission-parallel-375.png") });
    expect(f.apiReads.slice(start).filter(value => !value.startsWith("GET "))).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
