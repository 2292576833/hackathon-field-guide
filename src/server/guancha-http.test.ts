import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./database.ts";
import { createGuanchaHttp } from "./guancha-http.ts";
import { createGuanchaAuth } from "./guancha-auth.ts";
import { guanchaConfiguration } from "./guancha-config.ts";
import { AuthService, PostgresAuthStore, createNodeAuthCrypto, safeAuthReturnTo } from "../modules/auth/index.ts";
import { GuanchaLoginService, PostgresGuanchaAttemptStore, createNodeGuanchaCrypto, type GuanchaProviderPort } from "../modules/guancha-login/index.ts";

const origin = "https://field-guide.example", callback = `${origin}/api/v1/auth/guancha/callback`;
const browserName = "__Host-hackathon_guancha_browser", pendingName = "__Host-hackathon_guancha_pending";
const headersCookies = (response: Response) => response.headers.getSetCookie().filter(item => !item.includes("Max-Age=0")).map(item => item.split(";", 1)[0]).join("; ");
const token = (cookies: string, name: string) => cookies.split("; ").find(part => part.startsWith(name + "="))?.slice(name.length + 1) ?? "";
async function fixture(t: TestContext, enabled = true) {
  const database = await createDatabase({}); t.after(() => database.close()); await database.migrate();
  let time = Date.parse("2026-10-12T00:00:00Z"), exchanges = 0, sentCode = "";
  const clock = { now: () => new Date(time) }, ids = { next: () => randomUUID() };
  const crypto = createNodeAuthCrypto("guancha-root-fixture-secret-long-enough");
  const auth = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto, clock, ids,
    email: { async sendLoginCode(message) { sentCode = message.code; } } });
  const identity = createGuanchaAuth({ database, crypto, clock, ids });
  const provider: GuanchaProviderPort = {
    configuration: { issuer: "https://watcha.cn", authorizationEndpoint: "https://watcha.cn/oauth/authorize", redirectUri: callback,
      documentationUrl: "https://watcha.cn", configurationId: "root-fixture-v1", pkce: "S256", useNonce: false },
    authorizationUrl: input => `https://watcha.cn/oauth/authorize?${new URLSearchParams({ response_type: "code", redirect_uri: input.redirectUri, state: input.state, code_challenge: input.codeChallenge!, code_challenge_method: "S256" })}`,
    async exchangeAndVerify() { exchanges++; return { issuer: "https://watcha.cn", subject: "fixture-private-identity" }; },
  };
  const service = new GuanchaLoginService({ attempts: new PostgresGuanchaAttemptStore(database), crypto: createNodeGuanchaCrypto("guancha-root-fixture-secret-long-enough"),
    clock, identity, safeReturnTo: safeAuthReturnTo, ...(enabled ? { provider } : {}) });
  const initialized: string[] = [];
  const handlers = createGuanchaHttp({ service, identity, database, origin, clock, ids, initializeWorkspace: async userId => { initialized.push(userId); },
    readSessionToken: request => token(request.headers.get("cookie") ?? "", "__Host-hackathon_session") || null,
    currentUserId: async request => (await auth.getActor(token(request.headers.get("cookie") ?? "", "__Host-hackathon_session")))?.userId ?? null });
  const request = (path: string, method = "GET", cookies = "", body?: unknown, requestOrigin = origin) => new Request(origin + "/api/v1/auth/guancha/" + path, {
    method, headers: { origin: requestOrigin, cookie: cookies, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function begin(returnTo = "/events") {
    const response = await handlers.begin(request("begin", "POST", "", { returnTo })); assert.equal(response.status, 200);
    const payload = await response.json(), state = new URL(payload.data.authorizationUrl).searchParams.get("state")!;
    return { response, state, cookies: headersCookies(response), payload };
  }
  async function account() {
    const receipt = await auth.requestLoginChallenge("fixture@example.test", "root-fixture");
    return auth.verifyLoginChallenge({ challengeId: receipt.challengeId, code: sentCode }, "root-fixture");
  }
  return { database, handlers, request, begin, account, auth, initialized, advance: (ms: number) => { time += ms; }, exchanges: () => exchanges };
}

test("root callback preserves pending browser binding, explicit verified-account link and subsequent original session", async t => {
  const f = await fixture(t), started = await f.begin("/app/projects/original-team");
  assert.equal(started.payload.data.browserBinding, undefined);
  assert.match(started.response.headers.getSetCookie()[0]!, /HttpOnly; SameSite=Lax; Secure/);
  const completed = await f.handlers.callback(f.request(`callback?state=${started.state}&code=fixture-code`, "GET", started.cookies));
  assert.equal(completed.status, 303); assert.equal(completed.headers.get("location"), origin + "/app/account/guancha");
  const pendingCookies = `${started.cookies}; ${headersCookies(completed)}`;
  assert.equal((await (await f.handlers.status(f.request("status", "GET", pendingCookies))).json()).data.pending, true);
  assert.equal((await f.handlers.confirm(f.request("confirm", "POST", pendingCookies, { confirm: true }))).status, 401);
  const grant = await f.account(), allCookies = `${pendingCookies}; __Host-hackathon_session=${grant.sessionToken}`;
  assert.equal((await f.handlers.confirm(f.request("confirm", "POST", allCookies, { confirm: false }))).status, 422);
  const confirmed = await f.handlers.confirm(f.request("confirm", "POST", allCookies, { confirm: true }));
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).data.returnTo, "/app/projects/original-team");
  assert.equal(confirmed.headers.getSetCookie().filter(item => item.includes("Max-Age=0")).length, 2);
  const recovered = (await (await f.handlers.status(f.request("status", "GET", allCookies))).json()).data;
  assert.equal(recovered.linked, true); assert.equal(recovered.returnTo, "/app/projects/original-team");
  assert.equal((await (await f.handlers.status(f.request("status", "GET", pendingCookies))).json()).data.linked, false);
  const second = await f.begin("/events");
  const loggedIn = await f.handlers.callback(f.request(`callback?state=${second.state}&code=fixture-code-2`, "GET", second.cookies));
  assert.equal(loggedIn.headers.get("location"), origin + "/events");
  const session = token(headersCookies(loggedIn), "__Host-hackathon_session");
  assert.equal((await f.auth.getActor(session))?.userId, grant.profile.id);
  assert.deepEqual(f.initialized, [grant.profile.id]); assert.equal(f.exchanges(), 2);
  assert.equal(loggedIn.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await loggedIn.text(), "");
});

