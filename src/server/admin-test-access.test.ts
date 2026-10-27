import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createDatabase } from "./database.ts";
import { grantVerifiedRole } from "./administration.ts";
import { issueAdminTestAccess, type AdminTestAccess } from "./admin-test-access.ts";
import { AuthService, PostgresAuthStore, createNodeAuthCrypto } from "../modules/auth/index.ts";
import { DomainError } from "../shared/errors.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { adminTestAccessDocument, assertEmbeddedServerStopped, reserveAdminTestOutput, validateAdminTestOutput } from "../../scripts/issue-admin-test-access.mts";

const pepper = "fixture-only-admin-test-code-pepper-at-least-32-bytes";
const email = "admin-test@example.test";
const start = "2026-10-11T07:00:00.000Z";
const denied = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const codeOf = (access: AdminTestAccess) => access.credential.slice(access.challengeId.length + 1);

async function fixture() {
  // An independent in-memory PostgreSQL-compatible fixture; no production path,
  // configuration, mail provider, worker or external server is loaded.
  const database = await createDatabase({});
  await database.migrate();
  let current = new Date(start);
  const clock = { now: () => new Date(current) };
  const ids = { next: () => randomUUID() };
  const crypto = createNodeAuthCrypto(pepper);
  await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,'隔离管理员','Asia/Shanghai',$3,$3)", ["fixture-admin", email, start]);
  await grantVerifiedRole(database, email, "admin");
  const auth = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto, clock, ids,
    email: { async sendLoginCode() { throw new Error("Unexpected fixture email send"); } } });
  const issue = (address: unknown = email) => issueAdminTestAccess({ database, codePepper: pepper, email: address, clock, ids });
  const verify = (access: AdminTestAccess, code = codeOf(access)) => auth.verifyLoginChallenge({ challengeId: access.challengeId, code, returnTo: "/admin" }, "fixture-browser-client");
  const users = () => database.query("SELECT id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision FROM auth_users ORDER BY id");
  return { database, clock, auth, crypto, issue, verify, users, advance(ms: number) { current = new Date(current.getTime() + ms); } };
}

test("trusted CLI issuance keeps identity and roles intact and returns only authentic persisted challenge metadata", async () => {
  const f = await fixture();
  try {
    const before = await f.users();
    const access = await f.issue(" ADMIN-TEST@example.test ");
    assert.deepEqual(Object.keys(access).sort(), ["challengeId", "credential", "email", "expiresAt", "issuedAt"]);
    assert.match(access.challengeId, /^[a-f0-9-]{36}$/);
    assert.match(codeOf(access), /^[0-9]{8}$/);
    assert.equal(access.credential, `${access.challengeId}.${codeOf(access)}`);
    assert.equal(access.email, email);
    assert.equal(access.issuedAt, start);
    assert.equal(access.expiresAt, "2026-10-11T07:10:00.000Z");
    const saved = (await f.database.query<{ email: string; code_hash: string; delivery: string; created_at: Date; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null }>("SELECT * FROM auth_login_challenges WHERE id=$1", [access.challengeId])).rows[0]!;
    assert.equal(saved.email, access.email);
    assert.equal(saved.code_hash, f.crypto.hashCode(access.challengeId, codeOf(access)));
    assert.equal(saved.delivery, "ready"); assert.equal(saved.consumed_at, null); assert.equal(saved.revoked_at, null);
    assert.equal(new Date(saved.created_at).toISOString(), access.issuedAt);
    assert.equal(new Date(saved.expires_at).toISOString(), access.expiresAt);
    assert.deepEqual(await f.users(), before);
    assert.equal((await f.database.query("SELECT id FROM auth_sessions")).rowCount, 0);
    assert.equal((await f.database.query("SELECT id FROM server_role_assignment_audit")).rowCount, 1);
    const events = await f.database.query<{ actor_id: string; action: string; object_id: string; result: string }>("SELECT actor_id,action,object_id,result FROM auth_audit_events ORDER BY action");
    assert.deepEqual(events.rows.map(row => row.action), ["login_challenge_requested", "login_email_delivery", "trusted_cli_test_challenge"]);
    assert.deepEqual(events.rows.find(row => row.action === "trusted_cli_test_challenge"), { actor_id: "fixture-admin", action: "trusted_cli_test_challenge", object_id: access.challengeId, result: "issued_locally" });
    const auditText = JSON.stringify(events.rows);
    for (const privateValue of [access.credential, codeOf(access), email, pepper]) assert.equal(auditText.includes(privateValue), false);
  } finally { await f.database.close(); }
});

