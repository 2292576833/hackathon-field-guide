import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Project } from "../../src/modules/projects/model.ts";
import type { OnboardingState } from "../../src/modules/onboarding/model.ts";
import type { HostedEvent, Organization, OrganizationApplication } from "../../src/modules/organizer/index.ts";
import type { MyRegistrationView } from "../../src/modules/event-registration/index.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.skip(process.env.FIRST_LOGIN_GUIDE_READY !== "1", "Coordinator must declare the newly built guide and API ready; skipped tests are not a pass");
test.use({ trace: "off", video: "off", screenshot: "off" });

async function firstVisit(browser: Browser, f: IsolatedWorkspace, identity: FixtureIdentity, width = 1280): Promise<Page> {
  const context = await f.attach(await browser.newContext({ baseURL: f.origin, viewport: { width, height: 900 } }), false);
  const separator = identity.cookie.indexOf("=");
  await context.addCookies([{ name: identity.cookie.slice(0, separator), value: identity.cookie.slice(separator + 1), domain: new URL(f.origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  return context.newPage();
}

function guide(page: Page) { return page.getByRole("dialog", { name: "先认识网站，继续你的操作", exact: true }); }

async function completedGuideMenu(page: Page) {
  const account = page.locator('[aria-label="账号操作"]');
  await expect.poll(() => page.locator("button").filter({ hasText: /^网站使用指引$/ }).count(), { message: "Completed guide has only the account-menu replay entry" }).toBe(1);
  await expect(page.getByRole("button", { name: "重新看网站指引", exact: true })).toHaveCount(0);
  await expect(guide(page)).not.toBeVisible();
  await account.locator("summary").click();
  const replay = account.getByRole("button", { name: "网站使用指引", exact: true });
  await expect(replay).toBeVisible();
  return replay;
}

async function publishedRegistrationEvent(f: IsolatedWorkspace) {
  const admin = await f.login("guide-priority-admin@example.test", "平台审核员");
  const owner = await f.login("guide-priority-owner@example.test", "主办方负责人");
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin'],revision=revision+1 WHERE id=$1", [admin.userId]);
  const application = await f.request<OrganizationApplication>("organizer/applications", "POST", {
    name: "新人参赛指引社区", kind: "community", description: "隔离验收的新人报名活动", contactName: "主办方负责人", contactEmail: owner.email,
    evidenceText: "仅用于隔离测试的机构核查依据", evidenceUrls: [],
  }, owner);
  await f.request(`admin/organizer/applications/${application.id}/review`, "POST", { expectedRevision: application.revision, decision: "approved", note: "隔离夹具机构已核对" }, admin);
  const organization = (await f.request<Organization[]>("organizer/organizations", "GET", undefined, owner)).find(value => value.id === application.organizationId);
  expect(organization).toBeTruthy();
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const draft = await f.request<HostedEvent>(`organizer/organizations/${organization!.id}/events`, "POST", {
    templateKey: "online", expectedOrganizationRevision: organization!.revision, title: "首次参赛报名优先体验赛", timezone: "Asia/Shanghai",
    startsAt: at(48), endsAt: at(72), registrationOpensAt: at(-1), registrationClosesAt: at(24), submissionClosesAt: null,
    modules: { registration: true, teams: false, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: true, capacity: 10 }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null },
    summary: "先填写本人报名，再认识网站", rules: "本场报名需人工审核，无需网站组队。", location: "线上参赛",
  }, owner);
  await f.request(`organizer/events/${draft.eventId}/registration-form`, "PUT", {
    expectedRevision: 0, title: "先完成本场报名", description: "明确提交后等待本场审核。", changeNote: "首次设置",
    fields: [{ id: "goal", type: "text", label: "参赛目标", description: "", required: true }],
  }, owner);
  return f.request<HostedEvent>(`organizer/events/${draft.eventId}/publish`, "POST", { expectedRevision: draft.revision, changeSummary: "开放新人报名" }, owner);
}

async function finishGuide(page: Page) {
  const dialog = guide(page);
  await expect(dialog).toBeVisible();
  for (let step = 1; step <= 5; step++) {
    await expect(dialog).toContainText(`第 ${step} / 6 步`);
    await dialog.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(dialog).toContainText(`第 ${step + 1} / 6 步`);
    await expect(dialog.getByRole("button", { name: step === 5 ? "了解了，继续刚才的操作" : "下一步", exact: true })).toBeEnabled();
  }
  await dialog.getByRole("button", { name: "了解了，继续刚才的操作", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("first account completes six steps, stays at original URL, persists on another device and can replay without writes", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const identity = await f.login("guide-first@example.test", "第一次参赛");
    const page = await firstVisit(browser, f, identity), start = f.apiReads.length;
    await page.goto("/events?from=first-guide#candidate");
    await expect(guide(page)).toBeVisible();
    await expect(guide(page).getByRole("heading", { name: "找到适合你的入口", level: 3, exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").filter({ visible: true })).toHaveCount(1);
    await finishGuide(page);
    await expect(page).toHaveURL(url => url.pathname === "/events" && url.search === "?from=first-guide" && url.hash === "#candidate");
    const state = await f.request<OnboardingState>("me/onboarding", "GET", undefined, identity);
    expect(state.completedAt).not.toBeNull(); expect(state.stepIndex).toBe(5);
    const browserWrites = f.apiReads.slice(start).filter(value => !value.startsWith("GET "));
    expect(browserWrites).toEqual(Array(6).fill("POST me/onboarding"));
    expect((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM projects_project")).rows[0]?.count).toBe(0);
    await page.reload(); await completedGuideMenu(page);
    await page.locator('[aria-label="账号操作"] summary').press("Escape");
    const anotherDevice = await firstVisit(browser, f, identity, 375);
    await anotherDevice.goto("/journey");
    const replay = await completedGuideMenu(anotherDevice);
    const replayStart = f.apiReads.length;
    await replay.click();
    await finishGuide(anotherDevice);
    await expect(anotherDevice.locator('[aria-label="账号操作"] summary')).toBeFocused();
    expect(f.apiReads.slice(replayStart).filter(value => !value.startsWith("GET "))).toEqual([]);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("375px guide traps keyboard focus, supports back, pauses without completing and resumes saved step", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const identity = await f.login("guide-mobile@example.test", "手机新人"), page = await firstVisit(browser, f, identity, 375);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/app"); await expect(guide(page)).toBeVisible();
    await mkdir(".runtime/previews", { recursive: true });
    await page.screenshot({ path: ".runtime/previews/first-login-guide-375.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (let count = 0; count < 12; count++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.querySelector('dialog[open][aria-labelledby="first-login-guide-title"]')?.contains(document.activeElement))).toBe(true);
    }
    await guide(page).getByRole("button", { name: "下一步", exact: true }).click();
    await expect(guide(page)).toContainText("第 2 / 6 步");
    await expect(guide(page).getByRole("button", { name: "上一步", exact: true })).toBeEnabled();
    await guide(page).getByRole("button", { name: "上一步", exact: true }).click();
    await expect(guide(page)).toContainText("第 1 / 6 步");
    await expect(guide(page).getByRole("button", { name: "下一步", exact: true })).toBeEnabled();
    await guide(page).getByRole("button", { name: "下一步", exact: true }).click();
    await expect(guide(page).getByRole("button", { name: "稍后继续", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape"); await expect(guide(page)).not.toBeVisible();
    const paused = await f.request<OnboardingState>("me/onboarding", "GET", undefined, identity);
    expect(paused.stepIndex).toBe(1); expect(paused.completedAt).toBeNull();
    await page.reload(); await expect(page.getByRole("button", { name: "继续网站指引", exact: true })).toBeEnabled();
    await expect(guide(page)).not.toBeVisible();
    const trigger = page.getByRole("button", { name: "继续网站指引", exact: true });
    await trigger.click(); await expect(guide(page)).toContainText("第 2 / 6 步");
    await guide(page).getByRole("button", { name: "稍后继续", exact: true }).click(); await expect(trigger).toBeFocused();
  } finally { await f.close(); }
});

test("one browser's completed account does not suppress a different account's first guide", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const first = await f.login("guide-seen@example.test", "已看过"), second = await f.login("guide-unseen@example.test", "另一位新人");
    await f.request("me/onboarding", "POST", { expectedRevision: 0, stepIndex: 5, completed: true }, first);
    const page = await firstVisit(browser, f, first);
    await page.goto("/app"); await completedGuideMenu(page);
    const separator = second.cookie.indexOf("=");
    await page.context().addCookies([{ name: second.cookie.slice(0, separator), value: second.cookie.slice(separator + 1), domain: new URL(f.origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    await page.reload(); await expect(guide(page)).toBeVisible(); await expect(guide(page)).toContainText("第 1 / 6 步");
    expect((await f.request<OnboardingState>("me/onboarding", "GET", undefined, second)).completedAt).toBeNull();
  } finally { await f.close(); }
});

test("invitation first visit remains usable and resumes the guide only after entering the accepted space", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("guide-owner@example.test", "邀请人"), newcomer = await f.login("guide-invited@example.test", "被邀请新人");
    const project = await f.request<Project>("projects", "POST", { name: "新人一起参赛", timezone: "Asia/Shanghai", goal: "完成一个可演示的 AI 项目" }, owner, 201);
    const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", maxUses: 1 }, owner, 201);
    const page = await firstVisit(browser, f, newcomer, 375);
    await page.goto(`/app/join/${invitation.token}`);
    await expect(page.getByText("先处理队友邀请，进入团队空间后会继续网站指引。", { exact: true })).toBeVisible();
    await expect(guide(page)).not.toBeVisible();
    await page.getByLabel("我已核对目标与角色，明确接受这条邀请。").check();
    await page.getByRole("button", { name: "加入团队空间", exact: true }).click();
    await page.getByRole("link", { name: "进入团队空间", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/app/projects/${project.id}`);
    await expect(guide(page)).toBeVisible(); await expect(guide(page)).toContainText("第 1 / 6 步");
    expect((await f.request<OnboardingState>("me/onboarding", "GET", undefined, newcomer)).completedAt).toBeNull();
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

for (const mode of ["login", "register"] as const) {
  test(`${mode} returns to the real registration form first and manual guide keeps saved steps and form input`, async ({ browser }, info) => {
    const f = await isolatedWorkspace(browser, info);
    try {
      const event = await publishedRegistrationEvent(f), target = `/competitions/${event.eventId}/register`;
      const email = `guide-priority-${mode}@example.test`;
      if (mode === "login") {
        await f.login(email, "第一次报名的选手");
        // This owned fixture represents an existing account whose previous
        // challenge has cooled down; keep the real rate row and login handler.
        await f.database.query("UPDATE auth_rate_limits SET last_attempt_at=$1 WHERE key IN (SELECT email_rate_key FROM auth_login_challenges WHERE email=$2)", [new Date(Date.now() - 61_000).toISOString(), email]);
      }
      // Opt out of the helper's completed-tour preparation: this is a real
      // incomplete onboarding record and a real published event/form fixture.
      const context = await f.attach(await browser.newContext({ baseURL: f.origin, viewport: { width: 320, height: 900 } }), false);
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(target);
      const entry = page.locator('section[aria-label="本场报名"]');
      await expect(entry.getByRole("heading", { name: "先完成本场报名", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog").filter({ visible: true })).toHaveCount(0);
      const signIn = entry.getByRole("link", { name: mode === "login" ? "登录后继续" : "注册账号后继续", exact: true });
      await expect(signIn).toHaveAttribute("href", `/${mode}?returnTo=${encodeURIComponent(target)}`);
      await signIn.click();
      await expect(page).toHaveURL(url => url.pathname === `/${mode}` && url.searchParams.get("returnTo") === target);
      if (mode === "register") await page.getByLabel("姓名 / 昵称", { exact: true }).fill("第一次报名的选手");
      await page.getByLabel("邮箱", { exact: true }).fill(email);
      await page.getByRole("button", { name: mode === "login" ? "获取登录验证码" : "获取注册验证码", exact: true }).click();
      await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
      await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode(email));
      await page.getByRole("button", { name: mode === "login" ? "验证并登录" : "验证邮箱并注册 / 登录", exact: true }).click();
      await expect(page).toHaveURL(`${f.origin}${target}`);
      await expect(page.getByText("先完成本场报名，之后继续网站指引。", { exact: true })).toBeVisible();
      const manual = page.getByRole("button", { name: "现在看网站指引", exact: true });
      await expect(manual).toBeEnabled();
      await expect(guide(page)).not.toBeVisible();
      await expect(entry.getByLabel("参赛目标（必填）", { exact: true })).toBeEnabled();
      await entry.getByLabel("参赛目标（必填）", { exact: true }).fill("先做一个能演示的小作品");
      const beforeGuide = f.apiReads.length;
      await manual.click();
      await expect(guide(page)).toBeVisible();
      await guide(page).getByRole("button", { name: "下一步", exact: true }).click();
      await expect(guide(page)).toContainText("第 2 / 6 步");
      await expect(guide(page).getByRole("button", { name: "先完成报名", exact: true })).toBeEnabled();
      await guide(page).getByRole("button", { name: "先完成报名", exact: true }).click();
      await expect(guide(page)).not.toBeVisible();
      await expect(page).toHaveURL(`${f.origin}${target}`);
      await expect(entry.getByLabel("参赛目标（必填）", { exact: true })).toHaveValue("先做一个能演示的小作品");
      expect(f.apiReads.slice(beforeGuide).filter(value => !value.startsWith("GET "))).toEqual(["POST me/onboarding"]);
      const session = (await context.cookies(f.origin)).find(cookie => cookie.httpOnly);
      expect(session).toBeTruthy();
      const identity: FixtureIdentity = { userId: "", cookie: `${session!.name}=${session!.value}`, email };
      const saved = await f.request<OnboardingState>("me/onboarding", "GET", undefined, identity);
      expect(saved.stepIndex).toBe(1); expect(saved.completedAt).toBeNull();
      const registration = await f.request<MyRegistrationView>(`competitions/${event.eventId}/my-registration`, "GET", undefined, identity);
      expect(registration.registration).toBeNull();
      const challengePath = mode === "login" ? "login-challenges" : "registration-challenges";
      expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([
        `POST auth/${challengePath}`, `POST auth/${challengePath}/verify`, "POST me/onboarding",
      ]);
      expect((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM projects_project")).rows[0]?.count).toBe(0);
      // This explicit reload discards only the browser's unsaved test input.
      page.once("dialog", dialog => void dialog.accept());
      await page.reload();
      await expect(page.getByRole("button", { name: "继续网站指引", exact: true })).toBeEnabled();
      await expect(guide(page)).not.toBeVisible();
      expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
      expect(f.externalRequests).toEqual([]); expect(errors).toEqual([]);
    } finally { await f.close(); }
  });
}

test("failed progress save keeps the local step, retries explicitly and clears when authentication expires", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const identity = await f.login("guide-save-failure@example.test", "失败后继续"), page = await firstVisit(browser, f, identity);
    let fail = true;
    await page.route("**/api/v1/me/onboarding", async route => {
      if (route.request().method() === "POST" && fail) {
        fail = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Fixture failure" }, requestId: "guide-fault" }) });
      } else await route.fallback();
    });
    await page.goto("/app"); await expect(guide(page)).toBeVisible();
    await guide(page).getByRole("button", { name: "下一步", exact: true }).click();
    await expect(guide(page)).toContainText("第 2 / 6 步");
    await expect(guide(page).getByRole("button", { name: "重试保存进度", exact: true })).toBeVisible();
    expect((await f.request<OnboardingState>("me/onboarding", "GET", undefined, identity)).revision).toBe(0);
    await guide(page).getByRole("button", { name: "重试保存进度", exact: true }).click();
    await expect(guide(page).getByRole("button", { name: "下一步", exact: true })).toBeEnabled();
    expect((await f.request<OnboardingState>("me/onboarding", "GET", undefined, identity)).stepIndex).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("hackathon:unauthenticated")));
    await expect(guide(page)).not.toBeVisible();
    await expect(page.getByRole("button", { name: "网站使用指引", exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});
