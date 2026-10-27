import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createNodeAuthCrypto } from "./crypto.ts";
import { createAuthHandlers, type AuthHttpOptions } from "./http.ts";
import type { AuthStorePort } from "./ports.ts";
import { AuthService, safeAuthReturnTo } from "./service.ts";
import { CapturingLoginEmail, FixtureClock, FixtureIds, SerialAuthStoreFixture } from "./test-fixtures.ts";
import type { AuthPolicy } from "./types.ts";

const origin = "https://hackathon.example";
const clientKey = "trusted-registration-client";
const errorCode = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;
const wrongCode = (code: string): string => code === "00000000" ? "11111111" : "00000000";

function fixture(policy: Partial<AuthPolicy> = {}) {
  const clock = new FixtureClock(); const ids = new FixtureIds();
  const crypto = createNodeAuthCrypto("registration-fixture-only-secret-material-at-least-32-bytes");
  const store = new SerialAuthStoreFixture(clock); const email = new CapturingLoginEmail();
  const storeCalls: string[] = [];
  const observedStore: AuthStorePort = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        storeCalls.push(String(property));
        return value.apply(target, args);
      };
    },
  });
  const service = new AuthService({ clock, ids, crypto, store: observedStore, email, policy });
  return { clock, ids, crypto, store, storeCalls, email, service };
}
type Fixture = ReturnType<typeof fixture>;

async function registerChallenge(f: Fixture, displayName = "初次参赛者", email = "newbie@example.com") {
  const receipt = await f.service.requestRegistrationChallenge({ email, displayName }, clientKey);
  return { receipt, code: f.email.sent.at(-1)!.code };
}

async function existingAccount(f: Fixture, email = "newbie@example.com") {
  const receipt = await f.service.requestLoginChallenge(email, clientKey);
  const grant = await f.service.verifyLoginChallenge({ challengeId: receipt.challengeId, code: f.email.sent.at(-1)!.code }, clientKey);
  const profile = await f.service.updateOwnProfile(grant.sessionToken, {
    displayName: "已有账户名称", timezone: "Asia/Tokyo", expectedRevision: grant.profile.revision,
  });
  f.clock.advance(60_000);
  return { grant, profile };
}

function handlers(f: Fixture, overrides: Partial<AuthHttpOptions> = {}) {
  return createAuthHandlers({ service: f.service, origin, getClientKey: () => clientKey, requestIds: f.ids, ...overrides });
}

