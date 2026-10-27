import type { Clock } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import type { ApplicationConfig } from "./config.ts";
import { discoveryFeedVersionSql, discoveryVisibilitySql, discoveryVisibilityTime } from "./discovery.ts";

export interface DiscoveryLiveState {
  version: string; count: number;
  state: "running" | "waiting" | "paused" | "limited" | "attention" | "offline" | "unconfigured";
  minimumIntervalMs: number | null; lastCompletedAt: string | null; nextEligibleAt: string | null;
}
const iso = (value: string | Date | null | undefined) => value == null ? null : new Date(value).toISOString();

/** Read-only public synchronization. It never claims work or invokes a provider.
 * Coalesce concurrent browsers and cache the small metadata response for one second. */
export function createDiscoveryLiveService(input: { database: DatabasePort; config: ApplicationConfig; clock: Clock; cacheMs?: number }) {
  let cached: DiscoveryLiveState | undefined;
  let cachedAt = 0;
  let cachedDeadline = Number.POSITIVE_INFINITY;
  let pending: Promise<{ value: DiscoveryLiveState; deadline: number; at: number }> | undefined;
  async function read(): Promise<{ value: DiscoveryLiveState; deadline: number; at: number }> {
    const now = input.clock.now(), [at, date] = discoveryVisibilityTime(now);
    const result = await input.database.query<{
      version: string; count: number; paused: boolean | null; quota_day: string | null;
      search_calls: number | null; model_calls: number | null; estimated_cost_micros: number | string | null;
      lease_expires_at: Date | string | null; last_completed_at: Date | string | null;
      next_eligible_at: Date | string | null; last_error_code: string | null;
      worker_status: string | null; last_seen_at: Date | string | null;
      next_closes_at: string | null; next_closes_on: string | null; next_event_starts_at: string | null; next_event_starts_on: string | null;
    }>(`SELECT feed.version,feed.count,feed.next_closes_at,feed.next_closes_on,s.paused,s.quota_day,s.search_calls,s.model_calls,s.estimated_cost_micros,
      s.lease_expires_at,s.last_completed_at,s.next_eligible_at,s.last_error_code,
      w.status AS worker_status,w.last_seen_at
      FROM (SELECT ${discoveryFeedVersionSql} AS version,
        count(*)::integer AS count,min(content#>>'{registrationWindow,closesAt}') AS next_closes_at,
        min(content#>>'{registrationWindow,closesOn}') AS next_closes_on,
        min(content#>>'{eventWindow,startsAt}') AS next_event_starts_at,
        min(content#>>'{eventWindow,startsOn}') AS next_event_starts_on
        FROM event_discovery_cards WHERE ${discoveryVisibilitySql("$1", "$2")}) feed
      LEFT JOIN operations_discovery_state s ON s.id='event-discovery'
      LEFT JOIN LATERAL (SELECT status,last_seen_at FROM backend_worker_heartbeats WHERE kind='discovery'
      ORDER BY (status<>'stopped' AND last_seen_at>$1::timestamptz-interval '120 seconds') DESC,last_seen_at DESC LIMIT 1) w ON true`, [at]);
    const row = result.rows[0]!;
    const worker = input.config.discovery?.worker;
    const healthy = row.last_seen_at != null && now.getTime() - new Date(row.last_seen_at).getTime() <= 120_000 && row.worker_status !== "stopped";
    const active = row.lease_expires_at != null && new Date(row.lease_expires_at).getTime() > now.getTime();
    const searchReservation = worker?.queries.length ?? 0;
    const modelReservation = (worker?.maxPagesPerCycle ?? 0) + (input.config.discovery?.provider === "dsh_native" ? searchReservation : 0);
    const costReservation = searchReservation * (worker?.searchCostMicrosPerCall ?? 0) + (worker?.maxPagesPerCycle ?? 0) * (worker?.modelCostReservationMicrosPerCall ?? 0);
    const sameDay = row.quota_day === now.toISOString().slice(0, 10);
    const limited = Boolean(worker && (
      (sameDay ? Number(row.search_calls) : 0) + searchReservation > worker.limits.maxSearchCallsPerDay ||
      (sameDay ? Number(row.model_calls) : 0) + modelReservation > worker.limits.maxModelCallsPerDay ||
      (sameDay ? Number(row.estimated_cost_micros) : 0) + costReservation > worker.limits.maxEstimatedCostMicrosPerDay));
    const state: DiscoveryLiveState["state"] = !worker || !input.config.dsh ? "unconfigured" : row.paused ? "paused" :
      !healthy ? "offline" : active ? "running" : limited ? "limited" : row.last_error_code || row.worker_status === "failed" ? "attention" : "waiting";
    return { value: { version: row.version, count: row.count, state, minimumIntervalMs: worker?.minimumIntervalMs ?? null,
      lastCompletedAt: iso(row.last_completed_at), nextEligibleAt: iso(row.next_eligible_at) }, deadline: Number.POSITIVE_INFINITY, at: now.getTime() };
  }
  function snapshot(): Promise<DiscoveryLiveState> {
    const now = input.clock.now().getTime();
    if (cached && now >= cachedAt && now - cachedAt < (input.cacheMs ?? 1000) && now < cachedDeadline) return Promise.resolve({ ...cached });
    if (!pending) pending = read().then(result => { cached = result.value; cachedAt = result.at; cachedDeadline = result.deadline; return result; }).finally(() => { pending = undefined; });
    return pending.then(result => {
      // A deadline may pass while SQL is in flight. Re-read with the new clock
      // before exposing the stale count; this remains a coalesced read-only call.
      if (input.clock.now().getTime() >= result.deadline) { cached = undefined; return snapshot(); }
      return { ...result.value };
    });
  }
  return { snapshot };
}
