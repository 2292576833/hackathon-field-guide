import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError } from "../shared/errors.ts";
import { createOrganizerService, type Organization } from "../modules/organizer/index.ts";
import { createOrganizerMailAccounts, type OrganizerMailAccountMetadata, type OrganizerSmtpConfiguration } from "./organizer-mail-accounts.ts";

/** Real O01 and new SQL, memory-only PostgreSQL, all credential verification and send transports mocked. */
async function fixture(t: TestContext, timeoutMs = 1000) {
 const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
 await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY,status text,email_verified_at timestamptz,platform_roles text[]); CREATE TABLE mail_account_sessions(user_id text PRIMARY KEY REFERENCES auth_users(id),active boolean NOT NULL);");
 for (const path of ["../../migrations/042_organizer_core.sql", "./organizer-mail-accounts-schema.sql"]) await engine.exec(await readFile(new URL(path, import.meta.url), "utf8"));
 const ambient = new AsyncLocalStorage<SqlExecutor>(), statements: string[] = [], verified: OrganizerSmtpConfiguration[] = [], created: OrganizerSmtpConfiguration[] = [], sent: { from: string; to: string }[] = [];
 let nextId = 0, savepoint = 0, guards = 0, failGuardAt = -1;
 const time = { value: Date.parse("2026-10-11T04:00:00Z") }, clock = { now: () => new Date(time.value) }, ids = { next: () => `mail-account-${++nextId}` };
 const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({ async query<Row>(sql: string, values: readonly unknown[] = []) { statements.push(sql); const result = await query(sql, [...values]); return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 }; } });
 const direct = executor((sql, values) => engine.query(sql, values));
 const database: DatabasePort = {
  query: (sql, values) => (ambient.getStore() ?? direct).query(sql, values),
  async transaction(work) { const current = ambient.getStore(); if (current) { const name = `mail_accounts_${++savepoint}`; await current.query(`SAVEPOINT ${name}`); try { const value = await work(current); await current.query(`RELEASE SAVEPOINT ${name}`); return value; } catch (error) { await current.query(`ROLLBACK TO SAVEPOINT ${name}`); await current.query(`RELEASE SAVEPOINT ${name}`); throw error; } } return engine.transaction(tx => { const sql = executor((statement, values) => tx.query(statement, values)); return ambient.run(sql, () => work(sql)); }); },
 };
 const roles: Record<string, Actor["platformRoles"]> = { ownerA: ["user"], ownerB: ["user"], staff: ["user"], admin: ["user", "admin"] };
 for (const [id, role] of Object.entries(roles)) { await database.query("INSERT INTO auth_users VALUES($1,'active','2026-10-01',$2)", [id, role]); await database.query("INSERT INTO mail_account_sessions VALUES($1,true)", [id]); }
 const principal = (userId: string): OrganizerPrincipal => ({ actor: { userId, platformRoles: roles[userId] }, async guard(sql) { guards++; const user = (await sql.query<{ status: string; email_verified_at: Date | null; platform_roles: string[] }>("SELECT status,email_verified_at,platform_roles FROM auth_users WHERE id=$1 FOR SHARE", [userId])).rows[0], session = (await sql.query("SELECT user_id FROM mail_account_sessions WHERE user_id=$1 AND active FOR SHARE", [userId])).rowCount; if (guards === failGuardAt || !user || user.status !== "active" || !user.email_verified_at || !session || JSON.stringify(user.platform_roles) !== JSON.stringify(roles[userId])) throw new DomainError("CURRENT_SESSION_REQUIRED", "当前账号或会话不可用。", { status: 401 }); } });
 const organizer = createOrganizerService({ database, clock, ids });
 const verification = { mode: "verified" as "verified" | "failed" | "throw" | "timeout", hook: null as ((config: OrganizerSmtpConfiguration, signal: AbortSignal) => Promise<boolean>) | null, sendFails: false };
 const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
 const create = (encryptionKey = key) => createOrganizerMailAccounts({ database, clock, ids, encryptionKey, verificationTimeoutMs: timeoutMs,
  requireOrganizationManager: (sql, actor, id) => organizer.requireOrganizationManager(sql, actor, id),
  getOrganization: (sql, id) => organizer.repository.getOrganization(sql, id, false),
  resolvePrincipal: async request => { const id = request.headers.get("x-fixture-user"); return id && roles[id] ? principal(id) : null; },
  assertMutationAllowed: async request => { if (request.headers.get("origin") !== "http://test.local") throw new DomainError("ORIGIN_DENIED", "来源无效。", { status: 403 }); },
  async verifyCredentials(config, { signal }) { assert.equal(ambient.getStore(), undefined, "SMTP login verification never holds a DB transaction."); verified.push({ ...config }); if (verification.hook) return verification.hook(config, signal); if (verification.mode === "throw") throw new Error("PRIVATE_PROVIDER_DETAIL_AND_PASSWORD"); if (verification.mode === "timeout") return new Promise<boolean>(resolve => signal.addEventListener("abort", () => resolve(false), { once: true })); return verification.mode === "verified"; },
  createSmtpMailTransport(config) { created.push({ ...config }); return { async send(message, options) { assert.equal(ambient.getStore(), undefined); assert.equal(options.signal.aborted, false); sent.push({ from: message.from, to: message.to }); if (verification.sendFails) throw new Error("PRIVATE_PROVIDER_DETAIL_AND_PASSWORD"); } }; },
 });
 const module = create();
 async function organization(userId = "ownerA", approved = true): Promise<Organization> { const application = await organizer.createApplication(principal(userId), { name: `机构-${userId}`, kind: "community", description: "活动组织", contactName: "联系人", contactEmail: "contact@example.org", evidenceText: "活动依据", evidenceUrls: [] }); if (approved) await organizer.reviewApplication(principal("admin"), application.id, { expectedRevision: application.revision, decision: "approved", note: "隔离人工认证" }); return (await database.transaction(sql => organizer.repository.getOrganization(sql, application.organizationId)))!; }
 const input = { expectedRevision: 0, provider: "qq", email: "privateorganizer@qq.com", authorizationCode: "FIXTURE_PRIVATE_AUTHORIZATION_CODE" };
 const request = (orgId: string, method = "GET", userId?: string, body?: unknown, origin = "http://test.local", suffix = "") => new Request(`http://test.local/api/v1/organizer/organizations/${orgId}/mail-account${suffix}`, { method, headers: { origin, ...(userId ? { "x-fixture-user": userId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
 async function http<T>(org: Organization, method = "GET", userId?: string, body?: unknown, expected = 200, suffix = "") { const response = await module.handle(request(org.id, method, userId, body, "http://test.local", suffix), ["organizer", "organizations", org.id, "mail-account", ...(suffix ? ["disable"] : [])]); assert.ok(response); const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload)); assert.match(response.headers.get("cache-control") ?? "", /no-store/); return payload.data as T; }
 const sender = (org: Organization) => database.transaction(sql => module.getSender(sql, org.id));
 return { database, module, create, organizer, principal, organization, input, key, time, verified, created, sent, verification, statements, ambient, request, http, sender, advance: () => { time.value += 60001; }, failNextFinalGuard: () => { failGuardAt = guards + 2; } };
}

test("metadata GET is current organization-manager-only, read-only and never fetches or exposes credentials", async t => {
 const f = await fixture(t), org = await f.organization(), other = await f.organization("ownerB"), pending = await f.organization("ownerB", false);
 await f.organizer.grantStaff(f.principal("ownerA"), org.id, { expectedOrganizationRevision: org.revision, userId: "staff", eventId: null, role: "staff", capabilities: ["event_manage", "registration_manage"] });
 const before = f.statements.length, value = await f.http<OrganizerMailAccountMetadata>(org, "GET", "ownerA"); assert.equal(value.revision, 0); assert.equal(value.state, "unconfigured");
 for (const user of ["ownerB", "admin", "staff"]) await f.http(org, "GET", user, undefined, 403); await f.http(org, "GET", undefined, undefined, 401); await f.http(other, "GET", "ownerA", undefined, 403); await f.http(pending, "GET", "ownerB", undefined, 403);
 assert.deepEqual(f.statements.slice(before).filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql)), []); assert.ok(!f.statements.slice(before).some(sql => /SELECT.+credential/.test(sql))); assert.equal(f.verified.length, 0);
 await f.database.query("UPDATE mail_account_sessions SET active=false WHERE user_id='ownerA'"); await f.http(org, "GET", "ownerA", undefined, 401);
});

