import { randomUUID } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { RecruitingListFilter } from "./model.ts";
import type { RecruitingService } from "./service.ts";

export type RecruitingHttpRoute =
  | { kind: "profile" | "summary" | "ownAvatar" | "publishCard" | "withdrawCard" | "cards" | "posts" | "ownApplications" }
  | { kind: "publicAvatar"; cardId: string }
  | { kind: "projectPost" | "projectApplications"; projectId: string }
  | { kind: "apply"; postId: string }
  | { kind: "review" | "withdrawApplication" | "join"; applicationId: string };
export interface RecruitingHttpDependencies {
  service: RecruitingService;
  /** Root resolves verified cookie identity and creates a guard for this exact request session. */
  resolveSession(request: Request): Promise<{ actor: Actor; guard: FreshSessionGuard } | null>;
  authorizeMutation(request: Request): Promise<void>;
  requestId?(): string;
}
const methods: Record<RecruitingHttpRoute["kind"], readonly string[]> = { profile: ["GET", "PATCH"], summary: ["POST"], ownAvatar: ["GET", "POST", "DELETE"], publishCard: ["POST"], withdrawCard: ["POST"], cards: ["GET"], posts: ["GET"], ownApplications: ["GET"], publicAvatar: ["GET"], projectPost: ["GET", "POST", "PATCH"], projectApplications: ["GET"], apply: ["POST"], review: ["POST"], withdrawApplication: ["POST"], join: ["POST"] };
async function jsonBody(request: Request, maximum: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("JSON_REQUIRED", "请发送JSON格式的请求。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) throw new DomainError("INVALID_JSON", "请求内容不能为空。", { status: 400 });
  const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > maximum) { void reader.cancel().catch(() => {}); throw new DomainError("REQUEST_TOO_LARGE", "内容超过大小限制，请缩减后重试。", { status: 413 }); } chunks.push(chunk.value); }
    const bytes = new Uint8Array(total); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) { if (isDomainError(error)) throw error; throw new DomainError("INVALID_JSON", "请求内容不是有效的JSON。", { status: 400 }); }
  finally { reader.releaseLock(); }
}
function filter(request: Request): RecruitingListFilter {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !["role", "purpose", "keyword", "cursor", "limit"].includes(key))) throw new DomainError("INVALID_RECRUITING_INPUT", "筛选字段无效。", { status: 400 });
  return { ...(params.has("role") ? { role: params.get("role") as RecruitingListFilter["role"] } : {}), ...(params.has("purpose") ? { purpose: params.get("purpose") as RecruitingListFilter["purpose"] } : {}), ...(params.has("keyword") ? { keyword: params.get("keyword")! } : {}), ...(params.has("cursor") ? { cursor: params.get("cursor")! } : {}), ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}) };
}
function avatarResponse(content: { bytes: Uint8Array; mimeType: string }, headers: Record<string, string>): Response {
  return new Response(new Uint8Array(content.bytes), { headers: { ...headers, "Content-Type": content.mimeType, "Content-Length": String(content.bytes.byteLength), "Content-Security-Policy": "default-src 'none'; sandbox" } });
}
/** Routes remain root-owned; all mutations are CSRF-checked and every private operation receives a fresh session guard. */
export function createRecruitingHttpHandlers(deps: RecruitingHttpDependencies) {
  return { async handle(request: Request, route: RecruitingHttpRoute): Promise<Response> {
    const requestId = deps.requestId?.() ?? randomUUID(), headers: Record<string, string> = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    try {
      if (!methods[route.kind].includes(request.method)) { headers.Allow = methods[route.kind].join(", "); throw new DomainError("METHOD_NOT_ALLOWED", "此接口不支持该方法。", { status: 405 }); }
      const service = deps.service;
      if (route.kind === "cards" || route.kind === "posts") { const data = route.kind === "cards" ? await service.listCards(filter(request)) : await service.listPosts(filter(request)); return Response.json({ data, requestId }, { headers }); }
      if (route.kind === "publicAvatar") { const params = new URL(request.url).searchParams; if ([...params.keys()].some(key => key !== "revision")) throw new DomainError("INVALID_RECRUITING_INPUT", "头像版本无效。", { status: 400 }); return avatarResponse(await service.getPublicAvatar(route.cardId, params.has("revision") ? Number(params.get("revision")) : undefined), headers); }
      const session = await deps.resolveSession(request); if (!session) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 }); const { actor, guard } = session;
      if (request.method !== "GET") await deps.authorizeMutation(request);
      if (route.kind === "ownAvatar" && request.method === "GET") return avatarResponse(await service.getOwnAvatar(actor, guard), headers);
      const body = request.method === "GET" ? undefined : await jsonBody(request, route.kind === "ownAvatar" ? 720 * 1024 : 64 * 1024);
      let data: unknown;
      switch (route.kind) {
        case "profile": data = request.method === "GET" ? await service.getProfile(actor, guard) : await service.saveProfile(actor, body, guard); break;
        case "summary": data = await service.generateSummary(actor, body, guard); break;
        case "ownAvatar": data = request.method === "DELETE" ? await service.removeAvatar(actor, body, guard) : await service.saveAvatar(actor, body, guard); break;
        case "publishCard": data = await service.publishCard(actor, body, guard); break;
        case "withdrawCard": data = await service.withdrawCard(actor, body, guard); break;
        case "ownApplications": data = await service.listOwnApplications(actor, guard); break;
        case "projectPost": data = request.method === "GET" ? await service.getPost(actor, route.projectId, guard) : await service.savePost(actor, route.projectId, body, guard); break;
        case "projectApplications": data = await service.listProjectApplications(actor, route.projectId, guard); break;
        case "apply": data = await service.apply(actor, route.postId, body, guard); break;
        case "review": data = await service.reviewApplication(actor, route.applicationId, body, guard); break;
        case "withdrawApplication": data = await service.withdrawApplication(actor, route.applicationId, body, guard); break;
        case "join": data = await service.joinApproved(actor, route.applicationId, body, guard); break;
      }
      return Response.json({ data, requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  } };
}

/** Optional root router helper. Accept the path after /api/v1; no route file is created here. */
export function recruitingHttpRoute(path: readonly string[]): RecruitingHttpRoute | null {
  const joined = path.join("/");
  const fixed: Record<string, RecruitingHttpRoute> = { "me/recruiting-profile": { kind: "profile" }, "me/recruiting-profile/summary": { kind: "summary" }, "me/recruiting-profile/avatar": { kind: "ownAvatar" }, "me/recruiting-card/publish": { kind: "publishCard" }, "me/recruiting-card/withdraw": { kind: "withdrawCard" }, "recruiting/cards": { kind: "cards" }, "recruiting/posts": { kind: "posts" }, "me/recruiting-applications": { kind: "ownApplications" } };
  if (Object.hasOwn(fixed, joined)) return fixed[joined];
  if (path.length === 4 && path[0] === "recruiting" && path[1] === "cards" && path[3] === "avatar") return { kind: "publicAvatar", cardId: path[2] };
  if (path.length === 3 && path[0] === "projects" && path[2] === "recruiting-post") return { kind: "projectPost", projectId: path[1] };
  if (path.length === 3 && path[0] === "projects" && path[2] === "recruiting-applications") return { kind: "projectApplications", projectId: path[1] };
  if (path.length === 4 && path[0] === "recruiting" && path[1] === "posts" && path[3] === "applications") return { kind: "apply", postId: path[2] };
  if (path.length === 4 && path[0] === "recruiting" && path[1] === "applications") { if (path[3] === "review") return { kind: "review", applicationId: path[2] }; if (path[3] === "withdraw") return { kind: "withdrawApplication", applicationId: path[2] }; if (path[3] === "join") return { kind: "join", applicationId: path[2] }; }
  return null;
}
