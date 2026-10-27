import { test, expect } from "./ux-test.ts";
import type { Locator, Page } from "@playwright/test";
import type { FixtureIdentity, IsolatedWorkspace } from "./isolated-workspace.ts";
import type { HostedEvent, Organization, OrganizationApplication } from "../../src/modules/organizer/index.ts";
import type { MyRegistrationView, RegistrationFormView } from "../../src/modules/event-registration/index.ts";

// The coordinator supplies the rebuilt, isolated page server on 3012. The auto
// workspace fixture intercepts every API through real handlers and owned SQL;
// these tests never open the production database or a second server process.
test.use({ viewport: { width: 390, height: 900 }, trace: "off", video: "off", screenshot: "off" });
test.setTimeout(180_000);
test.beforeEach(({}, info) => {
  const origin = new URL(String(info.project.use.baseURL));
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(origin.hostname);
  expect(origin.port, "Run only on the coordinator's prepared isolated page server").toBe("3012");
});

async function useIdentity(page: Page, f: IsolatedWorkspace, identity: FixtureIdentity) {
  const at = identity.cookie.indexOf("=");
  await page.context().addCookies([{ name: identity.cookie.slice(0, at), value: identity.cookie.slice(at + 1),
    domain: new URL(f.origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function visibleGuidance(page: Page, control: Locator, meaning: RegExp) {
  await expect(control).toBeVisible();
  await expect(control).toHaveAccessibleDescription(meaning);
  const ids = (await control.getAttribute("aria-describedby"))?.trim().split(/\s+/) ?? [];
  expect(ids.length, "Help must be associated with the actual control, not only a placeholder").toBeGreaterThan(0);
  for (const id of ids) await expect(page.locator(`[id="${id}"]`)).toBeVisible();
}

async function fitsPhone(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(390);
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)),
    "The form and its visible explanations must not cause horizontal scrolling").toBeLessThanOrEqual(391);
}

async function noExternalWork(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rowCount).toBe(0);
  expect((await f.database.query("SELECT id FROM organizer_notification_outbox")).rowCount).toBe(0);
}

async function approvedOrganizer(f: IsolatedWorkspace) {
  const admin = await f.login("guidance-reviewer@example.test", "隔离审核员");
  const owner = await f.login("guidance-owner@example.test", "第一次办赛的主办方");
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin'],revision=revision+1 WHERE id=$1", [admin.userId]);
  const application = await f.request<OrganizationApplication>("organizer/applications", "POST", {
    name: "新人 AI 实践社区", kind: "community", description: "帮助首次参赛者完成可演示的 AI 作品", contactName: "社区办赛负责人", contactEmail: owner.email,
    evidenceText: "仅用于隔离浏览器验收，已核对机构与申请人关系。", evidenceUrls: [],
  }, owner);
  await f.request(`admin/organizer/applications/${application.id}/review`, "POST", {
    expectedRevision: application.revision, decision: "approved", note: "隔离验收已核对授权依据",
  }, admin);
  const organization = (await f.request<Organization[]>("organizer/organizations", "GET", undefined, owner))
    .find(item => item.id === application.organizationId);
  expect(organization).toBeTruthy();
  return { owner, organization: organization! };
}

async function registrationDraft(f: IsolatedWorkspace, owner: FixtureIdentity, organization: Organization) {
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  return f.request<HostedEvent>(`organizer/organizations/${organization.id}/events`, "POST", {
    templateKey: "online", expectedOrganizationRevision: organization.revision, title: "首次 AI 参赛报名体验", timezone: "Asia/Shanghai",
    startsAt: at(48), endsAt: at(72), registrationOpensAt: at(-1), registrationClosesAt: at(24), submissionClosesAt: null,
    modules: { registration: true, teams: false, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: true, capacity: 10 }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null },
    summary: "填写分工意愿，主办方审核后参与本场活动", rules: "首次参赛者可以报名，提交后等待本场人工审核。", location: "全程线上，具体参与入口见本场官方通知。",
  }, owner);
}

