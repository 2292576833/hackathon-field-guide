import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AccountDeletionRequest, EmailChangeChallenge, StoredDataExport } from "./account-types.ts";
import { PostgresAccountStore } from "./account-postgres.ts";
import { FixtureClock, FixtureIds } from "./test-fixtures.ts";

const tokenA = "a".repeat(64); const tokenB = "b".repeat(64);
type RawQuery = (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
interface SqlCall { sql: string; values: readonly unknown[] }
async function fixture() {
  const engine = new PGlite(); await engine.waitReady;
  const clock = new FixtureClock(); const calls: SqlCall[] = [];
  let beforeQuery: ((call: SqlCall, query: RawQuery) => Promise<void>) | null = null;
  const executor = (query: RawQuery): SqlExecutor => ({
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const call = { sql: sql.replace(/\s+/g, " ").trim(), values }; calls.push(call);
      if (beforeQuery) await beforeQuery(call, query);
      const result = await query(sql, [...values]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const db: DatabasePort = { query: direct.query,
    transaction: work => engine.transaction(tx => work(executor((sql, values) => tx.query(sql, values)))) };
  for (const name of ["001_auth.sql", "002_session_last_seen.sql", "003_registration_display_name.sql", "004_account_completion.sql"]) {
    await engine.exec(await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"));
  }
  const start = clock.now().toISOString(); const expires = new Date(clock.now().getTime() + 60 * 60_000).toISOString();
  for (const [id, address, hash] of [["user-a", "old@example.test", tokenA], ["user-b", "other@example.test", tokenB]]) {
    await db.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,'UTC',$4,$4)", [id, address, id, start]);
    await db.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$4,$5,$4)", [`session-${id}`, id, hash, start, expires]);
  }
  const store = new PostgresAccountStore(db, new FixtureIds(), clock);
  return { engine, clock, db, store, calls, start, expires,
    hook: (hook: typeof beforeQuery) => { beforeQuery = hook; },
    close: () => engine.close() };
}
function exportRecord(now: string, id = "export-a", userId = "user-a"): StoredDataExport {
  return { id, userId, status: "queued", createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(), revision: 1, attempts: 0,
    errorCode: null, byteLength: null, document: null };
}
function deletionRecord(now: string, id = "deletion-a", userId = "user-a"): AccountDeletionRequest {
  return { id, userId, status: "blocked", createdAt: now, updatedAt: now, revision: 1,
    impact: { lastManagerProjects: [{ projectId: "project-a", name: "队友的共享成果", remediationUrl: "/projects/project-a" }], notices: ["需先转交管理员。"] } };
}
function challengeRecord(now: string, id = "change-a", userId = "user-a"): EmailChangeChallenge {
  return { id, userId, oldEmail: "old@example.test", newEmail: "new@example.test", expectedRevision: 1,
    currentCodeHash: "c".repeat(64), newCodeHash: "d".repeat(64), createdAt: now,
    expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(), delivery: "pending", failedAttempts: 0, consumedAt: null, revokedAt: null };
}
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

// Disposable PostgreSQL engine only. No production PGlite directory, migration, external mail or model.
test("real account DDL preserves owner isolation, immutable export lifetime and optimistic revisions", async () => {
  const f = await fixture();
  try {
    const request = exportRecord(f.start);
    await f.store.withSession(tokenA, async tx => { await tx.saveExport(request); await tx.audit("data_export_requested", "data_export", request.id, "queued"); });
    assert.deepEqual(await f.store.withSession(tokenA, tx => tx.getExport(request.id)), request);
    assert.deepEqual(await f.store.withSession(tokenB, tx => tx.listExports()), []);
    assert.equal(await f.store.withSession(tokenB, tx => tx.getExport(request.id)), null);
    await assert.rejects(f.store.withSession(tokenB, tx => tx.saveExport(request)), errorCode("ACCOUNT_RECORD_INVALID"));
    await f.store.withSession(tokenA, tx => tx.saveExport({ ...request, status: "failed", attempts: 1, revision: 2, errorCode: "EXPORT_TEMPORARY_FAILURE" }));
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveExport({ ...request, status: "ready", revision: 2 })), errorCode("VERSION_CONFLICT"));
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveExport({ ...request, revision: 3, expiresAt: new Date(Date.parse(request.expiresAt) + 1).toISOString() })), errorCode("VERSION_CONFLICT"));
    assert.equal((await f.store.withSession(tokenA, tx => tx.getExport(request.id)))!.revision, 2);
    await assert.rejects(f.store.withSession(tokenA, async tx => { await tx.saveExport(exportRecord(f.start, "rollback")); throw new Error("rollback collection"); }), /rollback collection/);
    assert.equal(await f.store.withSession(tokenA, tx => tx.getExport("rollback")), null);
    assert.ok(f.calls.every(call => !call.sql.includes("old@example.test") && !call.sql.includes(tokenA)));
    const audit = await f.db.query("SELECT * FROM auth_audit_events");
    assert.ok(!JSON.stringify(audit.rows).includes(tokenA));
    assert.ok(!JSON.stringify(audit.rows).includes("old@example.test"));
    const document = { schemaVersion: 1 as const, userId: "user-a", generatedAt: f.start,
      profile: { id: "user-a", email: "old@example.test", displayName: "user-a", timezone: "UTC", emailVerifiedAt: f.start, revision: 1 },
      records: { personal: [{ id: "private-record", userId: "user-a", data: "本人原始资料" }], conversations: [], generations: [], assessments: [], retrospectives: [], bookmarks: [] }, projects: [] };
    await f.store.withSession(tokenA, async tx => {
      for (let n = 0; n < 21; n++) await tx.saveExport({ ...exportRecord(f.start, `bounded-${String(n).padStart(2, "0")}`), status: "ready", document });
    });
    const summaries = await f.store.withSession(tokenA, tx => tx.listExports());
    assert.equal(summaries.length, 20);
    assert.ok(summaries.every(item => item.document === null));
    assert.deepEqual((await f.store.withSession(tokenA, tx => tx.getExport("bounded-00")))!.document, document);
  } finally { await f.close(); }
});

