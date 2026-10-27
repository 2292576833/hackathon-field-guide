import { test, expect, type Page } from "@playwright/test";
import { inspirationCandidates, type InspirationItem } from "../../src/server/inspiration-catalog.ts";

function analyzedFixture(): InspirationItem {
  const candidate = inspirationCandidates.find(item => item.id === "shadcn-ui")!;
  return { ...candidate, description: "隔离 DSH 返回说明：这里可以查找 React 基础界面组件与源码。",
    useWhen: "隔离 DSH 建议：搭建表单和项目工作台时查看组件文档。", usageNote: "隔离 DSH 提示：核对具体版本、依赖、许可和付费内容。",
    checkedAt: "2026-10-09T06:00:00.000Z", evidenceUrls: [candidate.url] };
}

async function mockInspiration(page: Page, initialItems: InspirationItem[] = []) {
  // This transport fixture supplies synthetic DSH output only to the browser.
  // It never opens a database, invokes a model, or calls an external account.
  const data = { items: initialItems, pendingItems: [...inspirationCandidates], status: { kind: "dsh", message: "隔离夹具：后台自动更新，结果保存后显示", updatedAt: null as string | null }, reads: 0, mutations: [] as string[], holdNext: false, held: 0, releaseHeld: undefined as undefined | (()=>void) };
  await page.addInitScript(() => localStorage.setItem("hackathon-navigator-intro-v1", "seen"));
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") data.mutations.push(`${request.method()} ${pathname}`);
    let status = 200, body: unknown;
    if (pathname === "/api/v1/inspiration") { data.reads++; if(data.holdNext) {data.holdNext=false; data.held++; await new Promise<void>(resolve=>{data.releaseHeld=resolve;});} body = { data: { items: data.items, pendingItems: data.pendingItems, status: data.status } }; }
    else if (pathname === "/api/v1/system/status") body = { data: { mode: "local", database: "local", email: "preview", modelConfigured: false, githubConfigured: false, dshConfigured: false, discoveryConfigured: false } };
    else if (pathname === "/api/v1/navigator/intro") body = { data: { version: "v1", title: "隔离介绍", sections: [], steps: [], links: [], chat: { provider: "dsh", configured: false } } };
    else { status = 401; body = { error: { code: "UNAUTHENTICATED", message: "隔离浏览者未登录" } }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return data;
}

test("verified pending websites show no recommendation until saved DSH analysis arrives", async ({ page }) => {
  const initialTime = new Date("2026-10-09T06:00:00.000Z");
  await page.clock.install({ time: initialTime });
  await page.clock.pauseAt(new Date(initialTime.getTime() + 60_000));
  const data = await mockInspiration(page);
  await page.goto("/inspiration");
  await expect(page.getByRole("heading", { name: "灵感库", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "找比赛", exact: true })).toHaveAttribute("href", "/events");
  await expect(page.locator("article")).toHaveCount(inspirationCandidates.length);
  await expect(page.getByText("等待 DSH 分析", { exact: true })).toHaveCount(inspirationCandidates.length);
  await expect(page.getByText("DSH 分析 · 未人工核验", { exact: true })).toHaveCount(0);
  await expect(page.locator("article").getByText("什么时候用：", { exact: true })).toHaveCount(0);
  const original = page.getByRole("link", { name: "打开 shadcn/ui 官网（新窗口）", exact: true });
  await expect(original).toHaveAttribute("href", "https://ui.shadcn.com/");
  await expect(original).toHaveAttribute("target", "_blank");
  await expect(original).toHaveAttribute("rel", "noopener noreferrer");
  data.items = [analyzedFixture()]; data.status.updatedAt = data.items[0].checkedAt;
  await page.clock.runFor(10000);
  await expect(page.getByText(data.items[0].description, { exact: true })).toBeVisible();
  await expect(page.getByText("DSH 分析 · 未人工核验", { exact: true })).toHaveCount(1);
  await expect(page.getByText("等待 DSH 分析", { exact: true })).toHaveCount(inspirationCandidates.length - 1);
  await expect(page.locator("article")).toHaveCount(inspirationCandidates.length);
  expect(data.reads).toBeGreaterThanOrEqual(2);
  expect(data.mutations).toEqual([]);
});

test("visibility changes keep one inspiration read in flight and a stalled read recovers with saved cards intact",async({page})=>{
  const start=new Date("2026-10-09T06:00:00Z");
  await page.clock.install({time:start}); await page.clock.pauseAt(new Date(start.getTime()+60000));
  const data=await mockInspiration(page,[analyzedFixture()]);
  try {
    await page.goto("/inspiration"); await expect(page.getByText(data.items[0]!.description,{exact:true})).toBeVisible();
    data.holdNext=true; await page.clock.runFor(10000); await expect.poll(()=>data.held).toBe(1);
    const heldReads=data.reads;
    for(let index=0;index<3;index++) await page.evaluate(()=>{
      Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"}); document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"visible"}); document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(data.reads).toBe(heldReads);
    await page.clock.runFor(10000);
    await expect(page.getByRole("alert").filter({hasText:"读取超时"})).toBeVisible();
    await expect(page.getByText(data.items[0]!.description,{exact:true})).toBeVisible();
    data.releaseHeld?.(); await page.clock.runFor(10000);
    await expect.poll(()=>data.reads).toBe(heldReads+1);
    await expect(page.getByRole("alert").filter({hasText:"读取超时"})).toHaveCount(0);
    await page.clock.runFor(10000); await expect.poll(()=>data.reads).toBe(heldReads+2);
    expect(data.mutations).toEqual([]);
  } finally {data.releaseHeld?.();}
});

test("inspiration category and keyword filters survive URL reloads and open official sources in a new window", async ({ page, context }) => {
  const data = await mockInspiration(page, [analyzedFixture()]);
  await page.goto("/inspiration?q=React&category=components");
  await expect(page.getByLabel("搜索灵感网站", { exact: true })).toHaveValue("React");
  await expect(page.getByLabel("灵感分类", { exact: true })).toHaveValue("components");
  await expect(page.getByRole("heading", { name: "shadcn/ui", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mobbin", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("搜索灵感网站", { exact: true })).toHaveValue("React");
  await expect(page.getByLabel("灵感分类", { exact: true })).toHaveValue("components");
  await page.getByLabel("灵感分类", { exact: true }).selectOption("motion");
  await expect(page).toHaveURL(/category=motion/);
  await expect(page.getByRole("heading", { name: "Motion", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "shadcn/ui", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page).toHaveURL(/\/inspiration$/);
  await page.getByLabel("搜索灵感网站", { exact: true }).fill("Mobbin");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/q=Mobbin/);
  await expect(page.locator("article")).toHaveCount(1);
  await context.route("https://mobbin.com/", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><meta charset='utf-8'><title>隔离官网跳转夹具</title><p>这里只验证新窗口链接。</p>" }));
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "打开 Mobbin 官网（新窗口）", exact: true }).click();
  const popup = await popupPromise; await popup.waitForLoadState("domcontentloaded");
  await expect(popup).toHaveURL("https://mobbin.com/"); await expect(popup).toHaveTitle("隔离官网跳转夹具");
  await popup.close(); await context.unroute("https://mobbin.com/");
  expect(data.mutations).toEqual([]);
});

test("mobile empty inspiration filters can be cleared without overflow or installation claims", async ({ page }) => {
  const data = await mockInspiration(page, [analyzedFixture()]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/inspiration?q=no-such-isolated-design&category=visual");
  await expect(page.getByText(/没有找到匹配的灵感网站。换个关键词，或清除筛选查看全部目录。/)).toBeVisible();
  await page.getByRole("button", { name: "查看全部灵感", exact: true }).click();
  await expect(page).toHaveURL(/\/inspiration$/);
  await expect(page.locator("article")).toHaveCount(inspirationCandidates.length);
  await expect(page.getByRole("button", { name: /安装/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "shadcn/ui", exact: true })).toBeVisible();
  await page.getByText("查看分析依据", { exact: true }).click();
  await expect(page.getByRole("link", { name: /ui\.shadcn\.com（官网依据，新窗口）/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(data.mutations).toEqual([]);
});
