import { test, expect, type Page } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import type { ParticipantProfile } from "../../src/shared/participant.ts";
import type { ParticipationContext } from "../../src/modules/participation/types.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });

/** Human-authored practice data exists only in the isolated SQL fixture. Its
 * required provider field does not imply any real DSH request or organizer verification. */
async function practiceEvent(f: IsolatedWorkspace) {
  const now = new Date().toISOString();
  const source = "https://example.com/isolated-return-context-practice";
  const saved = await f.app.discoveries.save({
    canonicalUrl: source, title: "隔离练习：新人补充资料后继续准备 AI 黑客松",
    summary: "仅用于浏览器验收的人工练习赛事，不代表真实赛事或 DSH 分析结果。",
    analysis: { fit: ["练习如何填写个人资料"], risks: ["报名、日期和参赛形式未知"], preparation: ["先准备个人资料，再决定是否生成计划"], unknowns: ["官方资格和提交要求仍需核对"] },
    sources: [{ url: source, title: "人工隔离练习依据", excerpt: "这是一条人工编写的隔离测试记录，比赛日期、地点和报名均未确认。", fetchedAt: now }],
    discoveredAt: now, lastAnalyzedAt: now, provider: "dsh",
  });
  return f.app.discoveries.get(saved.id);
}

async function currentIdentity(page: Page, email: string): Promise<FixtureIdentity> {
  const current = await page.evaluate(async () => (await (await fetch("/api/v1/me", { credentials: "same-origin" })).json()).data);
  const cookie = (await page.context().cookies()).find(value => value.httpOnly && value.name === "hackathon_session");
  if (!cookie) throw new Error("The isolated email verifier did not establish a session");
  return { userId: current.profile.id, email, cookie: `${cookie.name}=${cookie.value}` };
}

async function verifyEmail(page: Page, f: IsolatedWorkspace, email: string, registration = false) {
  if (registration) await page.getByLabel(/^姓名 \/ 昵称/).fill("练习参赛新人");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByRole("button", { name: registration ? "获取注册验证码" : "获取登录验证码", exact: true }).click();
  await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
  await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode(email));
  await page.getByRole("button", { name: registration ? "验证邮箱并注册 / 登录" : "验证并登录", exact: true }).click();
}

