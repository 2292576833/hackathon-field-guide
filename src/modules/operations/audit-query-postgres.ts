import type { SqlExecutor } from "../../shared/persistence.ts";
import { auditActions } from "./audit-query-types.ts";
import type { AdminAuditEntry, AuditQueryBoundary, AuditQueryFilters, AuditQueryPort } from "./audit-query-types.ts";

/** Queries only M08-owned metadata. Root may provide another port for separately authorized role audit. */
export class PostgresAuditQueryPort implements AuditQueryPort {
  async readPage(tx: SqlExecutor, filters: AuditQueryFilters, boundary: AuditQueryBoundary | null, fetchLimit: number): Promise<readonly AdminAuditEntry[]> {
    if (!Number.isInteger(fetchLimit) || fetchLimit < 2 || fetchLimit > 101) throw new Error("Invalid audit fetch limit");
    const result = await tx.query<AdminAuditEntry>(`
      WITH metadata AS (
        SELECT ('execution:' || id) COLLATE "C" AS audit_id, 'execution' AS stream, actor_kind, actor_id,
          action, CASE WHEN action LIKE 'Source%' THEN 'source' ELSE 'run' END AS object_kind,
          entity_id AS object_id, revision, NULL::integer AS content_version, occurred_at
        FROM operations_execution_audit
        UNION ALL
        SELECT ('event_review:' || id) COLLATE "C", 'event_review', 'user', payload->>'actorId', payload->>'action', 'event', event_id,
          CASE WHEN payload->>'revision' ~ '^[1-9][0-9]{0,8}$' THEN (payload->>'revision')::integer ELSE NULL END,
          CASE WHEN payload->>'candidateRevision' ~ '^[1-9][0-9]{0,8}$' THEN (payload->>'candidateRevision')::integer ELSE NULL END, occurred_at
        FROM operations_event_review_audit
        UNION ALL
        SELECT ('resource_review:' || id) COLLATE "C", 'resource_review', 'user', actor_id, payload->>'action', 'resource', resource_id,
          CASE WHEN payload->>'reviewRevision' ~ '^[1-9][0-9]{0,8}$' THEN (payload->>'reviewRevision')::integer
            WHEN payload->>'resourceRevision' ~ '^[1-9][0-9]{0,8}$' THEN (payload->>'resourceRevision')::integer ELSE NULL END,
          CASE WHEN payload->>'resourceRevision' ~ '^[1-9][0-9]{0,8}$' THEN (payload->>'resourceRevision')::integer ELSE NULL END, occurred_at
        FROM operations_resource_review_audit
        UNION ALL
        SELECT ('correction:' || id) COLLATE "C", 'correction', 'user', actor_id,
          'correction_' || (payload->>'toStatus'), 'correction', correction_id, revision, NULL::integer, occurred_at
        FROM operations_correction_transitions
        UNION ALL
        SELECT ('discovery_control:' || id::text) COLLATE "C", 'discovery_control', 'user', actor_id,
          CASE WHEN paused THEN 'discovery_paused' ELSE 'discovery_resumed' END, 'scheduler', scheduler_id, revision, NULL::integer, occurred_at
        FROM operations_discovery_control_audit
      ), safe_metadata AS (
        SELECT audit_id, stream, actor_kind, actor_id, CASE WHEN action=ANY($12::text[]) THEN action ELSE 'unrecognized' END AS action,
          object_kind, object_id, revision, content_version, occurred_at FROM metadata
      )
      SELECT audit_id AS id, stream, actor_kind AS "actorKind", actor_id AS "actorId", action,
        object_kind AS "objectKind", object_id AS "objectId", revision, content_version AS "contentVersion",
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
      FROM safe_metadata
      WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
        AND ($3::text IS NULL OR actor_id=$3) AND ($4::text IS NULL OR action=$4)
        AND ($5::text IS NULL OR object_kind=$5) AND ($6::text IS NULL OR object_id=$6)
        AND ($7::integer IS NULL OR revision=$7) AND ($8::text IS NULL OR stream=$8)
        AND ($9::timestamptz IS NULL OR (occurred_at,audit_id COLLATE "C") < ($9::timestamptz,$10::text COLLATE "C"))
      ORDER BY occurred_at DESC, audit_id COLLATE "C" DESC LIMIT $11::integer
    `, [filters.from, filters.to, filters.actorId, filters.action, filters.objectKind, filters.objectId, filters.revision, filters.stream,
      boundary?.occurredAt ?? null, boundary?.id ?? null, fetchLimit, auditActions]);
    return result.rows;
  }
}