function request(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request(`${origin}/api/v1/auth/registration-challenges`, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

test("注册姓名只保存到挑战，邮箱验证成功才原子创建有姓名的账号与会话", async () => {
  const f = fixture(); const issued = await registerChallenge(f, "  小林  ", " Newbie@Example.com ");
  const pending = f.store.snapshot();
  assert.equal(pending.users.length, 0); assert.equal(pending.sessions.length, 0);
  assert.equal(pending.challenges[0]!.email, "newbie@example.com");
  assert.equal(pending.challenges[0]!.registrationDisplayName, "小林");
  assert.equal(pending.challenges[0]!.delivery, "ready");
  const grant = await f.service.verifyRegistrationChallenge({ challengeId: issued.receipt.challengeId, code: issued.code, returnTo: "/participation?event=event-1" }, clientKey);
  assert.equal(grant.profile.displayName, "小林"); assert.equal(grant.profile.revision, 1);
  assert.equal(grant.returnTo, "/participation?event=event-1");
  assert.equal(f.store.snapshot().users.length, 1); assert.equal(f.store.snapshot().sessions.length, 1);
  assert.deepEqual(await f.service.requireActor(grant.sessionToken), { userId: grant.profile.id, platformRoles: ["user"] });
  await assert.rejects(f.service.verifyRegistrationChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, clientKey), errorCode("AUTH_CHALLENGE_INVALID"));
});

test("注册请求不查询已有账号，已存在和新邮箱获得相同的公开回执形状", async () => {
  const fresh = fixture(); const known = fixture();
  await existingAccount(known); known.storeCalls.length = 0;
  const before = known.store.snapshot().users;
  const receipts = await Promise.all([registerChallenge(fresh, "新姓名"), registerChallenge(known, "不应覆盖的姓名")]);
  for (const f of [fresh, known]) assert.deepEqual(f.storeCalls, ["reserveChallenge", "markChallengeDelivery"]);
  for (const { receipt } of receipts) {
    assert.deepEqual(Object.keys(receipt).sort(), ["challengeId", "expiresAt", "message", "resendAfterSeconds"]);
  }
  assert.equal(receipts[0]!.receipt.message, receipts[1]!.receipt.message);
  assert.equal(receipts[0]!.receipt.resendAfterSeconds, receipts[1]!.receipt.resendAfterSeconds);
  assert.deepEqual(known.store.snapshot().users, before);
  assert.equal(fresh.store.snapshot().users.length, 0);
});

test("姓名与注册字段先校验，格式错误或附加密码不会发送邮件或预留挑战", async () => {
  const f = fixture();
  for (const displayName of [undefined, null, 12, "", "  ", "甲".repeat(61), "小\n林", "小\u007f林"]) {
    await assert.rejects(f.service.requestRegistrationChallenge({ email: "newbie@example.com", displayName }, clientKey), errorCode("AUTH_PROFILE_INVALID"));
  }
  for (const extra of [{ password: "not-used" }, { userId: "another-user" }, { platformRoles: ["admin"] }]) {
    await assert.rejects(f.service.requestRegistrationChallenge({ email: "newbie@example.com", displayName: "小林", ...extra }, clientKey), errorCode("AUTH_FIELDS_INVALID"));
  }
  await assert.rejects(f.service.requestRegistrationChallenge({ email: "invalid-email", displayName: "小林" }, clientKey), errorCode("AUTH_EMAIL_INVALID"));
  assert.equal(f.email.sent.length, 0); assert.equal(f.storeCalls.length, 0);
  assert.equal(f.store.snapshot().challenges.length, 0);
  const accepted = await registerChallenge(f, "甲".repeat(60));
  assert.ok(accepted.receipt.challengeId); assert.equal(f.email.sent.length, 1);
});

test("已有邮箱完成注册验证只恢复身份，姓名、时区和资料revision均不被注册覆盖", async () => {
  const f = fixture(); const existing = await existingAccount(f);
  const original = f.store.snapshot().users[0]!;
  const issued = await registerChallenge(f, "攻击者替换名称");
  assert.deepEqual(f.store.snapshot().users[0], original);
  const grant = await f.service.verifyRegistrationChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, clientKey);
  assert.deepEqual(grant.profile, existing.profile);
  assert.equal(grant.profile.id, existing.grant.profile.id);
  assert.deepEqual(f.store.snapshot().users, [original]);
  assert.equal(f.store.snapshot().sessions.length, 2);
});

test("重发注册挑战撤销旧码和旧姓名，只有最新挑战的姓名可以创建账号", async () => {
  const f = fixture(); const first = await registerChallenge(f, "旧姓名");
  f.clock.advance(60_000); const newest = await registerChallenge(f, "最新姓名");
  assert.ok(f.store.snapshot().challenges.find((value) => value.id === first.receipt.challengeId)!.revokedAt);
  await assert.rejects(f.service.verifyRegistrationChallenge({ challengeId: first.receipt.challengeId, code: first.code }, clientKey), errorCode("AUTH_CHALLENGE_INVALID"));
  assert.equal(f.store.snapshot().users.length, 0);
  const grant = await f.service.verifyRegistrationChallenge({ challengeId: newest.receipt.challengeId, code: newest.code }, clientKey);
  assert.equal(grant.profile.displayName, "最新姓名"); assert.equal(f.store.snapshot().users.length, 1);
});

