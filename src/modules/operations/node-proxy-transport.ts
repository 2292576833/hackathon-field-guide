import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { Agent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { DomainError } from "../../shared/errors.ts";
import { isPublicAddress } from "./network-policy.ts";

const invalid = () => new DomainError("INVALID_CRAWLER_CONFIG", "来源代理必须是显式配置的本机 HTTP CONNECT 地址。", { status: 422 });
const unavailable = () => new DomainError("FETCH_UNAVAILABLE", "公开来源代理连接失败，请稍后重试。", { status: 503 });
const unsafe = () => new DomainError("UNSAFE_SOURCE_URL", "来源代理连接未通过固定地址校验。", { status: 422 });
const rejected = () => new DomainError("FETCH_RESPONSE_REJECTED", "来源代理返回了不受支持的 CONNECT 响应。", { status: 422 });
const cancelled = () => new DomainError("FETCH_CANCELLED", "本次来源获取已停止。", { status: 409 });

/** No ambient proxy configuration, DNS aliases, credentials, path or query. */
export function normalizeNodeProxyUrl(value: string): string {
  if (typeof value !== "string" || !/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/.test(value)) throw invalid();
  const match = value.match(/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/)!;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port > 65535) throw invalid();
  return `http://${match[1]}:${port}`;
}

export type NodeConnectRequest = (options: HttpRequestOptions) => ClientRequest;
export type NodeTunnelTlsConnect = (options: ConnectionOptions) => TLSSocket;
export interface PinnedProxyAgentOptions {
  readonly proxyUrl: string;
  readonly targetAddress: string;
  readonly targetHostname: string;
  readonly signal: AbortSignal;
  /** Isolated low-level protocol seams; production uses Node HTTP and TLS. */
  readonly request?: NodeConnectRequest;
  readonly connectTls?: NodeTunnelTlsConnect;
}

function matchesPeer(socket: { readonly remoteAddress?: string; readonly remotePort?: number }, hostname: string, port: number): boolean {
  const address = socket.remoteAddress;
  return socket.remotePort === port && (address === hostname ||
    (hostname === "127.0.0.1" && (address === "::ffff:127.0.0.1" || address === "::ffff:7f00:1")) ||
    (hostname === "::1" && address === "0:0:0:0:0:0:0:1"));
}

/** A new non-pooled tunnel per approved request. The physical peer is the
 * configured loopback proxy, not the destination. Destination-IP proof is the
 * exact CONNECT authority plus verified target-host TLS; this explicitly relies
 * on a trusted local proxy forwarding that authority correctly. */
export function createPinnedProxyAgent(options: PinnedProxyAgentOptions): {
  readonly agent: Agent;
  acceptsSocket(socket: unknown): boolean;
  close(): void;
} {
  const proxyUrl = new URL(normalizeNodeProxyUrl(options.proxyUrl));
  const proxyHostname = proxyUrl.hostname === "[::1]" ? "::1" : proxyUrl.hostname;
  const proxyPort = Number(proxyUrl.port || "80");
  if (!isPublicAddress(options.targetAddress) || !options.targetHostname || isIP(options.targetHostname) ||
      /[^a-z0-9.-]/i.test(options.targetHostname)) throw unsafe();
  const authority = isIP(options.targetAddress) === 6 ? `[${options.targetAddress}]:443` : `${options.targetAddress}:443`;
  const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
  const proof = new WeakSet<object>();
  const request = options.request ?? ((requestOptions) => httpRequest(requestOptions));
  const connectTls = options.connectTls ?? ((connectionOptions) => tlsConnect(connectionOptions));
  let connectRequest: ClientRequest | undefined;
  let tunnel: Socket | undefined;
  let secured: TLSSocket | undefined;
  let started = false;
  let closed = false;
  let settled = false;
  let connectionCallback: ((error: Error | null, stream: Duplex) => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", onAbort);
    connectRequest?.destroy();
    secured?.destroy();
    tunnel?.destroy();
    agent.destroy();
  };
  const finish = (error: Error | null, socket?: TLSSocket) => {
    if (settled) return;
    settled = true;
    if (error) close();
    connectionCallback?.(error, socket as Duplex);
  };
  const onAbort = () => { if (!settled) finish(cancelled()); else close(); };
  agent.createConnection = (_requestOptions, callback) => {
    if (started || !callback) throw unavailable();
    started = true;
    connectionCallback = callback;
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) { finish(cancelled()); return undefined; }
    try {
      connectRequest = request({ protocol: "http:", hostname: proxyHostname, port: proxyPort,
        method: "CONNECT", path: authority, agent: false, family: isIP(proxyHostname),
        lookup: (_hostname, _lookupOptions, done) => done(null, proxyHostname, isIP(proxyHostname)),
        headers: { Host: authority }, maxHeaderSize: 8192 });
      connectRequest.on("error", () => finish(options.signal.aborted ? cancelled() : unavailable()));
      connectRequest.on("response", (response: IncomingMessage) => { response.destroy(); finish(rejected()); });
      connectRequest.on("connect", (response: IncomingMessage, socket: Socket, head: Buffer) => {
        if (settled || closed) { socket.destroy(); return; }
        tunnel = socket;
        socket.on("error", () => finish(unavailable()));
        socket.on("close", () => { if (!settled) finish(unavailable()); });
        if (!matchesPeer(socket, proxyHostname, proxyPort)) { finish(unsafe()); return; }
        if (response.statusCode !== 200 || head.length || response.headers["transfer-encoding"] !== undefined ||
            (response.headers["content-length"] !== undefined && response.headers["content-length"] !== "0")) {
          finish(rejected()); return;
        }
        try {
          secured = connectTls({ socket, host: options.targetHostname, servername: options.targetHostname,
            rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
          secured.on("error", () => finish(unavailable()));
          secured.on("close", () => { if (!settled) finish(unavailable()); });
          secured.once("secureConnect", () => {
            if (settled || closed) return;
            if (options.signal.aborted) { finish(cancelled()); return; }
            if (!secured!.authorized || !matchesPeer(secured!, proxyHostname, proxyPort)) { finish(unsafe()); return; }
            proof.add(secured!);
            finish(null, secured);
          });
        } catch { finish(unavailable()); }
      });
      connectRequest.end();
    } catch { finish(unavailable()); }
    return undefined;
  };
  return { agent, close, acceptsSocket(socket) {
    return !closed && !!socket && typeof socket === "object" && proof.has(socket) &&
      matchesPeer(socket as TLSSocket, proxyHostname, proxyPort);
  } };
}
