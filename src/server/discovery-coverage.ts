import type { Clock } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { DiscoveryCycleReport } from "../modules/operations/discovery-types.ts";

export interface DiscoveryCoverageRecord {
  readonly attemptId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly report: DiscoveryCycleReport;
}
export interface DiscoveryCoverageSummary {
  readonly quotaDay: string;
  /** A service coverage goal, never a claim of continuous model execution. */
  readonly targetHours: number;
  readonly firstStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly cycles: number;
  /** Successfully returned searches, excluding unknown dispatch outcomes. */
  readonly searchCalls: number;
  readonly fetchedPages: number;
  readonly savedCards: number;
  /** Sum of each recorded cycle's processing time; excludes between-cycle waits. */
  readonly activeMs: number;
  /** First start to latest finish; explicitly includes waits and possible outages. */
  readonly spanMs: number;
}
interface CoverageRow {
  first_started_at: string | Date;
  last_completed_at: string | Date;
  cycles: number;
  search_calls: number;
  fetched_pages: number;
  saved_cards: number;
  active_ms: string | number;
}
const schedulerId = "event-discovery";
const validCounter = (value: number) => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new DomainError("INVALID_DISCOVERY_COVERAGE", "发现作业记录的标识、时间或数量无效。");

/** Observation only: never reserves, refunds, replays or changes discovery work. */
export function createDiscoveryCoverage(input: { database: DatabasePort; clock: Clock; targetHours?: number }) {
  const targetHours = input.targetHours ?? 5;
  if (!Number.isSafeInteger(targetHours) || targetHours < 1 || targetHours > 24) throw invalid();
  async function record(value: DiscoveryCoverageRecord): Promise<boolean> {
    if (value.report.status === "skipped" || (value.report.searched === 0 && value.report.fetched === 0)) return false;
    const start = Date.parse(value.startedAt), end = Date.parse(value.completedAt);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.attemptId) ||
      !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      !["completed", "failed", "cancelled"].includes(value.report.status) ||
      ![value.report.searched, value.report.fetched, value.report.saved].every(validCounter)) throw invalid();
    const startedAt = new Date(start).toISOString(), completedAt = new Date(end).toISOString();
    const quotaDay = startedAt.slice(0, 10), activeMs = end - start;
    return input.database.transaction(async tx => {
      const inserted = await tx.query<{ attempt_id: string }>(`INSERT INTO operations_discovery_coverage_cycles
        (scheduler_id,attempt_id,quota_day,started_at,completed_at,report_status,search_calls,fetched_pages,saved_cards,active_ms)
        VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8,$9,$10)
        ON CONFLICT(scheduler_id,attempt_id) DO NOTHING RETURNING attempt_id`,
      [schedulerId, value.attemptId.toLowerCase(), quotaDay, startedAt, completedAt, value.report.status,
        value.report.searched, value.report.fetched, value.report.saved, activeMs]);
      if (inserted.rows.length === 0) return false;
      await tx.query(`INSERT INTO operations_discovery_coverage
        (scheduler_id,quota_day,first_started_at,last_completed_at,cycles,search_calls,fetched_pages,saved_cards,active_ms)
        VALUES($1,$2,$3::timestamptz,$4::timestamptz,1,$5,$6,$7,$8)
        ON CONFLICT(scheduler_id,quota_day) DO UPDATE SET
          first_started_at=LEAST(operations_discovery_coverage.first_started_at,EXCLUDED.first_started_at),
          last_completed_at=GREATEST(operations_discovery_coverage.last_completed_at,EXCLUDED.last_completed_at),
          cycles=operations_discovery_coverage.cycles+1,
          search_calls=operations_discovery_coverage.search_calls+EXCLUDED.search_calls,
          fetched_pages=operations_discovery_coverage.fetched_pages+EXCLUDED.fetched_pages,
          saved_cards=operations_discovery_coverage.saved_cards+EXCLUDED.saved_cards,
          active_ms=operations_discovery_coverage.active_ms+EXCLUDED.active_ms`,
      [schedulerId, quotaDay, startedAt, completedAt, value.report.searched, value.report.fetched, value.report.saved, activeMs]);
      return true;
    });
  }
  async function summary(): Promise<DiscoveryCoverageSummary> {
    const quotaDay = input.clock.now().toISOString().slice(0, 10);
    const result = await input.database.query<CoverageRow>(`SELECT first_started_at,last_completed_at,cycles,search_calls,fetched_pages,saved_cards,active_ms
      FROM operations_discovery_coverage WHERE scheduler_id=$1 AND quota_day=$2`, [schedulerId, quotaDay]);
    const row = result.rows[0];
    const firstStartedAt = row ? new Date(row.first_started_at).toISOString() : null;
    const lastCompletedAt = row ? new Date(row.last_completed_at).toISOString() : null;
    return { quotaDay, targetHours, firstStartedAt, lastCompletedAt, cycles: row?.cycles ?? 0,
      searchCalls: row?.search_calls ?? 0, fetchedPages: row?.fetched_pages ?? 0, savedCards: row?.saved_cards ?? 0,
      activeMs: row ? Number(row.active_ms) : 0,
      spanMs: firstStartedAt && lastCompletedAt ? Date.parse(lastCompletedAt) - Date.parse(firstStartedAt) : 0 };
  }
  return { record, summary };
}
