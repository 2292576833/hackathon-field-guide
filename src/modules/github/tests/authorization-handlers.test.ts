import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { RepositoryCreationOperation } from "../authorization-types.ts";
import { authorizationCookieName } from "../authorization-service.ts";
import { createGitHubAuthorizationHandler, type GitHubAuthorizationAction, type GitHubAuthorizationHandlerDependencies } from "../authorization-handlers.ts";

const actor: Actor = { userId: "handler-user", platformRoles: ["user"] };
const state = "s".repeat(43);
const nonce = "n".repeat(43);
const identity = { id: 42, login: "handler-person", profileUrl: "https://github.com/handler-person" };
const params = { projectId: "project-handler", operationId: "creation-handler" };

function operation(): RepositoryCreationOperation {
  return { id: params.operationId, userId: actor.userId, projectId: params.projectId, appId: 3, githubUserId: 42, owner: identity.login,
    name: "handler-repo", description: "测试项目", private: true, autoInit: true, idempotencyKey: "handler-key-001", confirmationHash: "a".repeat(64), revision: 1,
    status: "preview", createdAt: "2026-10-08T08:00:00.000Z", expiresAt: "2026-10-08T08:15:00.000Z", repository: null, errorCode: null, leaseUntil: null };
}
function request(path: string, method = "GET", value?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example${path}`, { method, ...(value !== undefined ? { body: JSON.stringify(value), headers: { "Content-Type": "application/json", ...headers } } : { headers }) });
}
function callbackCookie(flow: "authorization" | "installation", value = nonce) {
  return { cookie: `${authorizationCookieName(flow, state)}=${encodeURIComponent(value)}` };
}

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  let authenticated = true;
  let csrf = true;
  let returnTo = "/app/projects/project-handler/delivery";
  let creation = operation();
  let status: unknown = { status: "bound", identity, accessExpiresAt: "2026-10-08T16:00:00.000Z" };
  let error: Error | null = null;
  function call(method: string, ...args: unknown[]) {
    assert.equal(args[0], actor); calls.push({ method, args }); if (error) throw error;
  }
  const d: GitHubAuthorizationHandlerDependencies = {
    requestId: () => "authorization-request-id",
    async resolveActor() { return authenticated ? actor : null; },
    async assertMutationAllowed(_request, receivedActor) { assert.equal(receivedActor, actor); calls.push({ method: "csrf", args: [receivedActor] }); if (!csrf) throw new DomainError("CSRF_REJECTED", "请求来源无效。", { status: 403 }); },
    authorization: {
      async start(receivedActor, input) { call("start", receivedActor, input); return { authorizationUrl: `https://github.com/login/oauth/authorize?state=${state}`, expiresAt: "2026-10-08T08:10:00.000Z", cookie: { name: authorizationCookieName("authorization", state), value: nonce, path: "/api/v1/github/authorization/callback", maxAge: 600, secure: true } }; },
      async complete(receivedActor, input, browserNonce) { call("complete", receivedActor, input, browserNonce); return { returnTo, status: "bound", identity }; },
      async status(receivedActor) { call("status", receivedActor); return status; },
      async revoke(receivedActor) { call("revoke", receivedActor); return { status: "revoked", remoteStatus: "revoked" }; },
      async startInstallation(receivedActor, input) { call("startInstallation", receivedActor, input); return { installationUrl: `https://github.com/apps/fixture/installations/new?state=${state}`, expiresAt: "2026-10-08T08:10:00.000Z", cookie: { name: authorizationCookieName("installation", state), value: nonce, path: "/api/v1/github/installation/callback", maxAge: 600, secure: true } }; },
      async completeInstallation(receivedActor, input, browserNonce) { call("completeInstallation", receivedActor, input, browserNonce); return { returnTo, installationId: input.installationId }; },
      async listInstallations(receivedActor) { call("listInstallations", receivedActor); return [{ id: 99, appId: 3, accountLogin: identity.login, accountType: "User", repositorySelection: "selected", permissions: { contents: "write" }, suspended: false }]; },
      async listRepositories(receivedActor, installationId) { call("listRepositories", receivedActor, installationId); return [{ repositoryId: 101, owner: identity.login, name: "handler-repo", installationId, appId: 3, defaultBranch: "main", url: `https://github.com/${identity.login}/handler-repo`, private: true, userCanPush: true, contentsWrite: true, pullRequestsWrite: false, archived: false, disabled: false }]; },
    },
    creation: {
      async preview(receivedActor, projectId, input) { call("preview", receivedActor, projectId, input); return structuredClone(creation); },
      async get(receivedActor, projectId, id) { call("creation.get", receivedActor, projectId, id); return structuredClone(creation); },
      async confirm(receivedActor, projectId, id, hash) { call("confirm", receivedActor, projectId, id, hash); return structuredClone(creation); },
      async reconcile(receivedActor, projectId, id) { call("reconcile", receivedActor, projectId, id); return structuredClone(creation); },
    },
  };
  return { d, calls, handler: (action: GitHubAuthorizationAction) => createGitHubAuthorizationHandler(action, d),
    setAuthenticated: (value: boolean) => { authenticated = value; }, setCsrf: (value: boolean) => { csrf = value; },
    setReturnTo: (value: string) => { returnTo = value; }, setStatus: (value: unknown) => { status = value; },
    setCreationStatus: (value: RepositoryCreationOperation["status"]) => { creation = { ...creation, status: value }; },
    setError: (value: Error) => { error = value; },
  };
}

