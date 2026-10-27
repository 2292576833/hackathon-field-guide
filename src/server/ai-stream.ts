import { AiProviderError, type JsonModelRequest } from "./ai.ts";

/**
 * 规划35 P4：流式文本端口。
 *
 * 只给**编辑器生成**用（规划 §6.5）；模块助手、评分、灵感等仍走非流式 completeJSON。
 * 当前部署的 DSH 传输是子进程一次性 JSON，**没有流式**——所以这个端口只在
 * OpenAI 兼容提供方下可用，根按能力决定是否开启。
 */
export interface StreamingUsage { readonly inputTokens: number; readonly outputTokens: number }
export interface StreamingJsonModelPort {
  readonly modelVersion: string;
  /** `onUsage` 在提供方给出最终用量时回调一次；不给就永远不调，调用方据此如实记录「用量未知」。 */
  streamText(request: JsonModelRequest & { readonly onUsage?: (usage: StreamingUsage) => void }, signal: AbortSignal): AsyncIterable<string>;
}

export interface StreamingHttpOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export function createOpenAICompatibleStreamingModel(options: StreamingHttpOptions): StreamingJsonModelPort {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new AiProviderError("AI_CONFIG_INVALID", "not_sent"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  const secure = base.protocol === "https:" || (options.allowInsecureLoopback === true && local && base.protocol === "http:");
  if (!secure || base.username || base.password || base.search || base.hash || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) {
    throw new AiProviderError("AI_CONFIG_INVALID", "not_sent");
  }
  const endpoint = base.href.replace(/\/$/, "") + "/chat/completions";
  const limit = options.maxResponseBytes ?? 2 * 1024 * 1024;
  const send = options.fetch ?? globalThis.fetch;
  const messages = (request: JsonModelRequest) => [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: typeof request.input === "string" ? request.input : JSON.stringify(request.input) },
  ];
  return {
    modelVersion: options.model,
    async *streamText(request, signal) {
      if (signal.aborted) throw new AiProviderError("AI_CANCELLED", "not_sent");
      const response = await send(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: "Bearer " + options.apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: options.model, messages: messages(request), stream: true, response_format: { type: "json_object" }, stream_options: { include_usage: true } }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new AiProviderError(response.status === 429 ? "AI_RATE_LIMITED" : "AI_REQUEST_REJECTED",
          response.status < 500 ? "rejected" : "unknown");
      }
      if (response.body === null) throw new AiProviderError("AI_RESPONSE_INVALID", "not_sent");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let buffer = "", total = 0, finished = false;
      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) throw new AiProviderError("AI_RESPONSE_TOO_LARGE", "response_received");
          buffer += decoder.decode(value, { stream: true });
          // SSE 事件以空行分隔；只处理 data: 行。
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const event = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") { finished = true; break; }
              let parsed: unknown;
              try { parsed = JSON.parse(data); } catch { throw new AiProviderError("AI_RESPONSE_INVALID", "response_received"); }
              const usageRaw = (parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
              if (usageRaw && typeof usageRaw.prompt_tokens === "number" && typeof usageRaw.completion_tokens === "number") {
                request.onUsage?.({ inputTokens: usageRaw.prompt_tokens, outputTokens: usageRaw.completion_tokens });
              }
              const choices = (parsed as { choices?: unknown }).choices;
              if (!Array.isArray(choices) || choices.length === 0) continue;
              const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
              if (delta && typeof delta.content === "string" && delta.content.length > 0) yield delta.content;
            }
            if (finished) break;
            index = buffer.indexOf("\n\n");
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
