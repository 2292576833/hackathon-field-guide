import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import type { GitOperation } from "../types.ts";
import type { StoredAuthorizationState, StoredGitHubCredential } from "../authorization-types.ts";
import { PostgresDraftStore, PostgresGitRepositoryStore } from "../git-postgres.ts";
import { PostgresAuthorizationStore } from "../authorization-postgres.ts";
import { AesGcmCredentialCipher } from "../authorization-vault.ts";
import { createGitHubMaintenance } from "../maintenance.ts";

const now = "2026-10-10T00:00:00.000Z", expired = "2026-10-09T00:00:00.000Z", live = "2099-10-11T00:00:00.000Z";
const files = [{ path: "readme.txt", action: "upsert" as const, content: "private-upload" }];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function operation(id: string, overrides: Partial<GitOperation> = {}): GitOperation {
  return {
    id, projectId: "project", actorId: "alice", bindingId: "binding", bindingRevision: 1,
    target: { repositoryId: 123, owner: "owner", name: "repo", installationId: 12, appId: 42, defaultBranch: "main" },
    idempotencyKey: `key-${id}`, inputHash: hash(id), manifest: { entries: [{ path: "readme.txt", action: "upsert", bytes: 14, contentHash: hash("private-upload"), mode: "100644" }], totalBytes: 14, inputHash: hash("manifest"), issues: [] },
    draftRef: `draft-${id}`, expiresAt: expired, message: "保存版本", wantsPullRequest: false,
    branch: `hackathon/${id}`, status: "ready_for_preview", step: "preview", revision: 4,
    createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T01:00:00.000Z",
    preview: { inputHash: hash(id), baseHeadSha: "base-sha", baseTreeSha: "base-tree", files: [{ path: "readme.txt", action: "modify", before: "private-before", after: "private-after", beforeMode: "100644", afterMode: "100644" }], issues: [], previewHash: "preview-hash", createdAt: "2026-10-08T01:00:00.000Z" },
    treeSha: null, commitSha: null, commitMessage: null, pullRequestUrl: null, pullRequestStatus: "not_requested", errorCode: null, leaseUntil: null,
    ...overrides,
  };
}

