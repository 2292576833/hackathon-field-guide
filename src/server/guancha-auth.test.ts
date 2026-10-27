import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  AuthService, PostgresAuthStore, createNodeAuthCrypto,
} from "../modules/auth/index.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { createGuanchaAuth, type GuanchaConfirmLinkInput } from "./guancha-auth.ts";

const issuer = "https://watcha.cn";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Isolated PostgreSQL engine; never opens a disk database or contacts a provider.
 * PGlite validates SQL/atomicity but cannot establish real multi-connection locks. */
async function fixture(t: TestContext) {
  const engine = new PGlite(); await engine.waitReady;
  t.after(() => engine.close());
  for (const file of ["../modules/auth/migrations/001_auth.sql", "../modules/auth/migrations/002_session_last_seen.sql", "../modules/guancha-login/schema.sql"]) {
    await engine.exec(await readFile(new URL(file, import.meta.url), "utf8"));
  }
  const state = {
    time: Date.parse("2026-10-12T04:00:00.000Z"),
    afterQuery: null as null | ((sql: string) => void),
    failQuery: null as null | ((sql: string) => boolean),
  };
  let nextId = 0;
  const statements: string[] = [], parameters: unknown[][] = [];
  const clock = { now: () => new Date(state.time) }, ids = { next: () => `guancha-test-${++nextId}` };
  const crypto = createNodeAuthCrypto("isolated-guancha-auth-test-pepper-at-least-32-bytes");
  const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      statements.push(sql); parameters.push([...values]);
      if (state.failQuery?.(sql)) throw new Error("isolated write failure");
      const result = await query(sql, [...values]);
      state.afterQuery?.(sql);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const database: DatabasePort = {
    query: direct.query,
    transaction: work => engine.transaction(tx => work(executor((sql, values) => tx.query(sql, values)))),
  };
  const service = createGuanchaAuth({ database, crypto, clock, ids });
  const m01 = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto, clock, ids,
    email: { async sendLoginCode() { throw new Error("No email expected in this test."); } } });
  const browser = crypto.generateSessionToken();
  async function account(id: string) {
    const now = clock.now().toISOString(), sessionToken = crypto.generateSessionToken();
    await database.query(
      "INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$4)",
      [id, `${id}@example.test`, `本站昵称-${id}`, now],
    );
    await database.query(
      "INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$4,$5,$4)",
      [`session-${id}`, id, crypto.hashSessionToken(sessionToken), now, new Date(state.time + 7 * 86_400_000).toISOString()],
    );
    return sessionToken;
  }
  async function start(subject = "subject-private", returnTo = "/events", browserBinding = browser, identityIssuer = issuer) {
    return service.completeLogin({ identity: { issuer: identityIssuer, subject, displayName: "不应覆盖本站昵称" },
      now: clock.now().toISOString(), returnTo, browserBindingHash: sha256(browserBinding) });
  }
  async function pending(subject = "subject-private", returnTo = "/events", browserBinding = browser, identityIssuer = issuer) {
    const result = await start(subject, returnTo, browserBinding, identityIssuer);
    assert.equal(result.status, "link_required");
    if (result.status !== "link_required") throw new Error("Expected unbound identity.");
    return result;
  }
  const confirm = (pendingToken: string, sessionToken: string, browserBinding = browser) => service.confirmLink({ pendingToken, sessionToken, browserBinding });
  const rows = (table: "auth_users" | "auth_sessions" | "auth_audit_events" | "guancha_identity_bindings" | "guancha_pending_links") => database.query(`SELECT * FROM ${table}`).then(result => result.rows);
  return { state, clock, ids, crypto, database, service, m01, browser, account, start, pending, confirm, rows, statements, parameters };
}

