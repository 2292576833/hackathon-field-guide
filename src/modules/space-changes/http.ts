import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { SpaceChangesService } from "./service.ts";
import type { AcknowledgeSpaceChange } from "./types.ts";

export interface SpaceChangesHttpDependencies {
  service: SpaceChangesService;
  resolveActor(request: Request): Promise<Actor | null>;
  /** Root checks same-origin/session CSRF before all writes. */
  authorizeMutation(request: Request): Promise<void>;
  requestIds: IdGenerator;
}
async function readBody(request: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new DomainError("JSON_REQUIRED", "请求需要JSON格式。", { status: 415 });
  if (!request.body) throw new DomainError("INVALID_JSON", "请求内容不能为空。", { status: 400 });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new DomainError("PAYLOAD_TOO_LARGE", "请求内容过长。", { status: 413 }); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new DomainError("INVALID_JSON", "请求需要有效JSON。", { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new DomainError("INVALID_INPUT", "请求包含不支持的字段。", { status: 400 });
  return body as Record<string, unknown>;
}
export function createSpaceChangesHandlers(deps: SpaceChangesHttpDependencies) {
  const handler = (method: string, action: (actor: Actor, projectId: string, request: Request) => Promise<unknown>) =>
    async (request: Request, params: { projectId: string }): Promise<Response> => {
      const requestId = deps.requestIds.next();
      const headers = { "Cache-Control": "private, no-store" };
      try {
        if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
        const actor = await deps.resolveActor(request);
        if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
        if (method !== "GET") await deps.authorizeMutation(request);
        return Response.json({ data: await action(actor, params.projectId, request), requestId }, { headers });
      } catch (error) {
        return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers });
      }
    };
  return {
    list: handler("GET", (actor, projectId, request) => {
      const query = new URL(request.url).searchParams;
      return deps.service.list(actor, projectId, {
        ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
        ...(query.has("beforeVersion") ? { beforeVersion: Number(query.get("beforeVersion")) } : {}),
      });
    }),
    reconcile: handler("POST", async (actor, projectId, request) => {
      await readBody(request, []);
      return deps.service.reconcile(actor, projectId);
    }),
    acknowledge: handler("POST", async (actor, projectId, request) => {
      const body = await readBody(request, ["changeId", "version", "understood"]);
      return deps.service.acknowledge(actor, projectId, body as unknown as AcknowledgeSpaceChange);
    }),
  };
}
