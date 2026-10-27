import { createHash } from "node:crypto";
import type { PublicSearchPort } from "../modules/operations/discovery-types.ts";
import { normalizeSourceUrl } from "../modules/operations/index.ts";
import type { ApplicationConfig } from "./config.ts";
import { createDshNativeSearchRuntime } from "./dsh-search-runtime.ts";
import { DomainError } from "../shared/errors.ts";

/** Only the official native tool's structured results and cited text cross
 * this boundary. Generated prose and inferred URLs never become evidence. */
export function createNativeDiscoverySearch(config: NonNullable<ApplicationConfig["dsh"]>,
  options: NonNullable<NonNullable<ApplicationConfig["discovery"]>["native"]>,
  runtime = createDshNativeSearchRuntime(config, options)): PublicSearchPort {
  const requestIdentity = createHash("sha256").update(JSON.stringify(runtime.identity)).digest("hex");
  return { modelCallsPerSearch: 1, requestIdentity, resultOrdering: "interleave",
    async search(input) {
      const response = await runtime.search(input);
      const seen = new Set<string>();
      const results = response.sources.flatMap(source => {
        try {
          const url = normalizeSourceUrl(source.url);
          if (seen.has(url)) return []; seen.add(url);
          const title = source.title?.trim().slice(0, 200) || new URL(url).hostname;
          const snippet = typeof source.snippet === "string" ? source.snippet.trim().slice(0, 16_000) : "";
          return [{ url, title, description: snippet.slice(0, 1000), ...(snippet ? { indexedExcerpt: snippet } : {}) }];
        } catch { return []; }
      }).slice(0, input.count);
      let usage = null;
      if (response.usage) {
        const { inputTokens, outputTokens } = response.usage;
        const estimatedCostMicros = Math.ceil((inputTokens * options.inputRate + outputTokens * options.outputRate) / 1_000_000);
        if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0) throw new DomainError("DSH_SEARCH_USAGE_INVALID", "原生搜索用量无效。");
        usage = { inputTokens, outputTokens, estimatedCostMicros, currency: "USD" as const };
      }
      return { results, usage };
    } };
}
