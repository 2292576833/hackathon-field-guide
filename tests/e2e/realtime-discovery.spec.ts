import { test, expect, type Page } from "@playwright/test";
import type { RegistrationWindow } from "../../src/shared/registration-window.ts";

type BackendState = "running" | "waiting" | "paused" | "limited" | "attention" | "offline" | "unconfigured";
function card(title: string, id: string) {
  const deadline = "隔离报名说明：报名开放，报名截止日期为 2030年12月31日。";
  return { id, canonicalUrl: `https://ethglobal.com/events/isolated-${id}`, title, summary: "隔离测试卡片，不代表真实赛事。",
    analysis: { fit: ["页面验收夹具"], risks: ["需核对官方要求"], preparation: ["打开原文"], unknowns: ["资格待确认"] },
    sources: [{ url: `https://ethglobal.com/events/isolated-${id}`, title: "隔离测试依据", excerpt: deadline, fetchedAt: "2026-10-09T03:00:00.000Z" }],
    registrationWindow: { status: "open", closesAt: null, closesOn: "2030-12-31", evidence: [deadline], checkedAt: "2026-10-09T03:00:00.000Z" } as RegistrationWindow,
    lastAnalyzedAt: "2026-10-09T03:00:00.000Z", verificationStatus: "unverified" };
}

async function fixture(page: Page, options: { holdInitialList?: boolean; holdInitialLive?: boolean; deferReady?: boolean; legacyVersion?: boolean; empty?: boolean } = {}) {
  // All requests are fulfilled in the browser. No persistent database, model,
  // search provider, or real external event website is contacted by these tests.
  const data = { version: "fixture-version-1", state: "waiting" as BackendState, failLive: false, failListReads: 0,
    holdNextLive: options.holdInitialLive ?? false, heldLiveReads: 0, releaseHeldLive: null as (() => void) | null,
    holdNextList: options.holdInitialList ?? false, heldListReads: 0, releaseHeldList: null as (() => void) | null,
    latest: options.empty ? [] : [card("隔离夹具最新比赛一", "one")], older: [card("隔离夹具历史比赛", "older")],
    liveReads: 0, liveCompleted: 0, listReads: 0, listCompleted: 0, mutations: [] as string[] };
  await page.addInitScript(() => localStorage.setItem("hackathon-navigator-intro-v1", "seen"));
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") data.mutations.push(`${request.method()} ${url.pathname}`);
    let status = 200, body: unknown, heldRequest = false;
    if (url.pathname === "/api/v1/event-discoveries/live") {
      data.liveReads++;
      if (data.failLive) { status = 503; body = { error: { code: "FIXTURE_DISCONNECTED", message: "隔离连接失败" } }; }
      else body = { data: { version: data.version, count: data.latest.length + data.older.length, state: data.state, minimumIntervalMs: 300000,
        lastCompletedAt: "2026-10-09T02:00:00.000Z", nextEligibleAt: "2026-10-09T02:05:00.000Z" } };
      if (data.holdNextLive) {
        data.holdNextLive = false; heldRequest = true; data.heldLiveReads++;
        await new Promise<void>(resolve => { data.releaseHeldLive = resolve; });
      }
    } else if (url.pathname === "/api/v1/event-discoveries") {
      data.listReads++;
      // Freeze the cards and inventory hash together before delaying transport. A
      // concurrent save must not rewrite a response's already-read SQL snapshot.
      if (data.failListReads > 0) { data.failListReads--; status = 503; body = { error: { code: "FIXTURE_LIST_UNAVAILABLE", message: "隔离卡片读取暂时失败" } }; }
      else body = { data: { items: structuredClone(url.searchParams.has("cursor") ? data.older : data.latest),
        nextCursor: url.searchParams.has("cursor") ? null : "fixture-older", ...(options.legacyVersion ? {} : { version: data.version }) } };
      if (data.holdNextList) {
        data.holdNextList = false; heldRequest = true; data.heldListReads++;
        await new Promise<void>(resolve => { data.releaseHeldList = resolve; });
      }
    } else if (url.pathname === "/api/v1/system/status") {
      body = { data: { mode: "local", database: "local", email: "preview", modelConfigured: false, githubConfigured: false, dshConfigured: false, discoveryConfigured: true, discoveryProvider: "dsh_native" } };
    } else if (url.pathname === "/api/v1/navigator/intro") {
      body = { data: { version: "v1", title: "隔离导航介绍", sections: [], steps: [], links: [], chat: { provider: "dsh", configured: false } } };
    } else {
      status = 401; body = { error: { code: "UNAUTHENTICATED", message: "未登录的隔离浏览者" } };
    }
    try {
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/v1/event-discoveries/live") data.liveCompleted++;
      else if (url.pathname === "/api/v1/event-discoveries") data.listCompleted++;
    }
    catch (error) { if (!heldRequest) throw error; /* The timeout intentionally cancels the held browser request. */ }
  });
  await page.goto("/events");
  if (!options.deferReady) {
    if (!options.empty) await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
    await expect.poll(() => data.liveCompleted).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("button", { name: "查看更多比赛", exact: true })).toBeEnabled();
  }
  return data;
}

