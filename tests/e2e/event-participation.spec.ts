import { test, expect, type Page, type TestInfo } from "@playwright/test";
import type { RegistrationWindow } from "../../src/shared/registration-window.ts";
import type { EventWindow } from "../../src/shared/event-window.ts";

interface Card {
  id: string; revision: number; canonicalUrl: string; title: string; summary: string;
  analysis: { fit: string[]; risks: string[]; preparation: string[]; unknowns: string[] };
  sources: { url: string; title: string; excerpt: string; fetchedAt: string; sourceKind?: "page" | "indexed_excerpt" }[];
  discoveredAt: string; lastAnalyzedAt: string; provider: "dsh"; verificationStatus: "unverified";
  registration?: unknown; participation?: unknown; registrationWindow?: RegistrationWindow; eventWindow?: EventWindow;
}
const stamp = "2026-10-09T06:00:00.000Z";
const registrationUrl = "https://tickets.example.com/fixture-hackathon/register";
const evidence = "主办方公布的隔离报名说明：请通过指定入口报名。";
function card(id: string, title = `隔离参赛建议夹具 ${id}`): Card {
  const original = `https://events.example.com/fixture/${id}`;
  const deadline = "隔离报名说明：报名开放，报名截止日期为 2030年12月31日。";
  return { id, revision: 1, canonicalUrl: original, title, summary: "这是一条隔离浏览器夹具，用于核对参赛建议和报名入口，不代表真实赛事。",
    analysis: { fit: ["适合愿意做最小可运行原型的队伍", "适合能准备现场演示和仓库的参赛者", "适合能核对主办方规则的新人"],
      risks: ["需要核对团队人数和截止时区"], preparation: ["先列出最小作品与演示清单"], unknowns: ["报名资格尚需核实"] },
    sources: [{ url: original, title: "隔离公开赛事原文", excerpt: `${evidence}\n${deadline}`, fetchedAt: stamp, sourceKind: "page" }],
    registrationWindow: { status: "open", closesAt: null, closesOn: "2030-12-31", evidence: [deadline], checkedAt: stamp },
    discoveredAt: stamp, lastAnalyzedAt: stamp, provider: "dsh", verificationStatus: "unverified" };
}
function advised(id: string, recommendation: "consider" | "caution" | "insufficient_info" = "consider"): Card {
  const value = card(id);
  value.participation = { recommendation, reason: "DSH 根据赛事资料提供的隔离判断：先核对规则，再决定是否参赛。",
    suitableFor: ["愿意和队友协作完成原型的参赛者"], cautionFor: ["不能投入完整比赛时间的队伍需谨慎"] };
  return value;
}
async function fixture(page: Page, info: TestInfo, cards: Card[], saved?: Card) {
  // Fully intercepted HTTP fixtures: no database, DSH, provider, actual login,
  // or external registration service is used by this presentation test suite.
  const origin = new URL(String(info.project.use.baseURL ?? "http://localhost:3000")).origin;
  const errors: string[] = [], mutations: string[] = [], externalRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("hackathon-navigator-intro-v1", "seen"));
  await page.context().route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["https:", "http:"].includes(url.protocol) && url.origin !== origin) {
      externalRequests.push(url.href);
      if (url.href === registrationUrl) await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>隔离报名入口</title><p>仅用于新窗口验收。</p>" });
      else await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const projectId = "participation-preview-fixture";
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice("/api/v1".length);
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    let data: unknown, status = 200;
    if (path === "/event-discoveries") data = { items: cards, nextCursor: null };
    else if (path === "/event-discoveries/live") data = { version: "isolated-participation-version", count: cards.length, state: "waiting", minimumIntervalMs: 300000, lastCompletedAt: stamp, nextEligibleAt: stamp };
    else if (path === "/system/status") data = { mode: "local", database: "local", email: "preview", modelConfigured: false, githubConfigured: false, dshConfigured: false, discoveryConfigured: true, discoveryProvider: "dsh_native" };
    else if (path === "/navigator/intro") data = { version: "v1", title: "隔离导航介绍", sections: [], steps: [], links: [], chat: { provider: "dsh", configured: false } };
    else if (path === "/me") {
      if (saved) data = { profile: { id: "isolated-reader", email: "reader@example.test", displayName: "隔离项目成员", timezone: "Asia/Shanghai", revision: 1 } };
      else status = 401;
    } else if (path === `/projects/${projectId}`) data = {
      project: { id: projectId, name: "隔离只读赛事项目", teamId: null, eventId: null, createdBy: "isolated-manager", goal: "核对赛事建议", minimumDeliverable: "完成原型", stage: "preparing", timezone: "Asia/Shanghai", deadline: null, deadlineSource: "unknown", revision: 1, createdAt: stamp, updatedAt: stamp },
      membership: { membershipId: "isolated-membership", projectId, userId: "isolated-reader", role: "member", status: "active", revision: 1, joinedAt: stamp, leftAt: null }, members: [],
    };
    else if (path === `/projects/${projectId}/discovery-draft`) data = { revision: 1, sourceState: "current", draft: saved ? { projectId, discoveryId: saved.id, discoveryRevision: saved.revision, revision: 1, snapshot: saved, notes: "隔离队伍保存的备赛备注", status: "draft", savedBy: "isolated-manager", savedAt: stamp } : null };
    else if (path === `/projects/${projectId}/rules`) data = { confirmation: null, rules: null };
    else if (path === "/events") data = { items: [], nextCursor: null };
    else status = 404;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { data } : { error: { code: status === 401 ? "UNAUTHENTICATED" : "ISOLATED_ROUTE_UNAVAILABLE", message: "隔离夹具中未提供此服务" } }) });
  });
  return { projectId, errors, mutations, externalRequests };
}
function article(page: Page, title: string) { return page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) }); }

