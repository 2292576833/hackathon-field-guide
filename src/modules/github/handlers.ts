import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { FileChange, RepositoryTarget } from "./types.ts";
import type { GitService } from "./git-service.ts";
import type { DeliveryService, RecordSubmissionInput, RecordVerificationInput } from "./delivery-service.ts";
import { getDeliverySummary } from "./delivery-summary.ts";
import type { DeliveryMaterialsService } from "./delivery-materials-service.ts";
import type { SaveDeliveryMaterialsInput } from "./delivery-materials-types.ts";

export type GitHubAction = "binding.get" | "binding.put" | "binding.delete" | "operations.create" | "operations.list" | "operations.get" | "operations.draft" | "operations.preview" | "operations.confirm" | "operations.reconcile" | "operations.pull-request" | "verifications.list" | "verifications.create" | "submissions.list" | "submissions.create" | "submissions.update" | "materials.get" | "materials.save" | "materials.history" | "summary";
export interface GitHubHandlerDependencies {
  git: GitService; delivery: DeliveryService;
  materials?: DeliveryMaterialsService;
  resolveActor(request: Request): Promise<Actor | null>;
  /** Wire the shared CSRF/origin policy. Must run before accepting any mutation. */
  assertMutationAllowed(request: Request, actor: Actor): Promise<void>;
  requestId(): string;
}
const verbs: Record<GitHubAction, string> = {
  "binding.get": "GET", "binding.put": "PUT", "binding.delete": "DELETE", "operations.create": "POST", "operations.list": "GET", "operations.get": "GET", "operations.draft": "GET", "operations.preview": "POST", "operations.confirm": "POST", "operations.reconcile": "POST", "operations.pull-request": "POST",
  "verifications.list": "GET", "verifications.create": "POST", "submissions.list": "GET", "submissions.create": "POST", "submissions.update": "PATCH", summary: "GET",
  "materials.get": "GET", "materials.save": "PUT", "materials.history": "GET",
};
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase().endsWith("application/json")) throw new DomainError("JSON_REQUIRED", "请使用 JSON 请求。", { status: 415 });
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader(); let total = 0;
  if (reader) {
    try {
      for (;;) { const result = await reader.read(); if (result.done) break; total += result.value.byteLength; if (total > 6 * 1024 * 1024) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "文件选择超过本次限制。", { status: 413 }); } chunks.push(result.value); }
    } finally { reader.releaseLock(); }
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new DomainError("INVALID_JSON", "请求内容无法解析。"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("INVALID_INPUT", "请提供有效的请求字段。");
  const value = body as Record<string, unknown>;
  if (["actor", "userId", "actorId", "recordedBy", "verifierId", "token", "credential", "platformRoles"].some(key => key in value)) throw new DomainError("SERVER_IDENTITY_REQUIRED", "身份与凭据必须来自服务器会话。");
  return value;
}
function str(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new DomainError("INVALID_INPUT", `请提供${name}。`); return value; }
function version(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new DomainError("INVALID_VERSION", "请提供当前修订号。"); return Number(value); }

/** Next.js route modules choose a fixed action and pass trusted URL params. */
export function createGitHubHandler(d: GitHubHandlerDependencies, action: GitHubAction) {
  return async (request: Request, params: { projectId: string; operationId?: string; recordId?: string }): Promise<Response> => {
    const requestId = d.requestId();
    try {
      if (request.method !== verbs[action]) throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
      const actor = await d.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      const mutation = verbs[action] !== "GET";
      if (mutation) await d.assertMutationAllowed(request, actor);
      const body = mutation && !["operations.preview", "operations.reconcile", "operations.pull-request"].includes(action) ? await readBody(request) : {};
      const projectId = str(params.projectId, "项目 ID");
      let data: unknown;
      switch (action) {
        case "binding.get": data = await d.git.getBinding(actor, projectId); break;
        case "binding.put": {
          if (!body.target || typeof body.target !== "object" || Array.isArray(body.target)) throw new DomainError("INVALID_REPOSITORY", "请选择授权仓库。");
          data = await d.git.bindRepository(actor, projectId, body.target as RepositoryTarget, body.expectedRevision === null ? null : version(body.expectedRevision)); break;
        }
        case "binding.delete": await d.git.unbindRepository(actor, projectId, version(body.expectedRevision)); data = { disconnected: true }; break;
        case "operations.create": {
          if (!Array.isArray(body.changes) || (body.wantsPullRequest !== undefined && typeof body.wantsPullRequest !== "boolean")) throw new DomainError("INVALID_DRAFT", "请选择文件并明确是否创建 PR。");
          data = await d.git.createDraft(actor, projectId, { changes: body.changes as FileChange[], idempotencyKey: str(body.idempotencyKey, "幂等键"), message: str(body.message, "保存说明"), wantsPullRequest: body.wantsPullRequest as boolean | undefined }); break;
        }
        case "operations.list": data = await d.git.listOperations(actor, projectId); break;
        case "operations.get": data = await d.git.getOperation(actor, projectId, str(params.operationId, "操作 ID")); break;
        case "operations.draft": data = await d.git.getDraftFiles(actor, projectId, str(params.operationId, "操作 ID")); break;
        case "operations.preview": data = await d.git.preview(actor, projectId, str(params.operationId, "操作 ID")); break;
        case "operations.confirm": data = await d.git.confirm(actor, projectId, str(params.operationId, "操作 ID"), str(body.previewHash, "预览版本")); break;
        case "operations.reconcile": data = await d.git.reconcile(actor, projectId, str(params.operationId, "操作 ID")); break;
        case "operations.pull-request": data = await d.git.retryPullRequest(actor, projectId, str(params.operationId, "操作 ID")); break;
        case "verifications.list": data = await d.delivery.listVerifications(actor, projectId); break;
        case "verifications.create": data = await d.delivery.recordVerification(actor, projectId, body as unknown as RecordVerificationInput); break;
        case "submissions.list": data = await d.delivery.listSubmissions(actor, projectId); break;
        case "submissions.create": data = await d.delivery.recordSubmission(actor, projectId, body as unknown as RecordSubmissionInput); break;
        case "submissions.update": { const { expectedVersion, ...input } = body; data = await d.delivery.updateSubmission(actor, projectId, str(params.recordId, "提交记录 ID"), version(expectedVersion), input as unknown as RecordSubmissionInput); break; }
        case "materials.get": case "materials.save": case "materials.history": {
          if (!d.materials) throw new DomainError("DELIVERY_MATERIALS_UNAVAILABLE", "材料清单尚未接入，请先人工核对已确认的比赛要求。", { status: 503, recoveryAction: "review_confirmed_event_requirements" });
          data = action === "materials.get" ? await d.materials.read(actor, projectId) : action === "materials.history" ? await d.materials.history(actor, projectId) : await d.materials.save(actor, projectId, body as unknown as SaveDeliveryMaterialsInput);
          break;
        }
        case "summary": data = await getDeliverySummary(actor, projectId, d); break;
      }
      const state = data && typeof data === "object" && "status" in data ? (data as { status: string }).status : null;
      return Response.json({ data, requestId }, { status: state === "saving" || state === "unknown" ? 202 : ["operations.create", "verifications.create", "submissions.create"].includes(action) ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } }); }
  };
}
