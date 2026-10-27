import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import { AesGcmCredentialCipher } from "../authorization-vault.ts";
import { PostgresAuthorizationStore } from "../authorization-postgres.ts";
import type { StoredAuthorizationState, StoredGitHubCredential } from "../authorization-types.ts";

const key = Buffer.alloc(32, 31).toString("base64");
const vault = new AesGcmCredentialCipher({ activeKeyId: "test-key", keyring: { "test-key": key } });
const now = "2026-10-08T03:00:00.000Z";
const tokenValues = { accessToken: "fake-private-access-token", refreshToken: "fake-private-refresh-token" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function state(overrides: Partial<StoredAuthorizationState> = {}): StoredAuthorizationState {
  return { stateHash: hash("raw-state-not-stored"), userId: "alice", appId: 42, browserHash: hash("raw-browser-not-stored"), encryptedVerifier: vault.encrypt("fake-private-pkce-verifier", JSON.stringify(["github-app-state", "alice", 42, hash("raw-state-not-stored")])), projectId: "project", returnTo: "/app/projects/project/delivery", createdAt: "2026-10-08T02:59:00.000Z", expiresAt: "2026-10-08T03:10:00.000Z", authorizationEpoch: 0, flow: "authorization", ...overrides };
}
function credential(overrides: Partial<StoredGitHubCredential> = {}): StoredGitHubCredential {
  const result: StoredGitHubCredential = { userId: "alice", appId: 42, githubUserId: 123, githubLogin: "alice-github", encryptedTokens: null, accessExpiresAt: "2026-10-08T11:00:00.000Z", refreshExpiresAt: "2027-04-08T03:00:00.000Z", status: "active", revision: 1, refreshLeaseUntil: null, checkedAt: now, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(overrides, "encryptedTokens") && (result.status === "active" || result.status === "refreshing")) result.encryptedTokens = vault.encrypt(tokenValues, JSON.stringify(["github-app-tokens", result.userId, result.appId, result.githubUserId]));
  return result;
}
function consumeInput(item = state()) {
  return { stateHash: item.stateHash, userId: item.userId, appId: item.appId, browserHash: item.browserHash, flow: item.flow, now };
}

describe("ephemeral PGlite PostgreSQL executes authorization SQL (single-connection fixture)", { concurrency: false }, () => {
  let engine: PGlite;
  let db: DatabasePort;
  let store: PostgresAuthorizationStore;
  function executor(source: PGlite | Transaction): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await source.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  before(async () => {
    engine = new PGlite();
    await engine.exec(await readFile(new URL("../sql/authorization.sql", import.meta.url), "utf8"));
    const sql = executor(engine);
    db = { query: sql.query, async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) { return engine.transaction(tx => work(executor(tx))); } };
    store = new PostgresAuthorizationStore(db);
  });
  beforeEach(async () => { await engine.exec("TRUNCATE m06_github_authorization_events,m06_github_authorization_credentials,m06_github_authorization_states,m06_github_authorization_epochs"); });
  after(async () => { await engine.close(); });
  async function count(table: string): Promise<number> {
    const allowed = ["m06_github_authorization_states", "m06_github_authorization_credentials", "m06_github_authorization_events", "m06_github_authorization_epochs"];
    assert.ok(allowed.includes(table));
    const result = await engine.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
    return result.rows[0].count;
  }

  test("state persists only hashes and encrypted PKCE with project, return path, epoch and flow", async () => {
    const item = state();
    assert.equal(await store.getAuthorizationEpoch("alice", 42), 0);
    await store.insertState(item);
    const stored = await engine.query<{ payload: string }>("SELECT row_to_json(s)::text AS payload FROM m06_github_authorization_states s");
    for (const plain of ["raw-state-not-stored", "raw-browser-not-stored", "fake-private-pkce-verifier"]) assert.ok(!stored.rows[0].payload.includes(plain));
    const consumed = await store.consumeState(consumeInput(item));
    assert.deepEqual(consumed, item);
    assert.equal(vault.decrypt(consumed!.encryptedVerifier, JSON.stringify(["github-app-state", "alice", 42, item.stateHash])), "fake-private-pkce-verifier");
    assert.equal(await store.consumeState(consumeInput(item)), null);
  });

  test("mismatched user, App, browser, flow or expiry does not consume a valid state", async () => {
    const item = state(); await store.insertState(item);
    const valid = consumeInput(item);
    for (const wrong of [{ ...valid, userId: "mallory" }, { ...valid, appId: 43 }, { ...valid, browserHash: hash("other-browser") }, { ...valid, flow: "installation" as const }, { ...valid, now: item.expiresAt }]) {
      assert.equal(await store.consumeState(wrong), null);
      assert.equal(await count("m06_github_authorization_states"), 1);
    }
    assert.equal((await store.consumeState(valid))?.stateHash, item.stateHash);
  });

  test("simultaneous callback consumers receive exactly one returned state", async () => {
    const item = state(); await store.insertState(item);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeState(consumeInput(item))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await count("m06_github_authorization_states"), 0);
  });

  test("expiry purge removes only expired states and duplicate handles cannot replace the original", async () => {
    const old = state({ stateHash: hash("old"), createdAt: "2026-10-08T02:00:00.000Z", expiresAt: "2026-10-08T03:00:00.000Z" });
    const live = state({ stateHash: hash("live"), flow: "installation" });
    await store.insertState(old); await store.insertState(live);
    await assert.rejects(store.insertState({ ...live, returnTo: "/different" }), { code: "AUTHORIZATION_STATE_CONFLICT" });
    assert.equal(await store.purgeExpiredStates(now), 1);
    assert.deepEqual(await store.consumeState(consumeInput(live)), live);
  });

  test("credential insert and update use CAS; one concurrent writer wins and only winners are audited", async () => {
    const first = credential(), alternative = credential({ githubUserId: 124, githubLogin: "other" });
    const inserted = await Promise.allSettled([store.saveCredential(first, null, 0), store.saveCredential(alternative, null, 0)]);
    assert.equal(inserted.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(inserted.filter(result => result.status === "rejected" && result.reason.code === "VERSION_CONFLICT").length, 1);
    const current = (await store.getCredential("alice", 42))!;
    assert.equal(current.revision, 1);
    const a = { ...current, revision: 2, githubLogin: "updated-a" }, b = { ...current, revision: 2, githubLogin: "updated-b" };
    const updates = await Promise.allSettled([store.saveCredential(a, 1), store.saveCredential(b, 1)]);
    assert.equal(updates.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await store.getCredential("alice", 42))!.revision, 2);
    assert.equal(await count("m06_github_authorization_events"), 2);
    await assert.rejects(store.saveCredential({ ...current, revision: 4 }, 2), { code: "VERSION_CONFLICT" });
    assert.equal(await count("m06_github_authorization_events"), 2);
  });

  test("refresh claim is single-owner and never reclaims an expired refreshing lease", async () => {
    await store.saveCredential(credential(), null);
    const lease = "2026-10-08T02:59:00.000Z"; // Deliberately expired: a second worker must still not replay refresh.
    const claims = await Promise.all(Array.from({ length: 6 }, () => store.claimRefresh("alice", 42, 1, lease)));
    const winner = claims.find(Boolean)!;
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(winner.status, "refreshing"); assert.equal(winner.revision, 2); assert.equal(winner.refreshLeaseUntil, lease);
    assert.equal(await store.claimRefresh("alice", 42, 2, "2026-10-08T03:01:00.000Z"), null);
    await store.saveCredential({ ...winner, status: "reauthorize_required", encryptedTokens: null, refreshLeaseUntil: null, revision: 3 }, 2);
    assert.equal(await store.claimRefresh("alice", 42, 3, "2026-10-08T03:02:00.000Z"), null);
    assert.equal((await store.getCredential("alice", 42))!.status, "reauthorize_required");
  });

  test("successful refresh stores new ciphertext and records metadata without tokens or envelopes", async () => {
    await store.saveCredential(credential(), null);
    const claimed = (await store.claimRefresh("alice", 42, 1, "2026-10-08T03:01:00.000Z"))!;
    const nextTokens = vault.encrypt({ accessToken: "rotated-private-token", refreshToken: "rotated-private-refresh" }, JSON.stringify(["github-app-tokens", "alice", 42, 123]));
    await store.saveCredential({ ...claimed, encryptedTokens: nextTokens, status: "active", refreshLeaseUntil: null, revision: 3 }, 2);
    const current = (await store.getCredential("alice", 42))!;
    assert.deepEqual(current.encryptedTokens, nextTokens);
    const events = await engine.query<{ event_type: string; details: Record<string, unknown> }>("SELECT event_type,details FROM m06_github_authorization_events ORDER BY credential_revision");
    assert.deepEqual(events.rows.map(row => row.event_type), ["GitHubAuthorizationBound", "GitHubRefreshClaimed", "GitHubTokensRefreshed"]);
    const serialized = JSON.stringify(events.rows);
    for (const secret of [tokenValues.accessToken, tokenValues.refreshToken, "rotated-private-token", "rotated-private-refresh", nextTokens.data, key]) assert.ok(!serialized.includes(secret));
  });

  test("same App/GitHub identity cannot bind two website accounts until explicit revocation", async () => {
    await store.saveCredential(credential(), null);
    const duplicate = credential({ userId: "bob" });
    await assert.rejects(store.saveCredential(duplicate, null), error => {
      assert.equal((error as { code: string }).code, "GITHUB_ACCOUNT_ALREADY_BOUND");
      assert.ok(!String(error).includes("duplicate key"));
      assert.ok(!String(error).includes("m06_github"));
      return true;
    });
    assert.equal(await store.getCredential("bob", 42), null);
    await store.saveCredential(credential({ userId: "bob", appId: 43 }), null);
    const revocationEpoch = await store.revokeCredential("alice", 42, 1);
    await assert.rejects(store.saveCredential(duplicate, null), { code: "GITHUB_ACCOUNT_ALREADY_BOUND" });
    await store.finishRevocation("alice", 42, revocationEpoch);
    await store.saveCredential(duplicate, null);
    assert.equal((await store.getCredential("bob", 42))?.githubUserId, 123);
    assert.equal((await store.getCredential("alice", 42))?.encryptedTokens, null);
  });

  test("disconnect without a credential invalidates in-flight first callbacks through the epoch", async () => {
    const item = state(); await store.insertState(item);
    const inFlight = (await store.consumeState(consumeInput(item)))!;
    const revocationEpoch = await store.revokeCredential("alice", 42, null);
    assert.equal(revocationEpoch, 1);
    await assert.rejects(store.getAuthorizationEpoch("alice", 42), { code: "GITHUB_REVOCATION_IN_PROGRESS" });
    await assert.rejects(store.insertState(state({ authorizationEpoch: 1 })), { code: "GITHUB_REVOCATION_IN_PROGRESS" });
    await assert.rejects(store.consumeState(consumeInput()), { code: "GITHUB_REVOCATION_IN_PROGRESS" });
    await assert.rejects(store.saveCredential(credential(), null, 1), { code: "GITHUB_REVOCATION_IN_PROGRESS" });
    await store.finishRevocation("alice", 42, revocationEpoch);
    assert.equal(await store.getAuthorizationEpoch("alice", 42), 1);
    await assert.rejects(store.saveCredential(credential(), null, inFlight.authorizationEpoch), { code: "AUTHORIZATION_EPOCH_CHANGED" });
    await assert.rejects(store.insertState(state()), { code: "AUTHORIZATION_EPOCH_CHANGED" });
    assert.equal(await store.getCredential("alice", 42), null);
    const restarted = state({ stateHash: hash("new-flow"), authorizationEpoch: 1 });
    await store.insertState(restarted);
    assert.equal((await store.consumeState(consumeInput(restarted)))?.authorizationEpoch, 1);
    await store.saveCredential(credential(), null, 1);
  });

  test("revocation clears all pending flows and refresh tokens atomically; stale CAS changes nothing", async () => {
    await store.saveCredential(credential(), null);
    await store.insertState(state());
    await store.insertState(state({ stateHash: hash("install"), flow: "installation" }));
    await assert.rejects(store.revokeCredential("alice", 42, 5), { code: "VERSION_CONFLICT" });
    await assert.rejects(store.revokeCredential("alice", 42, null), { code: "VERSION_CONFLICT" });
    assert.equal(await store.getAuthorizationEpoch("alice", 42), 0); assert.equal(await count("m06_github_authorization_states"), 2);
    const claimed = (await store.claimRefresh("alice", 42, 1, "2026-10-08T03:01:00.000Z"))!;
    const revocationEpoch = await store.revokeCredential("alice", 42, 2);
    const revoked = (await store.getCredential("alice", 42))!;
    assert.equal(revoked.status, "revoked"); assert.equal(revoked.revision, 3); assert.equal(revoked.encryptedTokens, null); assert.equal(revoked.refreshLeaseUntil, null);
    assert.equal(await count("m06_github_authorization_states"), 0);
    await assert.rejects(store.saveCredential({ ...claimed, status: "active", refreshLeaseUntil: null, revision: 3 }, 2), { code: "VERSION_CONFLICT" });
    await store.finishRevocation("alice", 42, revocationEpoch);
    assert.equal(await store.getAuthorizationEpoch("alice", 42), 1);
  });

  test("a stale revocation finisher cannot clear a newer gate or release its GitHub identity", async () => {
    await store.saveCredential(credential(), null);
    const firstEpoch = await store.revokeCredential("alice", 42, 1);
    const secondEpoch = await store.revokeCredential("alice", 42, 2);
    assert.equal(secondEpoch, firstEpoch + 1);
    await assert.rejects(store.finishRevocation("alice", 42, firstEpoch), { code: "VERSION_CONFLICT" });
    await assert.rejects(store.getAuthorizationEpoch("alice", 42), { code: "GITHUB_REVOCATION_IN_PROGRESS" });
    await assert.rejects(store.saveCredential(credential({ userId: "bob" }), null), { code: "GITHUB_ACCOUNT_ALREADY_BOUND" });
    const pending = await engine.query<{ revocation_pending: boolean }>("SELECT revocation_pending FROM m06_github_authorization_credentials WHERE user_id='alice' AND app_id=42");
    assert.equal(pending.rows[0].revocation_pending, true);
    await store.finishRevocation("alice", 42, secondEpoch);
    await store.finishRevocation("alice", 42, secondEpoch); // The same completed epoch is idempotent.
    assert.equal(await store.getAuthorizationEpoch("alice", 42), secondEpoch);
    await store.saveCredential(credential({ userId: "bob" }), null);
  });

  test("credential saves and revocations roll back entirely if the audit append fails", async () => {
    const failing: DatabasePort = { query: db.query, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) {
      return db.transaction(sql => work({ async query<Row>(statement: string, parameters?: readonly unknown[]) {
        if (statement.startsWith("INSERT INTO m06_github_authorization_events")) throw new Error(`provider error ${tokenValues.accessToken}`);
        return sql.query<Row>(statement, parameters);
      } }));
    } };
    const broken = new PostgresAuthorizationStore(failing);
    await assert.rejects(broken.saveCredential(credential(), null), error => {
      assert.equal((error as { code: string }).code, "GITHUB_AUTHORIZATION_STORE_UNAVAILABLE");
      assert.ok(!String(error).includes(tokenValues.accessToken));
      assert.equal((error as { cause?: unknown }).cause, undefined); return true;
    });
    assert.equal(await count("m06_github_authorization_credentials"), 0); assert.equal(await count("m06_github_authorization_epochs"), 0);
    await store.saveCredential(credential(), null); await store.insertState(state());
    await assert.rejects(broken.revokeCredential("alice", 42, 1), { code: "GITHUB_AUTHORIZATION_STORE_UNAVAILABLE" });
    assert.equal((await store.getCredential("alice", 42))!.status, "active");
    assert.equal((await store.getCredential("alice", 42))!.revision, 1);
    assert.equal(await store.getAuthorizationEpoch("alice", 42), 0); assert.equal(await count("m06_github_authorization_states"), 1);
    assert.equal(await count("m06_github_authorization_events"), 1);
    await assert.rejects(broken.claimRefresh("alice", 42, 1, "2026-10-08T03:01:00.000Z"), { code: "GITHUB_AUTHORIZATION_STORE_UNAVAILABLE" });
    assert.equal((await store.getCredential("alice", 42))!.status, "active");
  });
});