test("persistent deletion requests can be cancelled and replaced; sessions revoke only on real processing", async () => {
  const f = await fixture();
  try {
    const request = deletionRecord(f.start, "z-deletion");
    await f.store.withSession(tokenA, tx => tx.saveDeletion(request));
    assert.deepEqual(await f.store.withSession(tokenA, tx => tx.getDeletion()), request);
    assert.equal(await f.store.withSession(tokenB, tx => tx.getDeletion(request.id)), null);
    assert.equal((await f.store.withSession(tokenA, tx => Promise.resolve(tx.context.user))).status, "active");
    await assert.rejects(f.store.withSession(tokenA, tx => tx.beginDeletionProcessing()), errorCode("ACCOUNT_RECORD_INVALID"));
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveDeletion(deletionRecord(f.start, "duplicate"))), errorCode("VERSION_CONFLICT"));
    await f.store.withSession(tokenA, tx => tx.saveDeletion({ ...request, status: "cancelled", revision: 2 }));
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveDeletion({ ...request, status: "pending", revision: 2 })), errorCode("VERSION_CONFLICT"));
    const next = { ...deletionRecord(f.start, "a-next"), status: "pending" as const, impact: { lastManagerProjects: [], notices: [] } };
    await f.store.withSession(tokenA, tx => tx.saveDeletion(next));
    assert.equal((await f.store.withSession(tokenA, tx => tx.getDeletion()))!.id, "a-next");
    await f.store.withUser("user-a", async tx => {
      await tx.assertSession();
      await tx.saveDeletion({ ...next, status: "processing", revision: 2 });
      await tx.beginDeletionProcessing();
    });
    await assert.rejects(f.store.withSession(tokenA, async () => undefined), errorCode("AUTH_SESSION_REQUIRED"));
    await assert.rejects(f.store.withUser("user-a", async () => undefined), errorCode("AUTH_SESSION_REQUIRED"));
    assert.equal((await f.db.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", ["user-a"])).rows[0]!.status, "deletion_pending");
    assert.equal((await f.store.withSession(tokenB, tx => Promise.resolve(tx.context.user))).id, "user-b");
  } finally { await f.close(); }
});

