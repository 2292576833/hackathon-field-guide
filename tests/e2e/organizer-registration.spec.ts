import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";
import type { HostedEvent, Organization, OrganizationApplication } from "../../src/modules/organizer/index.ts";
import type { MyRegistrationView, RegistrationForm } from "../../src/modules/event-registration/index.ts";
import { createOrganizerMailAccounts, type OrganizerMailAccountMetadata } from "../../src/server/organizer-mail-accounts.ts";

// This suite must never run against the ordinary website or persistent database.
// Every browser API request uses the real root handlers in an owned SQL fixture.
test.use({ baseURL: "http://127.0.0.1:3101", actionTimeout: 15_000 });
test.skip(process.env.ORGANIZER_READY !== "1", "Requires the explicitly prepared isolated organizer page server on port 3101");
test.setTimeout(180_000);
test.beforeEach(({}, info) => {
  // The shared fixture creates its own context from project.use, so require the
  // project-level environment override as well as the suite-level page setting.
  expect(info.project.use.baseURL, "Set E2E_BASE_URL to the prepared organizer server before creating any fixture context").toBe("http://127.0.0.1:3101");
});

async function prepareOrganizer(f: IsolatedWorkspace) {
  const admin = await f.login("organizer-browser-admin@example.test", "平台审核员");
  const owner = await f.login("organizer-browser-owner@example.test", "本场负责人");
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin'],revision=revision+1 WHERE id=$1", [admin.userId]);
  const application = await f.request<OrganizationApplication>("organizer/applications", "POST", {
    name: "新手 AI 社区", kind: "community", description: "组织新人一起完成可演示的作品", contactName: "本场负责人", contactEmail: owner.email,
    evidenceText: "仅用于隔离浏览器验收的机构说明", evidenceUrls: [],
  }, owner);
  await f.request(`admin/organizer/applications/${application.id}/review`, "POST", { expectedRevision: application.revision, decision: "approved", note: "隔离验收机构已核查" }, admin);
  const organization = (await f.request<Organization[]>("organizer/organizations", "GET", undefined, owner)).find(item => item.id === application.organizationId);
  expect(organization, "Prepared owner must have an approved organization").toBeTruthy();
  return { owner, organization: organization! };
}

async function createDraft(f: IsolatedWorkspace, owner: FixtureIdentity, organizationId: string, title: string) {
  const organization = (await f.request<Organization[]>("organizer/organizations", "GET", undefined, owner)).find(item => item.id === organizationId)!;
  const now = Date.now(), at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  return f.request<HostedEvent>(`organizer/organizations/${organization.id}/events`, "POST", {
    templateKey: "online", expectedOrganizationRevision: organization.revision, title, timezone: "Asia/Shanghai", startsAt: at(48), endsAt: at(72), registrationOpensAt: at(-1), registrationClosesAt: at(24), submissionClosesAt: null,
    modules: { registration: true, teams: false, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: true, capacity: 10 }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null },
    summary: "先完成报名，再按官方安排参加", rules: "本场不需要在网站组队。报名需工作人员审核，结果在报名页查看。", location: "线上参赛",
  }, owner);
}

async function publishFixture(f: IsolatedWorkspace, owner: FixtureIdentity, draft: HostedEvent) {
  const form = await f.request<RegistrationForm>(`organizer/events/${draft.eventId}/registration-form`, "PUT", {
    expectedRevision: 0, title: "报名这场 AI 体验赛", description: "填写参赛目标，正式提交后由本场主办方审核。", changeNote: "首次设置",
    fields: [{ id: "goal", type: "text", label: "参赛目标", description: "", required: true }],
  }, owner);
  const event = await f.request<HostedEvent>(`organizer/events/${draft.eventId}/publish`, "POST", { expectedRevision: draft.revision, changeSummary: "首次开放人工审核报名" }, owner);
  return { event, form };
}

async function currentIdentity(f: IsolatedWorkspace, page: Page, email: string): Promise<FixtureIdentity> {
  const sessionName = (await page.context().cookies(f.origin)).find(cookie => cookie.httpOnly)?.name;
  const session = (await page.context().cookies(f.origin)).find(cookie => cookie.name === sessionName);
  if (!session) throw new Error("Browser registration did not install a session");
  const cookie = `${session.name}=${session.value}`;
  const me = await f.request<{ profile: { id: string } }>("me", "GET", undefined, { userId: "", cookie, email });
  return { userId: me.profile.id, cookie, email };
}

