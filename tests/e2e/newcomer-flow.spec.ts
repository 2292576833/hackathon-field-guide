import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createDatabase } from "../../src/server/database.ts";
import { createApplication } from "../../src/server/application.ts";
import { dispatch } from "../../src/server/router.ts";
import type { Project, ProjectMember, Team } from "../../src/modules/projects/model.ts";

interface Identity { userId: string; cookie: string; email: string }
interface ProjectDetail { project: Project; membership: ProjectMember; members: (ProjectMember & { displayName?: string | null })[] }
/** Production pages render against real module handlers in an isolated SQL engine.
 * No persistent directory, real credentials, model worker or external transport is used. */
async function isolatedWorkspace(page: Page, info: TestInfo, signedIn = true) {
  const origin = new URL(String(info.project.use.baseURL ?? "http://localhost:3000")).origin;
  const database = await createDatabase({});
  try {
    const app = await createApplication({ mode: "local", origin, codePepper: "newcomer-browser-fixture-pepper-32bytes", emailFrom: "qa@localhost.invalid" }, database);
    const externalRequests: string[] = [], apiReads: string[] = [];
    async function request<T>(path: string, method = "GET", body?: unknown, identity?: Identity, expectedStatus = 200): Promise<T> {
      const headers = new Headers({ origin, "content-type": "application/json" });
      if (identity) headers.set("cookie", identity.cookie);
      const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"));
      const envelope = await response.json() as { data: T; error?: { code: string } };
      // Never put challenge codes, invitation/session tokens or request bodies in failures.
      expect(response.status, `Isolated ${method} returned ${envelope.error?.code ?? "unexpected status"}`).toBe(expectedStatus);
      return envelope.data;
    }
    async function challengeCode(email: string): Promise<string> {
      const mail = await database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
      const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
      if (!code) throw new Error("Isolated development challenge was not available");
      return code;
    }
    async function login(email: string, displayName: string): Promise<Identity> {
      const challenge = await request<{ challengeId: string }>("auth/login-challenges", "POST", { email });
      const verified = await dispatch(app, new Request(`${origin}/api/v1/auth/login-challenges/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, code: await challengeCode(email) }) }), ["auth", "login-challenges", "verify"]);
      expect(verified.ok, "Isolated login verification must succeed").toBeTruthy();
      const verifiedBody = (await verified.json()).data;
      const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("Isolated session was not created");
      const identity = { cookie, userId: verifiedBody.profile.id as string, email };
      await request("me", "PATCH", { displayName, timezone: "Asia/Shanghai", expectedRevision: verifiedBody.profile.revision }, identity);
      return identity;
    }
    const current = signedIn ? await login("newcomer-owner@example.test", "小林") : null;
    if (current) {
      const separator = current.cookie.indexOf("=");
      await page.context().addCookies([{ name: current.cookie.slice(0, separator), value: current.cookie.slice(separator + 1), domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    }
    await page.addInitScript(version => localStorage.setItem("hackathon-navigator-intro-" + version, "seen"), app.navigator.intro().version);
    // Browser assets may only come from the local application. External links are
    // inspected, never opened; provider calls cannot be hidden behind this fixture.
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
        externalRequests.push(url.origin); await route.abort("blockedbyclient"); return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/**", async route => {
      const browserRequest = route.request(), url = new URL(browserRequest.url());
      if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort("blockedbyclient"); return; }
      const path = url.pathname.slice("/api/v1/".length);
      apiReads.push(`${browserRequest.method()} ${path}`);
      const requestBody = browserRequest.postData();
      const response = await dispatch(app, new Request(browserRequest.url(), { method: browserRequest.method(), headers: await browserRequest.allHeaders(), ...(requestBody === null ? {} : { body: requestBody }) }), path.split("/"));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    return { app, database, current, request, login, challengeCode, externalRequests, apiReads,
      async close() { try { if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" }); } finally { await database.close(); } } };
  } catch (error) { await page.unrouteAll({ behavior: "wait" }); await database.close(); throw error; }
}

async function populatedWorkspace(page: Page, info: TestInfo) {
  const f = await isolatedWorkspace(page, info);
  try {
    const owner = f.current!;
    const peers = [await f.login("newcomer-peer@example.test", "小陈"), await f.login("newcomer-duplicate@example.test", "小陈")];
    const team = await f.request<Team>("teams", "POST", { name: "QA 新人合作队" }, owner, 201);
    for (const peer of peers) {
      const currentTeam = await f.request<{ team: Team }>(`teams/${team.id}`, "GET", undefined, owner);
      const invitation = await f.request<{ token: string }>(`teams/${team.id}/invitations`, "POST", { expectedRevision: currentTeam.team.revision, role: "member", invitedEmail: peer.email }, owner, 201);
      await f.request(`invitations/${invitation.token}/accept`, "POST", {}, peer);
    }
    const project = await f.request<Project>("projects", "POST", { name: "QA 可访问作品", teamId: team.id, timezone: "Asia/Shanghai", goal: "做出一个能演示的核心流程", minimumDeliverable: "可以实际操作的网页" }, owner, 201);
    for (const peer of peers) {
      const currentProject = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
      const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", { expectedRevision: currentProject.project.revision, role: "member", invitedEmail: peer.email }, owner, 201);
      await f.request(`invitations/${invitation.token}/accept`, "POST", {}, peer);
    }
    const privateProject = await f.request<Project>("projects", "POST", { name: "QA 队员私人作品", teamId: team.id, timezone: "Asia/Shanghai", goal: "PRIVATE_OTHER_MEMBER_GOAL" }, peers[0], 201);
    const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    return { ...f, owner, peers, team, project, privateProject, detail };
  } catch (error) { await f.close(); throw error; }
}

test("team opens only a directly accessible project; rosters use real names and the stage picker offers valid steps", async ({ page }, info) => {
  const f = await populatedWorkspace(page, info), pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await page.goto(`/app/teams/${encodeURIComponent(f.team.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: f.team.name })).toBeVisible();
    const roster = page.locator("section").filter({ has: page.getByRole("heading", { name: "队伍成员", exact: true }) });
    await expect(roster.getByText("你", { exact: true })).toBeVisible();
    await expect.poll(() => roster.locator("li > strong").allTextContents()).toEqual(expect.arrayContaining(["你", expect.stringMatching(/^小陈 · [A-Z0-9]{7}$/), expect.stringMatching(/^小陈 · [A-Z0-9]{7}$/)]));
    const names = await roster.locator("li > strong").allTextContents();
    expect(new Set(names).size).toBe(3);
    const linked = page.locator("section").filter({ has: page.getByRole("heading", { name: "这支队伍的项目", exact: true }) });
    const projectLink = linked.locator(`a[href="/app/projects/${encodeURIComponent(f.project.id)}"]`);
    await expect(projectLink).toContainText(f.project.name);
    await expect(linked.getByText(f.privateProject.name, { exact: true })).toHaveCount(0);
    await expect(linked.getByText("PRIVATE_OTHER_MEMBER_GOAL", { exact: true })).toHaveCount(0);
    await projectLink.click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${f.project.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: f.project.name })).toBeVisible();
    const stages = page.getByLabel("下一阶段", { exact: true });
    await expect(stages.locator("option")).toHaveText(["请选择", "备赛", "复盘", "已归档"]);
    expect(await stages.locator('option[value="active"]').count()).toBe(0);
    await stages.selectOption("preparing");
    await page.getByLabel("变更依据", { exact: true }).fill("目标与最小交付物已明确");
    await page.getByRole("button", { name: "确认更新阶段", exact: true }).click();
    await expect(stages.locator("option")).toHaveText(["请选择", "草稿", "执行中", "复盘", "已归档"]);
    await stages.selectOption("active");
    await expect(page.getByText("开始执行前，请先在“分工与进度”中确认任务安排。", { exact: true })).toBeVisible();
    await page.getByLabel("变更依据", { exact: true }).fill("检查尚未建立计划时的提示");
    await page.getByRole("button", { name: "确认更新阶段", exact: true }).click();
    const stagePanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "更新参赛阶段", exact: true }) });
    await expect(stagePanel.getByRole("alert")).toContainText("请先确认一份计划或建立手动任务。");
    expect((await f.request<ProjectDetail>(`projects/${f.project.id}`, "GET", undefined, f.owner)).project.stage).toBe("preparing");
    await page.getByRole("link", { name: "分工与进度", exact: true }).click();
    const projectRoster = page.locator("section").filter({ has: page.getByRole("heading", { name: "当前空间成员", exact: true }) });
    await expect(projectRoster.getByText("你", { exact: true })).toBeVisible();
    await expect.poll(async () => (await projectRoster.locator("li > strong").allTextContents()).sort()).toEqual([...names].sort());
    for (const member of f.detail.members) await expect(projectRoster.getByText(member.membershipId, { exact: true })).not.toBeVisible();
    const removeOptions = await page.getByLabel("要移除的活跃成员", { exact: true }).locator("option").allTextContents();
    expect(removeOptions.length).toBe(3);
    expect(removeOptions.slice(1).every(value => /^小陈 · [A-Z0-9]{7} · 空间成员$/.test(value))).toBeTruthy();
    expect(pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
    expect(f.apiReads).not.toEqual(expect.arrayContaining([expect.stringMatching(/navigator\/messages|github.*POST|analysis-jobs/)]));
  } finally { await f.close(); }
});

