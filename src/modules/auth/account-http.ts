import type { IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { AuthClientKeyPort } from "./ports.ts";
import type { AuthHttpHandler } from "./http.ts";
import type { AccountCompletionService } from "./account-service.ts";

export type AccountCompletionHttpService = Pick<AccountCompletionService,
  "getDataOverview" | "requestExport" | "prepareExport" | "downloadExport" | "requestDeletion" | "refreshDeletion" | "cancelDeletion" | "requestEmailChange" | "verifyEmailChange">;
export interface AccountCompletionHttpOptions {
  readonly service: AccountCompletionHttpService; readonly origin: string; readonly requestIds: IdGenerator;
  readonly clientKeys: AuthClientKeyPort;
  /** Both values come from the already configured createAuthHandlers instance. */
  readonly readSessionToken: (request: Request) => string | null;
  readonly clearSessionCookie: string; readonly maxJsonBytes?: number;
}
export interface AccountCompletionHandlers {
  readonly getDataOverview: AuthHttpHandler; readonly requestExport: AuthHttpHandler;
  readonly prepareExport: AuthHttpHandler; readonly downloadExport: AuthHttpHandler;
  readonly requestDeletion: AuthHttpHandler; readonly refreshDeletion: AuthHttpHandler; readonly cancelDeletion: AuthHttpHandler;
  readonly requestEmailChange: AuthHttpHandler; readonly verifyEmailChange: AuthHttpHandler;
}
const invalid = (message: string, status = 422) => new DomainError("ACCOUNT_FIELDS_INVALID", message, { status });

async function readBody(request: Request, fields: readonly string[], maximum: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")) throw invalid("请使用未压缩的 JSON 请求。", 415);
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maximum) { void reader.cancel().catch(() => {}); throw invalid("请求内容过大。", 413); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try {
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const c of chunks) { joined.set(c, offset); offset += c.byteLength; }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch { throw invalid("请求需要为有效 JSON 对象。", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw invalid("请求包含不支持的字段。");
  return value as Record<string, unknown>;
}
/** Framework-independent handlers: all owner identity comes from the existing auth cookie reader. */
export function createAccountCompletionHandlers(options: AccountCompletionHttpOptions): AccountCompletionHandlers {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || !["http:", "https:"].includes(origin.protocol)
    || (origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("An exact secure or loopback account origin is required.");
  if (!options.clearSessionCookie || /[\r\n]/.test(options.clearSessionCookie)
    || !/;\s*HttpOnly(?:;|$)/i.test(options.clearSessionCookie) || !/;\s*Max-Age=0(?:;|$)/i.test(options.clearSessionCookie)
    || (origin.protocol === "https:" && !/;\s*Secure(?:;|$)/i.test(options.clearSessionCookie))) throw new Error("Reuse the existing auth clear-session cookie.");
  const maximum = options.maxJsonBytes ?? 4096;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65_536) throw new Error("Invalid account JSON limit.");
  const json = (request: Request, fields: readonly string[]) => readBody(request, fields, maximum);
  const response = (value: unknown, status: number, headers?: HeadersInit) => new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...Object.fromEntries(new Headers(headers)) },
  });
  const wrap = (method: string, run: (request: Request) => Promise<unknown>, optionsForResponse?: { clearCookie?: boolean; download?: boolean }): AuthHttpHandler => async (request) => {
    let requestId = "unavailable";
    try {
      requestId = options.requestIds.next();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) { requestId = "unavailable"; throw new Error("Invalid request ID."); }
      if (request.method !== method) return response(toErrorEnvelope(new DomainError("AUTH_METHOD_NOT_ALLOWED", "此接口不支持当前方式。", { status: 405 }), requestId), 405, { Allow: method });
      if (method !== "GET" && request.headers.get("origin") !== options.origin) throw new DomainError("AUTH_ORIGIN_INVALID", "请从本站页面发起操作。", { status: 403 });
      const data = await run(request);
      if (optionsForResponse?.download) {
        const file = data as { filename: string; json: string };
        if (!/^hackathon-own-data-\d{4}-\d{2}-\d{2}\.json$/.test(file.filename)) throw new Error("Invalid download filename.");
        return new Response(file.json, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${file.filename}"`, "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId } });
      }
      return response({ data, requestId }, 200, optionsForResponse?.clearCookie ? { "Set-Cookie": options.clearSessionCookie } : undefined);
    } catch (failure) { return response(toErrorEnvelope(failure, requestId), isDomainError(failure) ? failure.status : 500); }
  };
  const token = options.readSessionToken;
  const recordInput = async (request: Request) => {
    const body = await json(request, ["id", "expectedRevision"]);
    if (typeof body.id !== "string" || typeof body.expectedRevision !== "number") throw invalid("请提供请求编号与当前版本。");
    return { id: body.id, revision: body.expectedRevision };
  };
  return {
    getDataOverview: wrap("GET", (request) => options.service.getDataOverview(token(request))),
    requestExport: wrap("POST", async (request) => { await json(request, []); return options.service.requestExport(token(request)); }),
    prepareExport: wrap("POST", async (request) => { const input = await recordInput(request); return options.service.prepareExport(token(request), input.id, input.revision); }),
    downloadExport: wrap("GET", async (request) => {
      const query = new URL(request.url).searchParams;
      if (query.size !== 1 || query.getAll("id").length !== 1) throw invalid("请选择一个导出请求。");
      return options.service.downloadExport(token(request), query.get("id")!);
    }, { download: true }),
    requestDeletion: wrap("POST", async (request) => {
      const body = await json(request, ["confirmed"]);
      if (body.confirmed !== true) throw invalid("请先阅读并确认删除申请影响。");
      return options.service.requestDeletion(token(request));
    }),
    refreshDeletion: wrap("POST", async (request) => { const input = await recordInput(request); return options.service.refreshDeletion(token(request), input.id, input.revision); }),
    cancelDeletion: wrap("POST", async (request) => { const input = await recordInput(request); return options.service.cancelDeletion(token(request), input.id, input.revision); }),
    requestEmailChange: wrap("POST", async (request) => {
      const body = await json(request, ["newEmail", "expectedRevision"]);
      if (typeof body.expectedRevision !== "number") throw invalid("请提供当前账号资料版本。");
      return options.service.requestEmailChange(token(request), { newEmail: body.newEmail, expectedRevision: body.expectedRevision }, await options.clientKeys.getClientKey(request));
    }),
    verifyEmailChange: wrap("POST", async (request) => {
      const body = await json(request, ["challengeId", "currentCode", "newCode"]);
      if (typeof body.challengeId !== "string") throw invalid("请提供邮箱验证请求编号。");
      const result = await options.service.verifyEmailChange(token(request), { challengeId: body.challengeId, currentCode: body.currentCode, newCode: body.newCode }, await options.clientKeys.getClientKey(request));
      // Explicit projection: no challenge hashes or session grant can enter the response.
      return { changed: result.changed, requiresLogin: result.requiresLogin, profile: result.profile };
    }, { clearCookie: true }),
  };
}