async function installPausedClock(page: Page) {
  const initialTime = new Date("2026-10-09T06:00:00.000Z");
  await page.clock.install({ time: initialTime });
  // Freeze before loading application code, so advancing to this future instant
  // cannot fire any existing feed request or timeout during initialization.
  await page.clock.pauseAt(new Date(initialTime.getTime() + 60_000));
}

async function checkAtCurrentClockInstant(page: Page) {
  await page.evaluate(() => {
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("a stable initial feed reads the full inventory once when metadata arrives first", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { holdInitialList: true, deferReady: true });
  await expect.poll(() => data.heldListReads).toBe(1);
  await expect.poll(() => data.liveCompleted).toBe(1);
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveCompleted).toBe(2);
  expect(data.listReads).toBe(1);
  data.releaseHeldList?.();
  await expect(page.getByRole("heading", { name: data.latest[0]!.title, exact: true })).toBeVisible();
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveCompleted).toBe(3);
  expect(data.listReads).toBe(1);
  expect(data.mutations).toEqual([]);
});

test("a stable initial feed reads the full inventory once when cards arrive first", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { holdInitialLive: true, deferReady: true });
  await expect(page.getByRole("heading", { name: data.latest[0]!.title, exact: true })).toBeVisible();
  await expect.poll(() => data.heldLiveReads).toBe(1);
  data.releaseHeldLive?.();
  await expect.poll(() => data.liveCompleted).toBe(1);
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveCompleted).toBe(2);
  expect(data.listReads).toBe(1);
});

test("an empty saved inventory also needs only one initial list read", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { empty: true });
  await expect(page.getByText("本页 0 个分析结果", { exact: true })).toBeVisible();
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveCompleted).toBe(2);
  expect(data.listReads).toBe(1);
});

test("a new version observed during the initial read is fetched after the old snapshot arrives", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { holdInitialList: true, deferReady: true });
  await expect.poll(() => data.heldListReads).toBe(1);
  await expect.poll(() => data.liveCompleted).toBe(1);
  const fresh = card("隔离首屏加载期间的新比赛", "initial-race");
  data.latest = [fresh]; data.version = "fixture-initial-race";
  await checkAtCurrentClockInstant(page);
  await expect.poll(() => data.liveCompleted).toBe(2);
  expect(data.listReads).toBe(1);
  data.releaseHeldList?.();
  await expect(page.getByRole("heading", { name: fresh.title, exact: true })).toBeVisible();
  expect(data.listReads).toBe(2);
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveCompleted).toBe(3);
  expect(data.listReads).toBe(2);
});