test("verified account encrypts both mailbox and authorization code, returning only masked safe metadata", async t => {
 const f = await fixture(t), org = await f.organization(), value = await f.http<OrganizerMailAccountMetadata>(org, "PUT", "ownerA", f.input);
 assert.equal(value.state, "verified"); assert.equal(value.revision, 1); assert.equal(value.maskedEmail, "p***@qq.com"); assert.doesNotMatch(JSON.stringify(value), /privateorganizer|FIXTURE_PRIVATE|credential|authorizationCode|password|cipher/);
 const storage = JSON.stringify((await f.database.query("SELECT * FROM organizer_mail_accounts")).rows) + JSON.stringify((await f.database.query("SELECT * FROM organizer_mail_account_audit")).rows) + JSON.stringify((await f.database.query("SELECT * FROM organizer_mail_verification_attempts")).rows); assert.doesNotMatch(storage, /privateorganizer@qq.com|FIXTURE_PRIVATE_AUTHORIZATION_CODE/);
 const sender = await f.sender(org); assert.ok(sender); assert.equal(sender.from, f.input.email); assert.deepEqual(f.created[0], { host: "smtp.qq.com", port: 465, secure: true, user: f.input.email, password: f.input.authorizationCode });
 await sender.transport.send({ from: sender.from, to: "participant@example.org", subject: "入选通知", text: "你已通过审核" }, { signal: new AbortController().signal }); assert.equal(f.sent[0].from, f.input.email);
 await assert.rejects(f.database.query("DELETE FROM organizer_mail_account_audit"), /immutable/);
});

