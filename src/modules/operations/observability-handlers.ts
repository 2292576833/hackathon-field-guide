import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { ExecutionKind, ExecutionStatus, FailureCategory } from "./run-domain.ts";
import type { OperationsObservabilityService } from "./observability-service.ts";

export function createOperationsObservabilityHandlers(deps: {
  readonly service: OperationsObservabilityService;
  /** A verified active website session, never Actor fields from query/body. */
  readonly resolveActor: (request: Request) => Promise<Actor | null>;
  readonly requestId: (request: Request) => string;
}) {
  return {
    /** Root route suggestion: GET /api/v1/admin/sources/:sourceId/observability. */
    source: (sourceId: string) => async (request: Request): Promise<Response> => {
      const requestId = deps.requestId(request);
      const headers = { "Cache-Control": "no-store, private", "Vary": "Cookie, Authorization" };
      try {
        if (request.method !== "GET") throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
        const actor = await deps.resolveActor(request);
        if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
        const params = new URL(request.url).searchParams;
        const allowed = ["since", "until", "kind", "status", "failureCategory", "limit", "cursor"];
        if (request.url.length > 8192 || [...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw new DomainError("INVALID_OBSERVABILITY_QUERY", "查询参数无效。");
        const data = await deps.service.source(actor, { sourceId, since: params.get("since") ?? undefined, until: params.get("until") ?? undefined,
          kind: (params.get("kind") ?? undefined) as ExecutionKind | undefined, status: (params.get("status") ?? undefined) as ExecutionStatus | undefined,
          failureCategory: (params.get("failureCategory") ?? undefined) as FailureCategory | undefined,
          limit: params.has("limit") ? Number(params.get("limit")) : undefined, cursor: params.get("cursor") ?? undefined });
        return Response.json({ data, requestId }, { headers });
      } catch (error) {
        return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers });
      }
    },
  };
}
