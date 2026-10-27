import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createDatabase } from "../../src/server/database.ts";
import { createApplication } from "../../src/server/application.ts";
import { dispatch } from "../../src/server/router.ts";

const origin = "http://localhost:3000";
/** The browser renders the real production page. API responses come from the real
 * router and an isolated SQL database, never the user's persistent database. */
async function isolatedOperator(page: Page, admin: boolean, options: { inspiration?: boolean; allowInspirationControl?: boolean } = {}) {
  const database = await createDatabase({});
  try {
    const app = await createApplication({ mode: "local", origin, codePepper: "dashboard-browser-fixture-pepper-32bytes", emailFrom: "qa@localhost.invalid" }, database);
    if (options.inspiration) {
      // Add configuration only after composition, so no real model/worker port
      // exists. The actual SQL dashboard and authenticated control routes remain.
      const budget = { dailyProjectCallLimit: 24, dailyProjectBudgetMicroUsd: 100_000 };
      app.config.dsh = { apiKey: "PRIVATE_DSH_FIXTURE_KEY", modelVersion: "PRIVATE_DSH_FIXTURE_MODEL", promptVersion: "PRIVATE_DSH_FIXTURE_PROMPT", currency: "USD", inputCostMicrosPerMillionTokens: 1, outputCostMicrosPerMillionTokens: 2, budget, sourceBudget: budget };
      app.config.inspiration = { workerId: "PRIVATE_INSPIRATION_PROCESS", userAgent: "isolated-dashboard-browser", minimumIntervalMs: 60_000, recrawlAfterMs: 86_400_000, maxCycleDurationMs: 60_000, fetchTimeoutMs: 1000, maxPageBytes: 65_536,
        modelCostReservationMicrosPerCall: 100, limits: { maxSearchCallsPerDay: 0, maxModelCallsPerDay: 24, maxEstimatedCostMicrosPerDay: 100_000, currency: "USD" } };
      const now = new Date().toISOString();
      await database.query("INSERT INTO operations_discovery_state(id,revision,quota_day,model_calls,estimated_cost_micros,last_completed_at) VALUES('inspiration-catalog',4,$1,3,4000,$2::timestamptz)", [now.slice(0, 10), now]);
      await database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at,last_completed_at) VALUES('PRIVATE_BROWSER_INSPIRATION','inspiration','idle',$1::timestamptz,$1::timestamptz)", [now]);
      await database.query("INSERT INTO inspiration_cards(id,revision,content_hash,content,last_analyzed_at) VALUES('isolated-dashboard-card',1,'PRIVATE_HASH',$1::jsonb,$2::timestamptz)", [JSON.stringify({ description: "PRIVATE_DSH_MODEL_BODY_NEVER_RENDER" }), now]);
    }
    const request = async (path: string, body: unknown) => dispatch(app, new Request(origin + "/api/v1/" + path, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }), path.split("/"));
    const challengeResponse = await request("auth/login-challenges", { email: "dashboard-fixture@example.test" });
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()).data;
    const message = await database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", ["dashboard-fixture@example.test"]);
    const code = message.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
    if (!code) throw new Error("Isolated login challenge was not available");
    const verified = await request("auth/login-challenges/verify", { challengeId: challenge.challengeId, code });
    expect(verified.ok).toBeTruthy();
    const verifiedBody = (await verified.json()).data;
    const userId = verifiedBody.profile.id as string;
    if (admin) await database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin'] WHERE id=$1", [userId]);
    const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Isolated session was not created");
    const separator = cookie.indexOf("=");
    await page.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const intro = app.navigator.intro();
    await page.addInitScript(version => localStorage.setItem("hackathon-navigator-intro-" + version, "seen"), intro.version);
    let dashboardReads = 0, inspirationStatusReads = 0;
    const controls: { expectedRevision: number; paused: boolean }[] = [];
    await page.route("**/api/v1/**", async route => {
      const browserRequest = route.request();
      const path = new URL(browserRequest.url()).pathname.slice("/api/v1/".length);
      // Refresh stays read-only. Only this explicitly opted-in test permits the
      // real administrator pause route; no provider/model request is possible.
      if (!["GET", "HEAD"].includes(browserRequest.method())) {
        if (!options.allowInspirationControl || path !== "admin/inspiration/paused" || browserRequest.method() !== "POST") throw new Error("Dashboard attempted an unexpected mutation");
        controls.push(JSON.parse(browserRequest.postData() ?? "null"));
      }
      if (path === "admin/backend-dashboard") dashboardReads++;
      if (path === "admin/inspiration/status") inspirationStatusReads++;
      const body = browserRequest.postData();
      const response = await dispatch(app, new Request(browserRequest.url(), { method: browserRequest.method(), headers: await browserRequest.allHeaders(), ...(body === null ? {} : { body }) }), path.split("/"));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    return { app, database, userId, reads: () => dashboardReads, inspirationStatusReads: () => inspirationStatusReads, controls, cookie };
  } catch (error) { await database.close(); throw error; }
}

