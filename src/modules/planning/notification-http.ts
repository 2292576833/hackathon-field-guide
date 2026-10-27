import type { Actor } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { PlanningNotificationHttpDependencies } from "./notification-types.ts";

async function command(request: Request): Promise<{ expectedRevision: number }> {
  const value = await request.text();
  if (new TextEncoder().encode(value).byteLength > 4096) throw new DomainError("PAYLOAD_TOO_LARGE", "提醒请求过大。", { status: 413 });
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new DomainError("INVALID_JSON", "请提供有效的提醒状态。", { status: 400 }); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== "expectedRevision") || !Number.isSafeInteger((parsed as { expectedRevision?: number }).expectedRevision) || ((parsed as { expectedRevision: number }).expectedRevision < 1)) throw new DomainError("INVALID_INPUT", "请提供提醒版本，不要传入用户或项目身份。");
  return parsed as { expectedRevision: number };
}
export function createPlanningNotificationHandlers(dependencies: PlanningNotificationHttpDependencies) {
  const handler = (method: string, work: (actor: Actor, request: Request, id?: string) => Promise<unknown>) => async (request: Request, id?: string): Promise<Response> => {
    const requestId = dependencies.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该提醒入口不支持此请求方法。", { status: 405 });
      const actor = await dependencies.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后查看自己的提醒。", { status: 401, recoveryAction: "login" });
      if (method !== "GET") await dependencies.authorizeMutation(request);
      const data = await work(actor, request, id);
      return Response.json({ data, requestId }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { "Cache-Control": "private, no-store" } }); }
  };
  const identifier = (id?: string) => { if (!id?.trim()) throw new DomainError("INVALID_ROUTE", "缺少提醒编号。", { status: 400 }); return id; };
  return {
    listOwn: handler("GET", (actor, request) => { const query = new URL(request.url).searchParams; const raw = query.get("limit"); const projectId = query.get("projectId"); return dependencies.service.listOwn(actor, { ...(raw === null ? {} : { limit: Number(raw) }), ...(projectId === null ? {} : { projectId }) }); }),
    markRead: handler("POST", async (actor, request, id) => dependencies.service.markRead(actor, identifier(id), await command(request))),
    dismissResolved: handler("POST", async (actor, request, id) => dependencies.service.dismissResolved(actor, identifier(id), await command(request))),
  };
}
