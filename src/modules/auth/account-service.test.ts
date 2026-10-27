import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AccountEmailPort, OwnDataExportPort } from "./account-ports.ts";
import { PostgresAccountStore } from "./account-postgres.ts";
import { AccountCompletionService } from "./account-service.ts";
import type { AccountCompletionPolicy, AccountDeletionRequest, EmailChangeChallenge, OwnDataBundle, StoredDataExport } from "./account-types.ts";
import { createNodeAuthCrypto } from "./crypto.ts";
import { PostgresAuthStore } from "./postgres.ts";
import { AuthService } from "./service.ts";
import { CapturingLoginEmail, FixtureClock, FixtureIds } from "./test-fixtures.ts";

// Disposable in-memory PostgreSQL engine. These tests never use DATABASE_URL,
// the production PGlite directory, live email or another module's tables.
const errorCode = (code: string) => (failure: unknown): boolean => failure instanceof DomainError && failure.code === code;
const wrongCode = (code: string): string => code === "00000000" ? "11111111" : "00000000";
type EmailInput = Parameters<AccountEmailPort["sendEmailChangeCode"]>[0];
class CapturingAccountEmail implements AccountEmailPort {
  readonly sent: EmailInput[] = [];
  failAt: number | null = null;
  async sendEmailChangeCode(input: EmailInput): Promise<void> {
    this.sent.push({ ...input });
    if (this.sent.length === this.failAt) throw new Error("test-only unknown delivery outcome");
  }
}
const ownBundle = (actor: Actor): OwnDataBundle => ({
  records: {
    personal: [{ id: "personal-1", userId: actor.userId, data: { purpose: "参加比赛" } }],
    conversations: [{ id: "conversation-1", userId: actor.userId, data: { message: "本人对话" } }],
    generations: [{ id: "generation-1", userId: actor.userId, data: { answer: "本人生成" } }],
    assessments: [{ id: "assessment-1", userId: actor.userId, data: { rawAnswer: "本人原始回答" } }],
    retrospectives: [{ id: "retrospective-1", userId: actor.userId, data: { lesson: "本人复盘" } }],
    bookmarks: [{ id: "bookmark-1", userId: actor.userId, data: { resourceId: "approved-resource-1" } }],
  },
  projects: [{ projectId: "project-1", name: "当前有权项目", summary: "可公开给当前成员的摘要" }],
});

