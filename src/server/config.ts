import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { AiHttpOptions } from "./ai.ts";
import type { AiBudgetPolicy } from "./ai-jobs.ts";
import type { GitHubAppOptions } from "../modules/github/authorization-types.ts";
import type { DeepSeekHarnessConfiguration, ContinuousDiscoveryConfig } from "../modules/operations/index.ts";
import { OFFICIAL_EVENT_SOURCES } from "../modules/operations/index.ts";
import { emailConfiguration } from "./email-config.ts";
import type { SmtpMailConfiguration } from "./smtp-mail.ts";
import { validateLocalTestOrigin } from "./local-test-auth.ts";
import { guanchaConfiguration, type GuanchaLoginConfiguration } from "./guancha-config.ts";

export interface ApplicationConfig {
  mode: "local" | "connected";
  origin: string;
  localTestOrigin?: string;
  guancha?: GuanchaLoginConfiguration;
  databaseUrl?: string;
  localDatabasePath?: string;
  /** Explicit trusted loopback CONNECT proxy for public source fetching only. */
  sourceProxyUrl?: string;
  codePepper: string;
  emailFrom: string;
  resendKey?: string;
  smtp?: SmtpMailConfiguration;
  emailProvider?: "resend" | "smtp";
  globalSendLimit?: number;
  globalVerificationLimit?: number;
  ai?: AiHttpOptions & { budget: AiBudgetPolicy; workerPollMs: number; workerLeaseMs: number; maxAttempts: number };
  aiProvider?: "http" | "dsh";
  github?: { options: GitHubAppOptions; credentialKey: string; keyId: string; previousKeys: Record<string, string> };
  authProxySigners?: readonly { id: string; signingKey: string }[];
  dsh?: DeepSeekHarnessConfiguration & { budget: AiBudgetPolicy; sourceBudget: AiBudgetPolicy };
  inspiration?: Pick<ContinuousDiscoveryConfig, "workerId" | "userAgent" | "minimumIntervalMs" | "recrawlAfterMs" | "maxCycleDurationMs" | "fetchTimeoutMs" | "maxPageBytes" | "modelCostReservationMicrosPerCall" | "limits">;
  discovery?: { provider?: "brave" | "official_sources" | "dsh_native"; searchKey?: string;
    rollingNativeQueries?: boolean;
    coverageTargetHours?: number;
    nativeQueriesPerCycle?: number;
    native?: { modelVersion: string; maxTokens: number; maxUses: number; timeoutMs: number; inputRate: number; outputRate: number };
    worker: ContinuousDiscoveryConfig };
}
/** Refresh the current and next two calendar months for a long-lived search server. */
export function defaultNativeEventQueries(now: Date, round = 0): string[] {
  const dates = Array.from({ length: 3 }, (_, index) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index, 1)));
  const months = dates.map(date => `"${date.getUTCFullYear()}年${date.getUTCMonth()+1}月"`).join(" OR ");
  const years = [...new Set(dates.map(date=>date.getUTCFullYear()))].join(" OR ");
  // Two requests per round: change the source focus instead of repeatedly
  // asking one large multi-platform query for the same top-ranked results.
  const groups = [
    [`(${years}) 黑客松 黑客马拉松 比赛 报名 招募 主办方 官网`, `(${years}) hackathon open registration upcoming official competition`],
    [`(${months}) 黑客松 报名 招募 site:mp.weixin.qq.com`, `(${years}) 黑客马拉松 AI 黑客松 报名 公众号 微信`],
    [`(${years}) 黑客松 比赛 报名 招募 site:xiaohongshu.com`, `(${years}) 黑客松 hackathon 招募 报名 site:weibo.com`],
    [`(${years}) 黑客松 报名 招募 site:bilibili.com`, `(${years}) 黑客松 招募 比赛 site:okjike.com`],
    [`(${years}) 黑客松 AI 编程 比赛 报名 site:zhihu.com`, `(${years}) 黑客松 比赛 报名 site:douyin.com`],
    [`(${years}) hackathon upcoming registration site:ethglobal.com/events`, `(${years}) AI hackathon registration site:lablab.ai/event`],
    [`(${years}) hackathon developer challenge registration site:devpost.com`, `(${years}) 黑客松 创新挑战赛 报名 招募 大学 开发者`],
    [`(${years}) hackathon registration announcement site:x.com OR site:linkedin.com`, `(${years}) hackathon open registration community site:reddit.com OR site:lu.ma`],
  ];
  const index = Number.isSafeInteger(round) && round >= 0 ? round % groups.length : 0;
  const today = now.toISOString().slice(0, 10);
  return groups[index]!.map(query => /黑客|比赛|报名/u.test(query)
    ? `${query} 报名仍开放 报名截止晚于 ${today}`
    : `${query} registration still open application deadline after ${today}`);
}
/** Split the existing sixteen source queries into smaller bounded paid batches. */
export function defaultNativeEventQueryBatch(now: Date, round = 0, batchSize = 2): string[] {
  if (![1, 2].includes(batchSize)) throw new Error("Native query batch size must be 1 or 2.");
  const position = Number.isSafeInteger(round) && round >= 0 ? round : 0;
  if (batchSize === 2) return defaultNativeEventQueries(now, position);
  return [defaultNativeEventQueries(now, Math.floor(position / 2))[position % 2]!];
}
export async function loadConfig(): Promise<ApplicationConfig> {
  const mode = process.env.APP_MODE === "local" || (!process.env.APP_MODE && process.env.NODE_ENV !== "production") ? "local" : "connected";
  const origin = process.env.AUTH_ORIGIN ?? (mode === "local" ? "http://localhost:3000" : "");
  const url = new URL(origin);
  const loopbackOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const publicLocalPreview = mode === "local" && !loopbackOrigin && process.env.AUTH_ALLOW_PUBLIC_LOCAL_ORIGIN === "true";
  if (url.origin !== origin || (mode === "local" && !loopbackOrigin && !publicLocalPreview)) throw new Error("Local mode requires an exact loopback origin unless the explicit public preview flag is enabled.");
  if (publicLocalPreview && url.protocol !== "https:") throw new Error("Public local preview requires an HTTPS AUTH_ORIGIN.");
  if (mode === "connected" && url.protocol !== "https:") throw new Error("Connected mode requires a configured HTTPS AUTH_ORIGIN.");
  const localTestOrigin = validateLocalTestOrigin(mode, process.env.AUTH_LOCAL_TEST_ORIGIN);
  let codePepper = process.env.AUTH_CODE_PEPPER;
  if (!codePepper && mode === "local") {
    const directory = join(process.cwd(), ".runtime");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "local-secrets.json");
    try { codePepper = (JSON.parse(await readFile(path, "utf8")) as { codePepper: string }).codePepper; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      codePepper = randomBytes(48).toString("base64url");
      try { await writeFile(path, JSON.stringify({ codePepper }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; codePepper = (JSON.parse(await readFile(path, "utf8")) as { codePepper: string }).codePepper; }
    }
  }
  if (!codePepper || Buffer.byteLength(codePepper) < 32) throw new Error("AUTH_CODE_PEPPER must contain at least 32 bytes.");
  if (mode === "connected" && !process.env.DATABASE_URL) throw new Error("Connected mode requires DATABASE_URL.");
  const sourceProxyUrl = process.env.SOURCE_HTTP_PROXY;
  if (sourceProxyUrl) {
    if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(sourceProxyUrl) || Number(new URL(sourceProxyUrl).port) > 65535) {
      throw new Error("SOURCE_HTTP_PROXY requires an explicit trusted loopback HTTP proxy with a valid port, without credentials or paths.");
    }
  }
  const email = emailConfiguration(process.env);
  const budget = (name: string, fallback: number, maximum: number, minimum = 1) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} requires a bounded integer between ${minimum} and ${maximum}.`);
    return value;
  };
  const optionalInteger = (name: string, maximum = 1_000_000_000_000) => process.env[name] === undefined ? undefined : budget(name, 1, maximum);
  let ai: ApplicationConfig["ai"];
  const aiNames = ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL"];
  if (aiNames.some(name => process.env[name])) {
    if (!aiNames.every(name => process.env[name]?.trim())) throw new Error("AI_BASE_URL, AI_API_KEY and AI_MODEL are required together.");
    const tokenParameter = process.env.AI_TOKEN_PARAMETER ?? "max_tokens";
    if (tokenParameter !== "max_tokens" && tokenParameter !== "max_completion_tokens") throw new Error("AI_TOKEN_PARAMETER is invalid.");
    if (budget("AI_MAX_OUTPUT_TOKENS", 8192, 65_536) < 512) throw new Error("AI_MAX_OUTPUT_TOKENS must allow at least 512 tokens for validated drafts.");
    ai = { baseUrl: process.env.AI_BASE_URL!, apiKey: process.env.AI_API_KEY!, model: process.env.AI_MODEL!,
      timeoutMs: budget("AI_TIMEOUT_MS", 30_000, 120_000), maxInputBytes: budget("AI_MAX_INPUT_BYTES", 131_072, 2_097_152),
      maxOutputTokens: budget("AI_MAX_OUTPUT_TOKENS", 8192, 65_536), tokenParameter,
      allowInsecureLoopback: mode === "local" && process.env.AI_ALLOW_INSECURE_LOOPBACK === "true",
      budget: { dailyProjectCallLimit: budget("AI_DAILY_PROJECT_CALL_LIMIT", 40, 100_000), dailyProjectBudgetMicroUsd: optionalInteger("AI_DAILY_PROJECT_BUDGET_MICRO_USD"),
        inputMicroUsdPerMillion: optionalInteger("AI_INPUT_MICRO_USD_PER_MILLION"), outputMicroUsdPerMillion: optionalInteger("AI_OUTPUT_MICRO_USD_PER_MILLION") },
      workerPollMs: budget("AI_WORKER_POLL_MS", 2000, 60_000), workerLeaseMs: budget("AI_WORKER_LEASE_MS", 180_000, 600_000),
      maxAttempts: budget("AI_MAX_HTTP_ATTEMPTS", 1, 3) };
  }
  let github: ApplicationConfig["github"];
  const githubNames = ["GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_SLUG"];
  const credentialKey = process.env.GITHUB_TOKEN_ENCRYPTION_KEY ?? process.env.GITHUB_CREDENTIAL_KEY;
  if (githubNames.some(name => process.env[name]) || credentialKey) {
    if (!githubNames.every(name => process.env[name]?.trim()) || !credentialKey?.trim()) throw new Error("GitHub App credentials, slug and credential encryption key are required together.");
    let previousKeys: Record<string, string> = {};
    try { if (process.env.GITHUB_TOKEN_ENCRYPTION_PREVIOUS_KEYS) { const value = JSON.parse(process.env.GITHUB_TOKEN_ENCRYPTION_PREVIOUS_KEYS); if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(key => typeof key !== "string")) throw new Error(); previousKeys = value; } } catch { throw new Error("GitHub previous keyring configuration is invalid."); }
    const callbackUrl = `${origin}/api/v1/github/authorization/callback`;
    if (process.env.GITHUB_CALLBACK_URL && process.env.GITHUB_CALLBACK_URL !== callbackUrl) throw new Error("GITHUB_CALLBACK_URL must match the website callback route.");
    github = { options: { appId: budget("GITHUB_APP_ID", 1, Number.MAX_SAFE_INTEGER), clientId: process.env.GITHUB_APP_CLIENT_ID!, clientSecret: process.env.GITHUB_APP_CLIENT_SECRET!,
      appSlug: process.env.GITHUB_APP_SLUG!, origin, callbackUrl },
      credentialKey, keyId: process.env.GITHUB_TOKEN_ENCRYPTION_KEY_ID ?? process.env.GITHUB_CREDENTIAL_KEY_ID ?? "v1", previousKeys };
  }
  let authProxySigners: ApplicationConfig["authProxySigners"];
  if (process.env.AUTH_PROXY_SIGNERS_JSON) {
    try { const value = JSON.parse(process.env.AUTH_PROXY_SIGNERS_JSON); if (!Array.isArray(value) || value.length < 1 || value.length > 10 || value.some(item => !item || typeof item.id !== "string" || typeof item.signingKey !== "string" || Object.keys(item).some(key => !["id", "signingKey"].includes(key)))) throw new Error(); authProxySigners = value; }
    catch { throw new Error("AUTH_PROXY_SIGNERS_JSON must contain configured proxy IDs and private signing keys."); }
  }
  const nonnegative = (name: string, fallback?: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) throw new Error(`${name} requires a configured nonnegative integer.`);
    return value;
  };
  let dsh: ApplicationConfig["dsh"];
  if (process.env.DSH_DESKTOP_DIRECTORY || process.env.DSH_ACCOUNT_CREDENTIALS_FILE || process.env.DSH_API_KEY || process.env.DSH_MODEL) {
    const credentials = [process.env.DSH_DESKTOP_DIRECTORY, process.env.DSH_ACCOUNT_CREDENTIALS_FILE, process.env.DSH_API_KEY].filter(value => value?.trim());
    if (!process.env.DSH_MODEL?.trim() || credentials.length !== 1) throw new Error("DSH_MODEL requires exactly one Desktop, Node account, or API-key credential mode.");
    if (process.env.DSH_ACCOUNT_CREDENTIALS_FILE && !isAbsolute(process.env.DSH_ACCOUNT_CREDENTIALS_FILE)) throw new Error("DSH_ACCOUNT_CREDENTIALS_FILE requires an absolute private server path.");
    if (process.env.DSH_DESKTOP_DIRECTORY && (process.env.DSH_API_KEY || (mode !== "local" && process.platform !== "win32"))) throw new Error("Desktop DSH uses its account credential and requires its installed Windows host.");
    const inputRate = nonnegative("DSH_INPUT_MICRO_USD_PER_MILLION");
    const outputRate = nonnegative("DSH_OUTPUT_MICRO_USD_PER_MILLION");
    dsh = { apiKey: process.env.DSH_API_KEY, modelVersion: process.env.DSH_MODEL, promptVersion: "field-guide-dsh-v1",
      desktopInstallationDirectory: process.env.DSH_DESKTOP_DIRECTORY,
      accountCredentialsFile: process.env.DSH_ACCOUNT_CREDENTIALS_FILE,
      desktopCredentialsFile: process.env.DSH_DESKTOP_DIRECTORY ? process.env.DSH_DESKTOP_CREDENTIALS_FILE ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml") : undefined,
      runtimePackageDirectory: process.env.DSH_RUNTIME_PACKAGE_DIRECTORY ?? join(process.cwd(), ".runtime", "dsh-runtime", "node_modules", "@deepseek-ai", "dsh"),
      workingDirectory: join(process.cwd(), ".runtime", "dsh-sessions"), baseUrl: process.env.DSH_BASE_URL,
      timeoutMs: budget("DSH_TIMEOUT_MS", 90_000, 120_000), maxTokens: budget("DSH_MAX_OUTPUT_TOKENS", 8192, 65_536), maxInputBytes: budget("DSH_MAX_INPUT_BYTES", 131_072, 2_097_152),
      currency: "USD", inputCostMicrosPerMillionTokens: inputRate, outputCostMicrosPerMillionTokens: outputRate,
      budget: { dailyProjectCallLimit: budget("DSH_DAILY_NAVIGATOR_CALL_LIMIT", 40, 1000), dailyProjectBudgetMicroUsd: optionalInteger("DSH_DAILY_NAVIGATOR_BUDGET_MICRO_USD"), inputMicroUsdPerMillion: inputRate, outputMicroUsdPerMillion: outputRate },
      sourceBudget: { dailyProjectCallLimit: budget("DSH_DAILY_SOURCE_CALL_LIMIT", 20, 1000), dailyProjectBudgetMicroUsd: budget("DSH_DAILY_SOURCE_BUDGET_MICRO_USD", 2_000_000, 1_000_000_000_000), inputMicroUsdPerMillion: inputRate, outputMicroUsdPerMillion: outputRate } };
  }
  const aiProvider = process.env.AI_PROVIDER ?? (process.env.DSH_DESKTOP_DIRECTORY || process.env.DSH_ACCOUNT_CREDENTIALS_FILE ? "dsh" : "http");
  if (aiProvider !== "http" && aiProvider !== "dsh") throw new Error("AI_PROVIDER must be http or dsh.");
  if (aiProvider === "dsh" && !dsh) throw new Error("AI_PROVIDER=dsh requires configured DSH.");
  let discovery: ApplicationConfig["discovery"];
  const discoveryProvider = process.env.DISCOVERY_PROVIDER ?? (process.env.BRAVE_SEARCH_API_KEY ? "brave" : undefined);
  if (discoveryProvider && !["brave", "official_sources", "dsh_native"].includes(discoveryProvider)) throw new Error("DISCOVERY_PROVIDER must be brave, official_sources or dsh_native.");
  if (discoveryProvider) {
    if (!dsh) throw new Error("Continuous discovery requires configured DSH.");
    const nativeQueriesPerCycle = budget("DISCOVERY_NATIVE_QUERIES_PER_CYCLE", 2, 2, 1);
    const coverageTargetHours = budget("DISCOVERY_COVERAGE_TARGET_HOURS", 5, 24, 1);
    let queries: string[];
    if (discoveryProvider === "official_sources") {
      try {
        const value: unknown = process.env.DISCOVERY_SOURCE_IDS_JSON ? JSON.parse(process.env.DISCOVERY_SOURCE_IDS_JSON) : ["ethglobal", "lablab"];
        if (!Array.isArray(value) || value.length < 1 || value.length > 5 || new Set(value).size !== value.length || value.some(id => typeof id !== "string" || !OFFICIAL_EVENT_SOURCES.some(source => source.id === id))) throw new Error();
        queries = value;
      } catch { throw new Error("DISCOVERY_SOURCE_IDS_JSON must contain 1-5 distinct supported official source IDs."); }
    } else if (discoveryProvider === "brave") {
      if (!process.env.BRAVE_SEARCH_API_KEY?.trim()) throw new Error("Brave discovery requires BRAVE_SEARCH_API_KEY.");
      queries = [`hackathon open registration official ${new Date().getUTCFullYear()}`, `黑客松 比赛 报名 官网 ${new Date().getUTCFullYear()}`];
      if (process.env.DISCOVERY_QUERIES_JSON) { try { const value = JSON.parse(process.env.DISCOVERY_QUERIES_JSON); if (!Array.isArray(value) || !value.length || value.length > 5 || value.some(q => typeof q !== "string" || !q.trim() || q.length > 300)) throw new Error(); queries = value; } catch { throw new Error("DISCOVERY_QUERIES_JSON is invalid."); } }
    } else {
      if (!dsh.desktopInstallationDirectory && !dsh.accountCredentialsFile) throw new Error("Native DSH search requires a configured Desktop or official Node account runtime.");
      queries = defaultNativeEventQueryBatch(new Date(), 0, nativeQueriesPerCycle);
      if (process.env.DISCOVERY_QUERIES_JSON) { try { const value: unknown = JSON.parse(process.env.DISCOVERY_QUERIES_JSON); if (!Array.isArray(value) || !value.length || value.length > 5 || new Set(value).size !== value.length || value.some(q => typeof q !== "string" || !q.trim() || q.length > 600 || /[\u0000-\u001f]/.test(q))) throw new Error(); queries = value; } catch { throw new Error("DISCOVERY_QUERIES_JSON must contain 1-5 distinct bounded public search queries."); } }
    }
    const reservedCost = Math.ceil((dsh.maxInputBytes! * dsh.inputCostMicrosPerMillionTokens + dsh.maxTokens! * dsh.outputCostMicrosPerMillionTokens) / 1_000_000);
    const native = discoveryProvider === "dsh_native" ? { modelVersion: process.env.DSH_SEARCH_MODEL ?? "deepseek-v4-flash", maxTokens: budget("DSH_SEARCH_MAX_OUTPUT_TOKENS", 2048, 2048, 256), maxUses: budget("DSH_SEARCH_MAX_USES", 1, 2), timeoutMs: budget("DSH_SEARCH_TIMEOUT_MS", 90_000, 120_000, 1000), inputRate: nonnegative("DSH_SEARCH_INPUT_MICRO_USD_PER_MILLION", dsh.inputCostMicrosPerMillionTokens), outputRate: nonnegative("DSH_SEARCH_OUTPUT_MICRO_USD_PER_MILLION", dsh.outputCostMicrosPerMillionTokens) } : undefined;
    if (native && (!/^[a-zA-Z0-9._-]{1,100}$/.test(native.modelVersion) || native.inputRate === 0 || native.outputRate === 0)) throw new Error("Native search requires a valid model name and positive conservative token prices.");
    if (native && !["deepseek-v4-flash", "deepseek-flash"].includes(native.modelVersion)) throw new Error("Native search currently supports the verified DeepSeek Flash model aliases only.");
    // Native web search is a model request. Its internal search context may be
    // larger than the user query, so reserve the complete bounded model window.
    const nativeSearchReservation = native ? Math.ceil((1_048_576 * native.inputRate + native.maxTokens * native.outputRate) * native.maxUses / 1_000_000) : 0;
    discovery = { provider: discoveryProvider as "brave" | "official_sources" | "dsh_native", native,
      coverageTargetHours, nativeQueriesPerCycle,
      rollingNativeQueries: discoveryProvider === "dsh_native" && !process.env.DISCOVERY_QUERIES_JSON,
      searchKey: discoveryProvider === "brave" ? process.env.BRAVE_SEARCH_API_KEY : undefined, worker: { workerId: "field-guide-discovery", userAgent: "HackathonFieldGuide/0.1", queries,
      minimumIntervalMs: budget("DISCOVERY_MINIMUM_INTERVAL_MS", 300_000, 86_400_000, 60_000), recrawlAfterMs: budget("DISCOVERY_RECRAWL_AFTER_MS", 300_000, 604_800_000, 60_000),
      maxResultsPerQuery: budget("DISCOVERY_RESULTS_PER_QUERY", 5, 20), maxPagesPerCycle: budget("DISCOVERY_MAX_PAGES_PER_CYCLE", 3, 10),
      maxCycleDurationMs: budget("DISCOVERY_CYCLE_TIMEOUT_MS", 360_000, 600_000, 1000), fetchTimeoutMs: budget("DISCOVERY_FETCH_TIMEOUT_MS", 15_000, 60_000, 100), maxPageBytes: budget("DISCOVERY_MAX_PAGE_BYTES", 262_144, 1_048_576, 1024),
      searchCostMicrosPerCall: native ? nativeSearchReservation : discoveryProvider === "official_sources" ? 0 : nonnegative("BRAVE_SEARCH_COST_MICRO_USD_PER_CALL"), modelCostReservationMicrosPerCall: reservedCost,
      limits: { maxSearchCallsPerDay: budget("DISCOVERY_DAILY_SEARCH_CALL_LIMIT", 100, 10_000), maxModelCallsPerDay: budget("DISCOVERY_DAILY_MODEL_CALL_LIMIT", 100, 10_000), maxEstimatedCostMicrosPerDay: budget("DISCOVERY_DAILY_BUDGET_MICRO_USD", 10_000_000, 1_000_000_000_000), currency: "USD" } } };
  }
  let inspiration: ApplicationConfig["inspiration"];
  if (process.env.INSPIRATION_ENABLED && !["true", "false"].includes(process.env.INSPIRATION_ENABLED)) throw new Error("INSPIRATION_ENABLED must be true or false.");
  if (process.env.INSPIRATION_ENABLED === "true") {
    if (!dsh) throw new Error("Inspiration analysis requires configured DSH.");
    inspiration = { workerId: "field-guide-inspiration", userAgent: "HackathonFieldGuide/0.1",
      minimumIntervalMs: budget("INSPIRATION_MINIMUM_INTERVAL_MS", 60_000, 86_400_000, 60_000),
      recrawlAfterMs: budget("INSPIRATION_RECRAWL_AFTER_MS", 86_400_000, 604_800_000, 60_000),
      maxCycleDurationMs: budget("INSPIRATION_CYCLE_TIMEOUT_MS", 360_000, 600_000, 1000),
      fetchTimeoutMs: budget("INSPIRATION_FETCH_TIMEOUT_MS", 60_000, 60_000, 100),
      maxPageBytes: budget("INSPIRATION_MAX_PAGE_BYTES", 1_048_576, 1_048_576, 1024),
      modelCostReservationMicrosPerCall: Math.ceil((dsh.maxInputBytes! * dsh.inputCostMicrosPerMillionTokens + dsh.maxTokens! * dsh.outputCostMicrosPerMillionTokens) / 1_000_000),
      limits: { maxSearchCallsPerDay: 0, maxModelCallsPerDay: budget("INSPIRATION_DAILY_MODEL_CALL_LIMIT", 24, 1000), maxEstimatedCostMicrosPerDay: budget("INSPIRATION_DAILY_BUDGET_MICRO_USD", 100_000, 1_000_000_000_000), currency: "USD" } };
  }
  return { mode, origin, localTestOrigin, guancha: guanchaConfiguration(process.env, origin), codePepper, ...email,
    databaseUrl: process.env.DATABASE_URL, localDatabasePath: mode === "local" && !process.env.DATABASE_URL ? join(process.cwd(), ".runtime", "postgres-data") : undefined, sourceProxyUrl,
    globalSendLimit: budget("AUTH_GLOBAL_SEND_LIMIT", mode === "connected" ? 200 : 20, 1000),
    globalVerificationLimit: budget("AUTH_GLOBAL_VERIFICATION_LIMIT", mode === "connected" ? 500 : 50, 5000), ai, aiProvider, github, authProxySigners, dsh, discovery, inspiration };
}

/** One effective model path for all project services, without fake HTTP credentials. */
export function aiServiceSettings(config: ApplicationConfig) {
  if (config.aiProvider === "dsh") return config.dsh ? { provider: "dsh" as const, budget: config.dsh.budget, timeoutMs: config.dsh.timeoutMs, maxInputBytes: config.dsh.maxInputBytes,
    maxOutputTokens: config.dsh.maxTokens, maxAttempts: 1, workerPollMs: 2000, workerLeaseMs: 180000 } : null;
  return config.ai ? { ...config.ai, provider: "http" as const } : null;
}
