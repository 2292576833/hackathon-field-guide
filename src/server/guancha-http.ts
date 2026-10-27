import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import { safeAuthReturnTo, type SessionGrant } from "../modules/auth/index.ts";
import type { GuanchaLoginService } from "../modules/guancha-login/index.ts";
import type { GuanchaAuth, GuanchaAuthResult } from "./guancha-auth.ts";

const BROWSER_COOKIE = "__Host-hackathon_guancha_browser";
const PENDING_COOKIE = "__Host-hackathon_guancha_pending";
const attributes = "; Path=/; HttpOnly; SameSite=Lax; Secure";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const linkPage = "/app/account/guancha";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  return values.length === 1 && tokenPattern.test(values[0]!) ? values[0]! : null;
}
function setCookie(headers: Headers, name: string, value: string, expiresAt: string) {
  if (!tokenPattern.test(value) || !Number.isFinite(Date.parse(expiresAt))) throw new Error("Invalid Guancha cookie grant.");
  headers.append("Set-Cookie", `${name}=${value}; Expires=${new Date(expiresAt).toUTCString()}${attributes}`);
}
function clear(headers: Headers, name: string) { headers.append("Set-Cookie", `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${attributes}`); }
function clearFlow(headers: Headers) { clear(headers, BROWSER_COOKIE); clear(headers, PENDING_COOKIE); }
function responseHeaders() { return new Headers({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }); }

