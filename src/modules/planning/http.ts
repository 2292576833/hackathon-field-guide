import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import { parseAcceptanceCorrectionCommand, parseAcceptanceCorrectionRequestCommand, parseApplyCommand, parseDraftCommand, parseEditDraftCommand, parseProgressCommand } from "./parse.ts";
import type { PlanningService } from "./service.ts";
import { parseRestorePlanCommand } from "./restore-command.ts";

export interface PlanningHttpDependencies {
  service: PlanningService;
  /** Resolve a verified M01 session. JSON userId/roles are rejected by parsers. */
  resolveActor(request: Request): Promise<Actor | null>;
  requestIds: IdGenerator;
  /** Router must enforce same-origin/CSRF policy for cookie-authenticated mutations. */
  authorizeMutation(request: Request): Promise<void>;
}
export interface PlanningRouteParams { projectId: string; planId?: string; taskId?: string }
async function body(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > 1_000_000) throw new DomainError("PAYLOAD_TOO_LARGE", "请求内容过大。", { status: 413 });
  const value = await request.text();
  if (new TextEncoder().encode(value).length > 1_000_000) throw new DomainError("PAYLOAD_TOO_LARGE", "请求内容过大。", { status: 413 });
  try { return JSON.parse(value); } catch { throw new DomainError("INVALID_JSON", "请求需要有效 JSON。", { status: 400 }); }
}
function parameter(value: string | undefined): string {
  if (!value) throw new DomainError("INVALID_ROUTE", "缺少路由标识。", { status: 400 });
  return value;
}

export function createPlanningHandlers(dependencies: PlanningHttpDependencies) {
  const handler = (method: string, work: (actor: Actor, request: Request, params: PlanningRouteParams) => Promise<unknown>, status = 200) => async (request: Request, params: PlanningRouteParams): Promise<Response> => {
    const requestId = dependencies.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
      const actor = await dependencies.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401, recoveryAction: "login" });
      if (method !== "GET") await dependencies.authorizeMutation(request);
      const data = await work(actor, request, params);
      return Response.json({ data, requestId }, { status, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } });
    }
  };
  return {
    getCurrent: handler("GET", (actor, _request, params) => dependencies.service.getCurrent(actor, params.projectId)),
    listHistory: handler("GET", (actor, _request, params) => dependencies.service.listHistory(actor, params.projectId)),
    listProgress: handler("GET", (actor, _request, params) => dependencies.service.listProgress(actor, params.projectId)),
    getDiff: handler("GET", (actor, _request, params) => dependencies.service.getDiff(actor, params.projectId, parameter(params.planId))),
    createDraft: handler("POST", async (actor, request, params) => dependencies.service.createDraft(actor, params.projectId, parseDraftCommand(await body(request))), 201),
    editDraft: handler("PATCH", async (actor, request, params) => dependencies.service.editDraft(actor, params.projectId, parameter(params.planId), parseEditDraftCommand(await body(request)))),
    apply: handler("POST", async (actor, request, params) => dependencies.service.apply(actor, params.projectId, parameter(params.planId), parseApplyCommand(await body(request)))),
    restoreAsDraft: handler("POST", async (actor, request, params) => dependencies.service.restoreAsDraft(actor, params.projectId, parameter(params.planId), parseRestorePlanCommand(await body(request))), 201),
    updateProgress: handler("POST", async (actor, request, params) => dependencies.service.updateProgress(actor, params.projectId, parameter(params.taskId), parseProgressCommand(await body(request))), 201),
    correctAcceptance: handler("POST", async (actor, request, params) => dependencies.service.correctAcceptance(actor, params.projectId, parameter(params.taskId), parseAcceptanceCorrectionCommand(await body(request))), 201),
    requestAcceptanceCorrection: handler("POST", async (actor, request, params) => dependencies.service.requestAcceptanceCorrection(actor, params.projectId, parameter(params.taskId), parseAcceptanceCorrectionRequestCommand(await body(request))), 201),
  };
}
