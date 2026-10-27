import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chromium } from "@playwright/test";

/**
 * 边界回归：`TeamSupervisionPanel` 的失败分支。
 *
 * 背景：组件里原本写的是 `reason instanceof SupervisionApiError && [401,403,404].includes(status)`。
 * 这类 `instanceof` 依赖注入模块导出的类；一旦该模块被替换或未导出这个类，就会抛
 * "Right-hand side of 'instanceof' is not an object"，使 catch 在 setError 之前中断。
 *
 * 本测试锁定两件事：
 *  1. 普通错误 → 必须显示 role="alert"（提示不能被吞掉）；
 *  2. 401/403/404 → 必须清空面板（保留原有的"权限变化即重置"语义，不能被防御性改写破坏）。
 */
async function panel(browser: Awaited<ReturnType<typeof chromium.launch>>, rejectWith: string) {
  const modules: Record<string, string> = {};
  // 本文件在 src/modules/team-supervision/ 下，`../../../` 即项目根；用显式拼接避免把包名拼错。
  const projectRoot = new URL("../../../", import.meta.url);
  for (const [id, path] of [["react", "react/cjs/react.development.js"], ["react/jsx-runtime", "react/cjs/react-jsx-runtime.development.js"], ["react-dom", "react-dom/cjs/react-dom.development.js"], ["react-dom/client", "react-dom/cjs/react-dom-client.development.js"], ["scheduler", "scheduler/cjs/scheduler.development.js"]]) modules[id!] = readFileSync(new URL(`node_modules/${path}`, projectRoot), "utf8");
  modules.panel = ts.transpileModule(readFileSync(new URL("./TeamSupervisionPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  // 提供真实的错误类，正是它让 `instanceof` 有意义（也复现了夹具曾漏导出的那种缺口）。
  modules["./client.ts"] = "exports.createSupervisionApiClient=()=>({});exports.SupervisionApiError=class SupervisionApiError extends Error{constructor(message,status){super(message);this.status=status;}};";
  modules["./supervision.module.css"] = "exports.__esModule=true;exports.default=new Proxy({},{get:(_,key)=>String(key)});";
  const css = readFileSync(new URL("./supervision.module.css", import.meta.url), "utf8");
  const runtime = `window.process={env:{NODE_ENV:'development'}};const sources=${JSON.stringify(modules)},cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;new Function('require','module','exports',sources[id])(require,m,m.exports);return m.exports;}
  const seed={projectId:'p1',revision:1,enabled:true,reason:'hold',membershipId:'m1',factsFingerprint:'f1',hints:[{id:'blocked:t',kind:'blocked',taskId:'t',title:'接口',detail:'等交接'}],report:null,holdRequestId:null,dailyUsed:0,dailyLimit:24,nextAllowedAt:null};
  // 错误类只存在于 require 出来的模块命名空间里（顶层没有 exports），先取出来再构造失败对象。
  window.SupervisionApiError=require('./client.ts').SupervisionApiError;
  const failure=${rejectWith};
  window.client={get:async()=>{throw failure},settings:async()=>{throw failure},check:async()=>{throw failure}};
  const app=require('react-dom/client').createRoot(document.getElementById('root'));app.render(require('react').createElement(require('panel').TeamSupervisionPanel,{projectId:'p1',accountKey:'alice',client:window.client}));`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>:root{--paper:#fff;--line:#ccc;--action:#d43;--muted:#666}body{margin:12px}*{box-sizing:border-box}${css}</style></head><body><div id="root"></div><script>${runtime.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const page = await browser.newPage({ viewport: { width: 375, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://supervision.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://supervision.test/");
  await page.waitForTimeout(1200);
  return { page, errors };
}

test("a plain read failure still surfaces an alert, and 401/403/404 still reset the panel", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    // 1) 普通错误：必须出现 role="alert"
    const plain = await panel(browser, "new Error('read failed')");
    try {
      await plain.page.getByRole("alert").waitFor({ timeout: 15_000 });
    } catch (error) {
      // 失败时把现场打出来，避免只能看到一句 Timeout。
      console.log("DIAG pageerrors=" + JSON.stringify(plain.errors));
      console.log("DIAG alerts=" + await plain.page.getByRole("alert").count());
      console.log("DIAG body=" + JSON.stringify((await plain.page.locator("body").innerText()).slice(0, 400)));
      throw error;
    }
    assert.match(await plain.page.getByRole("alert").innerText(), /read failed/);
    assert.deepEqual(plain.errors, [], "普通错误不应产生未捕获异常（instanceof 必须安全）");
    await plain.page.close();

    // 2) 权限类错误：面板必须被清空，而不是显示内容
    for (const status of [401, 403, 404]) {
      const denied = await panel(browser, `new window.SupervisionApiError('denied', ${status})`);
      await denied.page.getByRole("alert").waitFor({ timeout: 15_000 });
      assert.equal(await denied.page.getByText("规则提示 · 当前记录").count(), 0, `${status} 之后不应再显示记录`);
      assert.deepEqual(denied.errors, [], `${status} 分支不应产生未捕获异常`);
      await denied.page.close();
    }
  } finally { await browser.close(); }
});
