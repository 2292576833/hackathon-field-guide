import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { EventFilter } from "./model.ts";
import type { EventsService } from "./service.ts";

export interface EventsHandlerDependencies {
  service: EventsService;
  resolveActor(request: Request): Promise<Actor | null>;
  requestIds: IdGenerator;
}
async function json(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new DomainError("INVALID_CONTENT_TYPE", "请使用 JSON 请求。", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("INVALID_JSON", "请求内容不能为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "请求内容超过限制。", { status: 413 }); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("INVALID_JSON", "JSON 请求内容无效。");
  } finally { reader.releaseLock(); }
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError("INVALID_INPUT", `${field}不能为空。`);
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DomainError("INVALID_INPUT", `${field}必须是有效整数。`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DomainError("INVALID_INPUT", "请求含有不受支持的字段。");
}
/** Main session wires these to Next.js route handlers and its trusted session resolver. */
export function createEventsHandlers(dependencies: EventsHandlerDependencies) {
  const actor = async (request: Request): Promise<Actor> => {
    const current = await dependencies.resolveActor(request);
    if (!current) throw new DomainError("AUTH_REQUIRED", "请登录后继续。", { status: 401 });
    return current;
  };
  const handle = async (operation: () => Promise<unknown>, status = 200): Promise<Response> => {
    const requestId = dependencies.requestIds.next();
    try { return Response.json({ data: await operation(), requestId }, { status, headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } }); }
  };
  return {
    list: (request: Request) => handle(async () => {
      const search = new URL(request.url).searchParams;
      const allowed = ["query", "format", "region", "beginnerEligibility", "phase", "cursor", "limit"];
      if ([...search.keys()].some(key => !allowed.includes(key)) || allowed.some(key => search.getAll(key).length > 1)) throw new DomainError("INVALID_FILTER", "筛选条件无效或重复。");
      const filter: EventFilter = {};
      if (search.has("query")) filter.query = search.get("query")!;
      if (search.has("region")) filter.region = search.get("region")!;
      if (search.has("cursor")) filter.cursor = search.get("cursor")!;
      if (search.has("format")) filter.format = search.get("format") as EventFilter["format"];
      if (search.has("phase")) filter.phase = search.get("phase") as EventFilter["phase"];
      if (search.has("beginnerEligibility")) filter.beginnerEligibility = search.get("beginnerEligibility") as EventFilter["beginnerEligibility"];
      if (search.has("limit")) filter.limit = Number(search.get("limit"));
      return dependencies.service.listEvents(filter);
    }),
    detail: (_request: Request, eventId: string) => handle(() => dependencies.service.getEvent(eventId)),
    projectRules: (request: Request, projectId: string) => handle(async () => dependencies.service.getProjectRules(await actor(request), projectId)),
    projectChanges: (request: Request, projectId: string) => handle(async () => dependencies.service.getProjectChanges(await actor(request), projectId)),
    confirm: (request: Request, projectId: string) => handle(async () => {
      const current = await actor(request);
      const body = await json(request);
      keys(body, ["eventId", "rulesVersion", "expectedRevision", "analysisId"]);
      return dependencies.service.confirmProjectRules(current, projectId, text(body.eventId, "赛事 ID"), number(body.rulesVersion, "规则版本"), number(body.expectedRevision, "预期版本"), body.analysisId === undefined || body.analysisId === null ? null : text(body.analysisId, "分析 ID"));
    }),
    manualAnalysis: (request: Request, projectId: string) => handle(async () => {
      const current = await actor(request);
      const body = await json(request);
      keys(body, ["input", "content"]);
      const input = body.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || (input as Record<string, unknown>).projectId !== projectId) throw new DomainError("INVALID_ANALYSIS_INPUT", "分析输入必须属于当前项目。");
      return dependencies.service.saveManualAnalysis(current, input, body.content);
    }, 201),
    queueAnalysis: (request: Request, projectId: string) => handle(async () => {
      const current = await actor(request);
      const body = await json(request);
      keys(body, ["input", "idempotencyKey"]);
      const input = body.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || (input as Record<string, unknown>).projectId !== projectId) throw new DomainError("INVALID_ANALYSIS_INPUT", "分析输入必须属于当前项目。");
      return dependencies.service.queueAnalysis(current, input, text(body.idempotencyKey, "幂等键"));
    }, 202),
    analysis: (request: Request, projectId: string, analysisId: string) => handle(async () => dependencies.service.getAnalysis(await actor(request), projectId, analysisId)),
    run: (request: Request, projectId: string, runId: string) => handle(async () => dependencies.service.getAnalysisRun(await actor(request), projectId, runId)),
    retryRun: (request: Request, projectId: string, runId: string) => handle(async () => dependencies.service.retryAnalysis(await actor(request), projectId, runId), 202),
    cancelRun: (request: Request, projectId: string, runId: string) => handle(async () => dependencies.service.cancelAnalysis(await actor(request), projectId, runId)),
    correction: (request: Request, eventId: string) => handle(async () => {
      const current = await actor(request);
      const body = await json(request);
      keys(body, ["field", "explanation", "sourceUrl"]);
      return dependencies.service.submitCorrection(current, eventId, { field: text(body.field, "纠错字段"), explanation: text(body.explanation, "说明"), sourceUrl: body.sourceUrl === undefined || body.sourceUrl === null ? null : text(body.sourceUrl, "来源链接") });
    }, 201),
    candidate: (request: Request) => handle(async () => {
      const current = await actor(request);
      const body = await json(request);
      keys(body, ["rules", "expectedRevision"]);
      return dependencies.service.createCandidate(current, body.rules, number(body.expectedRevision, "预期版本"));
    }, 201),
    review: (request: Request, eventId: string) => handle(async () => {
      const current = await actor(request); const body = await json(request); keys(body, ["expectedRevision"]);
      return dependencies.service.requestReview(current, eventId, number(body.expectedRevision, "预期版本"));
    }),
    publish: (request: Request, eventId: string) => handle(async () => {
      const current = await actor(request); const body = await json(request); keys(body, ["expectedRevision"]);
      return dependencies.service.publishCandidate(current, eventId, number(body.expectedRevision, "预期版本"));
    }),
    archive: (request: Request, eventId: string) => handle(async () => {
      const current = await actor(request); const body = await json(request); keys(body, ["expectedRevision"]);
      return dependencies.service.archiveEvent(current, eventId, number(body.expectedRevision, "预期版本"));
    }),
  };
}
