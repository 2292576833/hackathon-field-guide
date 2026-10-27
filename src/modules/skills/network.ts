import { request as httpRequest } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
/** HTTPS CONNECT through an explicitly selected proxy, with normal target TLS validation. */
export async function proxyRequest(input: { url: string; proxyUrl: string; method: string; headers?: Record<string, string>; body?: string; maxBytes: number }): Promise<{ bytes: Uint8Array; status: number }> {
  const target = new URL(input.url); const proxy = new URL(input.proxyUrl);
  if (target.protocol !== "https:" || !["http:", "https:"].includes(proxy.protocol)) throw new Error("只允许 HTTPS 目标与 HTTP(S) 代理。");
  const agent = new HttpsAgent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    let settled = false; const finish = (error: Error | null, socket?: Duplex) => { if (settled) return; settled = true; callback?.(error, socket as Duplex); };
    const connectHeaders: Record<string, string> = { Host: `${target.hostname}:${target.port || "443"}` };
    if (proxy.username || proxy.password) connectHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const tunnel = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80), method: "CONNECT", path: `${target.hostname}:${target.port || "443"}`, headers: connectHeaders, timeout: 15_000 });
    tunnel.on("timeout", () => tunnel.destroy(new Error("代理连接超时。")));
    tunnel.on("error", error => finish(error));
    tunnel.on("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) { socket.destroy(); finish(new Error("代理拒绝连接。")); return; }
      const secured = tlsConnect({ socket, servername: target.hostname, rejectUnauthorized: true });
      secured.setTimeout(30_000, () => secured.destroy(new Error("安全连接超时。")));
      secured.on("error", error => finish(error)); secured.once("secureConnect", () => finish(null, secured));
    }); tunnel.end(); return undefined;
  };
  try { return await new Promise((resolveRequest, reject) => {
    const request = httpsRequest(target, { agent, method: input.method, headers: input.headers, timeout: 30_000 }, response => {
      const chunks: Uint8Array[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > input.maxBytes) { response.destroy(new Error("代理响应超过限制。")); return; } chunks.push(chunk); });
      response.on("error", reject); response.on("end", () => resolveRequest({ bytes: Buffer.concat(chunks), status: response.statusCode ?? 502 }));
    }); request.on("error", reject); request.on("timeout", () => request.destroy(new Error("网络请求超时。"))); request.end(input.body);
  }); } finally { agent.destroy(); }
}