export function createGuanchaHttp(deps: {
  readonly service: Pick<GuanchaLoginService<GuanchaAuthResult>, "enabled" | "begin" | "complete">;
  readonly identity: Pick<GuanchaAuth, "confirmLink" | "syncLinkedProfile">;
  readonly database: DatabasePort;
  readonly origin: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly readSessionToken: (request: Request) => string | null;
  readonly currentUserId: (request: Request) => Promise<string | null>;
  readonly initializeWorkspace: (userId: string) => Promise<unknown>;
}) {
  const available = () => {
    if (!deps.service.enabled) throw new DomainError("GUANCHA_LOGIN_UNAVAILABLE", "观猹登录尚未启用，请使用邮箱验证码登录。", { status: 503 });
  };
  const origin = (request: Request) => {
    if (request.headers.get("origin") !== deps.origin) throw new DomainError("AUTH_ORIGIN_INVALID", "请从本站正式登录页面继续。", { status: 403 });
  };
  const budget = async (kind: "begin" | "confirm") => {
    // One bounded, persistent global bucket: never trust X-Forwarded-For as a
    // client identity or create unlimited rows from arbitrary request headers.
    const row = await deps.database.query<{ attempts: number }>(
      `INSERT INTO guancha_http_budgets(kind,window_started_at,attempts) VALUES($1,$2,1)
       ON CONFLICT(kind) DO UPDATE SET
         attempts=CASE WHEN guancha_http_budgets.window_started_at <= $2::timestamptz-interval '5 minutes' THEN 1 ELSE guancha_http_budgets.attempts+1 END,
         window_started_at=CASE WHEN guancha_http_budgets.window_started_at <= $2::timestamptz-interval '5 minutes' THEN $2::timestamptz ELSE guancha_http_budgets.window_started_at END
       WHERE guancha_http_budgets.attempts < 60 OR guancha_http_budgets.window_started_at <= $2::timestamptz-interval '5 minutes'
       RETURNING attempts`, [kind, deps.clock.now().toISOString()]);
    if (!row.rowCount) throw new DomainError("AUTH_RATE_LIMITED", "登录请求较多，请稍后重试。", { status: 429 });
  };
  const body = async (request: Request, fields: readonly string[]) => {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("AUTH_JSON_REQUIRED", "请求格式无效。", { status: 415 });
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) throw new DomainError("BODY_TOO_LARGE", "请求内容过长。", { status: 413 });
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new DomainError("AUTH_JSON_INVALID", "请求格式无效。", { status: 400 }); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw new DomainError("AUTH_FIELDS_INVALID", "请求包含不支持的字段。", { status: 400 });
    return input as Record<string, unknown>;
  };
  const json = async (work: (headers: Headers) => Promise<unknown>, method: string, request: Request) => {
    const headers = responseHeaders(), requestId = deps.ids.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "请求方式不支持。", { status: 405 });
      if (method !== "GET") origin(request);
      return Response.json({ data: await work(headers), requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  const grant = async (headers: Headers, result: SessionGrant) => {
    await deps.initializeWorkspace(result.profile.id);
    setCookie(headers, "__Host-hackathon_session", result.sessionToken, result.expiresAt);
    clearFlow(headers);
  };
  return {
    status: (request: Request) => json(async () => {
      const pendingToken = cookie(request, PENDING_COOKIE), browserBinding = cookie(request, BROWSER_COOKIE);
      let pending = false, linked = false, returnTo: string | undefined;
      if (deps.service.enabled && pendingToken && browserBinding) {
        const row = await deps.database.query<{ consumed_at: string | Date | null; issuer: string; subject: string; return_to: string }>(
          "SELECT consumed_at,issuer,subject,return_to FROM guancha_pending_links WHERE token_hash=$1 AND browser_binding_hash=$2 AND created_at<=$3 AND expires_at>$3",
          [hash(pendingToken), hash(browserBinding), deps.clock.now().toISOString()]);
        const value = row.rows[0];
        pending = Boolean(value && value.consumed_at === null);
        if (value?.consumed_at) {
          const userId = await deps.currentUserId(request);
          if (userId) {
            const match = await deps.database.query("SELECT user_id FROM guancha_identity_bindings WHERE issuer=$1 AND subject=$2 AND user_id=$3", [value.issuer, value.subject, userId]);
            linked = match.rowCount === 1;
            if (linked) returnTo = safeAuthReturnTo(value.return_to);
          }
        }
      }
      const canonical = request.headers.get("host") === new URL(deps.origin).host || new URL(request.url).origin === deps.origin;
      return { enabled: deps.service.enabled && canonical, pending: pending && canonical, linked: linked && canonical,
        ...(linked && canonical ? { returnTo } : {}) };
    }, "GET", request),
    begin: (request: Request) => json(async headers => {
      available(); const input = await body(request, ["returnTo"]); await budget("begin");
      const result = await deps.service.begin(input.returnTo);
      setCookie(headers, BROWSER_COOKIE, result.browserBinding, result.expiresAt); clear(headers, PENDING_COOKIE);
      return { authorizationUrl: result.authorizationUrl };
    }, "POST", request),
    async callback(request: Request) {
      const headers = responseHeaders();
      try {
        available();
        if (request.method !== "GET") throw new Error("Wrong method");
        const query = new URL(request.url).searchParams;
        if (["state", "code", "error"].some(key => query.getAll(key).length > 1)) throw new Error("Duplicate callback parameters");
        const result = await deps.service.complete({ state: query.get("state"), browserBinding: cookie(request, BROWSER_COOKIE),
          ...(query.has("code") ? { code: query.get("code") } : {}), ...(query.has("error") ? { error: query.get("error") } : {}) });
        if (result.status === "authenticated") { await grant(headers, result.grant); headers.set("Location", deps.origin + safeAuthReturnTo(result.grant.returnTo)); }
        else { setCookie(headers, PENDING_COOKIE, result.pendingToken, result.expiresAt); headers.set("Location", deps.origin + linkPage); }
      } catch (error) {
        clearFlow(headers);
        headers.set("Location", `${deps.origin}/login?guancha=${isDomainError(error) && error.code === "GUANCHA_LOGIN_CANCELLED" ? "cancelled" : "failed"}`);
      }
      return new Response(null, { status: 303, headers });
    },
    confirm: (request: Request) => json(async headers => {
      available(); const input = await body(request, ["confirm"]);
      if (input.confirm !== true) throw new DomainError("GUANCHA_CONFIRM_REQUIRED", "请确认关联到当前账号。", { status: 422 });
      await budget("confirm");
      const result = await deps.identity.confirmLink({ pendingToken: cookie(request, PENDING_COOKIE), browserBinding: cookie(request, BROWSER_COOKIE), sessionToken: deps.readSessionToken(request) });
      // 首次关联成功：继承观猹昵称与头像（仅此一次，之后登录不再覆盖用户自己改过的名字）。
      // 这一步失败只影响"有没有头像/默认昵称"，**不影响这次已经成功的关联**。
      const userId = await deps.currentUserId(request);
      if (userId) await deps.identity.syncLinkedProfile(userId, result.profileSync);
      clearFlow(headers); return result;
    }, "POST", request),
    cancel: (request: Request) => json(async headers => {
      await body(request, []); clearFlow(headers); return { cancelled: true };
    }, "POST", request),
  };
}
