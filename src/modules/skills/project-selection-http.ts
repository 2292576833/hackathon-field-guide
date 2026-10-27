import type { Actor } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { ProjectSkillSelectionService } from "./project-selection.ts";

export interface ProjectSkillSelectionHttpDependencies {
  service: ProjectSkillSelectionService;
  resolveActor(request: Request): Promise<Actor | null>;
  assertMutationAllowed(request: Request, actor: Actor): Promise<void>;
  requestId(): string;
}
async function json(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new DomainError("JSON_REQUIRED", "请提交 JSON。", { status: 415 });
  if (!request.body) throw new DomainError("INVALID_JSON", "请求不能为空。");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 48 * 1024) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "技能选择请求过大。", { status: 413 }); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new DomainError("INVALID_JSON", "JSON 格式无效。"); }
}
function fields(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new DomainError("INVALID_SKILL_REFERENCE", "请求包含不支持的字段。");
}
/** Root supplies project routes. GET only reads saved facts and reviewed catalog. */
export function createProjectSkillSelectionHttpHandlers(dependencies: ProjectSkillSelectionHttpDependencies) {
  const handler = (method: "GET" | "PUT" | "POST", work: (actor: Actor, input: Record<string, unknown>) => Promise<unknown>) => async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestId();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
      const actor = await dependencies.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      if (method !== "GET") await dependencies.assertMutationAllowed(request, actor);
      const data = await work(actor, method === "GET" ? {} : await json(request));
      return Response.json({ data, requestId }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
  return {
    read: (projectId: string) => handler("GET", actor => dependencies.service.read(actor, projectId)),
    catalog: (projectId: string) => handler("GET", actor => dependencies.service.catalog(actor, projectId)),
    save: (projectId: string) => handler("PUT", (actor, input) => {
      fields(input, ["expectedRevision", "selections"]);
      return dependencies.service.save(actor, projectId, { expectedRevision: input.expectedRevision as number, selections: input.selections });
    }),
    copy: (targetProjectId: string) => handler("POST", (actor, input) => {
      fields(input, ["sourceProjectId", "expectedRevision"]);
      return dependencies.service.copy(actor, input.sourceProjectId as string, targetProjectId, input.expectedRevision as number);
    }),
  };
}
