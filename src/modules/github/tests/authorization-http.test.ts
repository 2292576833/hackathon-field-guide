import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { GitHubAppAuthorizationHttpAdapter } from "../authorization-http.ts";
import { GitHubHttpError, GITHUB_API_VERSION } from "../github-http.ts";
import type { GitHubAppOptions, GitHubInstallation } from "../authorization-types.ts";

const access = `ghu_${"A".repeat(36)}`, refresh = `ghr_${"R".repeat(36)}`, rotated = `ghr_${"N".repeat(36)}`;
const options: GitHubAppOptions = { appId: 9, clientId: "Iv1.fixture", clientSecret: "fixture-app-secret", appSlug: "fixture-app", origin: "https://field.test", callbackUrl: "https://field.test/api/github/callback" };
const now = new Date("2026-10-08T00:00:00.000Z"), verifier = "v".repeat(43), code = "fixture-authorization-code";
const tokens = { access_token: access, refresh_token: refresh, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" };
const user = { id: 7, login: "alice", type: "User", temp_clone_token: access, token: access, html_url: `https://github.com/alice?token=${access}` };
const installationResponse = { id: 8, app_id: 9, account: { login: "alice", type: "User" }, repository_selection: "selected", suspended_at: null, permissions: { metadata: "read", contents: "write", pull_requests: "read", token: access } };
const installation: GitHubInstallation = { id: 8, appId: 9, accountLogin: "alice", accountType: "User", repositorySelection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "read" }, suspended: false };
const repository = { id: 42, owner: { id: 7, login: "alice", type: "User" }, name: "demo", default_branch: "main", description: "demo project", private: true, permissions: { push: true }, archived: false, disabled: false, size: 100, temp_clone_token: access, html_url: `https://github.com/alice/demo?token=${access}` };
const reference = { ref: "refs/heads/main", object: { type: "commit", sha: "1".repeat(40) } };
type Step = { path: string; oauth?: boolean; method?: "GET" | "POST" | "DELETE"; body?: unknown; basic?: boolean; status?: number; data?: unknown; headers?: HeadersInit; run?: (init: RequestInit) => Promise<Response> };

function mock(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    const step = steps[calls.length - 1]; assert.ok(step, "Unexpected request");
    assert.equal(url, `${step.oauth ? "https://github.com" : "https://api.github.com"}${step.path}`);
    assert.equal(init.method, step.method ?? "GET"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-github-api-version"), GITHUB_API_VERSION);
    assert.equal(headers.get("accept"), step.oauth ? "application/json" : "application/vnd.github+json");
    assert.equal(headers.get("authorization"), step.oauth ? null : step.basic ? `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}` : `Bearer ${access}`);
    if (step.body !== undefined) { assert.equal(headers.get("content-type"), "application/json"); assert.deepEqual(JSON.parse(String(init.body)), step.body); }
    if (step.run) return step.run(init);
    return new Response((step.status ?? 200) === 204 ? null : JSON.stringify(step.data ?? {}), { status: step.status ?? 200, headers: step.headers });
  };
  const adapter = (extras: { timeoutMs?: number; maxResponseBytes?: number; maxPages?: number } = {}) => new GitHubAppAuthorizationHttpAdapter(options, { fetch: fetcher, clock: { now: () => now }, ...extras });
  return { adapter, calls, done: () => assert.equal(calls.length, steps.length) };
}
function expected(code: string, unknown = false) {
  return (error: unknown) => {
    assert.ok(error instanceof GitHubHttpError); assert.equal(error.code, code); assert.equal(error.outcomeUnknown, unknown);
    const encoded = JSON.stringify(error);
    for (const secret of [access, refresh, rotated, options.clientSecret, verifier, "fixture-authorization-code"]) assert.ok(!encoded.includes(secret));
    return true;
  };
}
function exchange(data: unknown = tokens): Step {
  return { path: "/login/oauth/access_token", oauth: true, method: "POST", body: { client_id: options.clientId, client_secret: options.clientSecret, code, code_verifier: verifier, redirect_uri: options.callbackUrl }, data };
}
function refreshStep(data: unknown = { ...tokens, refresh_token: rotated }): Step {
  return { path: "/login/oauth/access_token", oauth: true, method: "POST", body: { client_id: options.clientId, client_secret: options.clientSecret, grant_type: "refresh_token", refresh_token: refresh }, data };
}

