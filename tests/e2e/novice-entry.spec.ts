import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.skip(process.env.NOVICE_ENTRY_READY !== "1", "Coordinator must provide the isolated rebuilt page server; skipped tests are not an acceptance pass");
test.use({ trace: "off", video: "off", screenshot: "off" });

function nextAction(page: Page) { return page.getByRole("region", { name: "为这次参赛创建一个空间", exact: true }); }
function creation(page: Page) { return page.locator("main details#create-project"); }
function personalPreparation(page: Page) { return page.locator("main details").filter({ has: page.locator("summary").filter({ hasText: /^个人准备（出行、路演与经验）$/ }) }); }
async function liveSpace(f: IsolatedWorkspace, owner: FixtureIdentity) {
  const project = await f.request<Project>("projects", "POST", { name: "本次真实备赛空间", timezone: "Asia/Shanghai", goal: "帮助第一次参赛者完成一条实际流程", minimumDeliverable: "可以由队友复现的网页演示" }, owner, 201);
  return f.request<Project>(`projects/${project.id}/stage`, "POST", { expectedRevision: project.revision, stage: "preparing", reason: "隔离夹具已确定作品目标，开始备赛" }, owner);
}
async function noExternalWork(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rows).toEqual([]);
}

for (const width of [320, 390, 1280]) {
  test(`${width}px first visitor sees a clear starting action and the organizer entry without a forced tour`, async ({ browser }, info) => {
    const f = await isolatedWorkspace(browser, info);
    try {
      // No remembered introduction and no account: exercise the genuine first
      // visitor state while every API uses the fixture's real root handlers.
      const context = await f.attach(await browser.newContext({ baseURL: f.origin, viewport: { width, height: 900 } }), false);
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: "主导航", exact: true });
      await expect(nav.getByRole("link")).toHaveText(["参赛指引", "找比赛", "我的参赛", "工具与资料"]);
      await expect.poll(() => f.apiReads.includes("GET navigator/intro")).toBe(true);
      await expect(page.locator('[aria-label="账号操作"]')).not.toContainText("读取账号…");
      await expect(page.getByRole("dialog").filter({ visible: true })).toHaveCount(0);
      const start = page.getByRole("link", { name: /^开始参赛指引/ });
      await expect(start).toHaveAttribute("href", "/journey");
      await expect(start).toBeInViewport({ ratio: 1 });
      const continuation = page.getByRole("link", { name: /^已有团队空间？继续参赛/ });
      await expect(continuation).toHaveAttribute("href", "/app");
      const organizer = page.locator("header").getByRole("link", { name: /^主办方入驻/ });
      await expect(organizer).toHaveAttribute("href", "/organizers");
      await expect(organizer).toBeInViewport({ ratio: 1 });
      const target = await organizer.boundingBox();
      expect(target?.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator('[aria-label="主办方办赛入口"]')).toContainText("发布报名链接、审核选手");
      const headerOverflow = await page.evaluate(() => {
        const viewport = innerWidth;
        return [...document.querySelectorAll('header nav[aria-label="主导航"] a, header a[href="/organizers"]')].map(element => {
          const rect = element.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= viewport + 1;
        });
      });
      expect(headerOverflow.every(Boolean), "All four navigation links and the organizer button remain within the viewport").toBe(true);
      expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
      await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: "instant" }));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await mkdir(".runtime/previews", { recursive: true });
      await page.screenshot({ path: `.runtime/previews/novice-home-${width}.png`, animations: "disabled" });
      await start.click();
      await expect(page).toHaveURL(url => url.pathname === "/journey");
      await expect(page.getByRole("heading", { name: "参赛路线图", level: 1, exact: true })).toBeVisible();
      const auxiliary = page.locator('main details:has(ul[aria-label$="的辅助资源"])');
      expect(await auxiliary.count()).toBeGreaterThan(0);
      for (const branch of await auxiliary.all()) await expect(branch).not.toHaveAttribute("open", "");
      expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([]);
      expect(f.externalRequests).toEqual([]); expect(errors).toEqual([]);
    } finally { await f.close(); }
  });
}

test("320px account with no space sees one creation action, opens the folded form, and creates its first real space", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("novice-entry-new-space@example.test", "第一次准备参赛");
    const page = await f.page(owner, 320);
    await page.goto("/app");
    await expect(nextAction(page)).toBeVisible();
    const form = creation(page), start = nextAction(page).getByRole("link", { name: /^创建我的参赛空间/ });
    await expect(start).toHaveAttribute("href", "#create-project");
    await expect(form).not.toHaveAttribute("open", "");
    await expect(form.getByLabel("空间名称", { exact: true })).toBeHidden();
    await expect(personalPreparation(page)).not.toHaveAttribute("open", "");
    await expect(page.getByRole("link", { name: /^进入团队空间/ })).toHaveCount(0);
    await start.click();
    await expect(form).toHaveAttribute("open", "");
    await form.getByLabel("空间名称", { exact: true }).fill("新人第一次参赛空间");
    await form.getByLabel("作品要解决什么问题（可稍后补充）", { exact: true }).fill("完成第一条可以演示的流程");
    await form.getByLabel("这次至少做出什么（可稍后补充）", { exact: true }).fill("可以打开并操作的页面");
    await form.getByRole("button", { name: "创建团队空间", exact: true }).click();
    await expect(page).toHaveURL(url => /^\/app\/projects\/[^/]+$/.test(url.pathname));
    const projects = await f.request<Project[]>("projects", "GET", undefined, owner);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "新人第一次参赛空间", goal: "完成第一条可以演示的流程", minimumDeliverable: "可以打开并操作的页面" });
    expect(new URL(page.url()).pathname).toBe(`/app/projects/${projects[0].id}`);
    expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual(["POST projects"]);
    await noExternalWork(f);
  } finally { await f.close(); }
});

