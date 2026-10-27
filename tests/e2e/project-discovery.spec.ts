import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createApplication } from "../../src/server/application.ts";
import { createDatabase } from "../../src/server/database.ts";
import { dispatch } from "../../src/server/router.ts";
import type { DiscoveryInput } from "../../src/server/discovery.ts";
import type { ProjectDiscoveryView } from "../../src/server/project-discovery.ts";
import type { Project } from "../../src/modules/projects/index.ts";

interface Identity { userId: string; cookie: string }
const firstTitle = "赛事引用浏览器夹具一", secondTitle = "赛事引用浏览器夹具二";
function card(url: string, title: string, indexed = false): DiscoveryInput {
  const now = new Date().toISOString();
  const deadline = "隔离报名说明：报名开放，报名截止日期为 2030年12月31日。";
  return { canonicalUrl: url, title, summary: `${title}的完整分析摘要，赛事日期尚未核验。`, analysis: { fit: ["适合构建最小原型"], risks: ["主办方资格要求待核实"], preparation: ["准备仓库、演示和提交清单"], unknowns: ["团队人数与费用"] }, sources: [{ url, title: "隔离测试的公开原文依据", excerpt: deadline, fetchedAt: now, ...(indexed ? { sourceKind: "indexed_excerpt" as const } : {}) }], registrationWindow: { status: "open", closesAt: null, closesOn: "2030-12-31", evidence: [deadline], checkedAt: now }, discoveredAt: now, lastAnalyzedAt: now, provider: "dsh" };
}

/** All API requests use one isolated SQL engine and real handlers. Fixture
 * cards are explicitly ingested into that engine; no DSH/search/production
 * database is touched and no human account is impersonated. */
