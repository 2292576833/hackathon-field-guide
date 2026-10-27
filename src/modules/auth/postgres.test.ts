import assert from "node:assert/strict";
import test from "node:test";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { createNodeAuthCrypto } from "./crypto.ts";
import { PostgresAuthStore } from "./postgres.ts";
import { DEFAULT_AUTH_POLICY } from "./types.ts";

// Scripted SQL contract tests. No live PostgreSQL engine is represented here.
const start = "2026-10-08T12:00:00.000Z";
const expire = "2026-10-08T12:10:00.000Z";
const crypto = createNodeAuthCrypto("test-only-pepper-of-at-least-32-bytes");
const user = {
  id: "user-a", email: "person@example.com", display_name: "参赛新人", timezone: "Asia/Shanghai",
  status: "active", platform_roles: ["user"], email_verified_at: start, created_at: start, revision: 1,
};
const session = {
  id: "session-a", user_id: "user-a", token_hash: "a".repeat(64), created_at: start,
  authenticated_at: start, expires_at: "2026-10-15T12:00:00.000Z", revoked_at: null,
  last_seen_at: start,
};
const challenge = {
  id: "challenge-a", email: "person@example.com", email_rate_key: "email-key",
  code_hash: crypto.hashCode("challenge-a", "12345678"), expires_at: expire,
  delivery: "ready", failed_attempts: 0, consumed_at: null, revoked_at: null,
};

interface Call { readonly sql: string; readonly parameters: readonly unknown[]; readonly transaction: boolean }
class ScriptedDatabase implements DatabasePort {
  readonly calls: Call[] = [];
  readonly outcomes: string[] = [];
  readonly responder: (call: Call) => readonly unknown[];
  constructor(responder: (call: Call) => readonly unknown[]) { this.responder = responder; }
  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.run<Row>(statement, parameters, false);
  }
  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    const tx: SqlExecutor = { query: <Row>(sql: string, values: readonly unknown[] = []) => this.run<Row>(sql, values, true) };
    try { const result = await work(tx); this.outcomes.push("commit"); return result; }
    catch (error) { this.outcomes.push("rollback"); throw error; }
  }
  private async run<Row>(statement: string, parameters: readonly unknown[], transaction: boolean): Promise<SqlResult<Row>> {
    const call = { sql: statement.replace(/\s+/g, " ").trim(), parameters, transaction };
    this.calls.push(call);
    const rows = this.responder(call) as readonly Row[];
    return { rows, rowCount: rows.length };
  }
}

function commonResponder(call: Call): readonly unknown[] {
  if (call.sql === "SELECT email FROM auth_login_challenges WHERE id = $1") return [{ email: challenge.email }];
  if (call.sql === "SELECT * FROM auth_login_challenges WHERE id = $1 FOR UPDATE") return [challenge];
  if (call.sql === "SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE") return [{ key: call.parameters[0], window_started_at: start, attempts: 0, last_attempt_at: null }];
  if (call.sql === "SELECT * FROM auth_users WHERE email = $1 FOR UPDATE" || call.sql === "SELECT * FROM auth_users WHERE id = $1 FOR UPDATE") return [user];
  if (call.sql === "SELECT user_id FROM auth_sessions WHERE token_hash = $1") return [{ user_id: "user-a" }];
  if (call.sql === "SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE") return [session];
  if (call.sql.startsWith("UPDATE auth_sessions SET last_seen_at")) return [{ last_seen_at: call.parameters[1] }];
  return [];
}
function consumeInput(code = "12345678") {
  return {
    challengeId: challenge.id, codeHash: crypto.hashCode(challenge.id, code), now: start,
    policy: DEFAULT_AUTH_POLICY, newUserId: "new-user-id",
    newSession: {
      id: "new-session-id", tokenHash: "b".repeat(64), createdAt: start, authenticatedAt: start,
      expiresAt: session.expires_at, revokedAt: null,
      lastSeenAt: start,
    },
  };
}
let id = 0;
const ids = { next: () => `audit-${++id}` };