test("all rate rules lock in sorted order and reject without consuming other budgets; lock wait uses fresh time", async () => {
  const f = await fixture();
  try {
    const rules = [{ key: "z-budget", windowMs: 60_000, maximum: 1 }, { key: "a-budget", windowMs: 60_000, maximum: 3 }];
    assert.equal(await f.store.withSession(tokenA, tx => tx.takeRates(rules)), true);
    assert.equal(await f.store.withSession(tokenA, tx => tx.takeRates(rules)), false);
    const rates = await f.db.query<{ key: string; attempts: number }>("SELECT key,attempts FROM auth_rate_limits ORDER BY key");
    assert.deepEqual(rates.rows, [{ key: "a-budget", attempts: 1 }, { key: "z-budget", attempts: 1 }]);
    const locks = f.calls.filter(call => call.sql === "SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE");
    assert.deepEqual(locks.map(call => call.values[0]), ["a-budget", "z-budget", "a-budget", "z-budget"]);
    let advanced = false;
    f.hook(async call => { if (!advanced && call.sql === "SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE") { advanced = true; f.clock.advance(60_000); } });
    assert.equal(await f.store.withSession(tokenA, tx => tx.takeRates(rules)), true);
    f.hook(null);
    const reset = await f.db.query<{ window_started_at: Date; attempts: number }>("SELECT window_started_at,attempts FROM auth_rate_limits WHERE key=$1", ["z-budget"]);
    assert.equal(new Date(reset.rows[0]!.window_started_at).toISOString(), f.clock.now().toISOString());
    assert.equal(reset.rows[0]!.attempts, 1);
    await assert.rejects(f.store.withSession(tokenA, tx => tx.takeRates([rules[0]!, rules[0]!])), errorCode("ACCOUNT_RECORD_INVALID"));
  } finally { await f.close(); }
});

test("email challenges persist unknown delivery, consumption and revocation without stale resurrection", async () => {
  const f = await fixture();
  try {
    const challenge = challengeRecord(f.start);
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge(challenge));
    assert.equal(await f.store.withSession(tokenB, tx => tx.getEmailChallenge(challenge.id)), null);
    await assert.rejects(f.store.withSession(tokenB, tx => tx.saveEmailChallenge(challenge)), errorCode("ACCOUNT_RECORD_INVALID"));
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...challenge, delivery: "unknown" }));
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...challenge, delivery: "ready" })), errorCode("VERSION_CONFLICT"));
    const good = challengeRecord(f.start, "good");
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge(good));
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...good, delivery: "ready" }));
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...good, delivery: "ready", failedAttempts: 1 }));
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...good, delivery: "ready" })), errorCode("VERSION_CONFLICT"));
    const consumed = { ...good, delivery: "ready" as const, failedAttempts: 1, consumedAt: f.clock.now().toISOString() };
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge(consumed));
    await f.store.withSession(tokenA, tx => tx.revokeEmailChallenges());
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...consumed, consumedAt: null })), errorCode("VERSION_CONFLICT"));
    assert.equal((await f.store.withSession(tokenA, tx => tx.getEmailChallenge(challenge.id)))!.revokedAt, f.clock.now().toISOString());
    assert.equal((await f.store.withSession(tokenA, tx => tx.getEmailChallenge(good.id)))!.revokedAt, null);
    await assert.rejects(f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...challenge, delivery: "unknown" })), errorCode("VERSION_CONFLICT"));
  } finally { await f.close(); }
});