async function isolatedDiscovery(page: Page, info: TestInfo, options: { member?: boolean; saved?: boolean; archived?: boolean } = {}) {
  const origin = new URL(String(info.project.use.baseURL ?? "http://localhost:3000")).origin;
  const database = await createDatabase({});
  try {
    const app = await createApplication({ mode: "local", origin, codePepper: "browser-project-discovery-fixture-pepper", emailFrom: "test@localhost.invalid" }, database);
    async function request<T>(path: string, method = "GET", body?: unknown, identity?: Identity, status = 200): Promise<T> {
      const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers: { origin, "content-type": "application/json", ...(identity ? { cookie: identity.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"));
      const envelope = await response.json() as { data: T; error?: { code: string } };
      expect(response.status, `Isolated ${method} endpoint returned ${envelope.error?.code ?? "unexpected status"}`).toBe(status);
      return envelope.data;
    }
    async function login(email: string): Promise<Identity> {
      const challenge = await request<{ challengeId: string }>("auth/login-challenges", "POST", { email });
      const mail = await database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
      const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
      if (!code) throw new Error("Isolated email challenge was unavailable");
      const response = await dispatch(app, new Request(`${origin}/api/v1/auth/login-challenges/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, code }) }), ["auth", "login-challenges", "verify"]);
      expect(response.ok).toBeTruthy(); const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("Isolated verification did not create a session");
      return { userId: (await response.json()).data.profile.id as string, cookie };
    }
    const manager = await login("discovery-ui-manager@example.test"), member = await login("discovery-ui-member@example.test");
    const project = await request<Project>("projects", "POST", { name: "隔离赛事线索用户流程", timezone: "Asia/Shanghai", goal: "核对规则后完成最小演示" }, manager, 201);
    const invitation = await request<{ token: string }>(`projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", invitedEmail: "discovery-ui-member@example.test" }, manager, 201);
    await request(`invitations/${invitation.token}/accept`, "POST", {}, member);
    const first = await app.discoveries.save(card("https://example.com/discovery-ui-fixture/first", firstTitle, true));
    const second = await app.discoveries.save(card("https://example.com/discovery-ui-fixture/second", secondTitle));
    const path = `projects/${project.id}/discovery-draft`;
    const command = { discoveryId: first.id, discoveryRevision: first.revision, expectedRevision: 0, notes: "保存时的队伍准备记录" };
    if (options.saved) await request(path, "POST", command, manager);
    if (options.archived) {
      const detail = await request<{ project: Project }>(`projects/${project.id}`, "GET", undefined, manager);
      await request(`projects/${project.id}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "只读界面验收" }, manager);
    }
    const browserIdentity = options.member ? member : manager, separator = browserIdentity.cookie.indexOf("=");
    await page.context().addCookies([{ name: browserIdentity.cookie.slice(0, separator), value: browserIdentity.cookie.slice(separator + 1), domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    await page.addInitScript(version => localStorage.setItem("hackathon-navigator-intro-" + version, "seen"), app.navigator.intro().version);
    const pageErrors: string[] = [], externalRequests: string[] = [], mutations: { method: string; body: unknown }[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) { externalRequests.push(url.origin); await route.abort("blockedbyclient"); return; }
      await route.continue();
    });
    await page.route("**/api/v1/**", async route => {
      const browserRequest = route.request(), url = new URL(browserRequest.url());
      if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort("blockedbyclient"); return; }
      const endpoint = url.pathname.slice("/api/v1/".length), body = browserRequest.postData();
      if (endpoint === path && browserRequest.method() !== "GET") mutations.push({ method: browserRequest.method(), body: JSON.parse(body ?? "null") });
      const response = await dispatch(app, new Request(browserRequest.url(), { method: browserRequest.method(), headers: await browserRequest.allHeaders(), ...(body === null ? {} : { body }) }), endpoint.split("/"));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    return { app, database, manager, member, project, first, second, path, command, request, mutations, pageErrors, externalRequests,
      async close() { await page.unrouteAll({ behavior: "wait" }); await database.close(); } };
  } catch (error) { await page.unrouteAll({ behavior: "wait" }); await database.close(); throw error; }
}
async function openPanel(page: Page, project: Project) {
  await page.goto(`/app/projects/${project.id}/rules`);
  await expect(page.getByRole("heading", { name: project.name, level: 1 })).toBeVisible();
  const panel = page.getByRole("region", { name: "赛事线索草案", exact: true });
  await expect(panel).toBeVisible(); return panel;
}

test("selecting a competition provides immediate radio feedback while the full analysis is still loading", async ({ page }, info) => {
  const f = await isolatedDiscovery(page, info);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route(`**/api/v1/event-discoveries/${f.first.id}`, async route => { await gate; await route.fallback(); });
    const panel = await openPanel(page, f.project);
    const choice = panel.getByRole("radio", { name: firstTitle, exact: true });
    await choice.check();
    await expect(choice).toBeChecked();
    await expect(panel.getByRole("button", { name: "保存赛事线索草案", exact: true })).toBeDisabled();
    await expect(panel.getByRole("heading", { name: "准备引用的赛事分析", exact: true })).toHaveCount(0);
    release();
    await expect(panel.getByRole("heading", { name: "准备引用的赛事分析", exact: true })).toBeVisible();
    await expect(choice).toBeChecked();
    expect(f.mutations).toEqual([]); expect(f.pageErrors).toEqual([]);
  } finally { release(); await f.close(); }
});

test("manager references a complete analysis, saves notes, reloads and replaces or clears the project draft", async ({ page }, info) => {
  const f = await isolatedDiscovery(page, info);
  try {
    const panel = await openPanel(page, f.project), save = panel.getByRole("button", { name: "保存赛事线索草案", exact: true });
    await expect(save).toBeDisabled();
    await panel.getByRole("radio", { name: firstTitle, exact: true }).click();
    await expect(panel.getByRole("heading", { name: "准备引用的赛事分析", exact: true })).toBeVisible();
    for (const text of ["适合构建最小原型", "主办方资格要求待核实", "准备仓库、演示和提交清单", "团队人数与费用"]) await expect(panel.getByText(text, { exact: true })).toBeVisible();
    await expect(panel.getByText("部分依据来自搜索引用，尚未读取原文全文。请打开来源核对完整要求。", { exact: true })).toBeVisible();
    const original = panel.getByRole("link", { name: "查看赛事原文（新窗口）", exact: true });
    await expect(original).toHaveAttribute("href", "https://example.com/discovery-ui-fixture/first"); await expect(original).toHaveAttribute("target", "_blank");
    await panel.getByText("查看来源与依据", { exact: true }).click();
    await expect(panel.getByText("隔离报名说明：报名开放，报名截止日期为 2030年12月31日。", { exact: true })).toBeVisible();
    const notes = "我们负责最小演示，先核实参赛资格\n最后预留提交时间。";
    await panel.getByLabel("队伍备赛备注", { exact: true }).fill(notes); await expect(save).toBeEnabled(); await save.click();
    await expect(panel.getByText("未核验 · 项目草案", { exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "已保存的赛事线索", exact: true })).toBeVisible(); await expect(panel.getByText(notes, { exact: true })).toBeVisible();
    expect(f.mutations).toEqual([{ method: "POST", body: { ...f.command, notes } }]);
    await page.reload(); await expect(panel.getByText(notes, { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "编辑已保存草案", exact: true }).click();
    await expect(panel.getByLabel("队伍备赛备注", { exact: true })).toHaveValue(notes);
    await panel.getByLabel("队伍备赛备注", { exact: true }).fill("尚未保存的新想法");
    await panel.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(panel.getByText(notes, { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "替换赛事线索", exact: true }).click();
    await panel.getByRole("radio", { name: secondTitle, exact: true }).click();
    await panel.getByLabel("队伍备赛备注", { exact: true }).fill("第二场比赛准备记录"); await save.click();
    await expect(panel.getByRole("heading", { name: secondTitle, exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: firstTitle, exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "清除项目草案", exact: true }).click();
    await expect(panel.getByText("未核验 · 项目草案", { exact: true })).toHaveCount(0);
    await expect(save).toBeDisabled(); await expect(panel.getByRole("radio")).toHaveCount(2);
    const cleared = await f.request<ProjectDiscoveryView>(f.path, "GET", undefined, f.manager);
    expect(cleared).toEqual({ revision: 3, draft: null, sourceState: null });
    expect(await f.app.eventsRepository.getConfirmation(f.project.id)).toBeNull(); expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("a teammate edit reports conflict and rereads the stored version while preserving unsaved notes", async ({ page }, info) => {
  const f = await isolatedDiscovery(page, info, { saved: true });
  try {
    const panel = await openPanel(page, f.project);
    await panel.getByRole("button", { name: "编辑已保存草案", exact: true }).click();
    const input = panel.getByLabel("队伍备赛备注", { exact: true }), local = "本地尚未保存的备注";
    await input.fill(local);
    await f.request(f.path, "POST", { ...f.command, expectedRevision: 1, notes: "队友已经保存的新备注" }, f.manager);
    const save = panel.getByRole("button", { name: "保存赛事线索草案", exact: true }); await save.click();
    await expect(panel.getByRole("alert")).toHaveText("队友已经修改了赛事线索草案，请重新读取后再保存。");
    await expect(input).toHaveValue(local); await expect(save).toBeDisabled();
    await panel.getByRole("button", { name: "重新读取队友版本", exact: true }).click();
    await expect(panel.getByText("队友已经保存的新备注", { exact: true })).toBeVisible(); await expect(input).toHaveValue(local);
    await expect(save).toBeEnabled(); await save.click();
    await expect(panel.getByText(local, { exact: true })).toBeVisible();
    expect((await f.request<ProjectDiscoveryView>(f.path, "GET", undefined, f.member)).draft?.notes).toBe(local);
    expect(f.mutations.map(item => item.body)).toEqual([{ ...f.command, expectedRevision: 1, notes: local }, { ...f.command, expectedRevision: 2, notes: local }]);
    expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

for (const mode of ["member", "archived"] as const) {
  test(`${mode} can read the project discovery snapshot but sees no editing controls`, async ({ page }, info) => {
    const f = await isolatedDiscovery(page, info, { saved: true, ...(mode === "member" ? { member: true } : { archived: true }) });
    try {
      const panel = await openPanel(page, f.project);
      await expect(panel.getByRole("heading", { name: firstTitle, exact: true })).toBeVisible();
      await expect(panel.getByText("保存时的队伍准备记录", { exact: true })).toBeVisible();
      await expect(panel.getByText("当前可阅读草案。只有未归档项目的管理员可以编辑、替换或清除。", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button")).toHaveCount(0); await expect(panel.getByRole("radio")).toHaveCount(0); await expect(panel.getByLabel("队伍备赛备注", { exact: true })).toHaveCount(0);
      expect(f.mutations).toEqual([]); expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
    } finally { await f.close(); }
  });
}

test("changed discovery analysis remains an explicit replacement and never silently overwrites the saved snapshot", async ({ page }, info) => {
  const f = await isolatedDiscovery(page, info, { saved: true });
  try {
    const updatedTitle = "赛事线索更新后的版本";
    await f.app.discoveries.save(card("https://example.com/discovery-ui-fixture/first", updatedTitle));
    const panel = await openPanel(page, f.project);
    await expect(panel.getByRole("heading", { name: firstTitle, exact: true })).toBeVisible();
    await expect(panel.getByText("比赛分析已有更新。此处保留团队保存时的版本；编辑时可重新选择最新分析，核对后再保存。", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "编辑已保存草案", exact: true }).click();
    const save = panel.getByRole("button", { name: "保存赛事线索草案", exact: true }); await expect(save).toBeDisabled();
    await panel.getByLabel("队伍备赛备注", { exact: true }).fill("读取更新时保留的想法");
    await panel.getByRole("button", { name: "读取这场比赛的最新分析", exact: true }).click();
    await expect(panel.getByRole("heading", { name: updatedTitle, exact: true })).toBeVisible();
    await expect(panel.getByLabel("队伍备赛备注", { exact: true })).toHaveValue("读取更新时保留的想法");
    await expect(panel.getByRole("heading", { name: firstTitle, exact: true })).toBeVisible(); await expect(save).toBeEnabled();
    await save.click(); await expect(panel.getByRole("heading", { name: firstTitle, exact: true })).toHaveCount(0);
    const view = await f.request<ProjectDiscoveryView>(f.path, "GET", undefined, f.manager);
    expect(view.sourceState).toBe("current"); expect(view.draft?.discoveryRevision).toBe(2);
    expect(view.draft?.snapshot.title).toBe(updatedTitle); expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("competition page reserves multiple clear card positions without inflating the actual analysis count", async ({ page }, info) => {
  const f = await isolatedDiscovery(page, info);
  try {
    await page.goto("/events");
    await expect(page.getByText("本页 2 个分析结果", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: firstTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: secondTitle, exact: true })).toBeVisible();
    await expect(page.getByText("等待新赛事分析", { exact: true }).filter({ visible: true })).toHaveCount(22);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText("等待新赛事分析", { exact: true }).filter({ visible: true })).toHaveCount(4);
    const more = page.getByText("更多待更新位置（18 个）", { exact: true }); await expect(more).toBeVisible(); await more.click();
    await expect(page.getByText("等待新赛事分析", { exact: true }).filter({ visible: true })).toHaveCount(22);
    await expect(page.getByText("本页 2 个分析结果", { exact: true })).toBeVisible();
    expect(f.mutations).toEqual([]); expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