for (const flow of ["authorization", "installation"] as const) {
  test(`${flow} start仅返回URL/expiry，nonce只在限定path的HttpOnly SameSite Secure cookie`, async () => {
    const f = fixture();
    const response = await f.handler(`${flow}.start`)(request(`/api/v1/github/${flow}/start`, "POST", { projectId: params.projectId }));
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.deepEqual(Object.keys(envelope.data).sort(), [flow === "authorization" ? "authorizationUrl" : "installationUrl", "expiresAt"].sort());
    assert.ok(!JSON.stringify(envelope).includes(nonce)); assert.ok(!("cookie" in envelope.data));
    assert.equal(envelope.requestId, "authorization-request-id"); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const cookie = response.headers.get("set-cookie")!;
    assert.ok(cookie.startsWith(`${authorizationCookieName(flow, state)}=${nonce};`));
    assert.ok(cookie.includes(`Path=/api/v1/github/${flow}/callback`));
    for (const flag of ["HttpOnly", "SameSite=Lax", "Secure", "Max-Age=600"]) assert.ok(cookie.includes(flag));
    assert.deepEqual(f.calls.map(call => call.method), ["csrf", flow === "authorization" ? "start" : "startInstallation"]);
    assert.deepEqual(f.calls[1].args[1], { projectId: params.projectId });
  });
}

test("OAuth callback由state找到cookie并传可信Actor，303返回项目页且清理cookie不回显code", async () => {
  const f = fixture();
  const response = await f.handler("authorization.callback")(request(`/api/v1/github/authorization/callback?state=${state}&code=private-oauth-code`, "GET", undefined, callbackCookie("authorization")));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/app/projects/project-handler/delivery"); assert.equal(await response.text(), "");
  const cookie = response.headers.get("set-cookie")!;
  assert.ok(cookie.startsWith(`${authorizationCookieName("authorization", state)}=;`)); assert.ok(cookie.includes("Max-Age=0")); assert.ok(cookie.includes("Path=/api/v1/github/authorization/callback"));
  assert.deepEqual(f.calls.map(call => call.method), ["complete"]);
  assert.deepEqual(f.calls[0].args, [actor, { state, code: "private-oauth-code" }, nonce]);
  assert.ok(![...response.headers.values()].some(value => value.includes("private-oauth-code")));
});

test("安装callback使用installation cookie与正整数installation_id，不接受任意userId作为身份", async () => {
  const f = fixture();
  const response = await f.handler("installation.callback")(request(`/api/v1/github/installation/callback?state=${state}&installation_id=99&userId=other-user`, "GET", undefined, callbackCookie("installation")));
  assert.equal(response.status, 303);
  assert.deepEqual(f.calls[0].args, [actor, { state, installationId: 99 }, nonce]);
  assert.ok(response.headers.get("set-cookie")!.includes(authorizationCookieName("installation", state)));
});

test("callback浏览器nonce缺失/重复cookie与重复query拒绝，不调用complete", async () => {
  for (const headers of [{}, { cookie: `${authorizationCookieName("authorization", state)}=first; ${authorizationCookieName("authorization", state)}=second` }, callbackCookie("installation")]) {
    const f = fixture();
    const response = await f.handler("authorization.callback")(request(`/api/v1/github/authorization/callback?state=${state}&code=x`, "GET", undefined, headers));
    assert.equal(response.status, 403); assert.equal(f.calls.length, 0); assert.ok(response.headers.get("set-cookie")!.includes("Max-Age=0"));
  }
  for (const query of [`state=${state}&state=${state}&code=x`, `state=${state}&code=x&code=y`, "state=bad%0Astate&code=x"]) {
    const f = fixture(); const response = await f.handler("authorization.callback")(request(`/api/v1/github/authorization/callback?${query}`, "GET", undefined, callbackCookie("authorization")));
    assert.equal(response.status, 422); assert.equal(f.calls.length, 0);
  }
});