test("SQL lookups and atomic state consumption bind untrusted identifiers as parameters", async () => {
  const calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
  const db: DatabasePort = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      calls.push({ statement, parameters });
      if (statement.startsWith("SELECT authorization_epoch,revocation_in_progress")) return { rows: [{ authorization_epoch: 0, revocation_in_progress: false }] as Row[], rowCount: 1 };
      return { rows: [] as Row[], rowCount: 0 };
    },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { return work(db); },
  };
  const store = new PostgresAuthorizationStore(db);
  const untrusted = "user'); DROP TABLE m06_github_authorization_credentials;--";
  assert.equal(await store.getCredential(untrusted, 42), null);
  assert.equal(await store.consumeState({ ...consumeInput(), userId: untrusted }), null);
  assert.ok(calls.every(call => !call.statement.includes(untrusted)));
  assert.deepEqual(calls[0].parameters, [untrusted, 42]);
  assert.match(calls[0].statement, /user_id=\$1 AND app_id=\$2 LIMIT 1/u);
  const consumed = calls.find(call => call.statement.startsWith("DELETE FROM m06_github_authorization_states"))!;
  assert.match(consumed.statement, /^DELETE .*state_hash=\$1 AND user_id=\$2 AND app_id=\$3 AND browser_hash=\$4 AND expires_at>\$5::timestamptz AND flow=\$6 RETURNING/u);
  assert.deepEqual(consumed.parameters, [state().stateHash, untrusted, 42, state().browserHash, now, "authorization"]);
});

