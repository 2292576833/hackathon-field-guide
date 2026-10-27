import { test, expect } from "./ux-test.ts";
import { issueAdminTestAccess } from "../../src/server/admin-test-access.ts";
import { grantVerifiedRole } from "../../src/server/administration.ts";

const fixturePepper = "ux-browser-fixture-only-pepper-32bytes";
const testEntry = "/login?test=1&returnTo=%2Fadmin%2Forganizers";

test("a locally issued administrator credential uses normal login, is consumed once, and sends no browser email request", async ({ page, workspace }) => {
  const email = "admin-access-fixture@example.test";
  await workspace.login(email, "隔离管理员");
  await grantVerifiedRole(workspace.database, email, "admin");
  const issuanceTime = new Date(workspace.app.clock.now().getTime() + 61_000);
  workspace.app.clock.now = () => issuanceTime;
  const issued = await issueAdminTestAccess({ database: workspace.database, codePepper: fixturePepper, email, clock: workspace.app.clock });
  const mailCount = (await workspace.database.query("SELECT id FROM development_mailbox")).rowCount;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(testEntry);
  await expect(page.getByRole("heading", { name: "管理员测试登录", exact: true })).toBeVisible();
  const credential = page.getByLabel("管理员测试凭证", { exact: true });
  await expect(credential).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "获取登录验证码", exact: true })).toHaveCount(0);
  await credential.fill(issued.credential);
  const verifyRequest = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/auth/login-challenges/verify");
  await page.getByRole("button", { name: "使用测试凭证登录", exact: true }).click();
  expect((await verifyRequest).postDataJSON()).toEqual({ challengeId: issued.challengeId, code: issued.credential.split(".")[1], returnTo: "/admin/organizers" });
  await expect(page).toHaveURL(url => url.pathname === "/admin/organizers");
  await expect(page.getByRole("heading", { name: "主办方入驻审核", exact: true })).toBeVisible();
  expect((await workspace.database.query("SELECT id FROM development_mailbox")).rowCount).toBe(mailCount);
  expect(workspace.apiReads.filter(value => value === "POST auth/login-challenges")).toHaveLength(0);
  const replay = await workspace.raw("auth/login-challenges/verify", "POST", { challengeId: issued.challengeId, code: issued.credential.split(".")[1], returnTo: "/admin" });
  expect(replay.status).toBe(401);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(workspace.externalRequests).toEqual([]);
});

test("invalid and expired test credentials do not establish a session or request email", async ({ page, workspace }) => {
  const email = "expired-admin-access@example.test";
  await workspace.login(email, "隔离过期凭证管理员");
  await grantVerifiedRole(workspace.database, email, "admin");
  const issuanceTime = new Date(workspace.app.clock.now().getTime() + 61_000);
  workspace.app.clock.now = () => issuanceTime;
  const issued = await issueAdminTestAccess({ database: workspace.database, codePepper: fixturePepper, email, clock: workspace.app.clock });
  await page.goto(testEntry);
  await page.getByLabel("管理员测试凭证", { exact: true }).fill("incomplete");
  await page.getByRole("button", { name: "使用测试凭证登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请粘贴完整" })).toBeVisible();
  expect(workspace.apiReads.some(value => value.startsWith("POST auth/"))).toBe(false);
  const elapsed = new Date(Date.parse(issued.expiresAt) + 1);
  workspace.app.clock.now = () => elapsed;
  await page.getByLabel("管理员测试凭证", { exact: true }).fill(issued.credential);
  await page.getByRole("button", { name: "使用测试凭证登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "验证码无效" })).toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === "/login");
  expect((await workspace.raw("me")).status).toBe(401);
  expect(workspace.apiReads).not.toContain("POST auth/login-challenges");
});

test("opening the test entry grants no role and returning to normal login restores email verification", async ({ page, workspace }) => {
  await page.goto(testEntry);
  expect((await workspace.raw("admin/organizer/applications")).status).toBe(401);
  const users = await workspace.database.query("SELECT id FROM auth_users");
  expect(users.rowCount).toBe(0);
  await page.getByRole("link", { name: "返回邮箱验证码登录", exact: true }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "获取登录验证码", exact: true })).toBeVisible();
  await expect(page.getByLabel("管理员测试凭证", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(url => url.searchParams.get("returnTo") === "/admin/organizers" && !url.searchParams.has("test"));
  expect(workspace.apiReads.some(value => value.startsWith("POST auth/"))).toBe(false);
});
