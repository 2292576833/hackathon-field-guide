import type { IdGenerator } from "../../shared/contracts.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { EventRegistrationService } from "./service.ts";
import type { SaveFormInput, SaveDraftInput, MutationInput, ReviewRegistrationInput, CreateTeamInput, JoinTeamInput, RespondJoinInput, LeaveTeamInput, RequestProjectLinkInput, ConfirmProjectLinkInput, ProposeTeamInput, ReopenRosterInput } from "./model.ts";
import { identifier } from "./validation.ts";

export interface EventRegistrationRouteParams { eventId?: string; registrationId?: string; teamId?: string; requestId?: string }
export interface EventRegistrationHttpDependencies {
  service: EventRegistrationService;
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  /** Root verifies cookie same-origin/CSRF before any mutation. */
  authorizeMutation(request: Request): Promise<void>;
  requestIds: IdGenerator; maxJsonBytes?: number;
}
export type EventRegistrationHttpHandler = (request: Request, params?: EventRegistrationRouteParams) => Promise<Response>;
function param(params: EventRegistrationRouteParams, key: keyof EventRegistrationRouteParams): string { const value = params[key]; identifier(value, key); return value; }
async function json(request: Request, allowed: readonly string[], maximum: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")) throw new DomainError("JSON_REQUIRED", "请提交未压缩的JSON表单资料。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) throw new DomainError("INVALID_JSON", "请提供表单资料。", { status: 400 });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength;
      if (bytes > maximum) { void reader.cancel().catch(() => {}); throw new DomainError("PAYLOAD_TOO_LARGE", "表单资料过长，请精简后重试。", { status: 413 }); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new DomainError("INVALID_JSON", "表单资料格式无法读取，请重新填写。", { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new DomainError("INVALID_INPUT", "表单包含不支持的字段。", { status: 400 });
  return value as Record<string, unknown>;
}
function key(request: Request, input: Record<string, unknown>) {
  const header = request.headers.get("Idempotency-Key");
  if (header && input.idempotencyKey !== undefined && header !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_CONFLICT", "请求头与表单的操作标识不一致。", { status: 409 });
  const result = header ?? input.idempotencyKey; identifier(result, "操作标识"); return result;
}
function pagination(request: Request) {
  const search = new URL(request.url).searchParams;
  return { ...(search.has("limit") ? { limit: Number(search.get("limit")) } : {}), ...(search.get("cursor") ? { cursor: search.get("cursor")! } : {}), ...(search.get("status") ? { status: search.get("status")! } : {}) };
}

/** Fixed method factories; root mounts routes and supplies trusted principal + CSRF. */
export function createEventRegistrationHandlers(deps: EventRegistrationHttpDependencies) {
  const maximum = deps.maxJsonBytes ?? 131072;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 131072) throw new Error("Invalid registration HTTP body limit.");
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
  const handler = (method: string, work: (principal: OrganizerPrincipal, request: Request, params: EventRegistrationRouteParams) => Promise<unknown>, publicRead = false): EventRegistrationHttpHandler => async (request, params = {}) => {
    let requestId = "unavailable";
    try {
      requestId = deps.requestIds.next();
      if (request.method !== method) return Response.json(toErrorEnvelope(new DomainError("METHOD_NOT_ALLOWED", "当前入口不支持此操作。", { status: 405 }), requestId), { status: 405, headers: { ...headers, Allow: method } });
      if (method !== "GET") await deps.authorizeMutation(request);
      const principal = publicRead ? null : await deps.resolvePrincipal(request);
      if (!publicRead && (!principal || typeof principal.guard !== "function")) throw new DomainError("UNAUTHENTICATED", "请登录后继续报名或查看自己的比赛。", { status: 401, recoveryAction: "login" });
      const data = await work(principal!, request, params); return Response.json({ data, requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  async function command(request: Request, allowed: string[]) { const input = await json(request, [...allowed, "idempotencyKey"], maximum); return { ...input, idempotencyKey: key(request, input) }; }
  return {
    getRegistrationForm: handler("GET", (_principal, _request, params) => deps.service.getRegistrationForm(param(params, "eventId")), true),
    getStaffForm: handler("GET", (principal, _request, params) => deps.service.getStaffForm(principal, param(params, "eventId"))),
    saveForm: handler("PUT", async (principal, request, params) => deps.service.saveForm(principal, param(params, "eventId"), await json(request, ["expectedRevision", "title", "description", "fields", "changeNote"], maximum) as unknown as SaveFormInput)),
    getMine: handler("GET", (principal, _request, params) => deps.service.getMine(principal, param(params, "eventId"))),
    saveDraft: handler("PATCH", async (principal, request, params) => deps.service.saveDraft(principal, param(params, "eventId"), await json(request, ["expectedRevision", "formRevision", "answers"], maximum) as unknown as SaveDraftInput)),
    submit: handler("POST", async (principal, request, params) => deps.service.submit(principal, param(params, "eventId"), await command(request, ["expectedRevision"]) as unknown as MutationInput)),
    withdraw: handler("POST", async (principal, request, params) => deps.service.withdraw(principal, param(params, "eventId"), await command(request, ["expectedRevision"]) as unknown as MutationInput)),
    listStaff: handler("GET", (principal, request, params) => deps.service.listStaff(principal, param(params, "eventId"), pagination(request))),
    review: handler("POST", async (principal, request, params) => deps.service.review(principal, param(params, "eventId"), param(params, "registrationId"), await command(request, ["expectedRevision", "decision", "note"]) as unknown as ReviewRegistrationInput)),
    /** 报名状态精确计数：只读，供主办方工作台显示"待审核 N 条"，避免用第一页冒充总数。 */
    registrationCounts: handler("GET", (principal, _request, params) => deps.service.registrationCounts(principal, param(params, "eventId"))),
    exportRegistrations: handler("GET", (principal, _request, params) => deps.service.exportRegistrations(principal, param(params, "eventId"))),
    listTeams: handler("GET", (principal, request, params) => deps.service.listTeams(principal, param(params, "eventId"), pagination(request))),
    listPublicTeams: handler("GET", (_principal, request, params) => deps.service.listPublicTeams(param(params, "eventId"), pagination(request)), true),
    listStaffTeams: handler("GET", (principal, request, params) => deps.service.listStaffTeams(principal, param(params, "eventId"), pagination(request))),
    getStaffCandidates: handler("GET", (principal, request, params) => deps.service.getStaffCandidates(principal, param(params, "eventId"), pagination(request))),
    listTeamSuggestions: handler("GET", (principal, _request, params) => deps.service.listTeamSuggestions(principal, param(params, "eventId"))),
    proposeTeam: handler("POST", async (principal, request, params) => deps.service.proposeTeam(principal, param(params, "eventId"), await command(request, ["captainUserId", "memberUserIds", "name", "track", "note"]) as unknown as ProposeTeamInput)),
    createTeam: handler("POST", async (principal, request, params) => deps.service.createTeam(principal, param(params, "eventId"), await command(request, ["name", "introduction", "track", "suggestionId"]) as unknown as CreateTeamInput)),
    requestJoin: handler("POST", async (principal, request, params) => deps.service.requestJoin(principal, param(params, "eventId"), param(params, "teamId"), await command(request, ["expectedTeamRevision", "message"]) as unknown as JoinTeamInput)),
    respondJoin: handler("POST", async (principal, request, params) => deps.service.respondJoin(principal, param(params, "eventId"), param(params, "teamId"), param(params, "requestId"), await command(request, ["expectedRevision", "expectedTeamRevision", "decision", "note"]) as unknown as RespondJoinInput)),
    cancelJoin: handler("POST", async (principal, request, params) => deps.service.cancelJoin(principal, param(params, "eventId"), param(params, "teamId"), param(params, "requestId"), await command(request, ["expectedRevision"]) as unknown as MutationInput)),
    leaveTeam: handler("POST", async (principal, request, params) => deps.service.leaveTeam(principal, param(params, "eventId"), param(params, "teamId"), await command(request, ["expectedRevision", "successorUserId"]) as unknown as LeaveTeamInput)),
    lockRoster: handler("POST", async (principal, request, params) => deps.service.lockRoster(principal, param(params, "eventId"), param(params, "teamId"), await command(request, ["expectedRevision"]) as unknown as MutationInput)),
    reopenRoster: handler("POST", async (principal, request, params) => deps.service.reopenRoster(principal, param(params, "eventId"), param(params, "teamId"), await command(request, ["expectedRevision", "note"]) as unknown as ReopenRosterInput)),
    requestProjectLink: handler("POST", async (principal, request, params) => deps.service.requestProjectLink(principal, param(params, "eventId"), param(params, "teamId"), await command(request, ["expectedRevision", "projectId"]) as unknown as RequestProjectLinkInput)),
    getProjectLink: handler("GET", (principal, _request, params) => deps.service.getProjectLink(principal, param(params, "eventId"), param(params, "teamId"))),
    confirmProjectLink: handler("POST", async (principal, request, params) => deps.service.confirmProjectLink(principal, param(params, "eventId"), param(params, "teamId"), param(params, "requestId"), await command(request, ["expectedRevision", "expectedProjectRevision", "expectedTeamRevision"]) as unknown as ConfirmProjectLinkInput)),
    listMine: handler("GET", (principal, request) => deps.service.listMine(principal, pagination(request))),
  };
}
export type EventRegistrationHandlers = ReturnType<typeof createEventRegistrationHandlers>;