test("skills filter URL survives detail navigation and real isolated browser login", async ({ page }, info) => {
  const f = await isolatedWorkspace(page, info, false), pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    const query = "agentId=codex&track=general&category=delivery&search=README";
    await page.goto(`/skills?${query}`);
    await expect(page.getByLabel("你正在使用哪个 AI 工具？", { exact: true })).toHaveValue("codex");
    await page.getByText(/^更多筛选：作品方向与关键词/).click();
    await expect(page.getByLabel("作品方向（资源分类）", { exact: true })).toHaveValue("general");
    const detailLink = page.locator(`a[href="/skills/create-readme?${query}"]`);
    await expect(detailLink).toContainText("作品 README 与演示说明");
    await detailLink.click();
    await expect(page).toHaveURL(url => url.pathname === "/skills/create-readme" && url.searchParams.get("search") === "README");
    await expect(page.getByRole("heading", { level: 1, name: "作品 README 与演示说明" })).toBeVisible();
    const headerLogin = page.locator('[aria-label="账号操作"]').getByRole("link", { name: "登录", exact: true });
    await expect(headerLogin).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(`/skills/create-readme?${query}`)}`);
    await headerLogin.click();
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("returnTo") === `/skills/create-readme?${query}`);
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "作品 README 与演示说明" })).toBeVisible();
    const installationLogin = page.getByRole("link", { name: "登录后创建本人安装计划", exact: true });
    const destination = new URL((await installationLogin.getAttribute("href"))!, "http://localhost").searchParams.get("returnTo")!;
    const fixedSelection = new URL(destination, "http://localhost");
    expect(fixedSelection.pathname).toBe("/skills/create-readme");
    for (const [key, value] of new URLSearchParams(query)) expect(fixedSelection.searchParams.get(key)).toBe(value);
    expect(fixedSelection.searchParams.get("versionId")).toMatch(/^create-readme@/);
    await installationLogin.click();
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("returnTo") === destination);
    const email = "newcomer-skills-browser@example.test";
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByRole("button", { name: "获取登录验证码", exact: true }).click();
    await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
    const code = await f.challengeCode(email);
    // No traces/screenshots/logs contain this short-lived fixture code.
    await page.getByLabel("8 位验证码", { exact: true }).fill(code);
    await page.getByRole("button", { name: "验证并登录", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname + url.search === destination);
    await expect(page.getByRole("link", { name: "登录后创建本人安装计划", exact: true })).toHaveCount(0);
    const accountMenu = page.locator('[aria-label="账号操作"] summary');
    await expect(accountMenu).toContainText("我的账号");
    await accountMenu.click();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).not.toBeVisible();
    await expect(page.getByLabel("安装到哪个 AI 工具", { exact: true })).toHaveValue("codex");
    await expect(page.getByLabel("选择固定文件版本", { exact: true })).toHaveValue(fixedSelection.searchParams.get("versionId")!);
    await page.getByRole("link", { name: "返回 AI 技能目录，保留工具与任务筛选", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/skills" && url.search === `?${query}`);
    await expect(page.getByLabel("你想完成什么？", { exact: true })).toHaveValue("delivery");
    await page.getByText(/^更多筛选：作品方向与关键词/).click();
    await expect(page.getByLabel("搜索技能用途", { exact: true })).toHaveValue("README");
    expect(pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
    expect((await f.database.query("SELECT id FROM skill_installation_plans")).rowCount).toBe(0);
  } finally { await f.close(); }
});

test("mobile empty team and empty skill search offer actionable next steps without overflow", async ({ page }, info) => {
  const f = await isolatedWorkspace(page, info);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const team = await f.request<Team>("teams", "POST", { name: "QA 等待首个项目的队伍" }, f.current!, 201);
    await page.goto(`/app/teams/${encodeURIComponent(team.id)}`);
    await expect(page.getByText("还没有你可访问的关联项目。", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "创建项目", exact: true })).toHaveAttribute("href", "/app#create-project");
    await expect(page.getByRole("link", { name: "选择已有项目", exact: true })).toHaveAttribute("href", "/app");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("link", { name: "创建项目", exact: true }).click();
    await expect(page.getByRole("heading", { name: "创建团队空间", exact: true })).toBeVisible();
    await page.goto("/skills?agentId=codex&track=game&search=qa-no-matching-skill-7291");
    await expect(page.getByText("没有符合当前工具和任务的已发布技能。", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "清除筛选，浏览全部技能", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "阅读技能包指南", exact: true })).toHaveAttribute("href", "/library/skill-pack-guide");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "清除筛选，浏览全部技能", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/skills" && !url.search);
    await expect(page.locator('a[href="/skills/create-readme"]')).toBeVisible();
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
