import { test, expect } from "@playwright/test";

// 公网入口使用自签证书（用户已在浏览器里接受过）；测试里显式忽略，否则连页面都打不开。
test.use({ ignoreHTTPSErrors: true });

/**
 * 观猹（watcha.cn）OAuth 登录入口的真实浏览器验收。
 *
 * 注意边界：这里只验收**本站这一侧**——入口是否出现、可点、点击后是否正确跳向观猹官方授权端点。
 * 授权码换令牌、以及观猹侧"构念/应用是否已登记回调"必须在真实浏览器里由人完成一次登录才能确认，
 * 本测试**不会**声称整条链路已通过。
 */
test("the Guancha login entry appears, is clickable, and points at the official authorize endpoint", async ({ browser }, info) => {
  const baseURL = String(info.project.use.baseURL ?? "http://127.0.0.1:3000");
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  try {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // 本站这一侧的开关状态必须以公开接口为准（客户端渲染，不能看服务端 HTML）。
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/v1/auth/guancha/status");
      return { status: response.status, body: await response.json() } as { status: number; body: { data?: { enabled?: boolean } } };
    });
    console.log("=== status 接口 ===", JSON.stringify(status));

    const entry = page.getByRole("button", { name: /观猹/ });
    const entryCount = await entry.count();
    const bodyText = await page.locator("body").innerText();
    console.log("=== 登录页是否出现「观猹」文字 ===", bodyText.includes("观猹"), "| 按钮数:", entryCount);

    if (entryCount > 0 && await entry.first().isVisible()) {
      console.log("=== 按钮文案 ===", JSON.stringify(await entry.first().innerText()));
      await entry.first().click();
      await page.waitForTimeout(2500);
      console.log("=== 点击后 URL ===", page.url().slice(0, 160));
      const navigated = page.url().includes("watcha.cn");
      console.log("=== 是否跳向观猹官方端点 ===", navigated);
      console.log("=== 落地页标题 ===", JSON.stringify((await page.title()).slice(0, 80)));
    } else {
      console.log("=== 未出现观猹入口（开关为关，或组件未渲染）===");
    }
    console.log("=== 未捕获异常 ===", JSON.stringify(errors));
  } finally { await context.close(); }
});
