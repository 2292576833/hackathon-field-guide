import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace } from "./isolated-workspace.ts";

/** 装配验收：新加的两个组件（倒计时与资源 / 范围调整）能从组件箱放进画布并真的渲染出内容。
 *  只断言"能编译"不算做完——必须证明它在真实浏览器里有可见输出。 */
test("the new deadline and scope components mount and render real content", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("assembly-owner@example.test", "装配验收");
    const project = await f.request<Project>("projects", "POST", {
      name: "装配验收空间", timezone: "Asia/Shanghai",
      goal: "完成可演示的最小版本", minimumDeliverable: "能跑通主流程的演示",
    }, owner, 201);
    const page = await f.page(owner, 1440);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");

    // 组件箱里应能看见这两个新组件
    const palette = page.locator('aside[aria-label="组件箱"]');
    await expect(palette.getByText("倒计时与资源", { exact: false })).toBeVisible();
    await expect(palette.getByText("范围调整", { exact: false })).toBeVisible();

    // 放进画布
    const before = await page.locator("[data-instance-id]").count();
    await palette.getByRole("button", { name: /倒计时与资源/ }).click();
    await page.waitForTimeout(700);
    await palette.getByRole("button", { name: /范围调整/ }).click();
    await page.waitForTimeout(700);
    const after = await page.locator("[data-instance-id]").count();
    expect(after, "两个组件都应放进画布").toBe(before + 2);

    // 注意：按用户要求，卡片上**不再显示组件名**（已去掉顶部操作栏）。
    // 因此这里按"刚放进来的最后两张"来定位，而不是按卡片内的标题文字。
    const cards = page.locator("[data-instance-id]");
    const deadlineCard = cards.nth(after - 2);
    const scopeCard = cards.nth(after - 1);
    const deadlineText = await deadlineCard.innerText();
    const scopeText = await scopeCard.innerText();
    console.log("=== 倒计时组件文本 ===", JSON.stringify(deadlineText.slice(0, 300)));
    console.log("=== 范围调整组件文本 ===", JSON.stringify(scopeText.slice(0, 400)));
    expect(deadlineText.length, "倒计时组件必须有可见内容").toBeGreaterThan(0);
    expect(scopeText.length, "范围调整组件必须有可见内容").toBeGreaterThan(0);
    expect(/%/u.test(scopeText), "不得出现百分比").toBe(false);
    expect(/%/u.test(deadlineText), "不得出现百分比").toBe(false);

    console.log("=== 画布内所有组件文本 ===", JSON.stringify((await page.locator("[data-instance-id]").allInnerTexts()).map(t => t.slice(0, 120))));
    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});
