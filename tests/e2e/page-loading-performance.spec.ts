import { test, expect } from "@playwright/test";
import { isolatedWorkspace } from "./isolated-workspace.ts";
import type { Project } from "../../src/modules/projects/model.ts";

test("首页优先加载当前内容，共用账号读取，导航员打开后再读资料", async ({ browser }, info) => {
  const fixture = await isolatedWorkspace(browser, info);
  try {
    const page = await fixture.page();
    const reads: string[] = [];
    page.on("request", request => { if (request.method() === "GET") reads.push(new URL(request.url()).pathname); });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("第一次参加黑客松");
    await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
    await page.waitForTimeout(600);
    expect(reads.filter(path => path === "/api/v1/me")).toHaveLength(1);
    expect(reads.filter(path => path === "/api/v1/navigator/intro")).toHaveLength(0);
    expect(reads.filter(path => ["/journey", "/events", "/resources", "/organizers"].includes(path))).toHaveLength(0);
    await page.getByRole("button", { name: "问问导航员", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "你的参赛导航员" })).toBeVisible();
    await expect.poll(() => reads.filter(path => path === "/api/v1/navigator/intro").length).toBe(1);
    await page.getByRole("button", { name: "关闭导航员", exact: true }).click();
    await page.getByRole("link", { name: /^开始参赛指引/ }).click();
    await expect(page).toHaveURL(/\/journey$/);
    expect(fixture.externalRequests).toEqual([]);
  } finally { await fixture.close(); }
});

test("先读取保存的画布，不提前挂载默认文档和待办组件", async ({ browser }, info) => {
  const fixture = await isolatedWorkspace(browser, info);
  let release: (() => void) | undefined;
  try {
    const identity = await fixture.login("performance-layout@example.test", "布局验收选手");
    const project = await fixture.request<Project>("projects", "POST", { name: "加载布局验收", timezone: "Asia/Shanghai", goal: "只读取保存组件", minimumDeliverable: "AI 入口" }, identity, 201);
    await fixture.request(`projects/${project.id}/space-canvas`, "PUT", { expectedRevision: 0, items: [{ instanceId: "ai-only", kind: "assistant", x: 100, y: 100, collapsed: false, scale: 1 }] }, identity);
    const page = await fixture.page(identity);
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/v1/projects/${project.id}/space-canvas`, async route => { await gate; await route.fallback(); });
    await page.goto(`/app/projects/${project.id}`);
    await expect(page.getByText("正在读取你保存的画布摆放…", { exact: true })).toBeVisible();
    await expect(page.locator("[data-instance-id]")).toHaveCount(0);
    const reads = () => fixture.apiReads.filter(path => /space-todos|space-documents/.test(path));
    expect(reads()).toEqual([]);
    release();
    await expect(page.locator('[data-instance-id="ai-only"]')).toBeVisible();
    expect(reads()).toEqual([]);
  } finally { release?.(); await fixture.close(); }
});

test("登录后保留首次使用指引，关闭的导航员不抢读私人对话", async ({ browser }, info) => {
  const fixture = await isolatedWorkspace(browser, info);
  try {
    const identity = await fixture.login("performance-user@example.test", "加载验收选手");
    const page = await fixture.page(identity);
    const reads: string[] = [];
    page.on("request", request => { if (request.method() === "GET") reads.push(new URL(request.url()).pathname); });
    await page.goto("/");
    await expect(page.locator('[aria-label="账号操作"] summary')).toContainText("我的账号");
    await expect.poll(() => reads.filter(path => path === "/api/v1/me/onboarding").length).toBe(1);
    expect(reads.filter(path => path === "/api/v1/me")).toHaveLength(1);
    expect(reads).not.toContain("/api/v1/navigator/conversation");
    expect(reads).not.toContain("/api/v1/projects");
    await page.getByRole("button", { name: "问问导航员", exact: true }).click();
    await expect.poll(() => reads.includes("/api/v1/navigator/conversation")).toBe(true);
    expect(fixture.externalRequests).toEqual([]);
  } finally { await fixture.close(); }
});