test("PKCE exchange sends only the exact server client/code/verifier/callback payload and computes expiry from injected clock", async () => {
  const transport = mock([exchange()]);
  assert.deepEqual(await transport.adapter().exchangeCode({ code, codeVerifier: verifier, redirectUri: options.callbackUrl }), { accessToken: access, refreshToken: refresh, accessExpiresAt: "2026-10-08T08:00:00.000Z", refreshExpiresAt: "2027-04-10T00:00:00.000Z" });
  transport.done();
});

test("exchange rejects alternate redirects and invalid verifier before any request", async () => {
  const transport = mock([]); const adapter = transport.adapter();
  for (const input of [{ code, codeVerifier: verifier, redirectUri: "https://evil.test/callback" }, { code, codeVerifier: "short", redirectUri: options.callbackUrl }, { code: "bad\r\ncode", codeVerifier: verifier, redirectUri: options.callbackUrl }]) {
    await assert.rejects(adapter.exchangeCode(input), expected("GITHUB_INVALID_AUTHORIZATION_INPUT"));
  }
  transport.done();
});

test("OAuth scopes, token kinds, missing expiry or nonrotating refresh are rejected without returning token material", async () => {
  for (const data of [{ ...tokens, scope: "repo" }, { ...tokens, access_token: "gho_" + "A".repeat(36) }, { ...tokens, refresh_token: undefined }, { ...tokens, expires_in: undefined }, { ...tokens, expires_in: 0 }, { ...tokens, token_type: "mac" }, [tokens]]) {
    const transport = mock([exchange(data)]);
    await assert.rejects(transport.adapter().exchangeCode({ code, codeVerifier: verifier, redirectUri: options.callbackUrl }), expected("GITHUB_OUTCOME_UNKNOWN", true));
    transport.done();
  }
  const nonrotating = mock([refreshStep(tokens)]);
  await assert.rejects(nonrotating.adapter().refreshToken(refresh), expected("GITHUB_OUTCOME_UNKNOWN", true));
  nonrotating.done();
  const offline = mock([exchange({ ...tokens, scope: "offline_access" })]);
  assert.equal((await offline.adapter().exchangeCode({ code, codeVerifier: verifier, redirectUri: options.callbackUrl })).accessToken, access);
  offline.done();
});

test("refresh sends a single-use grant once, returns rotated expiring tokens and never retries lost results", async () => {
  const transport = mock([refreshStep()]);
  assert.equal((await transport.adapter().refreshToken(refresh)).refreshToken, rotated); transport.done();
  for (const scenario of [
    { run: async () => { throw new Error(options.clientSecret); } },
    { run: async () => new Promise<Response>(() => {}) },
    { status: 502, data: { message: refresh } },
  ] as Partial<Step>[]) {
    const transport = mock([{ ...refreshStep(), ...scenario }]);
    await assert.rejects(transport.adapter({ timeoutMs: 20 }).refreshToken(refresh), expected("GITHUB_OUTCOME_UNKNOWN", true));
    transport.done(); assert.equal(transport.calls.length, 1);
  }
});

