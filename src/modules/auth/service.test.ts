import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createNodeAuthCrypto } from "./crypto.ts";
import { AuthService, normalizeLoginEmail, safeAuthReturnTo } from "./service.ts";
import type { AuthPolicy, ProfileUpdate } from "./types.ts";
import { CapturingLoginEmail, deferred, FixtureClock, FixtureIds, SerialAuthStoreFixture } from "./test-fixtures.ts";

function fixture(policy: Partial<AuthPolicy> = {}) {
  const clock = new FixtureClock(); const ids = new FixtureIds();
  const crypto = createNodeAuthCrypto("fixture-only-secret-material-at-least-32-bytes");
  const store = new SerialAuthStoreFixture(clock); const email = new CapturingLoginEmail();
  const service = new AuthService({ clock, ids, crypto, store, email, policy });
  return { clock, ids, crypto, store, email, service };
}
type Fixture = ReturnType<typeof fixture>;
const errorCode = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;
const wrongCode = (code: string): string => code === "00000000" ? "11111111" : "00000000";
async function challenge(f: Fixture, address = "newbie@example.com", client = "trusted-client-a") {
  const receipt = await f.service.requestLoginChallenge(address, client);
  const mail = f.email.sent.at(-1)!;
  return { receipt, code: mail.code };
}
async function login(f: Fixture, address = "newbie@example.com", client = "trusted-client-a") {
  const issued = await challenge(f, address, client);
  const grant = await f.service.verifyLoginChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, client);
  return { ...issued, grant };
}

test("验证只消费一次；同邮箱重新登录恢复稳定身份且默认只有user角色", async () => {
  const f = fixture(); const first = await login(f, " Newbie@Example.com ");
  assert.deepEqual(await f.service.requireActor(first.grant.sessionToken), { userId: first.grant.profile.id, platformRoles: ["user"] });
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: first.receipt.challengeId, code: first.code }, "another-client"), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal(f.store.snapshot().sessions.length, 1);
  await f.service.logout(first.grant.sessionToken);
  f.clock.advance(60_000);
  const restored = await login(f, "newbie@example.com", "new-browser");
  assert.equal(restored.grant.profile.id, first.grant.profile.id);
  assert.equal(f.store.snapshot().users.length, 1);
  assert.notEqual(restored.grant.sessionToken, first.grant.sessionToken);
});

test("并发提交同一验证码只创建一份有效会话", async () => {
  const f = fixture(); const issued = await challenge(f);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => f.service.verifyLoginChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, `client-${index}`)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failures = results.filter((result) => result.status === "rejected");
  assert.equal(failures.length, 11);
  for (const failure of failures) assert.ok(errorCode("AUTH_CHALLENGE_INVALID")(failure.reason));
  assert.equal(f.store.snapshot().sessions.length, 1);
  assert.equal(f.store.snapshot().users.length, 1);
});

test("验证码在expiresAt边界和排队期间过期均不创建用户或会话", async () => {
  const f = fixture(); const issued = await challenge(f);
  f.clock.set(issued.receipt.expiresAt);
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, "client"), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal(f.store.snapshot().users.length, 0);
  assert.equal(f.store.snapshot().sessions.length, 0);
  const waiting = fixture(); const next = await challenge(waiting);
  waiting.clock.set(new Date(Date.parse(next.receipt.expiresAt) - 1).toISOString());
  const blocker = waiting.store.blockTransactions(); await blocker.entered;
  const verification = waiting.service.verifyLoginChallenge({ challengeId: next.receipt.challengeId, code: next.code }, "client");
  waiting.clock.advance(1); blocker.release(); await blocker.finished;
  await assert.rejects(verification, errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal(waiting.store.snapshot().sessions.length, 0);
});

test("邮箱冷却跨客户端生效，精确冷却/窗口边界允许重发", async () => {
  const f = fixture({ sendCooldownMs: 1_000, rateWindowMs: 10_000, maxSendsPerEmail: 2 });
  await challenge(f);
  await assert.rejects(challenge(f, "newbie@example.com", "another-client"), errorCode("AUTH_RATE_LIMITED"));
  f.clock.advance(999);
  await assert.rejects(challenge(f, "newbie@example.com", "another-client"), errorCode("AUTH_RATE_LIMITED"));
  f.clock.advance(1); await challenge(f, "newbie@example.com", "another-client");
  f.clock.advance(1_000);
  await assert.rejects(challenge(f, "newbie@example.com", "third-client"), errorCode("AUTH_RATE_LIMITED"));
  f.clock.advance(8_000); await challenge(f, "newbie@example.com", "third-client");
  assert.equal(f.email.sent.length, 3);
});

