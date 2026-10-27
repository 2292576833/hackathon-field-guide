import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { AuthService, createNodeAuthCrypto, PostgresAuthStore } from "./index.ts";
import { CapturingLoginEmail, FixtureClock, FixtureIds } from "./test-fixtures.ts";

// Real PostgreSQL engine in a disposable test database; no external credentials,
// production migration or live email. PGlite does not prove multi-connection locks.
test("additive migration and actual SQL preserve legacy sessions, account metadata and owner-only revocation", async () => {
  const engine = new PGlite(); await engine.waitReady;
  const clock = new FixtureClock(); const ids = new FixtureIds();
  const crypto = createNodeAuthCrypto("real-engine-test-only-pepper-at-least-32-bytes");
  const email = new CapturingLoginEmail();
  const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      const result = await query(sql, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const database: DatabasePort = {
    query: direct.query,
    transaction: (work) => engine.transaction((tx) => work(executor((sql, values) => tx.query(sql, values)))),
  };
  try {
    await engine.exec(await readFile(new URL("./migrations/001_auth.sql", import.meta.url), "utf8"));
    const createdAt = clock.now().toISOString(); const legacyExpiry = new Date(clock.now().getTime() + 7 * 24 * 60 * 60_000).toISOString();
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,$4,$5,$5)", ["legacy-user", "person@example.test", "旧账号", "UTC", createdAt]);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", ["legacy-session", "legacy-user", crypto.hashSessionToken("l".repeat(43)), createdAt, legacyExpiry]);
    await engine.exec(await readFile(new URL("./migrations/002_session_last_seen.sql", import.meta.url), "utf8"));
    await engine.exec(await readFile(new URL("./migrations/003_registration_display_name.sql", import.meta.url), "utf8"));
    const backfill = await database.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM auth_sessions WHERE id=$1", ["legacy-session"]);
    assert.equal(new Date(backfill.rows[0]!.last_seen_at).toISOString(), createdAt);
    const service = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto, email, clock, ids });
    const login = async (address: string) => {
      const challenge = await service.requestLoginChallenge(address, "trusted-engine-test");
      return service.verifyLoginChallenge({ challengeId: challenge.challengeId, code: email.sent.at(-1)!.code }, "trusted-engine-test");
    };
    const grant = await login("person@example.test");
    assert.equal(grant.profile.id, "legacy-user");
    assert.deepEqual((await service.requireActor(grant.sessionToken)).platformRoles, ["user"]);
    clock.advance(30_000);
    const settings = await service.getAccountSettings(grant.sessionToken);
    assert.equal(settings.currentSession.lastSeenAt, clock.now().toISOString());
    assert.equal(settings.sessions.length, 2);
    assert.equal(settings.canLogoutAll, true);
    assert.deepEqual(Object.keys(settings.currentSession).sort(), ["authenticatedAt", "createdAt", "current", "expiresAt", "id", "lastSeenAt"]);
    const persisted = await database.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM auth_sessions WHERE id=$1", [settings.currentSession.id]);
    assert.equal(new Date(persisted.rows[0]!.last_seen_at).toISOString(), settings.currentSession.lastSeenAt);
    const foreign = await login("other@example.test");
    const foreignSession = (await service.getAccountSettings(foreign.sessionToken)).currentSession;
    assert.deepEqual(await service.revokeOwnSession(grant.sessionToken, foreignSession.id), { revoked: false, currentSessionRevoked: false });
    assert.ok(await service.getActor(foreign.sessionToken));
    await database.query("UPDATE auth_sessions SET expires_at=$2 WHERE id=$1", ["legacy-session", clock.now().toISOString()]);
    assert.deepEqual(await service.revokeOwnSession(grant.sessionToken, "legacy-session"), { revoked: false, currentSessionRevoked: false });
    clock.advance(5 * 60_000);
    assert.equal((await service.getAccountSettings(grant.sessionToken)).canLogoutAll, false);
    await assert.rejects(service.logoutAll(grant.sessionToken), (error) => error instanceof DomainError && error.code === "AUTH_REAUTHENTICATION_REQUIRED");
    assert.deepEqual(await service.revokeOwnSession(grant.sessionToken, settings.currentSession.id), { revoked: true, currentSessionRevoked: true });
    assert.equal(await service.getActor(grant.sessionToken), null);
    const audit = await database.query("SELECT * FROM auth_audit_events");
    assert.ok(!JSON.stringify(audit.rows).includes(grant.sessionToken));
  } finally { await engine.close(); }
});