async function fitsPhone(page: Page) {
  await expect.poll(() => page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }))).toMatchObject({ viewport: 390 });
  const width = await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth));
  expect(width, "The 390px phone layout must not require horizontal scrolling").toBeLessThanOrEqual(391);
}

test("主办方先发布报名表再发布赛事；社交链接保留正确比赛，选手注册报名和人工审核完整闭环", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  const pageErrors: string[] = [];
  try {
    expect(f.origin).toBe("http://127.0.0.1:3101");
    const { owner, organization } = await prepareOrganizer(f);
    const draft = await createDraft(f, owner, organization.id, "新人 AI 首次参赛体验赛");
    const ownerPage = await f.page(owner);
    ownerPage.setDefaultTimeout(15_000);
    ownerPage.on("pageerror", error => pageErrors.push(error.message));
    const reviewPage = await ownerPage.goto(`/organizers/workspace?event=${draft.eventId}`);
    expect(reviewPage?.status(), "The prepared review server must serve the new organizer route").toBe(200);
    const workspace = ownerPage.locator('section[aria-label="主办方赛事工作台"]');
    await expect(workspace.getByLabel("当前比赛", { exact: true })).toHaveValue(draft.eventId);
    await workspace.getByRole("button", { name: "预览公开规则与发布范围", exact: true }).click();
    await expect(workspace.getByRole("heading", { name: "发布前还需要", exact: true })).toBeVisible();
    await expect(workspace.getByRole("button", { name: "确认首次发布", exact: true })).toBeDisabled();
    await expect(ownerPage.getByRole("button", { name: "复制报名链接", exact: true })).toHaveCount(0);

    await ownerPage.getByRole("link", { name: "查看报名与审核", exact: true }).click();
    await expect(ownerPage).toHaveURL(`${f.origin}/organizers/workspace/${draft.eventId}/registration`);
    const manager = ownerPage.locator('section[aria-label="主办方报名管理"]');
    await expect(manager.getByRole("heading", { name: "本场队伍管理", exact: true })).toHaveCount(0);
    await manager.getByLabel("表单标题", { exact: true }).fill("首次 AI 黑客松报名");
    await manager.getByRole("textbox", { name: "报名前说明", exact: true }).fill("无需网站组队。请填写目标，提交后等待本场审核。");
    await manager.getByRole("button", { name: "添加参赛想法", exact: true }).click();
    await manager.getByRole("button", { name: "发布本场报名表", exact: true }).click();
    await expect(manager.getByRole("status").filter({ hasText: "报名表第 1 版已发布" })).toBeVisible();
    await ownerPage.getByRole("link", { name: "比赛设置", exact: true }).click();
    await expect(ownerPage).toHaveURL(`${f.origin}/organizers/workspace?event=${draft.eventId}`);
    await workspace.getByRole("button", { name: "预览公开规则与发布范围", exact: true }).click();
    await expect(workspace.getByText("公开配置检查通过，请核对规则与期限后填写发布说明。", { exact: true })).toBeVisible();
    await workspace.getByLabel("本次发布说明 / 对参赛者的影响", { exact: true }).fill("正式开放报名，由工作人员人工审核；本场无需网站组队。");
    await workspace.getByRole("button", { name: "确认首次发布", exact: true }).click();
    await expect(workspace.getByRole("status").filter({ hasText: "正式规则 v1 已发布" })).toBeVisible();

    const share = ownerPage.locator('section[aria-label="本场报名链接"]');
    const target = `/competitions/${draft.eventId}/register`, publicUrl = `${f.origin}${target}`;
    await expect(share.getByText("报名开放中", { exact: true })).toBeVisible();
    await expect(share.getByLabel("可公开分享的报名链接", { exact: true })).toHaveValue(publicUrl);
    await expect(share.getByRole("link", { name: "查看报名与审核", exact: true })).toHaveAttribute("href", `/organizers/workspace/${draft.eventId}/registration`);
    await ownerPage.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedRegistrationUrl: string }).copiedRegistrationUrl = text; } } }));
    await share.getByRole("button", { name: "复制报名链接", exact: true }).click();
    await expect(share.getByRole("status")).toHaveText("报名链接已复制，可粘贴到微信、公众号、小红书等平台。");
    expect(await ownerPage.evaluate(() => (window as unknown as { copiedRegistrationUrl: string }).copiedRegistrationUrl)).toBe(publicUrl);

    const participant = await f.page(undefined, 390);
    participant.setDefaultTimeout(15_000);
    participant.on("pageerror", error => pageErrors.push(error.message));
    await participant.goto(publicUrl);
    const entry = participant.locator('section[aria-label="本场报名"]');
    await expect(entry.getByRole("heading", { name: "首次 AI 黑客松报名", exact: true })).toBeVisible();
    await expect(entry.getByRole("button", { name: "提交报名", exact: true })).toBeDisabled();
    await expect(entry.getByRole("link", { name: "登录后继续", exact: true })).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(target)}`);
    await entry.getByRole("link", { name: "注册账号后继续", exact: true }).click();
    await expect(participant).toHaveURL(`${f.origin}/register?returnTo=${encodeURIComponent(target)}`);
    const accountEntry = participant.getByRole("navigation", { name: "账号入口", exact: true });
    await accountEntry.getByRole("link", { name: "登录", exact: true }).click();
    await expect(participant).toHaveURL(`${f.origin}/login?returnTo=${encodeURIComponent(target)}`);
    await accountEntry.getByRole("link", { name: "注册", exact: true }).click();
    await expect(participant).toHaveURL(`${f.origin}/register?returnTo=${encodeURIComponent(target)}`);
    const email = "first-time-browser-entrant@example.test";
    await participant.getByLabel("姓名 / 昵称", { exact: true }).fill("第一次参赛的小林");
    await participant.getByLabel("邮箱", { exact: true }).fill(email);
    await participant.getByRole("button", { name: "获取注册验证码", exact: true }).click();
    await expect(participant.getByLabel("8 位验证码", { exact: true })).toBeVisible();
    await participant.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode(email));
    await participant.getByRole("button", { name: "验证邮箱并注册 / 登录", exact: true }).click();
    await expect(participant).toHaveURL(publicUrl);
    await entry.getByLabel("这次参赛想做什么（选填）", { exact: true }).fill("学会把 AI 原型做成可演示的作品");
    await entry.getByRole("button", { name: "提交报名", exact: true }).click();
    await expect(entry.getByText("等待审核", { exact: true })).toBeVisible();
    await expect(entry.getByRole("button", { name: "刷新审核结果", exact: true })).toBeVisible();
    await fitsPhone(participant);
    const identity = await currentIdentity(f, participant, email);
    expect((await f.request<MyRegistrationView>(`competitions/${draft.eventId}/my-registration`, "GET", undefined, identity)).registration?.status).toBe("pending");

    await share.getByRole("link", { name: "查看报名与审核", exact: true }).click();
    const pending = manager.locator("article").filter({ has: ownerPage.getByRole("heading", { name: `报名选手 · ${identity.userId}`, exact: true }) });
    await expect(pending.getByText("等待审核", { exact: true })).toBeVisible();
    await pending.getByText("查看本人提交的报名资料", { exact: true }).click();
    await expect(pending.getByText("学会把 AI 原型做成可演示的作品", { exact: true })).toBeVisible();
    await pending.getByRole("textbox", { name: "给选手的说明（未通过时必填）", exact: true }).fill("报名已核对，请留意本场官方安排。");
    await pending.getByRole("button", { name: "通过报名", exact: true }).click();
    await expect(manager.getByRole("status").filter({ hasText: "已批准这份报名" })).toBeVisible();
    await entry.getByRole("button", { name: "刷新审核结果", exact: true }).click();
    await expect(entry.getByText("报名已通过", { exact: true })).toBeVisible();
    await expect(entry.getByText("报名已核对，请留意本场官方安排。", { exact: false })).toBeVisible();
    await expect(entry.getByRole("link", { name: "下一步：查看本场安排", exact: true })).toHaveAttribute("href", `/competitions/${draft.eventId}`);
    await expect(entry.getByRole("link", { name: "下一步：前往本场队伍", exact: true })).toHaveCount(0);
    await expect(participant.getByRole("navigation", { name: "本场参赛流程", exact: true }).getByRole("link", { name: "我的队伍", exact: true })).toHaveCount(0);
    expect((await f.request<MyRegistrationView>(`competitions/${draft.eventId}/my-registration`, "GET", undefined, identity)).registration?.status).toBe("approved");

    await ownerPage.getByText("入选通知：编辑文字与样式", { exact: true }).click();
    const template = ownerPage.locator('section[aria-label="入选通知模板"]');
    await template.getByLabel("通知标题", { exact: true }).fill("你已入选 {event}");
    await template.getByLabel("通知正文", { exact: true }).fill("{name}，你好。\n你已通过 {event} 的报名审核。\n请查看本场官方通知与后续安排。\n{organizer}");
    await template.getByLabel("通知样式", { exact: true }).selectOption("simple");
    await template.getByLabel("强调色", { exact: true }).selectOption("green");
    await template.getByRole("button", { name: "保存本场模板", exact: true }).click();
    await expect(template.getByRole("status").filter({ hasText: "模板第 1 版已保存" })).toBeVisible();
    await manager.getByRole("combobox", { name: "当前列表", exact: true }).selectOption("approved");
    await pending.getByRole("button", { name: "查看并发布入选通知", exact: true }).click();
    const publication = ownerPage.locator('section[aria-label="为本场已通过选手发布入选通知"]');
    await expect(publication).toContainText("第一次参赛的小林");
    await publication.getByRole("button", { name: "预览并确认发布", exact: true }).click();
    await expect(publication.getByRole("button", { name: "确认发布给此选手", exact: true })).toBeDisabled();
    await publication.getByRole("checkbox", { name: "我已核对本场收件人、标题、正文和样式，确认发布站内通知；邮件服务已配置时会进入队列。", exact: true }).check();
    await publication.getByRole("button", { name: "确认发布给此选手", exact: true }).click();
    await expect(publication.getByRole("status").filter({ hasText: "站内通知第 1 版已发布" })).toHaveText("站内通知第 1 版已发布。邮件状态见下方回执。");
    const ownNotices = participant.locator('section[aria-label="我的入选通知"]');
    await ownNotices.getByRole("button", { name: "刷新本人通知", exact: true }).click();
    const record = ownNotices.getByRole("article", { name: "入选通知第 1 版", exact: true });
    await expect(record).toContainText("第一次参赛的小林，你好。");
    await expect(record.getByRole("heading", { name: `你已入选 ${draft.title}`, exact: true })).toBeVisible();
    await expect(record).toContainText("新手 AI 社区");
    await expect(record).toContainText("请查看本场官方通知与后续安排。");
    await expect(record.getByText("邮件未配置", { exact: true })).toBeVisible();
    expect((await f.database.query("SELECT id FROM organizer_selection_notices WHERE event_id=$1 AND recipient_user_id=$2", [draft.eventId, identity.userId])).rowCount).toBe(1);
    expect((await f.database.query("SELECT id FROM organizer_notification_outbox")).rowCount).toBe(0);
    await fitsPhone(participant);
    await participant.screenshot({ path: info.outputPath("participant-approved-mobile.png"), fullPage: true });
    await entry.getByRole("link", { name: "下一步：查看本场安排", exact: true }).click();
    const next = participant.locator('section[aria-label="当前下一步"]');
    await expect(next).toContainText("本场不需要在网站组队");
    await expect(next.getByRole("link", { name: "查看官方通知", exact: true })).toHaveAttribute("href", `/competitions/${draft.eventId}/help`);
    expect(f.externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await f.close(); }
});

test("手机分享入口使用已发布规则；复制失败仍选中可手动复制的链接，并正确切换比赛", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    expect(f.origin).toBe("http://127.0.0.1:3101");
    const { owner, organization } = await prepareOrganizer(f);
    const first = await publishFixture(f, owner, await createDraft(f, owner, organization.id, "公开报名：AI 学习赛"));
    const second = await publishFixture(f, owner, await createDraft(f, owner, organization.id, "另一场：创意体验赛"));
    await f.request(`organizer/events/${first.event.eventId}`, "PATCH", {
      expectedRevision: first.event.revision, title: "尚未公开的比赛改名", timezone: first.event.timezone,
      startsAt: first.event.startsAt, endsAt: first.event.endsAt, registrationOpensAt: first.event.registrationOpensAt,
      registrationClosesAt: first.event.registrationClosesAt, submissionClosesAt: first.event.submissionClosesAt,
      modules: first.event.modules, registration: { reviewRequired: false, capacity: 1 }, teams: first.event.teams,
      summary: first.event.summary, rules: first.event.rules, location: first.event.location,
    }, owner);
    const page = await f.page(owner, 390);
    page.setDefaultTimeout(15_000);
    const reviewPage = await page.goto(`/organizers/workspace?event=${first.event.eventId}`);
    expect(reviewPage?.status(), "The prepared review server must serve the new organizer route").toBe(200);
    const share = page.locator('section[aria-label="本场报名链接"]');
    const firstUrl = `${f.origin}/competitions/${first.event.eventId}/register`;
    await expect(share).toContainText("公开报名：AI 学习赛");
    await expect(share).not.toContainText("尚未公开的比赛改名");
    await expect(share).toContainText("本场需要主办方审核");
    await expect(share.getByLabel("可公开分享的报名链接", { exact: true })).toHaveValue(firstUrl);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Browser clipboard denied for regression fixture"); } } }));
    await share.getByRole("button", { name: "复制报名链接", exact: true }).click();
    await expect(share.getByRole("status")).toHaveText("浏览器未允许自动复制，请长按或右键复制上方只读链接。");
    const selected = await share.getByLabel("可公开分享的报名链接", { exact: true }).evaluate((element: HTMLInputElement) => ({ start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element, length: element.value.length }));
    expect(selected).toEqual({ start: 0, end: firstUrl.length, focused: true, length: firstUrl.length });
    await fitsPhone(page);
    await page.screenshot({ path: info.outputPath("organizer-share-mobile.png"), fullPage: true });
    await page.getByLabel("当前比赛", { exact: true }).selectOption(second.event.eventId);
    const secondUrl = `${f.origin}/competitions/${second.event.eventId}/register`;
    await expect(share.getByLabel("可公开分享的报名链接", { exact: true })).toHaveValue(secondUrl);
    await expect(share.getByRole("link", { name: "查看报名与审核", exact: true })).toHaveAttribute("href", `/organizers/workspace/${second.event.eventId}/registration`);
    await expect(share.getByRole("link", { name: "查看报名页", exact: true })).toHaveAttribute("href", `/competitions/${second.event.eventId}/register`);
    await fitsPhone(page);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("主办方自配发信入口易找；认证失败可恢复，授权码不回显，停用回到网站邮箱", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  let instant = Date.now(), authenticationCount = 0, sends = 0;
  const pageErrors: string[] = [];
  try {
    expect(f.origin).toBe("http://127.0.0.1:3101");
    // Keep the real service, root router, authorization and SQL. Only replace
    // the external SMTP boundary inside this owned fixture; never call a host.
    f.app.organizerMailAccounts = createOrganizerMailAccounts({
      database: f.database, clock: { now: () => new Date(instant) }, ids: f.app.ids,
      resolvePrincipal: f.app.resolvePrincipal, assertMutationAllowed: f.app.assertMutationAllowed,
      encryptionKey: createHash("sha256").update("organizer-mail-credentials:v1:").update(f.app.config.codePepper).digest(),
      requireOrganizationManager: (sql, actor, id) => f.app.organizerIntegration.organizer.requireOrganizationManager(sql, actor, id),
      getOrganization: (sql, id) => f.app.organizerIntegration.organizer.repository.getOrganization(sql, id),
      async verifyCredentials(config, { signal }) {
        authenticationCount++;
        expect(signal.aborted).toBe(false);
        expect(config.host).toBe("smtp.qq.com"); expect(config.port).toBe(465); expect(config.secure).toBe(true);
        return authenticationCount > 1;
      },
      createSmtpMailTransport() { return { async send() { sends++; throw new Error("Browser acceptance must not send mail"); } }; },
    });
    const { owner, organization } = await prepareOrganizer(f);
    const page = await f.page(owner, 390);
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`/organizers/workspace?organization=${organization.id}`);
    await page.getByText("发信邮箱：使用主办方自己的账号", { exact: true }).click();
    const settings = page.locator('section[aria-label="主办方发信邮箱设置"]');
    await expect(settings.getByRole("heading", { name: "设置自己的发信邮箱", exact: true })).toBeVisible();
    await expect(settings).toContainText("登录验证码始终由网站邮箱发送");
    await expect(settings).toContainText("尚未设置自己的邮箱 · 使用网站邮箱");
    await expect(settings.getByRole("combobox", { name: "邮箱服务", exact: true }).locator("option")).toHaveText(["QQ 邮箱", "163 邮箱", "126 邮箱", "Gmail"]);
    const email = settings.getByRole("textbox", { name: "完整发信邮箱", exact: true });
    const code = settings.getByLabel("邮箱 SMTP 授权码", { exact: true });
    const confirmation = settings.getByRole("checkbox", { name: "我确认用此邮箱发送本主办方的赛事通知，并同意验证连接和认证。", exact: true });
    const save = settings.getByRole("button", { name: "验证并保存发信邮箱", exact: true });
    const path = `organizer/organizations/${organization.id}/mail-account`;
    await expect(save).toBeDisabled();
    await email.fill("1098765432@qq.com");
    await code.fill("NOT_A_REAL_AUTHORIZATION_CODE");
    await expect(save).toBeDisabled();
    await confirmation.check();
    await save.click();
    await expect(settings.getByRole("alert")).toHaveText("邮箱连接或认证未通过，本次配置未保存，原有设置保留。请按下方官方帮助核对 SMTP 服务与授权码，再读取最新设置重试；完整邮箱已保留，授权码已清除。");
    await expect(email).toHaveValue("1098765432@qq.com");
    await expect(code).toHaveValue("");
    await expect(save).toBeDisabled();
    expect(authenticationCount).toBe(1);
    expect((await f.request<OrganizerMailAccountMetadata>(path, "GET", undefined, owner)).state).toBe("unconfigured");
    expect((await f.database.query("SELECT organization_id FROM organizer_mail_accounts")).rowCount).toBe(0);
    await settings.getByRole("button", { name: "读取最新设置，保留邮箱输入", exact: true }).click();
    await expect(settings.getByRole("button", { name: "读取最新设置，保留邮箱输入", exact: true })).toBeEnabled();
    await expect(email).toHaveValue("1098765432@qq.com");
    expect(authenticationCount, "Reading metadata must not retry SMTP authentication").toBe(1);
    instant += 60_001;
    await code.fill("NOT_A_REAL_AUTHORIZATION_CODE");
    await confirmation.check();
    await save.click();
    await expect(settings.getByRole("status").filter({ hasText: "SMTP 连接与认证已验证" })).toHaveText("SMTP 连接与认证已验证，发信邮箱已保存。没有向选手发送测试邮件；之后发布本主办方的比赛通知时采用此设置。");
    await expect(settings.getByText("使用主办方自配邮箱", { exact: true })).toBeVisible();
    await expect(settings).toContainText("1***@qq.com");
    await expect(email).toHaveValue(""); await expect(code).toHaveValue("");
    const metadata = await f.request<OrganizerMailAccountMetadata>(path, "GET", undefined, owner);
    expect(metadata).toMatchObject({ organizationId: organization.id, state: "verified", revision: 1, maskedEmail: "1***@qq.com" });
    expect(JSON.stringify(metadata)).not.toContain("NOT_A_REAL_AUTHORIZATION_CODE");
    expect(JSON.stringify(metadata)).not.toContain("1098765432@qq.com");
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes("NOT_A_REAL_AUTHORIZATION_CODE")))).toBe(false);
    expect(authenticationCount).toBe(2); expect(sends).toBe(0);
    await fitsPhone(page);
    await page.screenshot({ path: info.outputPath("organizer-sender-mobile.png"), fullPage: true });
    await settings.getByText("停用自配邮箱", { exact: true }).click();
    const disable = settings.getByRole("button", { name: "停用自配邮箱，使用网站邮箱", exact: true });
    await expect(disable).toBeDisabled();
    await settings.getByRole("checkbox", { name: "确认停用当前自配发信账号", exact: true }).check();
    await disable.click();
    await expect(settings.getByRole("status").filter({ hasText: "自配发信邮箱已停用" })).toHaveText("自配发信邮箱已停用，后续本主办方的比赛通知回到网站邮箱。网站邮箱能否发送以平台当前配置为准。");
    await expect(settings.getByText("自配邮箱已停用 · 使用网站邮箱", { exact: true })).toBeVisible();
    expect((await f.request<OrganizerMailAccountMetadata>(path, "GET", undefined, owner)).revision).toBe(2);
    expect((await f.database.query<{ credential: unknown }>("SELECT credential FROM organizer_mail_accounts WHERE organization_id=$1", [organization.id])).rows[0].credential).toBeNull();
    expect((await f.database.query<{ state: string }>("SELECT state FROM organizer_mail_verification_attempts ORDER BY sequence")).rows.map(item => item.state)).toEqual(["failed", "verified"]);
    expect(authenticationCount).toBe(2); expect(sends).toBe(0);
    await fitsPhone(page);
    expect(f.externalRequests).toEqual([]); expect(pageErrors).toEqual([]);
  } finally { await f.close(); }
});