test("explicit OAuth error responses are sanitized known rejection and do not expose descriptions", async () => {
  const transport = mock([refreshStep({ error: "bad_refresh_token", error_description: refresh, error_uri: `https://example.test/${options.clientSecret}` })]);
  await assert.rejects(transport.adapter().refreshToken(refresh), expected("GITHUB_REFRESH_REJECTED")); transport.done();
  const denied = mock([exchange({ error: "bad_verification_code", error_description: code })]);
  await assert.rejects(denied.adapter().exchangeCode({ code, codeVerifier: verifier, redirectUri: options.callbackUrl }), expected("GITHUB_AUTHORIZATION_REJECTED")); denied.done();
});

test("grant revocation uses application client Basic auth and token JSON, accepts only 204", async () => {
  const transport = mock([{ path: `/applications/${options.clientId}/grant`, method: "DELETE", basic: true, body: { access_token: access }, status: 204 }]);
  await transport.adapter().revokeGrant(access); transport.done();
  const unknown = mock([{ path: `/applications/${options.clientId}/grant`, method: "DELETE", basic: true, status: 503, data: { token: access } }]);
  await assert.rejects(unknown.adapter().revokeGrant(access), expected("GITHUB_OUTCOME_UNKNOWN", true)); unknown.done();
});

test("single-token cleanup targets /token and never revokes the user's application grant", async () => {
  const transport = mock([{ path: `/applications/${options.clientId}/token`, method: "DELETE", basic: true, body: { access_token: access }, status: 204 }]);
  await transport.adapter().revokeToken(access); transport.done();
  assert.ok(transport.calls.every(call => !call.url.endsWith("/grant")));
  const lost = mock([{ path: `/applications/${options.clientId}/token`, method: "DELETE", basic: true, body: { access_token: access }, run: async () => { throw new Error(access); } }]);
  await assert.rejects(lost.adapter().revokeToken(access), expected("GITHUB_OUTCOME_UNKNOWN", true)); lost.done();
});

test("identity projects only user ID/login/safe profile URL and rejects non-App access tokens locally", async () => {
  const transport = mock([{ path: "/user", data: user }]);
  assert.deepEqual(await transport.adapter().getIdentity(access), { id: 7, login: "alice", profileUrl: "https://github.com/alice" }); transport.done();
  const noRequests = mock([]);
  for (const other of ["ghs_" + "A".repeat(36), "gho_" + "A".repeat(36), `${access}\r\n`]) await assert.rejects(noRequests.adapter().getIdentity(other), expected("GITHUB_APP_USER_TOKEN_REQUIRED"));
  noRequests.done();
});

test("installation pagination constructs fixed-host pages and excludes other Apps, suspended installs and provider secrets", async () => {
  const fillers = Array.from({ length: 100 }, (_, index) => ({ ...installationResponse, id: 1000 + index, app_id: 99 }));
  const transport = mock([
    { path: "/user/installations?per_page=100&page=1", data: { total_count: 102, installations: fillers }, headers: { link: '<https://untrusted.test/token>; rel="next"' } },
    { path: "/user/installations?per_page=100&page=2", data: { total_count: 102, installations: [installationResponse, { ...installationResponse, id: 80, suspended_at: "2026-10-08T00:00:00Z" }] } },
  ]);
  assert.deepEqual(await transport.adapter().listInstallations(access), [installation]); transport.done();
});

test("repository discovery projects IDs and user/App permission intersections and suppresses token/provider URLs", async () => {
  const transport = mock([{ path: "/user/installations/8/repositories?per_page=100&page=1", data: { total_count: 3, repositories: [repository, { ...repository, id: 43, permissions: { push: false } }, { ...repository, id: 44, archived: true }] } }]);
  const repositories = await transport.adapter().listRepositories(access, installation);
  assert.equal(repositories[0].contentsWrite, true); assert.equal(repositories[0].pullRequestsWrite, false);
  assert.equal(repositories[0].url, "https://github.com/alice/demo");
  assert.deepEqual(repositories.slice(1).map(value => [value.userCanPush, value.contentsWrite, value.pullRequestsWrite]), [[false, false, false], [false, false, false]]);
  assert.ok(!JSON.stringify(repositories).includes(access)); transport.done();
  const rejected = mock([]);
  await assert.rejects(rejected.adapter().listRepositories(access, { ...installation, appId: 99 }), expected("GITHUB_INSTALLATION_REVOKED")); rejected.done();
});

