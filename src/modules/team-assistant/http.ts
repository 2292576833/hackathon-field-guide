import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { AssistantMessageInput, FeasibilityReportInput } from "./model.ts";
import type { TeamAssistantService } from "./service.ts";

export interface TeamAssistantHttpDependencies {
  service: TeamAssistantService;
  resolveActor(request: Request): Promise<Actor | null>;
  authorizeMutation(request: Request, actor: Actor): Promise<void>;
  /** Must come from the actual authenticated request session. */
  freshSessionGuard(request: Request, actor: Actor): FreshSessionGuard;
  requestIds: IdGenerator;
}
export interface TeamAssistantRouteParams { projectId: string }
export function createTeamAssistantHandlers(deps: TeamAssistantHttpDependencies) {
  const handler = (method: string, work: (actor: Actor, request: Request, projectId: string, guard: FreshSessionGuard) => Promise<unknown>, status = 200) => async (request: Request, params: TeamAssistantRouteParams): Promise<Response> => {
    const requestId = deps.requestIds.next(), headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
      const actor = await deps.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录后使用本空间的私人助手。", { status: 401, recoveryAction: "login" });
      if (!params?.projectId) throw new DomainError("INVALID_ROUTE", "缺少空间地址。", { status: 400 });
      if (method !== "GET") await deps.authorizeMutation(request, actor);
      const guard = deps.freshSessionGuard(request, actor);
      return Response.json({ data: await work(actor, request, params.projectId, guard), requestId }, { status, headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  return {
    conversation: handler("GET", (actor, _req, projectId, guard) => deps.service.conversation(actor, projectId, guard)),
    clearConversation: handler("DELETE", async (actor, req, projectId, guard) => { const input = await body(req); return deps.service.clearConversation(actor, projectId, input.expectedRevision as number, guard); }),
    send: handler("POST", async (actor, req, projectId, guard) => deps.service.send(actor, projectId, await body(req) as unknown as AssistantMessageInput, guard)),
    context: handler("GET", (actor, _req, projectId, guard) => deps.service.getContext(actor, projectId, guard)),
    generateFeasibility: handler("POST", async (actor, req, projectId, guard) => deps.service.generateFeasibility(actor, projectId, await body(req) as unknown as FeasibilityReportInput, guard), 201),
    listFeasibility: handler("GET", (actor, _req, projectId, guard) => deps.service.listFeasibility(actor, projectId, guard)),
  };
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || request.headers.get("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")
    throw new DomainError("JSON_REQUIRED", "请提交未压缩的 JSON 内容。", { status: 415 });
  const limit = 28000, length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) throw new DomainError("PAYLOAD_TOO_LARGE", "输入内容过长，请缩短后继续。", { status: 413 });
  const chunks: Uint8Array[] = []; let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) { void reader.cancel().catch(() => {}); throw new DomainError("PAYLOAD_TOO_LARGE", "输入内容过长，请缩短后继续。", { status: 413 }); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new DomainError("INVALID_JSON", "请提交有效的 JSON 内容。", { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("ASSISTANT_INVALID_INPUT", "请输入有效内容。", { status: 422 });
  return value as Record<string, unknown>;
}
