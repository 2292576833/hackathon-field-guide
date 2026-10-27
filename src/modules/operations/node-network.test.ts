import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { createNodeNetworkPorts } from "./node-network.ts";
import type { NodeHttpsRequest } from "./node-network.ts";
import { fetchApprovedSource } from "./network-policy.ts";
import { assertRobotsAllowed } from "./robots-policy.ts";
import type { PinnedFetchRequest } from "./network-policy.ts";

const controller = () => new AbortController();
const input = (signal = controller().signal): PinnedFetchRequest => ({
  url: "https://events.hackathon.dev/rules?view=public", hostname: "events.hackathon.dev", connectAddress: "93.184.216.34",
  resolvedAddresses: ["93.184.216.34"], maxBytes: 32, acceptedContentTypes: ["text/plain"], signal,
});
function fakeRequest(responseInput: { status?: number; type?: string; address?: string; length?: string; encoding?: string; location?: string; chunks?: readonly Buffer[]; keepOpen?: boolean }) {
  const outgoing = new EventEmitter() as EventEmitter & { destroyed: boolean; end(): void; destroy(): void };
  outgoing.destroyed = false;
  let sentOptions: RequestOptions | undefined;
  let incoming: PassThrough | undefined;
  const request: NodeHttpsRequest = (options, onResponse) => {
    sentOptions = options;
    outgoing.end = () => {
      incoming = new PassThrough();
      Object.assign(incoming, { statusCode: responseInput.status ?? 200,
        headers: { "content-type": responseInput.type ?? "text/plain; charset=utf-8",
          ...(responseInput.length ? { "content-length": responseInput.length } : {}),
          ...(responseInput.encoding ? { "content-encoding": responseInput.encoding } : {}),
          ...(responseInput.location ? { location: responseInput.location } : {}) },
        socket: { remoteAddress: responseInput.address ?? "93.184.216.34" }, complete: false });
      queueMicrotask(() => {
        onResponse(incoming as unknown as IncomingMessage);
        for (const chunk of responseInput.chunks ?? [Buffer.from("public rules")]) incoming!.write(chunk);
        if (!responseInput.keepOpen) { Object.assign(incoming!, { complete: true }); incoming!.end(); }
      });
    };
    outgoing.destroy = () => { outgoing.destroyed = true; incoming?.destroy(); };
    return outgoing as unknown as ClientRequest;
  };
  return { request, outgoing, options: () => sentOptions, response: () => incoming };
}

test("real HTTPS adapter pins lookup and preserves TLS hostname; uses only explicit public headers", async () => {
  const stub = fakeRequest({});
  const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot/1.0", request: stub.request });
  const result = await transport.request(input());
  assert.equal(result.body, "public rules");
  assert.equal(result.connectedAddress, "93.184.216.34");
  const options = stub.options()!;
  assert.equal(options.hostname, "events.hackathon.dev");
  assert.equal(options.servername, "events.hackathon.dev");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.family, 4);
  assert.equal(options.path, "/rules?view=public");
  assert.deepEqual(Object.keys(options.headers!).sort(), ["Accept", "Accept-Encoding", "User-Agent"]);
  assert.equal((options.headers as Record<string, string>)["Accept-Encoding"], "identity");
  await new Promise<void>((resolve) => options.lookup!("ignored.invalid", {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4); resolve();
  }));
});

test("adapter fails before any socket request for private, mixed DNS and hostname mismatch", async () => {
  let requests = 0;
  const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: () => { requests += 1; throw Error("must not connect"); } });
  for (const override of [{ connectAddress: "127.0.0.1", resolvedAddresses: ["127.0.0.1"] },
    { resolvedAddresses: ["93.184.216.34", "10.0.0.1"] }, { hostname: "another.hackathon.dev" },
    { resolvedAddresses: ["1.1.1.1"] }]) {
    await assert.rejects(async () => transport.request({ ...input(), ...override }), { code: "UNSAFE_SOURCE_URL" });
  }
  assert.equal(requests, 0);
});

