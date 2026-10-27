import { randomUUID } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { GitHubIdentity } from "./authorization-types.ts";
import { authorizationCookieName } from "./authorization-service.ts";
import type { RepositoryCreationService, RepositoryCreationInput } from "./repository-creation.ts";

export type GitHubAuthorizationAction = "authorization.start" | "authorization.callback" | "authorization.status" | "authorization.revoke"
  | "installation.start" | "installation.callback" | "installations.list" | "repositories.list"
  | "creation.preview" | "creation.get" | "creation.confirm" | "creation.reconcile";

export interface AuthorizationBrowserCookie { name: string; value: string; path: string; maxAge: number; secure: boolean }
export interface AuthorizationHandlerPort {
  start(actor: Actor, input: { projectId?: string }): Promise<{ authorizationUrl: string; expiresAt: string; cookie: AuthorizationBrowserCookie }>;
  complete(actor: Actor, input: { state: string; code?: string; error?: string }, browserNonce: string): Promise<{ returnTo: string; status: "bound"; identity: GitHubIdentity }>;
  status(actor: Actor): Promise<unknown>;
  revoke(actor: Actor): Promise<unknown>;
  startInstallation(actor: Actor, input: { projectId?: string }): Promise<{ installationUrl: string; expiresAt: string; cookie: AuthorizationBrowserCookie }>;
  completeInstallation(actor: Actor, input: { state: string; installationId: number }, browserNonce: string): Promise<{ returnTo: string; installationId: number }>;
  listInstallations(actor: Actor): Promise<unknown>;
  listRepositories(actor: Actor, installationId: number): Promise<unknown>;
}
export interface GitHubAuthorizationHandlerDependencies {
  authorization: AuthorizationHandlerPort;
  creation: Pick<RepositoryCreationService, "preview" | "get" | "confirm" | "reconcile">;
  resolveActor(request: Request): Promise<Actor | null>;
  /** Ordinary mutations use the shared origin/CSRF check; GitHub callbacks use single-use state + browser nonce. */
  assertMutationAllowed(request: Request, actor: Actor): Promise<void>;
  requestId?(): string;
}

const verbs: Record<GitHubAuthorizationAction, string> = {
  "authorization.start": "POST", "authorization.callback": "GET", "authorization.status": "GET", "authorization.revoke": "DELETE",
  "installation.start": "POST", "installation.callback": "GET", "installations.list": "GET", "repositories.list": "GET",
  "creation.preview": "POST", "creation.get": "GET", "creation.confirm": "POST", "creation.reconcile": "POST",
};
const BODY_LIMIT = 64 * 1024;
function invalid(message: string): never { throw new DomainError("INVALID_INPUT", message); }
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`请提供有效的${field}。`);
  return value;
}
function keys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid("请求包含不可写入的字段。");
}
function positiveId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) invalid("请提供有效的 GitHub 安装 ID。");
  return Number(value);
}
function query(url: URL, name: string, required = true): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1 || (required && values.length !== 1)) invalid("GitHub 回调或查询参数不完整。");
  return values.length ? string(values[0], "GitHub 查询参数") : undefined;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("JSON_REQUIRED", "请使用 JSON 请求。", { status: 415 });
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > BODY_LIMIT) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "请求内容超过限制。", { status: 413 }); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
  catch { throw new DomainError("INVALID_JSON", "请求内容无法解析。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请提供有效的 JSON 对象。");
  const input = value as Record<string, unknown>;
  if (["actor", "user", "userId", "actorId", "platformRoles", "token", "accessToken", "refreshToken", "credential", "clientSecret"].some(key => key in input)) {
    throw new DomainError("SERVER_IDENTITY_REQUIRED", "身份与凭据必须来自服务器会话。");
  }
  return input;
}

function setCookie(cookie: AuthorizationBrowserCookie, requestUrl: URL): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cookie.name) || typeof cookie.value !== "string" || !cookie.value || cookie.value.length > 2048 || /[\u0000-\u001f\u007f]/.test(cookie.value) || !cookie.path.startsWith("/") || /[;\u0000-\u0020\u007f]/.test(cookie.path) || !Number.isSafeInteger(cookie.maxAge) || cookie.maxAge < 1 || cookie.maxAge > 3600 || typeof cookie.secure !== "boolean") {
    throw new DomainError("INVALID_AUTHORIZATION_COOKIE", "授权浏览器校验暂时不可用。", { status: 500 });
  }
  return `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=Lax${cookie.secure || requestUrl.protocol === "https:" ? "; Secure" : ""}`;
}
function clearCookie(name: string, requestUrl: URL): string {
  return `${name}=; Path=${requestUrl.pathname}; Max-Age=0; HttpOnly; SameSite=Lax${requestUrl.protocol === "https:" ? "; Secure" : ""}`;
}
function browserNonce(request: Request, cookieName: string): string {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 16_384) invalid("浏览器授权校验无效。");
  const matches = header.split(";").map(value => value.trim()).filter(value => value.slice(0, value.indexOf("=")) === cookieName);
  if (matches.length !== 1) throw new DomainError("GITHUB_BROWSER_STATE_REQUIRED", "请在发起授权的同一浏览器完成连接。", { status: 403 });
  let value: string;
  try { value = decodeURIComponent(matches[0].slice(matches[0].indexOf("=") + 1)); } catch { invalid("浏览器授权校验无效。"); }
  return string(value, "浏览器授权校验");
}
function safeReturnTo(returnTo: string, requestUrl: URL): string {
  if (typeof returnTo !== "string" || !returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(returnTo) || new URL(returnTo, requestUrl.origin).origin !== requestUrl.origin) {
    throw new DomainError("INVALID_AUTHORIZATION_RETURN_TO", "授权完成后的返回地址无效。", { status: 500 });
  }
  return returnTo;
}