test("unbound identity yields a short-lived private pending handle without inventing an account", async t => {
  const f = await fixture(t), result = await f.pending("subject-private", "https://external.invalid");
  assert.equal(result.returnTo, "/app");
  assert.match(result.pendingToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(result.expiresAt) - f.state.time, 10 * 60_000);
  assert.deepEqual(await f.rows("auth_users"), []);
  assert.deepEqual(await f.rows("auth_sessions"), []);
  const rows = await f.rows("guancha_pending_links");
  assert.equal(rows[0].token_hash, sha256(result.pendingToken));
  assert.equal(rows[0].browser_binding_hash, sha256(f.browser));
  assert.equal(rows[0].consumed_at, null);
  const stored = JSON.stringify([...rows, ...await f.rows("auth_audit_events")]);
  assert.ok(!stored.includes(result.pendingToken)); assert.ok(!stored.includes(f.browser));
  assert.doesNotMatch(JSON.stringify(await f.rows("auth_audit_events")), /subject-private|watcha\.cn|不应覆盖/);
});

test("explicit binding consumes one pending handle and later login grants a normal M01 session", async t => {
  const f = await fixture(t), token = await f.account("owner"), pending = await f.pending("member-A", "/participation?event=event-A");
  const originalAccount = await f.rows("auth_users");
  f.statements.length = 0;
  // 关联成功还会带回**待继承的观猹资料**（昵称/头像地址），供根层在首次关联后同步。
  // 这里断言昵称被原样带出、且待关联记录里没有头像时明确为 null。
  assert.deepEqual(await f.confirm(pending.pendingToken, token), {
    success: true, returnTo: "/participation?event=event-A",
    profileSync: { displayName: "不应覆盖本站昵称", avatarUrl: null },
  });
  const lockPositions = [
    f.statements.findIndex(sql => sql.includes("pg_advisory_xact_lock")),
    f.statements.findIndex(sql => sql.includes("auth_users") && sql.includes("FOR UPDATE")),
    f.statements.findIndex(sql => sql.includes("auth_sessions") && sql.includes("FOR UPDATE")),
    f.statements.findIndex(sql => sql.includes("guancha_pending_links") && sql.includes("FOR UPDATE")),
  ];
  assert.ok(lockPositions.every((value, index) => value >= 0 && (!index || value > lockPositions[index - 1])));
  assert.equal((await f.rows("auth_sessions")).length, 1, "binding does not replace or duplicate the current session");
  assert.ok((await f.rows("guancha_pending_links"))[0].consumed_at);
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "GUANCHA_LINK_INVALID" });
  const result = await f.start("member-A", "/events");
  assert.equal(result.status, "authenticated"); if (result.status !== "authenticated") return;
  assert.equal(result.grant.profile.id, "owner");
  assert.equal(result.grant.profile.displayName, "本站昵称-owner");
  assert.equal(result.grant.returnTo, "/events");
  assert.deepEqual(await f.m01.requireActor(result.grant.sessionToken), { userId: "owner", platformRoles: ["user"] });
  assert.equal(Date.parse(result.grant.expiresAt) - f.state.time, 7 * 86_400_000);
  assert.deepEqual(await f.rows("auth_users"), originalAccount);
  const stored = JSON.stringify([...await f.rows("auth_sessions"), ...await f.rows("auth_audit_events")]);
  assert.ok(!stored.includes(result.grant.sessionToken)); assert.ok(!stored.includes(token));
  assert.ok(!JSON.stringify(f.parameters).includes(result.grant.sessionToken), "raw session token never reaches SQL");
});

test("suspended, deletion-pending and deleted mapped accounts cannot create a session or a replacement account", async t => {
  const f = await fixture(t), token = await f.account("disabled"), pending = await f.pending();
  await f.confirm(pending.pendingToken, token);
  for (const status of ["suspended", "deletion_pending", "deleted"]) {
    await f.database.query("UPDATE auth_users SET status=$1 WHERE id='disabled'", [status]);
    await assert.rejects(f.start(), { code: "GUANCHA_ACCOUNT_UNAVAILABLE" });
    assert.equal((await f.rows("auth_users")).length, 1);
    assert.equal((await f.rows("auth_sessions")).length, 1);
    assert.equal(await f.m01.getActor(token), null);
  }
  assert.equal((await f.rows("auth_audit_events")).filter(row => row.action === "guancha_login" && row.result === "denied").length, 3);
});

