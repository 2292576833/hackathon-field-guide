import type { Page } from "@playwright/test";
import { test, expect, browserLogin, browserRequest } from "./ux-test.ts";
import type { IsolatedWorkspace } from "./isolated-workspace.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

interface SystemStatus { mode: string; modelConfigured: boolean; navigatorConfigured?: boolean; dshConfigured?: boolean }
async function dismissFirstIntroduction(page: Page, workspace: IsolatedWorkspace) {
  const metadata = await workspace.raw("navigator/intro");
  expect(metadata.ok).toBeTruthy();
  const version = (await metadata.json()).data.version as string;
  const alreadySeen = await page.evaluate(value => localStorage.getItem("hackathon-navigator-intro-" + value) === "seen", version);
  if (!alreadySeen) {
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "稍后再看", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
}
async function waitForBridge(script: string, projectRoot: string, origin: string): Promise<{ child: ChildProcess; url: string; pairToken: string }> {
  const child = spawn(process.execPath, [script, "--project-root", projectRoot, "--origin", origin], {
    cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const address = await new Promise<{ url: string; pairToken: string }>((resolveAddress, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Downloaded local bridge did not become ready")), 20_000);
      const finish = (error?: Error, value?: { url: string; pairToken: string }) => {
        clearTimeout(timer);
        if (error) reject(error); else resolveAddress(value!);
      };
      child.once("error", () => finish(new Error("Could not start downloaded local bridge")));
      child.once("exit", () => finish(new Error("Downloaded local bridge exited before readiness")));
      child.stdout!.on("data", chunk => {
        output += String(chunk);
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        const pairToken = output.match(/配对令牌[^\n]*：([a-f0-9]{64})/)?.[1];
        if (url && pairToken) finish(undefined, { url, pairToken });
      });
      // Consume errors without printing tokens, directory contents or credentials.
      child.stderr!.on("data", () => {});
    });
    return { child, ...address };
  } catch (error) { child.kill(); throw error; }
}
async function stopBridge(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, "exit");
  child.kill();
  await stopped;
}
async function removeOwnedTemporaryDirectory(path: string) {
  const parent = resolve(".runtime");
  const candidate = resolve(path);
  const fragment = relative(parent, candidate);
  if (!fragment.startsWith("bridge-e2e-") || fragment.includes("..") || isAbsolute(fragment)) throw new Error("Refusing to clean outside the E2E-owned temporary directory");
  await rm(candidate, { recursive: true, force: true });
}

test.beforeEach(async ({ workspace }) => {
  const response = await workspace.raw("system/status");
  expect(response.ok).toBeTruthy();
  expect((await response.json()).data.mode, "Development mailbox must be explicitly enabled").toBe("local");
});

test.describe("initial introduction", () => {
test.use({ introSeen: false });
test("first introduction is keyboard-dismissible, remembered and replayable; guides and discovery cards use real data", async ({ page, workspace }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "欢迎来到黑客松情报局", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "打开新手教程", exact: true })).toHaveAttribute("href", "/library");
  expect(await page.evaluate(() => document.querySelector("dialog")?.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "新手教程" })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "问问导航员", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/library/github-first-repository");
  await page.getByText("补充阅读：本站原创入门说明", { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("GitHub 入门：仓库、分支与第一次保存");
  await expect(page.getByRole("link", { name: "GitHub 官方 Hello World（新窗口）", exact: true })).toHaveAttribute("href", /docs\.github\.com/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "比赛分析", exact: true })).toBeVisible();
  await page.reload();
  const response = await browserRequest(workspace, page, "event-discoveries?limit=24");
  expect(response.ok).toBeTruthy();
  const data = (await response.json()).data as { items: { title: string; canonicalUrl: string; verificationStatus: string }[] };
  const serviceState = (await (await browserRequest(workspace, page, "system/status")).json()).data;
  if (!serviceState.discoveryConfigured) {
    if (!data.items.length) await expect(page.getByText(/自动收集尚未启用/)).toBeVisible();
  }
  if (data.items.length === 0 && serviceState.discoveryConfigured) await expect(page.getByText(/暂时没有已保存的比赛分析/)).toBeVisible();
  else if (data.items.length) {
    expect(data.items.every(item => item.verificationStatus === "unverified")).toBeTruthy();
    await expect(page.getByRole("heading", { name: data.items[0]!.title, exact: true })).toBeVisible();
    await expect(page.getByText("AI 分析 · 未人工核验", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^(?:前往比赛官网|查看赛事原文)（新窗口）$/ }).first()).toHaveAttribute("href", data.items[0]!.canonicalUrl);
  }
  await expect(page.getByLabel("筛选已发布赛事", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新发现卡片", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看后台搜索配置状态", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await mkdir(".runtime/previews", { recursive: true });
  await page.screenshot({ path: ".runtime/previews/events-analysis-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: ".runtime/previews/events-analysis-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});
});

test("account nickname and team name persist across real browser reloads; ordinary users do not receive admin controls", async ({ page, workspace }) => {
  const identity = Date.now();
  await browserLogin(page, workspace, "qa-extended-account-" + identity + "@example.test", "/app/account");
  await expect(page.getByRole("heading", { name: "账号与登录设备", exact: true })).toBeVisible();
  await page.getByLabel("昵称", { exact: true }).fill("验收成员 " + identity);
  await page.getByRole("button", { name: "保存本人资料", exact: true }).click();
  await expect(page.getByText(/资料已保存/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("昵称", { exact: true })).toHaveValue("验收成员 " + identity);
  const settings = await browserRequest(workspace, page, "me/account-settings");
  expect(settings.ok).toBeTruthy();
  const account = (await settings.json()).data;
  expect(account.currentSession.current).toBe(true);
  expect(account.sessions.length > 0).toBeTruthy();
  await expect(page.getByRole("link", { name: /^打开运营工作台/ })).toHaveCount(0);
  await page.goto("/app/teams");
  await page.getByLabel("队伍名称", { exact: true }).fill("验收队伍 " + identity);
  await page.getByRole("button", { name: "创建队伍", exact: true }).click();
  await page.waitForURL(/\/app\/teams\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("验收队伍 " + identity);
  await page.getByLabel("队伍名称", { exact: true }).fill("已保存队伍 " + identity);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByText("名称已更新。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("已保存队伍 " + identity);
  await expect(page.getByText("你", { exact: true })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "需要运营权限", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "自动发现", exact: true })).toHaveCount(0);
});

test("skill bundle has an authoritative file manifest and downloadable standalone bridge; invalid execution writes no skill files", async ({ page, request, workspace }) => {
  await browserLogin(page, workspace, "qa-extended-skills-" + Date.now() + "@example.test", "/skills");
  const bundlesResponse = await workspace.raw("skill-bundles");
  expect(bundlesResponse.ok).toBeTruthy();
  const bundles = (await bundlesResponse.json()).data.items as { id: string; track: string; name: string }[];
  const bundle = bundles.find(item => item.track === "game");
  expect(Boolean(bundle), "A real published game bundle must be present").toBeTruthy();
  await page.goto("/skills/bundles/" + encodeURIComponent(bundle!.id));
  await page.getByLabel("安装到哪个 AI 工具", { exact: true }).selectOption("codex");
  await page.getByLabel("我知道适配表是路径/格式声明，所用客户端版本及真实任务效果仍需自己验证。", { exact: true }).check();
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/me/skill-installation-plans" && response.request().method() === "POST");
  await page.getByRole("button", { name: "生成精确文件预览", exact: true }).click();
  const preview = await previewResponse;
  expect(preview.ok()).toBeTruthy();
  const plan = (await preview.json()).data as { planId: string; status: string; manifestHash: string; items: { skillVersionId: string; commit: string; files: { relativePath: string; sha256: string; bytes: number }[]; license: { spdx: string } }[] };
  expect(plan.status).toBe("preview");
  expect(plan.items.length > 0).toBeTruthy();
  expect(plan.items.every(item => /^[a-f0-9]{40}$/.test(item.commit) && item.files.some(file => file.relativePath === "SKILL.md") && item.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0))).toBeTruthy();
  await expect(page.getByRole("heading", { name: "文件预览 · 待核对文件", exact: true })).toBeVisible();
  await page.getByText("连接自己的电脑并执行（确认文件后进行）", { exact: true }).click();
  await expect(page.getByRole("button", { name: "在本人项目中执行已确认安装", exact: true })).toBeDisabled();
  await page.getByLabel("我已核对具体文件、固定 commit、许可通知和项目写入范围，确认此预览。", { exact: true }).check();
  await page.getByRole("button", { name: "确认此安装计划", exact: true }).click();
  await expect(page.getByRole("heading", { name: "文件预览 · 已确认，等待本机执行", exact: true })).toBeVisible();
  const recorded = await browserRequest(workspace, page, "me/skill-installations");
  expect(recorded.ok).toBeTruthy();
  expect((await recorded.json()).data.receipts.length).toBe(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /下载桥接启动器/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("hackathon-skills-bridge.mjs");
  await mkdir(resolve(".runtime"), { recursive: true });
  const directory = await mkdtemp(join(resolve(".runtime"), "bridge-e2e-"));
  let bridge: Awaited<ReturnType<typeof waitForBridge>> | undefined;
  try {
    const script = join(directory, "hackathon-skills-bridge.mjs");
    await download.saveAs(script);
    expect((await readFile(script, "utf8")).includes("createSkillsBridge")).toBeTruthy();
    const projectRoot = join(directory, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "existing.txt"), "keep existing project content");
    const origin = new URL(page.url()).origin;
    bridge = await waitForBridge(script, projectRoot, origin);
    const wrongPair = await request.get(bridge.url + "/status", { headers: { Origin: origin, Authorization: "Bearer invalid-pair" } });
    expect(wrongPair.status()).toBe(403);
    const paired = await request.get(bridge.url + "/status", { headers: { Origin: origin, Authorization: "Bearer " + bridge.pairToken } });
    expect(paired.ok()).toBeTruthy();
    expect((await paired.json()).scope).toBe("project");
    const refused = await request.post(bridge.url + "/install", {
      headers: { Origin: origin, Authorization: "Bearer " + bridge.pairToken },
      data: { planId: plan.planId, manifestHash: plan.manifestHash, bridgeToken: "not-an-execution-credential" },
    });
    expect(refused.status()).toBe(422);
    expect(Boolean((await refused.json()).receipt)).toBe(false);
    expect((await readdir(projectRoot)).sort()).toEqual([".hackathon-skills", "existing.txt"]);
    expect(await readFile(join(projectRoot, "existing.txt"), "utf8")).toBe("keep existing project content");
    const finalHistory = await browserRequest(workspace, page, "me/skill-installations");
    expect((await finalHistory.json()).data.receipts.length).toBe(0);
  } finally {
    if (bridge) await stopBridge(bridge.child);
    await removeOwnedTemporaryDirectory(directory);
  }
});

test("an unconfigured navigator reports the real service error without fabricating an AI reply", async ({ page, request, workspace }) => {
  const response = await workspace.raw("system/status");
  const status = (await response.json()).data as SystemStatus;
  test.skip(status.dshConfigured === true, "Configured providers are not called by this no-external-service test");
  await browserLogin(page, workspace, "qa-extended-navigator-" + Date.now() + "@example.test");
  await page.getByRole("button", { name: "问问导航员", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "向 AI 提问", exact: true }).click();
  await expect(dialog.getByLabel("你现在需要什么帮助", { exact: true })).toBeEnabled();
  await dialog.getByLabel("你现在需要什么帮助", { exact: true }).fill("我第一次参加黑客松，怎样开始？");
  const replyResponse = page.waitForResponse(item => new URL(item.url()).pathname === "/api/v1/navigator/messages" && item.request().method() === "POST");
  await dialog.getByRole("button", { name: "发送问题", exact: true }).click();
  const reply = await replyResponse;
  expect(reply.status()).toBe(503);
  expect((await reply.json()).error.code).toBe("NAVIGATOR_NOT_CONFIGURED");
  await expect(dialog.getByRole("alert")).toContainText("AI 导航员服务尚未配置");
  await expect(dialog.getByText("导航员", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("你现在需要什么帮助", { exact: true })).toHaveValue("我第一次参加黑客松，怎样开始？");
});
