import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Actor, ProjectAccessPort } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { RepositoryTarget } from "../modules/github/index.ts";
import { createGitHubIntegration, type GitHubIntegrationDependencies } from "./github-integration.ts";

const origin = "https://hackathon.example";
const actor: Actor = { userId: "website-alice", platformRoles: ["user"] };
const clock = { now: () => new Date("2026-10-08T06:00:00.000Z") };
const ids = { next: () => randomUUID() };
const activeKey = Buffer.alloc(32, 42).toString("base64");
const configured: GitHubIntegrationDependencies["config"] = { origin, github: {
  options: { appId: 42, clientId: "Iv1.testClient", clientSecret: "private-client-secret", appSlug: "hackathon-helper", origin,
    callbackUrl: `${origin}/api/v1/github/authorization/callback` },
  credentialKey: activeKey, keyId: "key-v1", previousKeys: {},
} };
const target: RepositoryTarget = { repositoryId: 99, owner: "alice", name: "first-hack", appId: 42, installationId: 17, defaultBranch: "main" };
const accessToken = `ghu_${"A".repeat(40)}`;
const refreshToken = `ghr_${"R".repeat(40)}`;
function jsonRequest(path: string, value: unknown, method = "POST"): Request {
  return new Request(`${origin}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(value) });
}

test("disabled integration never reads storage or calls GitHub and preserves session/mutation guards", async () => {
  let mutations = 0;
  const database: DatabasePort = { async query() { assert.fail("disabled storage accessed"); }, async transaction() { assert.fail("disabled transaction started"); } };
  let signedIn = true;
  const integration = createGitHubIntegration({ config: { origin }, database, clock, ids,
    projectRepository: { async getMembership() { assert.fail("disabled membership read"); } },
    capabilities: { async getCapabilities() { assert.fail("disabled capabilities read"); } },
    resolveActor: async () => signedIn ? actor : null,
    assertMutationAllowed: async request => { mutations++; if (request.headers.get("Origin") !== origin) throw new DomainError("ORIGIN_MISMATCH", "来源不允许。", { status: 403 }); },
    httpTransport: { fetch: async () => { assert.fail("disabled GitHub request"); } },
  });
  assert.equal(integration.authorization, null); assert.equal(integration.creation, null);
  await assert.rejects(integration.credentials.getUserCredential(actor, target), { code: "GITHUB_NOT_CONFIGURED", status: 503 });
  const status = await integration.handler("authorization.status")(new Request(`${origin}/api/v1/github/authorization/status`));
  assert.equal(status.status, 503); assert.equal((await status.json()).error.code, "GITHUB_NOT_CONFIGURED");
  assert.equal(status.headers.get("Cache-Control"), "private, no-store");
  const start = await integration.handler("authorization.start")(jsonRequest("/github/authorization/start", {}));
  assert.equal(start.status, 503); assert.equal(mutations, 1);
  const forbidden = await integration.handler("authorization.start")(new Request(`${origin}/api/v1/github/authorization/start`, {
    method: "POST", headers: { Origin: "https://other.example", "Content-Type": "application/json" }, body: "{}",
  }));
  assert.equal(forbidden.status, 403);
  signedIn = false;
  assert.equal((await integration.handler("authorization.status")(new Request(`${origin}/api/v1/github/authorization/status`))).status, 401);
  assert.equal((await integration.handler("authorization.start")(new Request(`${origin}/api/v1/github/authorization/start`))).status, 405);
});

describe("real App HTTP adapter + AES vault + PostgreSQL stores are composed", { concurrency: false }, () => {
  let engine: PGlite;
  let database: DatabasePort;
  let allowed: boolean;
  let created: boolean;
  let calls: { url: string; method: string; body: Record<string, unknown> | null }[];
  const projectRepository: ProjectAccessPort = { async getMembership(projectId, userId) {
    return allowed ? { membershipId: "membership", projectId, userId, role: "manager", status: "active" } : null;
  } };
  function executor(source: PGlite | Transaction): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, method, body });
    assert.equal(init?.redirect, "error");
    if (url === "https://github.com/login/oauth/access_token") {
      assert.equal(body?.client_id, "Iv1.testClient"); assert.equal(body?.client_secret, "private-client-secret");
      assert.equal(body?.redirect_uri, `${origin}/api/v1/github/authorization/callback`);
      assert.match(String(body?.code_verifier), /^[A-Za-z0-9_-]{43}$/);
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 28800,
        refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "alice", type: "User", access_token: "must-never-propagate" });
    if (url === "https://api.github.com/user/repos" && method === "POST") {
      assert.deepEqual(body, { name: "first-hack", description: "比赛作品", private: true, auto_init: true });
      created = true;
      return Response.json(repository(), { status: 201 });
    }
    if (url === "https://api.github.com/repos/alice/first-hack") return created ? Response.json(repository()) : Response.json({}, { status: 404 });
    if (url === "https://api.github.com/repos/alice/first-hack/git/ref/heads/main") {
      return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } });
    }
    if (url === "https://api.github.com/applications/Iv1.testClient/grant" && method === "DELETE") return new Response(null, { status: 204 });
    assert.fail(`Unexpected mock endpoint: ${method} ${url}`);
  };
  function repository() { return { id: 99, owner: { id: 7, login: "alice", type: "User" }, name: "first-hack", description: "比赛作品", private: true, default_branch: "main" }; }
  function integration(config = configured) {
    return createGitHubIntegration({ config, database, projectRepository, clock, ids,
      capabilities: { async getCapabilities() { return { saveRepository: allowed, verifyDelivery: allowed, recordSubmission: allowed }; } },
      resolveActor: async () => actor,
      assertMutationAllowed: async request => { if (request.headers.get("Origin") !== origin) throw new DomainError("ORIGIN_MISMATCH", "来源不允许。", { status: 403 }); },
      httpTransport: { fetch: fetcher },
    });
  }
  async function bind(instance = integration()) {
    const start = await instance.handler("authorization.start")(jsonRequest("/github/authorization/start", { projectId: "project" }));
    assert.equal(start.status, 200);
    const result = (await start.json()).data;
    const url = new URL(result.authorizationUrl);
    assert.equal(url.origin, "https://github.com"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const cookie = start.headers.get("Set-Cookie")!;
    assert.match(cookie, /HttpOnly; SameSite=Lax; Secure$/);
    const state = url.searchParams.get("state")!;
    const persisted = await engine.query<{ payload: string }>("SELECT row_to_json(s)::text AS payload FROM m06_github_authorization_states s");
    assert.ok(!persisted.rows[0].payload.includes(state));
    assert.ok(!persisted.rows[0].payload.includes(cookie.split(";")[0].split("=")[1]));
    const callbackRequest = () => new Request(`${origin}/api/v1/github/authorization/callback?state=${state}&code=one-use-test-code`, { headers: { Cookie: cookie.split(";")[0] } });
    const callback = await instance.handler("authorization.callback")(callbackRequest());
    assert.equal(callback.status, 303); assert.equal(callback.headers.get("Location"), "/app/projects/project/delivery");
    assert.equal((await instance.handler("authorization.callback")(callbackRequest())).status, 400);
    return instance;
  }
  before(async () => {
    engine = new PGlite();
    await engine.exec(await readFile(new URL("../modules/github/sql/authorization.sql", import.meta.url), "utf8"));
    await engine.exec(await readFile(new URL("../modules/github/sql/repository-creation.sql", import.meta.url), "utf8"));
    const sql = executor(engine);
    database = { query: sql.query, async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) { return engine.transaction(tx => work(executor(tx))); } };
  });
  beforeEach(async () => {
    allowed = true; created = false; calls = [];
    await engine.exec("TRUNCATE github_repository_creation_audit,github_repository_creation_operations,m06_github_authorization_events,m06_github_authorization_credentials,m06_github_authorization_states,m06_github_authorization_epochs");
  });
  after(async () => { await engine.close(); });

  test("callback persists ciphertext only and reusable service yields credentials without public token leakage", async () => {
    const instance = await bind();
    const rows = await engine.query<{ payload: string; encrypted_tokens: { keyId: string } }>("SELECT row_to_json(c)::text AS payload,encrypted_tokens FROM m06_github_authorization_credentials c");
    assert.equal(rows.rows[0].encrypted_tokens.keyId, "key-v1");
    for (const secret of [accessToken, refreshToken, activeKey, "private-client-secret"]) assert.ok(!rows.rows[0].payload.includes(secret));
    const credential = await instance.credentials.getUserCredential(actor, target);
    assert.deepEqual(credential, { token: accessToken, tokenKind: "github_app_user", websiteUserId: actor.userId, githubUserId: 7 });
    const response = await instance.handler("authorization.status")(new Request(`${origin}/api/v1/github/authorization/status`));
    const text = await response.text();
    assert.equal(response.status, 200); assert.equal(JSON.parse(text).data.status, "bound");
    for (const secret of [accessToken, refreshToken, "encryptedTokens", "must-never-propagate"]) assert.ok(!text.includes(secret));
    await assert.rejects(instance.credentials.getUserCredential(actor, { ...target, appId: 43 }), { code: "GITHUB_APP_MISMATCH", status: 403 });
  });

  test("previous encryption key decrypts existing authorization after active key rotation", async () => {
    await bind();
    const rotated = integration({ ...configured, github: { ...configured.github!, credentialKey: Buffer.alloc(32, 9).toString("base64"), keyId: "key-v2", previousKeys: { "key-v1": activeKey } } });
    assert.equal((await rotated.credentials.getUserCredential(actor, target)).token, accessToken);
    const missingPreviousKey = integration({ ...configured, github: { ...configured.github!, credentialKey: Buffer.alloc(32, 9).toString("base64"), keyId: "key-v2", previousKeys: {} } });
    // A missing old key invalidates the local authorization and requires a fresh OAuth flow.
    await assert.rejects(missingPreviousKey.credentials.getUserCredential(actor, target), { code: "GITHUB_AUTHORIZATION_REQUIRED", status: 401 });
  });

  test("preview writes no remote repository; explicit confirmed hash creates one initialized personal repository", async () => {
    const instance = await bind();
    const response = await instance.handler("creation.preview")(jsonRequest("/projects/project/repository-creations", {
      name: "first-hack", description: "比赛作品", private: true, idempotencyKey: "new-repository-1",
    }), { projectId: "project" });
    assert.equal(response.status, 201);
    const preview = (await response.json()).data;
    assert.equal(preview.status, "preview"); assert.equal(created, false);
    const wrong = await instance.handler("creation.confirm")(jsonRequest(`/projects/project/repository-creations/${preview.id}/confirm`, { confirmationHash: "wrong" }), { projectId: "project", operationId: preview.id });
    assert.equal(wrong.status, 409); assert.equal(created, false);
    const confirmation = () => instance.handler("creation.confirm")(jsonRequest(`/projects/project/repository-creations/${preview.id}/confirm`, { confirmationHash: preview.confirmationHash }), { projectId: "project", operationId: preview.id });
    const confirmed = await confirmation();
    assert.equal(confirmed.status, 200);
    const operation = (await confirmed.json()).data;
    assert.equal(operation.status, "created"); assert.equal(operation.repository.initialized, true);
    assert.equal((await confirmation()).status, 200);
    assert.equal(calls.filter(call => call.method === "POST" && call.url.endsWith("/user/repos")).length, 1);
    const audit = await engine.query<{ count: number }>("SELECT count(*)::integer AS count FROM github_repository_creation_audit");
    assert.ok(audit.rows[0].count >= 1);
  });

  test("current project permission is required at confirmation and disconnect removes local token usability", async () => {
    const instance = await bind();
    const preview = await instance.creation!.preview(actor, "project", { name: "first-hack", description: "比赛作品", private: true, idempotencyKey: "new-repository-2" });
    allowed = false;
    const confirmation = await instance.handler("creation.confirm")(jsonRequest(`/projects/project/repository-creations/${preview.id}/confirm`, { confirmationHash: preview.confirmationHash }), { projectId: "project", operationId: preview.id });
    assert.equal(confirmation.status, 404); assert.equal(created, false);
    const disconnect = await instance.handler("authorization.revoke")(new Request(`${origin}/api/v1/github/authorization`, { method: "DELETE", headers: { Origin: origin } }));
    assert.equal(disconnect.status, 200);
    await assert.rejects(instance.credentials.getUserCredential(actor, target), { code: "GITHUB_AUTHORIZATION_REQUIRED", status: 401 });
    const rows = await engine.query<{ encrypted_tokens: unknown; status: string }>("SELECT encrypted_tokens,status FROM m06_github_authorization_credentials");
    assert.equal(rows.rows[0].encrypted_tokens, null); assert.equal(rows.rows[0].status, "revoked");
  });

  test("invalid encryption material or cross-origin callback cannot instantiate a configured integration", () => {
    assert.throws(() => integration({ ...configured, github: { ...configured.github!, credentialKey: "not-an-encryption-key" } }), { code: "CREDENTIAL_CIPHER_CONFIG_INVALID" });
    assert.throws(() => integration({ ...configured, github: { ...configured.github!, options: { ...configured.github!.options, callbackUrl: "https://other.example/api/v1/github/authorization/callback" } } }), { code: "GITHUB_INVALID_CONFIG" });
  });
});