test("320px account with one real unarchived space continues there while creation and personal preparation remain folded", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("novice-entry-existing-space@example.test", "继续准备的选手"), project = await liveSpace(f, owner);
    expect(project.stage).toBe("preparing");
    const page = await f.page(owner, 320);
    await page.goto("/app");
    const continuation = page.getByRole("region", { name: project.name, exact: true });
    await expect(continuation).toBeVisible();
    const start = continuation.getByRole("link", { name: /^进入团队空间/ });
    await expect(start).toHaveAttribute("href", `/app/projects/${project.id}`);
    await expect(nextAction(page)).toHaveCount(0);
    await expect(creation(page)).not.toHaveAttribute("open", "");
    await expect(creation(page).locator("summary")).toHaveText("创建另一个参赛空间");
    await expect(creation(page).getByLabel("空间名称", { exact: true })).toBeHidden();
    await expect(personalPreparation(page)).not.toHaveAttribute("open", "");
    expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
    await start.click();
    await expect(page).toHaveURL(url => url.pathname === `/app/projects/${project.id}`);
    expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([]);
    await noExternalWork(f);
  } finally { await f.close(); }
});

test("a failed space read stays an error and retries the real existing space instead of offering a first-space action", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("novice-entry-read-error@example.test", "读取失败后重试的选手"), project = await liveSpace(f, owner);
    const page = await f.page(owner, 390);
    let failRead = true, failedReads = 0;
    await page.route("**/api/v1/projects", async route => {
      if (failRead && route.request().method() === "GET") {
        failedReads++;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "FIXTURE_READ_FAILED", message: "隔离测试：暂时无法读取团队空间" } }) });
        return;
      }
      await route.fallback();
    });
    await page.goto("/app");
    await expect(page.locator("main").getByRole("alert")).toContainText("隔离测试：暂时无法读取团队空间");
    await expect(page.getByRole("button", { name: "重新读取团队空间", exact: true })).toBeEnabled();
    expect(failedReads).toBeGreaterThanOrEqual(1);
    await expect(nextAction(page)).toHaveCount(0);
    await expect(creation(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^创建我的参赛空间/ })).toHaveCount(0);
    failRead = false;
    await page.getByRole("button", { name: "重新读取团队空间", exact: true }).click();
    await expect(page.getByRole("region", { name: project.name, exact: true })).toBeVisible();
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await expect(nextAction(page)).toHaveCount(0);
    await expect(creation(page)).not.toHaveAttribute("open", "");
    expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([]);
    await noExternalWork(f);
  } finally { await f.close(); }
});

test("unsaved creation fields remain visible and intact when its disclosure is closed, until explicitly cleared", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("novice-entry-unsaved-space@example.test", "暂存创建输入的选手");
    await liveSpace(f, owner);
    const page = await f.page(owner, 320);
    await page.goto("/app");
    const form = creation(page);
    await expect(form).not.toHaveAttribute("open", "");
    await form.locator("summary").click();
    await form.getByLabel("空间名称", { exact: true }).fill("尚未创建的新空间");
    await form.getByLabel("作品要解决什么问题（可稍后补充）", { exact: true }).fill("这些文字还没有保存");
    await expect(form.locator("summary")).toContainText("有未保存填写");
    await form.locator("summary").click();
    await expect(form).toHaveAttribute("open", "");
    await expect(form.getByLabel("空间名称", { exact: true })).toBeVisible();
    await expect(form.getByLabel("空间名称", { exact: true })).toHaveValue("尚未创建的新空间");
    await expect(form.getByLabel("作品要解决什么问题（可稍后补充）", { exact: true })).toHaveValue("这些文字还没有保存");
    await form.getByRole("button", { name: "清空未保存填写", exact: true }).click();
    await expect(form).not.toHaveAttribute("open", "");
    await expect(form.locator("summary")).not.toContainText("有未保存填写");
    await form.locator("summary").click();
    await expect(form.getByLabel("空间名称", { exact: true })).toHaveValue("");
    await expect(form.getByLabel("作品要解决什么问题（可稍后补充）", { exact: true })).toHaveValue("");
    expect((await f.request<Project[]>("projects", "GET", undefined, owner))).toHaveLength(1);
    expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([]);
    await noExternalWork(f);
  } finally { await f.close(); }
});
