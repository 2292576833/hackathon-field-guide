import { DomainError } from "../../shared/errors.ts";
import { normalizeSourceUrl } from "./network-policy.ts";
import type { PublicSearchPort, PublicSearchResult } from "./discovery-types.ts";

/** Verified official endpoint; neither the model nor request JSON may configure it. */
export const BRAVE_WEB_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_WEB_SEARCH_DOCUMENTATION = "https://api-dashboard.search.brave.com/api-reference/web/search/get";
export function createBraveSearchProvider(config: {
  readonly apiKey: string; readonly timeoutMs?: number; readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}): PublicSearchPort<readonly PublicSearchResult[]> {
  if (typeof config.apiKey !== "string" || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey)) {
    throw new DomainError("SEARCH_UNCONFIGURED", "尚未配置搜索服务密钥。", { status: 503, recoveryAction: "configure_public_search" });
  }
  const timeoutMs = config.timeoutMs ?? 15_000; const maxBytes = config.maxResponseBytes ?? 1_048_576;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 || !Number.isInteger(maxBytes) || maxBytes < 100 || maxBytes > 2_097_152) throw new DomainError("INVALID_SEARCH_CONFIG", "搜索请求限制无效。");
  const request = config.fetch ?? globalThis.fetch;
  return {
    async search(input) {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 600 || input.query.trim().split(/\s+/).length > 75 || !Number.isInteger(input.count) || input.count < 1 || input.count > 20) throw new DomainError("INVALID_SEARCH_QUERY", "搜索词或结果数量无效。");
      const controller = new AbortController();
      const cancel = () => controller.abort(input.signal.reason);
      input.signal.addEventListener("abort", cancel, { once: true });
      if (input.signal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(new Error("search timeout")), timeoutMs);
      try {
        const url = new URL(BRAVE_WEB_SEARCH_ENDPOINT);
        url.searchParams.set("q", input.query.trim()); url.searchParams.set("count", String(input.count)); url.searchParams.set("safesearch", "strict");
        const response = await request(url, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
          headers: { Accept: "application/json", "X-Subscription-Token": config.apiKey } });
        if (response.status === 401 || response.status === 403) throw new DomainError("SEARCH_AUTH_FAILED", "搜索服务身份或权限无效。", { status: 503 });
        if (response.status === 429) throw new DomainError("SEARCH_RATE_LIMITED", "搜索服务已限流，等待下一调度窗口。", { status: 429 });
        if (!response.ok) throw new DomainError("SEARCH_UNAVAILABLE", "搜索服务暂时无法返回结果。", { status: 503 });
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) throw new DomainError("SEARCH_RESPONSE_INVALID", "搜索服务返回的内容格式无效。", { status: 503 });
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new DomainError("SEARCH_RESPONSE_TOO_LARGE", "搜索结果超出大小限制。", { status: 503 });
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > maxBytes) throw new DomainError("SEARCH_RESPONSE_TOO_LARGE", "搜索结果超出大小限制。", { status: 503 });
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        let payload: unknown;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new DomainError("SEARCH_RESPONSE_INVALID", "搜索结果不是有效 JSON。", { status: 503 }); }
        const rows = (payload as { web?: { results?: unknown } } | null)?.web?.results;
        if (rows === undefined) return [];
        if (!Array.isArray(rows)) throw new DomainError("SEARCH_RESPONSE_INVALID", "搜索结果列表无效。", { status: 503 });
        const results: PublicSearchResult[] = [];
        for (const row of rows.slice(0, input.count)) {
          if (!row || typeof row !== "object") continue;
          const item = row as Record<string, unknown>;
          if (typeof item.url !== "string" || typeof item.title !== "string" || !item.title.trim()) continue;
          try { results.push({ url: normalizeSourceUrl(item.url), title: item.title.slice(0, 300), description: typeof item.description === "string" ? item.description.slice(0, 2000) : "" }); }
          catch { /* Non-public/HTTP/IP URLs are never handed to the fetcher. */ }
        }
        return results;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (input.signal.aborted) throw new DomainError("DISCOVERY_CANCELLED", "持续发现已停止。", { status: 409 });
        if (controller.signal.aborted) throw new DomainError("SEARCH_TIMEOUT", "搜索服务请求超时。", { status: 503 });
        throw new DomainError("SEARCH_UNAVAILABLE", "搜索服务请求失败。", { status: 503 });
      } finally { clearTimeout(timer); controller.abort(); input.signal.removeEventListener("abort", cancel); }
    },
  };
}
