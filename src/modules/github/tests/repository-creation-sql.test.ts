import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import type { Actor, ProjectAccessPort } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import { PostgresAuthorizationStore } from "../authorization-postgres.ts";
import { GitHubAuthorizationService } from "../authorization-service.ts";
import { AesGcmCredentialCipher } from "../authorization-vault.ts";
import { PostgresRepositoryCreationStore } from "../repository-creation-postgres.ts";
import { RepositoryCreationService } from "../repository-creation.ts";
import type { CreatedRepository, GitHubAuthorizationHttpPort, RepositoryCreationOperation, StoredGitHubCredential } from "../authorization-types.ts";

const now = "2026-10-08T08:00:00.000Z";
const actor: Actor = { userId: "alice", platformRoles: ["user"] };
const key = Buffer.alloc(32, 72).toString("base64");
const cipher = new AesGcmCredentialCipher({ activeKeyId: "local-sql-test", keyring: { "local-sql-test": key } });
const tokens = { accessToken: `ghu_${"A".repeat(30)}`, refreshToken: `ghr_${"R".repeat(30)}`, accessExpiresAt: "2026-10-08T16:00:00.000Z", refreshExpiresAt: "2027-04-08T08:00:00.000Z" };
function operation(overrides: Partial<RepositoryCreationOperation> = {}): RepositoryCreationOperation {
  return { id: "creation-1", projectId: "project-1", userId: actor.userId, appId: 42, githubUserId: 123,
    owner: "alice-github", name: "hackathon-demo", description: "Team prototype", private: true, autoInit: true,
    idempotencyKey: "creation-key-001", confirmationHash: "confirmation-1", revision: 1, status: "preview", createdAt: now,
    expiresAt: "2026-10-08T08:15:00.000Z", repository: null, errorCode: null, leaseUntil: null, ...overrides };
}