test("failed verification commits its attempt and mailbox budget, without creating an identity/session", async () => {
  const db = new ScriptedDatabase(commonResponder);
  const store = new PostgresAuthStore(db, ids, { now: () => new Date(start) });
  assert.deepEqual(await store.consumeChallenge(consumeInput("99999999")), { status: "invalid" });
  assert.deepEqual(db.outcomes, ["commit"]);
  assert.ok(db.calls.some((call) => call.sql.includes("failed_attempts = failed_attempts + 1")));
  assert.ok(db.calls.some((call) => call.sql.startsWith("UPDATE auth_rate_limits")));
  assert.ok(!db.calls.some((call) => call.sql.startsWith("INSERT INTO auth_users") || call.sql.startsWith("INSERT INTO auth_sessions")));
  assert.ok(db.calls.every((call) => call.transaction));
  assert.ok(!db.calls.some((call) => call.sql.includes("99999999") || call.sql.includes(challenge.email)));
});

test("successful verification atomically consumes the code, creates only default-user identity, and inserts a hashed session", async () => {
  const db = new ScriptedDatabase(commonResponder);
  const store = new PostgresAuthStore(db, ids, { now: () => new Date(start) });
  const result = await store.consumeChallenge(consumeInput());
  assert.equal(result.status, "verified");
  assert.deepEqual(db.outcomes, ["commit"]);
  const consumption = db.calls.findIndex((call) => call.sql.includes("SET consumed_at"));
  const sessionInsertion = db.calls.findIndex((call) => call.sql.startsWith("INSERT INTO auth_sessions"));
  assert.ok(consumption >= 0 && sessionInsertion > consumption);
  assert.ok(db.calls.find((call) => call.sql.startsWith("INSERT INTO auth_users"))!.sql.includes("ARRAY['user']::text[]"));
  assert.equal(db.calls[sessionInsertion]!.parameters[2], "b".repeat(64));
  assert.ok(db.calls.every((call) => call.transaction));
  const auditCalls = db.calls.filter((call) => call.sql.startsWith("INSERT INTO auth_audit_events"));
  assert.ok(auditCalls.length > 0);
  for (const call of auditCalls) assert.ok(!call.parameters.includes(challenge.email) && !call.parameters.includes(challenge.code_hash));
});

test("session insertion failure escapes the transaction so consumption cannot commit alone", async () => {
  const db = new ScriptedDatabase((call) => {
    if (call.sql.startsWith("INSERT INTO auth_sessions")) throw new Error("simulated connection failure");
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => new Date(start) });
  await assert.rejects(store.consumeChallenge(consumeInput()), /simulated connection failure/);
  assert.deepEqual(db.outcomes, ["rollback"]);
});

test("a challenge that expires while waiting for its row lock cannot create a session", async () => {
  let now = new Date(start);
  const db = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_login_challenges WHERE id = $1 FOR UPDATE") now = new Date(expire);
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => now });
  assert.deepEqual(await store.consumeChallenge(consumeInput()), { status: "invalid" });
  assert.ok(!db.calls.some((call) => call.sql.startsWith("INSERT INTO auth_users")));
});

test("expiry while waiting on the user rolls back identity work but retains the rate fact", async () => {
  let now = new Date(start);
  const db = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_users WHERE email = $1 FOR UPDATE") now = new Date(expire);
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => now });
  assert.deepEqual(await store.consumeChallenge(consumeInput()), { status: "invalid" });
  assert.ok(db.calls.some((call) => call.sql === "ROLLBACK TO SAVEPOINT auth_verification_account"));
  assert.ok(db.calls.some((call) => call.sql.startsWith("UPDATE auth_rate_limits")));
  assert.ok(!db.calls.some((call) => call.sql.startsWith("INSERT INTO auth_sessions")));
  assert.deepEqual(db.outcomes, ["commit"]);
});