test("only four literal SMTP profiles are accepted; arbitrary host, port, headers and Outlook password auth cannot reach verification", async t => {
 const f = await fixture(t), org = await f.organization();
 for (const input of [{ ...f.input, host: "127.0.0.1" }, { ...f.input, host: "smtp.qq.com", port: 25 }, { ...f.input, provider: "__proto__" }, { ...f.input, provider: "outlook" }, { ...f.input, email: "sender@example.org\r\nBcc:evil@example.org" }, { ...f.input, authorizationCode: "secret\u0000" }, { ...f.input, replyTo: "someone@example.org" }, { ...f.input, tls: { rejectUnauthorized: false } }]) await f.http(org, "PUT", "ownerA", input, 422);
 assert.equal(f.verified.length, 0); assert.equal((await f.module.get(f.principal("ownerA"), org.id)).state, "unconfigured");
 for (const [provider, host] of [["qq", "smtp.qq.com"], ["163", "smtp.163.com"], ["126", "smtp.126.com"], ["gmail", "smtp.gmail.com"]]) { const old = await f.module.get(f.principal("ownerA"), org.id); await f.module.save(f.principal("ownerA"), org.id, { ...f.input, expectedRevision: old.revision, provider }); assert.equal(f.verified.at(-1)!.host, host); assert.equal(f.verified.at(-1)!.secure, true); assert.equal(f.verified.at(-1)!.port, 465); f.advance(); }
});

test("failed or ambiguous login verification never overwrites a previously usable account", async t => {
 const f = await fixture(t), org = await f.organization(); await f.module.save(f.principal("ownerA"), org.id, f.input);
 const previous = (await f.database.query("SELECT * FROM organizer_mail_accounts")).rows[0];
 f.advance(); f.verification.mode = "failed"; await assert.rejects(f.module.save(f.principal("ownerA"), org.id, { ...f.input, expectedRevision: 1, authorizationCode: "BAD_FIXTURE_CODE" }), { code: "ORGANIZER_MAIL_VERIFICATION_FAILED" }); assert.deepEqual((await f.database.query("SELECT * FROM organizer_mail_accounts")).rows[0], previous);
 f.advance(); f.verification.mode = "throw"; const failed = await f.module.handle(f.request(org.id, "PUT", "ownerA", { ...f.input, expectedRevision: 1 }), ["organizer", "organizations", org.id, "mail-account"]); assert.equal(failed?.status, 503); assert.doesNotMatch(await failed!.text(), /PRIVATE_PROVIDER|FIXTURE_PRIVATE|privateorganizer/); assert.deepEqual((await f.database.query("SELECT * FROM organizer_mail_accounts")).rows[0], previous);
 const states = (await f.database.query<{ state: string }>("SELECT state FROM organizer_mail_verification_attempts ORDER BY sequence")).rows.map(row => row.state); assert.deepEqual(states, ["verified", "failed", "unknown_hold"]); assert.ok(await f.sender(org));
});

