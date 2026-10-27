import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace, type IsolatedWorkspace } from "./isolated-workspace.ts";

// J00 must explicitly declare the rebuilt page server ready before execution.
// A skipped preparation run is not an acceptance pass. No webServer is started.
test.skip(process.env.JOURNEY_READY !== "1", "Await J00 ready; set JOURNEY_READY=1 only for the ready page server");
test.use({ trace: "off", video: "off", screenshot: "off" });

const phases = ["赛前", "赛中", "赛后"];
const requiredDestinations = ["/events", "/competitions", "/app", "/participation", "/resources", "/inspiration", "/skills", "/github", "/roadshow", "/ppt"];
// The global Navigator reads the user's own saved history and accessible-space
// list for explicit sharing. Neither GET selects a space or calls a model;
// the public guide must not carry a project-scoped conversation or detail read.
const guideReads = new Set(["GET me", "GET me/permissions", "GET me/onboarding", "GET system/status", "GET navigator/intro", "GET navigator/conversation", "GET projects"]);

async function guardOtherApis(page: Page) {
  const unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // The shared fixture already dispatches all /api/v1/* to isolated handlers.
  // Fail closed for a future endpoint outside that prefix, including popups.
  await page.context().route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/navigator/conversation" && url.searchParams.has("projectId")) {
      unexpected.push("Public guide received a project-scoped conversation read"); await route.abort("blockedbyclient");
    } else if (!url.pathname.startsWith("/api/v1/")) {
      unexpected.push("API outside isolated v1 handlers"); await route.abort("blockedbyclient");
    } else await route.fallback();
  });
  return { unexpected, errors };
}

/** Fingerprints verify saved business facts, not just equal row counts.
 * Auth session activity is separate; neither row contents nor tokens are logged. */
async function savedFacts(f: IsolatedWorkspace) {
  const tables = await f.database.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'auth_%' AND table_name<>'application_migrations' ORDER BY table_name");
  const result: Record<string, { count: string; fingerprint: string }> = {};
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Unexpected fixture table identifier");
    const rows = await f.database.query<{ count: string; fingerprint: string }>(`SELECT count(*)::text AS count, md5(COALESCE(string_agg(row_data, E'\\n' ORDER BY row_data), '')) AS fingerprint FROM (SELECT to_jsonb(t)::text AS row_data FROM "${table}" t) AS saved`);
    result[table] = rows.rows[0]!;
  }
  return result;
}

async function loadedGuide(page: Page, f: IsolatedWorkspace) {
  await expect(page.getByRole("heading", { level: 1, name: "参赛路线图", exact: true })).toBeVisible();
  await expect.poll(() => f.apiReads.includes("GET navigator/intro")).toBe(true);
  await expect(page.locator('[aria-label="账号操作"]')).not.toContainText("读取账号…");
  await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link")).toHaveText(["参赛指引", "找比赛", "我的参赛", "工具与资料"]);
}

async function assertGuideReadOnly(f: IsolatedWorkspace, readsFrom = 0) {
  const reads = f.apiReads.slice(readsFrom);
  expect(reads.filter(value => !guideReads.has(value)), "Guide may read account/status/introduction/own chat and accessible-space list; no project detail or paid actions").toEqual([]);
  expect(f.externalRequests, "No browser request may leave the loopback application").toEqual([]);
}

async function noInventedProgress(page: Page) {
  const main = page.locator("main");
  await expect(main.locator('input[type="checkbox"], [role="checkbox"], progress, [role="progressbar"], [role="tree"]')).toHaveCount(0);
  expect(await main.innerText()).not.toMatch(/\d+(?:\.\d+)?\s*[%％]|\d+\s*\/\s*\d+\s*(?:已完成|完成)|你的完成率|已为你创建/);
  const links = await main.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href")!));
  expect(links.filter(href => /\/app\/projects\/|[?&]projectId=/.test(href)), "Public guide must not invent or select a private project").toEqual([]);
  expect(links.every(href => href.startsWith("/") && !href.startsWith("//") || href.startsWith("#")), "Guide resources use real internal entries").toBe(true);
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1), { message: "Long Chinese content must wrap within the viewport" }).toBe(true);
}