test("email change locks mailbox identities before user/session and atomically preserves ID, version and invalidation", async () => {
  const f = await fixture();
  try {
    const challenge = challengeRecord(f.start);
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge(challenge));
    await f.store.withSession(tokenA, tx => tx.saveEmailChallenge({ ...challenge, delivery: "ready" }));
    for (const [id, email] of [["login-old", challenge.oldEmail], ["login-new", challenge.newEmail], ["login-other", "other@example.test"]]) {
      await f.db.query("INSERT INTO auth_login_challenges(id,email,email_rate_key,code_hash,delivery,created_at,expires_at) VALUES($1,$2,'test-rate',$3,'ready',$4,$5)", [id, email, "e".repeat(64), f.start, f.expires]);
    }
    assert.equal(await f.store.withSession(tokenA, tx => tx.changeEmail("other@example.test", 1), ["other@example.test"]), "email_conflict");
    assert.equal(await f.store.withSession(tokenA, tx => tx.changeEmail(challenge.newEmail, 2), [challenge.newEmail]), "version_conflict");
    await assert.rejects(f.store.withSession(tokenA, tx => tx.changeEmail(challenge.newEmail, 1)), errorCode("ACCOUNT_RECORD_INVALID"));
    f.calls.length = 0;
    const result = await f.store.withSession(tokenA, async tx => {
      const user = await tx.changeEmail(challenge.newEmail, 1);
      await tx.saveEmailChallenge({ ...challenge, delivery: "ready", consumedAt: tx.now() });
      await tx.revokeEmailChallenges();
      await tx.audit("email_changed", "user", tx.context.user.id, "succeeded");
      return user;
    }, [challenge.newEmail]);
    assert.ok(typeof result === "object");
    assert.equal(result.id, "user-a"); assert.equal(result.revision, 2); assert.equal(result.email, "new@example.test");
    assert.equal(result.displayName, "user-a");
    const mailbox = f.calls.filter(call => call.sql.startsWith("SELECT pg_advisory_xact_lock"));
    assert.deepEqual(mailbox.map(call => call.values[0]), ["auth-email:new@example.test", "auth-email:old@example.test"]);
    assert.ok(f.calls.indexOf(mailbox.at(-1)!) < f.calls.findIndex(call => call.sql === "SELECT * FROM auth_users WHERE id = $1 FOR UPDATE"));
    await assert.rejects(f.store.withSession(tokenA, async () => undefined), errorCode("AUTH_SESSION_REQUIRED"));
    assert.ok(await f.store.withSession(tokenB, tx => Promise.resolve(tx.context.user)));
    const logins = await f.db.query<{ id: string; revoked_at: Date | null }>("SELECT id,revoked_at FROM auth_login_challenges ORDER BY id");
    assert.ok(logins.rows.find(row => row.id === "login-old")!.revoked_at);
    assert.ok(logins.rows.find(row => row.id === "login-new")!.revoked_at);
    assert.equal(logins.rows.find(row => row.id === "login-other")!.revoked_at, null);
  } finally { await f.close(); }
});

test("unique email failure rolls back its savepoint and leaves the outer transaction and old sessions usable", async () => {
  const f = await fixture();
  try {
    let inject = true;
    f.hook(async (call, query) => {
      if (inject && call.sql.startsWith("UPDATE auth_users SET email")) {
        inject = false;
        await query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,'test','UTC',$3,$3)", ["race-user", "new@example.test", f.start]);
      }
    });
    const result = await f.store.withSession(tokenA, async tx => {
      const changed = await tx.changeEmail("new@example.test", 1);
      await tx.audit("email_change_denied", "user", "user-a", "email_conflict");
      await tx.assertSession();
      return changed;
    }, ["new@example.test"]);
    assert.equal(result, "email_conflict");
    assert.ok(f.calls.some(call => call.sql === "ROLLBACK TO SAVEPOINT account_email_change"));
    assert.equal((await f.store.withSession(tokenA, tx => Promise.resolve(tx.context.user))).email, "old@example.test");
    assert.equal((await f.db.query("SELECT id FROM auth_users WHERE id='race-user'")).rowCount, 0);
  } finally { await f.close(); }
});

test("entry and final session checks use fresh clocks after awaits and reject a changed mailbox hint", async () => {
  const f = await fixture();
  try {
    let entered = false;
    f.hook(async call => { if (call.sql === "SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE") f.clock.set(f.expires); });
    await assert.rejects(f.store.withSession(tokenA, async () => { entered = true; }), errorCode("AUTH_SESSION_REQUIRED"));
    assert.equal(entered, false);
    f.hook(null); f.clock.set(f.start);
    await assert.rejects(f.store.withSession(tokenA, async tx => { await tx.saveExport(exportRecord(f.start)); f.clock.set(f.expires); await tx.assertSession(); }), errorCode("AUTH_SESSION_REQUIRED"));
    f.clock.set(f.start);
    assert.equal(await f.store.withSession(tokenA, tx => tx.getExport("export-a")), null);
    let swapped = false;
    f.hook(async (call, query) => {
      if (!swapped && call.sql === "SELECT * FROM auth_users WHERE id = $1 FOR UPDATE") {
        swapped = true; await query("UPDATE auth_users SET email=$2 WHERE id=$1", ["user-a", "swapped@example.test"]);
      }
    });
    await assert.rejects(f.store.withSession(tokenA, async () => undefined, ["new@example.test"]), errorCode("AUTH_SESSION_REQUIRED"));
    f.hook(null);
    assert.equal((await f.store.withSession(tokenA, tx => Promise.resolve(tx.context.user))).email, "old@example.test");
    await assert.rejects(f.store.withSession(tokenA, async tx => {
      await tx.executor.query("UPDATE auth_users SET status='suspended' WHERE id=$1", ["user-a"]);
      await tx.assertSession();
    }), errorCode("AUTH_SESSION_REQUIRED"));
  } finally { await f.close(); }
});

