import { test, expect } from "@playwright/test";
import { searchSiteDocuments } from "../../src/server/site-search.ts";
import { isolatedWorkspace } from "./isolated-workspace.ts";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("375px navigator shows actual matched guide excerpts and retains links after history reload", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const user = await f.login("site-search-ui@example.test", "查找教程的新人");
    const page = await f.page(user, 375);
    const matches = searchSiteDocuments("Git 冲突怎样处理");
    expect(matches.items.some(item => item.href === "/library/github-team-workflow")).toBe(true);
    let messages: { role: "user" | "assistant"; content: string }[] = [], calls = 0;
    await page.route(url => url.origin === f.origin && url.pathname === "/api/v1/navigator/conversation", route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ data: { session: { id: "isolated-ui-session", provider: "dsh", busy: false }, messages } }),
    }));
    // UI-only response fixture. Backend selection, permission and DSH behavior
    // are exercised separately by server tests; this never calls a real model.
    await page.route(url => url.origin === f.origin && url.pathname === "/api/v1/navigator/messages", async route => {
      calls++;
      const input = route.request().postDataJSON();
      expect(input.message).toBe("Git 冲突怎样处理"); expect(input.projectId).toBeUndefined();
      messages = [{ role: "user", content: input.message }, { role: "assistant", content: "隔离界面夹具：先保存自己的草稿，再查看冲突双方的目的。" }];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        reply: messages[1]!.content, links: [{ title: "队友一起改代码：怎样减少冲突", href: "/library/github-team-workflow" }],
        provider: "dsh", requestId: "isolated-ui-response", siteSearch: matches,
      } }) });
    });
    await page.goto("/resources");
    await page.getByRole("button", { name: "问问导航员", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "你的参赛导航员", exact: true });
    await dialog.getByRole("button", { name: "向 AI 提问", exact: true }).click();
    await dialog.getByLabel("你现在需要什么帮助", { exact: true }).fill("Git 冲突怎样处理");
    await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(dialog).toContainText("隔离界面夹具：先保存自己的草稿");
    const sources = dialog.getByRole("region", { name: "本次找到的站内资料", exact: true });
    await sources.locator("summary").click();
    await expect(sources).toContainText("本站原创资料");
    await expect(sources).toContainText("冲突");
    await expect(sources.locator('time[datetime="2026-10-08"]').first()).toHaveText("2026-10-08");
    const featureGuide = sources.locator("li").filter({ has: page.getByRole("link", { name: "GitHub：建仓、分支、拉取与代码协作", exact: true }) });
    await expect(featureGuide).toBeVisible();
    await expect(featureGuide.locator("time")).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "队友一起改代码：怎样减少冲突", exact: true }).last()).toHaveAttribute("href", "/library/github-team-workflow");
    expect(calls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: ".runtime/previews/navigator-search-375.png", fullPage: true });
    // SiteShell keeps the launcher mounted. Changing the page/space must clear
    // the previous reply's transient sources and links before another query.
    await dialog.getByRole("button", { name: "关闭导航员", exact: true }).click();
    await page.goto("/events");
    await page.getByRole("button", { name: "问问导航员", exact: true }).click();
    await expect(page.getByRole("region", { name: "本次找到的站内资料", exact: true })).toHaveCount(0);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("unmatched queries clearly show no corresponding site documents and the catalog limitation", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const user = await f.login("site-search-empty@example.test", "查找未知资料的新人"), page = await f.page(user, 375);
    await page.route(url => url.origin === f.origin && url.pathname === "/api/v1/navigator/messages", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      reply: "隔离界面夹具：站内没有这份文档，请补充名称。", links: [], provider: "dsh", requestId: "isolated-empty-response",
      siteSearch: { items: [], notices: ["部分动态资料目录暂时无法读取。"], coverage: { searchedDocuments: 17, returnedDocuments: 0, scope: "provided_documents" } },
    } }) }));
    await page.goto("/events"); await page.getByRole("button", { name: "问问导航员", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "你的参赛导航员", exact: true });
    await dialog.getByRole("button", { name: "向 AI 提问", exact: true }).click();
    await dialog.getByLabel("你现在需要什么帮助", { exact: true }).fill("不存在的专用文档 xyzzy");
    await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
    const sources = dialog.getByRole("region", { name: "本次找到的站内资料", exact: true });
    await expect(sources).toContainText("没有找到对应的站内资料");
    await expect(sources).toContainText("部分动态资料目录暂时无法读取");
    await expect(sources.getByRole("link")).toHaveCount(0);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
