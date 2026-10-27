import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import { RetrospectiveService } from "./service.ts";
import { object, revision } from "./validation.ts";
import type { PersonalRecordFilter } from "./service.ts";

export interface HandlerDependencies {
  service: RetrospectiveService;
  authenticate(request: Request): Promise<Actor | null>;
  requestId(): string;
}
/** Route adapters receive trusted URL params; identity is always read from the session. */
export interface RouteParams { id?: string; projectId?: string }
type Handler = (request: Request, params: RouteParams) => Promise<Response>;
async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > 100_000) throw new DomainError("BODY_TOO_LARGE", "内容过长，请减少文字或引用。", { status: 413 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DomainError("INVALID_INPUT", "请使用JSON请求。");
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("INVALID_INPUT", "请求内容不能为空。");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 100_000) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "内容过长，请减少文字或引用。", { status: 413 }); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { throw new DomainError("INVALID_INPUT", "JSON内容无效，请检查后重试。"); }
}
const headers = { "cache-control": "private, no-store", "vary": "cookie", "x-content-type-options": "nosniff" };
export function createRetrospectiveHandlers(dependencies: HandlerDependencies) {
  const wrap = (method: string, action: (actor: Actor, request: Request, params: RouteParams) => Promise<unknown>, status = 200): Handler => async (request, params) => {
    const requestId = dependencies.requestId();
    try {
      if (request.method !== method) return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "请求方式不支持。" }, requestId }, { status: 405, headers: { ...headers, allow: method } });
      const actor = await dependencies.authenticate(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401, recoveryAction: "sign_in" });
      const data = await action(actor, request, params);
      return Response.json({ data, requestId }, { status, headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers }); }
  };
  const id = (params: RouteParams) => { if (!params.id) throw new DomainError("INVALID_INPUT", "缺少记录标识。"); return params.id; };
  const project = (params: RouteParams) => { if (!params.projectId) throw new DomainError("INVALID_INPUT", "缺少项目标识。"); return params.projectId; };
  const expected = async (request: Request) => object(await readBody(request), ["expectedRevision"]).expectedRevision;
  const list = (kind: "retrospective" | "experience_card") => wrap("GET", async (actor, request, params) => {
    const query = new URL(request.url).searchParams;
    return dependencies.service.list(actor, { kind, projectId: params.projectId, ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}), ...(query.has("afterId") ? { afterId: query.get("afterId")! } : {}) });
  });
  const enqueueGeneration = wrap("POST", async (actor, request, params) => dependencies.service.enqueueGeneration(actor, id(params), await expected(request)), 202);
  const personalFilter = (request: Request, allowText = true): PersonalRecordFilter => {
    const query = new URL(request.url).searchParams;
    const allowed = allowText ? ["projectId", "query", "status", "limit", "afterId"] : ["projectId", "limit", "afterId"];
    if ([...query.keys()].some(key => !allowed.includes(key)) || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)) throw new DomainError("INVALID_INPUT", "筛选字段无效。");
    return { ...(query.has("projectId") ? { projectId: query.get("projectId")! } : {}), ...(query.has("query") ? { query: query.get("query")! } : {}), ...(query.has("status") ? { status: query.get("status")! } : {}), ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}), ...(query.has("afterId") ? { afterId: query.get("afterId")! } : {}) };
  };
  return {
    createRetrospective: wrap("POST", async (actor, request, params) => dependencies.service.createRetrospective(actor, project(params), await readBody(request)), 201),
    getRetrospective: wrap("GET", async (actor, _request, params) => dependencies.service.getRetrospective(actor, id(params))),
    updateRetrospective: wrap("PATCH", async (actor, request, params) => dependencies.service.updateRetrospective(actor, id(params), await readBody(request))),
    confirmRetrospective: wrap("POST", async (actor, request, params) => dependencies.service.confirmRetrospective(actor, id(params), await readBody(request))),
    listRetrospectives: list("retrospective"),
    createExperienceCard: wrap("POST", async (actor, request, params) => dependencies.service.createExperienceCard(actor, project(params), await readBody(request)), 201),
    getExperienceCard: wrap("GET", async (actor, _request, params) => dependencies.service.getExperienceCard(actor, id(params))),
    updateExperienceCard: wrap("PATCH", async (actor, request, params) => dependencies.service.updateExperienceCard(actor, id(params), await readBody(request))),
    confirmExperienceCard: wrap("POST", async (actor, request, params) => dependencies.service.confirmExperienceCard(actor, id(params), await expected(request))),
    listExperienceCards: list("experience_card"),
    listPersonalExperienceCards: wrap("GET", async (actor, request) => dependencies.service.listPersonalRecords(actor, "experience_card", personalFilter(request))),
    listPersonalRetrospectives: wrap("GET", async (actor, request) => dependencies.service.listPersonalRecords(actor, "retrospective", personalFilter(request))),
    listReuseDrafts: wrap("GET", async (actor, request, params) => dependencies.service.listReuseDrafts(actor, { ...personalFilter(request, false), ...(params.projectId ? { projectId: params.projectId } : {}) })),
    getPersonalReuseDraft: wrap("GET", async (actor, _request, params) => dependencies.service.getPersonalReuseDraft(actor, id(params))),
    createReuseDraft: wrap("POST", async (actor, request, params) => dependencies.service.createReuseDraft(actor, project(params), await readBody(request)), 201),
    getReuseDraft: wrap("GET", async (actor, _request, params) => dependencies.service.getReuseDraft(actor, id(params))),
    enqueueGeneration,
    generate: enqueueGeneration,
    getGenerationJob: wrap("GET", async (actor, _request, params) => dependencies.service.getGenerationJob(actor, id(params))),
    historyVersion: wrap("GET", async (actor, request, params) => dependencies.service.historyVersion(actor, id(params), revision(Number(new URL(request.url).searchParams.get("revision"))))),
    deliverySummary: wrap("GET", async (actor, _request, params) => dependencies.service.deliverySummary(actor, project(params))),
    deletePersonal: wrap("DELETE", async (actor, request, params) => { await dependencies.service.deletePersonal(actor, id(params), await expected(request)); return { deleted: true }; }),
    // Small textual exports are streamed as a response; no file URL or extra private data is stored.
    exportDocument: (async (request: Request, params: RouteParams) => {
      const requestId = dependencies.requestId();
      try {
        if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "请求方式不支持。" }, requestId }, { status: 405, headers: { ...headers, allow: "POST" } });
        const actor = await dependencies.authenticate(request);
        if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
        const data = object(await readBody(request), ["format"]);
        if (data.format !== "json" && data.format !== "markdown") throw new DomainError("INVALID_INPUT", "请选择JSON或Markdown格式。");
        const file = await dependencies.service.exportDocument(actor, id(params), data.format);
        return new Response(file.content, { headers: { ...headers, "content-type": file.mediaType, "content-disposition": `attachment; filename="${file.filename}"`, "x-request-id": requestId } });
      } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers }); }
    }) satisfies Handler,
  };
}