test("a 375px novice supplements a missing profile, saves it and returns to the same selected event without AI generation", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const identity = await f.login("return-profile@example.test", "个人资料未填写的新人");
    const event = await practiceEvent(f), page = await f.page(identity, 375);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const selectedPath = `/participation?event=${event.id}`;
    await page.goto(selectedPath);
    await expect(page.getByRole("heading", { name: "这次，准备参加哪场比赛", exact: true })).toBeVisible();
    await expect(page.getByText(event.title, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "用 DSH 生成并保存参与计划", exact: true })).toBeDisabled();
    const supplement = page.getByRole("link", { name: "去补全个人画像", exact: true });
    await expect(supplement).toHaveAttribute("href", `/app/account?event=${event.id}#participant-profile`);
    await supplement.click();
    await expect(page).toHaveURL(url => url.pathname === "/app/account" && url.searchParams.get("event") === event.id && url.hash === "#participant-profile");
    await expect(page.getByRole("heading", { name: "我的参赛画像", exact: true })).toBeVisible();
    await page.getByLabel(/^是否第一次参加黑客松/).selectOption("yes");
    await page.getByLabel(/^开发经验/).selectOption("none");
    await page.getByLabel(/^常住城市/).fill("杭州");
    await page.getByLabel(/^每日可投入时间（小时）/).fill("2");
    await page.getByRole("button", { name: "保存参赛画像", exact: true }).click();
    await expect(page.getByText("参赛画像已保存。下次生成计划会使用这份资料。", { exact: true })).toBeVisible();
    const saved = await f.request<ParticipantProfile>("me/participant-profile", "GET", undefined, identity);
    expect(saved.firstHackathon).toBe(true); expect(saved.developmentExperience).toBe("none");
    expect(saved.city).toBe("杭州"); expect(saved.availableHoursPerDay).toBe(2);
    const back = page.getByRole("link", { name: "返回所选比赛，继续制定计划 →", exact: true });
    await expect(back).toHaveAttribute("href", selectedPath);
    await back.click();
    await expect(page).toHaveURL(url => url.pathname === "/participation" && url.searchParams.get("event") === event.id);
    await expect(page.getByText(event.title, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "用 DSH 生成并保存参与计划", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "去补全个人画像", exact: true })).toHaveCount(0);
    const context = await f.request<ParticipationContext>(`me/participation/context?eventId=${event.id}`, "GET", undefined, identity);
    expect(context.event.id).toBe(event.id); expect(context.profile.revision).toBe(saved.revision);
    expect(context.missingProfileFields).toEqual([]);
    expect(f.apiReads.filter(value => value === "POST me/participation/plans")).toEqual([]);
    expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rowCount).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("visitor registration keeps resource filters and later GitHub login keeps the authorized project destination", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const query = new URLSearchParams({ search: "演示 & 表单", type: "ui_visual", stage: "development", stack: "react", prerequisite: "basic_code", use: "form", costType: "unknown", sort: "verified", limit: "30", cursor: "60" });
    const resourcesPath = `/resources?${query}`, visitor = await f.page(undefined, 375);
    await visitor.goto(resourcesPath);
    await expect(visitor.getByLabel("查找工具或资料", { exact: true })).toHaveValue("演示 & 表单");
    const catalogLogin = visitor.getByRole("banner").getByRole("link", { name: "登录", exact: true });
    await expect(catalogLogin).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(resourcesPath)}`);
    await catalogLogin.click();
    await expect(visitor).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("returnTo") === resourcesPath);
    await visitor.getByRole("navigation", { name: "账号入口", exact: true }).getByRole("link", { name: "注册", exact: true }).click();
    await expect(visitor).toHaveURL(url => url.pathname === "/register" && url.searchParams.get("returnTo") === resourcesPath);
    const email = "return-catalog-registration@example.test";
    await verifyEmail(visitor, f, email, true);
    await expect(visitor).toHaveURL(url => url.pathname === "/resources" && url.search === `?${query}`);
    await expect(visitor.getByLabel("查找工具或资料", { exact: true })).toHaveValue("演示 & 表单");
    await visitor.locator("summary").filter({ hasText: "更多条件：阶段、技术栈与费用" }).click();
    await expect(visitor.getByLabel("技术栈", { exact: true })).toHaveValue("react");
    await expect(visitor.getByLabel("排序", { exact: true })).toHaveValue("verified");
    const identity = await currentIdentity(visitor, email);
    const project = await f.request<Project>("projects", "POST", { name: "隔离练习：保留 GitHub 所属空间", timezone: "Asia/Shanghai", goal: "学习保存作品版本" }, identity, 201);
    // Advance only this owned fixture's server clock past the mail resend cooldown.
    // The test does not wait or change the production clock/rate policy.
    f.app.clock.now = () => new Date(Date.now() + 90_000);
    const githubPath = `/github?projectId=${project.id}`, guest = await f.page(undefined, 375);
    await guest.goto(githubPath);
    const githubLogin = guest.getByRole("link", { name: "登录本站后回到本教程", exact: true });
    await expect(githubLogin).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(githubPath)}`);
    await githubLogin.click();
    await expect(guest).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("returnTo") === githubPath);
    await verifyEmail(guest, f, email);
    await expect(guest).toHaveURL(url => url.pathname === "/github" && url.searchParams.get("projectId") === project.id);
    await expect(guest.getByText(project.name, { exact: true })).toBeVisible();
    await expect(guest.getByRole("link", { name: "在当前空间查看代码与提交", exact: true })).toHaveAttribute("href", `/app/projects/${project.id}/delivery`);
    const returned = await currentIdentity(guest, email);
    expect(returned.userId).toBe(identity.userId);
    expect(f.apiReads.some(value => /^POST .*github/.test(value))).toBe(false);
    expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rowCount).toBe(0);
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
