import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { SelectionNotice } from "./model.ts";

// Evaluate the actual preview component for controlled Node tests only. No output files or app build.
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (/\.tsx?$/.test(url)) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
  if (url.endsWith(".module.css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, {get:(_, key)=>String(key)});" };
  return nextLoad(url, context);
} });
const { NoticePreview, PublishedNotice } = await import("./NoticePreview.tsx");
hooks.deregister();

test("实际 React 预览使用文本节点，输入脚本/标签不会成为HTML", () => {
  const html = renderToStaticMarkup(createElement(NoticePreview, { content: { subject: '<img src=x onerror="bad()">', body: "<script>bad()</script>\n普通文字", accent: "orange", theme: "letter" } }));
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<img/); assert.match(html, /普通文字/); assert.match(html, /letter orange/);
});
test("两种实际预览样式和四种固定强调色正常渲染", () => {
  for (const theme of ["simple", "letter"] as const) for (const accent of ["orange", "blue", "green", "slate"] as const) {
    const html = renderToStaticMarkup(createElement(NoticePreview, { content: { subject: "标题", body: "正文", accent, theme } }));
    assert.ok(html.includes(`${theme} ${accent}`)); assert.ok(html.includes("通知预览"));
  }
});
test("实际回执区分别表达站内发布、服务接受与未知邮件状态", () => {
  const notice: SelectionNotice = { id: "notice-a", eventId: "event-a", registrationId: "registration-a", registrationRevision: 4, version: 2, templateRevision: 3, subject: "入选通知", body: "保存的真实正文", accent: "blue", theme: "simple", publishedAt: "2026-10-11T06:00:00Z", mailState: "accepted" };
  const accepted = renderToStaticMarkup(createElement(PublishedNotice, { notice }));
  assert.match(accepted, /站内已发布/); assert.match(accepted, /服务已接受，收件与已读未确认/); assert.doesNotMatch(accepted, /已送达/); assert.match(accepted, /北京时间/);
  const held = renderToStaticMarkup(createElement(PublishedNotice, { notice: { ...notice, mailState: "unknown_hold" } }));
  assert.match(held, /结果未知，已暂停自动重发/);
});