test("an evidenced registration link is separate from the original and DSH gives readable participation guidance", async ({ page }, info) => {
  const value = advised("registered");
  value.registration = { url: registrationUrl, sourceUrl: value.canonicalUrl, evidence };
  const startEvidence = "隔离比赛开赛日期为 2031年1月2日。";
  value.sources[0]!.excerpt += `\n${startEvidence}`;
  value.eventWindow = { status: "future", startsAt: null, startsOn: "2031-01-02", evidence: [startEvidence], checkedAt: stamp };
  const f = await fixture(page, info, [value]);
  await page.goto("/events");
  const view = article(page, value.title);
  await expect(view).toBeVisible();
  const information = view.locator("details[data-event-information]");
  await expect(information).not.toHaveAttribute("open", "");
  await expect(view.getByText(value.summary, { exact: true })).not.toBeVisible();
  for (const fit of value.analysis.fit) await expect(view.getByText(fit, { exact: true })).not.toBeVisible();
  await expect(view.getByRole("link", { name: "制定我的参赛计划", exact: true })).not.toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(view.getByText(/开赛时间：2031-01-02/)).toBeVisible();
  await expect(view.getByText(/报名截止：2030-12-31/)).toBeVisible();
  const registration = view.getByRole("link", { name: "查看报名入口（新窗口）", exact: true });
  await expect(registration).toHaveAttribute("href", registrationUrl);
  await expect(registration).toHaveAttribute("target", "_blank");
  await expect(registration).toHaveAttribute("rel", "noopener noreferrer");
  await expect(view.getByRole("link", { name: "查看赛事原文（新窗口）", exact: true })).toHaveAttribute("href", value.canonicalUrl);
  const popupPromise = page.waitForEvent("popup"); await registration.click();
  const popup = await popupPromise; await popup.waitForLoadState("domcontentloaded");
  await expect(popup).toHaveTitle("隔离报名入口"); await popup.close();
  const toggle = information.locator(":scope > summary");
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(information).toHaveAttribute("open", "");
  await expect(view.getByText("收起比赛信息与建议", { exact: true })).toBeVisible();
  await expect(view.getByText("值得了解", { exact: false }).first()).toBeVisible();
  await expect(view.getByText(value.summary, { exact: true })).toBeVisible();
  for (const fit of value.analysis.fit) await expect(view.getByText(fit, { exact: true })).toBeVisible();
  await expect(view.getByText("不能投入完整比赛时间的队伍需谨慎", { exact: true })).toBeVisible();
  await expect(view.getByRole("heading", { name: "选好这场比赛后，开始准备", exact: true })).toBeVisible();
  await expect(view.getByRole("link", { name: "制定我的参赛计划", exact: true })).toHaveAttribute("href", `/participation?event=${value.id}`);
  await expect(view.getByRole("link", { name: "在团队空间继续", exact: true })).toHaveAttribute("href", `/app?event=${value.id}`);
  await information.locator(":scope > summary").focus(); await page.keyboard.press("Space");
  await expect(information).not.toHaveAttribute("open", "");
  await expect(view.getByText("展开比赛信息与建议", { exact: true })).toBeVisible();
  await expect(view.getByText(value.summary, { exact: true })).not.toBeVisible();
  await expect(registration).toBeVisible();
  expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]); expect(f.externalRequests).toEqual([registrationUrl]);
});