test("发送客户端额度跨邮箱生效，验证客户端额度计入未知挑战", async () => {
  const f = fixture({ maxSendsPerClient: 2, maxVerificationsPerClient: 2, rateWindowMs: 120_000 });
  await challenge(f, "one@example.com", "shared-client");
  await challenge(f, "two@example.com", "shared-client");
  await assert.rejects(challenge(f, "three@example.com", "shared-client"), errorCode("AUTH_RATE_LIMITED"));
  const verifyUnknown = () => f.service.verifyLoginChallenge({ challengeId: "unknown", code: "12345678" }, "verify-client");
  await assert.rejects(verifyUnknown(), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(verifyUnknown(), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(verifyUnknown(), errorCode("AUTH_RATE_LIMITED"));
  f.clock.advance(120_000);
  await challenge(f, "three@example.com", "shared-client");
  await assert.rejects(verifyUnknown(), errorCode("AUTH_CHALLENGE_INVALID"));
});

test("重发使旧码失效；累计邮箱验证额度不会随重发或更换客户端清零", async () => {
  const f = fixture({ maxCodeFailures: 2, maxVerificationsPerEmail: 3 });
  const first = await challenge(f);
  for (let index = 0; index < 2; index++) {
    await assert.rejects(f.service.verifyLoginChallenge({ challengeId: first.receipt.challengeId, code: wrongCode(first.code) }, `old-${index}`), errorCode("AUTH_CHALLENGE_INVALID"));
  }
  f.clock.advance(60_000); const replacement = await challenge(f);
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: first.receipt.challengeId, code: first.code }, "old-correct"), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: replacement.receipt.challengeId, code: wrongCode(replacement.code) }, "new-wrong"), errorCode("AUTH_CHALLENGE_INVALID"));
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: replacement.receipt.challengeId, code: replacement.code }, "new-correct"), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal(f.store.snapshot().sessions.length, 0);
  assert.equal(f.store.snapshot().challenges.find((value) => value.id === replacement.receipt.challengeId)?.failedAttempts, 1);
  f.clock.advance(15 * 60_000);
  const recovered = await login(f, "newbie@example.com", "recovery-client");
  assert.ok(recovered.grant.sessionToken);
});

test("格式错误和并发猜测累计失败；达到尝试上限后正确码也不可消费", async () => {
  const f = fixture({ maxCodeFailures: 3 }); const issued = await challenge(f);
  for (const code of [null, "1234", " 12345678 "]) {
    await assert.rejects(f.service.verifyLoginChallenge({ challengeId: issued.receipt.challengeId, code }, "client"), errorCode("AUTH_CHALLENGE_INVALID"));
  }
  assert.equal(f.store.snapshot().challenges[0]?.failedAttempts, 3);
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, "fresh-client"), errorCode("AUTH_CHALLENGE_INVALID"));
  const concurrent = fixture({ maxCodeFailures: 3 }); const next = await challenge(concurrent);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => concurrent.service.verifyLoginChallenge({ challengeId: next.receipt.challengeId, code: wrongCode(next.code) }, `client-${index}`)));
  assert.ok(results.every((result) => result.status === "rejected" && errorCode("AUTH_CHALLENGE_INVALID")(result.reason)));
  assert.equal(concurrent.store.snapshot().challenges[0]?.failedAttempts, 3);
  assert.equal(concurrent.store.snapshot().sessions.length, 0);
});

