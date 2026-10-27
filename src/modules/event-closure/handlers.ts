import type { IdGenerator } from "../../shared/contracts.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { EventClosureService } from "./service.ts";
import type { ContactWillingnessInput, ContactWillingnessWithdrawInput } from "./model.ts";

/**
 * 赛后闭环 HTTP 工厂。与既有模块同形：私有 no-store、JSON 最多 64KB、GET 只读、
 * 写请求由 root 做 Origin/CSRF 授权。这里不新增公开面。
 */
export interface EventClosureHttpDependencies {
  service: EventClosureService;
  /** Root resolves a real account/session and its transaction-aware guard. */
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  authorizeMutation(request: Request, principal: OrganizerPrincipal): Promise<void>;
  requestIds: IdGenerator;
}
export interface EventClosureRouteParams { eventId: string; willingnessId?: string }

export function createEventClosureHandlers(deps: EventClosureHttpDependencies) {
  const handler = (method: string, work: (principal: OrganizerPrincipal, request: Request, params: EventClosureRouteParams) => Promise<unknown>) => async (request: Request, params: EventClosureRouteParams): Promise<Response> => {
    const requestId = deps.requestIds.next(); const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
      routeId(params?.eventId, "赛事");
      const principal = await deps.resolvePrincipal(request);
      if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
      if (method !== "GET") await deps.authorizeMutation(request, principal);
      return Response.json({ data: await work(principal, request, params), requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  return {
    /** 主办方侧赛后闭环：只读派生，只列已公布/已批准内容与既有记录。 */
    postEventSummary: handler("GET", (p, _r, a) => deps.service.postEventSummary(p, a.eventId)),
    /** 主办方侧联系意愿：只显示主动选择愿意的队伍。 */
    eventContactWillingness: handler("GET", (p, _r, a) => deps.service.eventContactWillingness(p, a.eventId)),
    /** 队伍侧：本队自己的选择与历史；指回既有赛后清单与复盘入口。 */
    myContactWillingness: handler("GET", (p, r, a) => deps.service.myContactWillingness(p, a.eventId, routeId(new URL(r.url).searchParams.get("teamId"), "队伍"))),
    myWillingnessEligibility: handler("GET", (p, r, a) => deps.service.myWillingnessEligibility(p, a.eventId, routeId(new URL(r.url).searchParams.get("teamId"), "队伍"))),
    /** 提交/重新提交本队的选择；支持 Idempotency-Key 头，与正文不一致时拒绝。 */
    submitContactWillingness: handler("POST", async (p, r, a) => {
      const input = await body(r); const headerKey = r.headers.get("idempotency-key");
      if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_MISMATCH", "请求重试标识不一致，请重新核对选择。", { status: 400 });
      return deps.service.submitContactWillingness(p, a.eventId, { ...input, idempotencyKey: headerKey ?? input.idempotencyKey } as unknown as ContactWillingnessInput);
    }),
    /** 撤回本队的选择；只有提交人本人可以撤回。 */
    withdrawContactWillingness: handler("POST", async (p, r, a) => deps.service.withdrawContactWillingness(p, a.eventId, routeId(a.willingnessId, "联系意愿"), await body(r) as unknown as ContactWillingnessWithdrawInput)),
  };
}
function routeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new DomainError("INVALID_ROUTE", `缺少有效的${label}地址。`, { status: 400 });
  return value;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || (request.headers.get("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")) throw new DomainError("JSON_REQUIRED", "请提交未压缩的JSON内容。", { status: 415 });
  const max = 65536, length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > max) throw new DomainError("PAYLOAD_TOO_LARGE", "输入超过64KB，请缩短后继续。", { status: 413 });
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new DomainError("PAYLOAD_TOO_LARGE", "输入超过64KB，请缩短后继续。", { status: 413 }); } chunks.push(chunk.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DomainError("INVALID_JSON", "请提交有效JSON内容。", { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("CLOSURE_INVALID_INPUT", "输入内容格式不正确。");
  return value as Record<string, unknown>;
}
