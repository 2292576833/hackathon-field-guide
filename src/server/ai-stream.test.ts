import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderError } from "./ai.ts";
import { createOpenAICompatibleStreamingModel } from "./ai-stream.ts";

const encoder = new TextEncoder();
const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
});
const fetchOf = (body: ReadableStream<Uint8Array> | null, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;
const model = (fetcher: typeof fetch, extra: { maxResponseBytes?: number } = {}) =>
  createOpenAICompatibleStreamingModel({ baseUrl: "https://api.example.com/v1", apiKey: "k-123456", model: "m1", fetch: fetcher, ...extra });
const delta = (text: string) => "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n";
const collect = async (port: ReturnType<typeof model>) => {
  let text = "";
  for await (const piece of port.streamText({ systemPrompt: "s", input: "i", promptVersion: "v1" }, new AbortController().signal)) text += piece;
  return text;
};

test("按 SSE 事件累积出完整文本", async () => {
  const body = streamOf([delta("{\"version\":1,"), delta("\"blocks\":[]}"), "data: [DONE]\n\n"]);
  assert.equal(await collect(model(fetchOf(body))), "{\"version\":1,\"blocks\":[]}");
});

test("SSE 事件被任意切开（含切在 data 行中间）也能还原", async () => {
  const raw = delta("{\"a\":1}") + "data: [DONE]\n\n";
  const body = streamOf([raw.slice(0, 5), raw.slice(5, 18), raw.slice(18)]);
  assert.equal(await collect(model(fetchOf(body))), "{\"a\":1}");
});

test("忽略非 data 行与无内容的 delta", async () => {
  const body = streamOf([": keep-alive\n\n", "data: {\"choices\":[{\"delta\":{}}]}\n\n", delta("x"), "data: [DONE]\n\n"]);
  assert.equal(await collect(model(fetchOf(body))), "x");
});

test("非 2xx 直接失败，不当作流", async () => {
  const port = model(fetchOf(streamOf(["data: [DONE]\n\n"]), 429));
  await assert.rejects(collect(port), (error: unknown) => error instanceof AiProviderError && error.code === "AI_RATE_LIMITED");
});

test("响应过大时中止", async () => {
  const big = delta("a".repeat(2048));
  const port = model(fetchOf(streamOf([big, big, big])), { maxResponseBytes: 1024 });
  await assert.rejects(collect(port), (error: unknown) => error instanceof AiProviderError && error.code === "AI_RESPONSE_TOO_LARGE");
});

test("缺少响应体时如实失败", async () => {
  const port = model(fetchOf(null));
  await assert.rejects(collect(port), (error: unknown) => error instanceof AiProviderError && error.code === "AI_RESPONSE_INVALID");
});
