import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { OBSERVABILITY_FAILURE_CATEGORIES } from "./observability-types.ts";
import type { OperationsObservabilityQueryPort, SourceObservabilityQuery, SourceObservabilityRecord } from "./observability-types.ts";

// Only operations-owned tables are read. The optional root runtime port owns AI
// budgets, worker heartbeats and unknown-request ledgers separately.
// JSON timestamptz serialization may use +00:00; format UTC with all six stored
// fractional digits rather than converting via JavaScript Date (millisecond).
const utc = (expression: string) => `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const snapshotSql = `WITH selected_runs AS (
  SELECT r.id,r.revision,r.kind,r.status,r.created_at,r.available_at,
    r.data->>'step' AS step,(r.data->>'attempt')::integer AS attempt,
    (CASE WHEN r.data->'history'->0->>'attempt'='1' THEN r.data->'history'->0->>'occurredAt' END)::timestamptz AS first_started_at,
    (r.data->>'lastAttemptAt')::timestamptz AS last_attempt_at,
    (r.data->>'finishedAt')::timestamptz AS finished_at,
    r.data->'failures'-> -1 AS latest_failure,
    CASE WHEN r.data->'failures'-> -1 ->>'category'=ANY($10::text[])
      THEN r.data->'failures'-> -1 ->>'category' ELSE 'unknown' END AS latest_failure_category
  FROM operations_execution_runs r
  WHERE r.source_config_id=$1 AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
    AND ($4::text IS NULL OR r.kind=$4) AND ($5::text IS NULL OR r.status=$5)
    AND ($6::text IS NULL OR r.data->'failures'-> -1 ->>'category'=$6)
), run_page AS (
  SELECT * FROM selected_runs
  WHERE $8::timestamptz IS NULL OR (created_at,id COLLATE "C") < ($8::timestamptz,$9::text COLLATE "C")
  ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT $7
), status_counts AS (
  SELECT status,count(*)::text AS count FROM selected_runs GROUP BY status
), failure_counts AS (
  SELECT latest_failure_category AS category,count(*)::text AS count
  FROM selected_runs WHERE latest_failure IS NOT NULL AND latest_failure <> 'null'::jsonb
  GROUP BY latest_failure_category
)
SELECT jsonb_build_object('id',s.id,'revision',s.revision,'status',s.status,
    'nextEligibleAt',${utc("s.next_eligible_at")},'lastSuccessAt',${utc("s.last_success_at")},
    'lastFailureAt',${utc("s.last_failure_at")},'consecutiveCrawlFailures',s.consecutive_failures) AS source,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'revision',p.revision,'kind',p.kind,'status',p.status,
    'step',p.step,'attempt',p.attempt,'createdAt',${utc("p.created_at")},'availableAt',${utc("p.available_at")},
    'firstStartedAt',${utc("p.first_started_at")},'lastAttemptAt',${utc("p.last_attempt_at")},'finishedAt',${utc("p.finished_at")},
    'latestFailure',CASE WHEN p.latest_failure IS NULL OR p.latest_failure='null'::jsonb THEN NULL ELSE
      jsonb_build_object('category',p.latest_failure_category,'occurredAt',${utc("(p.latest_failure->>'occurredAt')::timestamptz")},'attempt',(p.latest_failure->>'attempt')::integer) END)
    ORDER BY p.created_at DESC,p.id COLLATE "C" DESC) FROM run_page p),'[]'::jsonb) AS runs,
  COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.status) FROM status_counts c),'[]'::jsonb) AS counts,
  COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.category) FROM failure_counts c),'[]'::jsonb) AS failures
FROM operations_source_configs s WHERE s.id=$1`;

/** Index suggestion for root's next migration:
 * CREATE INDEX operations_observability_source_window
 * ON operations_execution_runs(source_config_id,created_at DESC,id COLLATE "C" DESC);
 * Optional kind/status prefixes should follow real volume measurements. No DDL
 * or transaction isolation changes occur in this read adapter. */
export function createPostgresOperationsObservabilityQueryPort(database: DatabasePort): OperationsObservabilityQueryPort {
  return {
    database,
    async read(sql: SqlExecutor, query: SourceObservabilityQuery): Promise<SourceObservabilityRecord | null> {
      const result = await sql.query<SourceObservabilityRecord>(snapshotSql, [query.sourceId, query.since, query.until, query.kind, query.status, query.failureCategory, query.limit + 1, query.before?.createdAt ?? null, query.before?.id ?? null, OBSERVABILITY_FAILURE_CATEGORIES]);
      return result.rows[0] ?? null;
    },
  };
}