test("registration migration saves a verified new name atomically and preserves existing accounts", async () => {
  const engine = new PGlite(); await engine.waitReady;
  const clock = new FixtureClock(); const ids = new FixtureIds();
  const crypto = createNodeAuthCrypto("registration-test-only-pepper-at-least-32-bytes");
  const email = new CapturingLoginEmail(); let failSession = false;
  const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      if (failSession && /^\s*INSERT INTO auth_sessions/.test(sql)) throw new Error("isolated session write failure");
      const result = await query(sql, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const database: DatabasePort = { query: direct.query,
    transaction: (work) => engine.transaction((tx) => work(executor((sql, values) => tx.query(sql, values)))) };
  try {
    for (const file of ["001_auth.sql", "002_session_last_seen.sql", "003_registration_display_name.sql"]) {
      await engine.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"));
    }
    const service = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto, email, clock, ids });
    const receipt = await service.requestRegistrationChallenge({ email: "new@example.test", displayName: "  参赛小陈  " }, "trusted-registration");
    const code = email.sent.at(-1)!.code;
    assert.equal((await database.query("SELECT id FROM auth_users")).rows.length, 0);
    const saved = await database.query<{ registration_display_name: string; code_hash: string }>("SELECT registration_display_name,code_hash FROM auth_login_challenges WHERE id=$1", [receipt.challengeId]);
    assert.equal(saved.rows[0]!.registration_display_name, "参赛小陈");
    assert.notEqual(saved.rows[0]!.code_hash, code);
    await assert.rejects(service.verifyRegistrationChallenge({ challengeId: receipt.challengeId, code: "bad" }, "trusted-registration"), error => error instanceof DomainError && error.code === "AUTH_CHALLENGE_INVALID");
    assert.equal((await database.query("SELECT id FROM auth_users")).rows.length, 0);
    failSession = true;
    await assert.rejects(service.verifyRegistrationChallenge({ challengeId: receipt.challengeId, code }, "trusted-registration"), /isolated session write failure/);
    assert.equal((await database.query("SELECT id FROM auth_users")).rows.length, 0);
    const afterFailure = await database.query<{ consumed_at: Date | null }>("SELECT consumed_at FROM auth_login_challenges WHERE id=$1", [receipt.challengeId]);
    assert.equal(afterFailure.rows[0]!.consumed_at, null);
    failSession = false;
    const grant = await service.verifyRegistrationChallenge({ challengeId: receipt.challengeId, code, returnTo: "/participation?event=event-1" }, "trusted-registration");
    assert.equal(grant.profile.displayName, "参赛小陈");
    assert.equal(grant.profile.revision, 1);
    assert.equal(grant.returnTo, "/participation?event=event-1");
    await service.updateOwnProfile(grant.sessionToken, { displayName: "已确认的姓名", timezone: "UTC", expectedRevision: 1 });
    clock.advance(60_000);
    const again = await service.requestRegistrationChallenge({ email: "new@example.test", displayName: "不应覆盖" }, "trusted-registration");
    assert.equal((await service.getCurrentProfile(grant.sessionToken)).displayName, "已确认的姓名");
    const returned = await service.verifyRegistrationChallenge({ challengeId: again.challengeId, code: email.sent.at(-1)!.code }, "trusted-registration");
    assert.equal(returned.profile.id, grant.profile.id);
    assert.equal(returned.profile.displayName, "已确认的姓名");
    assert.equal(returned.profile.timezone, "UTC");
    assert.equal(returned.profile.revision, 2);
    assert.equal((await database.query("SELECT id FROM auth_users")).rows.length, 1);
    const sessions = await database.query("SELECT id FROM auth_sessions");
    assert.equal(sessions.rows.length, 2);
  } finally { await engine.close(); }
});
