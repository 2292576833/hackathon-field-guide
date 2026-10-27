import { test, expect } from "./ux-test.ts";

test.describe("GitHub 新手图解页", () => {
  test("展示完整流程、分支图和官方资料入口", async ({ page }) => {
    await page.goto("/github");
    await expect(page.getByRole("heading", { name: "从注册到交付，一页学会 GitHub" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工具与资料分类", exact: true }).getByRole("link", { name: "GitHub 教程", exact: true })).toHaveAttribute("href", "/github");
    await expect(page.getByRole("heading", { name: "分支、拉取与提交，一张图看懂" })).toBeVisible();
    await expect(page.getByText("main · 稳定版本")).toBeVisible();
    await expect(page.getByText("feature/你的任务 · 独立工作")).toBeVisible();
    await expect(page.getByText("读取基版本有什么用？", { exact: true })).toBeVisible();
    await expect(page.getByText("取回本人草稿与 Git 的 Pull 命令是不同动作。", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: /Clone 官方说明/ })).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("link", { name: /Pull Request 说明/ })).toHaveAttribute("target", "_blank");
  });

  test("手机宽度不会产生横向滚动", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/github");
    await expect(page.getByRole("heading", { name: "分支、拉取与提交，一张图看懂" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});