async function fixture(t: TestContext, policy: Partial<AccountCompletionPolicy> = {}) {
  const engine = new PGlite(); await engine.waitReady;
  t.after(() => engine.close());
  for (const file of ["001_auth.sql", "002_session_last_seen.sql", "003_registration_display_name.sql", "004_account_completion.sql"]) {
    await engine.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"));
  }
  const clock = new FixtureClock("2026-10-10T04:00:00.000Z"), ids = new FixtureIds();
  const crypto = createNodeAuthCrypto("account-service-test-only-pepper-at-least-32-bytes");
  const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      const result = await query(sql, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const database: DatabasePort = {
    query: direct.query,
    transaction: work => engine.transaction(tx => work(executor((sql, values) => tx.query(sql, values)))),
  };
  const loginEmail = new CapturingLoginEmail(), email = new CapturingAccountEmail();
  const auth = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto, email: loginEmail, clock, ids });
  const state = {
    collection: ownBundle,
    collectionFailure: false,
    projectAccess: true,
    blocked: false,
    collectionActors: [] as string[],
    accessActors: [] as string[],
    impactActors: [] as string[],
  };
  const ownData: OwnDataExportPort = {
    async collectOwnData(actor, sql, limits) {
      state.collectionActors.push(actor.userId);
      assert.ok(limits.maxRecords > 0 && limits.maxBytes > 0);
      // Make collection failure abort a real SQL transaction; the service must
      // preserve a recoverable failed request in a separate transaction.
      if (state.collectionFailure) await sql.query("SELECT * FROM account_test_missing_table");
      await sql.query("SELECT 1");
      return state.collection(actor);
    },
    async assertProjectAccess(actor, projectIds, sql) {
      state.accessActors.push(actor.userId);
      assert.deepEqual(projectIds, ["project-1"]);
      await sql.query("SELECT 1");
      if (!state.projectAccess) throw new DomainError("PROJECT_PERMISSION_REQUIRED", "测试项目权限已撤销。", { status: 403 });
    },
  };
  const service = new AccountCompletionService({ store: new PostgresAccountStore(database, ids, clock), crypto, email, ownData,
    deletionImpact: { async inspectOwnDeletion(actor, sql) {
      state.impactActors.push(actor.userId); await sql.query("SELECT 1");
      return { lastManagerProjects: state.blocked ? [{ projectId: "project-1", name: "仍需转交的项目", remediationUrl: "/app/projects/project-1/team" }] : [],
        notices: ["申请不会自动删除队友成果或外部 GitHub 仓库。"] };
    } }, clock, ids, policy });
  const login = async (address: string, client = `test-login-${address}`) => {
    const receipt = await auth.requestLoginChallenge(address, client);
    return auth.verifyLoginChallenge({ challengeId: receipt.challengeId, code: loginEmail.sent.at(-1)!.code }, client);
  };
  const owner = await login("owner@example.test"), other = await login("other@example.test");
  const body = async <T>(table: string, id: string): Promise<T> => {
    assert.ok(["auth_data_exports", "auth_deletion_requests", "auth_email_change_challenges"].includes(table));
    const result = await database.query<{ body: T }>(`SELECT body FROM ${table} WHERE id = $1`, [id]);
    assert.equal(result.rows.length, 1); return result.rows[0]!.body;
  };
  const emailChange = async (newEmail = "next@example.test") => {
    const profile = await auth.getCurrentProfile(owner.sessionToken);
    const receipt = await service.requestEmailChange(owner.sessionToken, { newEmail, expectedRevision: profile.revision }, "trusted-change-client");
    const current = email.sent.at(-2)!, next = email.sent.at(-1)!;
    assert.equal(current.purpose, "current_email"); assert.equal(next.purpose, "new_email");
    return { receipt, currentCode: current.code, newCode: next.code };
  };
  return { engine, database, clock, ids, auth, service, owner, other, login, loginEmail, email, state, body, emailChange };
}

test("导出请求和文件仅本人可读，状态响应不包含原始资料或凭据", async t => {
  const f = await fixture(t); const request = await f.service.requestExport(f.owner.sessionToken);
  const ready = await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  assert.equal(ready.status, "ready"); assert.equal(ready.revision, 2);
  await assert.rejects(f.service.prepareExport(f.other.sessionToken, request.id, ready.revision), errorCode("ACCOUNT_EXPORT_NOT_FOUND"));
  await assert.rejects(f.service.downloadExport(f.other.sessionToken, request.id), errorCode("ACCOUNT_EXPORT_NOT_FOUND"));
  assert.equal((await f.service.getDataOverview(f.other.sessionToken)).exports.length, 0);
  const document = JSON.parse((await f.service.downloadExport(f.owner.sessionToken, request.id)).json);
  assert.equal(document.userId, f.owner.profile.id);
  assert.equal(document.profile.id, f.owner.profile.id);
  assert.equal(document.records.assessments[0].data.rawAnswer, "本人原始回答");
  assert.deepEqual(f.state.collectionActors, [f.owner.profile.id]);
  assert.ok(f.state.accessActors.every(actor => actor === f.owner.profile.id));
  const overview = await f.service.getDataOverview(f.owner.sessionToken);
  assert.ok(!JSON.stringify(overview).includes("本人原始回答"));
  assert.ok(!("document" in overview.exports[0]!)); assert.ok(!("userId" in overview.exports[0]!));
  const audit = await f.database.query("SELECT * FROM auth_audit_events");
  const auditJson = JSON.stringify(audit.rows);
  assert.ok(!auditJson.includes(f.owner.sessionToken)); assert.ok(!auditJson.includes("本人原始回答"));
});

test("导出拒绝混入其他人的原始资料并持久保存失败状态", async t => {
  const f = await fixture(t);
  f.state.collection = actor => { const bundle = ownBundle(actor); return { ...bundle, records: { ...bundle.records,
    assessments: [{ id: "foreign-answer", userId: f.other.profile.id, data: { rawAnswer: "他人回答" } }] } }; };
  const request = await f.service.requestExport(f.owner.sessionToken);
  const failure = await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  assert.equal(failure.status, "failed"); assert.equal(failure.errorCode, "ACCOUNT_EXPORT_SCOPE_INVALID");
  assert.equal((await f.body<StoredDataExport>("auth_data_exports", request.id)).document, null);
  await assert.rejects(f.service.downloadExport(f.owner.sessionToken, request.id), errorCode("ACCOUNT_EXPORT_UNAVAILABLE"));
});