test("administrator sees real SQL service state on desktop and mobile; refresh only reads and role withdrawal clears the dashboard", async ({ page }) => {
  const fixture = await isolatedOperator(page, true);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await page.goto("/admin");
    await page.getByRole("button", { name: "自动发现", exact: true }).click();
    await expect(page.getByText("尚未启用搜索", { exact: true })).toBeVisible();
    await expect(page.getByText("允许按后台计划运行", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "确认暂停后续发现", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/admin/services");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/后端服务|后台/);
    await expect(page.getByRole("button", { name: /刷新/ }).first()).toBeVisible();
    await expect.poll(fixture.reads).toBeGreaterThan(0);
    await expect(page.getByText(/未配置/).first()).toBeVisible();
    await mkdir(".runtime/previews", { recursive: true });
    await page.screenshot({ path: ".runtime/previews/backend-dashboard-desktop.png", fullPage: true });
    const previousReads = fixture.reads();
    await page.getByRole("button", { name: /刷新/ }).first().click();
    await expect.poll(fixture.reads).toBeGreaterThan(previousReads);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: ".runtime/previews/backend-dashboard-mobile.png", fullPage: true });
    await fixture.database.query("UPDATE auth_users SET platform_roles=ARRAY['user'] WHERE id=$1", [fixture.userId]);
    await page.getByRole("button", { name: /刷新/ }).first().click();
    await expect(page.getByRole("heading", { name: "需要管理员权限", exact: true })).toBeVisible();
    await expect(page.getByText(/未配置/).first()).not.toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally { await page.unrouteAll({ behavior: "wait" }); await fixture.database.close(); }
});

test("ordinary and anonymous users cannot read backend metrics or mutate the dashboard route", async ({ page }) => {
  const fixture = await isolatedOperator(page, false);
  try {
    await page.goto("/admin/services");
    await expect(page.getByRole("heading", { name: "需要管理员权限", exact: true })).toBeVisible();
    const anonymous = await dispatch(fixture.app, new Request(origin + "/api/v1/admin/backend-dashboard"), ["admin", "backend-dashboard"]);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).data).toBeUndefined();
    const mutation = await dispatch(fixture.app, new Request(origin + "/api/v1/admin/backend-dashboard", { method: "POST", headers: { origin } }), ["admin", "backend-dashboard"]);
    expect(mutation.status).toBe(405);
    expect((await mutation.json()).data).toBeUndefined();
  } finally { await page.unrouteAll({ behavior: "wait" }); await fixture.database.close(); }
});

