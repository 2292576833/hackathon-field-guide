import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Project, ProjectMember } from "../../src/modules/projects/model.ts";
import { assertPublishable, KEY_RULE_FACTS, validateRuleVersion, type EventRuleVersion } from "../../src/modules/events/domain.ts";
import type { EventRecord } from "../../src/modules/events/model.ts";
import type { CurrentPlanningView, PlanningInput, PlanVersion } from "../../src/modules/planning/types.ts";
import { versionsEqual, type TaskProposal } from "../../src/modules/planning/service.ts";
import type { DeliveryVerification, SubmissionRecord } from "../../src/modules/github/types.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

interface ProjectDetail { project: Project; membership: ProjectMember; members: ProjectMember[] }

const name = "隔离练习：第一次参加 AI 黑客松";
const eventId = "novice-ai-hackathon-fixture";
const originalUrl = "https://example.com/novice-ai-hackathon-fixture";
const registrationUrl = "https://example.com/novice-ai-hackathon-fixture/register";
const submissionUrl = "https://example.com/novice-ai-hackathon-fixture/submit";
const chinaTime = (milliseconds: number) => new Date(milliseconds + 8 * 60 * 60_000).toISOString().slice(0, 16);

/** This is authored test data, not DSH output or a real organizer announcement.
 * Only the isolated SQL fixture contains it. No page fetch, mail delivery,
 * model request, GitHub write or organizer submission is performed. */