test("导出递归拒绝安全字段而不把字段值带入错误或状态", async t => {
  const f = await fixture(t);
  f.state.collection = actor => { const bundle = ownBundle(actor); return { ...bundle, records: { ...bundle.records,
    personal: [{ id: "unsafe-record", userId: actor.userId, data: { nested: [{ access_token: "test-secret-do-not-export" }] } }] } }; };
  const request = await f.service.requestExport(f.owner.sessionToken);
  const failure = await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  assert.equal(failure.errorCode, "ACCOUNT_EXPORT_UNSAFE_DATA");
  assert.ok(!JSON.stringify(failure).includes("test-secret-do-not-export"));
  assert.equal((await f.body<StoredDataExport>("auth_data_exports", request.id)).document, null);
});

test("导出SQL失败可重试且CAS拒绝旧版本，原请求有效期不延长", async t => {
  const f = await fixture(t, { exportLifetimeMs: 10_000 }); f.state.collectionFailure = true;
  const request = await f.service.requestExport(f.owner.sessionToken);
  const failed = await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 1); assert.equal(failed.errorCode, "ACCOUNT_EXPORT_COLLECTION_FAILED");
  await assert.rejects(f.service.prepareExport(f.owner.sessionToken, request.id, request.revision), errorCode("VERSION_CONFLICT"));
  f.clock.advance(5_000); f.state.collectionFailure = false;
  const ready = await f.service.prepareExport(f.owner.sessionToken, request.id, failed.revision);
  assert.equal(ready.status, "ready"); assert.equal(ready.attempts, 2); assert.equal(ready.expiresAt, request.expiresAt);
  f.clock.set(request.expiresAt);
  await assert.rejects(f.service.downloadExport(f.owner.sessionToken, request.id), errorCode("ACCOUNT_EXPORT_UNAVAILABLE"));
  const expired = await f.body<StoredDataExport>("auth_data_exports", request.id);
  assert.equal(expired.status, "expired"); assert.equal(expired.document, null); assert.equal(expired.byteLength, null);
});

test("导出限制请求次数、资料数量和失败重试次数", async t => {
  const f = await fixture(t, { maxExportsPerWindow: 1, maxExportAttempts: 2, maxExportRecords: 1 });
  const request = await f.service.requestExport(f.owner.sessionToken);
  await assert.rejects(f.service.requestExport(f.owner.sessionToken), errorCode("ACCOUNT_EXPORT_RATE_LIMITED"));
  const first = await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  assert.equal(first.errorCode, "ACCOUNT_EXPORT_TOO_LARGE");
  const second = await f.service.prepareExport(f.owner.sessionToken, request.id, first.revision);
  assert.equal(second.attempts, 2);
  await assert.rejects(f.service.prepareExport(f.owner.sessionToken, request.id, second.revision), errorCode("ACCOUNT_EXPORT_RETRIES_EXHAUSTED"));
});

test("项目撤权后拒绝下载已生成导出，不沿用快照权限", async t => {
  const f = await fixture(t); const request = await f.service.requestExport(f.owner.sessionToken);
  await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  f.state.projectAccess = false;
  await assert.rejects(f.service.downloadExport(f.owner.sessionToken, request.id), errorCode("PROJECT_PERMISSION_REQUIRED"));
  assert.equal((await f.body<StoredDataExport>("auth_data_exports", request.id)).status, "ready");
});

test("资料收集途中会话过期不返回文件或保留已生成资料", async t => {
  const f = await fixture(t); const request = await f.service.requestExport(f.owner.sessionToken);
  f.state.collection = actor => { f.clock.set(f.owner.expiresAt); return ownBundle(actor); };
  await assert.rejects(f.service.prepareExport(f.owner.sessionToken, request.id, request.revision), errorCode("AUTH_SESSION_REQUIRED"));
  const saved = await f.body<StoredDataExport>("auth_data_exports", request.id);
  assert.equal(saved.status, "queued"); assert.equal(saved.document, null);
  await assert.rejects(f.service.downloadExport(f.owner.sessionToken, request.id), errorCode("AUTH_SESSION_REQUIRED"));
});

