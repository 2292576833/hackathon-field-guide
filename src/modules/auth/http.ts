import type { IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { AuthClientKeyPort } from "./ports.ts";
import type { AuthService } from "./service.ts";
import type { AccountSettings, LoginChallengeReceipt, SessionGrant, SessionSummary, UserProfile } from "./types.ts";

/** Server-only methods used by HTTP; allows test doubles without a live store or mail provider. */
export type AuthHttpService = Pick<AuthService,
  | "requestLoginChallenge" | "verifyLoginChallenge" | "getCurrentProfile" | "updateOwnProfile"
  | "logout" | "logoutAll" | "listOwnSessions" | "revokeOwnSession"
  | "getAccountSettings"
> & Partial<Pick<AuthService, "requestRegistrationChallenge" | "verifyRegistrationChallenge">>;

export interface AuthHttpOptions {
  readonly service: AuthHttpService;
  /** Exact public origin, configured by the server; never derive it from request headers. */
  readonly origin: string;
  /** Obtain a rate-limit key from a trusted transport/proxy integration, not forwarded JSON/headers. */
  readonly clientKeys?: AuthClientKeyPort;
  /** Transitional server adapter; configure either this callback or clientKeys, never both. */
  readonly getClientKey?: (request: Request) => string | Promise<string>;
  readonly requestIds: IdGenerator;
  readonly secure?: boolean;
  readonly cookieName?: string;
  readonly maxJsonBytes?: number;
}

export type AuthHttpHandler = (request: Request) => Promise<Response>;

export interface AuthHandlers {
  /** Reuse this exact boundary when a separate account operation invalidates the current session. */
  readonly clearSessionCookie: string;
  readonly requestLoginChallenge: AuthHttpHandler;
  readonly verify: AuthHttpHandler;
  readonly requestRegistrationChallenge: AuthHttpHandler;
  readonly verifyRegistration: AuthHttpHandler;
  readonly getMe: AuthHttpHandler;
  readonly patchMe: AuthHttpHandler;
  readonly getAccountSettings: AuthHttpHandler;
  readonly getCurrentSession: AuthHttpHandler;
  readonly logout: AuthHttpHandler;
  readonly logoutAll: AuthHttpHandler;
  readonly listSessions: AuthHttpHandler;
  readonly revokeSession: AuthHttpHandler;
  /** Use the same configured cookie boundary when composing other server-side auth queries. */
  readonly readSessionToken: (request: Request) => string | null;
}

function inputError(code: string, message: string, status = 422): DomainError {
  return new DomainError(code, message, { status });
}

function profileData(profile: UserProfile): UserProfile {
  return {
    id: profile.id, email: profile.email, displayName: profile.displayName,
    timezone: profile.timezone, emailVerifiedAt: profile.emailVerifiedAt, revision: profile.revision,
  };
}

function challengeData(receipt: LoginChallengeReceipt): LoginChallengeReceipt {
  return {
    challengeId: receipt.challengeId, expiresAt: receipt.expiresAt,
    resendAfterSeconds: receipt.resendAfterSeconds, message: receipt.message,
  };
}

function sessionData(session: SessionSummary): SessionSummary {
  return {
    id: session.id, createdAt: session.createdAt, authenticatedAt: session.authenticatedAt,
    expiresAt: session.expiresAt, current: session.current, lastSeenAt: session.lastSeenAt,
  };
}

function accountSettingsData(settings: AccountSettings): AccountSettings {
  return {
    profile: profileData(settings.profile), currentSession: sessionData(settings.currentSession),
    sessions: settings.sessions.map(sessionData), recentAuthenticationUntil: settings.recentAuthenticationUntil,
    canLogoutAll: settings.canLogoutAll,
  };
}

function checkFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw inputError("AUTH_FIELDS_INVALID", "请求包含不支持的字段，请检查后重试。");
  }
}

async function readJson(request: Request, maximum: number, allowEmpty: boolean): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type");
  const isJson = contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  if (!isJson && !(allowEmpty && contentType === null)) {
    throw inputError("AUTH_JSON_REQUIRED", "请使用 JSON 格式提交请求。", 415);
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw inputError("AUTH_JSON_REQUIRED", "请使用未压缩的 JSON 格式提交请求。", 415);
  }
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    throw inputError("AUTH_BODY_TOO_LARGE", "请求内容过大，请精简后重试。", 413);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) {
          void reader.cancel().catch(() => {});
          throw inputError("AUTH_BODY_TOO_LARGE", "请求内容过大，请精简后重试。", 413);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (size === 0 && allowEmpty) return {};
  if (!isJson) throw inputError("AUTH_JSON_REQUIRED", "请使用 JSON 格式提交请求。", 415);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw inputError("AUTH_JSON_INVALID", "请求内容不是有效的 JSON 对象。", 400); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw inputError("AUTH_JSON_INVALID", "请求内容需要为 JSON 对象。", 400);
  }
  return value as Record<string, unknown>;
}