test("wrong browser and malformed handles do not consume a valid pending association", async t => {
  const f = await fixture(t), token = await f.account("owner"), pending = await f.pending();
  await assert.rejects(f.confirm(pending.pendingToken, token, f.crypto.generateSessionToken()), { code: "GUANCHA_LINK_INVALID" });
  await assert.rejects(f.confirm("not-a-token", token), { code: "GUANCHA_LINK_INVALID" });
  await assert.rejects(f.confirm(f.crypto.generateSessionToken(), token), { code: "GUANCHA_LINK_INVALID" });
  await assert.rejects(f.service.confirmLink({ pendingToken: pending.pendingToken, browserBinding: f.browser, sessionToken: token, userId: "attacker" } as GuanchaConfirmLinkInput), { code: "GUANCHA_LINK_INVALID" });
  assert.equal((await f.rows("guancha_pending_links"))[0].consumed_at, null);
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
  await f.confirm(pending.pendingToken, token);
});

test("disabled accounts, missing/revoked/expired sessions and old authentication cannot confirm", async t => {
  const f = await fixture(t), token = await f.account("owner"), pending = await f.pending();
  await assert.rejects(f.service.confirmLink({ pendingToken: pending.pendingToken, browserBinding: f.browser, sessionToken: null }), { code: "AUTH_SESSION_REQUIRED" });
  await assert.rejects(f.confirm(pending.pendingToken, f.crypto.generateSessionToken()), { code: "AUTH_SESSION_REQUIRED" });
  await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='owner'");
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "AUTH_SESSION_REQUIRED" });
  await f.database.query("UPDATE auth_users SET status='active' WHERE id='owner'");
  await f.database.query("UPDATE auth_sessions SET revoked_at=$1 WHERE id='session-owner'", [f.clock.now().toISOString()]);
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "AUTH_SESSION_REQUIRED" });
  await f.database.query("UPDATE auth_sessions SET revoked_at=NULL,created_at=$1,expires_at=$2 WHERE id='session-owner'", [new Date(f.state.time - 1000).toISOString(), f.clock.now().toISOString()]);
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "AUTH_SESSION_REQUIRED" });
  await f.database.query("UPDATE auth_sessions SET expires_at=$1,authenticated_at=$2 WHERE id='session-owner'", [new Date(f.state.time + 86_400_000).toISOString(), new Date(f.state.time - 300_001).toISOString()]);
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "AUTH_REAUTHENTICATION_REQUIRED" });
  assert.equal((await f.rows("guancha_pending_links"))[0].consumed_at, null);
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
});

test("pending expiration uses the current clock and rejects future or elapsed records", async t => {
  const f = await fixture(t), token = await f.account("owner"), pending = await f.pending();
  const createdAt = f.clock.now().toISOString();
  await f.database.query("UPDATE guancha_pending_links SET created_at=$1", [new Date(f.state.time + 1000).toISOString()]);
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "GUANCHA_LINK_INVALID" });
  await f.database.query("UPDATE guancha_pending_links SET created_at=$1", [createdAt]);
  f.state.time += 10 * 60_000;
  await f.database.query("UPDATE auth_sessions SET authenticated_at=$1", [f.clock.now().toISOString()]);
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "GUANCHA_LINK_INVALID" });
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
});

test("a pending handle cannot overwrite another user's binding or the current user's other subject", async t => {
  const f = await fixture(t), ownerToken = await f.account("owner"), otherToken = await f.account("other");
  const first = await f.pending("same-subject"), competing = await f.pending("same-subject"), different = await f.pending("different-subject");
  await f.confirm(first.pendingToken, ownerToken);
  const bindings = await f.rows("guancha_identity_bindings");
  await assert.rejects(f.confirm(competing.pendingToken, otherToken), { code: "GUANCHA_LINK_CONFLICT" });
  await assert.rejects(f.confirm(different.pendingToken, ownerToken), { code: "GUANCHA_LINK_CONFLICT" });
  await assert.rejects(f.confirm(competing.pendingToken, ownerToken), { code: "GUANCHA_LINK_CONFLICT" });
  assert.deepEqual(await f.rows("guancha_identity_bindings"), bindings);
  assert.equal((await f.rows("guancha_pending_links")).filter(row => row.consumed_at !== null).length, 1);
});

