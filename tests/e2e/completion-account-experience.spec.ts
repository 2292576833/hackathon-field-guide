import { expect, test, type Page } from "@playwright/test";
import type { Project, ProjectMember } from "../../src/modules/projects/model.ts";
import type { MyIntentionView, SharedIntentionsView } from "../../src/modules/projects/collaboration.ts";
import type { ParticipantProfile } from "../../src/shared/participant.ts";
import type { EventRuleVersion } from "../../src/modules/events/domain.ts";
import type { EventReview, EventCandidateSnapshot } from "../../src/modules/operations/event-review-types.ts";
import type { Correction } from "../../src/modules/operations/correction-types.ts";
import type { AuditQueryPage } from "../../src/modules/operations/audit-query-types.ts";
import type { DeliveryMaterialsView, DeliveryMaterialChecklist } from "../../src/modules/github/delivery-materials-types.ts";
import type { ExperienceCard, ReuseDraft } from "../../src/modules/retrospectives/domain.ts";
import type { DocumentView, ReuseDraftView } from "../../src/modules/retrospectives/service.ts";
import type { PlanningInput, PlanVersion, CurrentPlanningView } from "../../src/modules/planning/types.ts";
import type { TaskProposal } from "../../src/modules/planning/index.ts";
import type { OwnPlanningNotification } from "../../src/modules/planning/notification-types.ts";
import type { AccountDataOverview, OwnDataDocument } from "../../src/modules/auth/account-types.ts";
import type { ProjectSkillSelectionView, ReviewedSkillOption } from "../../src/modules/skills/project-selection.ts";
import type { SkillReviewSnapshot } from "../../src/modules/skills/publication-types.ts";
import { dispatch } from "../../src/server/router.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

// These cases render the real root UI at 375px. All API requests use real root
// handlers and an owned in-memory PGlite fixture; no component or API body mocks.
// Mail uses the fixture development mailbox. No model/GitHub operation is sent.
test.use({ trace: "off", video: "off", screenshot: "off" });
interface Detail { project: Project; membership: ProjectMember; members: ProjectMember[] }
const privateSkill = "PRIVATE_EXPERIENCE_COMPLETION：整理真实测试记录";
const privateIdea = "PRIVATE_IDEA_COMPLETION：不应作为团队经验带入";
const savedExperience = "已有空间经验：做过页面草图";
const unsavedExperience = `${savedExperience}\n尚未保存的输入：本次想先做可体验的流程`;
const falseSharing = { duties: false, experience: false, wantsAiHelp: false, helpQuestion: false };

async function space(f: IsolatedWorkspace, owner: FixtureIdentity, name = "补全验收：新人协作空间", manualDeadline = true) {
  return f.request<Project>("projects", "POST", { name, timezone: "Asia/Shanghai", goal: "交付一条可体验的流程", minimumDeliverable: "可复现的最小作品", ...(manualDeadline ? { deadline: new Date(Date.now() + 96 * 3_600_000).toISOString() } : {}) }, owner, 201);
}
async function join(f: IsolatedWorkspace, projectId: string, manager: FixtureIdentity, member: FixtureIdentity) {
  const detail = await f.request<Detail>(`projects/${projectId}`, "GET", undefined, manager);
  const invitation = await f.request<{ token: string }>(`projects/${projectId}/invitations`, "POST", { expectedRevision: detail.project.revision, role: "member", maxUses: 1 }, manager, 201);
  await f.request(`invitations/${invitation.token}/accept`, "POST", {}, member);
}
async function remove(f: IsolatedWorkspace, projectId: string, manager: FixtureIdentity, member: FixtureIdentity) {
  const detail = await f.request<Detail>(`projects/${projectId}`, "GET", undefined, manager);
  await f.request(`projects/${projectId}/members/${member.userId}`, "DELETE", { expectedRevision: detail.project.revision }, manager);
}
async function profile(f: IsolatedWorkspace, owner: FixtureIdentity, skill = privateSkill) {
  return f.request<ParticipantProfile>("me/participant-profile", "PATCH", { expectedRevision: 0, firstHackathon: true, developmentExperience: "project", city: "仅本人城市", skills: [skill], interests: ["本人私人兴趣"], projectIdea: privateIdea, availableHoursPerDay: 2, travelPreference: "local", presentationExperience: "some" }, owner);
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
async function noExternalWork(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rows).toEqual([]);
  expect(f.apiReads.filter(item => /^(POST|PATCH) .*?(?:generation-jobs|role-help-jobs|assistant\/(?:messages|feasibility)|repository-creations|git-operations|navigator\/messages)/.test(item))).toEqual([]);
}
async function admin(f: IsolatedWorkspace, identity: FixtureIdentity) {
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin'] WHERE id=$1", [identity.userId]);
}
/** Explicit synthetic official text goes through the actual manual-review,
 * approval and publication APIs. No external page was fetched or verified. */
