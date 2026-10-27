import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGuanchaProvider, type GuanchaProviderOptions } from "./provider.ts";

// Test-only credentials; every transport is injected and no request reaches a network.
const clientId = "isolated-test-client";
const clientSecret = "isolated-test-secret+with&form=characters";
const accessToken = "isolated-private-access+/token==";
const refreshToken = "isolated-private-refresh-token";
const origin = "https://app.example.test:44353";
const redirectUri = `${origin}/api/v1/auth/guancha/callback`;
const state = "s".repeat(43), codeVerifier = "v".repeat(43);
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
const exchange = { code: "isolated+code&with=characters", redirectUri, codeVerifier, expectedNonce: null };
const authorization = { state, redirectUri, codeChallenge, nonce: null };
const tokenBody = () => ({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope: "read" });
const userinfoBody = () => ({ statusCode: 200, data: { user_id: 12345, nickname: "  观猹测试用户  ", avatar_url: "https://image.example.test/avatar" } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  ...init, headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
});

interface Call { readonly url: URL; readonly init: RequestInit }
type Step = Response | Error | ((call: Call) => Response | Promise<Response>);

function fixture(steps: readonly Step[] = [json(tokenBody()), json(userinfoBody())], overrides: Partial<GuanchaProviderOptions> = {}) {
  const calls: Call[] = [];
  const fetcher: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { url, init }; calls.push(call);
    const step = steps[calls.length - 1];
    if (!step) throw new Error("Unexpected additional transport call; network fallback is forbidden.");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(call) : step;
  };
  const options = { clientId, clientSecret, origin, redirectUri, ...overrides, fetch: fetcher };
  return { calls, provider: createGuanchaProvider(options), options };
}

function redacted(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Guancha provider response could not be verified.");
  assert.equal(error.cause, undefined);
  const diagnostic = `${String(error)} ${error.stack ?? ""} ${JSON.stringify(error)}`;
  for (const privateValue of [clientSecret, accessToken, refreshToken, exchange.code, codeVerifier]) {
    assert.ok(!diagnostic.includes(privateValue), "provider diagnostics must omit private request and response values");
  }
  assert.ok(!diagnostic.includes("access_token="));
  return true;
}

test("authorization uses the official endpoint, scope read and S256 without exposing secrets", () => {
  const f = fixture();
  const url = new URL(f.provider.authorizationUrl(authorization));
  assert.equal(`${url.origin}${url.pathname}`, "https://watcha.cn/oauth/authorize");
  assert.deepEqual([...url.searchParams.entries()].sort(), Object.entries({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "read", state,
    code_challenge: codeChallenge, code_challenge_method: "S256",
  }).sort());
  assert.ok(!url.toString().includes(clientSecret));
  assert.ok(!url.toString().includes(codeVerifier));
  assert.equal(f.provider.configuration.issuer, "https://watcha.cn");
  assert.equal(f.provider.configuration.pkce, "S256");
  assert.equal(f.provider.configuration.useNonce, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.provider.configuration.configurationId, fixture().provider.configuration.configurationId);
  assert.notEqual(f.provider.configuration.configurationId, fixture([], { clientId: "another-client" }).provider.configuration.configurationId);
  assert.notEqual(f.provider.configuration.configurationId, fixture([], {
    origin: "https://other.example.test", redirectUri: "https://other.example.test/api/v1/auth/guancha/callback",
  }).provider.configuration.configurationId);
});

test("configuration requires the exact HTTPS origin and callback path", () => {
  for (const override of [
    { origin: "http://app.example.test", redirectUri: "http://app.example.test/api/v1/auth/guancha/callback" },
    { origin: `${origin}/` }, { origin: `${origin}/nested` }, { origin: "https://user:password@app.example.test" },
    { origin: `${origin}?query=value` }, { origin: `${origin}#fragment` }, { origin: "not-a-url" },
    { redirectUri: "https://evil.example.test/api/v1/auth/guancha/callback" },
    { redirectUri: `${redirectUri}/` }, { redirectUri: `${redirectUri}?next=evil` }, { redirectUri: `${redirectUri}#fragment` },
    { redirectUri: `${origin}/api/v1/auth/guancha/%63allback` },
  ]) assert.throws(() => fixture([], override));
  for (const override of [
    { clientId: "" }, { clientId: "space client" }, { clientId: "x".repeat(513) },
    { clientSecret: "" }, { clientSecret: "secret\nheader" }, { clientSecret: "x".repeat(4097) },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }, { maximumResponseBytes: 255 }, { maximumResponseBytes: 262_145 },
  ]) assert.throws(() => fixture([], override));
});