test("资料读取完成后项目复核失败，持久保存可恢复失败且不留下快照", async t => {
  const f = await fixture(t); const request = await f.service.requestExport(f.owner.sessionToken);
  f.state.projectAccess = false;
  const failed = await f.service.prepareExport(f.owner.sessionToken, request.id, request.revision);
  assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "ACCOUNT_EXPORT_COLLECTION_FAILED");
  assert.equal((await f.body<StoredDataExport>("auth_data_exports", request.id)).document, null);
  f.state.projectAccess = true;
  assert.equal((await f.service.prepareExport(f.owner.sessionToken, request.id, failed.revision)).status, "ready");
});

test("删除申请说明最后管理员阻塞、本人隔离、幂等及取消版本冲突", async t => {
  const f = await fixture(t); f.state.blocked = true;
  const request = await f.service.requestDeletion(f.owner.sessionToken);
  assert.equal(request.status, "blocked"); assert.equal(request.impact.lastManagerProjects[0]!.remediationUrl, "/app/projects/project-1/team");
  assert.equal((await f.service.requestDeletion(f.owner.sessionToken)).id, request.id);
  assert.equal((await f.database.query("SELECT id FROM auth_deletion_requests")).rows.length, 1);
  assert.ok(await f.auth.getActor(f.owner.sessionToken));
  await assert.rejects(f.service.cancelDeletion(f.other.sessionToken, request.id, request.revision), errorCode("ACCOUNT_DELETION_NOT_FOUND"));
  await assert.rejects(f.service.cancelDeletion(f.owner.sessionToken, request.id, request.revision + 1), errorCode("VERSION_CONFLICT"));
  const cancelled = await f.service.cancelDeletion(f.owner.sessionToken, request.id, request.revision);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.revision, 2);
  assert.deepEqual(await f.service.cancelDeletion(f.owner.sessionToken, request.id, cancelled.revision), cancelled);
  assert.ok(await f.auth.getActor(f.owner.sessionToken));
});

test("转交后复核解除删除阻塞，真正进入处理才撤销会话和停止登录", async t => {
  const f = await fixture(t); f.state.blocked = true;
  const request = await f.service.requestDeletion(f.owner.sessionToken);
  const stillBlocked = await f.service.beginDeletionProcessing(f.owner.profile.id, request.id, request.revision);
  assert.equal(stillBlocked.status, "blocked"); assert.ok(await f.auth.getActor(f.owner.sessionToken));
  f.state.blocked = false;
  const pending = await f.service.refreshDeletion(f.owner.sessionToken, request.id, stillBlocked.revision);
  assert.equal(pending.status, "pending"); assert.ok(await f.auth.getActor(f.owner.sessionToken));
  await assert.rejects(f.service.beginDeletionProcessing(f.owner.profile.id, request.id, stillBlocked.revision), errorCode("VERSION_CONFLICT"));
  const processing = await f.service.beginDeletionProcessing(f.owner.profile.id, request.id, pending.revision);
  assert.equal(processing.status, "processing");
  const stored = await f.body<AccountDeletionRequest>("auth_deletion_requests", request.id);
  assert.equal(stored.status, "processing");
  const user = await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [f.owner.profile.id]);
  assert.equal(user.rows[0]!.status, "deletion_pending");
  assert.equal(await f.auth.getActor(f.owner.sessionToken), null); assert.ok(await f.auth.getActor(f.other.sessionToken));
  const sessions = await f.database.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM auth_sessions WHERE user_id=$1", [f.owner.profile.id]);
  assert.ok(sessions.rows.every(row => row.revoked_at !== null));
  await assert.rejects(f.service.cancelDeletion(f.owner.sessionToken, request.id, processing.revision), errorCode("AUTH_SESSION_REQUIRED"));
  f.clock.advance(60_000);
  await assert.rejects(f.login("owner@example.test"), errorCode("AUTH_CHALLENGE_INVALID"));
});

