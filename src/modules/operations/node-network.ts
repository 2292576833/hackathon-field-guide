import { lookup as lookupDns } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { DomainError } from "../../shared/errors.ts";
import { isPublicAddress, normalizeSourceUrl } from "./network-policy.ts";
import { createPinnedProxyAgent, normalizeNodeProxyUrl } from "./node-proxy-transport.ts";
export { normalizeNodeProxyUrl } from "./node-proxy-transport.ts";
import type { PinnedFetchPort, PinnedFetchRequest, PinnedFetchResponse, PublicDnsPort } from "./network-policy.ts";

export type NodeDnsLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly { address: string; family: number }[]>;
export type NodeHttpsRequest = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
export interface NodeNetworkOptions {
  /** Identifies the crawler; no cookies, authorization or ambient headers are accepted. */
  readonly userAgent: string;
  /** Explicit trusted loopback HTTP CONNECT proxy; never read from ambient configuration. */
  readonly proxyUrl?: string;
  /** Optional low-level seams for isolated tests; defaults perform real OS DNS and HTTPS. */
  readonly lookup?: NodeDnsLookup;
  readonly request?: NodeHttpsRequest;
}
const cancelled = () => new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });
const unsafe = () => new DomainError("UNSAFE_SOURCE_URL", "来源地址不符合已批准的公开网络范围。", { status: 422 });
const rejected = () => new DomainError("FETCH_RESPONSE_REJECTED", "来源内容类型、编码或大小超出批准范围。", { status: 422 });
const unavailable = () => new DomainError("FETCH_UNAVAILABLE", "公开来源网络连接失败，请稍后重试。", { status: 503 });