test("callback and PKCE inputs cannot downgrade or redirect the adapter before transport", async () => {
  const f = fixture();
  for (const input of [
    { ...authorization, state: "bad-state" }, { ...authorization, codeChallenge: null },
    { ...authorization, codeChallenge: "short" }, { ...authorization, nonce: state },
    { ...authorization, redirectUri: "https://evil.example.test/callback" },
  ]) assert.throws(() => f.provider.authorizationUrl(input), redacted);
  for (const input of [
    { ...exchange, codeVerifier: null }, { ...exchange, codeVerifier: "short" },
    { ...exchange, expectedNonce: state }, { ...exchange, code: "" },
    { ...exchange, code: "x".repeat(2049) }, { ...exchange, code: "code\nheader" },
    { ...exchange, redirectUri: `${redirectUri}?next=evil` },
  ]) await assert.rejects(f.provider.exchangeAndVerify(input), redacted);
  assert.equal(f.calls.length, 0);
});

test("code exchange sends secrets only in the POST body and userinfo uses the documented private query", async () => {
  const body = userinfoBody();
  Object.assign(body.data, {
    email: "victim@example.test", email_verified: true, subject: "attacker-controlled", roles: ["admin"],
    access_token: accessToken, refresh_token: refreshToken,
  });
  const f = fixture([json(tokenBody()), json(body)]);
  const result = await f.provider.exchangeAndVerify(exchange);
  assert.deepEqual(result, { issuer: "https://watcha.cn", subject: "12345", displayName: "观猹测试用户" });
  assert.equal(f.calls.length, 2);
  const [tokenCall, infoCall] = f.calls as [Call, Call];
  assert.equal(tokenCall.url.toString(), "https://watcha.cn/oauth/api/token");
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(new Headers(tokenCall.init.headers).get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(typeof tokenCall.init.body, "string");
  assert.deepEqual([...new URLSearchParams(String(tokenCall.init.body)).entries()].sort(), Object.entries({
    grant_type: "authorization_code", code: exchange.code, redirect_uri: redirectUri,
    client_id: clientId, client_secret: clientSecret, code_verifier: codeVerifier,
  }).sort());
  assert.equal(`${infoCall.url.origin}${infoCall.url.pathname}`, "https://watcha.cn/oauth/api/userinfo");
  assert.deepEqual([...infoCall.url.searchParams.entries()], [["access_token", accessToken]]);
  assert.equal(infoCall.init.method, "GET");
  assert.equal(infoCall.init.body, undefined);
  assert.equal(new Headers(infoCall.init.headers).get("authorization"), null, "do not invent undocumented Bearer-header transport");
  assert.ok(!infoCall.url.toString().includes(clientSecret));
  assert.ok(!infoCall.url.toString().includes(codeVerifier));
  for (const call of f.calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.equal(new Headers(call.init.headers).get("accept"), "application/json");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(result).includes("token"));
  assert.ok(!JSON.stringify(f.provider.configuration).includes(clientSecret));
});

test("token responses must provide a usable Bearer token, expiry and granted read scope", async () => {
  for (const invalid of [
    { ...tokenBody(), error: "invalid_grant", error_description: clientSecret },
    { ...tokenBody(), access_token: "" }, { ...tokenBody(), access_token: "has whitespace" },
    { ...tokenBody(), access_token: "x".repeat(4097) }, { ...tokenBody(), access_token: 123 },
    { ...tokenBody(), token_type: "Basic" }, { ...tokenBody(), token_type: null },
    { ...tokenBody(), expires_in: 0 }, { ...tokenBody(), expires_in: 1.5 }, { ...tokenBody(), expires_in: "3600" },
    { ...tokenBody(), expires_in: Number.MAX_SAFE_INTEGER + 1 },
    { ...tokenBody(), scope: "write" }, { ...tokenBody(), scope: ["read"] },
    { statusCode: 200, data: tokenBody() },
  ]) {
    const f = fixture([json(invalid)]);
    await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
    assert.equal(f.calls.length, 1, "invalid token response must not reach userinfo or retry");
  }
  const valid = fixture([json({ ...tokenBody(), token_type: "bearer" }), json(userinfoBody())]);
  assert.equal((await valid.provider.exchangeAndVerify(exchange)).subject, "12345");
});

test("userinfo accepts only a positive safe integer identity with successful business status", async () => {
  const badIds: unknown[] = [null, "12345", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, true];
  const cases: unknown[] = badIds.map(user_id => ({ statusCode: 200, data: { user_id, email: "victim@example.test" } }));
  cases.push(
    { statusCode: 401, data: { user_id: 12345, email: "victim@example.test" } },
    { statusCode: 200, data: { email: "victim@example.test" } },
  );
  for (const invalid of [...cases, { statusCode: "200", data: { user_id: 12345 } }, { statusCode: 200, data: [] }, { user_id: 12345 }]) {
    const f = fixture([json(tokenBody()), json(invalid)]);
    await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
    assert.equal(f.calls.length, 2, "invalid identity must not trigger fallback lookup or retry");
  }
  const f = fixture([json(tokenBody()), json({ statusCode: 200, data: { user_id: Number.MAX_SAFE_INTEGER } })]);
  assert.deepEqual(await f.provider.exchangeAndVerify(exchange), { issuer: "https://watcha.cn", subject: String(Number.MAX_SAFE_INTEGER) });
});

test("untrusted nickname metadata is optional and never replaces the stable identity", async () => {
  for (const nickname of [null, "", " ", "x".repeat(61), "name\nforged-header", { text: "name" }]) {
    const f = fixture([json(tokenBody()), json({ statusCode: 200, data: { user_id: 12345, nickname } })]);
    assert.deepEqual(await f.provider.exchangeAndVerify(exchange), { issuer: "https://watcha.cn", subject: "12345" });
  }
});

test("transport errors at either stage are redacted and never retried", async () => {
  const privateError = () => new Error(`failed https://watcha.cn/oauth/api/userinfo?access_token=${accessToken}; ${clientSecret}; ${refreshToken}; ${exchange.code}`);
  for (const stage of ["token", "userinfo"]) {
    const f = fixture(stage === "token" ? [privateError()] : [json(tokenBody()), privateError()]);
    await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
    assert.equal(f.calls.length, stage === "token" ? 1 : 2);
  }
});

test("HTTP failures, redirects and unexpected response locations fail closed", async () => {
  const badResponses = () => [
    json({ error: accessToken }, { status: 500 }),
    json({}, { status: 302, headers: { location: "https://evil.example.test/collect" } }),
    Object.defineProperty(json(tokenBody()), "redirected", { value: true }),
    Object.defineProperty(json(tokenBody()), "url", { value: "https://evil.example.test/collect" }),
  ];
  for (const response of badResponses()) {
    const f = fixture([response]);
    await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.init.redirect, "error");
  }
});