test("stream bytes, advertised length, rejected MIME and compressed bodies terminate the socket", async () => {
  for (const scenario of [{ chunks: [Buffer.from("a".repeat(20)), Buffer.from("b".repeat(20))] },
    { length: "33" }, { type: "text/html" }, { encoding: "gzip" }]) {
    const stub = fakeRequest(scenario);
    const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
    await assert.rejects(transport.request(input()), { code: "FETCH_RESPONSE_REJECTED" });
    assert.equal(stub.outgoing.destroyed, true);
  }
});

test("stream limit counts UTF-8 bytes rather than characters", async () => {
  const stub = fakeRequest({ chunks: [Buffer.from("规则"), Buffer.from("内容")] });
  const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
  await assert.rejects(transport.request({ ...input(), maxBytes: 11 }), { code: "FETCH_RESPONSE_REJECTED" });
});

test("unsupported declared charset and invalid UTF-8 fail without silently corrupting evidence", async () => {
  for (const scenario of [{ type: "text/plain; charset=gbk" }, { chunks: [Buffer.from([0xc0, 0xaf])] }]) {
    const stub = fakeRequest(scenario);
    await assert.rejects(createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request }).transport.request(input()), { code: "FETCH_RESPONSE_REJECTED" });
  }
});

test("peer mismatch and private peer fail even with approved resolved addresses", async () => {
  for (const address of ["1.1.1.1", "169.254.169.254", "::ffff:127.0.0.1"]) {
    const stub = fakeRequest({ address });
    const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
    await assert.rejects(transport.request(input()), { code: "UNSAFE_SOURCE_URL" });
  }
  const mapped = fakeRequest({ address: "::ffff:93.184.216.34" });
  assert.equal((await createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: mapped.request }).transport.request(input())).connectedAddress, "93.184.216.34");
});

test("redirect is returned without following it and error status needs no accepted MIME", async () => {
  const stub = fakeRequest({ status: 302, location: "https://other.hackathon.dev/", type: "text/html" });
  const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
  const result = await transport.request(input());
  assert.equal(result.status, 302);
  assert.equal(result.location, "https://other.hackathon.dev/");
});

test("missing robots statuses discard oversized or never-ending error pages after authenticated peer checks", async () => {
  for (const status of [404, 410]) {
    for (const length of [undefined, "999999999"]) {
      const active = controller();
      const stub = fakeRequest({ status, type: "text/html; charset=utf-8", length, encoding: "gzip",
        chunks: [Buffer.from("error page ".repeat(200))], keepOpen: true });
      const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
      const result = await transport.request({ ...input(active.signal), url: "https://events.hackathon.dev/robots.txt" });
      assert.deepEqual(result, { status, connectedAddress: "93.184.216.34", contentType: "text/html; charset=utf-8", body: "" });
      assert.equal(stub.outgoing.destroyed, true); assert.equal(stub.response()!.destroyed, true);
      assert.equal(stub.response()!.listenerCount("data"), 0, "error body is never put into flowing mode");
      assert.equal(getEventListeners(active.signal, "abort").length, 0, "successful discard removes its abort listener");
      assert.equal(stub.options()!.rejectUnauthorized, true); assert.equal(stub.options()!.servername, input().hostname);
      active.abort();
      stub.response()!.emit("error", new Error("late discarded response error"));
      stub.outgoing.emit("error", new Error("late discarded request error"));
    }
  }
});

test("missing robots transport result reaches the existing missing policy without waiting for body end", async () => {
  for (const status of [404, 410]) {
    const stub = fakeRequest({ status, type: "text/html", length: "999999999", keepOpen: true });
    const ports = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    const result = await assertRobotsAllowed({ sourceUrl: input().url, ...ports, userAgent: "HackathonIntelBot", policy: {
      version: 1, rules: [{ hostname: input().hostname, pathPrefix: "/rules" }],
      maxRedirects: 0, maxBytes: 32, timeoutMs: 1000, acceptedContentTypes: ["text/plain"],
    } });
    assert.equal(result.status, "missing"); assert.equal(stub.outgoing.destroyed, true);
  }
});

