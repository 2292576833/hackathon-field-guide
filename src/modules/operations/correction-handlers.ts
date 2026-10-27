import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createOperationsHttpHandler, positiveRevision, requiredString } from "./http.ts";
import type { OperationsHttpDependencies } from "./http.ts";
import type { CorrectionService } from "./correction-service.ts";
import type { CorrectionStatus, CorrectionTarget } from "./correction-types.ts";

function reference(value: unknown): CorrectionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "请提供公开内容版本。");
  const input = value as Record<string, unknown>;
  if (input.kind !== "event" && input.kind !== "resource") throw new DomainError("INVALID_INPUT", "纠错仅支持公开赛事与资源。");
  return { kind: input.kind, entityId: requiredString(input, "entityId", 200), version: positiveRevision(input, "version") };
}
export function createCorrectionHandlers(dependencies: OperationsHttpDependencies & { readonly service: CorrectionService }) {
  const handler = (method: "GET" | "POST" | "PATCH", execute: (actor: Actor, input: Record<string, unknown>, requestId: string, request: Request) => Promise<unknown>, successStatus?: number) => createOperationsHttpHandler(dependencies, { method, execute, successStatus });
  const queryLimit = (request: Request) => { const params = new URL(request.url).searchParams; return params.has("limit") ? Number(params.get("limit")) : 50; };
  return {
    submit: handler("POST", (actor, input) => {
      if (input.evidenceUrls !== undefined && (!Array.isArray(input.evidenceUrls) || input.evidenceUrls.some(item => typeof item !== "string"))) throw new DomainError("INVALID_INPUT", "依据须为链接列表。");
      return dependencies.service.submit(actor, { target: reference(input.target), field: requiredString(input, "field", 120), message: requiredString(input, "message", 4000), evidenceUrls: input.evidenceUrls as readonly string[] | undefined });
    }, 201),
    listOwn: handler("GET", (actor, _input, _requestId, request) => dependencies.service.listOwn(actor, queryLimit(request))),
    getOwn: (id: string) => handler("GET", actor => dependencies.service.getOwn(actor, id)),
    listQueue: handler("GET", (actor, _input, _requestId, request) => dependencies.service.listQueue(actor, (new URL(request.url).searchParams.get("status") ?? undefined) as CorrectionStatus | undefined, queryLimit(request))),
    getForReview: (id: string) => handler("GET", actor => dependencies.service.getForReview(actor, id)),
    process: (id: string) => handler("PATCH", (actor, input, requestId) => dependencies.service.process(actor, id, { expectedRevision: positiveRevision(input, "expectedRevision"), status: requiredString(input, "status", 30) as CorrectionStatus,
      reason: requiredString(input, "reason", 2000), relatedVersion: input.relatedVersion === undefined ? undefined : reference(input.relatedVersion) }, requestId)),
  };
}