test("inspiration quota and heartbeat are visible to admins, refresh is read-only, and pause/resume uses a fresh scheduler revision", async ({ page }) => {
  const fixture = await isolatedOperator(page, true, { inspiration: true, allowInspirationControl: true });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("/admin/services");
    const section = page.getByRole("region", { name: "DSH 灵感更新管理", exact: true });
    await expect(section).toBeVisible();
    await expect(page.getByRole("heading", { name: "DSH 灵感更新进程", exact: true })).toBeVisible();
    await expect(section.getByText("3 次", { exact: true })).toBeVisible();
    await expect(section.getByText("24 次 / UTC 日", { exact: true })).toBeVisible();
    await expect(section.getByText("$0.10 USD", { exact: true })).toBeVisible();
    await expect(section.getByText("1 条", { exact: true })).toBeVisible();
    await expect(section.getByText(/AI 说明不代表人工审核发布/)).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/PRIVATE_|MODEL_BODY/);
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect.poll(fixture.reads).toBeGreaterThanOrEqual(2);
    expect(fixture.inspirationStatusReads()).toBe(0); expect(fixture.controls).toEqual([]);
    // Simulate a completed background cycle after the displayed snapshot. The
    // button must use the fresh GET version, never the stale dashboard revision.
    await fixture.database.query("UPDATE operations_discovery_state SET revision=9 WHERE id='inspiration-catalog'");
    await section.getByRole("button", { name: "暂停 DSH 灵感更新", exact: true }).click();
    await expect(section.getByText("DSH 灵感更新已暂停，已保存的资料仍可查看。", { exact: true })).toBeVisible();
    expect(fixture.controls).toEqual([{ expectedRevision: 9, paused: true }]);
    await expect(section.getByRole("button", { name: "恢复 DSH 灵感更新", exact: true })).toBeEnabled();
    await section.getByRole("button", { name: "恢复 DSH 灵感更新", exact: true }).click();
    await expect(section.getByText("DSH 灵感更新已恢复，后续运行仍受独立额度与时间间隔限制。", { exact: true })).toBeVisible();
    expect(fixture.controls).toEqual([{ expectedRevision: 9, paused: true }, { expectedRevision: 10, paused: false }]);
    expect(fixture.inspirationStatusReads()).toBe(2);
    const audits = await fixture.database.query("SELECT id FROM operations_discovery_control_audit WHERE scheduler_id='inspiration-catalog'");
    expect(audits.rowCount).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.unrouteAll({ behavior: "wait" }); await fixture.database.close(); }
});

test("withdrawn and ordinary administrators cannot control inspiration or keep a privileged snapshot", async ({ page }) => {
  const fixture = await isolatedOperator(page, true, { inspiration: true, allowInspirationControl: true });
  try {
    await page.goto("/admin/services");
    const section = page.getByRole("region", { name: "DSH 灵感更新管理", exact: true });
    await expect(section).toBeVisible();
    await fixture.database.query("UPDATE auth_users SET platform_roles=ARRAY['user'] WHERE id=$1", [fixture.userId]);
    await section.getByRole("button", { name: "暂停 DSH 灵感更新", exact: true }).click();
    await expect(page.getByRole("heading", { name: "需要管理员权限", exact: true })).toBeVisible();
    await expect(section).toHaveCount(0); expect(fixture.controls).toEqual([]);
    const get = await dispatch(fixture.app, new Request(origin + "/api/v1/admin/inspiration/status", { headers: { cookie: fixture.cookie } }), ["admin", "inspiration", "status"]);
    expect(get.status).toBe(403);
    const post = await dispatch(fixture.app, new Request(origin + "/api/v1/admin/inspiration/paused", { method: "POST", headers: { origin, cookie: fixture.cookie, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 4, paused: true }) }), ["admin", "inspiration", "paused"]);
    expect(post.status).toBe(403);
    const row = (await fixture.database.query<{ paused: boolean; revision: number }>("SELECT paused,revision FROM operations_discovery_state WHERE id='inspiration-catalog'")).rows[0]!;
    expect(row.paused).toBe(false); expect(row.revision).toBe(4);
    expect((await fixture.database.query("SELECT id FROM operations_discovery_control_audit WHERE scheduler_id='inspiration-catalog'")).rowCount).toBe(0);
  } finally { await page.unrouteAll({ behavior: "wait" }); await fixture.database.close(); }
});