test("repository lookup needs an exact ref initialization proof; size alone never counts", async () => {
  const initialized = mock([{ path: "/repos/alice/demo", data: repository }, { path: "/repos/alice/demo/git/ref/heads/main", data: reference }]);
  assert.equal((await initialized.adapter().getRepository(access, "alice", "demo"))?.initialized, true); initialized.done();
  const empty = mock([{ path: "/repos/alice/demo", data: { ...repository, size: 999 } }, { path: "/repos/alice/demo/git/ref/heads/main", status: 404 }]);
  assert.equal((await empty.adapter().getRepository(access, "alice", "demo"))?.initialized, false); empty.done();
  const nonexistent = mock([{ path: "/repos/alice/demo", status: 404 }]);
  assert.equal(await nonexistent.adapter().getRepository(access, "alice", "demo"), null); nonexistent.done();
  const wrong = mock([{ path: "/repos/alice/demo", data: repository }, { path: "/repos/alice/demo/git/ref/heads/main", data: { ...reference, ref: "refs/heads/main-old" } }]);
  await assert.rejects(wrong.adapter().getRepository(access, "alice", "demo"), expected("GITHUB_INVALID_RESPONSE")); wrong.done();
});

test("personal repository creation checks identity, posts auto_init once and reads back the same initialized repository", async () => {
  const input = { name: "demo", description: "demo project", private: true };
  const transport = mock([
    { path: "/user", data: user },
    { path: "/user/repos", method: "POST", status: 201, body: { ...input, auto_init: true }, data: repository },
    { path: "/repos/alice/demo", data: repository },
    { path: "/repos/alice/demo/git/ref/heads/main", data: reference },
  ]);
  assert.deepEqual(await transport.adapter().createRepository(access, input), { repositoryId: 42, owner: "alice", name: "demo", url: "https://github.com/alice/demo", private: true, defaultBranch: "main", initialized: true, description: "demo project" });
  assert.equal(transport.calls.filter(call => call.init.method === "POST").length, 1); transport.done();
});

test("repository description uses the same Unicode character budget as the preview service", async () => {
  const description = "🚀".repeat(350), input = { name: "demo", description, private: true }, unicodeRepository = { ...repository, description };
  const transport = mock([
    { path: "/user", data: user },
    { path: "/user/repos", method: "POST", status: 201, body: { ...input, auto_init: true }, data: unicodeRepository },
    { path: "/repos/alice/demo", data: unicodeRepository },
    { path: "/repos/alice/demo/git/ref/heads/main", data: reference },
  ]);
  assert.equal((await transport.adapter().createRepository(access, input)).description, description); transport.done();
  const denied = mock([]);
  await assert.rejects(denied.adapter().createRepository(access, { ...input, description: description + "🚀" }), expected("GITHUB_INVALID_INPUT"));
  await assert.rejects(denied.adapter().createRepository(access, { ...input, description: "bad\u202evalue" }), expected("GITHUB_INVALID_INPUT")); denied.done();
});

