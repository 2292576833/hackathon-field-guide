import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { ResourceQuery } from "./domain.ts";
import { ResourceService } from "./service.ts";
import type { ResourceCorrectionKind } from "./ports.ts";

export interface ResourceHandlerDependencies {
  service: ResourceService;
  resolveActor(request: Request): Promise<Actor | null>;
  requestIds: IdGenerator;
  /** Coordinator validates origin/CSRF for cookie-authenticated mutations. */
  assertMutationAllowed(request: Request): Promise<void>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_REQUEST_BODY", "请求内容需要是一个对象。");
  return value as Record<string, unknown>;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DomainError("INVALID_REQUEST_BODY", "请使用 JSON 提交内容。", {status: 415});
  // Read with a byte bound; untrusted notes never cause external fetch or execution.
  if (!request.body) throw new DomainError("INVALID_REQUEST_BODY", "请求缺少内容。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "内容过长，请缩短备注。", {status: 413}); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return object(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("INVALID_REQUEST_BODY", "请求内容不是有效 JSON。"); }
}
function onlyKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new DomainError("UNEXPECTED_REQUEST_FIELD", "请求包含不支持的字段；身份由登录会话确定。");
}
function query(request: Request): ResourceQuery {
  const values = new URL(request.url).searchParams;
  const result: Record<string, unknown> = {};
  const allowed = ["search", "type", "stage", "stack", "prerequisite", "use", "costType", "sort", "cursor", "limit"];
  for (const [key, value] of values) {
    if (!allowed.includes(key) || values.getAll(key).length > 1) throw new DomainError("INVALID_RESOURCE_QUERY", "筛选条件包含不支持或重复的字段。");
    result[key] = key === "limit" ? Number(value) : value;
  }
  return result as ResourceQuery;
}

/** Next route files call these factories with path IDs; no app route is owned here. */
export function createResourceHandlers(deps: ResourceHandlerDependencies) {
  async function respond(work: () => Promise<unknown> | unknown, privateData = false): Promise<Response> {
    const requestId = deps.requestIds.next();
    try {
      return Response.json({data: await work(), requestId}, {headers: {"Cache-Control": privateData ? "private, no-store" : "no-store"}});
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), {status: error instanceof DomainError ? error.status : 500, headers: {"Cache-Control": privateData ? "private, no-store" : "no-store"}});
    }
  }
  return {
    listResources: (request: Request) => respond(() => deps.service.list(query(request))),
    resourceDetail: (_request: Request, id: string) => respond(() => deps.service.detail(id)),
    resourceCategories: (_request: Request) => respond(() => deps.service.categories()),
    listBookmarks: (request: Request) => respond(async () => {
      const parameters = new URL(request.url).searchParams;
      for (const key of parameters.keys()) if (!["cursor", "limit"].includes(key) || parameters.getAll(key).length > 1) throw new DomainError("INVALID_RESOURCE_QUERY", "个人收藏只接受分页条件。");
      return deps.service.listBookmarks(await deps.resolveActor(request), { ...(parameters.has("cursor") ? {cursor: parameters.get("cursor")!} : {}), ...(parameters.has("limit") ? {limit: Number(parameters.get("limit"))} : {}) });
    }, true),
    createBookmark: (request: Request) => respond(async () => {
      await deps.assertMutationAllowed(request);
      const input = await body(request);
      onlyKeys(input, ["resourceId", "purposeNote"]);
      return deps.service.bookmark(await deps.resolveActor(request), input.resourceId as string, input.purposeNote === undefined ? "" : input.purposeNote as string);
    }, true),
    updateBookmark: (request: Request, id: string) => respond(async () => {
      await deps.assertMutationAllowed(request);
      const input = await body(request);
      onlyKeys(input, ["purposeNote", "expectedRevision"]);
      return deps.service.updateBookmark(await deps.resolveActor(request), id, input.expectedRevision as number, input.purposeNote as string);
    }, true),
    deleteBookmark: (request: Request, id: string) => respond(async () => {
      await deps.assertMutationAllowed(request);
      await deps.service.removeBookmark(await deps.resolveActor(request), id);
      return {removed: true};
    }, true),
    reportCorrection: (request: Request) => respond(async () => {
      await deps.assertMutationAllowed(request);
      const input = await body(request);
      onlyKeys(input, ["resourceId", "kind", "note"]);
      return deps.service.reportCorrection(await deps.resolveActor(request), {resourceId: input.resourceId as string, kind: input.kind as ResourceCorrectionKind, note: input.note as string});
    }, true),
  };
}
