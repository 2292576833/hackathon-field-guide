import { isIP } from "node:net";
import { DomainError } from "../../shared/errors.ts";

export interface NetworkRule {
  readonly hostname: string;
  readonly pathPrefix: string;
}

export interface NetworkPolicy {
  readonly version: number;
  readonly rules: readonly NetworkRule[];
  readonly maxRedirects: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly acceptedContentTypes: readonly string[];
}

const mimeTypes = new Set(["text/html", "text/plain", "application/json"]);
const blockedNames = ["localhost", "local", "internal", "test", "invalid", "example", "home.arpa"];
const reject = (): never => { throw new DomainError("UNSAFE_SOURCE_URL", "来源地址不符合已批准的公开网络范围。", { status: 422 }); };

/** Numeric and IPv6 literals are never accepted as source hostnames. */
export function normalizeSourceUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) reject();
  let url: URL;
  try { url = new URL(value); } catch { return reject(); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) reject();
  if (!host.includes(".") || host.includes(":") || isIP(host) !== 0 || host.startsWith("[") || host.length > 253) reject();
  if (blockedNames.some((name) => host === name || host.endsWith(`.${name}`))) reject();
  if (!host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) reject();
  // Reject encoded separators and traversal, including multiply encoded forms.
  let path = url.pathname;
  for (let round = 0; round < 4; round += 1) {
    if (/[\\\u0000]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /%(?:2f|5c|00)/i.test(path)) reject();
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return reject(); }
    if (decoded === path) break;
    path = decoded;
    if (round === 3 && path.includes("%")) reject();
  }
  url.hostname = host;
  url.port = "";
  url.hash = "";
  return url.toString();
}