/** Canonicalize socket addresses for comparison only; never use mapped IPv6 DNS answers. */
function canonicalAddress(value: string): string {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return "";
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  if (canonical.startsWith("::ffff:")) {
    const tail = canonical.slice(7).split(":");
    if (tail.length === 2) {
      const high = parseInt(tail[0], 16), low = parseInt(tail[1], 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return canonical;
}

function validateRequest(input: PinnedFetchRequest): URL {
  const url = new URL(normalizeSourceUrl(input.url));
  if (url.hostname !== input.hostname || !isPublicAddress(input.connectAddress) ||
      !input.resolvedAddresses.length || input.resolvedAddresses.some((address) => !isPublicAddress(address)) ||
      !input.resolvedAddresses.includes(input.connectAddress) || !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 || input.maxBytes > 2_097_152 || !input.acceptedContentTypes.length ||
      input.acceptedContentTypes.some((type) => !["text/html", "text/plain", "application/json"].includes(type))) throw unsafe();
  return url;
}

/** Pin a new TLS connection per request; TLS still verifies the approved hostname. */
export function createNodeNetworkPorts(options: NodeNetworkOptions): { readonly dns: PublicDnsPort; readonly transport: PinnedFetchPort } {
  if (typeof options.userAgent !== "string" || !options.userAgent.trim() || options.userAgent.length > 256 || /[^\x20-\x7e]/.test(options.userAgent)) {
    throw new DomainError("INVALID_CRAWLER_CONFIG", "采集器需要有效的公开 User-Agent 标识。");
  }
  const lookup = options.lookup ?? ((hostname, lookupOptions) => lookupDns(hostname, lookupOptions));
  const request = options.request ?? httpsRequest;
  const proxyUrl = options.proxyUrl === undefined ? undefined : normalizeNodeProxyUrl(options.proxyUrl);
  const dns: PublicDnsPort = {
    resolve(hostname, signal) {
      if (signal.aborted) return Promise.reject(cancelled());
      if (new URL(normalizeSourceUrl(`https://${hostname}/`)).hostname !== hostname) return Promise.reject(unsafe());
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: DomainError | null, addresses?: readonly string[]) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve(addresses ?? []);
        };
        const onAbort = () => finish(cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })).then((answers) => {
          const addresses = [...new Set(answers.map((answer) => answer.address))];
          if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) finish(unsafe());
          else {
            // Validate every answer before ordering: a private AAAA/A must never be
            // hidden by a usable public IPv4. Keep IPv6 for IPv6-only hosts while
            // avoiding an unreachable first AAAA on otherwise working dual-stack hosts.
            addresses.sort((a, b) => (isIP(a) === 4 ? 0 : 1) - (isIP(b) === 4 ? 0 : 1));
            finish(null, addresses);
          }
        }, () => finish(unavailable()));
      });
    },
  };
  const transport: PinnedFetchPort = {
    async request(input) {
      const url = validateRequest(input);
      if (input.signal.aborted) return Promise.reject(cancelled());
      const proxy = proxyUrl ? createPinnedProxyAgent({ proxyUrl, targetAddress: input.connectAddress,
        targetHostname: input.hostname, signal: input.signal }) : undefined;
      return new Promise((resolve, reject) => {
        let settled = false;
        let outgoing: ClientRequest | undefined;
        let incoming: IncomingMessage | undefined;
        const finish = (error: DomainError | null, result?: PinnedFetchResponse, discardBody = false) => {
          if (settled) return;
          settled = true;
          input.signal.removeEventListener("abort", onAbort);
          proxy?.close();
          if (error || discardBody) {
            // Keep error listeners in place: destroy may emit asynchronously after rejection.
            incoming?.destroy();
            outgoing?.destroy();
          }
          if (error) reject(error); else resolve(result!);
        };
        const onAbort = () => finish(cancelled());
        input.signal.addEventListener("abort", onAbort, { once: true });
        if (input.signal.aborted) { onAbort(); return; }
        const onResponse = (response: IncomingMessage) => {
          incoming = response;
          // HTTPS provides an authenticated socket, but verify actual peer IP before reading data.
          const remote = response.socket.remoteAddress ?? "";
          const connected = proxy ? (proxy.acceptsSocket(response.socket) ? input.connectAddress : "") : canonicalAddress(remote);
          if (settled || !isPublicAddress(connected) || connected !== canonicalAddress(input.connectAddress)) {
            response.on("error", () => {});
            response.destroy();
            finish(unsafe());
            return;
          }
          const status = response.statusCode ?? 0;
          const contentType = response.headers["content-type"] ?? "";
          // A missing robots file is decided by its authenticated status, not its error page.
          // Stop the unneeded body before length/stream checks; all peer checks above still apply.
          if (url.pathname === "/robots.txt" && (status === 404 || status === 410)) {
            response.on("error", () => finish(unavailable()));
            finish(null, { status, connectedAddress: input.connectAddress, contentType, body: "",
              ...(response.headers.location ? { location: response.headers.location } : {}) }, true);
            return;
          }
          const contentEncoding = response.headers["content-encoding"];
          const length = response.headers["content-length"];
          const mime = contentType.split(";")[0].trim().toLowerCase();
          const charset = contentType.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
          const declaredCharset = (charset?.[1] ?? charset?.[2])?.toLowerCase();
          if ((status >= 200 && status < 300 && (!input.acceptedContentTypes.includes(mime) ||
              (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") ||
              (declaredCharset !== undefined && !["utf-8", "utf8", "us-ascii"].includes(declaredCharset)))) ||
              (length !== undefined && (!/^\d+$/.test(length) || Number(length) > input.maxBytes))) {
            response.on("error", () => {});
            finish(rejected());
            return;
          }
          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            receivedBytes += bytes.byteLength;
            if (receivedBytes > input.maxBytes) { finish(rejected()); return; }
            chunks.push(bytes);
          });
          response.on("error", () => finish(unavailable()));
          response.on("aborted", () => finish(unavailable()));
          response.on("close", () => { if (!response.complete && !settled) finish(unavailable()); });
          response.on("end", () => {
            if (input.signal.aborted) { finish(cancelled()); return; }
            if (!response.complete) { finish(unavailable()); return; }
            const bytes = Buffer.concat(chunks, receivedBytes);
            let body: string;
            try {
              body = status >= 200 && status < 300 ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("utf8");
            } catch { finish(rejected()); return; }
            finish(null, {
              status, connectedAddress: input.connectAddress, contentType,
              body,
              ...(response.headers.location ? { location: response.headers.location } : {}),
            });
          });
        };
        try {
          outgoing = request({
            protocol: "https:", hostname: input.hostname, port: 443,
            method: "GET", path: `${url.pathname}${url.search}`,
            servername: input.hostname, rejectUnauthorized: true,
            // No pool, ambient proxy, redirect following, credentials or caller headers.
            agent: proxy?.agent ?? false, family: isIP(input.connectAddress),
            lookup: (_hostname, _lookupOptions, callback) => callback(null, input.connectAddress, isIP(input.connectAddress)),
            headers: { "User-Agent": options.userAgent, Accept: input.acceptedContentTypes.join(", "), "Accept-Encoding": "identity" },
            maxHeaderSize: 16_384,
          }, onResponse);
          outgoing.on("error", () => finish(input.signal.aborted ? cancelled() : unavailable()));
          if (settled) outgoing.destroy(); else outgoing.end();
        } catch { finish(unavailable()); }
      });
    },
  };
  return { dns, transport };
}
