import { DomainError } from "../../shared/errors.ts";
import { assertAllowedSourceUrl, isPublicAddress, normalizeNetworkPolicy, normalizeSourceUrl } from "./network-policy.ts";
import type { NetworkPolicy, PinnedFetchPort, PublicDnsPort } from "./network-policy.ts";

const MAX_ROBOTS_BYTES = 512 * 1024;
interface RobotsRule { readonly allow: boolean; readonly pattern: string; }
interface RobotsGroup { readonly agents: string[]; readonly rules: RobotsRule[]; }
export interface RobotsCheckResult { readonly status: "allowed" | "missing"; readonly robotsUrl: string; readonly userAgent: string; }
const blocked = () => new DomainError("ROBOTS_DISALLOWED", "该公开来源的 robots.txt 不允许本采集器访问此页面。", { status: 422 });
const unavailable = () => new DomainError("ROBOTS_UNAVAILABLE", "无法可靠读取来源的 robots.txt，采集已停止，请人工核查后重试。", { status: 503 });

/** Use a separate RFC product token, or the first token of ProductToken/version. */
function productToken(userAgent: string): string {
  if (typeof userAgent !== "string" || userAgent.length > 256 || /[\r\n]/.test(userAgent)) throw new DomainError("INVALID_CRAWLER_CONFIG", "采集器 User-Agent 标识无效。");
  const token = userAgent.trim().split(/[\s/]/)[0];
  if (!/^[A-Za-z_-]+$/.test(token)) throw new DomainError("INVALID_CRAWLER_CONFIG", "robots 产品标识只能含英文字母、下划线与连字符。");
  return token.toLowerCase();
}

function normalizedOctets(text: string, pattern: boolean): string {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "%" && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      const byte = parseInt(text.slice(index + 1, index + 3), 16);
      const decoded = String.fromCharCode(byte);
      result += /^[A-Za-z0-9._~-]$/.test(decoded) ? decoded : `%${text.slice(index + 1, index + 3).toUpperCase()}`;
      index += 3;
      continue;
    }
    const codepoint = text.codePointAt(index)!;
    const char = String.fromCodePoint(codepoint);
    if (codepoint > 127 || char === "%" || (!pattern && char === "*") || (char === "$" && (!pattern || index !== text.length - 1))) {
      for (const byte of Buffer.from(char)) result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    } else result += char;
    index += char.length;
  }
  return result;
}

/** Glob matching uses ordered string searches, avoiding attacker-controlled regex backtracking. */
function matchesRule(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const withoutAnchor = anchored ? pattern.slice(0, -1) : pattern;
  const parts = withoutAnchor.split("*");
  if (!path.startsWith(parts[0])) return false;
  if (parts.length === 1) return !anchored || path.length === parts[0].length;
  let offset = parts[0].length;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (anchored && index === parts.length - 1) return path.endsWith(part) && path.length - part.length >= offset;
    const found = path.indexOf(part, offset);
    if (found === -1) return false;
    offset = found + part.length;
  }
  return true;
}

/** RFC 9309 group/rule semantics; unrecognized records never terminate a group. */
export function robotsAllows(body: string, targetUrl: string, userAgent: string): boolean {
  const token = productToken(userAgent);
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_ROBOTS_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(body)) throw unavailable();
  const target = new URL(targetUrl);
  if (target.pathname === "/robots.txt") return true;
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let hasRules = false;
  for (const line of body.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    const clean = line.split("#", 1)[0].trim();
    const colon = clean.indexOf(":");
    if (colon < 0) continue;
    const key = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!/^(?:[A-Za-z_-]+|\*)$/.test(value)) continue;
      if (!current || hasRules) { current = { agents: [], rules: [] }; groups.push(current); hasRules = false; }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      hasRules = true;
      if (!value || !value.startsWith("/") || /[\x00-\x20\x7f]/.test(value)) continue;
      current.rules.push({ allow: key === "allow", pattern: normalizedOctets(value, true) });
    }
  }
  const exact = groups.filter((group) => group.agents.includes(token));
  const matched = exact.length ? exact : groups.filter((group) => group.agents.includes("*"));
  const path = normalizedOctets(`${target.pathname}${target.search}`, false);
  let longest = -1, allowed = true;
  for (const group of matched) for (const rule of group.rules) {
    if (!matchesRule(rule.pattern, path)) continue;
    const specificity = rule.pattern.replace(/\*|\$$/g, "").replace(/%[0-9A-F]{2}/g, "x").length;
    if (specificity > longest || (specificity === longest && rule.allow)) { longest = specificity; allowed = rule.allow; }
  }
  return allowed;
}