test("permission and session revoked during network verification block the second save transaction", async t => {
 const f = await fixture(t), org = await f.organization();
 f.verification.hook = async () => { await f.database.query("UPDATE mail_account_sessions SET active=false WHERE user_id='ownerA'"); return true; };
 await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "CURRENT_SESSION_REQUIRED" }); assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_mail_accounts")).rows[0].n, 0);
 await f.database.query("UPDATE mail_account_sessions SET active=true WHERE user_id='ownerA'"); f.advance(); f.verification.hook = async () => { await f.database.query("UPDATE organizer_staff_grants SET status='revoked',document=jsonb_set(document,'{status}','\"revoked\"'::jsonb) WHERE organization_id=$1 AND user_id='ownerA'", [org.id]); return true; };
 await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_FORBIDDEN" }); assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_mail_accounts")).rows[0].n, 0);
});

test("parallel verification never holds a database transaction; only one matching CAS setting can commit", async t => {
 const f = await fixture(t), org = await f.organization(); const waiting: ((verified: boolean) => void)[] = [], reached: (() => void)[] = [];
 f.verification.hook = () => new Promise<boolean>(resolve => { waiting.push(resolve); reached.shift()?.(); });
 const started1 = new Promise<void>(resolve => reached.push(resolve)), first = f.module.save(f.principal("ownerA"), org.id, f.input); await started1; f.advance();
 const started2 = new Promise<void>(resolve => reached.push(resolve)), second = f.module.save(f.principal("ownerA"), org.id, { ...f.input, email: "anotherorganizer@qq.com" }); await started2;
 waiting[0](true); await first; waiting[1](true); await assert.rejects(second, { code: "ORGANIZER_MAIL_REVISION_CONFLICT" }); assert.equal((await f.module.get(f.principal("ownerA"), org.id)).revision, 1); assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_mail_account_audit")).rows[0].n, 1);
});

test("disable clears credentials, preserves a revision tombstone and invalidates captured old transport", async t => {
 const f = await fixture(t), org = await f.organization(); await f.module.save(f.principal("ownerA"), org.id, f.input); const old = await f.sender(org); assert.ok(old);
 const disabled = await f.http<OrganizerMailAccountMetadata>(org, "POST", "ownerA", { expectedRevision: 1 }, 200, "/disable"); assert.equal(disabled.state, "disabled"); assert.equal(disabled.revision, 2); assert.equal(await f.sender(org), null);
 const row = (await f.database.query<{ credential: unknown }>("SELECT credential FROM organizer_mail_accounts")).rows[0]; assert.equal(row.credential, null);
 await assert.rejects(old.transport.send({ from: old.from, to: "participant@example.org", subject: "旧账号", text: "不能发送" }, { signal: new AbortController().signal }), { code: "ORGANIZER_MAIL_SENDER_CHANGED" }); assert.equal(f.sent.length, 0);
 f.advance(); await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_REVISION_CONFLICT" }); assert.equal(f.verified.length, 1);
 const second = await f.organization("ownerB"); await f.module.disable(f.principal("ownerB"), second.id, { expectedRevision: 0 }); assert.equal((await f.module.get(f.principal("ownerB"), second.id)).revision, 1); assert.equal(await f.sender(second), null);
});

test("disabling while verification is in flight prevents that old expected revision from reviving the sender", async t => {
 const f = await fixture(t), org = await f.organization(); let release!: (value: boolean) => void, signal!: () => void; const started = new Promise<void>(resolve => { signal = resolve; });
 f.verification.hook = async () => { signal(); return new Promise<boolean>(resolve => { release = resolve; }); };
 const saving = f.module.save(f.principal("ownerA"), org.id, f.input); await started; await f.module.disable(f.principal("ownerA"), org.id, { expectedRevision: 0 }); release(true); await assert.rejects(saving, { code: "ORGANIZER_MAIL_REVISION_CONFLICT" }); assert.equal(await f.sender(org), null); assert.equal((await f.module.get(f.principal("ownerA"), org.id)).state, "disabled");
});