async function seedCompetition(f: IsolatedWorkspace, deadline: string) {
  const stamp = new Date().toISOString();
  const sourceDeadline = new Date(Date.parse(deadline) + 8 * 60 * 60_000).toISOString().slice(0, -1) + "+08:00";
  const evidence = "隔离练习公告：通过指定报名入口报名；报名截止尚未核实。线上参加，不设细分赛道。资格、费用与 AI 使用规则请向主办方核对。";
  const card = await f.app.discoveries.save({
    canonicalUrl: originalUrl, title: name,
    summary: "浏览器测试的隔离练习赛事，不代表真实比赛。练习新人如何核对信息、准备作品和协作交付。",
    analysis: { fit: ["愿意与队友做一个可演示原型的新人"], risks: ["报名资格和 AI 使用范围仍需核对"], preparation: ["先确认一个能演示的核心流程"], unknowns: ["报名截止尚未核实"] },
    sources: [{ url: originalUrl, title: "隔离练习来源", excerpt: evidence, fetchedAt: stamp }],
    registration: { url: registrationUrl, sourceUrl: originalUrl, evidence },
    participation: { recommendation: "consider", reason: "仅作练习：先核对主办方要求再决定参加。", suitableFor: ["愿意完成最小原型的新人"], cautionFor: ["时间不足时应先缩小范围"] },
    registrationWindow: { status: "unknown", closesAt: null, closesOn: null, evidence: ["报名截止尚未核实"], checkedAt: stamp },
    discoveredAt: stamp, lastAnalyzedAt: stamp, provider: "dsh",
  });
  const rules: EventRuleVersion = {
    eventId, version: 1, createdAt: stamp,
    metadata: { name, organizer: "隔离测试组织者，非真实主办方", format: "online", region: "线上", officialUrl: originalUrl },
    sources: [{ id: "novice-source", eventId, version: 1, sourceConfigId: null, url: originalUrl, kind: "official", contentHash: "fixture-only", fetchedAt: stamp, trustScope: "official_rules", status: "available" }],
    evidence: [
      { id: "novice-evidence", eventId, version: 1, sourceId: "novice-source", fieldKey: "submission", excerpt: `隔离练习：作品说明与演示原型须于 ${sourceDeadline} 前通过指定入口提交。`, locator: "fixture-only", rawDateText: sourceDeadline, verifiedBy: "fixture-curator", verifiedAt: stamp, conflictsWith: [] },
      { id: "novice-track-evidence", eventId, version: 1, sourceId: "novice-source", fieldKey: "official_tracks", excerpt: "隔离练习：主办方未细分赛道，按统一要求准备。", locator: "fixture-only", rawDateText: null, verifiedBy: "fixture-curator", verifiedAt: stamp, conflictsWith: [] },
    ],
    facts: KEY_RULE_FACTS.map(key => ({ key, statement: `隔离练习：${key} 尚未核实，请向主办方核对。`, status: "unknown", evidenceIds: [] })),
    stages: [{ id: "novice-submit", stageType: "submission", name: "隔离练习作品提交", startsAt: null, endsAt: { rawText: sourceDeadline, timeZone: "Asia/Shanghai", utc: deadline, dateOnly: false, evidenceIds: ["novice-evidence"] }, submissionUrl }],
    requirements: [{ id: "novice-readme", label: "隔离练习：作品说明与可演示原型", necessity: "required", stageId: "novice-submit", evidenceIds: ["novice-evidence"] }],
    officialTracks: { status: "none", evidenceIds: ["novice-track-evidence"], tracks: [] }, qualityFlags: ["missing_information"],
  };
  const event: EventRecord = { id: eventId, revision: 1, publicationStatus: "published", candidateVersion: 1, publishedVersion: 1, lastVerifiedAt: stamp };
  // Explicit fixture preparation replaces a curator's external fact checking.
  // User confirmation and every later mutation still use production handlers.
  const validatedRules = validateRuleVersion(rules);
  assertPublishable(validatedRules);
  await f.app.eventsRepository.transaction(async tx => { await tx.insertRules(validatedRules); await tx.saveEvent(event, 0); });
  return card;
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function browserIdentity(page: Page, email: string): Promise<FixtureIdentity> {
  const data = await page.evaluate(async () => (await (await fetch("/api/v1/me")).json()).data);
  const cookie = (await page.context().cookies()).find(value => value.httpOnly);
  if (!cookie) throw new Error("The isolated novice registration did not establish a session");
  return { email, userId: data.profile.id, cookie: `${cookie.name}=${cookie.value}` };
}

async function saveAvailableTime(page: Page, base: string, begins: number, ends: number) {
  await page.goto(base + "/team");
  await expect(page.getByRole("heading", { name: "我能投入的时间", exact: true })).toBeVisible();
  await page.getByLabel(/^时间段 1 · 开始/).fill(chinaTime(begins));
  await page.getByLabel("结束（北京时间）", { exact: true }).fill(chinaTime(ends));
  await page.getByRole("button", { name: "确认并保存可用时间", exact: true }).click();
  await expect(page.getByText("可用时间已确认。已有分工和计划需重新检查。", { exact: true }).first()).toBeVisible();
  await noOverflow(page);
}

/** A human-authored plan uses real validation and persistence. Creation is
 * intentionally dispatched directly because the existing workflow suite
 * covers the long manual editor; the novice still loads, reviews and confirms
 * this draft in the actual UI. This is not a mocked successful AI response. */
async function manualDraft(f: IsolatedWorkspace, owner: FixtureIdentity, peer: FixtureIdentity, projectId: string) {
  const detail = await f.request<ProjectDetail>(`projects/${projectId}`, "GET", undefined, owner);
  const facts = await f.request<PlanningInput>(`projects/${projectId}/planning-input`, "GET", undefined, owner);
  const ownerMember = detail.membership.membershipId;
  const peerMember = detail.members.find(member => member.userId === peer.userId)!.membershipId;
  const specifications: [string, TaskProposal["kind"], string, boolean, string[]][] = [
    ["novice-demo", "implementation", "做出一个能操作的 Demo", true, []],
    ["novice-script", "learning", "先准备视频脚本与开场", false, []],
    ["novice-video", "material", "录制真实演示视频", false, ["novice-demo"]],
    ["novice-integration", "integration", "把页面与核心功能连起来", true, ["novice-demo"]],
    ["novice-testing", "testing", "按新人操作顺序检查作品", false, ["novice-integration"]],
    ["novice-material", "material", "整理作品说明和 PPT 要点", true, ["novice-script"]],
    ["novice-submission", "submission", "检查必交文件与提交入口", true, ["novice-testing", "novice-video", "novice-material"]],
  ];
  const tasks: TaskProposal[] = specifications.map(([id, kind, title, owns, dependencies]) => ({
    id, kind, title, projectId, priority: "must", ownerMembershipId: owns ? ownerMember : peerMember,
    reviewerMembershipId: owns ? peerMember : ownerMember, helperEfforts: [],
    deliverable: `隔离练习成果：${title}`, acceptanceCriteria: ["队友能按说明复现成果"],
    durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "隔离练习的人工作业估算，非 AI 承诺" },
    dependencyTaskIds: dependencies, deadlineRef: "novice-submit",
    requirementRefs: id === "novice-material" ? facts.requirements.map(value => value.id) : [],
    resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  }));
  return f.request<PlanVersion>(`projects/${projectId}/plan-versions`, "POST", {
    tasks, buffers: facts.deadlines.map(value => ({ deadlineId: value.id, reservedMinutes: 20, basis: "保留核对与提交时间" })),
    reason: "隔离练习：UI 方向、技术验证与视频脚本并行，真实视频等待 Demo 检查通过", expectedTasksRevision: 0,
    basePlanVersionId: null, idempotencyKey: "novice-manual-plan",
  }, owner, 201);
}

