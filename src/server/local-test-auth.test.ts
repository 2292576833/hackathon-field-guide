import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { createApplication } from "./application.ts";
import { dispatch } from "./router.ts";
import { issueAdminTestAccess } from "./admin-test-access.ts";
import { matchesLocalTestMutation, matchesLocalTestRequest, validateLocalTestOrigin } from "./local-test-auth.ts";

const publicOrigin = "https://public.example.test:44353";
const localOrigin = "http://localhost:3000";
const pepper = "local-auth-integration-fixture-only-pepper";

test("the optional origin accepts only exact localhost:3000 in local mode", () => {
  assert.equal(validateLocalTestOrigin("local"), undefined);
  assert.equal(validateLocalTestOrigin("local", localOrigin), localOrigin);
  for (const [mode, value] of [["connected", localOrigin], ["local", "http://127.0.0.1:3000"], ["local", "http://192.168.1.2:3000"], ["local", "http://localhost:3000/"], ["local", "http://localhost.evil.test:3000"]]) {
    assert.throws(() => validateLocalTestOrigin(mode!, value!));
  }
  const localHeaders = { host: "localhost:3000", origin: localOrigin };
  assert.equal(matchesLocalTestMutation(new Request(`${localOrigin}/api/v1/auth`, { headers: localHeaders }), localOrigin), true);
  assert.equal(matchesLocalTestMutation(new Request("http://127.0.0.1:3000/api/v1/auth", { headers: localHeaders }), localOrigin), true);
  assert.equal(matchesLocalTestMutation(new Request(`${publicOrigin}/api/v1/auth`, { headers: localHeaders }), localOrigin), false);
  assert.equal(matchesLocalTestMutation(new Request(`${localOrigin}/api/v1/auth`, { headers: { ...localHeaders, origin: "https://evil.example.test" } }), localOrigin), false);
  assert.equal(matchesLocalTestRequest(new Request("http://127.0.0.1:3000/api/v1/auth", { headers: { host: "public.example.test:44353", "x-forwarded-host": "localhost:3000" } }), localOrigin), false);
  assert.equal(matchesLocalTestRequest(new Request(`${localOrigin}/api/v1/auth`), localOrigin), false);
});

test("local test login shares one database, isolates cookie names, and keeps the public cookie secure", async () => {
  const database = await createDatabase({});
  try {
    const app = await createApplication({ mode: "local", origin: publicOrigin, localTestOrigin: localOrigin, codePepper: pepper, emailFrom: "fixture@localhost.invalid" }, database);
    const email = "local-admin@example.test", stamp = app.clock.now().toISOString();
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES('local-admin',$1,'隔离管理员','Asia/Shanghai','active',ARRAY['user','admin'],$2,$2,1)", [email, stamp]);
    const issued = await issueAdminTestAccess({ database, codePepper: pepper, email, clock: app.clock });
    const body = { challengeId: issued.challengeId, code: issued.credential.split(".")[1], returnTo: "/admin/organizers" };
    const request = (urlOrigin: string, sourceOrigin: string, path: string, method: string, content?: unknown, cookie?: string) => dispatch(app, new Request(`${urlOrigin}/api/v1/${path}`, { method, headers: { host: new URL(urlOrigin).host, origin: sourceOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(content ? { body: JSON.stringify(content) } : {}) }), path.split("/"));
    const forged = await request(publicOrigin, localOrigin, "auth/login-challenges/verify", "POST", body);
    assert.equal(forged.status, 403);
    const unrelated = await request(localOrigin, "https://evil.example.test", "auth/login-challenges/verify", "POST", body);
    assert.equal(unrelated.status, 403);
    const response = await request(localOrigin, localOrigin, "auth/login-challenges/verify", "POST", body);
    assert.equal(response.status, 200);
    const localCookie = response.headers.get("set-cookie")!;
    assert.match(localCookie, /^hackathon_session=/);
    assert.match(localCookie, /HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(localCookie, /; Secure/);
    const cookie = localCookie.split(";", 1)[0]!;
    assert.equal((await request(localOrigin, localOrigin, "me/permissions", "GET", undefined, cookie)).status, 200);
    assert.equal((await request(publicOrigin, publicOrigin, "me/permissions", "GET", undefined, cookie)).status, 401);
    assert.equal((await request(localOrigin, localOrigin, "me/data-exports", "POST", {}, cookie)).status, 200);
    assert.equal((await request(publicOrigin, localOrigin, "me/data-exports", "POST", {}, cookie)).status, 403);
    assert.equal((await request(localOrigin, localOrigin, "auth/logout", "POST", {}, cookie)).status, 200);
    assert.equal((await request(localOrigin, localOrigin, "me", "GET", undefined, cookie)).status, 401);
    app.clock.now = () => new Date(Date.parse(stamp) + 61_000);
    const next = await issueAdminTestAccess({ database, codePepper: pepper, email, clock: app.clock });
    const publicResponse = await request(publicOrigin, publicOrigin, "auth/login-challenges/verify", "POST", { challengeId: next.challengeId, code: next.credential.split(".")[1] });
    assert.equal(publicResponse.status, 200);
    assert.match(publicResponse.headers.get("set-cookie")!, /^__Host-hackathon_session=.*; Secure$/);
    assert.equal((await database.query("SELECT id FROM development_mailbox")).rowCount, 0);
  } finally { await database.close(); }
});
