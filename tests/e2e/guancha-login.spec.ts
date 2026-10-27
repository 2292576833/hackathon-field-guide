import { test, expect } from "./ux-test.ts";

test("disabled Guancha keeps existing email login and explains a failed callback", async ({ workspace: f }) => {
  const page = await f.page(undefined, 375);
  await page.goto("/login?guancha=failed&returnTo=%2Fevents");
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用观猹登录", exact: true })).toHaveCount(0);
  await expect(page.getByText("这次观猹登录未完成。请重新尝试，或使用下方邮箱验证码登录。", { exact: true })).toBeVisible();
  await page.getByLabel("邮箱", { exact: true }).fill("guancha-email-regression@example.test");
  await page.getByRole("button", { name: "获取登录验证码", exact: true }).click();
  await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode("guancha-email-regression@example.test"));
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await page.waitForURL("/events");
  expect(f.externalRequests).toEqual([]);
});

test("first association keeps its page through real email verification and never links automatically", async ({ workspace: f }) => {
  const page = await f.page(undefined, 375);
  // OAuth itself is covered by real SQL HTTP tests; this isolated browser only
  // replaces the Secure-cookie provider status, so it never contacts watcha.cn.
  await page.route("**/api/v1/auth/guancha/status", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { enabled: true, pending: true, linked: false } }) }));
  await page.goto("/app/account/guancha");
  await expect(page.getByRole("heading", { name: "先验证你的邮箱", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "验证邮箱并登录", exact: true }).click();
  await page.getByLabel("邮箱", { exact: true }).fill("guancha-association@example.test");
  await page.getByRole("button", { name: "获取登录验证码", exact: true }).click();
  await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode("guancha-association@example.test"));
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await page.waitForURL("/app/account/guancha");
  await expect(page.getByRole("heading", { name: "关联到这个账号？", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认关联并继续", exact: true })).toBeVisible();
  expect(f.apiReads.some(read => read === "POST auth/guancha/confirm")).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(f.externalRequests).toEqual([]);
});

test("association status can recover an already saved result without claiming another link", async ({ workspace: f }) => {
  const owner = await f.login("guancha-recovery@example.test", "原来的账号"), page = await f.page(owner);
  await page.route("**/api/v1/auth/guancha/status", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { enabled: true, pending: false, linked: true, returnTo: "/events" } }) }));
  await page.goto("/app/account/guancha");
  await expect(page.getByText("观猹账号已成功关联到当前本站账号。", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "继续之前的操作", exact: true }).click();
  await page.waitForURL("/events");
  expect(f.apiReads.some(read => read === "POST auth/guancha/confirm")).toBe(false);
  expect(f.externalRequests).toEqual([]);
});
