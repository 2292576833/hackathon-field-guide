import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import { parsePlanningGenerationCommand } from "./generation.ts";
import type { PlanningGenerationService } from "./generation.ts";

export interface PlanningGenerationHttpDependencies {
  service: PlanningGenerationService;
  resolveActor(request: Request): Promise<Actor | null>;
  authorizeMutation(request: Request): Promise<void>;
  requestIds: IdGenerator;
}
export interface PlanningGenerationRouteParams { projectId: string; jobId?: string }
async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 50_000) throw new DomainError("PAYLOAD_TOO_LARGE", "生成请求过大。", { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 50_000) throw new DomainError("PAYLOAD_TOO_LARGE", "生成请求过大。", { status: 413 });
  try { return JSON.parse(text); } catch { throw new DomainError("INVALID_JSON", "需要有效JSON。", { status: 400 }); }
}
function jobId(params: PlanningGenerationRouteParams): string { if (!params.jobId) throw new DomainError("INVALID_ROUTE", "缺少生成任务标识。", { status: 400 }); return params.jobId; }
function revision(raw: unknown): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "expectedRevision") || !Number.isSafeInteger((raw as Record<string, unknown>).expectedRevision) || ((raw as Record<string, unknown>).expectedRevision as number) < 0) throw new DomainError("INVALID_INPUT", "只接收有效预期修订号。", { status: 400 });
  return (raw as { expectedRevision: number }).expectedRevision;
}
export function createPlanningGenerationHandlers(dependencies: PlanningGenerationHttpDependencies) {
  const handler = (method: string, work: (actor: Actor, request: Request, params: PlanningGenerationRouteParams) => Promise<unknown>, status = 200) => async (request: Request, params: PlanningGenerationRouteParams): Promise<Response> => {
    const requestId = dependencies.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
      const actor = await dependencies.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401, recoveryAction: "login" });
      if (method !== "GET") await dependencies.authorizeMutation(request);
      return Response.json({ data: await work(actor, request, params), requestId }, { status, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } }); }
  };
  return {
    queueGeneration: handler("POST", async (actor, request, params) => dependencies.service.queueGeneration(actor, params.projectId, parsePlanningGenerationCommand(await body(request))), 202),
    listGenerationJobs: handler("GET", (actor, _request, params) => dependencies.service.listGenerationJobs(actor, params.projectId)),
    getGenerationJob: handler("GET", (actor, _request, params) => dependencies.service.getGenerationJob(actor, params.projectId, jobId(params))),
    retryGeneration: handler("POST", async (actor, request, params) => dependencies.service.retryGeneration(actor, params.projectId, jobId(params), revision(await body(request)))),
    cancelGeneration: handler("POST", async (actor, request, params) => dependencies.service.cancelGeneration(actor, params.projectId, jobId(params), revision(await body(request)))),
  };
}
