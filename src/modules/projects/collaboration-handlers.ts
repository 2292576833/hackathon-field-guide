import { randomUUID } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { MemberIntentionInput, ProjectCollaborationService, TrackSelectionInput } from "./collaboration.ts";

export interface ProjectCollaborationHttpRoute { kind: "officialTracks" | "trackSelection" | "myIntention" | "sharedIntentions"; projectId: string }
export interface ProjectCollaborationHttpDependencies {
  service: ProjectCollaborationService;
  resolveActor(request: Request): Promise<Actor | null>;
  authorizeMutation(request: Request): Promise<void>;
  /** Root must recheck current session/account under the same ambient DB transaction. */
  requestId?: () => string;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("INVALID_CONTENT_TYPE", "请使用 JSON 请求。", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("INVALID_JSON", "请求内容不能为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 16 * 1024) { void reader.cancel().catch(() => {}); throw new DomainError("REQUEST_TOO_LARGE", "意愿资料超过长度限制。", { status: 413 }); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as Record<string, unknown>;
  } catch (error) { if (isDomainError(error)) throw error; throw new DomainError("INVALID_JSON", "JSON 请求内容无效。"); }
  finally { reader.releaseLock(); }
}
/** Root owns URLs. GET is strictly read-only and never initiates AI work. */
export function createProjectCollaborationHandlers(dependencies: ProjectCollaborationHttpDependencies) {
  return {
    async handle(request: Request, route: ProjectCollaborationHttpRoute): Promise<Response> {
      const requestId = dependencies.requestId?.() ?? randomUUID();
      const headers: Record<string, string> = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
      try {
        const methods = route.kind === "trackSelection" ? ["PUT"] : route.kind === "myIntention" ? ["GET", "PUT"] : ["GET"];
        if (!methods.includes(request.method)) { headers.Allow = methods.join(", "); throw new DomainError("METHOD_NOT_ALLOWED", "此接口不支持该请求方法。", { status: 405 }); }
        const actor = await dependencies.resolveActor(request);
        if (!actor) throw new DomainError("AUTH_REQUIRED", "请登录后继续。", { status: 401 });
        if (request.method !== "GET") await dependencies.authorizeMutation(request);
        const service = dependencies.service;
        let data: unknown;
        switch (route.kind) {
          case "officialTracks": data = await service.getOfficialTracks(actor, route.projectId); break;
          case "trackSelection": data = await service.selectTrack(actor, route.projectId, await body(request) as unknown as TrackSelectionInput); break;
          case "myIntention": data = request.method === "GET" ? await service.getMyIntention(actor, route.projectId) : await service.updateMyIntention(actor, route.projectId, await body(request) as unknown as MemberIntentionInput); break;
          case "sharedIntentions": data = await service.getSharedIntentions(actor, route.projectId); break;
        }
        return Response.json({ data, requestId }, { headers });
      } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
    },
  };
}