async function publishedEvent(f: IsolatedWorkspace, identity: FixtureIdentity, forPlanning = false) {
  await admin(f, identity);
  const eventId = "completion-official-fixture", now = f.app.clock.now().toISOString(), deadline = new Date(Date.now() + 96 * 3_600_000).toISOString();
  const planningClauses = [{ key: "eligibility", statement: "合成夹具允许练习账号参赛" }, { key: "fees", statement: "合成夹具不收取参赛费用" }, { key: "team_size", statement: "合成夹具允许一至四名成员" }, { key: "ai_policy", statement: "合成夹具允许 AI 辅助，需要如实说明" }];
  const content: EventRuleVersion = {
    eventId, version: 1, createdAt: now,
    metadata: { name: "补全验收的合成赛事夹具", organizer: "隔离夹具组织者", format: "online", region: "线上", officialUrl: "https://completion.example.test/rules" },
    sources: [{ id: "official", eventId, version: 1, sourceConfigId: null, url: "https://completion.example.test/rules", kind: "official", contentHash: "b".repeat(64), fetchedAt: now, trustScope: "official_rules", status: "available" }],
    evidence: [
      { id: "material-proof", eventId, version: 1, sourceId: "official", fieldKey: "requirements.demo", excerpt: "必须提交可复现的演示说明。", locator: "#materials", rawDateText: null, verifiedBy: identity.userId, verifiedAt: now, conflictsWith: [] },
      { id: "deadline-proof", eventId, version: 1, sourceId: "official", fieldKey: "stages.submission.endsAt", excerpt: `作品提交截止 ${deadline}`, locator: "#deadline", rawDateText: deadline, verifiedBy: identity.userId, verifiedAt: now, conflictsWith: [] },
      { id: "submit-proof", eventId, version: 1, sourceId: "official", fieldKey: "stages.submission.submissionUrl", excerpt: "提交入口 https://completion.example.test/submit", locator: "#submission", rawDateText: null, verifiedBy: identity.userId, verifiedAt: now, conflictsWith: [] },
      ...(forPlanning ? planningClauses.map(item => ({ id: `planning-${item.key}`, eventId, version: 1, sourceId: "official", fieldKey: item.key, excerpt: item.statement, locator: `#${item.key}`, rawDateText: null, verifiedBy: identity.userId, verifiedAt: now, conflictsWith: [] })) : []),
    ],
    facts: forPlanning ? planningClauses.map(item => ({ ...item, status: "verified", evidenceIds: [`planning-${item.key}`] })) : ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "合成夹具明确保留未知", status: "unknown", evidenceIds: [] })),
    stages: [{ id: "submission", stageType: "submission", name: "作品提交", startsAt: null, endsAt: { rawText: deadline, timeZone: "UTC", utc: deadline, dateOnly: false, evidenceIds: ["deadline-proof"] }, submissionUrl: "https://completion.example.test/submit" }],
    requirements: [{ id: "demo", label: "可复现的演示说明", necessity: "required", stageId: "submission", evidenceIds: ["material-proof"] }], qualityFlags: forPlanning ? [] : ["missing_information"],
  };
  const review = await f.request<EventReview>("admin/event-reviews", "POST", { content }, identity, 201);
  const detail = await f.request<{ review: EventReview; candidate: EventCandidateSnapshot }>(`admin/event-reviews/${review.id}`, "GET", undefined, identity);
  const approved = await f.request<EventReview>(`admin/event-reviews/${review.id}/approve`, "POST", { expectedRevision: review.revision, expectedCandidateRevision: detail.candidate.revision,
    checkedKeys: ["eligibility", "deadlines", "fees", "deliverables", "submission"], acknowledgedUnknownKeys: detail.candidate.criticalFields.filter(field => field.state === "unknown").map(field => field.key), reason: "仅验收合成夹具的审核规则，未知项保持未知。" }, identity);
  await f.request(`admin/event-reviews/${review.id}/publish`, "POST", { expectedRevision: approved.revision, expectedCandidateRevision: detail.candidate.revision, expectedPublishedVersion: null, reason: "将合成规则发布到隔离数据库。" }, identity);
  return eventId;
}

