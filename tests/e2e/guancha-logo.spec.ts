import { test, expect } from "@playwright/test";

// 公网入口是自签证书；测试里显式忽略。
test.use({ ignoreHTTPSErrors: true });

/**
 * 观猹登录按钮上的官方 logo 必须**真的渲染出来**（而不是只在代码里存在）。
 * 用 SVG 的路径数量与可见尺寸作证据；同时确认按钮文字仍然可读。
 */
test("the Guancha login button renders the official vector logo beside its label", async ({ browser }, info) => {
  const baseURL = String(info.project.use.baseURL ?? "http://127.0.0.1:3000");
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const button = page.getByRole("button", { name: /观猹/ });
    await expect(button).toBeVisible();
    console.log("按钮文案:", JSON.stringify(await button.innerText()));

    const logo = button.locator("svg");
    console.log("按钮内 svg 数量:", await logo.count());
    expect(await logo.count(), "按钮里必须有观猹 logo").toBeGreaterThan(0);

    const box = await logo.first().boundingBox();
    const viewBox = await logo.first().getAttribute("viewBox");
    const paths = await logo.first().locator("path").count();
    const fill = await logo.first().locator("path").last().getAttribute("fill");
    console.log("logo 证据:", JSON.stringify({ box, viewBox, paths, brandFill: fill }));

    expect(box, "logo 必须有可见尺寸").not.toBeNull();
    expect(box!.height).toBeGreaterThan(8);
    expect(box!.width).toBeGreaterThan(20);
    expect(viewBox).toBe("0 0 92 32");
    expect(paths).toBe(2);
    // 品牌绿必须来自官方路径数据，不能是我们自己涂的颜色。
    expect(fill).toBe("#3AAF78");
    // logo 应为装饰性元素，不重复朗读。
    expect(await logo.first().getAttribute("aria-hidden")).toBe("true");
  } finally { await context.close(); }
});
