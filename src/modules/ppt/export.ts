import type { PptOutline } from "./domain.ts";

const factKinds = { idea: "项目想法", target_users: "目标用户", completed: "用户自报已完成", planned: "待实现", evidence: "用户提供资料（需复核）" };
const modes = { live: "现场演示建议", recording: "预录演示建议", walkthrough: "概念流程讲解", none: "无演示" };
function pointLabel(outline: PptOutline, point: PptOutline["slides"][number]["keyPoints"][number]) {
  if (point.kind === "suggestion") return "建议";
  if (point.kind === "needs_evidence") return "待补证据";
  const fact = outline.facts.find(item => item.id === point.factId);
  return fact ? factKinds[fact.kind] : "用户提供";
}
function md(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}#!|])/g, "\\$1").replace(/\r?\n/g, "\n    ");
}
export function outlineMarkdown(outline: PptOutline): string {
  const rows = [`# ${md(outline.title)}`, "", `路演：${outline.durationMinutes} 分钟 · ${outline.slides.length} 页`, "",
    "这是可编辑 Markdown 大纲，不是 .pptx 文件。页内时长包含演示。AI 草案及本地修改需要人工复核。", ""];
  if (outline.sourceProject) rows.push(`来源项目：${md(outline.sourceProject.projectName)}（${md(outline.sourceProject.projectId)}，版本 ${outline.sourceProject.revision}）；读取于 ${md(outline.sourceProject.capturedAt)}。使用当时的有限资料快照，后续项目编辑不会改写此稿。`, "");
  for (const slide of outline.slides) {
    rows.push(`## ${slide.number}. ${md(slide.title)}（${slide.durationSeconds} 秒）`, "", "### 页内要点", "");
    for (const point of slide.keyPoints) rows.push(`- [${pointLabel(outline, point)}] ${md(point.text)}`);
    rows.push("", "### 视觉建议", "", md(slide.visualSuggestion), "", "### 讲者备注", "", md(slide.speakerNotes), "",
      `### ${modes[slide.demonstration.mode]}`, "");
    for (const step of slide.demonstration.steps) rows.push(`- ${md(step)}`);
    if (slide.demonstration.fallback) rows.push("", `备用：${md(slide.demonstration.fallback)}`);
    rows.push("", "---", "");
  }
  rows.push("## 排练核对", "", ...outline.rehearsalChecklist.map(item => `- [ ] ${md(item)}`), "", "## 需复核的提醒", "",
    ...outline.warnings.map(item => `- ${md(item)}`), "");
  return rows.join("\n");
}
function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Self-contained, script-free HTML; all generated/user text remains escaped. */
export function outlinePrintHtml(outline: PptOutline): string {
  const sourceInfo = outline.sourceProject ? `<p>来源项目：${html(outline.sourceProject.projectName)}（${html(outline.sourceProject.projectId)}，版本 ${outline.sourceProject.revision}）；读取于 ${html(outline.sourceProject.capturedAt)}。使用当时的有限资料快照，后续项目编辑不会改写此稿。</p>` : "";
  const slides = outline.slides.map(slide => `<section class="slide" aria-label="第 ${slide.number} 页"><p class="meta">${slide.number} / ${outline.slides.length} · ${slide.durationSeconds} 秒（含演示）</p><h2>${html(slide.title)}</h2><ul>${slide.keyPoints.map(point => `<li><span class="kind">${html(pointLabel(outline, point))}</span>${html(point.text)}</li>`).join("")}</ul><p class="visual"><strong>视觉建议：</strong>${html(slide.visualSuggestion)}</p></section><section class="notes"><h3>第 ${slide.number} 页 · 讲者备注</h3><p>${html(slide.speakerNotes)}</p><h4>${modes[slide.demonstration.mode]}</h4>${slide.demonstration.steps.length ? `<ol>${slide.demonstration.steps.map(step => `<li>${html(step)}</li>`).join("")}</ol>` : ""}${slide.demonstration.fallback ? `<p><strong>备用：</strong>${html(slide.demonstration.fallback)}</p>` : ""}</section>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'"><title>${html(outline.title)} · 幻灯片预览</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f2e9;color:#24231f;font-family:"Microsoft YaHei",system-ui,sans-serif;line-height:1.6;overflow-wrap:anywhere}main{max-width:1100px;margin:auto;padding:24px}.intro{margin-bottom:24px}.intro h1{font-size:28px}.intro p{font-size:15px;color:#635b52}.slide{background:#fffdf8;border-top:8px solid #cf442c;min-height:560px;padding:40px 48px;margin:0 0 20px;break-after:page}.meta{font-size:15px;color:#766554}.slide h2{font-size:34px;line-height:1.25;margin:22px 0 30px}.slide ul{padding-left:24px;font-size:23px}.slide li{margin:16px 0;white-space:pre-wrap}.kind{display:block;font-size:13px;color:#9f351e;letter-spacing:.04em}.visual{font-size:15px;margin-top:30px;color:#635b52;white-space:pre-wrap}.notes{background:#fffaf1;padding:20px 32px;margin-bottom:32px;border-left:3px solid #d7cbb8}.notes p,.notes li{white-space:pre-wrap}.checklist{padding:24px;background:#fffdf8}@media(max-width:650px){main{padding:12px}.slide{min-height:0;padding:24px 20px}.slide h2{font-size:27px}.slide ul{font-size:19px}.notes{padding:16px}}@page{size:A4 landscape;margin:12mm}@media print{body{background:white}main{max-width:none;padding:0}.intro,.notes,.checklist{display:none}.slide{margin:0;min-height:0;border:0;border-top:4px solid #cf442c;padding:8mm 6mm;box-shadow:none;break-after:page}.slide:last-of-type{break-after:auto}.slide h2{font-size:28pt}.slide ul{font-size:19pt}.meta,.kind,.visual{font-size:10pt}}@media(prefers-reduced-motion:reduce){*{animation:none;transition:none}}
</style></head><body><main><div class="intro"><h1>${html(outline.title)}</h1><p>${outline.durationMinutes} 分钟 · ${outline.slides.length} 页。可用浏览器打印或另存 PDF；这是 HTML 预览，不是 .pptx。打印只含幻灯片，备注在下方阅读。长页可分为多张纸，排练前请缩减页内文字。</p>${sourceInfo}</div>${slides}<section class="checklist"><h2>排练核对</h2><ul>${outline.rehearsalChecklist.map(item => `<li>${html(item)}</li>`).join("")}</ul><h2>需复核的提醒</h2><ul>${outline.warnings.map(item => `<li>${html(item)}</li>`).join("")}</ul></section></main></body></html>`;
}
