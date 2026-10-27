import { randomUUID } from "node:crypto";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { EventOfficialLinksService } from "./model.ts";
import * as v from "./validation.ts";

export interface EventOfficialLinksHttpRoute { readonly kind: "link" | "candidates" | "history"; readonly hostedEventId: string }
export interface EventOfficialLinksHttpDependencies {
  readonly service: EventOfficialLinksService;
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  /** Root rejects untrusted or absent Origin/CSRF before parsing mutation JSON. */
  authorizeMutation(request: Request): Promise<void>;
  requestId?(): string;
}
const methods = { link: ["GET", "PUT", "DELETE"], candidates: ["GET"], history: ["GET"] } as const;
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("JSON_REQUIRED", "请发送JSON请求。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) v.invalid("请求内容不能为空。", 400);
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength; if (total > 16 * 1024) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "核对备注过长，请缩短后重试。", { status: 413 }); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) v.invalid("请求必须是对象。", 400);
    return value as Record<string, unknown>;
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new DomainError("INVALID_JSON", "请求内容不是有效JSON。", { status: 400 });
  } finally { reader.releaseLock(); }
}
export function createEventOfficialLinksHttpHandlers(deps: EventOfficialLinksHttpDependencies) {
  return { async handle(request: Request, route: EventOfficialLinksHttpRoute): Promise<Response> {
    const requestId = deps.requestId?.() ?? randomUUID();
    const headers: Record<string, string> = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    try {
      const allowed: readonly string[] = methods[route.kind] ?? [];
      if (!allowed.includes(request.method)) { headers.Allow = allowed.join(", "); throw new DomainError("METHOD_NOT_ALLOWED", "此操作不支持该方法。", { status: 405 }); }
      const hostedEventId = v.id(route.hostedEventId), url = new URL(request.url);
      if ([...url.searchParams.keys()].some(key => route.kind !== "candidates" || key !== "query") || url.searchParams.getAll("query").length > 1) v.invalid("请求包含不支持的查询参数。", 400);
      const principal = await deps.resolvePrincipal(request);
      if (!principal) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
      if (request.method !== "GET") await deps.authorizeMutation(request);
      let data: unknown;
      if (route.kind === "candidates") data = await deps.service.listCandidates(principal, hostedEventId, url.searchParams.get("query") ?? "");
      else if (route.kind === "history") data = await deps.service.history(principal, hostedEventId);
      else if (request.method === "GET") data = await deps.service.get(principal, hostedEventId);
      else {
        const body = await readBody(request);
        data = request.method === "PUT" ? await deps.service.set(principal, hostedEventId, body) : await deps.service.withdraw(principal, hostedEventId, body);
      }
      return Response.json({ data, requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  } };
}
/** Root passes decoded segments after /api/v1. Exact shape and ID validation only. */
export function eventOfficialLinksHttpRoute(path: readonly string[]): EventOfficialLinksHttpRoute | null {
  if ((path.length !== 5 && path.length !== 6) || path[0] !== "admin" || path[1] !== "organizer" || path[2] !== "events" || path[4] !== "rule-link") return null;
  try { v.id(path[3]); } catch { return null; }
  if (path.length === 5) return { kind: "link", hostedEventId: path[3] };
  if (path[5] === "candidates" || path[5] === "history") return { kind: path[5], hostedEventId: path[3] };
  return null;
}