test("successful robots and non-robots error pages keep advertised and streamed size limits", async () => {
  for (const [path, status] of [["/robots.txt", 200], ["/rules", 404], ["/robots.txt/private", 410]] as const) {
    for (const scenario of [{ length: "33" }, { chunks: [Buffer.from("x".repeat(33))] }]) {
      const stub = fakeRequest({ status, ...scenario });
      const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
      await assert.rejects(transport.request({ ...input(), url: `https://events.hackathon.dev${path}` }), { code: "FETCH_RESPONSE_REJECTED" });
      assert.equal(stub.outgoing.destroyed, true);
    }
  }
  const normal = fakeRequest({ status: 404, type: "text/html", chunks: [Buffer.from("real error body")] });
  assert.equal((await createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: normal.request })
    .transport.request(input())).body, "real error body");
});

test("missing robots cannot bypass unsafe peer validation or a TLS/request failure", async () => {
  for (const status of [404, 410]) {
    for (const address of ["1.1.1.1", "127.0.0.1", "", "::ffff:127.0.0.1"]) {
      const stub = fakeRequest({ status, address, length: "999999999", keepOpen: true });
      const { transport } = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: stub.request });
      await assert.rejects(transport.request({ ...input(), url: "https://events.hackathon.dev/robots.txt" }), { code: "UNSAFE_SOURCE_URL" });
      assert.equal(stub.outgoing.destroyed, true);
    }
  }
  const outgoing = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
  let destroyed = false;
  outgoing.end = () => queueMicrotask(() => outgoing.emit("error", Object.assign(new Error("fixture TLS verification failed"), { code: "CERT_HAS_EXPIRED" })));
  outgoing.destroy = () => { destroyed = true; };
  const request: NodeHttpsRequest = options => {
    assert.equal(options.rejectUnauthorized, true);
    return outgoing as unknown as ClientRequest;
  };
  await assert.rejects(createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request })
    .transport.request({ ...input(), url: "https://events.hackathon.dev/robots.txt" }), { code: "FETCH_UNAVAILABLE" });
  assert.equal(destroyed, true);
});

test("abort before connection and during a body terminates without waiting for end", async () => {
  const pre = controller(); pre.abort();
  const unopened = fakeRequest({ keepOpen: true });
  await assert.rejects(createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: unopened.request }).transport.request(input(pre.signal)), { code: "FETCH_CANCELLED" });
  assert.equal(unopened.options(), undefined);
  const active = controller();
  const opened = fakeRequest({ keepOpen: true });
  const pending = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", request: opened.request }).transport.request(input(active.signal));
  await Promise.resolve();
  active.abort();
  await assert.rejects(pending, { code: "FETCH_CANCELLED" });
  assert.equal(opened.outgoing.destroyed, true);
});

test("DNS uses all records, rejects mixed private answers and cancels pending OS lookup", async () => {
  const calls: string[] = [];
  const publicPorts = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", lookup: async (hostname, options) => {
    calls.push(hostname); assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: "93.184.216.34", family: 4 }, { address: "93.184.216.34", family: 4 }];
  } });
  assert.deepEqual(await publicPorts.dns.resolve("events.hackathon.dev", controller().signal), ["93.184.216.34"]);
  assert.deepEqual(calls, ["events.hackathon.dev"]);
  await assert.rejects(createNodeNetworkPorts({ userAgent: "HackathonIntelBot", lookup: async () => [
    { address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 },
  ] }).dns.resolve("events.hackathon.dev", controller().signal), { code: "UNSAFE_SOURCE_URL" });
  const cancel = controller();
  let late: (value: readonly { address: string; family: number }[]) => void = () => {};
  const pending = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", lookup: async () => new Promise((resolve) => { late = resolve; }) }).dns.resolve("events.hackathon.dev", cancel.signal);
  await Promise.resolve(); cancel.abort();
  await assert.rejects(pending, { code: "FETCH_CANCELLED" });
  late([{ address: "93.184.216.34", family: 4 }]);
});

test("caller cannot inject request headers through a malformed user-agent", () => {
  assert.throws(() => createNodeNetworkPorts({ userAgent: "bot\r\nAuthorization: secret" }), { code: "INVALID_CRAWLER_CONFIG" });
});