test("server-only bounded expiry cleanup clears all owners' private bodies, preserves metadata and is idempotent", async () => {
  const f = await fixture();
  try {
    const expiredAt = new Date(Date.parse(f.start) + 60_000).toISOString();
    const documentFor = (userId: string) => ({ schemaVersion: 1 as const, userId, generatedAt: f.start,
      profile: { id: userId, email: `${userId}@example.test`, displayName: userId, timezone: "UTC", emailVerifiedAt: f.start, revision: 1 },
      records: { personal: [{ id: "private-record", userId, data: "本人原始资料" }], conversations: [], generations: [], assessments: [], retrospectives: [], bookmarks: [] }, projects: [] });
    const expired = (id: string, userId: string): StoredDataExport => ({ ...exportRecord(f.start, id, userId),
      status: "ready", expiresAt: expiredAt, byteLength: 123, document: documentFor(userId), attempts: 1 });
    const first = expired("a-expired", "user-a"), second = expired("b-expired", "user-b");
    const active = { ...expired("active", "user-a"), expiresAt: f.expires };
    await f.store.withSession(tokenA, async tx => { await tx.saveExport(first); await tx.saveExport(active); });
    await f.store.withSession(tokenB, tx => tx.saveExport(second));
    const alreadyExpired = { ...expired("already-expired", "user-b"), status: "expired" as const, document: null, byteLength: null };
    await f.store.withSession(tokenB, tx => tx.saveExport(alreadyExpired));
    for (const invalidMaximum of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(f.store.clearExpiredExportDocuments(invalidMaximum), errorCode("ACCOUNT_EXPORT_CLEANUP_LIMIT_INVALID"));
    }
    f.clock.set(expiredAt); f.calls.length = 0;
    assert.equal(await f.store.clearExpiredExportDocuments(1), 1);
    const metadata = await f.db.query<{ body: StoredDataExport }>("SELECT body FROM auth_data_exports ORDER BY id");
    const cleaned = metadata.rows.find(row => row.body.id === first.id)!.body;
    assert.deepEqual(cleaned, { ...first, document: null, byteLength: null, status: "expired", revision: 2, updatedAt: expiredAt });
    assert.deepEqual(metadata.rows.find(row => row.body.id === second.id)!.body, second);
    assert.deepEqual(metadata.rows.find(row => row.body.id === active.id)!.body, active);
    assert.deepEqual(metadata.rows.find(row => row.body.id === alreadyExpired.id)!.body, alreadyExpired);
    const lock = f.calls.find(call => call.sql.includes("FOR UPDATE SKIP LOCKED"))!;
    assert.deepEqual(lock.values, [expiredAt, 1]);
    assert.ok(!f.calls.some(call => /auth_users|auth_sessions/.test(call.sql)));
    assert.equal(await f.store.clearExpiredExportDocuments(), 1);
    assert.equal(await f.store.clearExpiredExportDocuments(1000), 0);
    const final = await f.db.query<{ body: StoredDataExport }>("SELECT body FROM auth_data_exports ORDER BY id");
    assert.equal(final.rowCount, 4);
    assert.deepEqual(final.rows.find(row => row.body.id === second.id)!.body, { ...second, document: null, byteLength: null, status: "expired", revision: 2, updatedAt: expiredAt });
    assert.deepEqual(final.rows.find(row => row.body.id === first.id)!.body, cleaned);
    assert.deepEqual(final.rows.find(row => row.body.id === active.id)!.body, active);
    assert.deepEqual(final.rows.find(row => row.body.id === alreadyExpired.id)!.body, alreadyExpired);
    assert.equal((await f.store.withSession(tokenB, tx => tx.getExport(second.id)))!.document, null);
    assert.equal(await f.store.withSession(tokenA, tx => tx.getExport(second.id)), null);
  } finally { await f.close(); }
});