test("375px own account experience is previewed and explicitly appended without losing existing input or sharing the private profile", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const manager = await f.login("completion-experience-manager@example.test", "空间管理员"), member = await f.login("completion-experience-member@example.test", "本人经验的新成员"), project = await space(f, manager);
    await join(f, project.id, manager, member);
    const page = await f.page(member, 375); await page.goto("/app/account");
    const accountProfile = page.getByRole("region", { name: "我的参赛画像", exact: true });
    await accountProfile.getByLabel("开发经验", { exact: true }).selectOption("project");
    await accountProfile.getByLabel("现有技能（可选）", { exact: true }).fill(privateSkill);
    await accountProfile.getByLabel("路演经验（可选）", { exact: true }).selectOption("some");
    await accountProfile.getByLabel("项目想法（可选）", { exact: true }).fill(privateIdea);
    await accountProfile.getByRole("button", { name: "保存参赛画像", exact: true }).click();
    await expect(accountProfile.getByText("参赛画像已保存。下次生成计划会使用这份资料。", { exact: true })).toBeVisible();
    const originalProfile = await f.request<ParticipantProfile>("me/participant-profile", "GET", undefined, member);
    await f.request(`projects/${project.id}/my-intention`, "PUT", { expectedRevision: 0, duties: ["design"], experience: savedExperience, wantsAiHelp: false, helpQuestion: "保留已有疑问", share: { ...falseSharing, duties: true, experience: true } }, member);
    await page.goto(`/app/projects/${project.id}/assessment`);
    const form = page.locator("#my-duties"), experience = form.getByLabel("做过什么，或希望从哪里开始（选填）", { exact: true });
    await experience.fill(unsavedExperience);
    const sharedExperience = form.getByRole("group", { name: "明确选择队友和分工 AI 能看到的字段", exact: true }).getByRole("checkbox", { name: "本人提供的经验", exact: true });
    await expect(sharedExperience).toBeChecked();
    await form.getByRole("button", { name: "带入本人经验", exact: true }).click();
    const preview = form.getByLabel("带入前的经验预览（可编辑）", { exact: true });
    await expect(preview).toHaveValue(new RegExp(privateSkill));
    await expect(experience).toHaveValue(unsavedExperience); await expect(sharedExperience).toBeChecked();
    expect(JSON.stringify(await f.request<SharedIntentionsView>(`projects/${project.id}/shared-intentions`, "GET", undefined, manager))).not.toContain(privateSkill);
    const chosen = "本人确认并编辑的经验：会整理测试记录"; await preview.fill(chosen);
    await form.getByRole("button", { name: "把预览追加到经验草稿", exact: true }).click();
    await expect(experience).toHaveValue(`${unsavedExperience}\n\n${chosen}`); await expect(sharedExperience).not.toBeChecked();
    await expect(form.getByRole("group", { name: "明确选择队友和分工 AI 能看到的字段", exact: true }).getByRole("checkbox", { name: "愿意负责的工作", exact: true })).toBeChecked();
    await form.getByRole("button", { name: "保存本人意愿与共享范围", exact: true }).click();
    await expect(form.getByText("本次意愿与共享范围已保存。团队确认分工后才成为正式任务安排。", { exact: true })).toBeVisible();
    const saved = await f.request<MyIntentionView>(`projects/${project.id}/my-intention`, "GET", undefined, member);
    expect(saved.intention?.experience).toBe(`${unsavedExperience}\n\n${chosen}`); expect(saved.intention?.share.experience).toBe(false);
    expect(JSON.stringify(await f.request<SharedIntentionsView>(`projects/${project.id}/shared-intentions`, "GET", undefined, manager))).not.toContain(chosen);
    expect(await f.request<ParticipantProfile>("me/participant-profile", "GET", undefined, member)).toEqual(originalProfile);
    await sharedExperience.check(); await form.getByRole("button", { name: "保存本人意愿与共享范围", exact: true }).click();
    await expect.poll(async () => JSON.stringify(await f.request<SharedIntentionsView>(`projects/${project.id}/shared-intentions`, "GET", undefined, manager))).toContain(chosen);
    await noOverflow(page); await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px revoked membership clears an in-flight experience preview and its late real response cannot restore the form", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info); let release = () => {};
  try {
    const manager = await f.login("completion-revoke-manager@example.test", "撤权管理员"), member = await f.login("completion-revoke-member@example.test", "待核对经验的成员"), project = await space(f, manager);
    await join(f, project.id, manager, member); await profile(f, member);
    const page = await f.page(member, 375); await page.goto(`/app/projects/${project.id}/assessment`);
    const form = page.locator("#my-duties"); await expect(form.getByRole("button", { name: "带入本人经验", exact: true })).toBeEnabled();
    let signalReady = () => {}; const ready = new Promise<void>(resolve => { signalReady = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
    await page.context().route("**/api/v1/me/participant-profile", async route => {
      const request = route.request(); const response = await dispatch(f.app, new Request(request.url(), { method: request.method(), headers: await request.allHeaders() }), ["me", "participant-profile"]);
      const body = await response.text(); signalReady(); await hold;
      // An unmounted form aborts this request; either fulfillment or cancellation is acceptable.
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
    });
    await form.getByRole("button", { name: "带入本人经验", exact: true }).click(); await ready;
    await remove(f, project.id, manager, member);
    await form.getByRole("button", { name: "检查本人新版本", exact: true }).click();
    await expect(form.getByRole("button", { name: "带入本人经验", exact: true })).toHaveCount(0);
    release(); await expect(form.getByLabel("带入前的经验预览（可编辑）", { exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(privateSkill);
    expect((await f.database.query("SELECT user_id FROM projects_member_intention WHERE project_id=$1", [project.id])).rows).toEqual([]);
    await noOverflow(page); await noExternalWork(f);
  } finally { release(); await f.close(); }
});

test("375px personal experience library retains selected references across reload and deletion does not remove the source", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("completion-library-owner@example.test", "保存经验的本人"), outsider = await f.login("completion-library-outsider@example.test", "其他账号"), source = await space(f, owner, "经验来源空间"), target = await space(f, owner, "下一场练习空间");
    const page = await f.page(owner, 375); await page.goto(`/app/projects/${source.id}/retrospective`);
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "经验卡与选择性复用", exact: true }) }).first();
    await panel.getByRole("button", { name: "新建经验卡", exact: true }).click();
    const editor = panel.locator("section").filter({ has: page.getByRole("heading", { name: "写下一张经验卡", exact: true }) });
    const title = "私人经验：先验证再录制";
    for (const [label, text] of [["标题", title], ["遇到什么问题", "演示录制前才发现流程无法重复"], ["建议步骤（每行一项）", "先记录复现步骤\n实际检查通过后再录制"], ["什么条件下适用", "有可以运行并复现的最小流程"], ["不适用的情况和未知项", "不能替代新比赛要求、权限与时间核对"]]) await editor.getByLabel(label, { exact: true }).fill(text);
    await expect(editor.getByLabel("分享范围", { exact: true })).toHaveValue("personal");
    await editor.getByRole("button", { name: "保存经验草案", exact: true }).click();
    const persisted = panel.locator("section").filter({ has: page.getByRole("heading", { name: "编辑已保存经验", exact: true }) });
    await persisted.getByRole("checkbox", { name: "我已核对已保存经验的适用条件、限制和分享范围。", exact: true }).check();
    await persisted.getByRole("button", { name: "确认已保存经验", exact: true }).click();
    await expect.poll(async () => (await f.request<{ items: DocumentView<ExperienceCard>[] }>(`projects/${source.id}/experience-cards`, "GET", undefined, owner)).items[0]?.status).toBe("confirmed");
    const cards = await f.request<{ items: DocumentView<ExperienceCard>[] }>(`projects/${source.id}/experience-cards`, "GET", undefined, owner); const card = cards.items[0]!;
    expect(card.document?.status).toBe("confirmed");
    await f.request(`experience-cards/${card.id}`, "GET", undefined, outsider, 404);
    await page.goto("/app/experience"); await page.getByRole("button", { name: `${title} · 已确认 · 版本 ${card.revision}`, exact: true }).click();
    await page.getByLabel("选择复用目标", { exact: true }).selectOption(target.id);
    const picker = page.getByRole("region", { name: "选择经验，创建新草稿", exact: true });
    await picker.getByRole("checkbox", { name: "建议步骤", exact: true }).check();
    await expect(picker.getByRole("button", { name: "创建个人复用草稿", exact: true })).toBeDisabled();
    await picker.getByRole("checkbox", { name: "我会在新项目中重新核验这些条件，确认后再使用。", exact: true }).check();
    await picker.getByRole("button", { name: "创建个人复用草稿", exact: true }).click();
    await expect(picker.getByRole("button", { name: "草稿已创建", exact: true })).toBeVisible();
    const reuses = await f.request<{ items: ReuseDraftView[] }>("experience-reuses", "GET", undefined, owner); const reuse = reuses.items[0]!;
    expect(reuse.draft.selectedFields).toEqual(["advice"]); expect(Object.keys(reuse.selectedContent!)).toEqual(["advice"]);
    await page.reload(); await page.getByRole("button", { name: "复用草案", exact: true }).click();
    await expect(page.getByRole("heading", { name: `个人复用草案 · ${reuse.draft.id}`, exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "删除这份本人私人记录及其历史；删除后不能从这里恢复。", exact: true }).check();
    await page.getByRole("button", { name: "删除本人记录", exact: true }).click();
    await expect(page.getByRole("heading", { name: `个人复用草案 · ${reuse.draft.id}`, exact: true })).toHaveCount(0);
    expect((await f.request<DocumentView<ExperienceCard>>(`experience-cards/${card.id}`, "GET", undefined, owner)).document?.content.title).toBe(title);
    expect((await f.request<{ items: ReuseDraft[] }>(`projects/${target.id}/experience-reuses`, "GET", undefined, owner)).items).toEqual([]);
    await noOverflow(page); await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px material checklist stores actual locations and immutable versions without inventing a branch or submission success", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const manager = await f.login("completion-material-manager@example.test", "材料管理员"), member = await f.login("completion-material-member@example.test", "查看材料的成员"), project = await space(f, manager), eventId = await publishedEvent(f, manager);
    await join(f, project.id, manager, member);
    await f.request(`projects/${project.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision: 0 }, manager);
    const page = await f.page(manager, 375); await page.goto(`/app/projects/${project.id}/delivery`);
    const panel = page.locator("#delivery-materials"), material = panel.getByRole("group", { name: "可复现的演示说明 · 必交", exact: true });
    await expect(material).toBeVisible(); await expect(panel.getByText(/分支要求未知/).first()).toBeVisible();
    await material.getByLabel("实际材料位置或 HTTPS 链接", { exact: true }).fill("docs/isolated-demo-v1.md");
    await material.getByLabel("材料修订或版本", { exact: true }).fill("隔离说明修订 1");
    await panel.getByRole("button", { name: "保存材料清单", exact: true }).click();
    await expect(panel.getByRole("button", { name: "保存新的材料清单版本", exact: true })).toBeVisible();
    const before = await f.request<DeliveryMaterialsView>(`projects/${project.id}/delivery-materials`, "GET", undefined, manager);
    expect(before.current?.version).toBe(1); expect(before.current?.entries[0]).toMatchObject({ location: "docs/isolated-demo-v1.md", revision: "隔离说明修订 1", verification: null });
    expect(before.requirements?.requiredBranch.status).toBe("unknown");
    await material.getByLabel("实际材料位置或 HTTPS 链接", { exact: true }).fill("未保存的本地修订，不允许被轮询覆盖");
    await f.request<DeliveryMaterialChecklist>(`projects/${project.id}/delivery-materials`, "PUT", { expectedVersion: 1, eventId, requirementsVersion: before.requirements!.requirementsVersion, repositoryCommitSha: null,
      entries: [{ requirementId: "demo", location: "docs/isolated-demo-v2.md", revision: "另一个页面保存的修订 2", repositoryCommitSha: null, verification: null }], branchVerification: null, idempotencyKey: "completion-material-concurrent" }, manager);
    await panel.getByRole("button", { name: "重新读取材料与规则", exact: true }).click();
    await expect(panel.getByText(/材料或确认规则已更新/)).toBeVisible();
    await expect(material.getByLabel("实际材料位置或 HTTPS 链接", { exact: true })).toHaveValue("未保存的本地修订，不允许被轮询覆盖");
    await expect(panel.getByRole("button", { name: "保存新的材料清单版本", exact: true })).toBeDisabled();
    const history = await f.request<DeliveryMaterialsView>(`projects/${project.id}/delivery-materials`, "GET", undefined, manager);
    expect(history.history.map(record => record.version).sort()).toEqual([1, 2]); expect(history.history.find(record => record.version === 1)).toEqual(before.current);
    const memberPage = await f.page(member, 375); await memberPage.goto(`/app/projects/${project.id}/delivery`);
    await expect(memberPage.locator("#delivery-materials").getByRole("button", { name: "保存新的材料清单版本", exact: true })).toBeDisabled();
    expect(await f.request(`projects/${project.id}/submission-records`, "GET", undefined, manager)).toEqual([]);
    await noOverflow(page); await noOverflow(memberPage); await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px correction processing creates real metadata audit and revoking admin hides old rows without changing the original feedback", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const operator = await f.login("completion-audit-admin@example.test", "核查管理员"), author = await f.login("completion-correction-author@example.test", "提出纠错的本人"), outsider = await f.login("completion-correction-other@example.test", "其他账号"), eventId = await publishedEvent(f, operator);
    const correction = await f.request<Correction>("corrections", "POST", { target: { kind: "event", entityId: eventId, version: 1 }, field: "合成赛事的材料说明", message: "PRIVATE_CORRECTION_COMPLETION：请核对演示说明是否必须提供复现步骤", evidenceUrls: ["https://completion.example.test/rules#materials"] }, author, 201);
    const page = await f.page(operator, 375); await page.goto("/admin");
    await page.getByRole("button", { name: "统一纠错", exact: true }).click();
    await page.getByLabel("纠错 ID", { exact: true }).fill(correction.id); await page.getByRole("button", { name: "加载纠错", exact: true }).click();
    await page.getByLabel("下一处理状态", { exact: true }).selectOption("triaging");
    const response = "站内已开始核查原文；尚未修改公开规则"; await page.getByLabel("站内处理说明", { exact: true }).fill(response);
    await page.getByRole("button", { name: "保存处理结果", exact: true }).click();
    await expect(page.getByText(`最近回复：${response}`, { exact: true })).toBeVisible();
    const own = await f.request<Correction>(`me/corrections/${correction.id}`, "GET", undefined, author);
    expect(own).toMatchObject({ status: "triaging", revision: 2, response }); expect(own.original).toEqual(correction.original);
    await f.request(`me/corrections/${correction.id}`, "GET", undefined, outsider, 404);
    await page.getByRole("button", { name: "操作记录", exact: true }).click();
    const audit = page.locator("section").filter({ has: page.getByRole("heading", { name: "运营审计", exact: true }) }).first();
    await audit.getByRole("combobox", { name: "对象类型", exact: true }).selectOption("correction"); await audit.getByRole("textbox", { name: "对象标识", exact: true }).fill(correction.id); await audit.getByRole("button", { name: "查询记录", exact: true }).click();
    await expect(audit.getByRole("table")).toContainText("correction_triaging");
    await expect(audit).not.toContainText(correction.original.message); await expect(audit).not.toContainText(response); await expect(audit).not.toContainText(author.email);
    const rows = await f.request<AuditQueryPage>(`admin/operations/audit?objectKind=correction&objectId=${correction.id}`, "GET", undefined, operator);
    expect(rows.items).toHaveLength(1); expect(rows.items[0]).toMatchObject({ action: "correction_triaging", objectId: correction.id, actorId: operator.userId, revision: 2 });
    const countBefore = (await f.database.query("SELECT id FROM operations_correction_transitions WHERE correction_id=$1", [correction.id])).rowCount;
    await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user'] WHERE id=$1", [operator.userId]);
    await audit.getByRole("button", { name: "查询记录", exact: true }).click();
    await expect(audit.getByRole("table")).toHaveCount(0); await expect(audit.getByRole("alert")).toContainText("管理员权限");
    await f.request(`admin/corrections/${correction.id}`, "PATCH", { expectedRevision: 2, status: "confirmed", reason: "撤权后不能写入" }, operator, 403);
    expect((await f.database.query("SELECT id FROM operations_correction_transitions WHERE correction_id=$1", [correction.id])).rowCount).toBe(countBefore);
    await noOverflow(page); await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px task reminder reads persisted risk; marking read cannot dismiss an active blocker or complete its task", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("completion-reminder-owner@example.test", "核对提醒的本人"), outsider = await f.login("completion-reminder-other@example.test", "其他账号"), project = await space(f, owner, "提醒验收空间", false);
    const eventId = await publishedEvent(f, owner, true), now = Date.now();
    await f.request(`projects/${project.id}/rules/confirm`, "POST", { eventId, rulesVersion: 1, expectedRevision: 0 }, owner);
    await f.request(`projects/${project.id}/my-availability`, "PUT", { expectedRevision: 0, timezone: "UTC", windows: [{ id: "completion-window", startsAt: new Date(now + 3_600_000).toISOString(), endsAt: new Date(now + 9 * 3_600_000).toISOString(), effectiveMinutes: 480 }] }, owner);
    const input = await f.request<PlanningInput>(`projects/${project.id}/planning-input`, "GET", undefined, owner), detail = await f.request<Detail>(`projects/${project.id}`, "GET", undefined, owner);
    const estimate = { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "隔离人工练习估时" };
    const task = (id: string, kind: TaskProposal["kind"]): TaskProposal => ({ id, projectId: project.id, title: id === "completion-blocked-task" ? "核对可复现流程" : `准备 ${kind} 成果`, priority: "must", kind, ownerMembershipId: detail.membership.membershipId, helperEfforts: [], reviewerMembershipId: null, deliverable: "可由本人实际检查的成果", acceptanceCriteria: ["按照记录能重复完成"], durationEstimate: estimate, dependencyTaskIds: [], deadlineRef: input.deadlines[0]!.id, requirementRefs: kind === "material" ? input.requirements.map(item => item.id) : [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0 });
    const tasks = [task("completion-blocked-task", "implementation"), ...input.requiredTaskKinds.filter(kind => kind !== "implementation").map(kind => task(`completion-required-${kind}`, kind))];
    const draft = await f.request<PlanVersion>(`projects/${project.id}/plan-versions`, "POST", { tasks, buffers: [{ deadlineId: input.deadlines[0]!.id, reservedMinutes: 20, basis: "实际提交留出核对时间" }], reason: "隔离手动安排", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "completion-reminder-draft" }, owner, 201);
    expect(draft.status).toBe("ready");
    await f.request(`projects/${project.id}/plan-versions/${draft.id}/apply`, "POST", { expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "completion-reminder-apply" }, owner);
    const current = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, owner), blocked = current.tasks.find(item => item.id === "completion-blocked-task")!;
    await f.request(`projects/${project.id}/tasks/${blocked.id}/progress`, "POST", { expectedRevision: blocked.revision, status: "blocked", note: "依赖环境暂时无法启动，需要协助", blocker: "启动命令未确认", remainingEstimate: estimate, evidenceRefs: [], idempotencyKey: "completion-reminder-block" }, owner, 201);
    await f.app.planningNotifications.worker.runOnce();
    const notifications = await f.request<OwnPlanningNotification[]>(`me/planning-notifications?projectId=${project.id}`, "GET", undefined, owner), notification = notifications.find(item => item.cause === "task_blocked")!;
    expect(notification).toBeDefined();
    const page = await f.page(owner, 375); await page.goto(`/app/projects/${project.id}/plan`);
    const panel = page.getByRole("region", { name: "参赛提醒", exact: true }), item = panel.locator("li").filter({ hasText: "有任务需要协助" });
    await expect(item).toContainText("未读"); await item.getByRole("button", { name: "标为已读", exact: true }).click(); await expect(item).toContainText("已读");
    const dismissResponse = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/me/planning-notifications/${notification.id}/dismiss` && result.request().method() === "POST");
    await item.getByRole("button", { name: "收起已处理提醒", exact: true }).click();
    const rejectedDismiss = await dismissResponse; expect(rejectedDismiss.status()).toBe(409); expect((await rejectedDismiss.json()).error.code).toBe("RISK_STILL_ACTIVE"); await expect(item).toBeVisible();
    const after = await f.request<OwnPlanningNotification[]>(`me/planning-notifications?projectId=${project.id}`, "GET", undefined, owner);
    expect(after.find(value => value.id === notification.id)).toMatchObject({ status: "active", dismissedAt: null });
    expect((await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, owner)).tasks.find(value => value.id === blocked.id)?.status).toBe("blocked");
    await f.request(`me/planning-notifications/${notification.id}/read`, "POST", { expectedRevision: 1 }, outsider, 404);
    await f.request("auth/logout", "POST", undefined, owner); await panel.getByRole("button", { name: "刷新提醒", exact: true }).click();
    await expect(panel.getByText("有任务需要协助", { exact: true })).toHaveCount(0);
    await noOverflow(page); await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px email change requires two fixture mailbox proofs, retains account ownership and revokes the old session", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("completion-email-current@example.test", "更换邮箱的本人"), project = await space(f, owner, "邮箱更换后仍属本人的空间");
    const original = await profile(f, owner, "EMAIL_CHANGE_OWN_PROFILE_COMPLETION"), newEmail = "completion-email-new@example.test";
    const page = await f.page(owner, 375); await page.goto("/app/account");
    const panel = page.getByRole("region", { name: "更换登录邮箱", exact: true });
    await expect(panel.getByRole("button", { name: "获取两封验证邮件", exact: true })).toBeDisabled();
    await panel.getByLabel("新的登录邮箱", { exact: false }).fill(newEmail);
    await panel.getByRole("button", { name: "获取两封验证邮件", exact: true }).click();
    const confirm = panel.getByRole("button", { name: "确认更换并退出旧登录", exact: true });
    await expect(confirm).toBeDisabled();
    const currentCode = await f.challengeCode(owner.email), newCode = await f.challengeCode(newEmail);
    expect(currentCode).not.toBe(newCode);
    await panel.getByLabel("当前邮箱验证码", { exact: false }).fill(currentCode); await expect(confirm).toBeDisabled();
    await panel.getByLabel("新邮箱验证码", { exact: false }).fill(newCode);
    await noOverflow(page); await confirm.click(); await expect(page).toHaveURL(url => url.pathname === "/login");
    expect((await f.raw("me", "GET", undefined, owner)).status).toBe(401);
    // Reauthentication uses actual login handlers and the isolated development mailbox.
    const fresh = await f.login(newEmail, "更换邮箱的本人"); expect(fresh.userId).toBe(owner.userId);
    expect(await f.request<ParticipantProfile>("me/participant-profile", "GET", undefined, fresh)).toEqual(original);
    expect((await f.request<Detail>(`projects/${project.id}`, "GET", undefined, fresh)).membership.userId).toBe(owner.userId);
    expect(JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain(currentCode);
    expect(JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain(newCode);
    await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px fixed skill selection preserves local drafts and withdrawn history without installing files or upgrading compatibility", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("completion-skill-manager@example.test", "选择技能的管理员"), member = await f.login("completion-skill-member@example.test", "只读技能的队友"), project = await space(f, owner);
    await join(f, project.id, owner, member); await admin(f, owner);
    const catalog = await f.request<{ items: ReviewedSkillOption[] }>(`projects/${project.id}/skills/catalog`, "GET", undefined, owner);
    const option = catalog.items.find(item => item.reference.kind === "skill")!; expect(option).toBeDefined();
    const ref = option.reference, purpose = "PRIVATE_LOCAL_SKILL_COMPLETION：核对可复现的演示步骤";
    const page = await f.page(owner, 375); await page.goto(`/app/projects/${project.id}/resources`);
    await page.getByText("本次项目的技能与技能包（可选）", { exact: true }).click();
    const panel = page.getByRole("region", { name: "项目技能选择", exact: true });
    await panel.getByRole("combobox", { name: "已审核的固定版本", exact: true }).selectOption(`${ref.kind}:${ref.versionId}:${ref.contentHash}:${ref.revision}`);
    await panel.getByRole("textbox", { name: "用在哪项工作、帮助完成什么", exact: true }).fill(purpose);
    await panel.getByRole("spinbutton", { name: "学习、配置和试用估算（分钟）", exact: true }).fill("30");
    await panel.getByRole("combobox", { name: "计划使用的 AI 工具", exact: true }).selectOption("codex");
    await expect(panel).toContainText("只有格式和目录的安装器声明，客户端加载与示例任务待验证。");
    await panel.getByRole("button", { name: "加入选择", exact: true }).click();
    expect((await f.request<ProjectSkillSelectionView>(`projects/${project.id}/skills`, "GET", undefined, owner)).selections).toEqual([]);
    await panel.getByRole("button", { name: "刷新已审核目录", exact: true }).click(); await expect(panel).toContainText(purpose);
    await panel.getByRole("button", { name: "保存团队技能选择", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("固定版本与用途已保存");
    const saved = await f.request<ProjectSkillSelectionView>(`projects/${project.id}/skills`, "GET", undefined, owner);
    expect(saved.selections).toEqual([{ reference: ref, purpose, learningMinutes: 30, environment: { agentId: "codex" } }]);
    const memberPage = await f.page(member, 375); await memberPage.goto(`/app/projects/${project.id}/resources`);
    await memberPage.getByText("本次项目的技能与技能包（可选）", { exact: true }).click();
    const memberPanel = memberPage.getByRole("region", { name: "项目技能选择", exact: true });
    await expect(memberPanel).toContainText(purpose); await expect(memberPanel.getByRole("button", { name: "保存团队技能选择", exact: true })).toHaveCount(0);
    await f.request(`projects/${project.id}/skills`, "PUT", { expectedRevision: saved.revision, selections: [] }, member, 403);
    const administration = await f.page(owner, 375);
    await administration.goto("/admin"); await administration.getByRole("button", { name: "技能审核", exact: true }).click();
    const review = administration.getByRole("region", { name: "技能版本审核与发布", exact: true });
    await review.getByRole("combobox", { name: "选择精确版本", exact: true }).selectOption(JSON.stringify([ref.kind, ref.id, ref.versionId]));
    await expect(review.getByRole("region", { name: "当前服务器快照", exact: true })).toContainText(ref.versionId);
    await expect(review.getByRole("button", { name: "发布已批准的精确版本", exact: true })).toBeDisabled();
    await review.getByRole("textbox", { name: "审核 / 撤回说明", exact: true }).fill("隔离验收撤回固定版本，保留本人选择历史");
    await review.getByRole("button", { name: "按当前精确快照撤回", exact: true }).click();
    await expect(review.getByRole("status")).toContainText("服务器已撤回此固定版本");
    await panel.getByRole("button", { name: "刷新已审核目录", exact: true }).click(); await expect(panel).toContainText("历史选择保留，未自动升级。");
    const after = await f.request<ProjectSkillSelectionView>(`projects/${project.id}/skills`, "GET", undefined, owner);
    expect(after.selections).toEqual(saved.selections); expect(after.availability[0]?.available).toBe(false);
    const candidate = await f.request<SkillReviewSnapshot>(`admin/skill-candidates/${ref.kind}/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.versionId)}`, "GET", undefined, owner);
    expect(candidate.state).toBe("withdrawn"); expect(candidate.evidence.behavior.status).toBe("unknown");
    expect(candidate.evidence.compatibility.every(item => item.level === "installer_declared")).toBe(true);
    expect((await f.database.query("SELECT id FROM skill_installation_plans")).rows).toEqual([]); expect((await f.database.query("SELECT id FROM skill_installation_receipts")).rows).toEqual([]);
    await noOverflow(page); await noOverflow(memberPage); await noOverflow(administration); await noExternalWork(f);
  } finally { await f.close(); }
});

test("375px account data export is owner-only and a last-manager deletion request is blocked, persisted and cancellable", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("completion-account-owner@example.test", "本人数据的所有者"), outsider = await f.login("completion-account-other@example.test", "另一个账号"), project = await space(f, owner, "必须先交还管理员的空间");
    await profile(f, owner, "OWN_EXPORT_PROFILE_COMPLETION"); await profile(f, outsider, "OTHER_EXPORT_PROFILE_COMPLETION");
    const page = await f.page(owner, 375); await page.goto("/app/account");
    const panel = page.getByRole("region", { name: "本人数据与删除申请", exact: true });
    await panel.getByRole("button", { name: "申请新的导出", exact: true }).click();
    await panel.getByRole("button", { name: "整理这份资料", exact: true }).click(); await expect(panel.getByRole("button", { name: "下载 JSON 资料", exact: true })).toBeVisible();
    const overview = await f.request<AccountDataOverview>("me/data-controls", "GET", undefined, owner); const exported = overview.exports[0]!; expect(exported.status).toBe("ready");
    const file = await f.raw(`me/data-exports/download?id=${exported.id}`, "GET", undefined, owner); expect(file.status).toBe(200); const text = await file.text(), document = JSON.parse(text) as OwnDataDocument;
    expect(document.userId).toBe(owner.userId); expect(text).toContain("OWN_EXPORT_PROFILE_COMPLETION"); expect(text).not.toContain("OTHER_EXPORT_PROFILE_COMPLETION"); expect(text).not.toContain(outsider.email); expect(text).not.toContain(owner.cookie);
    expect((await f.raw(`me/data-exports/download?id=${exported.id}`, "GET", undefined, outsider)).status).toBe(404);
    await expect(panel.getByRole("button", { name: "确认提交删除申请", exact: true })).toBeDisabled();
    await panel.getByRole("checkbox", { name: "我已阅读以上影响说明，确认提交本人账号的删除申请。", exact: true }).check(); await panel.getByRole("button", { name: "确认提交删除申请", exact: true }).click();
    await expect(panel.getByText("申请已保存，需要先处理团队空间", { exact: true })).toBeVisible();
    const blocked = await f.request<AccountDataOverview>("me/data-controls", "GET", undefined, owner);
    expect(blocked.deletionRequest?.status).toBe("blocked"); expect(blocked.deletionRequest?.impact.lastManagerProjects.map(item => item.projectId)).toContain(project.id);
    await panel.getByRole("button", { name: "取消删除申请", exact: true }).click(); await expect(panel.getByText("申请已取消", { exact: true })).toBeVisible();
    expect((await f.request<AccountDataOverview>("me/data-controls", "GET", undefined, owner)).deletionRequest?.status).toBe("cancelled");
    expect((await f.request<{ profile: { id: string } }>("me", "GET", undefined, owner)).profile.id).toBe(owner.userId);
    await noOverflow(page); await noExternalWork(f);
  } finally { await f.close(); }
});
