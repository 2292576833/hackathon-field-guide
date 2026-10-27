import assert from "node:assert/strict";
import test from "node:test";
import { parseDshJsonObject } from "./dsh-json.ts";

test("complete raw objects and one outer JSON fence preserve values", () => {
  const data = { title: "真实赛事", nested: { quoted: 'a } { b ```json', newline: "第一行\n第二行" }, cards: [] };
  const json = JSON.stringify(data);
  for (const [text, outputFormat] of [[` \ufeff${json}\n`, "json"], [` \n\`\`\`json\n${json}\n\`\`\`\t`, "json_fence"], [`\`\`\`JSON\t\r\n${json}\r\n\`\`\``, "json_fence"]] as const) {
    assert.deepEqual(parseDshJsonObject(text), { ok: true, data, outputFormat, outputBytes: Buffer.byteLength(text) });
  }
});

test("parser never extracts objects from commentary, multiple answers or incomplete JSON", () => {
  for (const [text, outputFormat] of [
    [" \n\t", "empty"],
    ['前言 {"ok":true}', "invalid_json"],
    ['{"ok":true} 后记', "invalid_json"],
    ['{"ok":true}\n{"other":false}', "invalid_json"],
    ['{"unfinished":"正文', "invalid_json"],
    ['{"ok":true,}', "invalid_json"],
    ['```json\n{"ok":true}\n```\n后记', "invalid_fence"],
    ['前言\n```json\n{"ok":true}\n```', "invalid_fence"],
    ['```json\n{"ok":true}', "invalid_fence"],
    ['```json {"ok":true}\n```', "invalid_fence"],
    ['```javascript\n{"ok":true}\n```', "invalid_fence"],
    ['```\n{"ok":true}\n```', "invalid_fence"],
    ['```json\n{"ok":true}\n```\n```json\n{"other":true}\n```', "invalid_json_fence"],
    ['```json\n{"ok":true}\n{"other":true}\n```', "invalid_json_fence"],
    ['```json\n{"unfinished":"正文\n```', "invalid_json_fence"],
  ] as const) {
    assert.deepEqual(parseDshJsonObject(text), { ok: false, outputFormat, outputBytes: Buffer.byteLength(text) });
  }
});

test("top-level arrays, scalars and null never become structured model objects", () => {
  for (const text of ['[]', '[{"ok":true}]', 'null', 'true', '12', '"response"', '```json\n[]\n```']) {
    assert.deepEqual(parseDshJsonObject(text), { ok: false, outputFormat: "non_object", outputBytes: Buffer.byteLength(text) });
  }
});

test("failure diagnostics contain only a fixed classification and UTF8 byte count", () => {
  const raw = 'private-model-text: 凭据_FIXTURE_ONLY_SECRET {"unfinished"';
  const result = parseDshJsonObject(raw);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "outputBytes", "outputFormat"]);
  assert.equal(result.outputBytes, Buffer.byteLength(raw, "utf8"));
  assert.doesNotMatch(JSON.stringify(result), /private-model-text|凭据|FIXTURE_ONLY_SECRET|unfinished/);
});