test("another update during catch-up is not lost and each list request is allowed to finish", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { holdInitialList: true, deferReady: true });
  await expect.poll(() => data.heldListReads).toBe(1);
  await expect.poll(() => data.liveCompleted).toBe(1);
  data.latest = [card("隔离中间版本", "middle")]; data.version = "fixture-middle";
  await checkAtCurrentClockInstant(page);
  await expect.poll(() => data.liveCompleted).toBe(2);
  data.holdNextList = true;
  data.releaseHeldList?.();
  await expect.poll(() => data.heldListReads).toBe(2);
  const newest = card("隔离补读期间的最新比赛", "newest");
  data.latest = [newest]; data.version = "fixture-newest";
  await checkAtCurrentClockInstant(page);
  await expect.poll(() => data.liveCompleted).toBe(3);
  expect(data.listReads).toBe(2);
  data.releaseHeldList?.();
  await expect(page.getByRole("heading", { name: newest.title, exact: true })).toBeVisible();
  expect(data.listReads).toBe(3);
  expect(data.listCompleted).toBe(3);
});

test("a pending initial catch-up survives becoming hidden before the old list finishes", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { holdInitialList: true, deferReady: true });
  await expect.poll(() => data.heldListReads).toBe(1);
  await expect.poll(() => data.liveCompleted).toBe(1);
  const fresh = card("隔离隐藏后恢复的待补读比赛", "pending-hidden");
  data.latest = [fresh]; data.version = "fixture-pending-hidden";
  await checkAtCurrentClockInstant(page);
  await expect.poll(() => data.liveCompleted).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  data.releaseHeldList?.();
  await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
  expect(data.listReads).toBe(1);
  await checkAtCurrentClockInstant(page);
  await expect(page.getByRole("heading", { name: fresh.title, exact: true })).toBeVisible();
  expect(data.listReads).toBe(2);
});

test("legacy list responses without a version get one bounded conservative catch-up", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page, { legacyVersion: true });
  await expect.poll(() => data.listCompleted).toBe(2);
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveCompleted).toBe(2);
  expect(data.listReads).toBe(2);
});

test("the public feed keeps saved cards and labels registration status", async ({ page }) => {
  const data = await fixture(page);
  const open = card("隔离夹具仍可报名", "open");
  const expired = card("隔离夹具已截止", "expired");
  expired.registrationWindow = { ...expired.registrationWindow, closesOn: "2020-01-01" };
  const uncertain = card("隔离夹具截止不明确", "uncertain");
  uncertain.registrationWindow = { ...uncertain.registrationWindow, status: "unknown", closesOn: null };
  data.latest = [open, expired, uncertain];
  data.version = "fixture-registration-filter";
  await expect(page.getByRole("heading", { name: open.title, exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole("heading", { name: expired.title, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: uncertain.title, exact: true })).toBeVisible();
  await expect(page.getByText("本页 3 个分析结果", { exact: true })).toBeVisible();
  await expect(page.getByText("报名未截止", { exact: true })).toBeVisible();
  await expect(page.getByText(/报名截止：2030-12-31（原文未说明时区）/)).toBeVisible();
  data.latest = [expired, uncertain]; data.version = "fixture-no-open-registration";
  await expect(page.getByText("本页 2 个分析结果", { exact: true })).toBeVisible({ timeout: 7000 });
  expect(data.mutations).toEqual([]);
});

test("an already loaded card remains visible after its registration cutoff passes", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page);
  const expires = card("隔离夹具即将报名截止", "expires");
  const quote = "Registration closes 2026-10-09T06:01:02Z.";
  expires.registrationWindow = { status: "open", closesAt: "2026-10-09T06:01:02Z", closesOn: null, evidence: [quote], checkedAt: "2026-10-09T03:00:00Z" };
  data.latest = [expires]; data.version = "fixture-imminent-registration-deadline";
  await checkAtCurrentClockInstant(page);
  await expect(page.getByRole("heading", { name: expires.title, exact: true })).toBeVisible();
  const reads = data.listReads;
  await page.clock.fastForward(3001);
  await expect(page.getByRole("heading", { name: expires.title, exact: true })).toBeVisible();
  expect(data.listReads).toBe(reads);
  expect(data.mutations).toEqual([]);
});