test("390px first organizer understands required institution fields and submits a real application", async ({ page, workspace: f }, info) => {
  const owner = await f.login("guidance-first-applicant@example.test", "第一次申请入驻");
  await useIdentity(page, f, owner);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/organizers");
  const entry = page.locator('section[aria-label="主办方入驻"]');
  const form = entry.locator("form").filter({ has: page.getByRole("heading", { name: "申请一个组织", exact: true }) });
  await visibleGuidance(page, form.getByLabel("机构名称", { exact: true }), /实际办赛.*不要填写比赛名称/);
  await visibleGuidance(page, form.getByLabel("联系邮箱", { exact: true }), /入驻联系.*不会自动成为通知发信账号/);
  await visibleGuidance(page, form.getByLabel("活动或授权依据", { exact: true }), /与机构的关系.*办赛授权/);
  await form.getByLabel("机构名称", { exact: true }).fill("第一次办赛的学生社区");
  await form.getByLabel("机构类型", { exact: true }).selectOption("community");
  await form.getByLabel("机构简介", { exact: true }).fill("面向初学者开展 AI 应用实践和周末参赛活动。");
  await form.getByLabel("联系人", { exact: true }).fill("社区活动负责人");
  await form.getByLabel("联系邮箱", { exact: true }).fill(owner.email);
  await form.getByLabel("活动或授权依据", { exact: true }).fill("我是本社区活动负责人，由社区授权组织本次活动；当前提交文字说明供审核。");
  await fitsPhone(page);
  await form.getByRole("button", { name: "提交入驻申请", exact: true }).click();
  await expect(entry.getByRole("status").filter({ hasText: "申请已送交人工审核" })).toBeVisible();
  await expect(entry.getByText("待审核", { exact: true })).toBeVisible();
  const applications = await f.request<OrganizationApplication[]>("organizer/applications/mine", "GET", undefined, owner);
  expect(applications).toHaveLength(1);
  expect(applications[0]).toMatchObject({ name: "第一次办赛的学生社区", kind: "community", contactEmail: owner.email, status: "pending", evidenceUrls: [] });
  await noExternalWork(f); expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("organizer-application-mobile.png"), fullPage: true });
});