export function normalizeNetworkPolicy(policy: NetworkPolicy): NetworkPolicy {
  if (!Number.isSafeInteger(policy.version) || policy.version < 1 || !Array.isArray(policy.rules) || policy.rules.length < 1 || policy.rules.length > 20) reject();
  if (!Number.isInteger(policy.maxRedirects) || policy.maxRedirects < 0 || policy.maxRedirects > 3 ||
      !Number.isInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > 2_097_152 ||
      !Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 60_000 ||
      !Array.isArray(policy.acceptedContentTypes) || !policy.acceptedContentTypes.length ||
      policy.acceptedContentTypes.some((type) => !mimeTypes.has(type))) reject();
  const rules = policy.rules.map((rule) => {
    if (typeof rule.hostname !== "string" || typeof rule.pathPrefix !== "string" || !rule.pathPrefix.startsWith("/") || /[?#]/.test(rule.pathPrefix)) reject();
    const url = new URL(normalizeSourceUrl(`https://${rule.hostname}${rule.pathPrefix}`));
    if (url.pathname !== rule.pathPrefix) reject();
    return { hostname: url.hostname, pathPrefix: url.pathname };
  });
  return { ...policy, rules, acceptedContentTypes: [...new Set(policy.acceptedContentTypes)] };
}

export function assertAllowedSourceUrl(value: string, policy: NetworkPolicy): string {
  const normalized = normalizeSourceUrl(value);
  const url = new URL(normalized);
  if (!policy.rules.some((rule) => rule.hostname === url.hostname && (
    rule.pathPrefix === "/" || url.pathname === rule.pathPrefix ||
    url.pathname.startsWith(rule.pathPrefix.endsWith("/") ? rule.pathPrefix : `${rule.pathPrefix}/`)
  ))) reject();
  return normalized;
}

/** Deny reserved, local, metadata and non-global IP ranges. DNS must return only public answers. */
export function isPublicAddress(value: string): boolean {
  const ip = value.toLowerCase();
  if (isIP(ip) === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(ip) === 6) {
    // Accept global-unicast 2000::/3 only; deny transition/translation and documentation ranges.
    if (ip.includes(".")) return false;
    const halves = ip.split("::");
    const left = halves[0] ? halves[0].split(":").map((part) => parseInt(part, 16)) : [];
    const right = halves[1] ? halves[1].split(":").map((part) => parseInt(part, 16)) : [];
    const words = halves.length === 1 ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
    const [first, second] = words;
    if (first < 0x2000 || first > 0x3fff || ip.includes(".")) return false;
    if (first === 0x2002 || first === 0x3fff || (first === 0x2001 && (second < 0x0200 || second === 0x0db8))) return false;
    return true;
  }
  return false;
}

export interface PublicDnsPort {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
}

export interface PinnedFetchRequest {
  readonly url: string;
  readonly hostname: string;
  readonly connectAddress: string;
  readonly resolvedAddresses: readonly string[];
  readonly maxBytes: number;
  readonly acceptedContentTypes: readonly string[];
  readonly signal: AbortSignal;
}

export interface PinnedFetchResponse {
  readonly status: number;
  readonly connectedAddress: string;
  readonly contentType: string;
  readonly body: string;
  readonly location?: string;
}

/** Adapter MUST pin the TCP connection to connectAddress, use hostname for TLS/SNI,
 * disable automatic redirects, send no ambient cookies/credentials, enforce maxBytes
 * while streaming, honor signal, and never execute page scripts. There is no native
 * unrestricted fetch fallback. */
export interface PinnedFetchPort {
  request(input: PinnedFetchRequest): Promise<PinnedFetchResponse>;
}

export interface RestrictedFetchResult {
  readonly finalUrl: string;
  readonly contentType: string;
  readonly body: string;
  readonly redirectCount: number;
}

export async function fetchApprovedSource(input: {
  readonly url: string;
  readonly policy: NetworkPolicy;
  readonly dns: PublicDnsPort;
  readonly transport: PinnedFetchPort;
  readonly signal?: AbortSignal;
}): Promise<RestrictedFetchResult> {
  const policy = normalizeNetworkPolicy(input.policy);
  const controller = new AbortController();
  let rejectCancellation: ((error: DomainError) => void) | undefined;
  const cancellation = new Promise<never>((_, rejectCancelled) => { rejectCancellation = rejectCancelled; });
  const onAbort = () => {
    controller.abort(input.signal?.reason);
    rejectCancellation?.(new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 }));
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new DomainError("FETCH_TIMEOUT", "来源获取超时，可按任务规则重试。", { status: 503 }));
    }, policy.timeoutMs);
  });
  const operation = (async () => {
    let currentUrl = assertAllowedSourceUrl(input.url, policy);
    for (let count = 0; ; count += 1) {
      if (controller.signal.aborted) throw new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });
      const hostname = new URL(currentUrl).hostname;
      const addresses = await input.dns.resolve(hostname, controller.signal);
      if (controller.signal.aborted) throw new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });
      if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) reject();
      const response = await input.transport.request({ url: currentUrl, hostname, connectAddress: addresses[0], resolvedAddresses: addresses, maxBytes: policy.maxBytes, acceptedContentTypes: policy.acceptedContentTypes, signal: controller.signal });
      if (controller.signal.aborted) throw new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });
      if (!isPublicAddress(response.connectedAddress) || !addresses.includes(response.connectedAddress)) reject();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || count >= policy.maxRedirects) throw new DomainError("FETCH_REDIRECT_LIMIT", "来源重定向超出批准范围或次数。", { status: 422 });
        currentUrl = assertAllowedSourceUrl(new URL(response.location, currentUrl).toString(), policy);
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new DomainError("FETCH_ACCESS_DENIED", "来源限制访问，需要人工核查。", { status: 422 });
      if (response.status === 429) throw new DomainError("FETCH_RATE_LIMITED", "来源限制请求频率，请稍后重试。", { status: 429 });
      if (response.status >= 500) throw new DomainError("FETCH_UNAVAILABLE", "来源暂时不可用。", { status: 503 });
      if (response.status < 200 || response.status >= 300) throw new DomainError("FETCH_FAILED", "来源未返回可用内容。", { status: 422 });
      const contentType = response.contentType.split(";")[0].trim().toLowerCase();
      if (!policy.acceptedContentTypes.includes(contentType) || new TextEncoder().encode(response.body).byteLength > policy.maxBytes) throw new DomainError("FETCH_RESPONSE_REJECTED", "来源内容类型或大小超出批准范围。", { status: 422 });
      return { finalUrl: currentUrl, body: response.body, contentType, redirectCount: count };
    }
  })();
  try { return await Promise.race([operation, timeout, cancellation]); }
  finally { if (timer !== undefined) clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); }
}