test("network factory rejects unsafe proxy configuration before DNS or socket operations", () => {
  let operations = 0;
  for (const proxyUrl of ["http://1.1.1.1:8080", "http://10.0.0.1:8080", "http://user:secret@127.0.0.1:8080"]) {
    assert.throws(() => createNodeNetworkPorts({ userAgent: "HackathonIntelBot", proxyUrl,
      lookup: async () => { operations += 1; return []; }, request: () => { operations += 1; throw Error("must not connect"); } }),
    { code: "INVALID_CRAWLER_CONFIG" });
  }
  assert.equal(operations, 0);
});

test("dual-stack source fetch chooses a public IPv4 even when DNS returns IPv6 first", async () => {
  const answers = [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1001", family: 6 },
    { address: "1.1.1.1", family: 4 },
  ];
  const stub = fakeRequest({});
  const ports = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", lookup: async () => answers, request: stub.request });
  assert.deepEqual(await ports.dns.resolve("events.hackathon.dev", controller().signal),
    ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2606:4700:4700::1001"]);
  const result = await fetchApprovedSource({ url: input().url, ...ports, policy: {
    version: 1, rules: [{ hostname: input().hostname, pathPrefix: "/rules" }],
    maxRedirects: 0, maxBytes: 32, timeoutMs: 1000, acceptedContentTypes: ["text/plain"],
  } });
  assert.equal(result.body, "public rules");
  assert.equal(stub.options()!.family, 4);
  assert.equal(stub.options()!.servername, input().hostname);
  assert.equal(stub.options()!.rejectUnauthorized, true);
  assert.equal(stub.options()!.agent, false);
  await new Promise<void>((resolve) => stub.options()!.lookup!(input().hostname, {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4); resolve();
  }));
  assert.equal(answers[0].family, 6, "OS lookup answer list is not mutated");
});

test("IPv6-only source remains fetchable with its exact TLS peer and hostname pinned", async () => {
  const address = "2606:4700:4700::1111";
  const stub = fakeRequest({ address });
  const ports = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", lookup: async () => [
    { address, family: 6 }, { address: "2606:4700:4700::1001", family: 6 },
  ], request: stub.request });
  assert.deepEqual(await ports.dns.resolve(input().hostname, controller().signal), [address, "2606:4700:4700::1001"]);
  assert.equal((await fetchApprovedSource({ url: input().url, ...ports, policy: {
    version: 1, rules: [{ hostname: input().hostname, pathPrefix: "/rules" }],
    maxRedirects: 0, maxBytes: 32, timeoutMs: 1000, acceptedContentTypes: ["text/plain"],
  } })).body, "public rules");
  assert.equal(stub.options()!.family, 6);
  assert.equal(stub.options()!.servername, input().hostname);
  assert.equal(stub.options()!.rejectUnauthorized, true);
  await new Promise<void>((resolve) => stub.options()!.lookup!(input().hostname, {}, (error, chosen, family) => {
    assert.equal(error, null); assert.equal(chosen, address); assert.equal(family, 6); resolve();
  }));
});

test("IPv4 preference never filters unsafe IPv6 or IPv4 answers before source fetch", async () => {
  for (const unsafeAddress of ["fd00::1", "::1", "10.0.0.1", "::ffff:127.0.0.1"]) {
    let requests = 0;
    const ports = createNodeNetworkPorts({ userAgent: "HackathonIntelBot", lookup: async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
      { address: unsafeAddress, family: unsafeAddress.includes(":") ? 6 : 4 },
    ], request: () => { requests += 1; throw Error("must not connect"); } });
    await assert.rejects(fetchApprovedSource({ url: input().url, ...ports, policy: {
      version: 1, rules: [{ hostname: input().hostname, pathPrefix: "/rules" }],
      maxRedirects: 0, maxBytes: 32, timeoutMs: 1000, acceptedContentTypes: ["text/plain"],
    } }), { code: "UNSAFE_SOURCE_URL" });
    assert.equal(requests, 0);
  }
});