async function topScreenshot(page: Page, name: string) {
  await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  const directory = join(process.cwd(), ".runtime", "previews");
  await mkdir(directory, { recursive: true });
  await expect(page.locator("main details[open]"), "Rules and phase cautions are collapsed in the top screenshots").toHaveCount(0);
  const layout = await page.evaluate(() => {
    const coordinates = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { title: element.textContent?.trim(), x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100, fullyInViewport: rect.top >= 0 && rect.bottom <= innerHeight };
    };
    return { viewport: { width: innerWidth, height: innerHeight }, scrollY, openDetails: document.querySelectorAll("main details[open]").length, root: coordinates(document.querySelector("#journey-root-title")!), phases: [...document.querySelectorAll('section[id^="journey-phase-"] > header h3')].map(coordinates) };
  });
  await writeFile(join(process.cwd(), ".runtime", `journey-layout-${name}.log`), JSON.stringify(layout, null, 2) + "\n", "utf8");
  await page.screenshot({ path: join(directory, `journey-${name}.png`), animations: "disabled" });
  await page.screenshot({ path: join(directory, `journey-${name}-full.png`), fullPage: true, animations: "disabled" });
}

async function readRulesAndCollapse(page: Page) {
  const rules = page.locator("main details").filter({ has: page.getByText("怎样理解流程、进度与共享？", { exact: true }) });
  await expect(rules).toHaveCount(1); await expect(rules).not.toHaveAttribute("open", "");
  await rules.locator("summary").click();
  await expect(rules.locator("p").first()).toBeVisible();
  await expect(rules).toContainText("具体依赖和真实进度在团队空间确认");
  await expect(rules).toContainText("私人准备和材料不会自动共享");
  await rules.locator("summary").click(); await expect(rules).not.toHaveAttribute("open", "");
}

function phaseSection(page: Page, title: string): Locator {
  return page.getByRole("heading", { name: new RegExp(`^${title}(?:[：:·\\s]|$)`) }).first().locator("xpath=ancestor::section[1]");
}

function resourceBranches(page: Page): Locator {
  return page.locator('main details:has(ul[aria-label$="的辅助资源"])');
}

async function expandResources(page: Page) {
  const branches = resourceBranches(page);
  expect(await branches.count(), "The guide retains resource branches beneath its actions").toBeGreaterThan(0);
  for (const branch of await branches.all()) {
    await expect(branch).not.toHaveAttribute("open", "");
    await expect(branch.getByRole("link").first()).not.toBeVisible();
    await branch.locator(":scope > summary").click();
    await expect(branch).toHaveAttribute("open", "");
    await expect(branch.getByRole("link").first()).toBeVisible();
  }
}

test("guest reads the complete tree and nearby resource uses without creating saved work", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const page = await f.page(undefined, 1280), observed = await guardOtherApis(page), before = await savedFacts(f);
    await page.goto("/journey"); await loadedGuide(page, f);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: /从找比赛到留下经验/ })).toBeVisible();
    await expect(main).toContainText("团队空间");
    await expect(main).toContainText(/主办方/);
    await expect(main).toContainText(/(?:通用|准备)指南/);
    await expect(main).toContainText(/并行/);
    await expect(main).toContainText(/(?:具体|实际|真实).*(?:依赖|进度)|(?:依赖|进度).*(?:空间|任务)/);
    await readRulesAndCollapse(page);
    for (const title of phases) {
      const section = phaseSection(page, title);
      await expect(section).toBeVisible();
      await expect(section).toContainText("注意事项");
      const caution = section.locator(":scope > details").filter({ hasText: "本阶段注意事项" });
      await expect(caution).toHaveCount(1); await expect(caution).not.toHaveAttribute("open", "");
      await caution.locator("summary").click();
      await expect(caution).toHaveAttribute("open", "");
      expect(await caution.locator("li").count(), "Each phase exposes substantive cautions").toBeGreaterThan(0);
      await expect(caution.locator("li").first()).toBeVisible(); await caution.locator("summary").click();
      const actions = section.locator("ol").first().locator(":scope > li");
      expect(await actions.count(), `${title} contains concrete actions below its phase`).toBeGreaterThanOrEqual(3);
      for (const action of await actions.all()) {
        await expect(action.getByRole("link").first()).toBeVisible();
        const branch = action.locator('details:has(ul[aria-label$="的辅助资源"])');
        await expect(branch).toHaveCount(1);
        await expect(branch).not.toHaveAttribute("open", "");
        await expect(branch.locator("a[href]").first()).not.toBeVisible();
        await branch.locator("summary").click();
        await expect(branch).toHaveAttribute("open", "");
        const resources = action.locator("ol li a[href], ul li a[href]");
        expect(await resources.count(), "Each action has nested resource links").toBeGreaterThan(0);
        for (const resource of await resources.all()) {
          await expect(resource).toBeVisible();
          const lines = (await resource.innerText()).split("\n").map(line => line.trim()).filter(Boolean);
          expect(lines.length, "A resource shows both its name and nearby use explanation").toBeGreaterThanOrEqual(2);
          expect(lines.at(-1)!.length, "Use explanation contains more than a link label").toBeGreaterThanOrEqual(10);
        }
        await branch.locator("summary").click();
        await expect(branch).not.toHaveAttribute("open", "");
      }
    }
    await noInventedProgress(page); await noOverflow(page); await topScreenshot(page, "desktop-1280-top");
    await assertGuideReadOnly(f); expect(await savedFacts(f)).toEqual(before);
    expect(observed.unexpected).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await f.close(); }
});