test("invalid revisions, plaintext envelopes and invalid scopes fail before any database mutation", async () => {
  let calls = 0;
  const db: DatabasePort = { async query<Row>() { calls += 1; return { rows: [] as Row[], rowCount: 0 }; }, async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { calls += 1; return work(db); } };
  const store = new PostgresAuthorizationStore(db);
  await assert.rejects(store.saveCredential(credential({ revision: 2 }), null), { code: "VERSION_CONFLICT" });
  await assert.rejects(store.saveCredential(credential({ encryptedTokens: { keyId: "test-key", iv: "plaintext", tag: "plaintext", data: tokenValues.accessToken } }), null), { code: "GITHUB_AUTHORIZATION_STORE_INPUT_INVALID" });
  await assert.rejects(store.saveCredential(credential({ status: "revoked", encryptedTokens: credential().encryptedTokens }), null), { code: "GITHUB_AUTHORIZATION_STORE_INPUT_INVALID" });
  await assert.rejects(store.getCredential("user\nother", 42), { code: "GITHUB_AUTHORIZATION_STORE_INPUT_INVALID" });
  await assert.rejects(store.getCredential("alice", 0), { code: "GITHUB_AUTHORIZATION_STORE_INPUT_INVALID" });
  await assert.rejects(store.insertState(state({ stateHash: "raw-state" })), { code: "GITHUB_AUTHORIZATION_STORE_INPUT_INVALID" });
  await assert.rejects(store.insertState(state({ returnTo: "//attacker.example" })), { code: "GITHUB_AUTHORIZATION_STORE_INPUT_INVALID" });
  assert.equal(calls, 0);
});