test("后续登录挑战也撤销未验证注册，旧注册姓名不能通过新登录挑战写入", async () => {
  const f = fixture(); const first = await registerChallenge(f, "旧注册姓名");
  f.clock.advance(60_000);
  const loginReceipt = await f.service.requestLoginChallenge("newbie@example.com", clientKey);
  const loginCode = f.email.sent.at(-1)!.code;
  await assert.rejects(f.service.verifyRegistrationChallenge({ challengeId: first.receipt.challengeId, code: first.code }, clientKey), errorCode("AUTH_CHALLENGE_INVALID"));
  const grant = await f.service.verifyLoginChallenge({ challengeId: loginReceipt.challengeId, code: loginCode }, clientKey);
  assert.equal(grant.profile.displayName, "参赛新人");
  assert.equal(f.store.snapshot().users.length, 1);
});

test("错误与expiresAt边界过期的注册码不会建号或修改已有账户", async () => {
  for (const known of [false, true]) {
    for (const expired of [false, true]) {
      const f = fixture(); if (known) await existingAccount(f);
      const originalUsers = f.store.snapshot().users; const originalSessions = f.store.snapshot().sessions;
      const issued = await registerChallenge(f, "不得写入姓名");
      if (expired) f.clock.set(issued.receipt.expiresAt);
      await assert.rejects(f.service.verifyRegistrationChallenge({ challengeId: issued.receipt.challengeId, code: expired ? issued.code : wrongCode(issued.code) }, clientKey), errorCode("AUTH_CHALLENGE_INVALID"));
      assert.deepEqual(f.store.snapshot().users, originalUsers);
      assert.deepEqual(f.store.snapshot().sessions, originalSessions);
      assert.equal(f.store.snapshot().challenges.at(-1)!.consumedAt, null);
    }
  }
});

test("同一注册挑战并发验证只成功一次，新增或恢复账户均不会重复创建会话", async () => {
  for (const known of [false, true]) {
    const f = fixture(); const existing = known ? await existingAccount(f) : null;
    const issued = await registerChallenge(f, "首次注册姓名");
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => f.service.verifyRegistrationChallenge({ challengeId: issued.receipt.challengeId, code: issued.code }, `trusted-client-${index}`)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 7);
    for (const result of results) if (result.status === "rejected") assert.ok(errorCode("AUTH_CHALLENGE_INVALID")(result.reason));
    assert.equal(f.store.snapshot().users.length, 1);
    assert.equal(f.store.snapshot().sessions.length, known ? 2 : 1);
    assert.equal(f.store.snapshot().users[0]!.displayName, existing?.profile.displayName ?? "首次注册姓名");
    assert.equal(f.store.snapshot().users[0]!.revision, existing?.profile.revision ?? 1);
  }
});

test("注册返回路径保留新增站内入口，危险赛事ID与额外查询回退到/app", () => {
  for (const path of ["/participation", "/participation?event=event-1", "/participation?event=A_09", "/roadshow", "/ppt", "/register", "/inspiration", "/github"]) {
    assert.equal(safeAuthReturnTo(path), path);
  }
  for (const path of [
    "/participation?event=", "/participation?event=../admin", "/participation?event=event%2D1",
    "/participation?event=event-1&next=https://evil.example", "/participation?event=one&event=two",
    "/participation?event=event-1#fragment", "/participation?event=event-1\n", `/participation?event=${"a".repeat(129)}`,
    "//evil.example", "https://evil.example/roadshow", "/ppt?next=/admin", "/register\\evil",
  ]) assert.equal(safeAuthReturnTo(path), "/app");
});

test("两个注册HTTP写接口必须先验证固定Origin与POST，不调用服务或客户端解析", async () => {
  const f = fixture(); let clientCalls = 0;
  const api = handlers(f, { getClientKey: () => { clientCalls++; return clientKey; } });
  for (const operation of [api.requestRegistrationChallenge, api.verifyRegistration]) {
    for (const suppliedOrigin of ["", "null", "https://evil.example", `${origin}/`, `${origin}:443`]) {
      const response = await operation(request({}, { Origin: suppliedOrigin }));
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "AUTH_ORIGIN_INVALID");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const methodResponse = await operation(request({}, {}, "GET"));
    assert.equal(methodResponse.status, 405); assert.equal(methodResponse.headers.get("allow"), "POST");
  }
  assert.equal(clientCalls, 0); assert.equal(f.storeCalls.length, 0); assert.equal(f.email.sent.length, 0);
});

