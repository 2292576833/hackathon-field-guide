import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createDatabase } from "../../src/server/database.ts";
import { createApplication } from "../../src/server/application.ts";
import { dispatch } from "../../src/server/router.ts";
import { createNavigatorService, type NavigatorMessageInput } from "../../src/server/navigator.ts";
import { AiProviderError, type JsonModelPort, type JsonModelRequest, type JsonModelResult } from "../../src/server/ai.ts";
import type { Project } from "../../src/modules/projects/model.ts";

interface Identity { userId: string; cookie: string }
interface ChatContext {
  message: string;
  history: NonNullable<NavigatorMessageInput["history"]>;
  pagePath: string;
  project: { name: string; stage: string; goal: string } | null;
}
interface ControlledTurn {
  request: JsonModelRequest;
  release(reply: string): void;
  cancel(): void;
}

/** Explicit model fixture: responses are controlled by each test. This verifies
 * the real UI/router/session/project boundary, not a real DSH provider call. */
function controlledModel() {
  const turns: ControlledTurn[] = [];
  const model: JsonModelPort = {
    modelVersion: "fixture-dsh-chat-model",
    completeJSON(request, signal) {
      return new Promise<JsonModelResult>((resolve, reject) => {
        let settled = false;
        const finish = (reply?: string) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (reply === undefined) reject(new AiProviderError("AI_CANCELLED", "not_sent"));
          else resolve({ content: { reply, linkIds: [] }, usage: { inputTokens: 20, outputTokens: 10 }, requestId: "fixture-model-response", modelVersion: model.modelVersion });
        };
        const abort = () => finish();
        turns.push({ request: structuredClone(request), release: reply => finish(reply), cancel: abort });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
  return { model, turns };
}

/** No persistent directory, environment configuration, real provider or worker
 * is used. Every browser API call is dispatched into this isolated SQL engine. */
async function isolatedChat(page: Page, info: TestInfo, options: { signedIn?: boolean; mismatchedProvider?: boolean } = {}) {
  const origin = new URL(String(info.project.use.baseURL ?? "http://localhost:3000")).origin;
  const database = await createDatabase({});
  const fixtureModel = controlledModel();
  try {
    const app = await createApplication({ mode: "local", origin, codePepper: "chat-browser-fixture-pepper-32bytes", emailFrom: "qa@localhost.invalid" }, database);
    app.navigator = createNavigatorService({ database, projects: app.projects, clock: app.clock, ids: app.ids, model: fixtureModel.model, sessions: app.personalWorkspace });
    const requests: NavigatorMessageInput[] = [], externalRequests: string[] = [], pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    async function request<T>(path: string, method = "GET", body?: unknown, identity?: Identity, expectedStatus = 200): Promise<T> {
      const headers = new Headers({ origin, "content-type": "application/json" });
      if (identity) headers.set("cookie", identity.cookie);
      const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"));
      const envelope = await response.json() as { data: T; error?: { code: string } };
      // Keep fixture codes, session cookies and request bodies out of diagnostics.
      expect(response.status, `Isolated ${method} returned ${envelope.error?.code ?? "unexpected status"}`).toBe(expectedStatus);
      return envelope.data;
    }
    async function login(email: string): Promise<Identity> {
      const challenge = await request<{ challengeId: string }>("auth/login-challenges", "POST", { email });
      const mail = await database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
      const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
      if (!code) throw new Error("Isolated development challenge was not available");
      const response = await dispatch(app, new Request(`${origin}/api/v1/auth/login-challenges/verify`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, code }) }), ["auth", "login-challenges", "verify"]);
      expect(response.ok, "Isolated login verification must succeed").toBeTruthy();
      const profile = (await response.json()).data.profile;
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("Isolated session was not created");
      return { userId: profile.id as string, cookie };
    }
    let project: Project | null = null;
    if (options.signedIn !== false) {
      const current = await login("chat-owner@example.test");
      const other = await login("chat-other@example.test");
      const guide = await request<{ revision: number }>("me/onboarding", "GET", undefined, current);
      await request("me/onboarding", "POST", { expectedRevision: guide.revision, stepIndex: 5, completed: true }, current);
      project = await request<Project>("projects", "POST", { name: "隔离聊天授权项目", timezone: "Asia/Shanghai", goal: "仅完成授权项目的最小演示", minimumDeliverable: "AUTHORIZED_EXTRA_SCOPE_NOT_SENT" }, current, 201);
      await request<Project>("projects", "POST", { name: "PRIVATE_OTHER_PROJECT_NAME", timezone: "Asia/Shanghai", goal: "PRIVATE_OTHER_PROJECT_GOAL" }, other, 201);
      const separator = current.cookie.indexOf("=");
      await page.context().addCookies([{ name: current.cookie.slice(0, separator), value: current.cookie.slice(separator + 1), domain: new URL(origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    }
    await page.addInitScript(version => localStorage.setItem("hackathon-navigator-intro-" + version, "seen"), app.navigator.intro().version);
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
        externalRequests.push(url.origin); await route.abort("blockedbyclient"); return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/**", async route => {
      const browserRequest = route.request(), url = new URL(browserRequest.url());
      if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort("blockedbyclient"); return; }
      const path = url.pathname.slice("/api/v1/".length), body = browserRequest.postData();
      if (path === "navigator/messages" && browserRequest.method() === "POST") {
        requests.push(JSON.parse(body ?? "{}") as NavigatorMessageInput);
        if (options.mismatchedProvider) {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { reply: "不应显示的外部模型回复", links: [], provider: "model", requestId: "fixture-mismatched-provider" }, requestId: "fixture-mismatched-envelope" }) });
          return;
        }
      }
      const response = await dispatch(app, new Request(browserRequest.url(), { method: browserRequest.method(), headers: await browserRequest.allHeaders(), ...(body === null ? {} : { body }) }), path.split("/"));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    return { app, database, project, requests, externalRequests, pageErrors, turns: fixtureModel.turns,
      async close() { for (const turn of fixtureModel.turns) turn.cancel(); await page.unrouteAll({ behavior: "wait" }); await database.close(); } };
  } catch (error) {
    for (const turn of fixtureModel.turns) turn.cancel();
    await page.unrouteAll({ behavior: "wait" }); await database.close(); throw error;
  }
}

async function openChat(page: Page) {
  await page.getByRole("button", { name: "问问导航员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "你的参赛导航员" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "向 AI 提问", exact: true }).click();
  await expect(dialog.getByText(/当前账号有独立的 DSH 对话记录|DeepSeek Harness 尚未配置/)).toBeVisible();
  return dialog;
}

for (const source of ["events", "project-rules"] as const) {
  test(`DSH chat from ${source} shows pending input and supports a long reply in the next turn`, async ({ page }, info) => {
    const f = await isolatedChat(page, info);
    try {
      const path = source === "events" ? "/events" : `/app/projects/${f.project!.id}/rules`;
      await page.goto(path);
      if (source === "project-rules") await expect(page.getByRole("heading", { level: 1, name: f.project!.name })).toBeVisible();
      const dialog = await openChat(page), messages = dialog.locator('[aria-live="polite"]');
      const input = dialog.getByLabel("你现在需要什么帮助", { exact: true });
      const firstQuestion = "我只剩两小时，怎样删减任务？";
      const longReply = "隔离 DSH 聊天长回复夹具：" + "先确认最小交付物，再核对任务、时间和验收依据。".repeat(110);
      expect(longReply.length).toBeGreaterThan(2000); expect(longReply.length).toBeLessThan(6000);
      await expect(input).toBeEnabled(); await input.fill(firstQuestion);
      const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/navigator/messages" && response.request().method() === "POST");
      await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
      await expect.poll(() => f.turns.length).toBe(1);
      await expect(messages.getByText(firstQuestion, { exact: true })).toBeVisible();
      await expect(messages.locator("div > strong")).toHaveText(["你"]);
      await expect(messages.getByRole("status")).toHaveText("正在查找站内资料，并由 DeepSeek Harness 回复…");
      await expect(input).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "等待服务回复…", exact: true })).toBeDisabled();
      expect(f.requests[0]).toEqual({ message: firstQuestion, pagePath: path, ...(source === "project-rules" ? { projectId: f.project!.id } : {}) });
      const context = f.turns[0]!.request.input as ChatContext;
      expect(context).toMatchObject({ message: firstQuestion, history: [], pagePath: path });
      expect(context.project).toEqual(source === "events" ? null : { name: f.project!.name, stage: f.project!.stage, goal: f.project!.goal });
      for (const sentinel of ["PRIVATE_OTHER_PROJECT_NAME", "PRIVATE_OTHER_PROJECT_GOAL", "AUTHORIZED_EXTRA_SCOPE_NOT_SENT"]) expect(JSON.stringify(context)).not.toContain(sentinel);
      f.turns[0]!.release(longReply);
      const response = await firstResponse;
      expect(response.status()).toBe(200); expect((await response.json()).data.provider).toBe("dsh");
      await expect(messages.getByText(longReply, { exact: true })).toBeVisible();
      await expect(messages.locator("div > strong")).toHaveText(["你", "DeepSeek Harness"]);
      await expect(messages.getByRole("status")).toHaveCount(0);
      await expect(input).toHaveValue(""); await expect(input).toBeEnabled();
      const nextQuestion = "把上面的建议缩成三个步骤。";
      await input.fill(nextQuestion); await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
      await expect.poll(() => f.turns.length).toBe(2);
      const history = [{ role: "user", content: firstQuestion }, { role: "assistant", content: longReply }];
      expect(f.requests[1]).toEqual({ message: nextQuestion, pagePath: path, ...(source === "project-rules" ? { projectId: f.project!.id } : {}) });
      expect((f.turns[1]!.request.input as ChatContext).history).toEqual(history);
      expect((f.turns[1]!.request.input as ChatContext).project).toEqual(context.project);
      await expect(messages.getByText(nextQuestion, { exact: true })).toBeVisible();
      f.turns[1]!.release("隔离夹具的下一轮回复：确认交付物、删减任务、验证演示。");
      await expect(messages.getByText("隔离夹具的下一轮回复：确认交付物、删减任务、验证演示。", { exact: true })).toBeVisible();
      await expect(messages.locator("div > strong")).toHaveText(["你", "DeepSeek Harness", "你", "DeepSeek Harness"]);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      expect(f.requests).toHaveLength(2); expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
    } finally { await f.close(); }
  });
}

test("chat refuses a model provider response without adding a reply or losing the question", async ({ page }, info) => {
  const f = await isolatedChat(page, info, { mismatchedProvider: true });
  try {
    await page.goto("/events");
    const dialog = await openChat(page), messages = dialog.locator('[aria-live="polite"]');
    const input = dialog.getByLabel("你现在需要什么帮助", { exact: true }), question = "这个回复必须由 DeepSeek Harness 处理。";
    await expect(input).toBeEnabled(); await input.fill(question);
    await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("聊天回复来源不匹配，未展示结果。");
    await expect(input).toHaveValue(question); await expect(input).toBeEnabled();
    await expect(messages.locator("div")).toHaveCount(0);
    await expect(dialog.getByText("不应显示的外部模型回复", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("已收到 DeepSeek Harness 回复，请核对关键建议。", { exact: true })).toHaveCount(0);
    expect(f.requests).toEqual([{ message: question, pagePath: "/events" }]);
    expect(f.turns).toHaveLength(0); expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("anonymous chat offers the DSH login link and cannot send a model request", async ({ page }, info) => {
  const f = await isolatedChat(page, info, { signedIn: false });
  try {
    await page.goto("/events");
    const dialog = await openChat(page);
    await expect(dialog.getByRole("link", { name: "登录后使用 DeepSeek Harness 提问", exact: true })).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent("/events")}`);
    await expect(dialog.getByLabel("你现在需要什么帮助", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "发送问题", exact: true })).toBeDisabled();
    expect(f.requests).toHaveLength(0); expect(f.turns).toHaveLength(0);
    expect(f.pageErrors).toEqual([]); expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