async function changeStage(page: Page, base: string, stage: string) {
  await page.goto(base);
  await page.getByText("调整参赛阶段", { exact: true }).click();
  await page.getByLabel("下一阶段", { exact: true }).selectOption(stage);
  await page.getByLabel("变更依据", { exact: true }).fill("隔离练习：已核对对应的实际工作记录。");
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${base.slice(4)}/stage` && response.request().method() === "POST");
  await page.getByRole("button", { name: "确认更新阶段", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), "Explicit stage update must be saved").toBe(true);
  expect(((await response.json()).data as Project).stage).toBe(stage);
  const labels: Record<string, string> = { preparing: "备赛", active: "执行中", finalizing: "整理提交", submitted: "已记录提交" };
  await expect(page.locator("main").getByText(labels[stage]!, { exact: true }).first()).toBeVisible();
}

async function submitWork(page: Page, base: string, taskId: string) {
  await page.goto(base + "/plan");
  await page.getByRole("button", { name: "全队任务", exact: true }).click();
  const task = page.locator("#task-" + taskId);
  await task.getByRole("button", { name: "开始做", exact: true }).click();
  await task.getByLabel("这次完成了什么 / 进度说明", { exact: true }).fill("隔离练习：开始准备当前任务；不是已完成的真实作品。");
  await task.getByRole("button", { name: "保存进度", exact: true }).click();
  await expect(task).toContainText("进度已保存，队友可以看到。");
  await task.getByRole("button", { name: "提交成果，请队友检查", exact: true }).click();
  await task.getByLabel("这次完成了什么 / 进度说明", { exact: true }).fill("隔离练习成果，未执行真实外部项目工作。请队友检查本次练习记录。");
  await task.getByRole("button", { name: "提交到待检查", exact: true }).click();
  await expect(task).toContainText("成果已交到待检查，队友可以看到。");
}

async function reviewWork(page: Page, base: string, taskId: string) {
  await page.goto(base + "/plan");
  await page.getByRole("button", { name: "全队任务", exact: true }).click();
  const task = page.locator("#task-" + taskId);
  await task.getByRole("button", { name: "检查通过", exact: true }).click();
  await task.getByLabel("怎样确认满足检查条件", { exact: true }).fill("隔离练习：检查了队友本次提交的练习说明，非真实 Demo 运行结果。");
  await task.getByLabel("成果链接或记录依据（每行一项）", { exact: true }).fill("https://example.com/novice-fixture-evidence");
  await task.getByRole("button", { name: "确认检查通过", exact: true }).click();
  await expect(task).toContainText("检查已通过，依赖此成果的任务可以继续。");
}

test("a 375px first-time AI hackathon participant can understand and connect discovery, registration, teamwork, handoff, delivery and private retrospective", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const f = await isolatedWorkspace(browser, info);
  try {
    const now = Date.now(), officialDeadline = new Date(now + 72 * 60 * 60_000).toISOString();
    await mkdir(".runtime/previews", { recursive: true });
    const card = await seedCompetition(f, officialDeadline);
    const context = await f.attach(await browser.newContext({ baseURL: f.origin, viewport: { width: 375, height: 844 } }), false);
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const observed: { method: string; path: string }[] = [];
    context.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) observed.push({ method: request.method(), path: url.pathname.slice(8).replace(/invitations\/[^/]+/, "invitations/[token]") });
    });

    await test.step("First introduction and public route map explain the whole process without creating progress", async () => {
      await page.goto("/");
      const introduction = page.getByRole("dialog");
      await expect(introduction.getByRole("heading", { name: "欢迎来到黑客松情报局", exact: true })).toBeVisible();
      await introduction.getByRole("button", { name: "稍后再看", exact: true }).click();
      await page.getByRole("link", { name: /看完整参赛路线图/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "参赛路线图", exact: true })).toBeVisible();
      await expect(page.locator("main")).toContainText(/通用.*指南|准备指南/);
      await expect(page.locator("main")).toContainText("注意事项");
      await expect(page.locator('main input[type="checkbox"]')).toHaveCount(0);
      expect((await f.database.query("SELECT id FROM projects_project")).rowCount).toBe(0);
      await noOverflow(page);
      await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "找比赛", exact: true }).click();
    });

    await test.step("Read competition evidence and keep the selected event through registration", async () => {
      const view = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(view).toContainText("AI 分析 · 未人工核验");
      await expect(view.getByRole("link", { name: "查看报名入口（新窗口）", exact: true })).toHaveAttribute("href", registrationUrl);
      await view.getByText("查看分析依据", { exact: true }).click();
      await expect(view).toContainText("隔离练习公告");
      await view.getByRole("link", { name: "制定我的参赛计划", exact: true }).click();
      const selectedPath = `/participation?event=${encodeURIComponent(card.id)}`;
      await expect(page).toHaveURL(url => url.pathname + url.search === selectedPath);
      await expect(page.getByRole("heading", { name: "登录后开始准备", exact: true })).toBeVisible();
      const register = page.locator('[aria-label="账号操作"]').getByRole("link", { name: "注册", exact: true });
      await expect(register).toHaveAttribute("href", `/register?returnTo=${encodeURIComponent(selectedPath)}`);
      await register.click();
      await page.getByLabel("姓名 / 昵称", { exact: true }).fill("第一次参赛的小林");
      await page.getByLabel("邮箱", { exact: true }).fill("novice-first-time@example.test");
      await page.getByRole("button", { name: "获取注册验证码", exact: true }).click();
      await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
      await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode("novice-first-time@example.test"));
      await page.getByRole("button", { name: "验证邮箱并注册 / 登录", exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname + url.search === selectedPath);
      const guide = page.getByRole("dialog", { name: "第一次参赛，先认识网站", exact: true });
      await expect(guide).toBeVisible();
      for (let step = 1; step < 6; step++) {
        await expect(guide).toContainText(`网站使用指引 · 第 ${step} / 6 步`);
        await guide.getByRole("button", { name: "下一步", exact: true }).click();
        await expect(guide).toContainText(`网站使用指引 · 第 ${step + 1} / 6 步`);
      }
      await guide.getByRole("button", { name: "了解了，继续刚才的操作", exact: true }).click();
      await expect(guide).not.toBeVisible();
      await expect(page).toHaveURL(url => url.pathname + url.search === selectedPath);
      await expect(page.getByRole("heading", { name: "这次，准备参加哪场比赛", exact: true })).toBeVisible();
      await expect(page.locator("main")).toContainText(name);
      await expect(page.locator("main")).toContainText("是否第一次参加黑客松");
      await noOverflow(page);
    });

    const owner = await browserIdentity(page, "novice-first-time@example.test");
    let project!: Project, base = "";
    await test.step("Create one team space without requiring a fixed team or an AI assessment", async () => {
      const teamContinue = page.getByRole("link", { name: "和队友一起准备？在团队空间继续 →", exact: true });
      await expect(teamContinue).toHaveAttribute("href", `/app?event=${card.id}`);
      await teamContinue.click();
      await expect(page.getByRole("heading", { name: "继续准备你选择的比赛", exact: true })).toBeVisible();
      await expect(page.getByLabel("空间名称", { exact: true })).toHaveValue(name + " · 参赛空间");
      await page.getByLabel("空间名称", { exact: true }).fill("小林的第一场 AI 黑客松");
      await page.getByLabel(/^计划完成时间/).fill(chinaTime(now + 48 * 60 * 60_000));
      await page.getByLabel("作品要解决什么问题", { exact: true }).fill("让第一次参加 AI 黑客松的人知道自己下一步要做什么。");
      await page.getByLabel("这次至少做出什么", { exact: true }).fill("一个可操作的任务列表，能显示负责人和待检查成果。");
      await page.getByRole("button", { name: "创建团队空间", exact: true }).click();
      await expect(page).toHaveURL(url => /^\/app\/projects\/[^/]+\/rules$/.test(url.pathname) && url.searchParams.get("discovery") === card.id);
      const projectId = new URL(page.url()).pathname.match(/^\/app\/projects\/([^/]+)\/rules$/)![1]!;
      project = (await f.request<ProjectDetail>(`projects/${projectId}`, "GET", undefined, owner)).project;
      base = `/app/projects/${project.id}`;
      const lead = page.getByRole("region", { name: "赛事线索草案", exact: true });
      await expect(lead.getByRole("heading", { name: "准备引用的赛事分析", exact: true })).toBeVisible();
      await expect(lead.getByRole("radio", { name, exact: true })).toBeChecked();
      await lead.getByRole("button", { name: "保存赛事线索草案", exact: true }).click();
      await expect(lead).toContainText("赛事线索草案已保存");
      expect((await f.request<{ confirmation: unknown }>(`projects/${project.id}/rules`, "GET", undefined, owner)).confirmation).toBeNull();
      await page.goto(base);
      const nav = page.getByRole("navigation", { name: "团队空间", exact: true });
      await expect(nav.getByRole("link")).toHaveText(["工作台", "队友与分工", "任务进度", "比赛与资料", "提交与复盘"]);
      await expect(page.getByRole("region", { name: "参赛阶段工作台", exact: true })).toContainText("一个人也能继续");
      await expect(page.getByRole("button", { name: "全队任务", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: ".runtime/previews/novice-ai-v2-space-new-375.png", fullPage: true });
    });

    const peer = await f.login("novice-peer@example.test", "愿意做展示的小陈"), peerPage = await f.page(peer, 375);
    peerPage.on("pageerror", error => errors.push(error.message));
    await test.step("Invite, explicitly join, choose duties and confirm real working windows", async () => {
      await page.getByRole("button", { name: "邀请队友", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "1 人", exact: true })).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: "生成邀请链接", exact: true }).click();
      const link = dialog.getByLabel("本次邀请链接", { exact: true });
      await expect(link).toHaveValue(/\/app\/join\//);
      // Simulate sharing only this isolated short-lived URL. Do not print or
      // screenshot it, and do not contact any real user through a connector.
      const joinPath = new URL(await link.inputValue()).pathname;
      await expect(dialog.getByRole("button", { name: "复制邀请链接", exact: true })).toBeVisible();
      await expect(dialog).toContainText("离开或刷新页面后无法找回");
      await dialog.getByRole("button", { name: "关闭邀请弹窗", exact: true }).click();
      await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeFocused();
      await peerPage.goto(joinPath);
      await peerPage.getByLabel("我已核对目标与角色，明确接受这条邀请。", { exact: true }).check();
      await peerPage.getByRole("button", { name: "加入团队空间", exact: true }).click();
      await expect(peerPage.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
      await expect(peerPage.locator(`a[href="${base}/team"]`).first()).toBeVisible();
      await saveAvailableTime(page, base, now + 60 * 60_000, now + 9 * 60 * 60_000);
      await saveAvailableTime(peerPage, base, now + 60 * 60_000, now + 9 * 60 * 60_000);
      for (const [person, duty] of [[page, "做出核心功能"], [peerPage, "准备路演"]] as const) {
        await person.goto(base + "/assessment");
        await person.getByRole("checkbox", { name: new RegExp(`^${duty} ·`) }).check();
        await person.getByRole("checkbox", { name: "愿意负责的工作", exact: true }).check();
        await person.getByRole("button", { name: "保存本人意愿与共享范围", exact: true }).click();
        await expect(person.getByText("本次意愿与共享范围已保存。团队确认分工后才成为正式任务安排。", { exact: true })).toBeVisible();
      }
    });

    await test.step("Saving a DSH lead never silently confirms official rules", async () => {
      await page.goto(base + "/rules");
      const lead = page.getByRole("region", { name: "赛事线索草案", exact: true });
      await expect(lead).toContainText(name);
      const unconfirmed = await f.request<{ confirmation: unknown }>(`projects/${project.id}/rules`, "GET", undefined, owner);
      expect(unconfirmed.confirmation).toBeNull();
      await page.getByLabel("已发布赛事", { exact: true }).selectOption(eventId);
      await page.getByLabel("我已阅读资格、截止、AI 使用规则和必交材料；未知事项会另行核实。", { exact: true }).check();
      await page.getByRole("button", { name: "确认本项目使用此规则版本", exact: true }).click();
      await expect(page.getByText("要求版本已确认。现有分工和计划需重新检查，不会自动覆盖。", { exact: true })).toBeVisible();
      // The rule confirmation must refresh the next action on this same page.
      // A novice should not need a reload to discover the now-available choice.
      const track = page.locator("#official-track");
      await expect(track).toContainText("按主办方统一要求分工，无需选择资源包分类作为赛道。");
      await track.getByLabel("本次选择依据", { exact: true }).fill("隔离练习规则已明确主办方未细分赛道，按统一要求准备，非工具包分类。");
      await track.getByRole("checkbox", { name: "我已核对当前规则和赛道证据，确认用于本次分工。", exact: true }).check();
      await track.getByRole("button", { name: "保存本空间赛道选择", exact: true }).click();
      await expect(track).toContainText("项目赛道选择已保存。");
      await expect(track).toContainText("已保存：统一要求");

      // A subsequent confirmation refreshes server facts without erasing a
      // draft explanation or silently adopting the new form baseline.
      const unfinishedReason = "隔离练习：尚未保存的选择说明，读取新要求时仍需保留。";
      await track.getByLabel("本次选择依据", { exact: true }).fill(unfinishedReason);
      const renewedPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/rules/confirm` && response.request().method() === "POST");
      await page.getByLabel("我已阅读资格、截止、AI 使用规则和必交材料；未知事项会另行核实。", { exact: true }).check();
      await page.getByRole("button", { name: "确认本项目使用此规则版本", exact: true }).click();
      expect((await renewedPromise).ok()).toBe(true);
      await expect(track.getByRole("button", { name: "载入最新版本", exact: true })).toBeVisible();
      await expect(track.getByLabel("本次选择依据", { exact: true })).toHaveValue(unfinishedReason);
      await expect(track.getByRole("button", { name: "保存本空间赛道选择", exact: true })).toBeDisabled();
      page.once("dialog", dialog => dialog.accept());
      await track.getByRole("button", { name: "载入最新版本", exact: true }).click();
      await expect(track.getByLabel("本次选择依据", { exact: true })).toHaveValue("");
      await track.getByLabel("本次选择依据", { exact: true }).fill("隔离练习：明确载入最新确认版本后，重新按主办方统一要求准备。");
      await track.getByRole("checkbox", { name: "我已核对当前规则和赛道证据，确认用于本次分工。", exact: true }).check();
      await track.getByRole("button", { name: "保存本空间赛道选择", exact: true }).click();
      await expect(track).toContainText("项目赛道选择已保存。");
      await noOverflow(page);
    });

    await test.step("Review and explicitly apply the human-authored plan with actual dependencies", async () => {
      const draft = await manualDraft(f, owner, peer, project.id);
      expect(draft.status, "Fixture manual draft must pass the real planner before browser confirmation").toBe("ready");
      await page.goto(base + "/plan");
      await page.getByLabel("已保存的待采用计划", { exact: true }).selectOption(draft.id);
      await page.getByRole("button", { name: "载入计划草案", exact: true }).click();
      await expect(page.getByText(/草案状态：待确认应用/)).toBeVisible();
      const beforeApply = await f.request<PlanningInput>(`projects/${project.id}/planning-input`, "GET", undefined, owner);
      expect(versionsEqual(draft.inputSnapshot, beforeApply), "Reading the plan page must not change the saved manual plan inputs").toBe(true);
      const savedState = await f.app.planningRepository.read(project.id);
      const storedPlan = savedState!.plans.find(value => value.id === draft.id)!;
      expect(versionsEqual(storedPlan.inputSnapshot, beforeApply), "Persisted JSON snapshot must equal the current input versions regardless of JSON object key order").toBe(true);
      expect(storedPlan.revision).toBe(draft.revision);
      expect(storedPlan.baseTasksRevision).toBe(savedState!.tasksRevision);
      expect(storedPlan.basePlanVersionId).toBe(savedState!.currentPlanVersionId);
      const actor = await f.app.resolveActor(new Request(f.origin + "/api/v1/me", { headers: { cookie: owner.cookie } }));
      expect(actor).not.toBeNull();
      const lockedVersions = await f.database.transaction(sql => f.app.facts.planningFacts.lockVersions(project.id, sql, actor!));
      expect(versionsEqual(draft.inputSnapshot, lockedVersions), "Read and locked plan input versions must agree").toBe(true);
      await page.getByLabel("我已检查全部负责人、截止、依赖和上方未解决问题；理解生效不表示保证按时完成。", { exact: true }).check();
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/plan-versions/${draft.id}/apply` && response.request().method() === "POST");
      await page.getByRole("button", { name: "确认应用计划", exact: true }).click();
      const applyResponse = await responsePromise;
      const applyCommand = applyResponse.request().postDataJSON() as { expectedRevision: number };
      expect(applyCommand.expectedRevision, "Browser must submit the revision of the loaded plan").toBe(storedPlan.revision);
      const applied = await applyResponse.json() as { data?: PlanVersion; error?: { code: string; message: string } };
      expect(applyResponse.ok(), `Manual plan browser confirmation: ${applied.error?.code ?? "success"}`).toBe(true);
      await expect(page.getByText(/计划已确认生效/)).toBeVisible();
      await changeStage(page, base, "preparing");
      await changeStage(page, base, "active");
      const executionPlan = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, owner);
      expect(executionPlan.inputVersionsChanged, "Recording execution phase must not invalidate the plan that was required to enter execution").toBe(false);
      await peerPage.goto(base + "/plan");
      const waiting = peerPage.locator("#task-novice-video");
      await expect(waiting).toContainText("还在等：做出一个能操作的 Demo");
      await expect(waiting).toContainText("等待时你可以先做：先准备视频脚本与开场");
      await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
      await noOverflow(peerPage);
      await peerPage.screenshot({ path: ".runtime/previews/novice-ai-v2-task-handoff-375.png", fullPage: true });
    });

    await test.step("Teammates see submitted work; review releases only the actual dependent tasks", async () => {
      await submitWork(page, base, "novice-demo");
      await peerPage.getByRole("button", { name: "读取最新进度", exact: true }).click();
      await expect(peerPage.locator("#task-novice-video").getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
      await reviewWork(peerPage, base, "novice-demo");
      await peerPage.getByRole("button", { name: "读取最新进度", exact: true }).click();
      await expect(peerPage.locator("#task-novice-video").getByRole("button", { name: "开始做", exact: true })).toBeEnabled();
      for (const [id, maker, reviewer] of [
        ["novice-script", peerPage, page], ["novice-video", peerPage, page], ["novice-integration", page, peerPage],
        ["novice-testing", peerPage, page], ["novice-material", page, peerPage], ["novice-submission", page, peerPage],
      ] as const) { await submitWork(maker, base, id); await reviewWork(reviewer, base, id); }
      const current = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, owner);
      expect(current.tasks.every(task => task.status === "done")).toBe(true);
    });

    await test.step("GitHub guidance and presentation tools preserve this space without external writes or fake generated materials", async () => {
      await changeStage(page, base, "finalizing");
      await page.goto(base + "/delivery");
      await expect(page.getByText(/GitHub 服务尚未配置/).first()).toBeVisible();
      const guide = page.getByRole("link", { name: "看 GitHub 图形教程", exact: true });
      await expect(guide).toHaveAttribute("href", `/github?projectId=${project.id}`);
      await guide.click();
      await expect(page.getByRole("heading", { name: "分支、拉取与提交，一张图看懂", exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "当前团队空间交付操作", exact: true }).getByRole("link", { name: "返回团队空间 →", exact: true })).toHaveAttribute("href", base);
      await noOverflow(page);
      for (const kind of ["roadshow", "ppt"] as const) {
        await page.goto(`/${kind}?projectId=${project.id}`);
        await expect(page.getByRole("link", { name: "返回团队空间，查看代码与提交 →", exact: true })).toHaveAttribute("href", base + "/delivery");
        await expect(page.getByLabel("选择团队空间", { exact: true })).toHaveValue(project.id);
        await page.getByRole("button", { name: "查看将带入的资料", exact: true }).click();
        await expect(page.getByRole("button", { name: "使用这些资料，继续补充", exact: true })).toBeVisible();
        // Viewing a preview does not silently overwrite the user's form.
        const projectIdea = page.getByRole("textbox", { name: /^项目想法(?: 必填)?$/ });
        await expect(projectIdea).toHaveValue("");
        await page.getByRole("button", { name: "使用这些资料，继续补充", exact: true }).click();
        await expect(projectIdea).toHaveValue(project.goal);
        await expect(page.locator("main")).toContainText(/本人账号|私人/);
        if (kind === "roadshow") await expect(page.getByRole("heading", { name: "两个原创练习案例", exact: true })).toBeVisible();
        else await expect(page.getByRole("link", { name: /Microsoft PowerPoint/ })).toHaveAttribute("href", "https://www.microsoft.com/en-us/microsoft-365/powerpoint");
        await noOverflow(page);
        await page.screenshot({ path: `.runtime/previews/novice-ai-v2-${kind}-375.png`, fullPage: true });
        await page.locator(kind === "roadshow" ? "#roadshow-input" : "#ppt-workbench").screenshot({ path: `.runtime/previews/novice-ai-v2-${kind}-input-375.png` });
      }
      expect((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount).toBe(0);
    });

    await test.step("An explicit fixture run and organizer receipt are recorded separately, then a private retrospective persists", async () => {
      await page.goto(base + "/delivery");
      await page.getByLabel("实际验收时间（北京时间）", { exact: true }).fill(chinaTime(Date.now() - 60_000));
      await page.getByLabel("验收结果", { exact: true }).selectOption("passed");
      await page.getByLabel("运行环境", { exact: true }).fill("隔离测试夹具；没有真实运行仓库代码");
      await page.getByLabel("实际验收步骤（每行一项）", { exact: true }).fill("隔离练习：检查队友任务成果\n核对必交材料练习清单");
      await page.getByLabel("验收证据或记录链接（每行一项）", { exact: true }).fill("https://example.com/novice-fixture-run-record");
      await page.getByRole("button", { name: "保存验收记录", exact: true }).click();
      await expect(page.getByText("验收记录已保存，来源为成员自报。正式提交需另外记录。", { exact: true })).toBeVisible();
      const runs = await f.request<DeliveryVerification[]>(`projects/${project.id}/delivery-verifications`, "GET", undefined, owner);
      expect(runs).toHaveLength(1);
      expect(await f.request<SubmissionRecord[]>(`projects/${project.id}/submission-records`, "GET", undefined, owner)).toEqual([]);
      await page.getByLabel("已确认的提交阶段", { exact: true }).selectOption("novice-submit");
      await expect(page.getByRole("link", { name: "打开本阶段官方提交入口（新窗口）", exact: true })).toHaveAttribute("href", submissionUrl);
      await page.getByLabel("本次提交状态", { exact: true }).selectOption("reported");
      await page.getByLabel("实际提交时间（北京时间）", { exact: true }).fill(chinaTime(Date.now() - 30_000));
      await page.getByLabel("提交依据（每行一项）", { exact: true }).fill("隔离练习回执：非真实平台提交或核验。");
      await page.getByRole("button", { name: "保存成员提交记录", exact: true }).click();
      await expect(page.getByText("提交记录已保存，网站仍以成员自报标注，不代表平台已核验。", { exact: true })).toBeVisible();
      const submissions = await f.request<SubmissionRecord[]>(`projects/${project.id}/submission-records`, "GET", undefined, owner);
      expect(submissions).toHaveLength(1); expect(submissions[0]!.status).toBe("reported");
      expect(submissions[0]!.verificationSource).toBe("user_reported");
      await changeStage(page, base, "submitted");
      await page.goto(base + "/retrospective");
      await page.getByRole("button", { name: "新建本人复盘", exact: true }).click();
      for (const question of [/原来计划交付什么/, /最大的阻塞是什么/, /哪项分工或做法最有帮助/, /哪个功能删掉了/, /下一次最想保留/]) {
        await page.getByLabel(question).fill("隔离练习：先确认核心流程；等 Demo 时先写脚本；队友检查后再交接。");
      }
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await page.getByRole("button", { name: "确认已保存的复盘", exact: true }).click();
      await expect(page.getByText("复盘已确认。修改后可保存为新的草稿。", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: /已确认 · 仅本人/ })).toBeVisible();
      await noOverflow(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(base);
      const workbench = page.getByRole("region", { name: "参赛阶段工作台", exact: true });
      await workbench.getByText("按阶段查看补充说明", { exact: true }).click();
      const supplements = workbench.locator("details").filter({ has: page.getByText("按阶段查看补充说明", { exact: true }) }).first();
      await supplements.getByRole("tab", { name: "赛后复盘", exact: true }).click();
      await expect(supplements.locator(`a[href="${base}/retrospective"]`).first()).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: ".runtime/previews/novice-ai-v2-space-finished-1280.png", fullPage: true });
    });

    const forbidden = observed.filter(value => value.method !== "GET" && /(?:navigator\/messages|participation\/plans|roadshow\/scripts|ppt\/outlines|generation-jobs|role-help-jobs|assessment-attempts|git-operations|repository-creations|github\/)/.test(value.path));
    expect(forbidden, "This novice acceptance must never trigger a paid model or external repository operation").toEqual([]);
    expect(f.externalRequests, "External links are inspected without visiting registration, submission or tools").toEqual([]);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