test("注册HTTP拒绝未知身份、密码字段，验证HTTP不得改写挑战保存的姓名", async () => {
  const f = fixture(); const api = handlers(f);
  for (const extra of [{ password: "unused" }, { clientKey: "forged" }, { userId: "other-user" }, { platformRoles: ["admin"] }]) {
    const response = await api.requestRegistrationChallenge(request({ email: "newbie@example.com", displayName: "小林", ...extra }));
    assert.equal(response.status, 422); assert.equal((await response.json()).error.code, "AUTH_FIELDS_INVALID");
  }
  assert.equal(f.email.sent.length, 0);
  const sentResponse = await api.requestRegistrationChallenge(request({ email: "newbie@example.com", displayName: "保存姓名" }));
  assert.equal(sentResponse.status, 200); const receipt = (await sentResponse.json()).data;
  for (const extra of [{ displayName: "替换姓名" }, { email: "other@example.com" }, { sessionToken: "forged" }, { password: "unused" }]) {
    const response = await api.verifyRegistration(request({ challengeId: receipt.challengeId, code: f.email.sent[0]!.code, ...extra }));
    assert.equal(response.status, 422); assert.equal((await response.json()).error.code, "AUTH_FIELDS_INVALID");
  }
  assert.equal(f.store.snapshot().users.length, 0); assert.equal(f.store.snapshot().sessions.length, 0);
  const verified = await api.verifyRegistration(request({ challengeId: receipt.challengeId, code: f.email.sent[0]!.code }));
  assert.equal(verified.status, 200); assert.equal((await verified.json()).data.profile.displayName, "保存姓名");
});

test("注册HTTP按真实UTF-8字节限制两个请求体，并拒绝非JSON和压缩请求", async () => {
  const f = fixture(); let clientCalls = 0;
  const api = handlers(f, { maxJsonBytes: 64, getClientKey: () => { clientCalls++; return clientKey; } });
  for (const operation of [api.requestRegistrationChallenge, api.verifyRegistration]) {
    const body = JSON.stringify({ displayName: "新".repeat(30) });
    assert.ok(body.length < 64); assert.ok(new TextEncoder().encode(body).byteLength > 64);
    const overflow = await operation(new Request(`${origin}/api/v1/auth/registration-challenges`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "1" }, body,
    }));
    assert.equal(overflow.status, 413); assert.equal((await overflow.json()).error.code, "AUTH_BODY_TOO_LARGE");
    const declaredOverflow = await operation(request({}, { "Content-Length": "65" }));
    assert.equal(declaredOverflow.status, 413);
    const rejectedHeaders: Record<string, string>[] = [{ "Content-Type": "text/plain" }, { "Content-Encoding": "gzip" }];
    for (const headers of rejectedHeaders) {
      const response = await operation(request({}, headers));
      assert.equal(response.status, 415); assert.equal((await response.json()).error.code, "AUTH_JSON_REQUIRED");
    }
  }
  assert.equal(clientCalls, 0); assert.equal(f.storeCalls.length, 0); assert.equal(f.email.sent.length, 0);
});

