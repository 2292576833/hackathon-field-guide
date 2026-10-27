import assert from "node:assert/strict";
import test from "node:test";
import { BlocksScanner } from "./json-stream.ts";

const spec = (blocks: readonly unknown[]) => JSON.stringify({ version: 1, blocks });
const feed = (text: string, size = 1): readonly unknown[] => {
  const scanner = new BlocksScanner();
  const out: unknown[] = [];
  for (let index = 0; index < text.length; index += size) out.push(...scanner.push(text.slice(index, index + size)));
  return out;
};

test("整页一次给完时，逐个取出内容区块", () => {
  const text = spec([{ kind: "richText", id: "b1", text: "甲" }, { kind: "faq", id: "b2" }]);
  const blocks = feed(text, text.length);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { kind: "richText", id: "b1", text: "甲" });
  assert.deepEqual(blocks[1], { kind: "faq", id: "b2" });
});

test("逐字符喂入（最坏分片）也得到同样的区块", () => {
  const expected = [{ kind: "richText", id: "b1", text: "甲" }, { kind: "timeline", id: "b2" }];
  assert.deepEqual(feed(spec(expected), 1), expected);
});

test("字符串里的花括号与转义不会被当成结构", () => {
  const block = { kind: "richText", id: "b1", text: "包含 } 和 { 还有 \\\" 引号 \\\\ 反斜杠" };
  assert.deepEqual(feed(spec([block]), 1), [block]);
});

test("嵌套对象与数组按深度处理，不会提前闭合", () => {
  const block = { kind: "highlights", id: "b1", items: [{ heading: "a", text: null }, { heading: "b", text: "x" }], binding: null };
  assert.deepEqual(feed(spec([block]), 1), [block]);
});

test("没有 blocks 字段时什么也不产出", () => {
  assert.deepEqual(feed(JSON.stringify({ version: 1, other: [{ a: 1 }] }), 1), []);
});

test("流被截断时只产出已闭合的区块，并报告未闭合字节", () => {
  const full = spec([{ kind: "richText", id: "b1" }, { kind: "faq", id: "b2" }]);
  const cut = full.slice(0, full.length - 6);
  const scanner = new BlocksScanner();
  const out: unknown[] = [...scanner.push(cut)];
  assert.equal(out.length, 1, "第二个还没闭合");
  assert.deepEqual(out[0], { kind: "richText", id: "b1" });
  assert.equal(scanner.incomplete, true, "数组还没走到右括号");
});

test("单个非法元素被跳过，后续合法元素仍然产出", () => {
  const text = "{\"version\":1,\"blocks\":[{\"kind\":\"richText\",},{\"kind\":\"faq\",\"id\":\"b2\"}]}";
  assert.deepEqual(feed(text, 1), [{ kind: "faq", id: "b2" }]);
});
