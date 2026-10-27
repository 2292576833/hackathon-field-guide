import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { GuanchaProviderPort } from "./ports.ts";

/** Official guide linked by watcha.cn's /login component; see protocol-notes.md.
 * These are public OAuth endpoints, not the site's /oauth2-server UI APIs. */
export const GUANCHA_OFFICIAL_ENDPOINTS = Object.freeze({
  issuer: "https://watcha.cn",
  authorization: "https://watcha.cn/oauth/authorize",
  token: "https://watcha.cn/oauth/api/token",
  userinfo: "https://watcha.cn/oauth/api/userinfo",
  documentation: "https://agentuniverse.feishu.cn/wiki/EMYHwT3sIiUYaDkL1ZvcPntGnpb",
});

export interface GuanchaProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
  readonly redirectUri: string;
  /** Tests may inject a transport. Never use one that disables TLS validation,
   * logs request URLs/bodies, follows redirects or automatically retries. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

const failure = () => new Error("Guancha provider response could not be verified.");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Avoid framework-patched fetch caches/tracing for the officially documented
 * access_token query. Native HTTPS keeps certificate verification enabled,
 * performs no redirect/retry, and emits no application request log. */
function privateHttpsRequest(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoingHeaders = new Headers(init.headers);
    outgoingHeaders.set("accept-encoding", "identity");
    const request = httpsRequest(url, {
      method: init.method, headers: Object.fromEntries(outgoingHeaders), signal: init.signal ?? undefined,
    }, incoming => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      try {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode ?? 502, headers,
        }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.on("error", reject);
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
}

/** Official OAuth authorization-code + S256 adapter, not an OIDC JWT decoder.
 * Uses only scope=read. No provider email is requested or trusted for linking. */
export function createGuanchaProvider(options: GuanchaProviderOptions): GuanchaProviderPort {
  const { clientId, clientSecret, origin, redirectUri } = options;
  let base: URL;
  try { base = new URL(origin); } catch { throw new Error("Invalid Guancha callback origin."); }
  if (base.protocol !== "https:" || base.origin !== origin || base.username || base.password
      || redirectUri !== `${origin}/api/v1/auth/guancha/callback`) throw new Error("Guancha requires the exact configured HTTPS callback.");
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 512 || /[\u0000-\u0020\u007f]/.test(clientId)
      || typeof clientSecret !== "string" || clientSecret.length < 1 || clientSecret.length > 4096 || /[\u0000-\u001f\u007f]/.test(clientSecret)) {
    throw new Error("Guancha client credentials are not configured.");
  }
  const timeoutMs = options.timeoutMs ?? 10_000, maximum = options.maximumResponseBytes ?? 65_536;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
      || !Number.isSafeInteger(maximum) || maximum < 256 || maximum > 262_144) throw new Error("Invalid Guancha provider limits.");
  const fetcher = options.fetch ?? privateHttpsRequest;
  // Namespace/version is configuration metadata, not an OpenID `iss` assertion.
  const configuration = Object.freeze({
    issuer: GUANCHA_OFFICIAL_ENDPOINTS.issuer, authorizationEndpoint: GUANCHA_OFFICIAL_ENDPOINTS.authorization,
    redirectUri, documentationUrl: GUANCHA_OFFICIAL_ENDPOINTS.documentation,
    configurationId: `watcha-v1-${createHash("sha256").update(JSON.stringify([clientId, redirectUri, "read", "S256"])).digest("hex")}`,
    pkce: "S256" as const, useNonce: false,
  });

  async function requestJson(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, { ...init, redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
      if (!response.ok || response.redirected || (response.url && response.url !== url.toString())
          || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw failure();
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw failure();
      if (!response.body) throw failure();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) throw failure();
        chunks.push(next.value);
      }
      if (controller.signal.aborted) throw failure();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!object(value)) throw failure();
      return value;
    } catch { throw failure(); }
    finally {
      clearTimeout(timeout);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      controller.abort();
    }
  }

  return {
    configuration,
    authorizationUrl(input) {
      if (!tokenPattern.test(input.state) || !input.codeChallenge || !tokenPattern.test(input.codeChallenge)
          || input.redirectUri !== redirectUri || input.nonce !== null) throw failure();
      const url = new URL(GUANCHA_OFFICIAL_ENDPOINTS.authorization);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "read", state: input.state,
        code_challenge: input.codeChallenge, code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },
    async exchangeAndVerify(input) {
      try {
        if (input.redirectUri !== redirectUri || !input.codeVerifier || !tokenPattern.test(input.codeVerifier)
            || input.expectedNonce !== null || typeof input.code !== "string" || !input.code.length
            || input.code.length > 2048 || /[\u0000-\u0020\u007f]/.test(input.code)) throw failure();
        const token = await requestJson(new URL(GUANCHA_OFFICIAL_ENDPOINTS.token), {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code: input.code, redirect_uri: redirectUri,
            client_id: clientId, client_secret: clientSecret, code_verifier: input.codeVerifier,
          }).toString(),
        });
        if ("error" in token || typeof token.access_token !== "string" || token.access_token.length > 4096
            || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token.access_token)
            || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer"
            || typeof token.expires_in !== "number" || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0
            || typeof token.scope !== "string" || !token.scope.split(" ").includes("read")) throw failure();
        // The official integration guide documents userinfo's access_token query
        // parameter. Never send this private URL to the browser or application
        // logs; all fetch errors are replaced above. Do not guess Bearer-header
        // support or retry with alternate credential transports.
        const userinfoUrl = new URL(GUANCHA_OFFICIAL_ENDPOINTS.userinfo);
        userinfoUrl.searchParams.set("access_token", token.access_token);
        const userinfo = await requestJson(userinfoUrl, { method: "GET", headers: { accept: "application/json" } });
        if (userinfo.statusCode !== 200 || !object(userinfo.data) || typeof userinfo.data.user_id !== "number"
            || !Number.isSafeInteger(userinfo.data.user_id) || userinfo.data.user_id <= 0) throw failure();
        const name = typeof userinfo.data.nickname === "string" ? userinfo.data.nickname.trim() : "";
        // 观猹官方 userinfo 在用户有头像时返回 avatar_url（官方文档：字段存在才返回）。
        // 这里只做**格式白名单**：必须是 https 且 host 属于观猹自己的资源域；真正的字节校验在下载时做。
        const avatarUrl = typeof userinfo.data.avatar_url === "string" ? userinfo.data.avatar_url.trim() : "";
        const avatarAllowed = (() => {
          if (!avatarUrl || avatarUrl.length > 2048) return false;
          try {
            const parsed = new URL(avatarUrl);
            return parsed.protocol === "https:" && !parsed.username && !parsed.password
              && (parsed.hostname === "watcha.cn" || parsed.hostname.endsWith(".watcha.cn") || parsed.hostname.endsWith(".volces.com"));
          } catch { return false; }
        })();
        return {
          issuer: configuration.issuer, subject: String(userinfo.data.user_id),
          ...(name && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name) ? { displayName: name } : {}),
          ...(avatarAllowed ? { avatarUrl } : {}),
        };
      } catch { throw failure(); }
    },
  };
}
