import test from "node:test";
import assert from "node:assert/strict";
import { validateFields, validateAnswers, canonical, csvCell, pageOptions, identifier, plainText } from "./validation.ts";
import type { RegistrationForm } from "./model.ts";

const form = (fields: unknown): RegistrationForm => ({ eventId: "event-a", revision: 1, title: "报名", description: "", fields: validateFields(fields), changeNote: "", publishedAt: "2026-10-11T03:00:00.000Z" });

test("dynamic fields accept only safe identities, types and bounded choices/ranges", () => {
  for (const id of ["constructor", "prototype", "__proto__", "x.y", "1bad"]) assert.throws(() => validateFields([{ id, type: "text", label: "测试", required: true }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields([{ id: "a", type: "expression", label: "任意脚本", required: true }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields([{ id: "a", type: "choice", label: "重复选项", required: false, options: ["a", " a "] }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields([{ id: "a", type: "number", label: "范围", required: false, min: 5, max: 4 }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields([{ id: "a", type: "number", label: "范围", required: false, min: Infinity }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields([{ id: "a", type: "text", label: "长度", required: false, maxLength: 501 }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields([{ id: "a", type: "text", label: "a", required: false }, { id: "a", type: "text", label: "b", required: false }]), { code: "INVALID_INPUT" });
  assert.throws(() => validateFields(Array.from({ length: 31 }, (_, i) => ({ id: `field${i}`, type: "text", label: "a", required: false }))), { code: "INVALID_INPUT" });
  const fields = validateFields([{ id: "intro", type: "textarea", label: "<script>只是文字</script>", description: "解释规则", required: false }]);
  assert.equal(fields[0].maxLength, 4000); assert.equal(fields[0].label, "<script>只是文字</script>");
});

test("drafts may omit required fields but submission validates actual typed answers and forbids unknown keys", () => {
  const schema = form([{ id: "goal", type: "text", label: "目的", required: true, maxLength: 10 }, { id: "hours", type: "number", label: "时间", required: false, min: 0, max: 10 }, { id: "role", type: "choice", label: "职责", required: false, options: ["设计", "开发"] }, { id: "tools", type: "multichoice", label: "工具", required: false, options: ["a", "b"] }]);
  assert.deepEqual({ ...validateAnswers(schema, {}, false) }, {});
  assert.throws(() => validateAnswers(schema, {}, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "ok", hours: "5" }, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "ok", hours: 11 }, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "ok", role: "运营" }, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "ok", tools: ["a", "a"] }, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "ok", tools: ["a", "foreign"] }, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "ok", admin: true }, true), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, { goal: "too-long-answer" }, false), { code: "INVALID_INPUT" });
  const output = validateAnswers(schema, { goal: " 小作品 ", hours: 0, role: "设计", tools: ["a", "b"] }, true);
  assert.deepEqual({ ...output }, { goal: "小作品", hours: 0, role: "设计", tools: ["a", "b"] });
  assert.equal(Object.getPrototypeOf(output), null);
  assert.throws(() => validateAnswers(schema, new Date(), false), { code: "INVALID_INPUT" });
  assert.throws(() => validateAnswers(schema, JSON.parse('{"__proto__":{"polluted":true}}'), false), { code: "INVALID_INPUT" });
});

test("URL fields reject credentials and executable protocols; text limits preserve ordinary multiline content", () => {
  const schema = form([{ id: "website", type: "url", label: "网址", required: true }]);
  for (const website of ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/x", "https://name:password@example.com", "www.example.com"]) assert.throws(() => validateAnswers(schema, { website }, true), { code: "INVALID_INPUT" });
  assert.equal(validateAnswers(schema, { website: "https://example.com/path?q=a" }, true).website, "https://example.com/path?q=a");
  assert.equal(plainText("第一行\n第二行", "描述", 100), "第一行\n第二行");
  assert.throws(() => plainText("bad\u0000value", "描述", 100), { code: "INVALID_INPUT" });
  assert.throws(() => identifier("bad\nvalue"), { code: "INVALID_INPUT" });
  assert.throws(() => pageOptions({ limit: 0 }), { code: "INVALID_INPUT" });
  assert.throws(() => pageOptions({ limit: 101 }), { code: "INVALID_INPUT" });
});

test("CSV neutralizes spreadsheet formulas including hidden prefixes and escapes quote/newline cells", () => {
  for (const value of ["=1+1", "+cmd", "-cmd", "@SUM(A1)", "  =x", "\t@x", "\r\n+x"]) assert.equal(csvCell(value), `"'${value}"`);
  assert.equal(csvCell('包含"引号\n换行'), '"包含""引号\n换行"');
  assert.equal(csvCell("普通文字"), '"普通文字"');
  assert.equal(csvCell({ goal: "=SUM(1)" }), '"{""goal"":""=SUM(1)""}"', "structured answers remain a JSON literal cell, not an executable formula");
  assert.equal(canonical({ b: [2, 1], a: { z: true, y: null } }), canonical({ a: { y: null, z: true }, b: [2, 1] }));
  assert.notEqual(canonical([2, 1]), canonical([1, 2]));
});