describe("repository creation SQL on ephemeral PGlite PostgreSQL (single-connection fixture)", { concurrency: false }, () => {
  let engine: PGlite;
  let db: DatabasePort;
  let store: PostgresRepositoryCreationStore;
  function executor(source: PGlite | Transaction): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  before(async () => {
    engine = new PGlite();
    // Execute only module migration proposals, never the application's server/private adapters.
    await engine.exec(await readFile(new URL("../sql/authorization.sql", import.meta.url), "utf8"));
    await engine.exec(await readFile(new URL("../sql/repository-creation.sql", import.meta.url), "utf8"));
    const sql = executor(engine);
    db = { query: sql.query, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { return engine.transaction(tx => work(executor(tx))); } };
    store = new PostgresRepositoryCreationStore(db);
  });
  beforeEach(async () => {
    await engine.exec("DROP TRIGGER IF EXISTS fixture_creation_audit_failure ON github_repository_creation_audit");
    await engine.exec("TRUNCATE github_repository_creation_audit,github_repository_creation_operations,m06_github_authorization_events,m06_github_authorization_credentials,m06_github_authorization_states,m06_github_authorization_epochs");
  });
  after(async () => { await engine.close(); });
  async function counts(): Promise<{ operations: number; audit: number }> {
    const result = await engine.query<{ operations: number; audit: number }>("SELECT (SELECT count(*)::integer FROM github_repository_creation_operations) AS operations,(SELECT count(*)::integer FROM github_repository_creation_audit) AS audit");
    return result.rows[0];
  }

  test("concurrent idempotency returns one persisted operation and audit; lookups remain project/user scoped and parameterized", async () => {
    const first = operation({ projectId: "project'); DROP TABLE github_repository_creation_operations;--", userId: "user' OR TRUE--" });
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => store.insert({ ...first, id: `candidate-${index}`, confirmationHash: `hash-${index}` })));
    assert.ok(results.every(result => result.id === results[0].id && result.confirmationHash === results[0].confirmationHash));
    assert.deepEqual(await counts(), { operations: 1, audit: 1 });
    assert.deepEqual(await store.findByKey(first.projectId, first.userId, first.idempotencyKey), results[0]);
    assert.deepEqual(await store.get(first.projectId, first.userId, results[0].id), results[0]);
    assert.equal(await store.get("other-project", first.userId, results[0].id), null);
    assert.equal(await store.get(first.projectId, "other-user", results[0].id), null);
    assert.equal(await store.findByKey(first.projectId, "other-user", first.idempotencyKey), null);
    for (const changed of [{ name: "other-name" }, { private: false }, { owner: "other-owner" }]) {
      await assert.rejects(store.insert({ ...first, ...changed, id: "changed-input" }), { code: "IDEMPOTENCY_KEY_REUSED" });
    }
    assert.deepEqual(await counts(), { operations: 1, audit: 1 });
    await store.insert({ ...first, id: "other-project-operation", projectId: "other-project" });
    await store.insert({ ...first, id: "other-user-operation", userId: "other-user" });
    assert.deepEqual(await counts(), { operations: 3, audit: 3 });
  });

  test("CAS permits one competing transition; stale or changed immutable input cannot alter state or append audit", async () => {
    const preview = operation(); await store.insert(preview);
    const creating = { ...preview, revision: 2, status: "creating" as const, leaseUntil: "2026-10-08T08:05:00.000Z" };
    const blocked = { ...preview, revision: 2, status: "blocked" as const, errorCode: "REPOSITORY_ALREADY_EXISTS" };
    const results = await Promise.allSettled([store.update(creating, 1), store.update(blocked, 1)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "VERSION_CONFLICT").length, 1);
    const winner = (await store.get(preview.projectId, preview.userId, preview.id))!;
    assert.equal(winner.revision, 2); assert.ok(["creating", "blocked"].includes(winner.status));
    await assert.rejects(store.update({ ...preview, revision: 2, status: "unknown" }, 1), { code: "VERSION_CONFLICT" });
    for (const changed of [{ private: false }, { githubUserId: 999 }, { owner: "other-owner" }, { idempotencyKey: "replacement-key" }, { projectId: "other-project" }, { userId: "other-user" }]) {
      await assert.rejects(store.update({ ...winner, ...changed, revision: 3, status: "unknown" }, 2), { code: "VERSION_CONFLICT" });
    }
    assert.deepEqual(await store.get(preview.projectId, preview.userId, preview.id), winner);
    assert.deepEqual(await counts(), { operations: 1, audit: 2 });
    // The database itself rejects revision skew and credential fields, even below the adapter boundary.
    await assert.rejects(engine.query("UPDATE github_repository_creation_operations SET payload=jsonb_set(payload,'{revision}','99'::jsonb) WHERE id=$1", [preview.id]), { code: "23514" });
    await assert.rejects(engine.query("UPDATE github_repository_creation_operations SET payload=payload || $2::jsonb WHERE id=$1", [preview.id, JSON.stringify({ accessToken: tokens.accessToken })]), { code: "23514" });
    assert.deepEqual(await store.get(preview.projectId, preview.userId, preview.id), winner);
  });

  test("a real audit INSERT failure rolls back both creation inserts and CAS updates", async () => {
    await engine.exec("CREATE OR REPLACE FUNCTION fixture_reject_creation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit denied' USING ERRCODE='23514'; END $$");
    const enableFailure = () => engine.exec("CREATE TRIGGER fixture_creation_audit_failure BEFORE INSERT ON github_repository_creation_audit FOR EACH ROW EXECUTE FUNCTION fixture_reject_creation_audit()");
    await enableFailure();
    const preview = operation();
    await assert.rejects(store.insert(preview), { code: "23514" });
    assert.equal(await store.get(preview.projectId, preview.userId, preview.id), null);
    assert.deepEqual(await counts(), { operations: 0, audit: 0 });
    await engine.exec("DROP TRIGGER fixture_creation_audit_failure ON github_repository_creation_audit");
    await store.insert(preview);
    await enableFailure();
    await assert.rejects(store.update({ ...preview, revision: 2, status: "creating", leaseUntil: "2026-10-08T08:05:00.000Z" }, 1), { code: "23514" });
    assert.deepEqual(await store.get(preview.projectId, preview.userId, preview.id), preview);
    assert.deepEqual(await counts(), { operations: 1, audit: 1 });
  });

  test("acknowledged repository ID survives readback uncertainty and a new service instance reconciles by GET without another POST", async () => {
    const authorizationStore = new PostgresAuthorizationStore(db);
    const credential: StoredGitHubCredential = { userId: actor.userId, appId: 42, githubUserId: 123, githubLogin: "alice-github",
      encryptedTokens: cipher.encrypt(tokens, JSON.stringify(["github-app-tokens", actor.userId, 42, 123])),
      accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt,
      status: "active", revision: 1, refreshLeaseUntil: null, checkedAt: now };
    await authorizationStore.saveCredential(credential, null, 0);
    const repository: CreatedRepository = { repositoryId: 987, owner: "alice-github", name: "hackathon-demo", private: true,
      url: "https://github.com/alice-github/hackathon-demo", defaultBranch: "main", initialized: false, description: "Team prototype" };
    let posts = 0, readbackUnavailable = false, created: CreatedRepository | null = null, nextId = 0;
    const unused = async (): Promise<never> => { throw new Error("unexpected HTTP call"); };
    const http: GitHubAuthorizationHttpPort = {
      exchangeCode: unused, refreshToken: unused, revokeGrant: unused, revokeToken: unused, listInstallations: unused, listRepositories: unused,
      async getIdentity(accessToken) { assert.equal(accessToken, tokens.accessToken); return { id: 123, login: "alice-github", profileUrl: "https://github.com/alice-github" }; },
      async getRepository(accessToken, owner, name) {
        assert.equal(accessToken, tokens.accessToken); assert.equal(owner, repository.owner); assert.equal(name, repository.name);
        if (readbackUnavailable) throw new DomainError("GITHUB_REQUEST_FAILED", "仓库读回暂时不可用。", { status: 503 });
        return created ? structuredClone(created) : null;
      },
      async createRepository(accessToken, input) {
        assert.equal(accessToken, tokens.accessToken); assert.deepEqual(input, { name: repository.name, description: repository.description, private: true });
        posts += 1; readbackUnavailable = true; created = structuredClone(repository); return structuredClone(repository);
      },
    };
    const access: ProjectAccessPort = { async getMembership(projectId, userId) { return { membershipId: "membership-1", projectId, userId, role: "manager", status: "active" }; } };
    const clock = { now: () => new Date(now) }, ids = { next: () => `persistent-operation-${++nextId}` };
    function service() {
      const credentials = new GitHubAuthorizationService({ options: { appId: 42, clientId: "Iv1.test", clientSecret: "fake-secret", appSlug: "test-app", origin: "https://example.test", callbackUrl: "https://example.test/api/v1/github/authorization/callback" },
        store: new PostgresAuthorizationStore(db), cipher, http, access, clock, ids });
      return new RepositoryCreationService({ appId: 42, credentials, http, store: new PostgresRepositoryCreationStore(db), access,
        capabilities: { async getCapabilities() { return { saveRepository: true, verifyDelivery: false, recordSubmission: false }; } }, clock, ids });
    }
    const input = { name: repository.name, description: repository.description, private: true, idempotencyKey: "durable-creation-key" };
    const firstService = service(), preview = await firstService.preview(actor, "project-1", input);
    assert.equal(posts, 0);
    const uncertain = await firstService.confirm(actor, "project-1", preview.id, preview.confirmationHash);
    assert.equal(uncertain.status, "unknown"); assert.equal(uncertain.repository?.repositoryId, 987); assert.equal(uncertain.repository?.initialized, false); assert.equal(posts, 1);
    const restarted = service();
    assert.deepEqual(await restarted.get(actor, "project-1", preview.id), uncertain);
    assert.equal((await restarted.confirm(actor, "project-1", preview.id, preview.confirmationHash)).status, "unknown");
    readbackUnavailable = false; created = { ...repository, initialized: true };
    const reconciled = await restarted.reconcile(actor, "project-1", preview.id);
    assert.equal(reconciled.status, "created"); assert.equal(reconciled.repository?.repositoryId, 987); assert.equal(reconciled.repository?.initialized, true);
    assert.deepEqual(await service().preview(actor, "project-1", input), reconciled); assert.equal(posts, 1);
    assert.equal((await authorizationStore.getCredential(actor.userId, 42))?.revision, 1);
    const rows = await engine.query<{ event_type: string; details: { status: string; repositoryId: number | null } }>("SELECT event_type,details FROM github_repository_creation_audit ORDER BY revision");
    assert.deepEqual(rows.rows.map(row => row.details.status), ["preview", "creating", "creating", "unknown", "created"]);
    assert.equal(rows.rows.at(-1)?.event_type, "RepositoryCreated"); assert.equal(rows.rows.at(-1)?.details.repositoryId, 987);
    const stored = await engine.query<{ payload: string }>("SELECT payload::text AS payload FROM github_repository_creation_operations UNION ALL SELECT details::text FROM github_repository_creation_audit UNION ALL SELECT details::text FROM m06_github_authorization_events");
    const serialized = JSON.stringify(stored.rows);
    for (const secret of [tokens.accessToken, tokens.refreshToken, credential.encryptedTokens!.data, key, "fake-secret"]) assert.ok(!serialized.includes(secret));
  });
});