test("callback安全relative返回地址拒绝外部URL、协议相对与反斜线跳转", async () => {
  for (const returnTo of ["https://evil.example/capture", "//evil.example/capture", "/\\evil.example/capture", "/safe\nLocation: https://evil.example"]) {
    const f = fixture(); f.setReturnTo(returnTo);
    const response = await f.handler("authorization.callback")(request(`/api/v1/github/authorization/callback?state=${state}&code=x`, "GET", undefined, callbackCookie("authorization")));
    assert.equal(response.status, 500); assert.equal(response.headers.get("location"), null); assert.ok(response.headers.get("set-cookie")!.includes("Max-Age=0"));
  }
});

test("用户拒绝OAuth授权error交给服务处理，清理cookie且不回显provider错误说明", async () => {
  const f = fixture(); f.setError(new DomainError("GITHUB_AUTHORIZATION_DENIED", "你取消了 GitHub 授权。", { status: 403 }));
  const response = await f.handler("authorization.callback")(request(`/api/v1/github/authorization/callback?state=${state}&error=access_denied&error_description=private-provider-data`, "GET", undefined, callbackCookie("authorization")));
  assert.equal(response.status, 403); assert.deepEqual(f.calls[0].args[1], { state, error: "access_denied" });
  assert.ok(response.headers.get("set-cookie")!.includes("Max-Age=0")); assert.ok(!(await response.text()).includes("private-provider-data"));
});

test("status/installations/repositories只读取自己的身份，指定安装ID传给发现服务核验", async () => {
  const f = fixture();
  const status = await f.handler("authorization.status")(request("/api/v1/github/authorization"));
  assert.equal(status.status, 200); assert.equal((await status.json()).data.identity.id, identity.id);
  assert.equal((await f.handler("installations.list")(request("/api/v1/github/installations"))).status, 200);
  const repositories = await f.handler("repositories.list")(request("/api/v1/github/repositories?installationId=99&userId=other-user"));
  assert.equal(repositories.status, 200); assert.equal((await repositories.json()).data[0].installationId, 99);
  assert.deepEqual(f.calls.map(call => call.method), ["status", "listInstallations", "listRepositories"]);
  assert.deepEqual(f.calls[2].args, [actor, 99]);
});

test("仓库发现拒绝缺少/重复/无效安装ID，安装callback也拒绝无效ID", async () => {
  for (const suffix of ["", "?installationId=0", "?installationId=-1", "?installationId=1.5", "?installationId=9007199254740992", "?installationId=1&installationId=2"]) {
    const f = fixture(); const response = await f.handler("repositories.list")(request(`/api/v1/github/repositories${suffix}`));
    assert.equal(response.status, 422); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const response = await f.handler("installation.callback")(request(`/api/v1/github/installation/callback?state=${state}&installation_id=nope`, "GET", undefined, callbackCookie("installation")));
  assert.equal(response.status, 422); assert.equal(f.calls.length, 0);
});

test("DELETE撤销不要求JSON body，必须CSRF通过并分别返回本地与远端撤销状态", async () => {
  const f = fixture();
  const response = await f.handler("authorization.revoke")(request("/api/v1/github/authorization", "DELETE"));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, { status: "revoked", remoteStatus: "revoked" });
  assert.deepEqual(f.calls.map(call => call.method), ["csrf", "revoke"]);
});

test("创建preview/confirm/get/reconcile路由独立传入project与operation，不在handler自动bind", async () => {
  const f = fixture();
  const input = { name: "handler-repo", description: "测试项目", private: false, idempotencyKey: "handler-key-001" };
  const preview = await f.handler("creation.preview")(request("/api/v1/projects/project-handler/repository-creations/preview", "POST", input), params);
  assert.equal(preview.status, 201); assert.deepEqual(f.calls[1].args, [actor, params.projectId, input]);
  const get = await f.handler("creation.get")(request("/api/v1/projects/project-handler/repository-creations/creation-handler"), params);
  assert.equal(get.status, 200); assert.deepEqual(f.calls[2].args, [actor, params.projectId, params.operationId]);
  const confirm = await f.handler("creation.confirm")(request("/api/v1/projects/project-handler/repository-creations/creation-handler/confirm", "POST", { confirmationHash: "explicit-hash" }), params);
  assert.equal(confirm.status, 200); assert.deepEqual(f.calls[4].args, [actor, params.projectId, params.operationId, "explicit-hash"]);
  const reconcile = await f.handler("creation.reconcile")(request("/api/v1/projects/project-handler/repository-creations/creation-handler/reconcile", "POST"), params);
  assert.equal(reconcile.status, 200); assert.deepEqual(f.calls[6].args, [actor, params.projectId, params.operationId]);
});

