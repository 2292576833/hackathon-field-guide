import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { ParticipantService } from "./service.ts";
import { validateParticipantProfileUpdate } from "./service.ts";

export interface ParticipantPrincipal {
  /** Constructed from the verified cookie by the server, never from request JSON. */
  actor: Actor;
  /** Rechecks this request's session using the transaction executor. Required at HTTP boundary. */
  guard: FreshSessionGuard;
}

export interface ParticipantHttpOptions {
  service: ParticipantService;
  origin: string;
  resolvePrincipal(request: Request): Promise<ParticipantPrincipal | null>;
  requestIds: IdGenerator;
  maxJsonBytes?: number;
}

export type ParticipantHttpHandler = (request: Request) => Promise<Response>;
export interface ParticipantHandlers {
  getProfile: ParticipantHttpHandler;
  patchProfile: ParticipantHttpHandler;
  /** Mount at /api/v1/me/participant-profile; routes stay coordinator-owned. */
  handle: ParticipantHttpHandler;
}

function fail(code: string, message: string, status: number): never {
  throw new DomainError(code, message, { status });
}

async function json(request: Request, maximum: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("PARTICIPANT_JSON_REQUIRED", "请使用 JSON 格式保存个人画像。", 415);
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") fail("PARTICIPANT_JSON_REQUIRED", "请使用未压缩的 JSON 格式保存个人画像。", 415);
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) fail("PARTICIPANT_BODY_TOO_LARGE", "画像内容过大，请精简后重试。", 413);
  const reader = request.body?.getReader();
  if (!reader) fail("PARTICIPANT_JSON_INVALID", "请提交完整的个人画像。", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => {});
        fail("PARTICIPANT_BODY_TOO_LARGE", "画像内容过大，请精简后重试。", 413);
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("PARTICIPANT_JSON_INVALID", "画像内容不是有效的 JSON，请检查后重试。", 400); }
}

/** Independent GET/PATCH handlers with a private envelope and same-origin mutation check. */
export function createParticipantHandlers(options: ParticipantHttpOptions): ParticipantHandlers {
  let origin: URL;
  try { origin = new URL(options.origin); }
  catch { throw new Error("Participant HTTP origin must be a complete HTTP(S) origin."); }
  if (origin.origin !== options.origin || !["http:", "https:"].includes(origin.protocol)) {
    throw new Error("Participant HTTP origin must be an exact HTTP(S) origin without a path.");
  }
  const maximum = options.maxJsonBytes ?? 65_536;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65_536
    || typeof options.resolvePrincipal !== "function" || typeof options.requestIds?.next !== "function") {
    throw new Error("Participant HTTP requires a principal resolver, request IDs and a valid JSON limit.");
  }
  const response = (body: unknown, status: number, allow?: string): Response => new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", ...(allow ? { Allow: allow } : {}),
    },
  });
  const handler = (onlyMethod?: "GET" | "PATCH"): ParticipantHttpHandler => async request => {
    let requestId = "unavailable";
    try {
      requestId = options.requestIds.next();
      if (typeof requestId !== "string" || !requestId || requestId.length > 128 || /[\u0000-\u001f\u007f]/.test(requestId)) {
        requestId = "unavailable"; throw new Error("Invalid server request ID.");
      }
      const methods = onlyMethod ?? "GET, PATCH";
      if ((onlyMethod && request.method !== onlyMethod) || !["GET", "PATCH"].includes(request.method)) {
        return response(toErrorEnvelope(new DomainError("PARTICIPANT_METHOD_NOT_ALLOWED", "此接口不支持当前请求方式。", { status: 405 }), requestId), 405, methods);
      }
      if (request.method === "PATCH" && request.headers.get("origin") !== options.origin) {
        fail("PARTICIPANT_ORIGIN_INVALID", "请求来源无法确认，请从本站页面重试。", 403);
      }
      const principal = await options.resolvePrincipal(request);
      if (!principal) fail("UNAUTHENTICATED", "请登录后填写个人画像。", 401);
      if (typeof principal.guard !== "function") throw new Error("Participant HTTP principal requires a fresh session guard.");
      const data = request.method === "GET"
        ? await options.service.get(principal.actor, principal.guard)
        : await options.service.update(principal.actor, validateParticipantProfileUpdate(await json(request, maximum)), principal.guard);
      return response({ data, requestId }, 200);
    } catch (error) {
      return response(toErrorEnvelope(error, requestId), isDomainError(error) ? error.status : 500);
    }
  };
  return { getProfile: handler("GET"), patchProfile: handler("PATCH"), handle: handler() };
}