test("取消后同一时刻新建删除申请始终优先读取活跃申请并保持幂等", async t => {
  const f = await fixture(t);
  // Opaque IDs have no time ordering; force the cancelled ID to sort later than
  // the new active ID while created_at remains identical.
  let count = 0;
  f.ids.next = () => ["z-request", "audit-created", "audit-cancel", "a-request", "audit-new"][count++] ?? `later-id-${count}`;
  const first = await f.service.requestDeletion(f.owner.sessionToken);
  await f.service.cancelDeletion(f.owner.sessionToken, first.id, first.revision);
  const next = await f.service.requestDeletion(f.owner.sessionToken);
  assert.notEqual(next.id, first.id); assert.equal(next.status, "pending");
  assert.equal((await f.service.getDataOverview(f.owner.sessionToken)).deletionRequest?.id, next.id);
  assert.equal((await f.service.requestDeletion(f.owner.sessionToken)).id, next.id);
  assert.equal((await f.database.query("SELECT id FROM auth_deletion_requests WHERE status <> 'cancelled'")).rows.length, 1);
});

test("邮箱更换须近期认证，旧资料版本和不变邮箱不会发信", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.requestEmailChange(f.owner.sessionToken, { newEmail: "next@example.test", expectedRevision: 2 }, "client"), errorCode("VERSION_CONFLICT"));
  await assert.rejects(f.service.requestEmailChange(f.owner.sessionToken, { newEmail: f.owner.profile.email, expectedRevision: 1 }, "client"), errorCode("ACCOUNT_EMAIL_UNCHANGED"));
  f.clock.advance(5 * 60_000 + 1);
  await assert.rejects(f.service.requestEmailChange(f.owner.sessionToken, { newEmail: "next@example.test", expectedRevision: 1 }, "client"), errorCode("AUTH_REAUTHENTICATION_REQUIRED"));
  await assert.rejects(f.service.requestDeletion(f.owner.sessionToken), errorCode("AUTH_REAUTHENTICATION_REQUIRED"));
  assert.equal(f.email.sent.length, 0); assert.ok(await f.auth.getActor(f.owner.sessionToken));
});

test("邮箱双重验证保留稳定ID和资料，撤旧会话与旧登录码，消费后不可重放", async t => {
  const f = await fixture(t);
  await f.auth.updateOwnProfile(f.owner.sessionToken, { displayName: "同一个参赛者", timezone: "Asia/Shanghai", expectedRevision: 1 });
  f.clock.advance(60_000); const secondDevice = await f.login("owner@example.test", "owner-second-device");
  f.clock.advance(60_000);
  const pendingLogin = await f.auth.requestLoginChallenge("owner@example.test", "old-mailbox-device");
  const pendingCode = f.loginEmail.sent.at(-1)!.code;
  const issued = await f.emailChange();
  assert.equal(f.email.sent.at(-2)!.email, "owner@example.test"); assert.equal(f.email.sent.at(-1)!.email, "next@example.test");
  assert.ok(!JSON.stringify(issued.receipt).includes(issued.currentCode)); assert.ok(!JSON.stringify(issued.receipt).includes(issued.newCode));
  const changed = await f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: issued.receipt.challengeId, currentCode: issued.currentCode, newCode: issued.newCode }, "verify-client");
  assert.equal(changed.requiresLogin, true); assert.equal(changed.profile.id, f.owner.profile.id); assert.equal(changed.profile.email, "next@example.test");
  assert.equal(changed.profile.displayName, "同一个参赛者"); assert.equal(changed.profile.timezone, "Asia/Shanghai"); assert.equal(changed.profile.revision, 3);
  assert.equal(await f.auth.getActor(f.owner.sessionToken), null); assert.equal(await f.auth.getActor(secondDevice.sessionToken), null);
  assert.ok(await f.auth.getActor(f.other.sessionToken));
  await assert.rejects(f.auth.verifyLoginChallenge({ challengeId: pendingLogin.challengeId, code: pendingCode }, "old-mailbox-device"), errorCode("AUTH_CHALLENGE_INVALID"));
  const saved = await f.body<EmailChangeChallenge>("auth_email_change_challenges", issued.receipt.challengeId);
  assert.ok(saved.consumedAt); assert.notEqual(saved.currentCodeHash, issued.currentCode); assert.notEqual(saved.newCodeHash, issued.newCode);
  const again = await f.login("next@example.test", "new-mailbox-device"); assert.equal(again.profile.id, f.owner.profile.id);
  await assert.rejects(f.service.verifyEmailChange(again.sessionToken, { challengeId: issued.receipt.challengeId, currentCode: issued.currentCode, newCode: issued.newCode }, "replay-client"), errorCode("AUTH_CHALLENGE_INVALID"));
  const audit = JSON.stringify((await f.database.query("SELECT * FROM auth_audit_events")).rows);
  assert.ok(!audit.includes(issued.currentCode)); assert.ok(!audit.includes(issued.newCode)); assert.ok(!audit.includes(f.owner.sessionToken));
});