test("ciphertext is bound to organization/revision/provider/masked identity and corruption never silently selects a fallback", async t => {
 const f = await fixture(t), org = await f.organization(), other = await f.organization("ownerB"); await f.module.save(f.principal("ownerA"), org.id, f.input);
 const row = (await f.database.query<{ credential: unknown }>("SELECT credential FROM organizer_mail_accounts WHERE organization_id=$1", [org.id])).rows[0];
 await f.database.query("INSERT INTO organizer_mail_accounts SELECT $1,revision,state,provider,masked_email,credential,verified_at,updated_at FROM organizer_mail_accounts WHERE organization_id=$2", [other.id, org.id]); await assert.rejects(f.sender(other), { code: "ORGANIZER_MAIL_UNAVAILABLE" });
 const wrongKey = f.create(new Uint8Array(32)); await assert.rejects(f.database.transaction(sql => wrongKey.getSender(sql, org.id)), { code: "ORGANIZER_MAIL_UNAVAILABLE" });
 await f.database.query("UPDATE organizer_mail_accounts SET credential=jsonb_set(credential,'{tag}','\"malformed\"'::jsonb) WHERE organization_id=$1", [org.id]); await assert.rejects(f.sender(org), { code: "ORGANIZER_MAIL_UNAVAILABLE" });
 assert.ok(row.credential); assert.throws(() => f.create(new Uint8Array(31)), /32-byte/);
});

test("captured sender cannot spoof From, survive account replacement or send after organization suspension", async t => {
 const f = await fixture(t), org = await f.organization(); await f.module.save(f.principal("ownerA"), org.id, f.input); const old = await f.sender(org); assert.ok(old);
 await assert.rejects(old.transport.send({ from: "spoof@example.org", to: "participant@example.org", subject: "通知", text: "文字" }, { signal: new AbortController().signal }), { code: "ORGANIZER_MAIL_SENDER_CHANGED" });
 f.advance(); await f.module.save(f.principal("ownerA"), org.id, { ...f.input, expectedRevision: 1, email: "replacement@qq.com" }); await assert.rejects(old.transport.send({ from: old.from, to: "participant@example.org", subject: "通知", text: "文字" }, { signal: new AbortController().signal }), { code: "ORGANIZER_MAIL_SENDER_CHANGED" });
 const current = await f.sender(org); assert.ok(current); await f.database.query("UPDATE organizer_organizations SET status='suspended',document=jsonb_set(document,'{status}','\"suspended\"'::jsonb) WHERE id=$1", [org.id]); assert.equal(await f.sender(org), null); await assert.rejects(current.transport.send({ from: current.from, to: "participant@example.org", subject: "通知", text: "文字" }, { signal: new AbortController().signal }), { code: "ORGANIZER_MAIL_SENDER_CHANGED" }); assert.equal(f.sent.length, 0);
});

