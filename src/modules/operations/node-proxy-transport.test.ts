import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { createPinnedProxyAgent, normalizeNodeProxyUrl } from "./node-proxy-transport.ts";

function fixture(input: { status?: number; peer?: string; port?: number; head?: Buffer; headers?: Record<string, string | undefined>; authorized?: boolean; holdConnect?: boolean; holdTls?: boolean; targetAddress?: string } = {}) {
  const signal = new AbortController();
  const outgoing = new EventEmitter() as EventEmitter & { destroyed: boolean; end(): void; destroy(): void };
  outgoing.destroyed = false;
  outgoing.destroy = () => { outgoing.destroyed = true; };
  const tunnel = Object.assign(new PassThrough(), { remoteAddress: input.peer ?? "127.0.0.1", remotePort: input.port ?? 22321 });
  const secured = Object.assign(new PassThrough(), { remoteAddress: input.peer ?? "127.0.0.1", remotePort: input.port ?? 22321, authorized: input.authorized ?? true });
  let connectOptions: RequestOptions | undefined;
  let tlsOptions: ConnectionOptions | undefined;
  const proxy = createPinnedProxyAgent({ proxyUrl: "http://127.0.0.1:22321", targetAddress: input.targetAddress ?? "93.184.216.34",
    targetHostname: "events.hackathon.dev", signal: signal.signal,
    request(options) {
      connectOptions = options;
      outgoing.end = () => { if (!input.holdConnect) queueMicrotask(() => outgoing.emit("connect",
        { statusCode: input.status ?? 200, headers: input.headers ?? {} } as IncomingMessage,
        tunnel as unknown as Socket, input.head ?? Buffer.alloc(0))); };
      return outgoing as unknown as ClientRequest;
    },
    connectTls(options) { tlsOptions = options; if (!input.holdTls) queueMicrotask(() => secured.emit("secureConnect")); return secured as unknown as TLSSocket; },
  });
  const open = () => new Promise<TLSSocket>((resolve, reject) => proxy.agent.createConnection({}, (error, stream) => error ? reject(error) : resolve(stream as TLSSocket)));
  return { proxy, signal, open, outgoing, tunnel, secured, connectOptions: () => connectOptions, tlsOptions: () => tlsOptions };
}

test("only explicit credential-free loopback HTTP proxy URLs are accepted", () => {
  assert.equal(normalizeNodeProxyUrl("http://127.0.0.1:22321/"), "http://127.0.0.1:22321");
  assert.equal(normalizeNodeProxyUrl("http://[::1]:8080"), "http://[::1]:8080");
  assert.equal(normalizeNodeProxyUrl("http://127.0.0.1:80"), "http://127.0.0.1:80");
  for (const value of ["http://1.1.1.1:8080", "http://10.0.0.1:8080", "http://192.168.1.1:8080", "http://169.254.169.254:80",
    "http://127.0.0.2:8080", "http://[::ffff:127.0.0.1]:8080", "http://localhost:8080", "https://127.0.0.1:8080",
    "http://user:secret@127.0.0.1:8080", "http://127.0.0.1:8080?token=x", "http://127.0.0.1:8080#x",
    "http://127.0.0.1:8080/path", "http://127.0.0.1:8080//", "http://127.0.0.1:0", "http://127.0.0.1:65536",
    "http://127.0.0.1", "http://127.0.0.1:0080", " http://127.0.0.1:8080"]) {
    assert.throws(() => normalizeNodeProxyUrl(value), { code: "INVALID_CRAWLER_CONFIG" });
  }
});

test("CONNECT pins exact approved IPv4 and TLS verifies the source hostname without proxy credentials", async () => {
  const f = fixture();
  try {
    const socket = await f.open();
    const connect = f.connectOptions()!;
    assert.equal(connect.hostname, "127.0.0.1"); assert.equal(connect.port, 22321);
    assert.equal(connect.method, "CONNECT"); assert.equal(connect.path, "93.184.216.34:443");
    assert.deepEqual(connect.headers, { Host: "93.184.216.34:443" });
    assert.equal(connect.agent, false); assert.equal(connect.maxHeaderSize, 8192);
    const tls = f.tlsOptions()!;
    assert.equal(tls.socket, f.tunnel); assert.equal(tls.host, "events.hackathon.dev");
    assert.equal(tls.servername, "events.hackathon.dev"); assert.equal(tls.rejectUnauthorized, true);
    assert.deepEqual(tls.ALPNProtocols, ["http/1.1"]);
    assert.equal(f.proxy.acceptsSocket(socket), true);
    assert.equal(f.proxy.acceptsSocket(f.tunnel), false);
    assert.equal(f.proxy.acceptsSocket({ remoteAddress: "127.0.0.1", remotePort: 22321 }), false);
  } finally { f.proxy.close(); }
  assert.equal(f.tunnel.destroyed, true); assert.equal(f.secured.destroyed, true);
  assert.equal(f.proxy.acceptsSocket(f.secured), false);
});