test("unknown, ordinary and suspended accounts cannot receive a privileged test credential", async () => {
  const f = await fixture();
  try {
    await f.database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES('fixture-user','user@example.test','普通用户','UTC',$1,$1)", [start]);
    await assert.rejects(f.issue("unknown@example.test"), denied("ADMIN_TEST_ACCESS_DENIED"));
    await assert.rejects(f.issue("user@example.test"), denied("ADMIN_TEST_ACCESS_DENIED"));
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='fixture-admin'");
    const before = await f.users();
    await assert.rejects(f.issue(), denied("ADMIN_TEST_ACCESS_DENIED"));
    assert.deepEqual(await f.users(), before);
    assert.equal((await f.database.query("SELECT id FROM auth_login_challenges")).rowCount, 0);
    assert.equal((await f.database.query("SELECT id FROM auth_audit_events")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("a defensive unverified-account contract rejects issuance before any authentication write", async () => {
  // The current real schema requires email_verified_at NOT NULL. This explicit
  // SQL-port fixture checks defensive rejection without weakening that schema.
  const statements: string[] = [];
  const database: DatabasePort = {
    async query<Row>(statement: string) {
      statements.push(statement);
      return { rows: (statement.includes("FROM auth_users") ? [{ id: "unverified", status: "active", platform_roles: ["admin"], email_verified_at: null }] : []) as Row[], rowCount: 1 };
    },
    async transaction(work) { return work(database); },
  };
  await assert.rejects(issueAdminTestAccess({ database, codePepper: pepper, email }), denied("ADMIN_TEST_ACCESS_DENIED"));
  assert.ok(statements.some(statement => statement.includes("FOR UPDATE")));
  assert.equal(statements.some(statement => /^(?:INSERT|UPDATE|DELETE)/.test(statement)), false);
});

test("the normal verifier consumes CLI credentials once and retains the existing seven-day session policy", async () => {
  const f = await fixture();
  try {
    const before = await f.users(), access = await f.issue();
    const results = await Promise.allSettled([f.verify(access), f.verify(access)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const grant = results.find(result => result.status === "fulfilled");
    assert.ok(grant?.status === "fulfilled");
    assert.equal(grant.value.profile.id, "fixture-admin"); assert.equal(grant.value.returnTo, "/admin");
    assert.equal(grant.value.expiresAt, "2026-10-18T07:00:00.000Z");
    assert.deepEqual((await f.auth.requireActor(grant.value.sessionToken)).platformRoles, ["admin", "user"]);
    assert.deepEqual(await f.users(), before);
    assert.equal((await f.database.query("SELECT id FROM auth_sessions")).rowCount, 1);
    const challenge = (await f.database.query<{ consumed_at: Date }>("SELECT consumed_at FROM auth_login_challenges WHERE id=$1", [access.challengeId])).rows[0]!;
    assert.equal(new Date(challenge.consumed_at).toISOString(), start);
    await f.auth.logout(grant.value.sessionToken);
    assert.equal(await f.auth.getActor(grant.value.sessionToken), null);
  } finally { await f.database.close(); }
});

test("expiry and exhausted wrong-code attempts cannot be bypassed by a valid CLI credential", async () => {
  const f = await fixture();
  try {
    const expired = await f.issue(); f.advance(10 * 60_000);
    await assert.rejects(f.verify(expired), denied("AUTH_CHALLENGE_INVALID"));
    const limited = await f.issue();
    const wrong = codeOf(limited) === "00000000" ? "00000001" : "00000000";
    for (let count = 0; count < 5; count++) await assert.rejects(f.verify(limited, wrong), denied("AUTH_CHALLENGE_INVALID"));
    await assert.rejects(f.verify(limited), denied("AUTH_CHALLENGE_INVALID"));
    assert.equal((await f.database.query<{ failed_attempts: number }>("SELECT failed_attempts FROM auth_login_challenges WHERE id=$1", [limited.challengeId])).rows[0]?.failed_attempts, 5);
    assert.equal((await f.database.query("SELECT id FROM auth_sessions")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("CLI issuance uses existing resend and mailbox budgets and invalidates older challenges", async () => {
  const f = await fixture();
  try {
    const first = await f.issue();
    await assert.rejects(f.issue(), denied("AUTH_RATE_LIMITED"));
    f.advance(60_000); await f.issue();
    f.advance(60_000); const latest = await f.issue();
    f.advance(60_000); await assert.rejects(f.issue(), denied("AUTH_RATE_LIMITED"));
    assert.equal((await f.database.query("SELECT id FROM auth_login_challenges")).rowCount, 3);
    await assert.rejects(f.verify(first), denied("AUTH_CHALLENGE_INVALID"));
    await f.verify(latest);
  } finally { await f.database.close(); }
});

test("revoking the administrator role after issuance does not let a test credential grant it back", async () => {
  const f = await fixture();
  try {
    const access = await f.issue();
    await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user']::text[],revision=revision+1 WHERE id='fixture-admin'");
    const before = await f.users(), grant = await f.verify(access);
    assert.deepEqual((await f.auth.requireActor(grant.sessionToken)).platformRoles, ["user"]);
    assert.deepEqual(await f.users(), before);
    await assert.rejects(f.issue(), denied("ADMIN_TEST_ACCESS_DENIED"));
  } finally { await f.database.close(); }
});

test("a failed trusted issuance audit rolls back the challenge and its rate facts", async () => {
  const f = await fixture();
  try {
    const database: DatabasePort = {
      query: (...args) => f.database.query(...args),
      transaction: work => f.database.transaction(sql => work({ query(statement, parameters) {
        if (statement.includes("'trusted_cli_test_challenge'")) return Promise.reject(new Error("Fixture audit unavailable"));
        return sql.query(statement, parameters);
      } })),
    };
    await assert.rejects(issueAdminTestAccess({ database, codePepper: pepper, email, clock: f.clock }), /Fixture audit unavailable/);
    assert.equal((await f.database.query("SELECT id FROM auth_login_challenges")).rowCount, 0);
    assert.equal((await f.database.query("SELECT key FROM auth_rate_limits")).rowCount, 0);
    assert.equal((await f.database.query("SELECT id FROM auth_audit_events")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("private output refuses traversal, links and overwrites while preserving secret-free login URLs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "admin-test-output-fixture-"));
  try {
    const directory = join(workspace, ".runtime", "admin-test-access"); await mkdir(directory, { recursive: true });
    for (const path of [".runtime/outside.json", "../outside.json", ".runtime/admin-test-access/nested/access.json", ".runtime/admin-test-access/CON.json", ".runtime/admin-test-access/access.md"]) await assert.rejects(validateAdminTestOutput(workspace, path));
    const output = ".runtime/admin-test-access/fixture.json";
    const reserved = await reserveAdminTestOutput(workspace, output);
    const access = { credential: "fixture-challenge.12345678", challengeId: "fixture-challenge", email,
      issuedAt: start, expiresAt: "2026-10-11T07:10:00.000Z" };
    const document = adminTestAccessDocument(access, "https://events.example.test:44353");
    await reserved.file.writeFile(document); await reserved.file.close();
    await assert.rejects(reserveAdminTestOutput(workspace, output));
    assert.equal(await readFile(reserved.path, "utf8"), document);
    const parsed = JSON.parse(document);
    for (const url of Object.values(parsed.loginLinks) as string[]) {
      const params = new URL(url).searchParams;
      assert.equal(params.get("test"), "1"); assert.equal(params.get("returnTo"), "/admin");
      assert.equal(url.includes(access.credential), false); assert.equal(url.includes("12345678"), false);
    }
    assert.match(parsed.delivery, /未发送真实邮件/); assert.match(parsed.sessionPolicy, /7 天/);
    await assert.rejects(validateAdminTestOutput(workspace, join(directory, "fixture.json")));
    const link = join(directory, "link.json"), target = join(workspace, "outside-fixture.json"); await writeFile(target, "FIXTURE_ONLY");
    // Junctions need no Windows symlink privilege and exercise the same lstat/
    // realpath rejection for a linked output directory.
    const parentLink = join(workspace, "linked-workspace");
    await symlink(workspace, parentLink, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(validateAdminTestOutput(parentLink, ".runtime/admin-test-access/new.json"));
    if (process.platform !== "win32") {
      await symlink(target, link, "file");
      await assert.rejects(validateAdminTestOutput(workspace, ".runtime/admin-test-access/link.json"));
    }
  } finally {
    const normalized = resolve(workspace), rest = relative(resolve(tmpdir()), normalized);
    assert.equal(dirname(normalized), resolve(tmpdir())); assert.ok(rest.startsWith("admin-test-output-fixture-") && !rest.includes(sep));
    await rm(normalized, { recursive: true, force: true });
  }
});

test("the embedded database guard refuses a listening website before any database open", async () => {
  const server = createServer(socket => socket.end());
  try {
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await assert.rejects(assertEmbeddedServerStopped(address.port));
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await assertEmbeddedServerStopped(address.port);
  } finally { if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
});