test("root rejects origin spoofing, duplicate state/cookies, invalid browser and external returns without leaks", async t => {
  const f = await fixture(t);
  assert.equal((await f.handlers.begin(f.request("begin", "POST", "", {}, "https://untrusted.example"))).status, 403);
  const first = await f.begin("https://untrusted.example/");
  for (const [query, cookies] of [
    [`state=${first.state}&state=${first.state}&code=sensitive-code`, first.cookies],
    [`state=${first.state}&code=sensitive-code`, `${first.cookies}; ${first.cookies}`],
    [`state=${first.state}&code=sensitive-code`, `${browserName}=${"x".repeat(43)}`],
  ]) {
    const response = await f.handlers.callback(f.request(`callback?${query}`, "GET", cookies));
    assert.equal(response.headers.get("location"), origin + "/login?guancha=failed");
    assert.equal((await response.text()).includes("sensitive-code"), false);
  }
  assert.equal(f.exchanges(), 0);
  const cancelled = await f.handlers.callback(f.request(`callback?state=${first.state}&error=access_denied`, "GET", first.cookies));
  assert.equal(cancelled.headers.get("location"), origin + "/login?guancha=cancelled");
  await f.handlers.callback(f.request(`callback?state=${first.state}&code=later`, "GET", first.cookies));
  assert.equal(f.exchanges(), 0);
  const fresh = await f.begin("https://untrusted.example/");
  const pending = await f.handlers.callback(f.request(`callback?state=${fresh.state}&code=fixture-code`, "GET", fresh.cookies));
  const rows = await f.database.query<{ return_to: string }>("SELECT return_to FROM guancha_pending_links");
  assert.equal(rows.rows[0]?.return_to, "/app");
  const cookies = `${fresh.cookies}; ${headersCookies(pending)}`;
  assert.equal((await (await f.handlers.status(f.request("status", "GET", `${cookies}; ${pendingName}=${"x".repeat(43)}`))).json()).data.pending, false);
  f.advance(11 * 60_000);
  assert.equal((await (await f.handlers.status(f.request("status", "GET", cookies))).json()).data.pending, false);
});

test("root status is read-only, starts are globally bounded across caller headers, expiry allows next window", async t => {
  const f = await fixture(t);
  await f.handlers.status(f.request("status"));
  assert.equal((await f.database.query("SELECT * FROM guancha_http_budgets")).rowCount, 0);
  await f.database.query("INSERT INTO guancha_http_budgets VALUES('begin',$1,60)", ["2026-10-12T00:00:00Z"]);
  const limited = await f.handlers.begin(f.request("begin", "POST", "", {}));
  assert.equal(limited.status, 429); assert.equal((await f.database.query("SELECT * FROM guancha_login_attempts")).rowCount, 0);
  f.advance(300_001); await f.begin();
  const budget = await f.database.query<{ attempts: number }>("SELECT attempts FROM guancha_http_budgets");
  assert.equal(budget.rows[0]?.attempts, 1);
});

test("disabled provider does not start or query attempt state and cancellation clears only flow cookies", async t => {
  const f = await fixture(t, false);
  assert.deepEqual((await (await f.handlers.status(f.request("status"))).json()).data, { enabled: false, pending: false, linked: false });
  assert.equal((await f.handlers.begin(f.request("begin", "POST", "", {}))).status, 503);
  const response = await f.handlers.cancel(f.request("cancel", "POST", "", {}));
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.getSetCookie().some(value => value.startsWith("__Host-hackathon_session=")), false);
});

test("configuration requires full server-only credentials, exact HTTPS callback and explicit activation", () => {
  assert.equal(guanchaConfiguration({}, origin), undefined);
  const values = { GUANCHA_CLIENT_ID: "test-id", GUANCHA_CLIENT_SECRET: "test-secret", GUANCHA_REDIRECT_URI: callback };
  assert.equal(guanchaConfiguration(values, origin)?.enabled, false);
  assert.equal(guanchaConfiguration({ ...values, GUANCHA_LOGIN_ENABLED: "true" }, origin)?.enabled, true);
  for (const overrides of [{ GUANCHA_CLIENT_ID: "" }, { GUANCHA_REDIRECT_URI: origin + "/events" }, { GUANCHA_LOGIN_ENABLED: "yes" }]) assert.throws(() => guanchaConfiguration({ ...values, ...overrides }, origin));
  assert.throws(() => guanchaConfiguration(values, "http://localhost:3000"));
  assert.equal(safeAuthReturnTo("/app/account/guancha"), "/app/account/guancha");
  assert.equal(safeAuthReturnTo("/app/account/guancha?returnTo=https://untrusted.example"), "/app");
});