test("revoking a foreign session is bound to the authenticated user's id", async () => {
  const db = new ScriptedDatabase(commonResponder);
  const store = new PostgresAuthStore(db, ids, { now: () => new Date(start) });
  assert.deepEqual(await store.revokeOwnSessions({ currentTokenHash: session.token_hash, targetSessionId: "foreign-session", now: start, authenticatedAfter: null }), { status: "revoked", revoked: false, currentSessionRevoked: false });
  const update = db.calls.find((call) => call.sql.startsWith("UPDATE auth_sessions SET revoked_at"))!;
  assert.ok(update.sql.includes("WHERE user_id = $1"));
  assert.deepEqual(update.parameters, ["user-a", start, "foreign-session"]);
});

test("session expiry and recent-authentication are rechecked after lock waits", async () => {
  let now = new Date(start);
  const db = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE") now = new Date(session.expires_at);
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => now });
  assert.deepEqual(await store.revokeOwnSessions({ currentTokenHash: session.token_hash, targetSessionId: null, now: start, authenticatedAfter: start }), { status: "unauthenticated" });
  assert.ok(!db.calls.some((call) => call.sql.startsWith("UPDATE auth_sessions")));
  now = new Date(start);
  const staleDb = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE") now = new Date(new Date(start).getTime() + 5 * 60_000 + 1);
    return commonResponder(call);
  });
  const staleStore = new PostgresAuthStore(staleDb, ids, { now: () => now });
  assert.deepEqual(await staleStore.revokeOwnSessions({ currentTokenHash: session.token_hash, targetSessionId: null, now: start, authenticatedAfter: new Date(new Date(start).getTime() - 5 * 60_000).toISOString() }), { status: "reauthentication_required" });
});

test("rate row locks have stable ordering and refused send does not insert a challenge", async () => {
  const db = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE") return [{ key: call.parameters[0], window_started_at: start, attempts: 20, last_attempt_at: start }];
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => new Date(start) });
  const accepted = await store.reserveChallenge({
    challenge: {
      id: challenge.id, email: challenge.email, codeHash: challenge.code_hash,
      createdAt: start, expiresAt: expire, delivery: "pending", failedAttempts: 0, consumedAt: null, revokedAt: null,
    }, emailRateKey: "z-email", clientRateKey: "a-client", policy: DEFAULT_AUTH_POLICY,
  });
  assert.equal(accepted, false);
  const locks = db.calls.filter((call) => call.sql === "SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE");
  assert.deepEqual(locks.map((call) => call.parameters[0]), ["a-client", "z-email"]);
  assert.ok(!db.calls.some((call) => call.sql.startsWith("INSERT INTO auth_login_challenges")));
});

test("session query checks account status and rejects expiry during row lock waits", async () => {
  let now = new Date(start);
  const db = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE") now = new Date(session.expires_at);
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => now });
  assert.equal(await store.getSessionContext(session.token_hash, start), null);
  assert.ok(!db.calls.some((call) => call.sql.startsWith("UPDATE auth_sessions")));
});

test("device list refreshes time after locks and omits devices that expired during the wait", async () => {
  const afterWait = "2026-10-08T12:02:00.000Z";
  let now = new Date(start);
  const db = new ScriptedDatabase((call) => {
    if (call.sql === "SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE") now = new Date(afterWait);
    if (call.sql.startsWith("SELECT * FROM auth_sessions WHERE user_id")) {
      assert.deepEqual(call.parameters, ["user-a", afterWait]);
      return [session, { ...session, id: "expired-device", expires_at: "2026-10-08T12:01:00.000Z" }];
    }
    return commonResponder(call);
  });
  const store = new PostgresAuthStore(db, ids, { now: () => now });
  const devices = await store.listOwnSessions(session.token_hash, start);
  assert.deepEqual(devices?.map((device) => device.id), ["session-a"]);
});
