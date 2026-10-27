/** Isolated browser verification of the actual component with simulated APIs. No server, DB or DSH calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createRoadshowService } from "./service.ts";
import type { PersonalArtifact, PersonalAiPort } from "../../shared/personal-ai.ts";
import type { RoadshowInput } from "./types.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const previewDir = join(moduleDir, ".browser-preview");
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const input: RoadshowInput = { projectIdea: "浏览器测试的私人项目想法", targetUsers: "准备第一次参赛的人", problem: "缺少可彩排的讲述结构", completedCapabilities: "尚未实现，仅有想法", technicalApproach: "", differentiation: "", facts: "", assumptions: "希望能帮助整理表达", pendingValidation: "需要验证用户需求", durationSeconds: 180 };
const fixtureAi: PersonalAiPort = {
  async generate(actor, request) { return { id: "roadshow_browser_fixture", kind: request.kind, title: "浏览器模拟讲稿", provider: "dsh", createdAt: "2026-10-09T08:00:00.000Z", sessionId: `fixture_${actor.userId}`, data: request.validate(request.outputExample) }; },
  async list() { return []; }, async get() { throw new Error("fixture-only"); },
};
const artifact = await createRoadshowService({ ai: fixtureAi }).generate({ userId: "browser_fixture_owner", platformRoles: ["user"] }, input);
await mkdir(previewDir, { recursive: true });
const generatedFiles = ["loader.cjs", "entry.tsx", "link.tsx", "navigation.ts", "bundle.js"].map(name => join(previewDir, name));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await writeFile(generatedFiles[0]!, `const ts=require("typescript");module.exports=function(source){if(this.resourcePath.endsWith(".css")){const names={};const prefix=require("node:path").basename(this.resourcePath).replace(/\\W/g,"_")+"__";const css=source.replace(/\\.([A-Za-z_-][\\w-]*)/g,(_,key)=>{names[key]=prefix+key;return "."+prefix+key;});return "const s=document.createElement('style');s.textContent="+JSON.stringify(css)+";document.head.appendChild(s);export default "+JSON.stringify(names)+";";}return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;};`);
  await writeFile(generatedFiles[1]!, `import {createRoot} from "react-dom/client";import {RoadshowClient} from "../../../components/roadshow-client.tsx";createRoot(document.getElementById("root")!).render(<RoadshowClient/>);`);
  await writeFile(generatedFiles[2]!, `import type {ReactNode} from "react";export default function Link({href,children,...props}:{href:string;children?:ReactNode;[key:string]:unknown}){return <a href={href} {...props}>{children}</a>;}`);
  await writeFile(generatedFiles[3]!, `export function usePathname(){return location.pathname;}export function useSearchParams(){return new URLSearchParams(location.search);}`);
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack({ mode: "development", target: "web", entry: generatedFiles[1], output: { path: previewDir, filename: "bundle.js" }, devtool: false,
      resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "next/link$": generatedFiles[2], "next/navigation$": generatedFiles[3] } },
      module: { rules: [{ test: /\.(?:tsx?|css)$/, use: [{ loader: generatedFiles[0] }] }] }, optimization: { minimize: false } });
    compiler.run((error: Error | null, stats: { hasErrors(): boolean; toString(options: unknown): string }) => compiler.close(() => error ? reject(error) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  });
  const bundle = await readFile(generatedFiles[4]!);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--paper:#f6f3eb;--ink:#21201c;--muted:#666257;--action:#b8351e;--brand:#ef4d2e;--line:#d9d4c8}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei",system-ui,sans-serif}button,input,textarea{font:inherit}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem("hackathon-navigator-intro-v1", "seen"));
  let authenticated = false, failUnknown = false, malformedResponse = false, mutationCount = 0;
  let records: PersonalArtifact[] = [];
  const posted: unknown[] = [], errors: string[] = [];
  await context.route("http://roadshow.test/**", async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/bundle.js") { await route.fulfill({ contentType: "application/javascript", body: bundle }); return; }
    if (!url.pathname.startsWith("/api/v1/")) { await route.fulfill({ contentType: "text/html", body: html }); return; }
    const path = url.pathname.slice("/api/v1".length);
    if ((path === "/me" || path.startsWith("/me/")) && !authenticated) { await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "请先登录" }, requestId: "fixture" } }); return; }
    let data: unknown = {};
    if (path === "/me") data = { profile: { id: "browser_fixture_owner", email: "fixture@example.test", displayName: "测试用户", timezone: "Asia/Shanghai", revision: 1 } };
    else if (path === "/system/status") data = { mode: "connected", database: "postgres", dshConfigured: true };
    else if (path === "/navigator/intro") data = { version: "v1", title: "测试导航", sections: [], steps: [], links: [], chat: { provider: "dsh", configured: true } };
    else if (path === "/navigator/conversation") data = { session: { id: "fixture", provider: "dsh", busy: false }, messages: [] };
    else if (path === "/me/artifacts") data = records;
    else if (path === "/me/artifacts/roadshow_browser_fixture") data = artifact;
    else if (path === "/me/roadshow/scripts" && method === "POST") {
      mutationCount++; posted.push(route.request().postDataJSON());
      await new Promise(resolve => setTimeout(resolve, 200));
      if (malformedResponse) { await route.fulfill({ status: 201, contentType: "text/html", body: "Unreadable response after simulated save" }); return; }
      if (failUnknown) { await route.fulfill({ status: 409, json: { error: { code: "AI_PREVIOUS_REQUEST_UNKNOWN", message: "请求结果未知，请先核查" }, requestId: "fixture" } }); return; }
      records = [artifact]; data = artifact;
    }
    await route.fulfill({ status: 200, json: { data, requestId: "fixture" } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://roadshow.test/roadshow?idea=%E4%BB%8E%E9%93%BE%E6%8E%A5%E5%B8%A6%E5%85%A5%E7%9A%84%E6%83%B3%E6%B3%95");
  await page.getByRole("link", { name: "去登录 →", exact: true }).waitFor();
  assert.equal(await page.locator("#roadshow-projectIdea").inputValue(), "从链接带入的想法");
  assert.equal(await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(moduleDir, "roadshow-mobile-preview.png"), fullPage: true });
  authenticated = true;
  await page.goto("http://roadshow.test/roadshow");
  await page.getByText("还没有保存的路演讲稿。填写项目资料并生成后，记录会出现在这里。", { exact: true }).waitFor();
  for (const key of ["projectIdea", "targetUsers", "problem", "completedCapabilities", "assumptions", "pendingValidation"] as const) await page.locator(`#roadshow-${key}`).fill(input[key]);
  await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).click();
  await page.getByRole("button", { name: "正在生成…", exact: true }).waitFor();
  await page.getByRole("heading", { name: "浏览器模拟讲稿", exact: true }).waitFor();
  assert.equal(mutationCount, 1);
  assert.equal((posted[0] as RoadshowInput).projectIdea, input.projectIdea);
  assert.equal(await page.getByRole("link", { name: "下一步：整理 PPT →", exact: true }).getAttribute("href"), "/ppt?roadshowId=roadshow_browser_fixture");
  await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).waitFor();
  await page.locator("#roadshow-projectIdea").fill("临时改动");
  await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).click();
  await page.getByText("已恢复这份记录的输入和讲稿。修改后生成会保存为新的记录。尚未确认的请求仍需核查。", { exact: true }).waitFor();
  assert.equal(await page.locator("#roadshow-projectIdea").inputValue(), input.projectIdea);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Markdown 讲稿", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "路演讲稿-roadshow_browser_fixture.md");
  assert.ok((await readFile((await download.path())!, "utf8")).includes("预期"));
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(moduleDir, "roadshow-desktop-preview.png"), fullPage: true });
  malformedResponse = true;
  await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).click();
  await page.getByText("本次结果尚需核查，未自动重发。", { exact: true }).waitFor();
  assert.equal(mutationCount, 2);
  assert.equal(await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).click();
  await page.getByText("已恢复这份记录的输入和讲稿。修改后生成会保存为新的记录。尚未确认的请求仍需核查。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).isDisabled(), true);
  // Start a fresh fixture page to exercise the server's explicit persisted-hold error separately.
  malformedResponse = false;
  await page.reload();
  await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).waitFor();
  await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).click();
  await page.getByText("已恢复这份记录的输入和讲稿。修改后生成会保存为新的记录。尚未确认的请求仍需核查。", { exact: true }).waitFor();
  failUnknown = true;
  await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).click();
  await page.getByText("本次结果尚需核查，未自动重发。", { exact: true }).waitFor();
  assert.equal(mutationCount, 3);
  assert.equal(await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "只刷新已保存记录", exact: true }).click();
  assert.equal(mutationCount, 3);
  await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).click();
  await page.getByText("已恢复这份记录的输入和讲稿。修改后生成会保存为新的记录。尚未确认的请求仍需核查。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "用 DSH 生成并保存讲稿", exact: true }).isDisabled(), true);
  authenticated = false;
  await page.evaluate(() => window.dispatchEvent(new Event("hackathon:unauthenticated")));
  assert.equal(await page.locator("#roadshow-projectIdea").inputValue(), "");
  assert.equal(await page.getByRole("heading", { name: "浏览器模拟讲稿", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "恢复输入与讲稿", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("Roadshow browser fixture: guest URL, mobile/desktop overflow, busy state, generate/history restore, Markdown download, private PPT reference, invalid response/unknown request no replay, old history cannot release hold, session clearing passed. Simulated APIs only.");
} finally {
  await browser?.close();
  // Delete only known generated files under this module; retain the two inspection screenshots.
  for (const filename of generatedFiles) await rm(filename, { force: true });
  await rmdir(previewDir).catch(() => {});
}