test("其他账号不能验证本人邮箱挑战，错误的任一证明都会累计尝试", async t => {
  const f = await fixture(t, { maxCodeFailures: 2 }); const issued = await f.emailChange();
  const verify = (token: string, currentCode: string, newCode: string) => f.service.verifyEmailChange(token, { challengeId: issued.receipt.challengeId, currentCode, newCode }, "verify-client");
  await assert.rejects(verify(f.other.sessionToken, issued.currentCode, issued.newCode), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal((await f.body<EmailChangeChallenge>("auth_email_change_challenges", issued.receipt.challengeId)).failedAttempts, 0);
  await assert.rejects(verify(f.owner.sessionToken, wrongCode(issued.currentCode), issued.newCode), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(verify(f.owner.sessionToken, issued.currentCode, wrongCode(issued.newCode)), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(verify(f.owner.sessionToken, issued.currentCode, issued.newCode), errorCode("AUTH_CHALLENGE_INVALID"));
  const stored = await f.body<EmailChangeChallenge>("auth_email_change_challenges", issued.receipt.challengeId);
  assert.equal(stored.failedAttempts, 2); assert.equal(stored.consumedAt, null);
  assert.equal((await f.auth.getCurrentProfile(f.owner.sessionToken)).email, "owner@example.test");
});

test("邮件受理未知会持久封存本次挑战，读取和验证不会自动重发", async t => {
  const f = await fixture(t); f.email.failAt = 2;
  await assert.rejects(f.emailChange(), errorCode("AUTH_EMAIL_UNAVAILABLE"));
  const rows = await f.database.query<{ body: EmailChangeChallenge }>("SELECT body FROM auth_email_change_challenges WHERE user_id=$1", [f.owner.profile.id]);
  const challenge = rows.rows[0]!.body;
  assert.equal(challenge.delivery, "unknown"); assert.equal(challenge.consumedAt, null);
  await f.service.getDataOverview(f.owner.sessionToken);
  await assert.rejects(f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: challenge.id, currentCode: f.email.sent[0]!.code, newCode: f.email.sent[1]!.code }, "client"), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(f.emailChange(), errorCode("AUTH_RATE_LIMITED"));
  assert.equal(f.email.sent.length, 2); assert.ok(await f.auth.getActor(f.owner.sessionToken));
  f.clock.advance(60_000); f.email.failAt = null;
  const replacement = await f.emailChange(); assert.notEqual(replacement.receipt.challengeId, challenge.id);
  assert.ok((await f.body<EmailChangeChallenge>("auth_email_change_challenges", challenge.id)).revokedAt);
});

test("邮箱发送冷却与用户发送总限额、验证总限额不会被重发或换客户端绕过", async t => {
  const f = await fixture(t, { sendCooldownMs: 1_000, maxSendsPerUser: 2, maxVerificationsPerUser: 2, maxCodeFailures: 10 });
  const first = await f.emailChange();
  await assert.rejects(f.emailChange("another@example.test"), errorCode("AUTH_RATE_LIMITED"));
  const verify = (challengeId: string, client: string) => f.service.verifyEmailChange(f.owner.sessionToken, { challengeId, currentCode: "bad", newCode: "bad" }, client);
  await assert.rejects(verify(first.receipt.challengeId, "client-one"), errorCode("AUTH_CHALLENGE_INVALID"));
  f.clock.advance(1_000); const replacement = await f.emailChange("another@example.test");
  await assert.rejects(verify(replacement.receipt.challengeId, "client-two"), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(verify(replacement.receipt.challengeId, "client-three"), errorCode("AUTH_RATE_LIMITED"));
  f.clock.advance(1_000);
  await assert.rejects(f.emailChange("third@example.test"), errorCode("AUTH_RATE_LIMITED"));
  assert.equal(f.email.sent.length, 4);
});

test("邮箱挑战在过期边界不可验证，新挑战撤销旧挑战", async t => {
  const f = await fixture(t, { challengeLifetimeMs: 2_000, sendCooldownMs: 1_000 }); const first = await f.emailChange();
  f.clock.advance(1_000); const next = await f.emailChange();
  const verify = (issued: typeof first) => f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: issued.receipt.challengeId, currentCode: issued.currentCode, newCode: issued.newCode }, "client");
  await assert.rejects(verify(first), errorCode("AUTH_CHALLENGE_INVALID"));
  f.clock.set(next.receipt.expiresAt);
  await assert.rejects(verify(next), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal((await f.auth.getCurrentProfile(f.owner.sessionToken)).email, "owner@example.test");
});

test("邮箱已被其他账号使用时原子拒绝且不消费挑战或撤销会话", async t => {
  const f = await fixture(t); const issued = await f.emailChange("other@example.test");
  await assert.rejects(f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: issued.receipt.challengeId, currentCode: issued.currentCode, newCode: issued.newCode }, "client"), errorCode("ACCOUNT_EMAIL_CONFLICT"));
  assert.equal((await f.body<EmailChangeChallenge>("auth_email_change_challenges", issued.receipt.challengeId)).consumedAt, null);
  assert.equal((await f.auth.getCurrentProfile(f.owner.sessionToken)).email, "owner@example.test");
  assert.ok(await f.auth.getActor(f.other.sessionToken));
});