test("issuer and subject remain exact, case-sensitive identity keys", async t => {
  const f = await fixture(t), tokenA = await f.account("a"), tokenB = await f.account("b");
  const upper = await f.pending("Member"), lower = await f.pending("member"), otherIssuer = await f.pending("Member", "/events", f.browser, "https://watcha.cn/other-issuer");
  await f.confirm(upper.pendingToken, tokenA); await f.confirm(lower.pendingToken, tokenB); await f.confirm(otherIssuer.pendingToken, tokenB);
  const a = await f.start("Member"), b = await f.start("member"), c = await f.start("Member", "/events", f.browser, "https://watcha.cn/other-issuer");
  assert.equal(a.status === "authenticated" && a.grant.profile.id, "a");
  assert.equal(b.status === "authenticated" && b.grant.profile.id, "b");
  assert.equal(c.status === "authenticated" && c.grant.profile.id, "b");
});

test("failed final writes roll binding and pending consumption back together", async t => {
  const f = await fixture(t), token = await f.account("owner"), pending = await f.pending();
  f.state.failQuery = sql => sql.includes("INSERT INTO auth_audit_events");
  await assert.rejects(f.confirm(pending.pendingToken, token), /isolated write failure/);
  f.state.failQuery = null;
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
  assert.equal((await f.rows("guancha_pending_links"))[0].consumed_at, null);
  await f.confirm(pending.pendingToken, token);
  const sessions = await f.rows("auth_sessions");
  f.state.failQuery = sql => sql.includes("INSERT INTO auth_audit_events");
  await assert.rejects(f.start(), /isolated write failure/);
  f.state.failQuery = null;
  assert.deepEqual(await f.rows("auth_sessions"), sessions, "login session is not left behind after audit failure");
});

test("waiting for locked records or final writes cannot extend a pending or session lifetime", async t => {
  const f = await fixture(t), token = await f.account("owner"), pending = await f.pending();
  await f.database.query("UPDATE guancha_pending_links SET expires_at=$1", [new Date(f.state.time + 1000).toISOString()]);
  f.state.afterQuery = sql => { if (sql.includes("guancha_pending_links") && sql.includes("FOR UPDATE")) f.state.time += 1000; };
  await assert.rejects(f.confirm(pending.pendingToken, token), { code: "GUANCHA_LINK_INVALID" });
  f.state.afterQuery = null;
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
  const second = await f.pending("second-subject");
  await f.database.query("UPDATE auth_sessions SET expires_at=$1", [new Date(f.state.time + 1000).toISOString()]);
  f.state.afterQuery = sql => { if (sql.includes("INSERT INTO auth_audit_events")) f.state.time += 1000; };
  await assert.rejects(f.confirm(second.pendingToken, token), { code: "AUTH_SESSION_REQUIRED" });
  f.state.afterQuery = null;
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
  assert.ok((await f.rows("guancha_pending_links")).every(row => row.consumed_at === null));
  const third = await f.pending("third-subject");
  await f.database.query("UPDATE auth_sessions SET expires_at=$1,authenticated_at=$2", [
    new Date(f.state.time + 86_400_000).toISOString(), new Date(f.state.time - 299_000).toISOString(),
  ]);
  f.state.afterQuery = sql => { if (sql.includes("INSERT INTO auth_audit_events")) f.state.time += 1001; };
  await assert.rejects(f.confirm(third.pendingToken, token), { code: "AUTH_REAUTHENTICATION_REQUIRED" });
  f.state.afterQuery = null;
  assert.deepEqual(await f.rows("guancha_identity_bindings"), []);
  assert.ok((await f.rows("guancha_pending_links")).every(row => row.consumed_at === null));
});

