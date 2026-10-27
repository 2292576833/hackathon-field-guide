import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { RoadshowService } from "./types.ts";

export interface RoadshowHttpDependencies {
  service: RoadshowService;
  resolveActor(request: Request): Promise<Actor | null>;
  authorizeMutation(request: Request, actor: Actor): Promise<void>;
  /** Server factory must derive this from the authenticated request session, never request JSON. */
  freshSessionGuard(request: Request, actor: Actor): FreshSessionGuard;
  requestIds: IdGenerator;
}
export interface RoadshowRouteParams { id: string }
const MAX_BODY_BYTES = 90_000;
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || (request.headers.get("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")) {
    throw new DomainError("JSON_REQUIRED", "请提交未压缩的 JSON 内容。", { status: 415 });
  }
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "路演输入过大。", { status: 413 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new DomainError("PAYLOAD_TOO_LARGE", "路演输入过大。", { status: 413 }); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new DomainError("INVALID_JSON", "请提交有效的 JSON 内容。", { status: 400 }); }
}

/** Bind generate to POST /me/roadshow/scripts; generic artifact routes may use list/get. */
export function createRoadshowHandlers(dependencies: RoadshowHttpDependencies) {
  const handler = (method: string, work: (actor: Actor, request: Request, guard: FreshSessionGuard, params?: RoadshowRouteParams) => Promise<unknown>, status = 200) => async (request: Request, params?: RoadshowRouteParams): Promise<Response> => {
    const requestId = dependencies.requestIds.next();
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
      const actor = await dependencies.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401, recoveryAction: "login" });
      if (method !== "GET") await dependencies.authorizeMutation(request, actor);
      const guard = dependencies.freshSessionGuard(request, actor);
      return Response.json({ data: await work(actor, request, guard, params), requestId }, { status, headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  return {
    generate: handler("POST", async (actor, request, guard) => dependencies.service.generate(actor, await body(request), guard), 201),
    list: handler("GET", async (actor, _request, guard) => dependencies.service.list(actor, guard)),
    get: handler("GET", async (actor, _request, guard, params) => {
      if (!params?.id) throw new DomainError("INVALID_ROUTE", "缺少路演记录标识。", { status: 400 });
      return dependencies.service.get(actor, params.id, guard);
    }),
  };
}