test("375px tree wraps, supports reduced motion, keyboard links and phase anchors", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const page = await f.page(undefined, 375), observed = await guardOtherApis(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/journey"); await loadedGuide(page, f); await noOverflow(page);
    await readRulesAndCollapse(page);
    const main = page.locator("main"), anchors = main.locator('a[href^="#"]').filter({ hasText: /赛前|赛中|赛后/ });
    await expect(anchors).toHaveCount(3);
    for (const destination of ["/events", "/app"]) {
      const box = await main.locator(`a[href="${destination}"]`).first().boundingBox();
      expect(box?.height, "Root primary actions must provide a 44px target").toBeGreaterThanOrEqual(44);
    }
    await topScreenshot(page, "mobile-375-top");
    // Open auxiliary branches explicitly before traversing their retained links.
    await expandResources(page);
    const linkCount = await main.locator("a[href]").count(), reached = new Set<number>();
    await main.locator("a[href]").first().focus();
    // Resource summaries were opened with the pointer. Enter keyboard modality
    // through real Tab navigation before requiring :focus-visible on links.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    for (let index = 0; index < linkCount + 100 && reached.size < linkCount; index++) {
      const focus = await page.evaluate(() => {
        const active = document.activeElement, links = [...document.querySelectorAll("main a[href]")];
        const index = links.indexOf(active!);
        const style = active ? getComputedStyle(active) : null;
        return { index, visible: active?.matches(":focus-visible") ?? false, outline: style?.outlineStyle, width: parseFloat(style?.outlineWidth ?? "0"), shadow: style?.boxShadow };
      });
      if (focus.index >= 0) {
        reached.add(focus.index); expect(focus.visible, "Keyboard focus is visible on guide links").toBe(true);
        expect(focus.outline !== "none" && focus.width >= 1 || focus.shadow !== "none", "Focused guide link has a visible focus indicator").toBe(true);
      }
      await page.keyboard.press("Tab");
    }
    expect(reached.size, "All action and resource links are keyboard reachable").toBe(linkCount);
    for (const anchor of await anchors.all()) {
      const href = (await anchor.getAttribute("href"))!;
      expect(href).toMatch(/^#[a-z0-9-]+$/i);
      const target = page.locator(`[id="${href.slice(1)}"]`); await expect(target).toHaveCount(1);
      await anchor.focus(); await page.keyboard.press("Enter");
      await expect(page).toHaveURL(url => url.pathname === "/journey" && url.hash === href);
      await expect.poll(async () => (await target.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((await target.boundingBox())!.y).toBeLessThan((await page.viewportSize())!.height);
      await noOverflow(page);
    }
    await noInventedProgress(page); await assertGuideReadOnly(f);
    expect(observed.unexpected).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const entry of ["/", "/events", "/app", "/resources"]) {
  test(`public ${entry} entry opens the journey while primary navigation stays at four items`, async ({ browser }, info) => {
    const f = await isolatedWorkspace(browser, info);
    try {
      const page = await f.page(), observed = await guardOtherApis(page), before = await savedFacts(f);
      await page.goto(entry);
      const link = page.locator('main a[href="/journey"]').first(); await expect(link).toBeVisible();
      await link.click(); await expect(page).toHaveURL(url => url.pathname === "/journey"); await loadedGuide(page, f);
      expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([]);
      expect(f.externalRequests).toEqual([]); expect(await savedFacts(f)).toEqual(before);
      expect(observed.unexpected).toEqual([]); expect(observed.errors).toEqual([]);
    } finally { await f.close(); }
  });
}

test("all guide destinations exist and the retrospective path first opens a real space chooser", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const page = await f.page(), observed = await guardOtherApis(page), before = await savedFacts(f);
    await page.goto("/journey"); await loadedGuide(page, f); await noInventedProgress(page);
    const main = page.locator("main");
    const links = await main.locator('a[href^="/"]').evaluateAll(elements => elements.map(element => element.getAttribute("href")!));
    for (const path of requiredDestinations) expect(links.map(href => new URL(href, f.origin).pathname)).toContain(path);
    const after = phaseSection(page, "赛后");
    await expect(after).toContainText("复盘"); await expect(after).toContainText(/(?:创建|打开|选择).*团队空间/);
    await expect(after.locator('a[href="/app"], a[href^="/app#"]')).not.toHaveCount(0);
    for (const href of [...new Set(links)]) {
      // Some destinations are auxiliary only; make them reachable through the
      // real disclosure control instead of bypassing it with a forced click.
      const destination = page.locator(`main a[href="${href}"]`).first();
      if (!await destination.isVisible()) {
        const branch = destination.locator("xpath=ancestor::details[1]");
        await branch.locator(":scope > summary").click();
      }
      await destination.click();
      const expected = new URL(href, f.origin);
      await expect(page).toHaveURL(url => url.pathname === expected.pathname && url.search === expected.search);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator("main")).not.toContainText(/This page could not be found|404|页面不存在/);
      await noOverflow(page);
      await page.goto("/journey"); await loadedGuide(page, f);
    }
    expect(f.apiReads.filter(value => !value.startsWith("GET "))).toEqual([]);
    expect(f.externalRequests).toEqual([]); expect(await savedFacts(f)).toEqual(before);
    expect(observed.unexpected).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const mode of ["login", "register"] as const) {
  test(`${mode} returns to journey using isolated authentication without generating team work`, async ({ browser }, info) => {
    const f = await isolatedWorkspace(browser, info);
    try {
      const page = await f.page(undefined, 375), observed = await guardOtherApis(page);
      await page.goto("/journey"); await loadedGuide(page, f);
      const link = page.locator('[aria-label="账号操作"]').getByRole("link", { name: mode === "login" ? "登录" : "注册", exact: true });
      await expect(link).toHaveAttribute("href", `/${mode}?returnTo=%2Fjourney`);
      await link.click(); await expect(page).toHaveURL(url => url.pathname === `/${mode}` && url.searchParams.get("returnTo") === "/journey");
      const email = `journey-${mode}@example.test`;
      if (mode === "register") await page.getByLabel("姓名 / 昵称", { exact: true }).fill("路线图新人");
      await page.getByLabel("邮箱", { exact: true }).fill(email);
      await page.getByRole("button", { name: mode === "login" ? "获取登录验证码" : "获取注册验证码", exact: true }).click();
      await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
      await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode(email));
      await page.getByRole("button", { name: mode === "login" ? "验证并登录" : "验证邮箱并注册 / 登录", exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === "/journey"); await loadedGuide(page, f);
      await expect(page.locator('[aria-label="账号操作"] summary')).toContainText("我的账号");
      // Explicit fixture auth is the only authorized mutation in this scenario.
      expect(f.apiReads.filter(value => !value.startsWith("GET ") && !/^POST auth\/(?:login|registration)-challenges(?:\/verify)?$/.test(value))).toEqual([]);
      const before = await savedFacts(f), start = f.apiReads.length;
      await page.reload(); await loadedGuide(page, f); await noInventedProgress(page);
      await assertGuideReadOnly(f, start); expect(await savedFacts(f)).toEqual(before);
      expect(observed.unexpected).toEqual([]); expect(observed.errors).toEqual([]);
    } finally { await f.close(); }
  });
}

test("signed-in public reading neither selects a project nor discloses another team's saved facts", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const reader = await f.login("journey-reader@example.test", "读指南的成员"), stranger = await f.login("journey-stranger@example.test", "另一支队伍");
    const privateProject = await f.request<Project>("projects", "POST", { name: "PRIVATE_JOURNEY_OTHER_TEAM", timezone: "Asia/Shanghai", goal: "PRIVATE_JOURNEY_GOAL" }, stranger, 201);
    const ownProject = await f.request<Project>("projects", "POST", { name: "已有团队空间", timezone: "Asia/Shanghai", goal: "已有作品目标" }, reader, 201);
    const page = await f.page(reader, 1280), observed = await guardOtherApis(page), before = await savedFacts(f), start = f.apiReads.length;
    await page.goto("/journey"); await loadedGuide(page, f);
    await expect(page.locator('[aria-label="账号操作"] summary')).toContainText("我的账号");
    await expect(page.locator("main")).not.toContainText(/PRIVATE_JOURNEY_OTHER_TEAM|PRIVATE_JOURNEY_GOAL|已有作品目标/);
    for (const id of [privateProject.id, ownProject.id]) await expect(page.locator(`main a[href*="${id}"]`)).toHaveCount(0);
    await noInventedProgress(page); await page.reload(); await loadedGuide(page, f);
    await assertGuideReadOnly(f, start); expect(await savedFacts(f)).toEqual(before);
    expect(observed.unexpected).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await f.close(); }
});
