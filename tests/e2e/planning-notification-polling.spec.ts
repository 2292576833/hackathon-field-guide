import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace } from "./isolated-workspace.ts";

/**
 * 规划31 第1.3项：提醒面板跟随可见页面刷新。
 *
 * 提醒由后台 worker 每 30 秒生成，而此前这个面板只读一次——用户不点「刷新提醒」就永远看不到。
 * 这里验证两件事：① 页面回到可见时会**重新读取**；② 重读**不会自动标记已读**（宪法要求"标为已读"必须是明确动作）。
 */
test("the planning notification panel rereads when the page becomes visible, without auto-marking read", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("notice-poll@example.test", "提醒验证");
    const project = await f.request<Project>("projects", "POST", {
      name: "提醒刷新验收空间", timezone: "Asia/Shanghai", goal: "验证提醒会自己刷新",
      minimumDeliverable: "可演示", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    }, owner, 201);
    const page = await f.page(owner, 1280);

    let listReads = 0;
    let markReadCalls = 0;
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/me/planning-notifications")) listReads += 1;
      if (/\/me\/planning-notifications\/[^/]+\/read$/.test(path)) markReadCalls += 1;
    });

    await page.goto(`/app/projects/${project.id}/plan`);
    await page.waitForLoadState("networkidle");
    const afterLoad = listReads;
    console.log("首屏读取次数:", afterLoad);
    expect(afterLoad, "首屏应至少读取一次提醒").toBeGreaterThanOrEqual(1);

    // 模拟"切走再切回来"：可见时面板应重新读取（不必等 30 秒轮询）。
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(1200);

    console.log("可见后累计读取次数:", listReads, "自动标已读次数:", markReadCalls);
    expect(listReads, "页面回到可见后应重新读取提醒").toBeGreaterThan(afterLoad);
    expect(markReadCalls, "重读不得自动标记已读").toBe(0);
  } finally { await f.close(); }
});
