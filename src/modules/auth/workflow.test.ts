import assert from "node:assert/strict";
import test from "node:test";
import { AuthService, createAuthHandlers, createNodeAuthCrypto } from "./index.ts";
import { CapturingLoginEmail, FixtureClock, FixtureIds, SerialAuthStoreFixture } from "./test-fixtures.ts";

test("composed HTTP/service login, profile write and logout use cookie identity throughout", async () => {
  const clock = new FixtureClock(); const ids = new FixtureIds();
  const store = new SerialAuthStoreFixture(clock); const email = new CapturingLoginEmail();
  const service = new AuthService({ clock, ids, store, email, crypto: createNodeAuthCrypto("workflow-test-only-pepper-at-least-32-bytes") });
  const origin = "https://hackathon.example";
  const handlers = createAuthHandlers({ service, origin, requestIds: ids, getClientKey: () => "trusted-test-connection" });
  const makeRequest = (method: string, path: string, body?: unknown, cookie?: string) => new Request(`${origin}${path}`, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  assert.equal((await handlers.getMe(makeRequest("GET", "/api/v1/me"))).status, 401);
  const send = await handlers.requestLoginChallenge(makeRequest("POST", "/api/v1/auth/login-challenges", { email: "person@example.com" }));
  assert.equal(send.status, 200);
  const receipt = (await send.json()).data;
  const verify = await handlers.verify(makeRequest("POST", "/api/v1/auth/login-challenges/verify", {
    challengeId: receipt.challengeId, code: email.sent[0]!.code, returnTo: "/app/projects/project-1/team",
  }));
  assert.equal(verify.status, 200);
  const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
  const verifiedBody = await verify.json();
  assert.equal(verifiedBody.data.returnTo, "/app/projects/project-1/team");
  assert.ok(!JSON.stringify(verifiedBody).includes(cookie.split("=")[1]!));
  const actor = await service.requireActor(handlers.readSessionToken(makeRequest("GET", "/api/v1/me", undefined, cookie)));
  assert.deepEqual(actor.platformRoles, ["user"]);
  const me = await handlers.getMe(makeRequest("GET", "/api/v1/me", undefined, cookie));
  assert.equal((await me.json()).data.profile.id, actor.userId);
  clock.advance(1_000);
  const settingsResponse = await handlers.getAccountSettings(makeRequest("GET", "/api/v1/auth/account-settings", undefined, cookie));
  assert.equal(settingsResponse.status, 200);
  const settingsBody = await settingsResponse.json();
  assert.equal(settingsBody.data.profile.id, actor.userId);
  assert.equal(settingsBody.data.currentSession.current, true);
  assert.equal(settingsBody.data.currentSession.lastSeenAt, clock.now().toISOString());
  assert.equal(settingsBody.data.recentAuthenticationUntil, "2026-10-08T04:05:00.000Z");
  assert.equal(settingsBody.data.canLogoutAll, true);
  assert.deepEqual(settingsBody.data.sessions, [settingsBody.data.currentSession]);
  for (const secret of [cookie.split("=")[1]!, "tokenHash", "platformRoles", "codeHash"]) assert.ok(!JSON.stringify(settingsBody).includes(secret));
  const current = await handlers.getCurrentSession(makeRequest("GET", "/api/v1/auth/session", undefined, cookie));
  assert.deepEqual((await current.json()).data, { session: settingsBody.data.currentSession });
  const profile = await handlers.patchMe(makeRequest("PATCH", "/api/v1/me", { displayName: "参赛队员", timezone: "UTC", expectedRevision: 1 }, cookie));
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).data.profile.revision, 2);
  const updatedSettings = await handlers.getAccountSettings(makeRequest("GET", "/api/v1/auth/account-settings", undefined, cookie));
  assert.equal((await updatedSettings.json()).data.profile.displayName, "参赛队员");
  assert.equal((await handlers.logout(makeRequest("POST", "/api/v1/auth/logout", {}, cookie))).status, 200);
  assert.equal((await handlers.getMe(makeRequest("GET", "/api/v1/me", undefined, cookie))).status, 401);
  assert.equal((await handlers.getAccountSettings(makeRequest("GET", "/api/v1/auth/account-settings", undefined, cookie))).status, 401);
  assert.equal((await handlers.getCurrentSession(makeRequest("GET", "/api/v1/auth/session", undefined, cookie))).status, 401);
  assert.equal((await handlers.verify(makeRequest("POST", "/api/v1/auth/login-challenges/verify", { challengeId: receipt.challengeId, code: email.sent[0]!.code }))).status, 401);
  assert.equal(store.snapshot().sessions.length, 1);
});

test("composed account settings and revocation hide foreign IDs and clear a revoked current device", async () => {
  const clock = new FixtureClock(); const ids = new FixtureIds(); const store = new SerialAuthStoreFixture(clock);
  const email = new CapturingLoginEmail(); const origin = "https://hackathon.example";
  const service = new AuthService({ clock, ids, store, email, crypto: createNodeAuthCrypto("workflow-test-only-pepper-at-least-32-bytes") });
  const handlers = createAuthHandlers({ service, origin, requestIds: ids, clientKeys: { async getClientKey() { return "trusted-test-connection"; } } });
  const makeRequest = (method: "POST" | "GET", body?: unknown, cookie?: string) => new Request(`${origin}/api/v1/auth`, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const login = async (address: string) => {
    const send = await handlers.requestLoginChallenge(makeRequest("POST", { email: address })); assert.equal(send.status, 200);
    const challenge = (await send.json()).data;
    const verify = await handlers.verify(makeRequest("POST", { challengeId: challenge.challengeId, code: email.sent.at(-1)!.code }));
    assert.equal(verify.status, 200);
    return verify.headers.get("set-cookie")!.split(";")[0]!;
  };
  const ownCookie = await login("a@example.com"); const otherCookie = await login("b@example.com");
  const ownSettings = (await (await handlers.getAccountSettings(makeRequest("GET", undefined, ownCookie))).json()).data;
  const otherSettings = (await (await handlers.getAccountSettings(makeRequest("GET", undefined, otherCookie))).json()).data;
  assert.equal(ownSettings.sessions.length, 1);
  assert.ok(!JSON.stringify(ownSettings).includes(otherSettings.currentSession.id));
  for (const sessionId of [otherSettings.currentSession.id, "missing-session"]) {
    const revoke = await handlers.revokeSession(makeRequest("POST", { sessionId }, ownCookie));
    assert.equal(revoke.status, 200); assert.equal(revoke.headers.get("set-cookie"), null);
    assert.deepEqual((await revoke.json()).data, { revoked: false, currentSessionRevoked: false });
  }
  const currentRevoke = await handlers.revokeSession(makeRequest("POST", { sessionId: ownSettings.currentSession.id }, ownCookie));
  assert.equal(currentRevoke.status, 200);
  assert.ok(currentRevoke.headers.get("set-cookie")!.includes("Max-Age=0"));
  assert.deepEqual((await currentRevoke.json()).data, { revoked: true, currentSessionRevoked: true });
  assert.equal((await handlers.getAccountSettings(makeRequest("GET", undefined, ownCookie))).status, 401);
  assert.equal((await handlers.getAccountSettings(makeRequest("GET", undefined, otherCookie))).status, 200);
});