test("saved card changes update automatically while status-only changes do not reload the inventory", async ({ page }) => {
  const data = await fixture(page);
  const originalReads = data.listReads;
  const originalLive = data.liveCompleted;
  data.state = "running";
  await expect.poll(() => data.liveCompleted, { timeout: 7000 }).toBeGreaterThan(originalLive);
  expect(data.listReads).toBe(originalReads);
  data.latest = [card("隔离夹具新保存比赛", "two"), ...data.latest];
  data.version = "fixture-version-2";
  await expect(page.getByRole("heading", { name: "隔离夹具新保存比赛", exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByText("本页 2 个分析结果", { exact: true })).toBeVisible();
  expect(data.listReads).toBeGreaterThan(originalReads);
  expect(data.mutations).toEqual([]);
});

test("live card updates preserve independently expanded information and evidence", async ({ page }) => {
  const data = await fixture(page);
  const first = data.latest[0]!, second = card("隔离夹具第二个可独立展开的比赛", "second");
  data.latest = [first, second]; data.version = "fixture-two-disclosures";
  await checkAtCurrentClockInstant(page);
  const view = (title: string) => page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const firstView = view(first.title), secondView = view(second.title);
  await expect(secondView).toBeVisible();
  for (const entry of [firstView, secondView]) {
    await expect(entry.locator("details[data-event-information]")).not.toHaveAttribute("open", "");
    await entry.getByText("展开比赛信息与建议", { exact: true }).click();
  }
  await firstView.getByText("查看分析依据", { exact: true }).click();
  const updated = { ...first, summary: "隔离夹具同一比赛的新保存分析，保持当前阅读位置。" };
  const added = card("隔离夹具更新时新增的比赛", "added");
  data.latest = [added, updated, second]; data.version = "fixture-updated-open-disclosures";
  await checkAtCurrentClockInstant(page);
  await expect(firstView.getByText(updated.summary, { exact: true })).toBeVisible();
  for (const entry of [firstView, secondView]) await expect(entry.locator("details[data-event-information]")).toHaveAttribute("open", "");
  await expect(firstView.locator("details[data-event-information] details")).toHaveAttribute("open", "");
  await expect(view(added.title).locator("details[data-event-information]")).not.toHaveAttribute("open", "");
  await secondView.getByText("收起比赛信息与建议", { exact: true }).click();
  await expect(firstView.getByText(updated.summary, { exact: true })).toBeVisible();
  await expect(secondView.locator("details[data-event-information]")).not.toHaveAttribute("open", "");
  expect(data.mutations).toEqual([]);
});

test("hidden pages stop metadata requests and immediately catch up when visible again", async ({ page }) => {
  const data = await fixture(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenReads = data.liveReads;
  data.latest = [card("隔离夹具隐藏期间新比赛", "hidden")];
  data.version = "fixture-version-hidden";
  await page.waitForTimeout(3500);
  expect(data.liveReads).toBe(hiddenReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("heading", { name: "隔离夹具隐藏期间新比赛", exact: true })).toBeVisible({ timeout: 2500 });
  expect(data.liveReads).toBeGreaterThan(hiddenReads);
  expect(data.mutations).toEqual([]);
});

test("new inventory keeps the historical page in place until the reader returns to latest", async ({ page }) => {
  const data = await fixture(page);
  await page.getByRole("button", { name: "查看更多比赛", exact: true }).click();
  await expect(page.getByRole("heading", { name: "隔离夹具历史比赛", exact: true })).toBeVisible();
  const historicalReads = data.listReads;
  data.latest = [card("隔离夹具历史阅读期间新比赛", "fresh")];
  data.version = "fixture-version-while-reading";
  await expect(page.getByText("已有新的比赛分析，当前阅读位置已保留。", { exact: true })).toBeVisible({ timeout: 7000 });
  expect(data.listReads).toBe(historicalReads);
  await expect(page.getByRole("heading", { name: "隔离夹具历史比赛", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "隔离夹具历史阅读期间新比赛", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "查看最新比赛", exact: true }).click();
  await expect(page.getByRole("heading", { name: "隔离夹具历史阅读期间新比赛", exact: true })).toBeVisible();
  await expect(page.getByText("已有新的比赛分析，当前阅读位置已保留。", { exact: true })).toHaveCount(0);
  expect(data.mutations).toEqual([]);
});

test("metadata failure preserves cards and later reconnects and catches up", async ({ page }) => {
  const data = await fixture(page);
  const readsBeforeFailure = data.listReads;
  const liveBeforeFailure = data.liveCompleted;
  data.failLive = true;
  await expect.poll(() => data.liveCompleted, { timeout: 7000 }).toBeGreaterThan(liveBeforeFailure);
  await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
  expect(data.listReads).toBe(readsBeforeFailure);
  data.failLive = false; data.state = "limited";
  const reconnected = card("隔离重连后已保存比赛", "reconnected");
  data.latest = [reconnected, ...data.latest]; data.version = "fixture-reconnected";
  await expect(page.getByRole("heading", { name: reconnected.title, exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
  expect(data.mutations).toEqual([]);
});

test("a transient card-read failure automatically retries the same saved version", async ({ page }) => {
  const data = await fixture(page);
  data.latest = [card("隔离夹具自动重试恢复比赛", "recovered")];
  data.version = "fixture-version-recover";
  data.failListReads = 1;
  const cardError = page.getByRole("alert").filter({ hasText: "隔离卡片读取暂时失败" });
  await expect(cardError).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
  const failedReads = data.listReads;
  await expect(page.getByRole("heading", { name: "隔离夹具自动重试恢复比赛", exact: true })).toBeVisible({ timeout: 7000 });
  expect(data.listReads).toBe(failedReads + 1);
  expect(data.version).toBe("fixture-version-recover");
  await expect(cardError).toHaveCount(0);
  expect(data.mutations).toEqual([]);
});

test("a hanging metadata request times out after ten seconds and polling resumes", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page);
  data.holdNextLive = true;
  // Start the held request at an exact paused-clock instant instead of depending
  // on the remainder of the previous three-second polling interval.
  await checkAtCurrentClockInstant(page);
  await expect.poll(() => data.heldLiveReads).toBe(1);
  const heldReads = data.liveReads;
  await page.clock.runFor(9999);
  expect(data.liveReads).toBe(heldReads);
  await page.clock.runFor(1);
  // Next's route announcer also has role=alert; only feed errors matter here.
  const feed = page.locator("section").filter({ has: page.getByRole("heading", { name: "比赛分析", exact: true }) });
  await expect(feed.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
  data.releaseHeldLive?.();
  await page.clock.runFor(3000);
  await expect.poll(() => data.liveReads).toBe(heldReads + 1);
  expect(data.mutations).toEqual([]);
});

test("a hanging card read times out and automatically retries without a new saved version", async ({ page }) => {
  await installPausedClock(page);
  const data = await fixture(page);
  data.latest = [card("隔离夹具卡片超时恢复比赛", "list-timeout-recovered")];
  data.version = "fixture-version-list-timeout";
  data.holdNextList = true;
  await checkAtCurrentClockInstant(page);
  await expect.poll(() => data.heldListReads).toBe(1);
  const heldReads = data.listReads;
  const timeoutError = page.getByRole("alert").filter({ hasText: "读取超时，请稍后重试。" });
  await page.clock.runFor(9999);
  await expect(timeoutError).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "隔离夹具最新比赛一", exact: true })).toBeVisible();
  expect(data.listReads).toBe(heldReads);
  await page.clock.runFor(1);
  await expect(timeoutError).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载比赛", exact: true })).toBeEnabled();
  data.releaseHeldList?.();
  // A visibility check is a read-only metadata tick. It observes the same
  // version and the failed card-read state, without clicking a reload button.
  await checkAtCurrentClockInstant(page);
  await expect(page.getByRole("heading", { name: "隔离夹具卡片超时恢复比赛", exact: true })).toBeVisible();
  await expect(timeoutError).toHaveCount(0);
  expect(data.listReads).toBe(heldReads + 1);
  expect(data.version).toBe("fixture-version-list-timeout");
  expect(data.mutations).toEqual([]);
});