/** Defense in depth: even a miswired service must not put stored credentials in a JSON response. */
function assertPublicResponse(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new DomainError("UNSAFE_AUTHORIZATION_RESPONSE", "授权状态暂时无法显示。", { status: 500 });
  seen.add(value);
  if (Object.keys(value).some(key => ["token", "accessToken", "refreshToken", "access_token", "refresh_token", "clientSecret", "credential", "encryptedTokens", "encryptedVerifier", "codeVerifier", "browserNonce", "cookie"].includes(key))) {
    throw new DomainError("UNSAFE_AUTHORIZATION_RESPONSE", "授权状态暂时无法显示。", { status: 500 });
  }
  for (const child of Object.values(value)) assertPublicResponse(child, seen);
  seen.delete(value);
}

/** Each route fixes an action; project/operation identifiers come from trusted route parameters. */
export function createGitHubAuthorizationHandler(action: GitHubAuthorizationAction, d: GitHubAuthorizationHandlerDependencies) {
  return async (request: Request, params: { projectId?: string; operationId?: string } = {}): Promise<Response> => {
    const requestId = d.requestId?.() ?? randomUUID();
    const headers = new Headers({ "Cache-Control": "private, no-store" });
    const url = new URL(request.url);
    try {
      if (request.method !== verbs[action]) throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
      const actor = await d.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      if (verbs[action] !== "GET") await d.assertMutationAllowed(request, actor);
      let data: unknown;
      switch (action) {
        case "authorization.start": case "installation.start": {
          const input = await body(request); keys(input, ["projectId"]);
          const target = input.projectId === undefined ? {} : { projectId: string(input.projectId, "项目 ID") };
          if (action === "authorization.start") {
            const result = await d.authorization.start(actor, target);
            headers.set("Set-Cookie", setCookie(result.cookie, url));
            data = { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt };
          } else {
            const result = await d.authorization.startInstallation(actor, target);
            headers.set("Set-Cookie", setCookie(result.cookie, url));
            data = { installationUrl: result.installationUrl, expiresAt: result.expiresAt };
          }
          break;
        }
        case "authorization.callback": case "installation.callback": {
          const state = query(url, "state")!;
          if (!/^[A-Za-z0-9_-]{43}$/.test(state)) invalid("GitHub 授权 state 无效。");
          const flow = action === "authorization.callback" ? "authorization" : "installation";
          const name = authorizationCookieName(flow, state);
          headers.set("Set-Cookie", clearCookie(name, url));
          const nonce = browserNonce(request, name);
          const result = action === "authorization.callback"
            ? await d.authorization.complete(actor, { state, ...(query(url, "code", false) ? { code: query(url, "code", false)! } : {}), ...(query(url, "error", false) ? { error: query(url, "error", false)! } : {}) }, nonce)
            : await d.authorization.completeInstallation(actor, { state, installationId: positiveId(query(url, "installation_id")) }, nonce);
          headers.set("Location", safeReturnTo(result.returnTo, url));
          return new Response(null, { status: 303, headers });
        }
        case "authorization.status": data = await d.authorization.status(actor); break;
        case "authorization.revoke": data = await d.authorization.revoke(actor); break;
        case "installations.list": data = await d.authorization.listInstallations(actor); break;
        case "repositories.list": data = await d.authorization.listRepositories(actor, positiveId(query(url, "installationId"))); break;
        case "creation.preview": {
          const input = await body(request); keys(input, ["name", "description", "private", "idempotencyKey"]);
          if (typeof input.private !== "boolean" || (input.description !== undefined && typeof input.description !== "string")) invalid("请明确提供仓库可见性和有效说明。");
          data = await d.creation.preview(actor, string(params.projectId, "项目 ID"), { name: string(input.name, "仓库名称"), ...(input.description !== undefined ? { description: input.description } : {}), private: input.private, idempotencyKey: string(input.idempotencyKey, "幂等键") } as RepositoryCreationInput);
          break;
        }
        case "creation.get": data = await d.creation.get(actor, string(params.projectId, "项目 ID"), string(params.operationId, "操作 ID")); break;
        case "creation.confirm": {
          const input = await body(request); keys(input, ["confirmationHash"]);
          data = await d.creation.confirm(actor, string(params.projectId, "项目 ID"), string(params.operationId, "操作 ID"), string(input.confirmationHash, "确认版本")); break;
        }
        case "creation.reconcile": data = await d.creation.reconcile(actor, string(params.projectId, "项目 ID"), string(params.operationId, "操作 ID")); break;
      }
      assertPublicResponse(data);
      const status = data && typeof data === "object" && "status" in data ? (data as { status: unknown }).status : null;
      return Response.json({ data, requestId }, { status: status === "creating" || status === "unknown" ? 202 : action === "creation.preview" ? 201 : 200, headers });
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers });
    }
  };
}
