import { test as base, expect, type Page } from "@playwright/test";
import { isolatedWorkspace, type IsolatedWorkspace } from "./isolated-workspace.ts";

export const test = base.extend<{ workspace: IsolatedWorkspace; introSeen: boolean }>({
  introSeen: [true, { option: true }],
  workspace: [async ({ browser, context, introSeen }, use, info) => {
    const workspace = await isolatedWorkspace(browser, info);
    try { await workspace.attach(context, introSeen); await use(workspace); }
    finally { await workspace.close(); }
  }, { auto: true }],
});
export { expect };

export async function browserLogin(page: Page, workspace: IsolatedWorkspace, email: string, returnTo = "/app") {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByRole("button", { name: "获取登录验证码", exact: true }).click();
  await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
  await page.getByLabel("8 位验证码", { exact: true }).fill(await workspace.challengeCode(email));
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await page.waitForURL(returnTo);
}

/** APIRequestContext bypasses browser interception, so old browser tests must
 * route their direct assertions through this fixture dispatch instead. */
export async function browserRequest(workspace: IsolatedWorkspace, page: Page, path: string, method = "GET", body?: unknown) {
  const session = (await page.context().cookies(workspace.origin)).find(cookie => cookie.httpOnly);
  return workspace.raw(path, method, body, session ? { userId: "resolved-by-handler", email: "resolved-by-handler", cookie: `${session.name}=${session.value}` } : undefined);
}
