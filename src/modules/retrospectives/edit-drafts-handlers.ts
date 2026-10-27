import type { Actor } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import { editDraftBodyLimit, editDraftDocumentId, RetrospectiveEditDraftService } from "./edit-drafts.ts";
import { identifier, object } from "./validation.ts";

export interface EditDraftHandlerDependencies {
  service: RetrospectiveEditDraftService;
  authenticate(request: Request): Promise<Actor | null>;
  requestId(): string;
}
export interface EditDraftRouteParams { projectId?: string; id?: string }
type Handler = (request: Request, params?: EditDraftRouteParams) => Promise<Response>;
const headers = { "cache-control": "private, no-store", "vary": "cookie", "x-content-type-options": "nosniff" };
async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > editDraftBodyLimit) throw new DomainError("BODY_TOO_LARGE", "草稿请求过长，请减少文字或引用。", { status: 413 });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("INVALID_INPUT", "请使用JSON请求。");
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("INVALID_INPUT", "请求内容不能为空。");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > editDraftBodyLimit) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "草稿请求过长，请减少文字或引用。", { status: 413 }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)); }
  catch { throw new DomainError("INVALID_INPUT", "JSON内容无效，请检查后重试。"); }
}
function query(request: Request, allowed: readonly string[]): URLSearchParams {
  const values = new URL(request.url).searchParams;
  if ([...values.keys()].some(key => !allowed.includes(key) || values.getAll(key).length !== 1)) throw new DomainError("INVALID_INPUT", "查询包含不支持或重复的字段。");
  return values;
}
function project(params: EditDraftRouteParams): string { return identifier(params.projectId); }
function id(params: EditDraftRouteParams): string { return identifier(params.id); }

/** Session identity only; all drafts stay private even with project share intent. */
export function createRetrospectiveEditDraftHandlers(dependencies: EditDraftHandlerDependencies) {
  const wrap = (method: string, action: (actor: Actor, request: Request, params: EditDraftRouteParams) => Promise<unknown>): Handler => async (request, params = {}) => {
    const requestId = dependencies.requestId();
    try {
      if (request.method !== method) return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "请求方式不支持。" }, requestId }, { status: 405, headers: { ...headers, allow: method } });
      const actor = await dependencies.authenticate(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401, recoveryAction: "sign_in" });
      return Response.json({ data: await action(actor, request, params), requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  return {
    get: wrap("GET", async (actor, request, params) => {
      const values = query(request, ["documentId"]);
      return dependencies.service.get(actor, project(params), values.has("documentId") ? editDraftDocumentId(values.get("documentId")) : null);
    }),
    save: wrap("PUT", async (actor, request, params) => {
      const values = query(request, ["documentId"]), input = object(await body(request), ["documentId", "baseDocumentRevision", "expectedRevision", "mutationId", "requestedScope", "draftContent"]);
      if (values.has("documentId") && editDraftDocumentId(values.get("documentId")) !== editDraftDocumentId(input.documentId)) throw new DomainError("INVALID_INPUT", "请求中的编辑对象与当前页面不一致。");
      return dependencies.service.save(actor, project(params), input);
    }),
    list: wrap("GET", async (actor, request) => {
      const values = query(request, ["projectId", "limit", "afterId"]);
      return dependencies.service.list(actor, { ...(values.has("projectId") ? { projectId: identifier(values.get("projectId")) } : {}), ...(values.has("limit") ? { limit: Number(values.get("limit")) } : {}), ...(values.has("afterId") ? { afterId: identifier(values.get("afterId")) } : {}) });
    }),
    getById: wrap("GET", async (actor, request, params) => { query(request, []); return dependencies.service.getById(actor, id(params)); }),
    delete: wrap("DELETE", async (actor, request, params) => {
      query(request, []);
      const input = object(await body(request), ["expectedRevision"]);
      await dependencies.service.delete(actor, id(params), input.expectedRevision);
      return { deleted: true };
    }),
    exportDraft: (async (request: Request, params: EditDraftRouteParams = {}) => {
      const requestId = dependencies.requestId();
      try {
        if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "请求方式不支持。" }, requestId }, { status: 405, headers: { ...headers, allow: "POST" } });
        const actor = await dependencies.authenticate(request);
        if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401, recoveryAction: "sign_in" });
        query(request, []);
        const input = object(await body(request), ["format"]);
        if (input.format !== "json" && input.format !== "markdown") throw new DomainError("INVALID_INPUT", "请选择JSON或Markdown格式。");
        const file = await dependencies.service.exportDraft(actor, id(params), input.format);
        return new Response(file.content, { headers: { ...headers, "content-type": file.mediaType, "content-disposition": `attachment; filename="${file.filename}"`, "x-request-id": requestId } });
      } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
    }) satisfies Handler,
  };
}
