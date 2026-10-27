import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createOperationsHttpHandler, positiveRevision, requiredString } from "./http.ts";
import type { OperationsHttpDependencies } from "./http.ts";
import type { ResourceReviewService } from "./resource-review-service.ts";
import type { ResourceReviewStatus, ResourceVerification } from "./resource-review-types.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "请填写核验信息。");
  return value as Record<string, unknown>;
}
function verification(input: Record<string, unknown>): ResourceVerification {
  const check = object(input.verification); const link = object(check.link);
  if (link.status !== "available" && link.status !== "unavailable") throw new DomainError("INVALID_INPUT", "链接核验状态无效。");
  const claim = (value: unknown): ResourceVerification["fees"] => {
    const entry = object(value);
    if (entry.status !== "verified" && entry.status !== "unknown") throw new DomainError("INVALID_INPUT", "费用或许可核验状态无效。");
    return { status: entry.status, sourceUrl: entry.sourceUrl === null ? null : requiredString(entry, "sourceUrl", 2000) };
  };
  return { link: { status: link.status, checkedUrl: requiredString(link, "checkedUrl", 2000) }, fees: claim(check.fees), license: claim(check.license) };
}
export function createResourceReviewHandlers(dependencies: OperationsHttpDependencies & { readonly service: ResourceReviewService }) {
  const handler = (method: "GET" | "POST", execute: (actor: Actor, input: Record<string, unknown>, requestId: string, request: Request) => Promise<unknown>, successStatus?: number) => createOperationsHttpHandler(dependencies, { method, execute, successStatus });
  return {
    list: handler("GET", (actor, _input, _requestId, request) => {
      const params = new URL(request.url).searchParams;
      return dependencies.service.list(actor, (params.get("status") ?? undefined) as ResourceReviewStatus | undefined, params.has("limit") ? Number(params.get("limit")) : 50);
    }),
    detail: (reviewId: string) => handler("GET", actor => dependencies.service.getDetail(actor, reviewId)),
    register: (resourceId: string) => handler("POST", (actor, input, requestId) => dependencies.service.register(actor, { resourceId, expectedResourceRevision: positiveRevision(input, "expectedResourceRevision") }, requestId), 201),
    decide: (reviewId: string) => handler("POST", (actor, input, requestId) => {
      if (input.decision !== "approved" && input.decision !== "changes_requested" && input.decision !== "rejected") throw new DomainError("INVALID_INPUT", "审核结论无效。");
      return dependencies.service.decide(actor, reviewId, { expectedRevision: positiveRevision(input, "expectedRevision"), expectedResourceRevision: positiveRevision(input, "expectedResourceRevision"),
        decision: input.decision, reason: requiredString(input, "reason"), verification: input.decision === "approved" ? verification(input) : undefined }, requestId);
    }),
    publish: (reviewId: string) => handler("POST", (actor, input, requestId) => dependencies.service.publish(actor, reviewId, { expectedRevision: positiveRevision(input, "expectedRevision"), expectedResourceRevision: positiveRevision(input, "expectedResourceRevision") }, requestId)),
    withdraw: (resourceId: string) => handler("POST", (actor, input, requestId) => dependencies.service.withdraw(actor, { resourceId, expectedResourceRevision: positiveRevision(input, "expectedResourceRevision"), expectedPublishedVersion: positiveRevision(input, "expectedPublishedVersion"), operationId: requiredString(input, "operationId"), reason: requiredString(input, "reason") }, requestId)),
  };
}