describe("maintenance executes actual SQL in an isolated in-memory PGlite fixture", { concurrency: false }, () => {
  let engine: PGlite, db: DatabasePort, drafts: PostgresDraftStore, operations: PostgresGitRepositoryStore, authorization: PostgresAuthorizationStore;
  function executor(source: PGlite | Transaction): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  before(async () => {
    engine = new PGlite();
    await engine.exec(await readFile(new URL("../sql/git.sql", import.meta.url), "utf8"));
    await engine.exec(await readFile(new URL("../sql/authorization.sql", import.meta.url), "utf8"));
    db = { query: executor(engine).query, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { return engine.transaction(tx => work(executor(tx))); } };
    drafts = new PostgresDraftStore(db); operations = new PostgresGitRepositoryStore(db); authorization = new PostgresAuthorizationStore(db);
  });
  beforeEach(async () => {
    await engine.exec("TRUNCATE github_audit_events,github_file_drafts,github_operations,github_repository_bindings,m06_github_authorization_events,m06_github_authorization_credentials,m06_github_authorization_states,m06_github_authorization_epochs");
  });
  after(async () => { await engine.close(); });
  async function seed(item: GitOperation, withDraft = true): Promise<void> {
    await operations.createOperation(item);
    if (withDraft) await db.query("INSERT INTO github_file_drafts (id,project_id,actor_id,payload,bytes,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)", [item.draftRef, item.projectId, item.actorId, JSON.stringify(files), Buffer.byteLength(JSON.stringify(files)), item.expiresAt]);
  }
  async function hasDraft(ref: string): Promise<boolean> {
    return (await db.query("SELECT id FROM github_file_drafts WHERE id=$1", [ref])).rows.length === 1;
  }

  test("expiry clears only private text and advances CAS for previews and draft-only operations", async () => {
    const ready = operation("ready"), draftOnly = operation("draft-only", { status: "draft", step: "draft", preview: null });
    const saved = operation("saved", { status: "saved", step: "done", treeSha: "tree-sha", commitSha: "commit-sha", commitMessage: "confirmed-message" });
    const previewOnly = operation("preview-only"), fresh = operation("fresh", { expiresAt: live });
    for (const item of [ready, draftOnly, saved, fresh]) await seed(item);
    await seed(previewOnly, false);
    const auditBefore = await db.query("SELECT * FROM github_audit_events ORDER BY aggregate_id");
    assert.equal(await drafts.purgeExpired(now), 3);
    for (const original of [ready, draftOnly, saved, previewOnly]) {
      const cleared = (await operations.getOperation(original.projectId, original.id))!;
      assert.equal(cleared.revision, original.revision + 1, original.id); assert.equal(cleared.updatedAt, now);
      assert.deepEqual(cleared, { ...original, revision: original.revision + 1, updatedAt: now, preview: original.preview ? { ...original.preview, files: original.preview.files.map(file => ({ ...file, before: null, after: null })) } : null });
      assert.equal(await hasDraft(original.draftRef), false);
      await assert.rejects(operations.updateOperation({ ...original, revision: original.revision + 1 }, original.revision), { code: "VERSION_CONFLICT" });
    }
    assert.deepEqual(await operations.getOperation("project", fresh.id), fresh); assert.equal(await hasDraft(fresh.draftRef), true);
    assert.deepEqual((await db.query("SELECT * FROM github_audit_events ORDER BY aggregate_id")).rows, auditBefore.rows);
    assert.equal(await drafts.purgeExpired(now), 0);
    assert.equal((await operations.getOperation("project", ready.id))!.revision, 5);
    // A duplicate operation cannot reintroduce expired text or append another creation event.
    assert.equal((await operations.createOperation(ready)).revision, 5);
  });

  test("executing, unknown and resumable operations retain drafts, previews, CAS and recovery metadata", async () => {
    const protectedItems = [
      operation("saving-live", { status: "saving", step: "tree", leaseUntil: live }),
      operation("saving-expired", { status: "saving", step: "commit", leaseUntil: expired, treeSha: "tree-sha" }),
      operation("unknown", { status: "unknown", step: "tree", errorCode: "REMOTE_OBJECT_RESULT_UNKNOWN" }),
      operation("blocked-object", { status: "blocked", step: "commit", treeSha: "tree-sha" }),
      operation("resumable", { step: "branch", treeSha: "tree-sha", commitSha: "commit-sha" }),
      operation("pr-pending", { status: "saved", step: "pull_request", pullRequestStatus: "pending", commitSha: "commit-sha" }),
      operation("pr-unknown", { status: "saved", step: "pull_request", pullRequestStatus: "unknown", commitSha: "commit-sha" }),
      operation("saved-lease", { status: "saved", leaseUntil: expired, commitSha: "commit-sha" }),
    ];
    for (const item of protectedItems) await seed(item);
    assert.equal(await drafts.purgeExpired(now), 0);
    for (const item of protectedItems) {
      assert.deepEqual(await operations.getOperation(item.projectId, item.id), item);
      assert.equal(await hasDraft(item.draftRef), true);
    }
    // Explicit reconciliation settling the operation permits the next purge; expiry alone never settles it.
    const original = protectedItems[2];
    await operations.updateOperation({ ...original, status: "saved", step: "done", revision: 5, commitSha: "confirmed-sha" }, 4);
    assert.equal(await drafts.purgeExpired(now), 1);
    const settled = (await operations.getOperation("project", original.id))!;
    assert.equal(settled.status, "saved"); assert.equal(settled.commitSha, "confirmed-sha"); assert.equal(settled.revision, 6);
    assert.equal(settled.preview!.files[0].after, null);
  });

  test("scope isolation prevents a foreign recovery reference retaining another user's expired draft", async () => {
    const victim = operation("victim", { actorId: "bob", projectId: "other-project" });
    const foreign = operation("foreign", { status: "unknown", draftRef: victim.draftRef });
    await seed(victim); await seed(foreign, false);
    assert.equal(await drafts.get(victim.draftRef, "project", "alice"), null);
    assert.equal(await drafts.purgeExpired(now), 1);
    assert.equal(await hasDraft(victim.draftRef), false);
    assert.equal((await operations.getOperation(victim.projectId, victim.id))!.revision, 5);
    assert.deepEqual(await operations.getOperation("project", foreign.id), foreign);
  });

  test("a draft delete failure rolls back preview redaction and both CAS revisions", async () => {
    const item = operation("rollback"); await seed(item);
    const brokenDb: DatabasePort = { query: db.query, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) {
      return db.transaction(sql => work({ async query<Row>(statement: string, parameters?: readonly unknown[]) {
        if (statement.startsWith("DELETE FROM github_file_drafts")) throw new Error("fixture cleanup failed");
        return sql.query<Row>(statement, parameters);
      } }));
    } };
    await assert.rejects(new PostgresDraftStore(brokenDb).purgeExpired(now), /fixture cleanup failed/u);
    assert.deepEqual(await operations.getOperation("project", item.id), item);
    assert.equal(await hasDraft(item.draftRef), true);
  });

  test("factory cleans expired authorization handles only and preserves token/epoch/refresh unknown state", async () => {
    const vault = new AesGcmCredentialCipher({ activeKeyId: "fixture", keyring: { fixture: Buffer.alloc(32, 31).toString("base64") } });
    const credential: StoredGitHubCredential = {
      userId: "alice", appId: 42, githubUserId: 123, githubLogin: "alice-github",
      encryptedTokens: vault.encrypt({ accessToken: "private-token", refreshToken: "private-refresh" }, "fixture"),
      accessExpiresAt: expired, refreshExpiresAt: expired, status: "active", revision: 1, refreshLeaseUntil: null, checkedAt: expired,
    };
    await authorization.saveCredential(credential, null);
    const refreshing = (await authorization.claimRefresh("alice", 42, 1, expired))!;
    const state = (id: string, expiresAt: string, flow: StoredAuthorizationState["flow"]): StoredAuthorizationState => ({
      stateHash: hash(id), userId: "alice", appId: 42, browserHash: hash(`browser-${id}`), encryptedVerifier: vault.encrypt("private-verifier", "fixture"), projectId: "project", returnTo: "/app/projects/project/delivery", createdAt: "2026-10-08T00:00:00.000Z", expiresAt, authorizationEpoch: 0, flow,
    });
    await authorization.insertState(state("expired-auth", expired, "authorization"));
    await authorization.insertState(state("boundary-install", now, "installation"));
    await authorization.insertState(state("fresh", live, "authorization"));
    const events = await db.query("SELECT * FROM m06_github_authorization_events ORDER BY event_type");
    const item = operation("maintenance"); await seed(item);
    const maintenance = createGitHubMaintenance({ drafts, authorization, clock: { now: () => new Date(now) } });
    assert.deepEqual(await maintenance.run(), { checkedAt: now, expiredDraftsRemoved: 1, expiredStatesRemoved: 2 });
    assert.deepEqual(await authorization.getCredential("alice", 42), refreshing);
    assert.equal(await authorization.getAuthorizationEpoch("alice", 42), 0);
    assert.deepEqual((await db.query("SELECT * FROM m06_github_authorization_events ORDER BY event_type")).rows, events.rows);
    assert.equal((await db.query("SELECT state_hash FROM m06_github_authorization_states")).rows.length, 1);
    assert.deepEqual(await maintenance.run(), { checkedAt: now, expiredDraftsRemoved: 0, expiredStatesRemoved: 0 });
  });
});

test("invalid cleanup times fail without touching the database", async () => {
  let calls = 0;
  const db: DatabasePort = { async query<Row>() { calls++; return { rows: [] as Row[], rowCount: 0 }; }, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { calls++; return work(db); } };
  const drafts = new PostgresDraftStore(db);
  for (const instant of ["invalid", "2026-10-10T00:00:00", "2026-10-10'); DELETE FROM github_operations;--Z"]) await assert.rejects(drafts.purgeExpired(instant), { code: "GITHUB_MAINTENANCE_TIME_INVALID" });
  assert.equal(calls, 0);
});