test("挑战签发后资料版本变化会拒绝邮箱提交，不覆盖新的资料", async t => {
  const f = await fixture(t); const issued = await f.emailChange();
  await f.auth.updateOwnProfile(f.owner.sessionToken, { displayName: "新版昵称", timezone: "UTC", expectedRevision: 1 });
  await assert.rejects(f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: issued.receipt.challengeId, currentCode: issued.currentCode, newCode: issued.newCode }, "client"), errorCode("VERSION_CONFLICT"));
  const profile = await f.auth.getCurrentProfile(f.owner.sessionToken);
  assert.equal(profile.displayName, "新版昵称"); assert.equal(profile.email, "owner@example.test"); assert.equal(profile.revision, 2);
  assert.equal((await f.body<EmailChangeChallenge>("auth_email_change_challenges", issued.receipt.challengeId)).consumedAt, null);
  f.clock.advance(60_000); const replacement = await f.emailChange();
  const changed = await f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: replacement.receipt.challengeId, currentCode: replacement.currentCode, newCode: replacement.newCode }, "replacement-client");
  assert.equal(changed.profile.displayName, "新版昵称"); assert.equal(changed.profile.email, "next@example.test");
});

test("两账号竞争同一新邮箱只允许一份身份成功，不会合并账号", async t => {
  const f = await fixture(t); const first = await f.emailChange("contended@example.test");
  f.clock.advance(60_000);
  const second = await f.service.requestEmailChange(f.other.sessionToken, { newEmail: "contended@example.test", expectedRevision: 1 }, "other-change-client");
  const otherCurrent = f.email.sent.at(-2)!.code, otherNew = f.email.sent.at(-1)!.code;
  const results = await Promise.allSettled([
    f.service.verifyEmailChange(f.owner.sessionToken, { challengeId: first.receipt.challengeId, currentCode: first.currentCode, newCode: first.newCode }, "owner-verify"),
    f.service.verifyEmailChange(f.other.sessionToken, { challengeId: second.challengeId, currentCode: otherCurrent, newCode: otherNew }, "other-verify"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && errorCode("ACCOUNT_EMAIL_CONFLICT")(rejected.reason));
  const users = await f.database.query<{ id: string; email: string }>("SELECT id,email FROM auth_users ORDER BY id");
  assert.equal(users.rows.length, 2); assert.equal(users.rows.filter(row => row.email === "contended@example.test").length, 1);
  assert.deepEqual(users.rows.map(row => row.id).sort(), [f.owner.profile.id, f.other.profile.id].sort());
});