test("server policy and identity inputs are validated without accepting callback-controlled actor fields", async t => {
  const f = await fixture(t);
  assert.throws(() => createGuanchaAuth({ database: f.database, crypto: f.crypto, clock: f.clock, ids: f.ids, pendingLifetimeMs: 16 * 60_000 }), /lifetimes/);
  for (const identity of [{ issuer: "http://watcha.cn", subject: "a" }, { issuer, subject: " " }, { issuer, subject: "a".repeat(513) }]) {
    await assert.rejects(f.service.completeLogin({ identity, now: f.clock.now().toISOString(), returnTo: "/events", browserBindingHash: sha256(f.browser) }), { code: "GUANCHA_LINK_INVALID" });
  }
  const result = await f.service.completeLogin({ identity: { issuer, subject: "a", displayName: "owner@example.test" },
    now: "2000-01-01T00:00:00.000Z", returnTo: "//evil.test", browserBindingHash: sha256(f.browser) });
  assert.equal(result.status, "link_required");
  assert.equal(result.status === "link_required" && Date.parse(result.expiresAt), f.state.time + 10 * 60_000, "supplied timestamp cannot backdate or extend the authoritative clock");
  assert.deepEqual(await f.rows("auth_users"), []);
});

test("first-time linking adopts the Guancha nickname as a default without overwriting a self-chosen name", async t => {
  const f = await fixture(t);
  const now = f.clock.now().toISOString();
  // 账号一律用**真实注册默认值**建（昵称「参赛新人」、未自定义），再用显式标记区分两种情形：
  // 这正是被测试的判定条件——不能靠"昵称取值恰好等于某个默认值"来猜。
  await f.database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$4)",
    ["adopter", "adopter@example.test", "参赛新人", now]);
  await f.database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$4)",
    ["chooser", "chooser@example.test", "参赛新人", now]);
  // 乙：用户自己改过昵称 → 标记为已自定义。
  await f.database.query("UPDATE auth_users SET display_name=$2, display_name_customized=true WHERE id=$1", ["chooser", "我自己起的名字"]);

  const nameOf = async (userId: string) =>
    (await f.database.query<{ display_name: string; display_name_customized: boolean }>(
      "SELECT display_name, display_name_customized FROM auth_users WHERE id=$1", [userId])).rows[0];

  assert.deepEqual(await nameOf("adopter"), { display_name: "参赛新人", display_name_customized: false }, "前置：新账号是默认名且未自定义");
  assert.ok(f.service.syncLinkedProfile, "接口必须暴露资料同步能力");

  // 无条件 UPDATE 的 rowCount 必须可信，否则下面的断言没有意义。
  const plain = await f.database.query("UPDATE auth_users SET revision=revision+1 WHERE id=$1", ["adopter"]);
  assert.equal(plain.rowCount, 1, "无条件 UPDATE 的 rowCount 应可信");

  await f.service.syncLinkedProfile("adopter", { displayName: "观猹昵称", avatarUrl: null });
  await f.service.syncLinkedProfile("chooser", { displayName: "观猹昵称", avatarUrl: null });

  assert.deepEqual(await nameOf("adopter"), { display_name: "观猹昵称", display_name_customized: true }, "默认名应继承观猹昵称并标记为已定");
  assert.deepEqual(await nameOf("chooser"), { display_name: "我自己起的名字", display_name_customized: true }, "用户自定的昵称不得被覆盖");

  // 再次调用不得改写已经定下来的昵称。
  await f.service.syncLinkedProfile("adopter", { displayName: "后来的观猹名", avatarUrl: null });
  assert.equal((await nameOf("adopter"))!.display_name, "观猹昵称", "已继承过的昵称不再被后续登录改写");

  // 不合法的观猹昵称一律忽略（超长 / 空白），且绝不能把昵称写成空。
  await f.database.query("UPDATE auth_users SET display_name_customized=false WHERE id=$1", ["adopter"]);
  await f.service.syncLinkedProfile("adopter", { displayName: "x".repeat(61), avatarUrl: null });
  assert.equal((await nameOf("adopter"))!.display_name, "观猹昵称", "超长昵称应被忽略");
  await f.service.syncLinkedProfile("adopter", { displayName: "   ", avatarUrl: null });
  assert.equal((await nameOf("adopter"))!.display_name, "观猹昵称", "空白昵称应被忽略");

  // 头像下载缺失（本夹具未注入 fetchAvatar/saveAvatar）绝不能抛出：登录本身已经成功。
  await f.service.syncLinkedProfile("adopter", { displayName: null, avatarUrl: "https://watcha.cn/whatever.png" });
  assert.equal((await nameOf("adopter"))!.display_name, "观猹昵称");
});