test("both response stages reject invalid JSON, encoding, content type and non-object envelopes", async () => {
  const badResponses = () => [
    new Response(`{invalid:${accessToken}`, { headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify(tokenBody()), { headers: { "content-type": "text/html" } }),
    new Response(JSON.stringify(tokenBody())),
    new Response(null, { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } }),
    json(null), json([]), json("token-response"),
  ];
  for (const stage of ["token", "userinfo"]) for (const response of badResponses()) {
    const f = fixture(stage === "token" ? [response] : [json(tokenBody()), response]);
    await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
    assert.equal(f.calls.length, stage === "token" ? 1 : 2);
  }
});

test("declared and streamed response sizes are bounded independently", async () => {
  for (const stage of ["token", "userinfo"]) {
    for (const length of ["257", "-1", "unknown"]) {
      const response = json(stage === "token" ? tokenBody() : userinfoBody(), { headers: { "content-length": length } });
      const f = fixture(stage === "token" ? [response] : [json(tokenBody()), response], { maximumResponseBytes: 256 });
      await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
      assert.equal(f.calls.length, stage === "token" ? 1 : 2);
    }
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(200)); controller.enqueue(new Uint8Array(200)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body, { headers: { "content-type": "application/json", "content-length": "1" } });
    const f = fixture(stage === "token" ? [response] : [json(tokenBody()), response], { maximumResponseBytes: 256 });
    await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
    assert.equal(cancelled, true, "oversized stream is cancelled even if the header underreports its size");
    assert.equal(f.calls.length, stage === "token" ? 1 : 2);
  }
});

test("a stalled token exchange is aborted, redacted and not retried", { timeout: 2000 }, async () => {
  let aborts = 0;
  const f = fixture([({ init }) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => {
      aborts++; reject(new Error(`transport aborted ${clientSecret} ${exchange.code}`));
    }, { once: true });
  })], { timeoutMs: 10 });
  await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
  assert.equal(aborts, 1);
  assert.equal(f.calls.length, 1);
});

test("a stalled userinfo body is also bounded by the request timeout", { timeout: 2000 }, async () => {
  let aborts = 0;
  const f = fixture([json(tokenBody()), ({ init }) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"statusCode":'));
      init.signal!.addEventListener("abort", () => {
        aborts++; controller.error(new Error(`body aborted access_token=${accessToken}`));
      }, { once: true });
    },
  }), { headers: { "content-type": "application/json" } })], { timeoutMs: 10 });
  await assert.rejects(f.provider.exchangeAndVerify(exchange), redacted);
  assert.equal(aborts, 1);
  assert.equal(f.calls.length, 2);
});