test("IPv6 CONNECT authority uses brackets and never asks the proxy to resolve the target domain", async () => {
  const f = fixture({ targetAddress: "2606:4700:4700::1111" });
  try { await f.open(); assert.equal(f.connectOptions()!.path, "[2606:4700:4700::1111]:443");
    assert.deepEqual(f.connectOptions()!.headers, { Host: "[2606:4700:4700::1111]:443" });
  } finally { f.proxy.close(); }
  assert.throws(() => createPinnedProxyAgent({ proxyUrl: "http://127.0.0.1:22321", targetAddress: "10.0.0.1",
    targetHostname: "events.hackathon.dev", signal: new AbortController().signal }), { code: "UNSAFE_SOURCE_URL" });
});

test("non-200, unsolicited body and framing headers reject CONNECT before any target TLS", async () => {
  for (const scenario of [{ status: 407 }, { status: 302 }, { head: Buffer.from("body") },
    { headers: { "content-length": "1" } }, { headers: { "transfer-encoding": "chunked" } }]) {
    const f = fixture(scenario);
    await assert.rejects(f.open(), { code: "FETCH_RESPONSE_REJECTED" });
    assert.equal(f.tlsOptions(), undefined); assert.equal(f.tunnel.destroyed, true); assert.equal(f.outgoing.destroyed, true);
  }
});

test("the configured loopback address and port are checked before target TLS", async () => {
  for (const scenario of [{ peer: "1.1.1.1" }, { peer: "10.0.0.1" }, { peer: "::1" }, { port: 22322 }]) {
    const f = fixture(scenario); await assert.rejects(f.open(), { code: "UNSAFE_SOURCE_URL" });
    assert.equal(f.tlsOptions(), undefined); assert.equal(f.tunnel.destroyed, true);
  }
});

test("unverified target TLS and handshake errors are never accepted as a successful tunnel", async () => {
  const untrusted = fixture({ authorized: false });
  await assert.rejects(untrusted.open(), { code: "UNSAFE_SOURCE_URL" });
  assert.equal(untrusted.secured.destroyed, true);
  const handshake = fixture({ holdTls: true });
  const pending = handshake.open(); await new Promise<void>(resolve => setImmediate(resolve));
  handshake.secured.emit("error", new Error("untrusted provider text must not leak"));
  await assert.rejects(pending, { code: "FETCH_UNAVAILABLE" });
  assert.equal(handshake.tunnel.destroyed, true);
});

test("abort before CONNECT, while connecting, during TLS and after TLS closes every owned resource", async () => {
  const pre = fixture(); pre.signal.abort(); await assert.rejects(pre.open(), { code: "FETCH_CANCELLED" }); assert.equal(pre.connectOptions(), undefined);
  for (const scenario of [{ holdConnect: true }, { holdTls: true }]) {
    const f = fixture(scenario); const pending = f.open(); await new Promise<void>(resolve => setImmediate(resolve)); f.signal.abort();
    await assert.rejects(pending, { code: "FETCH_CANCELLED" }); assert.equal(f.outgoing.destroyed, true);
    if (f.tlsOptions()) assert.equal(f.secured.destroyed, true);
  }
  const ready = fixture(); await ready.open(); ready.signal.abort();
  assert.equal(ready.tunnel.destroyed, true); assert.equal(ready.secured.destroyed, true);
});

test("CONNECT transport errors expose only a safe domain error and clean up", async () => {
  const f = fixture({ holdConnect: true }); const pending = f.open();
  f.outgoing.emit("error", new Error("password=private-untrusted-text"));
  await assert.rejects(pending, error => (error as { code: string }).code === "FETCH_UNAVAILABLE" && !(error as Error).message.includes("private"));
  assert.equal(f.outgoing.destroyed, true);
});

test("real HTTP CONNECT parser rejects oversized headers without starting target TLS", async () => {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => socket.write(`HTTP/1.1 200 Connection Established\r\nX-Padding: ${"x".repeat(9000)}\r\n\r\n`));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let tlsCalls = 0;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2000);
  const port = (server.address() as { port: number }).port;
  const proxy = createPinnedProxyAgent({ proxyUrl: `http://127.0.0.1:${port}`, targetAddress: "93.184.216.34",
    targetHostname: "events.hackathon.dev", signal: controller.signal, connectTls() { tlsCalls += 1; throw Error("must not start TLS"); } });
  try {
    await assert.rejects(new Promise((resolve, reject) => proxy.agent.createConnection({}, (error, stream) => error ? reject(error) : resolve(stream))), { code: "FETCH_UNAVAILABLE" });
    assert.equal(tlsCalls, 0);
  } finally { clearTimeout(timer); proxy.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
