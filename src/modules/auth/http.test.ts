import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createAuthHandlers, type AuthHandlers, type AuthHttpOptions, type AuthHttpService } from "./http.ts";
import type { AccountSettings, SessionSummary, UserProfile } from "./types.ts";

const origin = "https://hackathon.example";
const token = "s".repeat(43);
const profile: UserProfile = {
  id: "user-1", email: "newcomer@example.org", displayName: "新人",
  timezone: "Asia/Shanghai", emailVerifiedAt: "2026-10-08T00:00:00.000Z", revision: 1,
};
const privateProfile = { ...profile, tokenHash: "private-token-hash", codeHash: "private-code-hash", platformRoles: ["admin"] };
const session: SessionSummary = {
  id: "session-1", createdAt: "2026-10-08T00:00:00.000Z", authenticatedAt: "2026-10-08T00:00:00.000Z",
  expiresAt: "2026-10-15T00:00:00.000Z", current: true, lastSeenAt: "2026-10-08T00:02:00.000Z",
};
const privateSession = { ...session, tokenHash: "private-token-hash", userId: "private-user-id", revokedAt: null };
const settings: AccountSettings = {
  profile, currentSession: session, sessions: [session],
  recentAuthenticationUntil: "2026-10-08T00:05:00.000Z", canLogoutAll: true,
};

function mockService(overrides: Partial<AuthHttpService> = {}): AuthHttpService {
  return {
    requestLoginChallenge: async () => ({ challengeId: "challenge-1", expiresAt: "2026-10-08T00:10:00.000Z", resendAfterSeconds: 60, message: "验证邮件已受理。", codeHash: "private-code-hash" }),
    verifyLoginChallenge: async () => ({ sessionToken: token, expiresAt: "2026-10-15T00:00:00.000Z", profile: privateProfile, returnTo: "/app" }),
    getCurrentProfile: async () => privateProfile,
    getAccountSettings: async () => ({ ...settings, profile: privateProfile, currentSession: privateSession, sessions: [privateSession], sessionToken: token }),
    updateOwnProfile: async () => privateProfile,
    logout: async () => {},
    logoutAll: async () => {},
    listOwnSessions: async () => [privateSession],
    revokeOwnSession: async () => ({ revoked: true, currentSessionRevoked: false }),
    ...overrides,
  };
}

function options(overrides: Partial<AuthHttpOptions> = {}): AuthHttpOptions {
  return { service: mockService(), origin, getClientKey: () => "trusted-transport-key", requestIds: { next: () => "req-server" }, ...overrides };
}

