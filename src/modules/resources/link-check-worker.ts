import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { resourceUrl } from "./domain.ts";

export interface ResourceLinkResponse { readonly statusCode: number; readonly location: string | null }
export interface ResourceLinkTransport { head(url: string, signal: AbortSignal): Promise<ResourceLinkResponse> }
export interface ResourceLinkCheck {
  readonly url: string;
  readonly finalUrl: string;
  readonly checkedAt: string;
  readonly status: "available" | "unreachable" | "unknown";
  readonly httpStatus: number | null;
  readonly reason: "http_success" | "http_not_found" | "http_restricted" | "head_unsupported" | "redirect_not_approved" | "redirect_limit" | "request_timeout" | "network_error" | "network_address_blocked" | "http_other";
}
export interface ResourceLinkCheckWorkerDependencies {
  /** Server-owned exact URLs, never derived from a user request or model output. */
  readonly approvedUrls: readonly string[];
  readonly clock: Clock;
  readonly transport?: ResourceLinkTransport;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}
function approvedHttpsUrl(value: string): string {
  const url = new URL(resourceUrl(value));
  if (url.protocol !== "https:" || url.port && url.port !== "443" || isIP(url.hostname) !== 0 || url.hostname === "localhost" || !url.hostname.includes(".")) {
    throw new DomainError("RESOURCE_CHECK_URL_NOT_ALLOWED", "活性检查仅支持审批的域名 HTTPS 入口和标准端口。");
  }
  return url.href;
}
/** Conservative IPv4 public-address allow rule; IPv6-only sites remain unknown. */
export function isPublicResourceCheckIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { work.catch(() => undefined); reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Executable HTTP adapter: DNS-pinned public IPv4, hostname TLS validation, HEAD only. */
export function createNodeResourceLinkTransport(): ResourceLinkTransport {
  return {
    async head(value, signal) {
      const url = new URL(approvedHttpsUrl(value));
      const addresses = await abortable(lookup(url.hostname, {all: true, family: 4}), signal);
      if (!addresses.length || addresses.some(address => !isPublicResourceCheckIpv4(address.address))) {
        throw new DomainError("RESOURCE_NETWORK_ADDRESS_BLOCKED", "检查目标未解析为允许的公网地址。");
      }
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const operation = request({
          hostname: addresses[0].address, family: 4, port: 443, servername: url.hostname,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
          rejectUnauthorized: true, method: "HEAD", path: `${url.pathname}${url.search}`, signal,
          agent: false, maxHeaderSize: 16384,
          headers: {Host: url.host, "User-Agent": "HackathonFieldGuide/0.1 resource-link-check", Accept: "text/html,application/json;q=0.8,*/*;q=0.1"},
        }, response => {
          const result = {statusCode: response.statusCode ?? 0, location: typeof response.headers.location === "string" ? response.headers.location : null};
          // Do not collect, decode or save a response body, and never execute page scripts.
          response.destroy();
          resolve(result);
        });
        operation.once("error", reject);
        operation.end();
      });
    },
  };
}

export function createResourceLinkCheckWorker(deps: ResourceLinkCheckWorkerDependencies) {
  const approved = new Set(deps.approvedUrls.map(approvedHttpsUrl));
  if (!approved.size || approved.size > 100) throw new DomainError("INVALID_RESOURCE_CHECK_POLICY", "审批 URL 集合需要包含 1 至 100 个入口。");
  const timeoutMs = deps.timeoutMs ?? 8000;
  const maxRedirects = deps.maxRedirects ?? 3;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new DomainError("INVALID_RESOURCE_CHECK_POLICY", "活性检查需要有界超时与跳转次数。");
  const transport = deps.transport ?? createNodeResourceLinkTransport();
  return {
    async check(value: string): Promise<ResourceLinkCheck> {
      const url = approvedHttpsUrl(value);
      if (!approved.has(url)) throw new DomainError("RESOURCE_CHECK_URL_NOT_APPROVED", "该完整 URL 尚未进入活性检查审批清单。", {status: 403});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("resource-link-timeout")), timeoutMs);
      let current = url;
      const result = (status: ResourceLinkCheck["status"], reason: ResourceLinkCheck["reason"], httpStatus: number | null): ResourceLinkCheck =>
        ({url, finalUrl: current, status, reason, httpStatus, checkedAt: deps.clock.now().toISOString()});
      try {
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
          const response = await abortable(transport.head(current, controller.signal), controller.signal);
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.location) {
            let next: string;
            try { next = approvedHttpsUrl(new URL(response.location, current).href); }
            catch { return result("unknown", "redirect_not_approved", response.statusCode); }
            if (!approved.has(next)) return result("unknown", "redirect_not_approved", response.statusCode);
            if (redirects === maxRedirects) return result("unknown", "redirect_limit", response.statusCode);
            current = next;
            continue;
          }
          if (response.statusCode >= 200 && response.statusCode < 300) return result("available", "http_success", response.statusCode);
          if ([404, 410].includes(response.statusCode)) return result("unreachable", "http_not_found", response.statusCode);
          if ([401, 403, 429].includes(response.statusCode)) return result("unknown", "http_restricted", response.statusCode);
          if (response.statusCode === 405) return result("unknown", "head_unsupported", response.statusCode);
          return result("unknown", "http_other", response.statusCode);
        }
        return result("unknown", "redirect_limit", null);
      } catch (error) {
        return result("unknown", controller.signal.aborted ? "request_timeout" : error instanceof DomainError && error.code === "RESOURCE_NETWORK_ADDRESS_BLOCKED" ? "network_address_blocked" : "network_error", null);
      } finally { clearTimeout(timer); }
    },
  };
}