test("missing registration and cautious or insufficient verdicts stay explicit without claiming personal eligibility", async ({ page }, info) => {
  const cautious = advised("cautious", "caution"), unknown = advised("unknown", "insufficient_info");
  cautious.registration = null; unknown.registration = null;
  const f = await fixture(page, info, [cautious, unknown]); await page.goto("/events");
  for (const [value, verdict] of [[cautious, "先核对再决定"], [unknown, "信息不足，暂无法判断"]] as const) {
    const view = article(page, value.title);
    await expect(view.locator("details[data-event-information]")).not.toHaveAttribute("open", "");
    await expect(view.getByText(verdict, { exact: false }).first()).not.toBeVisible();
    await view.getByText("展开比赛信息与建议", { exact: true }).click();
    await expect(view.getByText(verdict, { exact: false }).first()).toBeVisible();
    await expect(view.getByText("暂未找到明确报名链接，可从原文联系主办方。", { exact: true })).toBeVisible();
    await expect(view.getByRole("link", { name: "查看报名入口（新窗口）", exact: true })).toHaveCount(0);
    await expect(view.getByRole("link", { name: "查看赛事原文（新窗口）", exact: true })).toHaveAttribute("href", value.canonicalUrl);
  }
  for (const value of [cautious, unknown]) await expect(article(page, value.title).locator("details[data-event-information]")).toHaveAttribute("open", "");
  await article(page, cautious.title).getByText("收起比赛信息与建议", { exact: true }).click();
  await expect(article(page, unknown.title).locator("details[data-event-information]")).toHaveAttribute("open", "");
  await expect(page.getByText("报名未知或已结束的比赛也保留，请以主办方公告为准。", { exact: true })).toBeVisible();
  await expect(page.getByText(/匹配度.*%|你已符合报名资格/)).toHaveCount(0);
  expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]); expect(f.externalRequests).toEqual([]);
});

test("legacy analysis stays readable and indexed excerpts do not acquire a fabricated DSH verdict", async ({ page }, info) => {
  const legacy = card("legacy"), indexed = card("indexed"); indexed.sources[0]!.sourceKind = "indexed_excerpt";
  const f = await fixture(page, info, [legacy, indexed]); await page.goto("/events");
  for (const value of [legacy, indexed]) {
    const view = article(page, value.title);
    await expect(view.getByText(value.analysis.fit[0], { exact: true })).not.toBeVisible();
    if (value === indexed) await expect(view.getByText("搜索引用 · 未读取全文，请打开原文确认完整规则。", { exact: true })).toBeVisible();
    await view.getByText("展开比赛信息与建议", { exact: true }).click();
    await expect(view.getByText("参赛判断信息不完整，以下保留已有 DSH 分析供核对。", { exact: true })).toBeVisible();
    for (const fit of value.analysis.fit.slice(0, 2)) await expect(view.getByText(fit, { exact: true }).first()).toBeVisible();
    await expect(view.getByText(/DSH 参赛建议：/)).toHaveCount(0);
  }
  const indexedView = article(page, indexed.title);
  await expect(indexedView.getByText("搜索引用 · 未读取全文，请打开原文确认完整规则。", { exact: true })).toBeVisible();
  await indexedView.getByText("查看分析依据", { exact: true }).click();
  await expect(indexedView.getByText(/^搜索引用获取于/)).toBeVisible();
  expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]); expect(f.externalRequests).toEqual([]);
});