function request(method = "POST", body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/v1/auth`, {
    method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: `__Host-hackathon_session=${token}`, ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

function assertNoPrivateData(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [token, "private-token-hash", "private-code-hash", "platformRoles", "private-user-id", "sessionToken"]) {
    assert.ok(!text.includes(secret), `Response exposed ${secret}`);
  }
}

test("verification sets a host-only secure cookie and returns only profile and returnTo", async () => {
  const response = await createAuthHandlers(options()).verify(request("POST", { challengeId: "challenge-1", code: "12345678", returnTo: "/app" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const cookie = response.headers.get("set-cookie")!;
  assert.ok(cookie.startsWith(`__Host-hackathon_session=${token}; `));
  assert.ok(cookie.includes("Expires=Thu, 15 Oct 2026 00:00:00 GMT"));
  assert.ok(cookie.includes("; Path=/; HttpOnly; SameSite=Lax; Secure"));
  assert.ok(!cookie.includes("Domain="));
  const body: unknown = await response.json();
  assert.deepEqual(body, { data: { profile, returnTo: "/app" }, requestId: "req-server" });
  assertNoPrivateData(body);
});

test("cookie configuration rejects deployment mistakes and supports explicit loopback development", async () => {
  for (const invalid of [
    { origin: "https://hackathon.example/" }, { origin: "https://hackathon.example/path" },
    { origin: "http://localhost:3000" }, { origin: "http://hackathon.example", secure: false },
    { secure: false }, { cookieName: "bad;cookie" },
    { origin: "http://localhost:3000", secure: false, cookieName: "__Host-hackathon_session" },
    { origin: "http://localhost:3000", secure: false, cookieName: "__Secure-session" },
    { maxJsonBytes: 0 }, { maxJsonBytes: 65_537 },
  ]) assert.throws(() => createAuthHandlers(options(invalid)));
  const handlers = createAuthHandlers(options({ origin: "http://localhost:3000", secure: false }));
  const response = await handlers.verify(new Request("http://localhost:3000/api/v1/auth", {
    method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: "challenge-1", code: "12345678" }),
  }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.ok(cookie.startsWith(`hackathon_session=${token}; `));
  assert.ok(!cookie.includes("; Secure"));
  assert.ok(!cookie.includes("__Host-"));
});

test("all writes require a completely matching fixed Origin before invoking services", async () => {
  let calls = 0;
  const service = mockService({
    requestLoginChallenge: async () => { calls++; throw new Error("called"); },
    verifyLoginChallenge: async () => { calls++; throw new Error("called"); },
    updateOwnProfile: async () => { calls++; throw new Error("called"); },
    logout: async () => { calls++; }, logoutAll: async () => { calls++; }, revokeOwnSession: async () => { calls++; return { revoked: true, currentSessionRevoked: false }; },
  });
  const handlers = createAuthHandlers(options({ service }));
  const writes: readonly [Exclude<keyof AuthHandlers, "readSessionToken" | "clearSessionCookie">, string][] = [
    ["requestLoginChallenge", "POST"], ["verify", "POST"], ["patchMe", "PATCH"],
    ["logout", "POST"], ["logoutAll", "POST"], ["revokeSession", "POST"],
  ];
  for (const [name, method] of writes) {
    for (const suppliedOrigin of ["https://evil.example", `${origin}/`, `${origin}:443`, "null", ""]) {
      const response = await handlers[name](request(method, {}, { Origin: suppliedOrigin }));
      assert.ok(response instanceof Response);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).error.code, "AUTH_ORIGIN_INVALID");
    }
  }
  assert.equal(calls, 0);
});

test("writes reject non-JSON media types; only logout endpoints allow an empty untyped body", async () => {
  let loggedOut = 0;
  const handlers = createAuthHandlers(options({ service: mockService({ logout: async () => { loggedOut++; } }) }));
  assert.equal((await handlers.requestLoginChallenge(request("POST", { email: "x@example.org" }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await handlers.verify(request("POST", {}, { "Content-Encoding": "gzip" }))).status, 415);
  const empty = new Request(`${origin}/api/v1/auth/logout`, { method: "POST", headers: { Origin: origin } });
  assert.equal((await handlers.logout(empty)).status, 200);
  assert.equal(loggedOut, 1);
  assert.equal((await handlers.verify(new Request(`${origin}/api/v1/auth/verify`, { method: "POST", headers: { Origin: origin } }))).status, 415);
  assert.equal((await handlers.logout(new Request(`${origin}/api/v1/auth/logout`, { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: "nonempty" }))).status, 415);
});

test("JSON limit counts actual UTF-8 bytes even when Content-Length understates the body", async () => {
  let calls = 0;
  const handlers = createAuthHandlers(options({ maxJsonBytes: 64, service: mockService({ requestLoginChallenge: async () => { calls++; throw new Error("called"); } }) }));
  const body = JSON.stringify({ email: "新".repeat(30) });
  assert.ok(body.length < 64);
  assert.ok(new TextEncoder().encode(body).byteLength > 64);
  const response = await handlers.requestLoginChallenge(new Request(`${origin}/api/v1/auth`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "1" }, body,
  }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "AUTH_BODY_TOO_LARGE");
  assert.equal(calls, 0);
});

test("streamed JSON overflow cancels the stream without waiting for the sender cancellation", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(40).fill(32)); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  const streamed = new Request(`${origin}/api/v1/auth`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await createAuthHandlers(options({ maxJsonBytes: 64 })).requestLoginChallenge(streamed);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test("malformed, non-object and non-UTF-8 JSON are rejected", async () => {
  const handlers = createAuthHandlers(options());
  for (const body of ["{", "null", "[]", "123", '"string"']) {
    const response = await handlers.requestLoginChallenge(new Request(`${origin}/api/v1/auth`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "AUTH_JSON_INVALID");
  }
  const response = await handlers.requestLoginChallenge(new Request(`${origin}/api/v1/auth`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: new Uint8Array([0xff, 0xfe]),
  }));
  assert.equal(response.status, 400);
});

test("unknown fields including caller-supplied identities and credentials are rejected", async () => {
  const handlers = createAuthHandlers(options());
  const writes: readonly [Exclude<keyof AuthHandlers, "readSessionToken" | "clearSessionCookie">, string, unknown][] = [
    ["requestLoginChallenge", "POST", { email: "x@example.org", clientKey: "forged" }],
    ["verify", "POST", { challengeId: "c", code: "12345678", sessionToken: "forged" }],
    ["patchMe", "PATCH", { displayName: "新", timezone: "Asia/Shanghai", expectedRevision: 1, platformRoles: ["admin"] }],
    ["logout", "POST", { userId: "another-user" }], ["logoutAll", "POST", { actor: { userId: "another-user" } }],
    ["revokeSession", "POST", { sessionId: "s", userId: "another-user" }],
  ];
  for (const [name, method, body] of writes) {
    const response = await handlers[name](request(method, body));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "AUTH_FIELDS_INVALID");
  }
});

test("trusted transport client keys replace forwarded headers and JSON identities", async () => {
  let observedKey: string | undefined;
  const handlers = createAuthHandlers(options({
    getClientKey: async () => "server-transport-key",
    service: mockService({ requestLoginChallenge: async (email, key) => {
      assert.equal(email, "newcomer@example.org"); observedKey = key;
      return { challengeId: "c", expiresAt: "2026-10-08T00:10:00.000Z", resendAfterSeconds: 60, message: "验证邮件已受理。" };
    } }),
  }));
  const response = await handlers.requestLoginChallenge(request("POST", { email: "newcomer@example.org" }, {
    "x-forwarded-for": "forged", "x-client-key": "forged", "x-request-id": "forged",
  }));
  assert.equal(observedKey, "server-transport-key");
  const body = await response.json();
  assert.equal(body.requestId, "req-server");
  assertNoPrivateData(body);
});

test("client-key Port is the only configured source for send/verify and preserves adapter binding", async () => {
  const observed: unknown[] = [];
  const clientKeys = {
    connectionKey: "configured-connection",
    async getClientKey(input: Request) {
      observed.push(["port", input.url]);
      return this.connectionKey;
    },
  };
  const handlers = createAuthHandlers(options({
    getClientKey: undefined, clientKeys,
    service: mockService({
      requestLoginChallenge: async (_email, key) => { observed.push(["send", key]); return { challengeId: "c", expiresAt: "2026-10-08T00:10:00.000Z", resendAfterSeconds: 60, message: "验证邮件已受理。" }; },
      verifyLoginChallenge: async (_input, key) => { observed.push(["verify", key]); return { sessionToken: token, expiresAt: "2026-10-15T00:00:00.000Z", profile, returnTo: "/app" }; },
    }),
  }));
  const forgedHeaders = { "x-forwarded-for": "forged", "x-real-ip": "forged", "x-client-key": "forged" };
  assert.equal((await handlers.requestLoginChallenge(request("POST", { email: profile.email }, forgedHeaders))).status, 200);
  assert.equal((await handlers.verify(request("POST", { challengeId: "c", code: "12345678" }, forgedHeaders))).status, 200);
  assert.deepEqual(observed, [
    ["port", `${origin}/api/v1/auth`], ["send", "configured-connection"],
    ["port", `${origin}/api/v1/auth`], ["verify", "configured-connection"],
  ]);
  assert.throws(() => createAuthHandlers(options({ clientKeys })), /trusted client keys/);
  assert.throws(() => createAuthHandlers(options({ getClientKey: undefined })), /trusted client keys/);
});

test("account settings and current session project public metadata from the current cookie", async () => {
  const observed: unknown[] = [];
  const handlers = createAuthHandlers(options({ service: mockService({ getAccountSettings: async (input) => {
    observed.push(input);
    return { ...settings, profile: privateProfile, currentSession: privateSession, sessions: [privateSession], sessionToken: token };
  } }) }));
  const account = await handlers.getAccountSettings(request("GET", {}, { "x-user-id": "other-user", "x-role": "admin" }));
  assert.equal(account.status, 200);
  assert.equal(account.headers.get("cache-control"), "no-store");
  const accountBody = await account.json();
  assert.deepEqual(accountBody, { data: settings, requestId: "req-server" });
  assertNoPrivateData(accountBody);
  const current = await handlers.getCurrentSession(request("GET"));
  assert.equal(current.status, 200);
  const currentBody = await current.json();
  assert.deepEqual(currentBody, { data: { session }, requestId: "req-server" });
  assertNoPrivateData(currentBody);
  assert.deepEqual(observed, [token, token]);
  for (const handler of [handlers.getAccountSettings, handlers.getCurrentSession]) {
    const response = await handler(request("POST"));
    assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), "GET");
  }
  assert.deepEqual(observed, [token, token]);
});

test("account queries reject invalid cookie identity without exposing account or session metadata", async () => {
  const handlers = createAuthHandlers(options({ service: mockService({ getAccountSettings: async (input) => {
    assert.equal(input, null);
    throw new DomainError("AUTH_SESSION_REQUIRED", "请重新登录。", { status: 401, recoveryAction: "login" });
  } }) }));
  for (const handler of [handlers.getAccountSettings, handlers.getCurrentSession]) {
    const response = await handler(request("GET", {}, { Cookie: "another_cookie=other-user", "x-user-id": profile.id }));
    assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
    const body = await response.json();
    assert.deepEqual(body, { error: { code: "AUTH_SESSION_REQUIRED", message: "请重新登录。", recoveryAction: "login" }, requestId: "req-server" });
    assert.ok(!JSON.stringify(body).includes(profile.email)); assertNoPrivateData(body);
  }
});

test("profile queries read only the exact configured cookie and reject ambiguous cookies", async () => {
  const observedTokens: (string | null | undefined)[] = [];
  const handlers = createAuthHandlers(options({ service: mockService({ getCurrentProfile: async (input) => {
    observedTokens.push(input);
    if (!input) throw new DomainError("AUTH_SESSION_REQUIRED", "请重新登录。", { status: 401 });
    return privateProfile;
  } }) }));
  const success = await handlers.getMe(request("GET", {}, { "x-user-id": "other-user", "x-role": "admin" }));
  assert.equal(success.status, 200);
  const body = await success.json();
  assert.deepEqual(body.data, { profile });
  assertNoPrivateData(body);
  for (const cookie of [
    `__Host-hackathon_session=${token}; __Host-hackathon_session=${token}`,
    `other_cookie=${token}`, "__Host-hackathon_session=not-a-valid-token", `__Host-hackathon_session=%${token}`,
  ]) assert.equal((await handlers.getMe(request("GET", {}, { Cookie: cookie }))).status, 401);
  assert.deepEqual(observedTokens, [token, null, null, null, null]);
  assert.equal(handlers.readSessionToken(request("GET")), token);
});

test("profile updates forward only permitted fields and the cookie token", async () => {
  const update = { displayName: "新昵称", timezone: "Asia/Shanghai", expectedRevision: 1 };
  let observed: unknown;
  const handlers = createAuthHandlers(options({ service: mockService({ updateOwnProfile: async (inputToken, input) => {
    observed = { inputToken, input }; return { ...privateProfile, displayName: input.displayName, revision: 2 };
  } }) }));
  const response = await handlers.patchMe(request("PATCH", update));
  assert.equal(response.status, 200);
  assert.deepEqual(observed, { inputToken: token, input: update });
  assertNoPrivateData(await response.json());
  assert.equal((await handlers.patchMe(request("PATCH", { ...update, expectedRevision: "1" }))).status, 422);
});

test("current/all-device logout and per-device revocation use the current cookie", async () => {
  const calls: unknown[] = [];
  const handlers = createAuthHandlers(options({ service: mockService({
    logout: async (input) => { calls.push(["logout", input]); },
    logoutAll: async (input) => { calls.push(["logoutAll", input]); },
    revokeOwnSession: async (input, target) => { calls.push(["revoke", input, target]); return { revoked: true, currentSessionRevoked: false }; },
  }) }));
  for (const handler of [handlers.logout, handlers.logoutAll]) {
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), "__Host-hackathon_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure");
    assert.deepEqual((await response.json()).data, { loggedOut: true });
  }
  const revokeResponse = await handlers.revokeSession(request("POST", { sessionId: "another-device-session" }));
  assert.equal(revokeResponse.status, 200);
  assert.deepEqual((await revokeResponse.json()).data, { revoked: true, currentSessionRevoked: false });
  assert.equal(revokeResponse.headers.get("set-cookie"), null);
  assert.deepEqual(calls, [["logout", token], ["logoutAll", token], ["revoke", token, "another-device-session"]]);
});

test("all-device logout failure preserves the cookie and exposes a recoverable domain error", async () => {
  const handlers = createAuthHandlers(options({ service: mockService({ logoutAll: async () => {
    throw new DomainError("AUTH_REAUTHENTICATION_REQUIRED", "请重新验证邮箱。", { status: 403, recoveryAction: "reauthenticate" });
  } }) }));
  const response = await handlers.logoutAll(request());
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { error: { code: "AUTH_REAUTHENTICATION_REQUIRED", message: "请重新验证邮箱。", recoveryAction: "reauthenticate" }, requestId: "req-server" });
});

test("only an actual current-device revocation clears the matching HttpOnly cookie", async () => {
  for (const receipt of [
    { revoked: true, currentSessionRevoked: true },
    { revoked: true, currentSessionRevoked: false },
    { revoked: false, currentSessionRevoked: false },
  ]) {
    const handlers = createAuthHandlers(options({ service: mockService({ revokeOwnSession: async (input, target) => {
      assert.equal(input, token); assert.equal(target, "selected-device");
      return { ...receipt, userId: "private-user-id", tokenHash: "private-token-hash" };
    } }) }));
    const response = await handlers.revokeSession(request("POST", { sessionId: "selected-device" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), receipt.currentSessionRevoked
      ? "__Host-hackathon_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure"
      : null);
    const body = await response.json();
    assert.deepEqual(body.data, receipt); assertNoPrivateData(body);
  }
  const failed = await createAuthHandlers(options({ service: mockService({ revokeOwnSession: async () => {
    throw new DomainError("AUTH_SESSION_REQUIRED", "请重新登录。", { status: 401 });
  } }) })).revokeSession(request("POST", { sessionId: "selected-device" }));
  assert.equal(failed.status, 401); assert.equal(failed.headers.get("set-cookie"), null);
});

test("session list projection omits hashes and internal ownership fields", async () => {
  const response = await createAuthHandlers(options()).listSessions(request("GET"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.sessions[0], session);
  assertNoPrivateData(body);
});

test("shared error envelope retains domain recovery information and hides unknown failures", async () => {
  const failure = new Error(`provider secret ${token}`);
  const unknown = await createAuthHandlers(options({ service: mockService({ getCurrentProfile: async () => { throw failure; } }) })).getMe(request("GET"));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.headers.get("cache-control"), "no-store");
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error.code, "INTERNAL_ERROR");
  assertNoPrivateData(unknownBody);
  assert.ok(!JSON.stringify(unknownBody).includes("provider secret"));
  const limited = await createAuthHandlers(options({ service: mockService({ requestLoginChallenge: async () => {
    throw new DomainError("AUTH_RATE_LIMITED", "请求过于频繁。", { status: 429, recoveryAction: "wait_and_retry" });
  } }) })).requestLoginChallenge(request("POST", { email: "newcomer@example.org" }));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: { code: "AUTH_RATE_LIMITED", message: "请求过于频繁。", recoveryAction: "wait_and_retry" }, requestId: "req-server" });
});

test("incorrect HTTP methods fail without executing the service", async () => {
  let called = false;
  const handlers = createAuthHandlers(options({ service: mockService({ verifyLoginChallenge: async () => { called = true; throw new Error("called"); } }) }));
  const response = await handlers.verify(request("GET"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(called, false);
});

test("invalid session grants fail without creating a cookie or exposing raw grant data", async () => {
  const handlers = createAuthHandlers(options({ service: mockService({ verifyLoginChallenge: async () => ({
    sessionToken: "bad-token\r\nInjected: secret", expiresAt: "invalid", profile, returnTo: "/app",
  }) }) }));
  const response = await handlers.verify(request("POST", { challengeId: "c", code: "12345678" }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
});
