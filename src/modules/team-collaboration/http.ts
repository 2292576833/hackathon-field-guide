import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { TeamCollaborationService } from "./service.ts";
import type { EditSuggestionCommand, PublishSuggestionCommand, ShareSourceKind, SuggestionActionCommand } from "./types.ts";

export interface TeamCollaborationHttpDependencies {
  service: Pick<TeamCollaborationService, "listFeed" | "publish" | "edit" | "withdraw" | "adopt">;
  resolveActor(request: Request): Promise<Actor | null>;
  /** Root enforces cookie-session same-origin/CSRF policy before mutations. */
  authorizeMutation(request: Request): Promise<void>;
  requestIds: IdGenerator;
}
export interface TeamCollaborationRouteParams { projectId: string; suggestionId?: string }
const headers = { "Cache-Control": "private, no-store" };
async function body(request: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("JSON_REQUIRED", "请提交JSON格式内容。", { status: 415 });
  if (!request.body) throw new DomainError("INVALID_JSON", "请求内容不能为空。", { status: 400 });
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 32768) { await reader.cancel(); throw new DomainError("PAYLOAD_TOO_LARGE", "分享内容过大，请缩短片段。", { status: 413 }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new DomainError("INVALID_JSON", "请求需要有效JSON。", { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "请求内容需要一个对象。", { status: 400 });
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DomainError("INVALID_INPUT", "请求包含不支持的字段。", { status: 400 });
  return value as Record<string, unknown>;
}
function key(request: Request, input: Record<string, unknown>): string {
  const header = request.headers.get("Idempotency-Key");
  if (header && input.idempotencyKey !== undefined && header !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_CONFLICT", "请求正文与请求头的操作标识不一致。", { status: 409 });
  const value = header ?? input.idempotencyKey;
  if (typeof value !== "string" || !value.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "请提供操作标识以恢复重复请求。", { status: 400 });
  return value;
}
function suggestionId(params: TeamCollaborationRouteParams): string {
  if (!params.suggestionId) throw new DomainError("INVALID_ROUTE", "缺少建议标识。", { status: 400 });
  return params.suggestionId;
}
export function createTeamCollaborationHandlers(deps: TeamCollaborationHttpDependencies) {
  const handler = (method: string, work: (actor: Actor, request: Request, params: TeamCollaborationRouteParams) => Promise<unknown>, status = 200) => async (request: Request, params: TeamCollaborationRouteParams): Promise<Response> => {
    const requestId = deps.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "这个入口不支持此请求方法。", { status: 405 });
      const actor = await deps.resolveActor(request); if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录后打开团队空间。", { status: 401, recoveryAction: "login" });
      if (method !== "GET") await deps.authorizeMutation(request);
      const data = await work(actor, request, params); return Response.json({ data, requestId }, { status, headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  return {
    listFeed: handler("GET", (actor, request, params) => {
      const raw = new URL(request.url).searchParams.get("limit");
      return deps.service.listFeed(actor, params.projectId, raw === null ? {} : { limit: Number(raw) });
    }),
    publish: handler("POST", async (actor, request, params) => {
      const input = await body(request, ["sourceKind", "sourceId", "title", "body", "idempotencyKey"]);
      const command: PublishSuggestionCommand = { sourceKind: input.sourceKind as ShareSourceKind, sourceId: input.sourceId as string | null, title: input.title as string, body: input.body as string, idempotencyKey: key(request, input) };
      return deps.service.publish(actor, params.projectId, command);
    }, 201),
    edit: handler("PATCH", async (actor, request, params) => {
      const input = await body(request, ["expectedRevision", "title", "body", "idempotencyKey"]);
      const command: EditSuggestionCommand = { expectedRevision: input.expectedRevision as number, title: input.title as string, body: input.body as string, idempotencyKey: key(request, input) };
      return deps.service.edit(actor, params.projectId, suggestionId(params), command);
    }),
    withdraw: handler("POST", async (actor, request, params) => {
      const input = await body(request, ["expectedRevision", "idempotencyKey"]);
      const command: SuggestionActionCommand = { expectedRevision: input.expectedRevision as number, idempotencyKey: key(request, input) };
      return deps.service.withdraw(actor, params.projectId, suggestionId(params), command);
    }),
    adopt: handler("POST", async (actor, request, params) => {
      const input = await body(request, ["expectedRevision", "idempotencyKey"]);
      const command: SuggestionActionCommand = { expectedRevision: input.expectedRevision as number, idempotencyKey: key(request, input) };
      return deps.service.adopt(actor, params.projectId, suggestionId(params), command);
    }),
  };
}