test("390px approved organizer follows date and location help, changes a module and saves its first real draft", async ({ page, workspace: f }, info) => {
  const { owner, organization } = await approvedOrganizer(f);
  await useIdentity(page, f, owner);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/organizers/workspace?organization=${organization.id}`);
  const workspace = page.locator('section[aria-label="主办方赛事工作台"]');
  await expect(workspace.getByLabel("当前组织", { exact: true })).toHaveValue(organization.id);
  await workspace.getByRole("button", { name: "创建比赛", exact: true }).click();
  const form = workspace.locator("form").filter({ has: page.getByRole("heading", { name: "比赛配置", exact: true }) });
  await visibleGuidance(page, form.getByLabel("比赛开始", { exact: true }), /预填日期仅供建草稿.*真实安排/);
  await visibleGuidance(page, form.getByLabel("比赛时区", { exact: true }), /Asia\/Shanghai.*北京时间/);
  await visibleGuidance(page, form.getByLabel("报名截止", { exact: true }), /作品提交截止分别设置/);
  await visibleGuidance(page, form.getByLabel("地点 / 在线参与说明", { exact: true }), /发布前需填写.*线上/);
  const at = (hours: number) => new Date(Date.now() + (hours + 8) * 3_600_000).toISOString().slice(0, 16);
  const startsAt = at(48), endsAt = at(72), registrationStarts = at(0), registrationEnds = at(24);
  await form.getByLabel("比赛名称", { exact: true }).fill("主办方第一场 AI 线上实践赛");
  await form.getByLabel("一句话简介", { exact: true }).fill("面向初次参赛者，在两天内做出可演示的 AI 小作品。");
  await form.getByLabel("比赛开始", { exact: true }).fill(startsAt);
  await form.getByLabel("比赛结束", { exact: true }).fill(endsAt);
  await form.getByLabel("报名开始", { exact: true }).fill(registrationStarts);
  await form.getByLabel("报名截止", { exact: true }).fill(registrationEnds);
  await form.getByLabel("作品提交截止", { exact: true }).fill(endsAt);
  await form.getByLabel("地点 / 在线参与说明", { exact: true }).fill("全程线上，会议入口将在本场正式通知中提供。");
  await form.getByLabel("公开比赛规则", { exact: true }).fill("初学者可以报名；每队 1 至 5 人；请在作品截止前交作品说明和演示链接，评委按已公布维度人工评审。");
  const options = form.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^调整功能、报名与组队设置$/ }) });
  await options.locator("summary").click();
  const schedule = options.getByRole("checkbox", { name: "行程", exact: true });
  await visibleGuidance(page, schedule, /时间.*地点.*适用人员/);
  await schedule.uncheck();
  await options.getByLabel("报名人数上限", { exact: true }).fill("40");
  await options.getByRole("checkbox", { name: /^报名需要人工审核/ }).check();
  await options.locator("summary").click();
  await expect(form.getByLabel("比赛名称", { exact: true })).toHaveValue("主办方第一场 AI 线上实践赛");
  await options.locator("summary").click();
  await expect(schedule).not.toBeChecked();
  await expect(options.getByLabel("报名人数上限", { exact: true })).toHaveValue("40");
  await expect(form.getByLabel("比赛开始", { exact: true })).toHaveValue(startsAt);
  await fitsPhone(page);
  await form.getByRole("button", { name: "保存比赛草稿", exact: true }).click();
  await expect(workspace.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
  const events = await f.request<HostedEvent[]>(`organizer/organizations/${organization.id}/events`, "GET", undefined, owner);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ title: "主办方第一场 AI 线上实践赛", status: "draft", timezone: "Asia/Shanghai", location: "全程线上，会议入口将在本场正式通知中提供。", modules: { schedule: false, registration: true }, registration: { reviewRequired: true, capacity: 40 } });
  expect(events[0].startsAt).toBe(new Date(`${startsAt}:00+08:00`).toISOString());
  expect(events[0].registrationClosesAt).toBe(new Date(`${registrationEnds}:00+08:00`).toISOString());
  await noExternalWork(f); expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("organizer-draft-help-mobile.png"), fullPage: true });
});

test("390px organizer writes a clear required choice question; a participant reads the same help and submits it", async ({ page, workspace: f }, info) => {
  const { owner, organization } = await approvedOrganizer(f);
  const draft = await registrationDraft(f, owner, organization);
  await useIdentity(page, f, owner);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/organizers/workspace/${draft.eventId}/registration`);
  const manager = page.locator('section[aria-label="主办方报名管理"]');
  const editor = manager.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^设置报名表$/ }) });
  await expect(editor).toHaveAttribute("open", "");
  await editor.getByLabel("表单标题", { exact: true }).fill("新人 AI 实践赛报名");
  await editor.getByLabel("报名前说明", { exact: true }).fill("请填写希望负责的工作，提交后等待本场主办方审核。");
  await editor.getByRole("button", { name: "添加一个自定义字段", exact: true }).click();
  const question = editor.locator("article").filter({ has: page.getByRole("heading", { name: /^字段 1 ·/ }) });
  await visibleGuidance(page, question.getByLabel("字段名称", { exact: true }), /选手能直接回答的问题/);
  await visibleGuidance(page, question.getByLabel("字段说明（选填）", { exact: true }), /告诉选手填什么和格式.*显示在报名表/);
  await question.getByLabel("字段名称", { exact: true }).fill("你想负责什么");
  await question.getByLabel("填写方式", { exact: true }).selectOption("choice");
  const explanation = "选一个最希望承担的工作；不需要技术经验，路演可以从介绍项目开始学习。";
  await question.getByLabel("字段说明（选填）", { exact: true }).fill(explanation);
  await question.getByLabel("选项，每行一个", { exact: true }).fill("产品\n开发\n设计\n路演");
  const required = question.getByRole("checkbox", { name: "必须填写", exact: true });
  await required.check(); await expect(required).toBeChecked();
  await required.uncheck(); await expect(required).not.toBeChecked();
  await required.check();
  await expect(question.getByLabel("字段说明（选填）", { exact: true })).toHaveValue(explanation);
  await fitsPhone(page);
  await editor.getByRole("button", { name: "发布本场报名表", exact: true }).click();
  await expect(manager.getByRole("status").filter({ hasText: "报名表第 1 版已发布" })).toBeVisible();
  const saved = await f.request<RegistrationFormView>(`organizer/events/${draft.eventId}/registration-form`, "GET", undefined, owner);
  expect(saved.form?.fields).toHaveLength(1);
  const field = saved.form!.fields[0];
  expect(field).toMatchObject({ label: "你想负责什么", description: explanation, type: "choice", required: true, options: ["产品", "开发", "设计", "路演"] });
  await f.request(`organizer/events/${draft.eventId}/publish`, "POST", { expectedRevision: draft.revision, changeSummary: "开放新人报名，请填写分工意愿并等待审核。" }, owner);
  const participant = await f.login("guidance-first-participant@example.test", "第一次参加 AI 比赛");
  const participantPage = await f.page(participant, 390);
  participantPage.on("pageerror", error => errors.push(error.message));
  await participantPage.goto(`/competitions/${draft.eventId}/register`);
  const registration = participantPage.locator('section[aria-label="本场报名"]');
  const choice = registration.getByRole("combobox", { name: /^你想负责什么（必填）/ });
  await visibleGuidance(participantPage, choice, /不需要技术经验.*路演/);
  await choice.selectOption("路演");
  await registration.getByRole("button", { name: "提交报名", exact: true }).click();
  await expect(registration.getByText("等待审核", { exact: true })).toBeVisible();
  const submitted = await f.request<MyRegistrationView>(`competitions/${draft.eventId}/my-registration`, "GET", undefined, participant);
  expect(submitted.registration).toMatchObject({ status: "pending", answers: { [field.id]: "路演" } });
  await fitsPhone(participantPage);
  await noExternalWork(f); expect(errors).toEqual([]);
  await participantPage.screenshot({ path: info.outputPath("participant-question-help-mobile.png"), fullPage: true });
});
