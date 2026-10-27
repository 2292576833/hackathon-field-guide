import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace } from "./isolated-workspace.ts";

test("collaboration steps preserve every detail route with a clear return path and phone invitation", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("navigation-owner@example.test", "空间负责人");
    const project = await f.request<Project>("projects", "POST", { name: "全流程导航验收空间", timezone: "Asia/Shanghai", goal: "完成新人可用的参赛流程", minimumDeliverable: "可操作的完整演示" }, owner, 201);
    const page = await f.page(owner, 375);
    const base = `/app/projects/${project.id}`;
    for (const [section, selected] of [["", "工作台"], ["team", "队友与分工"], ["assessment", "队友与分工"], ["plan", "任务进度"], ["rules", "比赛与资料"], ["resources", "比赛与资料"], ["delivery", "提交与复盘"], ["retrospective", "提交与复盘"]]) {
      await page.goto(base + (section ? `/${section}` : ""));
      await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
      if (!section) {
        await expect(page.locator('[data-instance-id="todos-1"]')).toBeVisible();
        await expect(page.locator("#space-path-line")).toHaveAttribute("data-presentation", "canvas");
      } else {
        const nav = page.getByRole("navigation", { name: "当前团队空间", exact: true });
        await expect(nav.getByRole("link", { name: "← 返回团队空间", exact: true })).toHaveAttribute("href", base);
        await expect(nav).toContainText(selected);
      }
      await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), section || "home").toBeTruthy();
    }
    await page.goto(base + "/team");
    const history = page.locator("details").filter({ has: page.getByText("成员管理与历史", { exact: true }) });
    await expect(history).not.toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "我能投入的时间", exact: true })).toBeVisible();
    expect(f.apiReads.some(value => value.startsWith("POST ") && !value.endsWith("/space-changes/reconcile"))).toBe(false);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