test("verification limits survive restart, isolate organizations, enforce UTC daily count and keep only safe attempt facts", async t => {
 const f = await fixture(t), org = await f.organization(), other = await f.organization("ownerB"); f.verification.mode = "failed";
 await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_FAILED" }); await assert.rejects(f.create().save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_RATE_LIMIT" }); assert.equal(f.verified.length, 1);
 await assert.rejects(f.module.save(f.principal("ownerB"), other.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_FAILED" });
 for (let count = 1; count < 10; count++) { f.advance(); await assert.rejects(f.create().save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_FAILED" }); }
 f.advance(); await assert.rejects(f.create().save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_DAILY_LIMIT" }); assert.equal(f.verified.length, 11);
 f.time.value = Date.parse("2026-10-12T00:00:00Z"); await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_FAILED" }); assert.equal(f.verified.length, 12);
 const facts = JSON.stringify((await f.database.query("SELECT * FROM organizer_mail_verification_attempts")).rows); assert.doesNotMatch(facts, /privateorganizer|FIXTURE_PRIVATE|PRIVATE_PROVIDER|credential|email|password/); await assert.rejects(f.database.query("DELETE FROM organizer_mail_verification_attempts"), /cannot be deleted/); await assert.rejects(f.database.query("UPDATE organizer_mail_verification_attempts SET state='verified'"), /immutable/);
});

test("verification timeout is held without retry, late completion cannot save, and a stale started attempt still consumes quota", async t => {
 const f = await fixture(t, 5), org = await f.organization(); f.verification.mode = "timeout";
 await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_FAILED" }); assert.equal((await f.module.get(f.principal("ownerA"), org.id)).state, "unconfigured");
 assert.equal((await f.database.query<{ state: string }>("SELECT state FROM organizer_mail_verification_attempts")).rows[0].state, "unknown_hold"); await assert.rejects(f.create().save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_RATE_LIMIT" }); assert.equal(f.verified.length, 1);
 f.advance(); await f.database.query("INSERT INTO organizer_mail_verification_attempts VALUES('crash-started',DEFAULT,$1,'ownerA','verifying',$2,$2)", [org.id, new Date(f.time.value).toISOString()]); await assert.rejects(f.create().save(f.principal("ownerA"), org.id, f.input), { code: "ORGANIZER_MAIL_VERIFICATION_RATE_LIMIT" }); assert.equal(f.verified.length, 1);
});

test("final save guard failure rolls credentials and audit back while retaining factual successful verification", async t => {
 const f = await fixture(t), org = await f.organization(); f.verification.hook = async () => { f.failNextFinalGuard(); return true; };
 await assert.rejects(f.module.save(f.principal("ownerA"), org.id, f.input), { code: "CURRENT_SESSION_REQUIRED" }); assert.equal((await f.module.get(f.principal("ownerA"), org.id)).state, "unconfigured"); assert.equal((await f.database.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_mail_account_audit")).rows[0].n, 0); assert.equal((await f.database.query<{ state: string }>("SELECT state FROM organizer_mail_verification_attempts")).rows[0].state, "verified");
});

test("HTTP Origin, method, strict streamed 16KiB and current role checks reject before any external verification", async t => {
 const f = await fixture(t), org = await f.organization(); const route = ["organizer", "organizations", org.id, "mail-account"];
 const csrf = await f.module.handle(f.request(org.id, "PUT", "ownerA", f.input, "http://evil.local"), route); assert.equal(csrf?.status, 403);
 const method = await f.module.handle(f.request(org.id, "DELETE", "ownerA"), route); assert.equal(method?.status, 405); assert.equal(method?.headers.get("allow"), "GET, PUT");
 await f.http(org, "PUT", "ownerA", { ...f.input, authorizationCode: "a".repeat(16384) }, 413); await f.http(org, "PUT", "admin", f.input, 403);
 const missingType = new Request("http://test.local", { method: "PUT", headers: { origin: "http://test.local", "x-fixture-user": "ownerA" }, body: "{}" }); assert.equal((await f.module.handle(missingType, route))?.status, 415);
 await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin']::text[] WHERE id='ownerA'"); await f.http(org, "PUT", "ownerA", f.input, 401); assert.equal(f.verified.length, 0);
 assert.equal(await f.module.handle(f.request(org.id), ["unrelated"]), null);
});

test("trusted configured count includes only current approved organizations and is read-only without credentials", async t => {
 const f = await fixture(t), org = await f.organization(), other = await f.organization("ownerB"); await f.module.save(f.principal("ownerA"), org.id, f.input); await f.module.save(f.principal("ownerB"), other.id, f.input);
 assert.equal(await f.module.countConfigured(), 2);
 await f.database.query("UPDATE organizer_organizations SET status='suspended',document=jsonb_set(document,'{status}','\"suspended\"'::jsonb) WHERE id=$1", [other.id]); const before = f.statements.length; assert.equal(await f.module.countConfigured(), 1);
 assert.deepEqual(f.statements.slice(before).filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql)), []); assert.ok(!f.statements.slice(before).some(sql => /SELECT.+credential/.test(sql)));
 await f.module.disable(f.principal("ownerA"), org.id, { expectedRevision: 1 }); assert.equal(await f.module.countConfigured(), 0); assert.equal(f.sent.length, 0);
});

test("provider send errors remain unknown and cannot leak raw details through the trusted wrapper", async t => {
 const f = await fixture(t), org = await f.organization(); await f.module.save(f.principal("ownerA"), org.id, f.input); const sender = await f.sender(org); assert.ok(sender); f.verification.sendFails = true;
 await assert.rejects(sender.transport.send({ from: sender.from, to: "participant@example.org", subject: "通知", text: "文字" }, { signal: new AbortController().signal }), (error: unknown) => { assert.ok(error instanceof DomainError); assert.equal(error.code, "ORGANIZER_MAIL_SEND_UNCONFIRMED"); assert.doesNotMatch(error.message, /PRIVATE_PROVIDER|FIXTURE_PRIVATE|privateorganizer/); return true; }); assert.equal(f.sent.length, 1);
});