test("repository POST unknown is not retried; acknowledged creation retains ID when initialization readback is incomplete", async () => {
  const input = { name: "demo", description: "demo project", private: true };
  const denied = mock([{ path: "/user", data: user }, { path: "/user/repos", method: "POST", status: 403, data: { message: options.clientSecret } }]);
  await assert.rejects(denied.adapter().createRepository(access, input), expected("GITHUB_PERMISSION_DENIED")); denied.done();
  for (const scenario of [{ status: 502, data: { message: access } }, { run: async () => new Promise<Response>(() => {}) }, { status: 202, data: repository }] as Partial<Step>[]) {
    const transport = mock([{ path: "/user", data: user }, { path: "/user/repos", method: "POST", ...scenario }]);
    await assert.rejects(transport.adapter({ timeoutMs: 20 }).createRepository(access, input), expected("GITHUB_OUTCOME_UNKNOWN", true));
    transport.done(); assert.equal(transport.calls.filter(call => call.init.method === "POST").length, 1);
  }
  for (const followUp of [{ status: 404 }, { run: async () => { throw new Error(access); } }] as Partial<Step>[]) {
    const transport = mock([{ path: "/user", data: user }, { path: "/user/repos", method: "POST", status: 201, data: repository }, { path: "/repos/alice/demo", ...followUp }]);
    const acknowledged = await transport.adapter().createRepository(access, input);
    assert.equal(acknowledged.repositoryId, 42); assert.equal(acknowledged.owner, "alice"); assert.equal(acknowledged.private, true); assert.equal(acknowledged.initialized, false);
    assert.ok(!JSON.stringify(acknowledged).includes(access));
    transport.done(); assert.equal(transport.calls.filter(call => call.init.method === "POST").length, 1);
  }
  const uninitialized = mock([{ path: "/user", data: user }, { path: "/user/repos", method: "POST", status: 201, data: repository }, { path: "/repos/alice/demo", data: repository }, { path: "/repos/alice/demo/git/ref/heads/main", status: 404 }]);
  const acknowledged = await uninitialized.adapter().createRepository(access, input);
  assert.equal(acknowledged.repositoryId, 42); assert.equal(acknowledged.initialized, false); uninitialized.done();
  const replaced = mock([{ path: "/user", data: user }, { path: "/user/repos", method: "POST", status: 201, data: repository }, { path: "/repos/alice/demo", data: { ...repository, id: 99 } }, { path: "/repos/alice/demo/git/ref/heads/main", data: reference }]);
  const original = await replaced.adapter().createRepository(access, input);
  assert.equal(original.repositoryId, 42); assert.equal(original.initialized, false); replaced.done();
});

test("repository creation rejects organization/template/override fields and creation responses belonging to another identity", async () => {
  const input = { name: "demo", description: "demo project", private: true };
  const noRequests = mock([]);
  for (const extra of [{ owner: "org" }, { org: "org" }, { template: "template" }, { auto_init: false }, { token: access }]) {
    await assert.rejects(noRequests.adapter().createRepository(access, { ...input, ...extra }), expected("GITHUB_INVALID_INPUT"));
  }
  noRequests.done();
  const mismatched = mock([{ path: "/user", data: user }, { path: "/user/repos", method: "POST", status: 201, data: { ...repository, owner: { id: 88, login: "organization", type: "Organization" } } }]);
  await assert.rejects(mismatched.adapter().createRepository(access, input), expected("GITHUB_OUTCOME_UNKNOWN", true)); mismatched.done();
});

test("body, page and timeout limits fail closed and provider error bodies remain private", async () => {
  const oversized = mock([{ path: "/user", data: user, headers: { "content-length": "99999999" } }]);
  await assert.rejects(oversized.adapter({ maxResponseBytes: 10 }).getIdentity(access), expected("GITHUB_INVALID_RESPONSE")); oversized.done();
  const capped = mock([{ path: "/user/installations?per_page=100&page=1", data: { total_count: 101, installations: Array.from({ length: 100 }, () => installationResponse) } }]);
  await assert.rejects(capped.adapter({ maxPages: 1 }).listInstallations(access), expected("GITHUB_PAGINATION_LIMIT")); capped.done();
  const limited = mock([{ path: "/user", status: 429, headers: { "retry-after": "30" }, data: { token: access } }]);
  await assert.rejects(limited.adapter().getIdentity(access), error => { expected("GITHUB_RATE_LIMITED")(error); assert.equal((error as GitHubHttpError).retryAt, "2026-10-08T00:00:30.000Z"); return true; }); limited.done();
});