test("unsafe or unsubstantiated registration metadata produces no actionable registration link", async ({ page }, info) => {
  const entries = [
    { url: "javascript:alert(1)" }, { url: "data:text/html,unsafe" }, { url: "https://someone:secret@tickets.example.com/register" },
    { url: "https://tickets.example.com/login" }, { url: "https://tickets.example.com/register?access_token=private" },
    { url: "https://tickets.example.com/redirect?target=https://malicious.example.com" }, { url: "https://bit.ly/ambiguous" },
    { url: "http://127.0.0.1:3000/private" }, { sourceUrl: "https://unrelated.example.com/no-source" },
    { evidence: "没有出现在来源里的报名说明" }, { evidence: 123 }, { extraField: "untrusted" },
  ];
  const cards = entries.map((entry, index) => { const value = card(`unsafe-${index}`); value.registration = { url: registrationUrl, sourceUrl: value.canonicalUrl, evidence, ...entry }; return value; });
  cards[0]!.participation = { recommendation: ["consider"], reason: "不能把错误类型转成建议", suitableFor: [], cautionFor: [] };
  const f = await fixture(page, info, cards); await page.goto("/events");
  await expect(page.locator("article")).toHaveCount(entries.length);
  await expect(page.getByRole("link", { name: "查看报名入口（新窗口）", exact: true })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"],a[href^="data:"],a[href*="access_token"],a[href*="someone:secret"]')).toHaveCount(0);
  for (const value of cards) await expect(article(page, value.title).getByText("暂未找到明确报名链接，可从原文联系主办方。", { exact: true })).toBeVisible();
  await article(page, cards[0]!.title).getByText("展开比赛信息与建议", { exact: true }).click();
  await expect(article(page, cards[0]!.title).getByText("参赛判断信息不完整，以下保留已有 DSH 分析供核对。", { exact: true })).toBeVisible();
  expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]); expect(f.externalRequests).toEqual([]);
});

for (const width of [320, 390, 1280]) test(`event disclosures and long guidance fit ${width}px with reachable touch controls`, async ({ page }, info) => {
  const value = advised(`viewport-${width}`); value.title = "隔离赛事信息折叠验收（非真实比赛）";
  value.registration = { url: registrationUrl, sourceUrl: value.canonicalUrl, evidence };
  value.summary += "LongHackathonTitleWithoutSpaces".repeat(4);
  value.analysis.fit[0] = "适合希望和队友一起完成作品的新人：" + "LongProjectIdentifierWithoutSpaces".repeat(4);
  const f = await fixture(page, info, [value]); await page.setViewportSize({ width, height: 900 }); await page.goto("/events");
  const view = article(page, value.title);
  await expect(view).toBeVisible(); await expect(view.getByRole("link", { name: "查看报名入口（新窗口）", exact: true })).toBeVisible();
  const information = view.locator("details[data-event-information]");
  const toggle = information.locator(":scope > summary");
  const size = await toggle.boundingBox(); expect(size?.height).toBeGreaterThanOrEqual(44);
  await expect(information).not.toHaveAttribute("open", "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (width !== 320) await view.screenshot({ path: `.runtime/previews/event-fold-${width}-collapsed.png` });
  await toggle.click(); await view.getByText("查看分析依据", { exact: true }).click();
  await expect(view.getByText(value.analysis.fit[0], { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (width < 650) await expect(page.getByText("更多待更新位置（18 个）", { exact: true })).toBeVisible();
  if (width !== 320) await view.screenshot({ path: `.runtime/previews/event-fold-${width}.png` });
  expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]); expect(f.externalRequests).toEqual([]);
});

test("saved project snapshots present the same evidenced entry and full guidance to a read-only member", async ({ page }, info) => {
  const value = advised("saved", "caution"); value.registration = { url: registrationUrl, sourceUrl: value.canonicalUrl, evidence };
  const f = await fixture(page, info, [value], value); await page.goto(`/app/projects/${f.projectId}/rules`);
  const panel = page.getByRole("region", { name: "赛事线索草案", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("先核对再决定", { exact: false })).toBeVisible();
  await expect(panel.getByText(value.analysis.fit[2], { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "查看报名入口（新窗口）", exact: true })).toHaveAttribute("href", registrationUrl);
  await expect(panel.getByRole("link", { name: "查看赛事原文（新窗口）", exact: true })).toHaveAttribute("href", value.canonicalUrl);
  await expect(panel.getByText("当前可阅读草案。只有未归档项目的管理员可以编辑、替换或清除。", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button")).toHaveCount(0); await expect(panel.getByRole("radio")).toHaveCount(0);
  expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]); expect(f.externalRequests).toEqual([]);
});
