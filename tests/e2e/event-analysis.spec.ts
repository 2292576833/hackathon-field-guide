import { test, expect } from "@playwright/test";
import { createDatabase } from "../../src/server/database.ts";
import { createApplication } from "../../src/server/application.ts";
import { dispatch } from "../../src/server/router.ts";
import type { RegistrationWindow } from "../../src/shared/registration-window.ts";

const registrationQuote = "隔离报名说明：报名开放，报名截止日期为 2030年12月31日。";
function registrationWindow(checkedAt: string): RegistrationWindow {
  return { status: "open", closesAt: null, closesOn: "2030-12-31", evidence: [registrationQuote], checkedAt };
}

test("the public results page shows analysis and website links, and SQL-backed pagination exposes older results", async ({ page }) => {
  const database = await createDatabase({});
  try {
    const app = await createApplication({ mode: "local", origin: "http://localhost:3000", codePepper: "fixture-events-analysis-pepper-32bytes", emailFrom: "fixture@localhost.invalid" }, database);
    for (let index = 0; index < 61; index++) {
      await app.discoveries.save({ canonicalUrl: `https://ethglobal.com/events/fixture-${index}`, title: `隔离夹具比赛 ${index}`, summary: "这条分析来自隔离测试数据库。",
        analysis: { fit: ["适合初次参赛"], risks: ["需确认资格"], preparation: ["先完成最小作品"], unknowns: ["时区待确认"] },
        sources: [{ url: `https://ethglobal.com/events/fixture-${index}`, title: "测试来源", excerpt: registrationQuote, fetchedAt: app.clock.now().toISOString() }], registrationWindow: registrationWindow(app.clock.now().toISOString()), discoveredAt: app.clock.now().toISOString(), lastAnalyzedAt: app.clock.now().toISOString(), provider: "dsh" });
    }
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      const response = await dispatch(app, new Request(url, { method: route.request().method(), headers: route.request().headers() }), url.pathname.slice("/api/v1/".length).split("/"));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/events");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "比赛分析", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "前往比赛官网（新窗口）", exact: true })).toHaveCount(60);
    await expect(page.getByRole("button", { name: "查看更多比赛", exact: true })).toBeVisible();
    const information = page.locator("article details[data-event-information]").first();
    await expect(information).not.toHaveAttribute("open", "");
    await page.getByText("展开比赛信息与建议", { exact: true }).first().click();
    await expect(information).toHaveAttribute("open", "");
    await page.getByText("收起比赛信息与建议", { exact: true }).first().click();
    const latestNames = await page.locator("article h3").allTextContents();
    await expect(page.getByLabel("筛选已发布赛事", { exact: true })).toHaveCount(0);
    await expect(page.getByText("还没有已发布比赛", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "查看更多比赛", exact: true }).click();
    await expect(page.getByRole("link", { name: "前往比赛官网（新窗口）", exact: true })).toHaveCount(1);
    const older = await page.locator("article h3").innerText(); expect(latestNames).not.toContain(older);
    await expect(page.getByRole("button", { name: "查看更多比赛", exact: true })).toHaveCount(0);
    const outbound = page.getByRole("link", { name: "前往比赛官网（新窗口）", exact: true });
    await expect(outbound).toHaveAttribute("href", /^https:\/\/ethglobal\.com\/events\/fixture-\d+$/);
    await expect(outbound).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "返回最新比赛", exact: true }).click();
    await expect(outbound).toHaveCount(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.unrouteAll({ behavior: "wait" }); await database.close(); }
});

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 1000 },
]) {
  test(`native indexed citations and social original pages retain evidence scope and dates on ${viewport.name}`, async ({ page, context }) => {
    // An independent PostgreSQL-compatible fixture database, never the running
    // site's persistent inventory. There is no configured DSH or search key.
    const database = await createDatabase({});
    const indexedUrl = "https://mp.weixin.qq.com/s/fixture-native-indexed-e2e";
    const socialUrl = "https://weibo.com/fixture_events/fixture-original-e2e";
    const indexedTitle = "隔离夹具搜索引用赛事：公开报名线索与待确认规则";
    const socialTitle = "隔离夹具微博原文赛事";
    const indexedExcerpt = `隔离夹具搜索引用：仅取得公开索引中的报名线索，未读取原文全文。${registrationQuote}`;
    const pageExcerpt = `隔离夹具微博页面摘录：报名要求以主办方后续公告为准。${registrationQuote}`;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const app = await createApplication({ mode: "local", origin: "http://localhost:3000", codePepper: "fixture-native-events-pepper-32bytes", emailFrom: "fixture@localhost.invalid" }, database);
      app.clock.now = () => new Date("2026-10-09T06:00:00.000Z");
      const discoveredAt = "2026-10-09T04:00:00.000Z";
      const analysis = { fit: ["仅用于隔离页面验收"], risks: ["完整资格规则仍待核验"], preparation: ["打开赛事原文确认要求"], unknowns: ["搜索引用不代表完整资格规则"] };
      await app.discoveries.save({ canonicalUrl: indexedUrl, title: indexedTitle, summary: "这条隔离夹具卡片来自搜索引用；不代表真实比赛或完整规则。", analysis,
        sources: [{ url: indexedUrl, title: "隔离夹具搜索引用", excerpt: indexedExcerpt, fetchedAt: "2026-10-08T10:30:00.000Z", sourceKind: "indexed_excerpt" }],
        registrationWindow: registrationWindow(discoveredAt), discoveredAt, lastAnalyzedAt: discoveredAt, provider: "dsh" });
      await app.discoveries.save({ canonicalUrl: socialUrl, title: socialTitle, summary: "这条隔离夹具卡片的依据来自微博页面摘录；不代表人工核验。", analysis,
        sources: [{ url: socialUrl, title: "隔离夹具微博页面依据", excerpt: pageExcerpt, fetchedAt: "2026-10-07T10:15:00.000Z", sourceKind: "page" }],
        registrationWindow: registrationWindow(discoveredAt), discoveredAt, lastAnalyzedAt: discoveredAt, provider: "dsh" });
      await page.route("**/api/v1/**", async route => {
        const url = new URL(route.request().url());
        const response = await dispatch(app, new Request(url, { method: route.request().method(), headers: route.request().headers() }), url.pathname.slice("/api/v1/".length).split("/"));
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      });
      // Clicking the original-page links opens intercepted fixture documents;
      // the test never contacts either social platform or an external account.
      for (const url of [indexedUrl, socialUrl]) await context.route(url, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>隔离赛事原文夹具</title><p>仅用于出站链接验收。</p>" }));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/events");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "比赛分析", exact: true })).toBeVisible();
      const indexedCard = page.locator("article").filter({ has: page.getByRole("heading", { name: indexedTitle, exact: true }) });
      const socialCard = page.locator("article").filter({ has: page.getByRole("heading", { name: socialTitle, exact: true }) });
      await expect(indexedCard).toBeVisible(); await expect(socialCard).toBeVisible();
      const limitedEvidence = "搜索引用 · 未读取全文，请打开原文确认完整规则。";
      await expect(indexedCard.getByText(limitedEvidence, { exact: true })).toBeVisible();
      await expect(socialCard.getByText(limitedEvidence, { exact: true })).toHaveCount(0);
      await expect(page.getByText("AI 分析 · 未人工核验", { exact: true })).toHaveCount(2);
      await expect(page.getByRole("link", { name: "前往比赛官网（新窗口）", exact: true })).toHaveCount(0);
      for (const [card, url] of [[indexedCard, indexedUrl], [socialCard, socialUrl]] as const) {
        const outbound = card.getByRole("link", { name: "查看赛事原文（新窗口）", exact: true });
        await expect(outbound).toHaveAttribute("href", url);
        await expect(outbound).toHaveAttribute("target", "_blank");
        await expect(outbound).toHaveAttribute("rel", "noopener noreferrer");
        await expect(card.locator("details[data-event-information]")).not.toHaveAttribute("open", "");
        await card.getByText("展开比赛信息与建议", { exact: true }).click();
        await expect(card.locator("details").last()).not.toHaveAttribute("open", "");
        await card.getByText("查看分析依据", { exact: true }).click();
        await expect(card.locator("details").last()).toHaveAttribute("open", "");
        const popupPromise = page.waitForEvent("popup"); await outbound.click();
        const popup = await popupPromise; await popup.waitForLoadState("domcontentloaded");
        await expect(popup).toHaveURL(url); await expect(popup).toHaveTitle("隔离赛事原文夹具"); await popup.close();
      }
      await expect(indexedCard.getByText(indexedExcerpt, { exact: true })).toBeVisible();
      await expect(indexedCard.getByText(/^搜索引用获取于 /)).toHaveText(/搜索引用获取于\s+2026年10月8日\s+18:30（北京时间）/);
      await expect(indexedCard.getByText(/^页面获取于 /)).toHaveCount(0);
      await expect(socialCard.getByText(pageExcerpt, { exact: true })).toBeVisible();
      await expect(socialCard.getByText(/^页面获取于 /)).toHaveText(/页面获取于\s+2026年10月7日\s+18:15（北京时间）/);
      await expect(socialCard.getByText(/^搜索引用获取于 /)).toHaveCount(0);
      for (const card of [indexedCard, socialCard]) await expect(card.getByText(/^分析于 /)).toHaveText(/分析于\s+2026年10月9日\s+12:00（北京时间）/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "expanded fixture evidence must fit the viewport").toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await context.unroute(indexedUrl); await context.unroute(socialUrl);
      await database.close();
    }
  });
}
