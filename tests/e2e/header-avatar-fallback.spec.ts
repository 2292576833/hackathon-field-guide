import { test, expect } from "@playwright/test";
import { isolatedWorkspace } from "./isolated-workspace.ts";

/**
 * 页头头像的回落行为：
 *  - 没有头像（接口 404）时不能出现破图，必须回落姓名首字；
 *  - 无论哪种情况都不能产生未捕获异常。
 *
 * 这一条很重要的原因是：观猹登录会把头像写进同一个位置，
 * 如果"没有头像"的分支处理错了，所有没有头像的用户都会看到破图。
 */
test("the header avatar degrades to an initial instead of a broken image", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("avatar-header@example.test", "头像回归");
    const page = await f.page(owner, 1280);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));

    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    // 必须从**页面内部**取状态：会话 cookie 是 HttpOnly，Playwright 的 request 客户端带不上它，
    // 直接用 request 会得到 401，测的就不是真实路径了。组件对任何失败都回落首字，这是可接受的。
    const probe = await page.evaluate(async () => {
      const response = await fetch("/api/v1/me/recruiting-profile/avatar", { credentials: "same-origin" });
      return { status: response.status, type: response.headers.get("content-type") ?? "" };
    });
    console.log("头像接口（页面内、无头像时）:", JSON.stringify(probe));
    expect([200, 401, 404], "不能是 500；组件对任何失败都会回落首字").toContain(probe.status);

    const avatar = page.locator("header summary span").first();
    await expect(avatar).toBeVisible();

    const inside = await avatar.innerHTML();
    const text = (await avatar.innerText()).trim();
    console.log("页头头像内容:", JSON.stringify(inside.slice(0, 120)), "可见文字:", JSON.stringify(text));

    // 两种情况都必须成立：要么有图片且未被标记失败，要么显示首字；绝不能是"空的可见元素"。
    const hasImage = inside.includes("<img");
    const showsInitial = text.length > 0;
    console.log("有图片:", hasImage, "有首字:", showsInitial);
    expect(hasImage || showsInitial, "既没有图片也没有首字，用户会看到一个空圈").toBe(true);

    // 等图片失败回落的机会，确认最终不是"图片加载失败但仍在 DOM 里"的破图状态。
    await page.waitForTimeout(600);
    const finalInside = await avatar.innerHTML();
    const brokenImageStillThere = finalInside.includes("<img") && (await avatar.innerText()).trim().length === 0
      && await avatar.locator("img").first().evaluate(node => (node as HTMLImageElement).naturalWidth === 0).catch(() => false);
    console.log("最终 DOM:", JSON.stringify(finalInside.slice(0, 120)), "破图仍在:", brokenImageStillThere);
    expect(brokenImageStillThere, "加载失败的图片必须被首字替换，不能留破图").toBe(false);

    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});