/** Framework-independent handlers. Bind each function to its matching App Router method. */
export function createAuthHandlers(options: AuthHttpOptions): AuthHandlers {
  let publicOrigin: URL;
  try { publicOrigin = new URL(options.origin); }
  catch { throw new Error("Auth HTTP origin must be a complete HTTP(S) origin."); }
  if (publicOrigin.origin !== options.origin || !["https:", "http:"].includes(publicOrigin.protocol)) {
    throw new Error("Auth HTTP origin must be an exact HTTP(S) origin without a path.");
  }
  const secure = options.secure ?? true;
  if (typeof secure !== "boolean") throw new Error("Auth cookie secure setting must be a boolean.");
  if (secure && publicOrigin.protocol !== "https:") throw new Error("Secure auth cookies require an HTTPS origin.");
  if (!secure && (publicOrigin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(publicOrigin.hostname))) {
    throw new Error("Insecure auth cookies are only allowed with an explicit loopback HTTP development origin.");
  }
  const cookieName = options.cookieName ?? (secure ? "__Host-hackathon_session" : "hackathon_session");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)
    || (!secure && (cookieName.startsWith("__Host-") || cookieName.startsWith("__Secure-")))) {
    throw new Error("Auth cookie name is invalid for its secure configuration.");
  }
  const maxJsonBytes = options.maxJsonBytes ?? 4096;
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 0 || maxJsonBytes > 65_536) {
    throw new Error("Auth JSON limit must be a positive safe integer no greater than 65536 bytes.");
  }
  const usesClientPort = options.clientKeys !== undefined;
  const usesClientCallback = options.getClientKey !== undefined;
  if (usesClientPort === usesClientCallback
    || (usesClientPort && typeof options.clientKeys?.getClientKey !== "function")
    || (usesClientCallback && typeof options.getClientKey !== "function")
    || typeof options.requestIds?.next !== "function") {
    throw new Error("Auth HTTP requires trusted client keys and a server request ID generator.");
  }
  const getClientKey = options.clientKeys
    ? (request: Request) => options.clientKeys!.getClientKey(request)
    : options.getClientKey!;
  const attributes = `; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const clearedCookie = `${cookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${attributes}`;
  const readSessionToken = (request: Request): string | null => {
    const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`))
      .map((part) => part.slice(cookieName.length + 1));
    return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0]! : null;
  };
  const response = (body: unknown, status: number, extraHeaders?: HeadersInit): Response => {
    const headers = new Headers(extraHeaders);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(body), { status, headers });
  };
  type Operation = (request: Request) => Promise<{ readonly data: unknown; readonly cookie?: string }>;
  const wrap = (method: string, operation: Operation): AuthHttpHandler => async (request) => {
    let requestId = "unavailable";
    try {
      requestId = options.requestIds.next();
      if (typeof requestId !== "string" || !requestId || requestId.length > 128 || /[\u0000-\u001f\u007f]/.test(requestId)) {
        requestId = "unavailable";
        throw new Error("Invalid server request ID.");
      }
      if (request.method !== method) {
        return response(toErrorEnvelope(inputError("AUTH_METHOD_NOT_ALLOWED", "此接口不支持当前请求方式。", 405), requestId), 405, { Allow: method });
      }
      if (method !== "GET" && request.headers.get("origin") !== options.origin) {
        throw inputError("AUTH_ORIGIN_INVALID", "请求来源无法确认，请从本站页面重试。", 403);
      }
      const result = await operation(request);
      return response({ data: result.data, requestId }, 200, result.cookie ? { "Set-Cookie": result.cookie } : undefined);
    } catch (error) {
      const status = isDomainError(error) ? error.status : 500;
      return response(toErrorEnvelope(error, requestId), status);
    }
  };
  const json = (request: Request, fields: readonly string[], allowEmpty = false) => readJson(request, maxJsonBytes, allowEmpty)
    .then((body) => { checkFields(body, fields); return body; });
  const grantResponse = (grant: SessionGrant) => {
    const expiresAt = new Date(grant.expiresAt);
    if (!/^[A-Za-z0-9_-]{43}$/.test(grant.sessionToken) || !Number.isFinite(expiresAt.getTime())) {
      throw new Error("Invalid server session grant.");
    }
    return {
      data: { profile: profileData(grant.profile), returnTo: grant.returnTo },
      cookie: `${cookieName}=${grant.sessionToken}; Expires=${expiresAt.toUTCString()}${attributes}`,
    };
  };

  return {
    clearSessionCookie: clearedCookie,
    readSessionToken,
    requestLoginChallenge: wrap("POST", async (request) => {
      const body = await json(request, ["email"]);
      const receipt = await options.service.requestLoginChallenge(body.email, await getClientKey(request));
      return { data: challengeData(receipt) };
    }),
    requestRegistrationChallenge: wrap("POST", async (request) => {
      const body = await json(request, ["email", "displayName"]);
      if (!options.service.requestRegistrationChallenge) {
        throw inputError("AUTH_REGISTRATION_UNAVAILABLE", "注册服务暂时不可用，请稍后重试。", 503);
      }
      const receipt = await options.service.requestRegistrationChallenge({ email: body.email, displayName: body.displayName }, await getClientKey(request));
      return { data: challengeData(receipt) };
    }),
    verifyRegistration: wrap("POST", async (request) => {
      const body = await json(request, ["challengeId", "code", "returnTo"]);
      if (!options.service.verifyRegistrationChallenge) {
        throw inputError("AUTH_REGISTRATION_UNAVAILABLE", "注册服务暂时不可用，请稍后重试。", 503);
      }
      return grantResponse(await options.service.verifyRegistrationChallenge({ challengeId: body.challengeId, code: body.code, returnTo: body.returnTo }, await getClientKey(request)));
    }),
    verify: wrap("POST", async (request) => {
      const body = await json(request, ["challengeId", "code", "returnTo"]);
      const grant = await options.service.verifyLoginChallenge({ challengeId: body.challengeId, code: body.code, returnTo: body.returnTo }, await getClientKey(request));
      return grantResponse(grant);
    }),
    getMe: wrap("GET", async (request) => ({ data: { profile: profileData(await options.service.getCurrentProfile(readSessionToken(request))) } })),
    getAccountSettings: wrap("GET", async (request) => ({ data: accountSettingsData(await options.service.getAccountSettings(readSessionToken(request))) })),
    getCurrentSession: wrap("GET", async (request) => ({ data: { session: sessionData((await options.service.getAccountSettings(readSessionToken(request))).currentSession) } })),
    patchMe: wrap("PATCH", async (request) => {
      const body = await json(request, ["displayName", "timezone", "expectedRevision"]);
      if (typeof body.displayName !== "string" || typeof body.timezone !== "string" || typeof body.expectedRevision !== "number") {
        throw inputError("AUTH_PROFILE_INVALID", "请提供昵称、时区和当前资料版本。");
      }
      const profile = await options.service.updateOwnProfile(readSessionToken(request), {
        displayName: body.displayName, timezone: body.timezone, expectedRevision: body.expectedRevision,
      });
      return { data: { profile: profileData(profile) } };
    }),
    logout: wrap("POST", async (request) => {
      await json(request, [], true);
      await options.service.logout(readSessionToken(request));
      return { data: { loggedOut: true }, cookie: clearedCookie };
    }),
    logoutAll: wrap("POST", async (request) => {
      await json(request, [], true);
      await options.service.logoutAll(readSessionToken(request));
      return { data: { loggedOut: true }, cookie: clearedCookie };
    }),
    listSessions: wrap("GET", async (request) => ({ data: { sessions: (await options.service.listOwnSessions(readSessionToken(request))).map(sessionData) } })),
    revokeSession: wrap("POST", async (request) => {
      const body = await json(request, ["sessionId"]);
      if (typeof body.sessionId !== "string") throw inputError("AUTH_SESSION_ID_INVALID", "请选择需要退出的设备会话。");
      const result = await options.service.revokeOwnSession(readSessionToken(request), body.sessionId);
      return {
        data: { revoked: result.revoked, currentSessionRevoked: result.currentSessionRevoked },
        ...(result.currentSessionRevoked ? { cookie: clearedCookie } : {}),
      };
    }),
  };
}
