import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AiProviderError, createOpenAICompatibleModel, type JsonModelRequest } from "./ai.ts";

async function mockHttp(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const server = createServer((request, response) => { void Promise.resolve(handle(request, response)).catch(() => { response.statusCode = 500; response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
const input: JsonModelRequest = { systemPrompt: "只整理给定事实。", input: { question: "测试数据" }, promptVersion: "test-v1", outputExample: { advice: "无法确认" } };
function completion(content = JSON.stringify({ advice: "需要核对官方规则" }), finish = "stop", usage: unknown = { prompt_tokens: 20, completion_tokens: 10 }) {
  return { id: "mock-request-1", model: "test-model", choices: [{ finish_reason: finish, message: { role: "assistant", content } }], usage };
}
test("real HTTP transport sends compatible JSON mode and configurable token parameter, returns validated JSON and usage", async () => {
  let received: Record<string, unknown> | undefined;
  let authorization: string | undefined, path: string | undefined;
  const server = await mockHttp(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString());
    authorization = request.headers.authorization; path = request.url;
    response.setHeader("content-type", "application/json"); response.setHeader("x-request-id", "safe-mock-request"); response.end(JSON.stringify(completion()));
  });
  try {
    const model = createOpenAICompatibleModel({ baseUrl: server.baseUrl, apiKey: "unit-test-only-key", model: "test-model", allowInsecureLoopback: true, tokenParameter: "max_completion_tokens", maxOutputTokens: 100 });
    const result = await model.completeJSON(input, new AbortController().signal);
    assert.equal(path, "/v1/chat/completions"); assert.equal(authorization, "Bearer unit-test-only-key");
    assert.deepEqual(received?.response_format, { type: "json_object" }); assert.equal(received?.max_completion_tokens, 100); assert.equal(received?.max_tokens, undefined);
    assert.equal(received?.stream, false); assert.equal(received?.tools, undefined);
    assert.deepEqual(result.content, { advice: "需要核对官方规则" }); assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 }); assert.equal(result.requestId, "safe-mock-request");
  } finally { await server.close(); }
});
test("empty, malformed, nonobject and truncated model JSON never become adoptable results", async () => {
  for (const [content, finish, code] of [["", "stop", "AI_RESPONSE_INVALID"], ["not-json", "stop", "AI_JSON_INVALID"], ["[]", "stop", "AI_JSON_INVALID"], ["{}", "length", "AI_OUTPUT_TRUNCATED"]] as const) {
    const server = await mockHttp((_request, response) => { response.end(JSON.stringify(completion(content, finish))); });
    try {
      const model = createOpenAICompatibleModel({ baseUrl: server.baseUrl, apiKey: "unit-test-only-key", model: "test-model", allowInsecureLoopback: true });
      await assert.rejects(model.completeJSON(input, new AbortController().signal), error => error instanceof AiProviderError && error.code === code && error.externalState === "response_received" && error.usage !== null);
    } finally { await server.close(); }
  }
});
test("provider errors never disclose response body or secrets, and only explicit 429 is safely retryable", async () => {
  for (const status of [401, 402, 429, 503]) {
    let calls = 0;
    const server = await mockHttp((_request, response) => { calls++; response.statusCode = status; response.setHeader("retry-after", "0"); response.end("unit-test-only-key sensitive provider text"); });
    try {
      const model = createOpenAICompatibleModel({ baseUrl: server.baseUrl, apiKey: "unit-test-only-key", model: "test-model", allowInsecureLoopback: true });
      await assert.rejects(model.completeJSON(input, new AbortController().signal), error => {
        assert.ok(error instanceof AiProviderError); assert.equal(error.externalState, status === 503 ? "unknown" : "rejected");
        assert.equal(error.retryable, status === 429); assert.doesNotMatch(error.message, /unit-test-only-key|sensitive provider/); return true;
      });
      assert.equal(calls, 1, "the raw transport never retries");
    } finally { await server.close(); }
  }
});
test("timeout after dispatch is uncertain while pre-aborted or oversized input is never sent", async () => {
  let calls = 0;
  // Observe dispatch at the fetch boundary: a loaded test runner may abort a
  // loopback socket before its HTTP handler runs even though it was dispatched.
  const pendingFetch: typeof fetch = (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const model = createOpenAICompatibleModel({ baseUrl: "https://api.example.test/v1", apiKey: "unit-test-only-key", model: "test-model", fetch: pendingFetch, timeoutMs: 50, maxInputBytes: 1024 });
  await assert.rejects(model.completeJSON(input, new AbortController().signal), error => error instanceof AiProviderError && error.code === "AI_TIMEOUT_UNCERTAIN" && error.externalState === "unknown");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(model.completeJSON(input, aborted.signal), error => error instanceof AiProviderError && error.externalState === "not_sent");
  await assert.rejects(model.completeJSON({ ...input, input: "x".repeat(2000) }, new AbortController().signal), error => error instanceof AiProviderError && error.code === "AI_INPUT_TOO_LARGE");
  assert.equal(calls, 1);
});
test("transport rejects insecure remote URLs and bounds successful HTTP response bodies", async () => {
  assert.throws(() => createOpenAICompatibleModel({ baseUrl: "http://api.example.test/v1", apiKey: "unit-test-only-key", model: "test-model", allowInsecureLoopback: true }), /AI/);
  const server = await mockHttp((_request, response) => { response.end("x".repeat(2048)); });
  try {
    const model = createOpenAICompatibleModel({ baseUrl: server.baseUrl, apiKey: "unit-test-only-key", model: "test-model", allowInsecureLoopback: true, maxResponseBytes: 1024 });
    await assert.rejects(model.completeJSON(input, new AbortController().signal), error => error instanceof AiProviderError && error.code === "AI_RESPONSE_TOO_LARGE");
  } finally { await server.close(); }
});
