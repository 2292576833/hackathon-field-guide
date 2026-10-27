import { DomainError } from "../../shared/errors.ts";
import { createOperationsHttpHandler } from "./http.ts";
import type { OperationsHttpDependencies } from "./http.ts";
import type { AuditQueryService } from "./audit-query-service.ts";
import type { AuditQueryInput } from "./audit-query-types.ts";

export function createAuditQueryHandlers(deps: OperationsHttpDependencies & { readonly service: AuditQueryService }) {
  return {
    list: createOperationsHttpHandler(deps, { method: "GET", execute: (actor, _input, _requestId, request) => {
      const query = new URL(request.url).searchParams;
      const allowed = ["actorId", "action", "objectKind", "objectId", "revision", "stream", "from", "to", "limit", "cursor"];
      for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new DomainError("INVALID_AUDIT_QUERY", "审计筛选参数无效。", { status: 400 });
      const value = (key: string) => query.get(key) ?? undefined;
      const number = (key: string) => {
        const raw = value(key);
        if (raw === undefined) return undefined;
        if (!/^[1-9]\d{0,8}$/.test(raw)) throw new DomainError("INVALID_AUDIT_QUERY", "页数或版本格式无效。", { status: 400 });
        return Number(raw);
      };
      return deps.service.list(actor, { actorId: value("actorId"), action: value("action"), objectKind: value("objectKind"), objectId: value("objectId"),
        revision: number("revision"), stream: value("stream"), from: value("from"), to: value("to"), limit: number("limit"), cursor: value("cursor") } as AuditQueryInput);
    } }),
  };
}