test("创建进行中/unknown为202；确认必须明确hash且不接收owner/autoInit/token", async () => {
  for (const status of ["creating", "unknown"] as const) {
    const f = fixture(); f.setCreationStatus(status);
    assert.equal((await f.handler("creation.get")(request("/creation"), params)).status, 202);
    assert.equal((await f.handler("creation.reconcile")(request("/creation/reconcile", "POST"), params)).status, 202);
  }
  for (const input of [{}, { confirmationHash: "x", owner: "other" }, { confirmationHash: "x", autoInit: false }, { confirmationHash: "x", token: "private-token" }]) {
    const f = fixture(); const response = await f.handler("creation.confirm")(request("/creation/confirm", "POST", input), params);
    assert.equal(response.status, 422); assert.deepEqual(f.calls.map(call => call.method), ["csrf"]);
  }
});

test("方法、可信session和普通mutation CSRF在调用业务服务前校验", async () => {
  const f = fixture();
  assert.equal((await f.handler("authorization.start")(request("/authorization/start", "GET"))).status, 405);
  assert.equal(f.calls.length, 0);
  f.setAuthenticated(false);
  assert.equal((await f.handler("authorization.start")(request("/authorization/start", "POST", {}))).status, 401);
  assert.equal(f.calls.length, 0);
  f.setAuthenticated(true); f.setCsrf(false);
  assert.equal((await f.handler("creation.preview")(request("/creation/preview", "POST", { name: "repo", private: true, idempotencyKey: "fixture-key" }), params)).status, 403);
  assert.deepEqual(f.calls.map(call => call.method), ["csrf"]);
});

test("start仅允许projectId，创建preview必须显式可见性，身份与token从请求体注入被拒绝", async () => {
  for (const input of [{ userId: "other" }, { actor: { userId: "other" } }, { token: "private-token" }, { projectId: {}, extra: "invalid" }]) {
    const f = fixture(); const response = await f.handler("authorization.start")(request("/authorization/start", "POST", input));
    assert.equal(response.status, 422); assert.deepEqual(f.calls.map(call => call.method), ["csrf"]);
  }
  const f = fixture(); const response = await f.handler("creation.preview")(request("/creation/preview", "POST", { name: "repo", idempotencyKey: "fixture-key" }), params);
  assert.equal(response.status, 422); assert.deepEqual(f.calls.map(call => call.method), ["csrf"]);
});

test("JSON body流限制64KiB并拒绝格式/content-type错误", async () => {
  const f = fixture();
  const tooLarge = await f.handler("authorization.start")(request("/authorization/start", "POST", { projectId: "x".repeat(65_536) }));
  assert.equal(tooLarge.status, 413);
  const malformed = await f.handler("authorization.start")(new Request("https://app.example/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
  assert.equal(malformed.status, 422); assert.equal((await malformed.json()).error.code, "INVALID_JSON");
  const wrongType = await f.handler("authorization.start")(new Request("https://app.example/start", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }));
  assert.equal(wrongType.status, 415);
  const array = await f.handler("authorization.start")(request("/start", "POST", [])); assert.equal(array.status, 422);
  assert.ok(f.calls.every(call => call.method === "csrf"));
});

test("未知异常仅返回安全envelope，错误与服务响应都不能泄漏访问或加密token", async () => {
  const f = fixture(); f.setError(new Error("provider-secret-access-token and stack"));
  const failed = await f.handler("authorization.status")(request("/authorization"));
  assert.equal(failed.status, 500); const text = await failed.text(); assert.ok(!text.includes("provider-secret-access-token")); assert.ok(!text.includes("stack"));
  assert.equal(JSON.parse(text).error.code, "INTERNAL_ERROR");
  for (const value of [{ status: "bound", token: "private-token" }, { status: "bound", data: { encryptedTokens: { data: "ciphertext" } } }, { access_token: "private-token" }]) {
    const miswired = fixture(); miswired.setStatus(value);
    const response = await miswired.handler("authorization.status")(request("/authorization"));
    assert.equal(response.status, 500); const output = await response.text(); assert.ok(!output.includes("private-token")); assert.ok(!output.includes("ciphertext"));
  }
});

test("requestId依赖可省略，安全envelope仍返回生成的请求标识", async () => {
  const f = fixture(); delete f.d.requestId;
  const response = await f.handler("authorization.status")(request("/authorization"));
  assert.match((await response.json()).requestId, /^[a-f0-9-]{36}$/);
});