test("注册HTTP错误姓名不会发信，回执与验证DTO剔除内部数据且token只写入安全Cookie", async () => {
  const f = fixture(); const api = handlers(f);
  const invalid = await api.requestRegistrationChallenge(request({ email: "newbie@example.com", displayName: "  " }));
  assert.equal(invalid.status, 422); assert.equal((await invalid.json()).error.code, "AUTH_PROFILE_INVALID");
  assert.equal(f.email.sent.length, 0);

  const token = "s".repeat(43); const observed: Array<{ input: unknown; key: string }> = [];
  const privateReceipt = {
    challengeId: "challenge-1", expiresAt: "2026-10-08T04:10:00.000Z", resendAfterSeconds: 60, message: "验证邮件已受理。",
    email: "private-recipient@example.com", codeHash: "private-code-hash", registrationDisplayName: "private-pending-name",
  };
  const privateGrant = {
    sessionToken: token, expiresAt: "2026-10-15T04:00:00.000Z", returnTo: "/roadshow",
    profile: {
      id: "user-1", email: "newbie@example.com", displayName: "小林", timezone: "Asia/Shanghai", revision: 1,
      emailVerifiedAt: "2026-10-08T04:00:00.000Z", platformRoles: ["admin"], tokenHash: "private-token-hash", status: "active",
    },
  };
  const service = Object.assign(f.service, {
    requestRegistrationChallenge: async (input: { email: unknown; displayName: unknown }, key: string) => { observed.push({ input, key }); return privateReceipt; },
    verifyRegistrationChallenge: async (input: { challengeId: unknown; code: unknown; returnTo?: unknown }, key: string) => { observed.push({ input, key }); return privateGrant; },
  });
  const projectionApi = handlers(f, { service });
  const receiptResponse = await projectionApi.requestRegistrationChallenge(request({ email: "newbie@example.com", displayName: "小林" }, { "x-client-key": "forged" }));
  assert.equal(receiptResponse.status, 200); assert.equal(receiptResponse.headers.get("set-cookie"), null);
  const receiptBody = await receiptResponse.json();
  assert.deepEqual(Object.keys(receiptBody.data).sort(), ["challengeId", "expiresAt", "message", "resendAfterSeconds"]);
  const verified = await projectionApi.verifyRegistration(request({ challengeId: "challenge-1", code: "12345678", returnTo: "/roadshow" }, { "x-forwarded-for": "forged" }));
  assert.equal(verified.status, 200); assert.equal(verified.headers.get("cache-control"), "no-store");
  const verifiedBody = await verified.json();
  assert.deepEqual(Object.keys(verifiedBody.data).sort(), ["profile", "returnTo"]);
  assert.deepEqual(Object.keys(verifiedBody.data.profile).sort(), ["displayName", "email", "emailVerifiedAt", "id", "revision", "timezone"]);
  const serialized = JSON.stringify([receiptBody, verifiedBody]);
  for (const secret of [token, "sessionToken", "private-token-hash", "private-code-hash", "private-recipient", "private-pending-name", "platformRoles", "status"]) {
    assert.ok(!serialized.includes(secret), `Public registration DTO exposed ${secret}`);
  }
  const cookie = verified.headers.get("set-cookie")!;
  assert.ok(cookie.startsWith(`__Host-hackathon_session=${token};`));
  for (const attribute of ["; Path=/", "; HttpOnly", "; SameSite=Lax", "; Secure", "; Expires="]) assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes("Domain="));
  assert.deepEqual(observed, [
    { input: { email: "newbie@example.com", displayName: "小林" }, key: clientKey },
    { input: { challengeId: "challenge-1", code: "12345678", returnTo: "/roadshow" }, key: clientKey },
  ]);
});

test("缺少可选注册服务的旧HTTP组合保持可用并明确返回注册暂不可用", async () => {
  const f = fixture();
  const legacyService = new Proxy(f.service, {
    get(target, property, receiver) {
      if (property === "requestRegistrationChallenge" || property === "verifyRegistrationChallenge") return undefined;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const api = handlers(f, { service: legacyService });
  for (const operation of [api.requestRegistrationChallenge, api.verifyRegistration]) {
    const response = await operation(request({}));
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "AUTH_REGISTRATION_UNAVAILABLE");
  }
  assert.equal((await api.requestLoginChallenge(request({ email: "newbie@example.com" }))).status, 200);
  assert.equal(f.email.sent.length, 1);
});