test("邮件失败保持失败事实并脱敏错误，pending邮件不可验证", async () => {
  const f = fixture(); f.email.failure = new Error("provider credential secret must not escape");
  await assert.rejects(f.service.requestLoginChallenge("newbie@example.com", "client"), (error: unknown) => {
    assert.ok(error instanceof DomainError); assert.equal(error.code, "AUTH_EMAIL_UNAVAILABLE");
    assert.equal(error.status, 503); assert.ok(!error.message.includes("credential")); return true;
  });
  const failed = f.store.snapshot().challenges[0]!;
  assert.equal(failed.delivery, "failed");
  await assert.rejects(f.service.verifyLoginChallenge({ challengeId: failed.id, code: f.email.sent[0]!.code }, "client"), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal(f.store.snapshot().sessions.length, 0);
  const waiting = fixture(); const mailGate = deferred<void>(); waiting.email.gate = mailGate.promise;
  const sending = waiting.service.requestLoginChallenge("newbie@example.com", "client");
  // An explicit microtask barrier observes the captured send without wall-clock sleeps.
  while (waiting.email.sent.length === 0) await Promise.resolve();
  const pending = waiting.store.snapshot().challenges[0]!;
  assert.equal(pending.delivery, "pending");
  await assert.rejects(waiting.service.verifyLoginChallenge({ challengeId: pending.id, code: waiting.email.sent[0]!.code }, "client"), errorCode("AUTH_CHALLENGE_INVALID"));
  mailGate.resolve(); const receipt = await sending;
  const grant = await waiting.service.verifyLoginChallenge({ challengeId: receipt.challengeId, code: waiting.email.sent[0]!.code }, "client");
  assert.ok(await waiting.service.getActor(grant.sessionToken));
});

test("邮件返回时已过期或被较新发送替代，不能宣称验证码可用", async () => {
  const f = fixture(); const gate = deferred<void>(); f.email.gate = gate.promise;
  const sending = f.service.requestLoginChallenge("newbie@example.com", "client");
  while (f.email.sent.length === 0) await Promise.resolve();
  f.clock.advance(10 * 60_000); gate.resolve();
  await assert.rejects(sending, errorCode("AUTH_CHALLENGE_UNAVAILABLE"));
  const overlap = fixture(); const firstGate = deferred<void>(); overlap.email.gate = firstGate.promise;
  const first = overlap.service.requestLoginChallenge("newbie@example.com", "client");
  while (overlap.email.sent.length === 0) await Promise.resolve();
  overlap.clock.advance(60_000); overlap.email.gate = null;
  const newest = await challenge(overlap); firstGate.resolve();
  await assert.rejects(first, errorCode("AUTH_CHALLENGE_UNAVAILABLE"));
  assert.ok((await overlap.service.verifyLoginChallenge({ challengeId: newest.receipt.challengeId, code: newest.code }, "client")).sessionToken);
});

test("会话过期边界、当前退出和所有非active账号均不产生Actor", async () => {
  const expired = fixture({ sessionLifetimeMs: 1_000 }); const authenticated = await login(expired);
  expired.clock.set(authenticated.grant.expiresAt);
  assert.equal(await expired.service.getActor(authenticated.grant.sessionToken), null);
  await assert.rejects(expired.service.requireActor(authenticated.grant.sessionToken), errorCode("AUTH_SESSION_REQUIRED"));
  const f = fixture(); const active = await login(f);
  await f.service.logout(active.grant.sessionToken); await f.service.logout(active.grant.sessionToken);
  assert.equal(await f.service.getActor(active.grant.sessionToken), null);
  assert.equal(await f.service.getActor("fabricated-user-id"), null);
  assert.equal(await f.service.getActor("x".repeat(43)), null);
  for (const status of ["suspended", "deletion_pending", "deleted"] as const) {
    const blocked = fixture(); const user = await login(blocked);
    await blocked.store.setAccountStatus(user.grant.profile.id, status);
    assert.equal(await blocked.service.getActor(user.grant.sessionToken), null);
    await assert.rejects(blocked.service.updateOwnProfile(user.grant.sessionToken, { displayName: "修改", timezone: "Asia/Shanghai", expectedRevision: 1 }), errorCode("AUTH_SESSION_REQUIRED"));
    blocked.clock.advance(60_000); const another = await challenge(blocked);
    await assert.rejects(blocked.service.verifyLoginChallenge({ challengeId: another.receipt.challengeId, code: another.code }, "client"), errorCode("AUTH_CHALLENGE_INVALID"));
    assert.equal(blocked.store.snapshot().sessions.length, 1);
  }
});

test("本人会话列表和定向撤销不泄露或撤销别人的设备", async () => {
  const f = fixture(); const a = await login(f, "a@example.com", "a-client");
  f.clock.advance(60_000); const a2 = await login(f, "a@example.com", "a2-client");
  const b = await login(f, "b@example.com", "b-client");
  const sessions = await f.service.listOwnSessions(a.grant.sessionToken);
  assert.equal(sessions.length, 2); assert.equal(sessions.filter((value) => value.current).length, 1);
  const bSession = f.store.snapshot().sessions.find((value) => value.userId === b.grant.profile.id)!;
  assert.ok(!sessions.some((value) => value.id === bSession.id));
  assert.deepEqual(await f.service.revokeOwnSession(a.grant.sessionToken, bSession.id), { revoked: false, currentSessionRevoked: false });
  assert.deepEqual(await f.service.revokeOwnSession(a.grant.sessionToken, "nonexistent-session"), { revoked: false, currentSessionRevoked: false });
  assert.ok(await f.service.getActor(b.grant.sessionToken));
  const target = sessions.find((value) => !value.current)!;
  assert.deepEqual(await f.service.revokeOwnSession(a.grant.sessionToken, target.id), { revoked: true, currentSessionRevoked: false });
  assert.deepEqual(await f.service.revokeOwnSession(a.grant.sessionToken, target.id), { revoked: false, currentSessionRevoked: false });
  assert.equal(await f.service.getActor(a2.grant.sessionToken), null);
  assert.ok(await f.service.getActor(a.grant.sessionToken));
  assert.deepEqual(Object.keys((await f.service.listOwnSessions(a.grant.sessionToken))[0]!).sort(), ["authenticatedAt", "createdAt", "current", "expiresAt", "id", "lastSeenAt"]);
});

test("账户设置只含本人有效会话及公开元数据；过期和已撤销设备不可再次撤销", async () => {
  const f = fixture({ sessionLifetimeMs: 120_000 });
  const expired = await login(f, "a@example.com", "a-first");
  f.clock.advance(60_000); const revoked = await login(f, "a@example.com", "a-second");
  const other = await login(f, "b@example.com", "b-first");
  f.clock.advance(60_000); const active = await login(f, "a@example.com", "a-third");
  const records = f.store.snapshot().sessions;
  const expiredId = records.find((value) => value.tokenHash === f.crypto.hashSessionToken(expired.grant.sessionToken))!.id;
  const revokedId = records.find((value) => value.tokenHash === f.crypto.hashSessionToken(revoked.grant.sessionToken))!.id;
  assert.deepEqual(await f.service.revokeOwnSession(active.grant.sessionToken, expiredId), { revoked: false, currentSessionRevoked: false });
  assert.deepEqual(await f.service.revokeOwnSession(active.grant.sessionToken, revokedId), { revoked: true, currentSessionRevoked: false });
  const account = await f.service.getAccountSettings(active.grant.sessionToken);
  assert.equal(account.profile.id, active.grant.profile.id);
  assert.deepEqual(Object.keys(account).sort(), ["canLogoutAll", "currentSession", "profile", "recentAuthenticationUntil", "sessions"]);
  assert.deepEqual(Object.keys(account.profile).sort(), ["displayName", "email", "emailVerifiedAt", "id", "revision", "timezone"]);
  assert.deepEqual(account.sessions, [account.currentSession]);
  assert.deepEqual(Object.keys(account.currentSession).sort(), ["authenticatedAt", "createdAt", "current", "expiresAt", "id", "lastSeenAt"]);
  assert.equal(account.currentSession.current, true);
  assert.equal(account.currentSession.lastSeenAt, f.clock.now().toISOString());
  const text = JSON.stringify(account);
  for (const value of [active.grant.sessionToken, f.crypto.hashSessionToken(active.grant.sessionToken), "tokenHash", "platformRoles", other.grant.profile.id, other.grant.profile.email]) assert.ok(!text.includes(value));
  assert.deepEqual(await f.service.revokeOwnSession(active.grant.sessionToken, account.currentSession.id), { revoked: true, currentSessionRevoked: true });
  await assert.rejects(f.service.getAccountSettings(active.grant.sessionToken), errorCode("AUTH_SESSION_REQUIRED"));
  await assert.rejects(f.service.revokeOwnSession(active.grant.sessionToken, account.currentSession.id), errorCode("AUTH_SESSION_REQUIRED"));
  assert.ok(await f.service.getActor(other.grant.sessionToken));
});

test("账户设置暴露近期认证截止时刻且全设备退出边界与权限执行一致", async () => {
  const f = fixture({ recentAuthenticationMs: 5_000 }); const active = await login(f);
  const initial = await f.service.getAccountSettings(active.grant.sessionToken);
  assert.equal(initial.recentAuthenticationUntil, "2026-10-08T04:00:05.000Z");
  assert.equal(initial.canLogoutAll, true);
  f.clock.advance(5_000);
  const boundary = await f.service.getAccountSettings(active.grant.sessionToken);
  assert.equal(boundary.canLogoutAll, true);
  assert.equal(boundary.currentSession.lastSeenAt, boundary.recentAuthenticationUntil);
  await f.service.logoutAll(active.grant.sessionToken);
  assert.equal(await f.service.getActor(active.grant.sessionToken), null);
  const stale = fixture({ recentAuthenticationMs: 5_000 }); const staleSession = await login(stale);
  stale.clock.advance(5_001);
  assert.equal((await stale.service.getAccountSettings(staleSession.grant.sessionToken)).canLogoutAll, false);
  await assert.rejects(stale.service.logoutAll(staleSession.grant.sessionToken), errorCode("AUTH_REAUTHENTICATION_REQUIRED"));
  assert.ok(await stale.service.getActor(staleSession.grant.sessionToken));
});

test("只有有效本人会话访问会刷新最后活动时间，触摸不会延长过期或认证窗口", async () => {
  const f = fixture({ sessionLifetimeMs: 1_000, recentAuthenticationMs: 500 }); const active = await login(f);
  const tokenHash = f.crypto.hashSessionToken(active.grant.sessionToken);
  const created = f.store.snapshot().sessions[0]!;
  f.clock.advance(400); assert.ok(await f.service.getActor(active.grant.sessionToken));
  assert.equal(f.store.snapshot().sessions[0]!.lastSeenAt, "2026-10-08T04:00:00.400Z");
  f.clock.advance(100);
  const account = await f.service.getAccountSettings(active.grant.sessionToken);
  assert.equal(account.currentSession.lastSeenAt, "2026-10-08T04:00:00.500Z");
  assert.equal(account.currentSession.expiresAt, created.expiresAt);
  assert.equal(account.currentSession.authenticatedAt, created.authenticatedAt);
  // A backwards fixture clock must not make activity metadata decrease.
  f.clock.set("2026-10-08T04:00:00.300Z"); assert.ok(await f.service.getActor(active.grant.sessionToken));
  assert.equal(f.store.snapshot().sessions[0]!.lastSeenAt, "2026-10-08T04:00:00.500Z");
  assert.equal(await f.store.getOwnAccountSnapshot("foreign-or-forged-hash", f.clock.now().toISOString()), null);
  f.clock.set(created.expiresAt);
  assert.equal(await f.store.getOwnAccountSnapshot(tokenHash, f.clock.now().toISOString()), null);
  await assert.rejects(f.service.getAccountSettings(active.grant.sessionToken), errorCode("AUTH_SESSION_REQUIRED"));
  assert.equal(f.store.snapshot().sessions[0]!.lastSeenAt, "2026-10-08T04:00:00.500Z");
  const suspended = fixture(); const user = await login(suspended); const prior = suspended.store.snapshot().sessions[0]!;
  await suspended.store.setAccountStatus(user.grant.profile.id, "suspended"); suspended.clock.advance(1_000);
  await assert.rejects(suspended.service.getAccountSettings(user.grant.sessionToken), errorCode("AUTH_SESSION_REQUIRED"));
  assert.equal(suspended.store.snapshot().sessions[0]!.lastSeenAt, prior.lastSeenAt);
});

test("账户设置等到事务取得锁后重新校验有效期并返回不可变本人快照", async () => {
  const f = fixture({ sessionLifetimeMs: 1_000 }); const active = await login(f);
  const snapshot = await f.store.getOwnAccountSnapshot(f.crypto.hashSessionToken(active.grant.sessionToken), f.clock.now().toISOString());
  assert.ok(snapshot);
  await f.service.updateOwnProfile(active.grant.sessionToken, { displayName: "新的资料", timezone: "UTC", expectedRevision: 1 });
  assert.equal(snapshot.user.displayName, "参赛新人");
  assert.equal((await f.service.getAccountSettings(active.grant.sessionToken)).profile.displayName, "新的资料");
  f.clock.advance(999); const gate = f.store.blockTransactions(); await gate.entered;
  const pending = f.service.getAccountSettings(active.grant.sessionToken);
  f.clock.advance(1); gate.release(); await gate.finished;
  await assert.rejects(pending, errorCode("AUTH_SESSION_REQUIRED"));
});

test("退出全部设备要求近期验证，重新登录后撤销本人所有会话", async () => {
  const f = fixture({ recentAuthenticationMs: 5_000 });
  const first = await login(f, "a@example.com", "first");
  f.clock.advance(5_001);
  await assert.rejects(f.service.logoutAll(first.grant.sessionToken), errorCode("AUTH_REAUTHENTICATION_REQUIRED"));
  assert.ok(await f.service.getActor(first.grant.sessionToken));
  f.clock.advance(60_000); const recent = await login(f, "a@example.com", "second");
  const other = await login(f, "b@example.com", "third");
  await f.service.logoutAll(recent.grant.sessionToken);
  assert.equal(await f.service.getActor(first.grant.sessionToken), null);
  assert.equal(await f.service.getActor(recent.grant.sessionToken), null);
  assert.ok(await f.service.getActor(other.grant.sessionToken));
});

test("排队期间会话过期或近期认证窗口结束，资料写入及退出全部被拒绝", async () => {
  const f = fixture({ sessionLifetimeMs: 1_000 }); const active = await login(f);
  f.clock.advance(999); const blocker = f.store.blockTransactions(); await blocker.entered;
  const update = f.service.updateOwnProfile(active.grant.sessionToken, { displayName: "不应保存", timezone: "UTC", expectedRevision: 1 });
  f.clock.advance(1); blocker.release(); await blocker.finished;
  await assert.rejects(update, errorCode("AUTH_SESSION_REQUIRED"));
  assert.equal(f.store.snapshot().users[0]!.revision, 1);
  const recent = fixture({ recentAuthenticationMs: 1_000 }); const user = await login(recent);
  recent.clock.advance(999); const queue = recent.store.blockTransactions(); await queue.entered;
  const revoke = recent.service.logoutAll(user.grant.sessionToken);
  recent.clock.advance(2); queue.release(); await queue.finished;
  await assert.rejects(revoke, errorCode("AUTH_REAUTHENTICATION_REQUIRED"));
  assert.ok(await recent.service.getActor(user.grant.sessionToken));
});

test("资料更新只作用本人；并发版本冲突不覆盖成功值及敏感字段", async () => {
  const f = fixture(); const a = await login(f, "a@example.com", "a-client"); const b = await login(f, "b@example.com", "b-client");
  const updates = await Promise.allSettled([
    f.service.updateOwnProfile(a.grant.sessionToken, { displayName: "  阿甲  ", timezone: "UTC", expectedRevision: 1 }),
    f.service.updateOwnProfile(a.grant.sessionToken, { displayName: "旧编辑", timezone: "Asia/Shanghai", expectedRevision: 1 }),
  ]);
  assert.equal(updates.filter((value) => value.status === "fulfilled").length, 1);
  const conflict = updates.find((value) => value.status === "rejected")!;
  assert.ok(conflict.status === "rejected" && conflict.reason instanceof DomainError);
  assert.equal(conflict.reason.code, "VERSION_CONFLICT"); assert.equal(conflict.reason.latestRevision, 2);
  assert.equal((await f.service.getCurrentProfile(a.grant.sessionToken)).displayName, "阿甲");
  assert.equal((await f.service.getCurrentProfile(b.grant.sessionToken)).displayName, "参赛新人");
  const injected: ProfileUpdate & Record<string, unknown> = { displayName: "本人昵称", timezone: "UTC", expectedRevision: 2, userId: b.grant.profile.id, email: "attacker@example.com", platformRoles: ["admin"], status: "deleted" };
  await f.service.updateOwnProfile(a.grant.sessionToken, injected);
  const stored = f.store.snapshot().users.find((value) => value.id === a.grant.profile.id)!;
  assert.equal(stored.email, "a@example.com"); assert.equal(stored.status, "active"); assert.deepEqual(stored.platformRoles, ["user"]);
  const before = stored.revision;
  for (const [patch, expected] of [
    [{ displayName: "\n昵称", timezone: "UTC", expectedRevision: before }, "AUTH_PROFILE_INVALID"],
    [{ displayName: "昵称", timezone: "Not/A-Timezone", expectedRevision: before }, "AUTH_TIMEZONE_INVALID"],
    [{ displayName: "昵称", timezone: "UTC", expectedRevision: 0 }, "AUTH_REVISION_INVALID"],
  ] as const) await assert.rejects(f.service.updateOwnProfile(a.grant.sessionToken, patch), errorCode(expected));
  assert.equal((await f.service.getCurrentProfile(a.grant.sessionToken)).revision, before);
});

test("发码和用户DTO不回传验证码/安全摘要/账号内部状态，持久化不存原始sessionToken", async () => {
  const f = fixture(); const active = await login(f);
  assert.deepEqual(Object.keys(active.receipt).sort(), ["challengeId", "expiresAt", "message", "resendAfterSeconds"]);
  assert.ok(!JSON.stringify(active.receipt).includes(active.code));
  const profile = await f.service.getCurrentProfile(active.grant.sessionToken);
  assert.deepEqual(Object.keys(profile).sort(), ["displayName", "email", "emailVerifiedAt", "id", "revision", "timezone"]);
  assert.ok(!JSON.stringify(profile).includes(active.grant.sessionToken));
  const stored = f.store.snapshot();
  assert.ok(stored.challenges[0]!.codeHash !== active.code);
  assert.ok(stored.sessions[0]!.tokenHash !== active.grant.sessionToken);
  assert.ok(!JSON.stringify(stored).includes(active.grant.sessionToken));
});

test("邮件规范化不合并plus/dot别名，恶意回跳降级到预设站内路径", () => {
  assert.equal(normalizeLoginEmail(" A.B+Hack@Example.COM "), "a.b+hack@example.com");
  assert.notEqual(normalizeLoginEmail("a.b@example.com"), normalizeLoginEmail("ab@example.com"));
  for (const value of [null, "a@", "x\r\nBcc:target@example.com", "a@@example.com"]) assert.throws(() => normalizeLoginEmail(value), errorCode("AUTH_EMAIL_INVALID"));
  for (const value of ["https://evil.example", "//evil.example", "\\evil.example", "/%2f%2fevil.example", "/app\n", "/app?next=https://evil.example", "/app/../other", "/unknown", null]) assert.equal(safeAuthReturnTo(value), "/app");
  for (const value of ["/settings/security", "/app/projects/project-1/team", "/events/event-1", "/resources/resource-1"]) assert.equal(safeAuthReturnTo(value), value);
  assert.equal(safeAuthReturnTo(`/app/join/${"a".repeat(43)}`), `/app/join/${"a".repeat(43)}`);
  for (const value of ["/app/join/short", `/app/join/${"a".repeat(43)}?next=https://evil.example`, `/app/join/${"a".repeat(43)}/../other`]) assert.equal(safeAuthReturnTo(value), "/app");
  assert.equal(safeAuthReturnTo("/ppt?roadshowId=own-roadshow-1"), "/ppt?roadshowId=own-roadshow-1");
  for (const value of ["/ppt?roadshowId=", "/ppt?roadshowId=../other", "/ppt?roadshowId=one&next=https://evil.example", "/ppt?roadshowId=%2Fother", `/ppt?roadshowId=${"a".repeat(201)}`]) assert.equal(safeAuthReturnTo(value), "/app");
});

test("验证码摘要绑定挑战及用途，随机会话具备标准编码且pepper不得为空", () => {
  const crypto = createNodeAuthCrypto("fixture-only-secret-material-at-least-32-bytes");
  assert.throws(() => createNodeAuthCrypto("short"));
  assert.notEqual(crypto.hashCode("one", "12345678"), crypto.hashCode("two", "12345678"));
  assert.notEqual(crypto.hashCode("one", "12345678"), crypto.hashRateKey("one", "12345678"));
  assert.match(crypto.generateCode(), /^[0-9]{8}$/); assert.match(crypto.generateSessionToken(), /^[A-Za-z0-9_-]{43}$/);
});