/** Fresh check per acquisition. 404/410 permits; auth/rate/network/server/format failures block.
 * Redirects are deliberately stricter than RFC 9309: only the same approved origin's exact
 * /robots.txt is fetchable, with no query, according to the source's redirect budget. */
export async function assertRobotsAllowed(input: {
  readonly sourceUrl: string; readonly policy: NetworkPolicy; readonly dns: PublicDnsPort;
  readonly transport: PinnedFetchPort; readonly userAgent: string; readonly signal?: AbortSignal;
}): Promise<RobotsCheckResult> {
  const policy = normalizeNetworkPolicy(input.policy);
  const approvedSource = new URL(assertAllowedSourceUrl(input.sourceUrl, policy));
  const token = productToken(input.userAgent);
  const initialRobotsUrl = new URL("/robots.txt", approvedSource).toString();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupt = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 })); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    timer = setTimeout(() => { controller.abort(); reject(new DomainError("FETCH_TIMEOUT", "robots.txt 获取超时，采集已停止。", { status: 503 })); }, policy.timeoutMs);
  });
  const operation = (async (): Promise<RobotsCheckResult> => {
    let current = initialRobotsUrl;
    for (let redirects = 0; ; redirects += 1) {
      if (controller.signal.aborted) throw new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });
      const target = new URL(normalizeSourceUrl(current));
      if (target.origin !== approvedSource.origin || target.pathname !== "/robots.txt" || target.search) throw new DomainError("ROBOTS_REDIRECT_REJECTED", "robots.txt 重定向超出同源批准范围。", { status: 422 });
      const addresses = await input.dns.resolve(target.hostname, controller.signal);
      if (controller.signal.aborted) throw new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });
      if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new DomainError("UNSAFE_SOURCE_URL", "来源 DNS 不符合公开网络限制。", { status: 422 });
      const response = await input.transport.request({ url: target.toString(), hostname: target.hostname,
        connectAddress: addresses[0], resolvedAddresses: addresses, maxBytes: Math.min(policy.maxBytes, MAX_ROBOTS_BYTES),
        acceptedContentTypes: ["text/plain"], signal: controller.signal });
      if (!isPublicAddress(response.connectedAddress) || !addresses.includes(response.connectedAddress)) throw new DomainError("UNSAFE_SOURCE_URL", "来源连接地址不符合已批准的 DNS 结果。", { status: 422 });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirects >= policy.maxRedirects) throw new DomainError("ROBOTS_REDIRECT_REJECTED", "robots.txt 重定向超出批准次数。", { status: 422 });
        try { current = new URL(response.location, current).toString(); } catch { throw unavailable(); }
        continue;
      }
      if (response.status === 404 || response.status === 410) return { status: "missing", robotsUrl: initialRobotsUrl, userAgent: token };
      if (response.status === 401 || response.status === 403) throw new DomainError("ROBOTS_ACCESS_DENIED", "来源拒绝访问 robots.txt，采集已停止。", { status: 422 });
      if (response.status === 429) throw new DomainError("FETCH_RATE_LIMITED", "来源限制请求频率，请稍后重试。", { status: 429 });
      if (response.status < 200 || response.status >= 300) throw unavailable();
      if (response.contentType.split(";")[0].trim().toLowerCase() !== "text/plain" || Buffer.byteLength(response.body) > Math.min(policy.maxBytes, MAX_ROBOTS_BYTES)) throw unavailable();
      if (!robotsAllows(response.body, approvedSource.toString(), token)) throw blocked();
      return { status: "allowed", robotsUrl: initialRobotsUrl, userAgent: token };
    }
  })();
  try { return await Promise.race([operation, interrupt]); }
  finally { if (timer !== undefined) clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); }
}
