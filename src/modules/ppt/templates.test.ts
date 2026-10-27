import assert from "node:assert/strict";
import test from "node:test";
import type { PptTemplateId } from "./domain.ts";
import { getPptTemplate, PPT_TEMPLATES, templateMarkdown } from "./templates.ts";
import { PPT_TOOLS } from "./tools.ts";

test("three original frameworks include demonstration time within their stated duration", () => {
  assert.deepEqual(PPT_TEMPLATES.map((template) => template.id), [
    "demo-3", "product-5", "agent-technical",
  ]);
  for (const template of PPT_TEMPLATES) {
    assert.equal(
      template.slides.reduce((total, slide) => total + slide.durationSeconds, 0),
      template.durationMinutes * 60,
      template.id,
    );
    assert.ok(template.slides.some((slide) => slide.title.includes("演示")));
    for (const slide of template.slides) {
      assert.ok(Number.isInteger(slide.durationSeconds) && slide.durationSeconds > 0);
      assert.ok(slide.title.trim() && slide.say.trim() && slide.visualSuggestion.trim());
      assert.ok(slide.write.length > 0 && slide.avoid.length > 0);
    }
  }
});

test("editable copies cannot overwrite the shared original or another download", () => {
  const original = templateMarkdown("demo-3");
  const editable = getPptTemplate("demo-3");
  editable.name = "用户改稿";
  editable.slides[0].title = "我的标题";
  editable.slides[0].write.push("用户填入的内容");
  editable.slides[0].avoid[0] = "另一条提醒";
  editable.slides.pop();
  assert.equal(templateMarkdown("demo-3"), original);
  assert.notEqual(getPptTemplate("demo-3").slides[0].title, "我的标题");
});

test("Markdown exports remain manual frameworks and never claim an AI or saved result", () => {
  for (const template of PPT_TEMPLATES) {
    const markdown = templateMarkdown(template.id);
    assert.match(markdown, /本站原创结构模板.*手动填写框架，未调用 AI/);
    assert.match(markdown, /Markdown（\.md）.*不是 PowerPoint（\.pptx）/);
    assert.match(markdown, /已完成、待实现和证据待补/);
    assert.match(markdown, /尚未测量/);
    assert.match(markdown, /\[填写\]/);
    assert.equal((markdown.match(/### 写什么/g) ?? []).length, template.slides.length);
    assert.equal((markdown.match(/### 讲什么/g) ?? []).length, template.slides.length);
    assert.equal((markdown.match(/### 避坑/g) ?? []).length, template.slides.length);
    assert.ok(!("schemaVersion" in template));
    assert.ok(!("inputSnapshot" in template));
    assert.ok(!("facts" in template));
    assert.doesNotMatch(markdown, /provider:dsh|artifactId|AI 已生成|已保存至账号/);
  }
});

test("unknown runtime ids fail before a framework can be downloaded", () => {
  const unknown = "someone-else" as PptTemplateId;
  assert.throws(() => getPptTemplate(unknown), RangeError);
  assert.throws(() => templateMarkdown(unknown), RangeError);
});

test("tool cards retain verified official links and avoid unverified price or license claims", () => {
  const officialHosts = new Map([
    ["powerpoint", "www.microsoft.com"],
    ["google-slides", "workspace.google.com"],
    ["canva", "www.canva.com"],
    ["gamma", "gamma.app"],
  ]);
  assert.equal(PPT_TOOLS.length, officialHosts.size);
  assert.equal(new Set(PPT_TOOLS.map((tool) => tool.id)).size, PPT_TOOLS.length);
  for (const tool of PPT_TOOLS) {
    const url = new URL(tool.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, officialHosts.get(tool.id));
    assert.equal(tool.verifiedAt, "2026-10-09");
    assert.ok(tool.description.trim() && tool.useWhen.trim() && tool.note.trim());
    assert.doesNotMatch(`${tool.description} ${tool.useWhen} ${tool.note}`, /永久免费|全部免费|可商用|无限额度|免费许可/);
  }
});
