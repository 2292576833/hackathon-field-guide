import { randomBytes } from "node:crypto";
import type { Clock } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { DISCOVERY_MODEL_REQUIRES_REVIEW, DISCOVERY_SEARCH_REQUIRES_REVIEW, type DiscoveryCycleReservation, type DiscoveryLedgerPort, type DiscoveryState } from "./discovery-types.ts";

interface StateRow {
  revision: number; paused: boolean; next_eligible_at: string | Date | null; lease_token: string | null;
  lease_expires_at: string | Date | null; quota_day: string; search_calls: number; model_calls: number;
  estimated_cost_micros: number | string; reservation: DiscoveryCycleReservation | null;
  last_completed_at: string | Date | null; last_error_code: string | null; currency: "USD" | "CNY";
}
const iso = (value: string | Date | null) => value === null ? null : new Date(value).toISOString();
function state(row: StateRow): DiscoveryState {
  return { revision: row.revision, paused: row.paused, nextEligibleAt: iso(row.next_eligible_at), leaseExpiresAt: iso(row.lease_expires_at),
    quotaDay: row.quota_day, searchCalls: row.search_calls, modelCalls: row.model_calls, estimatedCostMicros: Number(row.estimated_cost_micros),
    lastCompletedAt: iso(row.last_completed_at), lastErrorCode: row.last_error_code };
}
function conflict(): never { throw new DomainError("DISCOVERY_VERSION_CONFLICT", "发现调度已更新，请刷新。", { status: 409 }); }

/** Global discovery quota + cycle lease + URL attempts are real PostgreSQL facts. */
export class PostgresDiscoveryLedger implements DiscoveryLedgerPort {
  private readonly database: DatabasePort; private readonly clock: Clock; private readonly id: string;
  constructor(input: { database: DatabasePort; clock: Clock; id?: string }) {
    this.database = input.database; this.clock = input.clock; this.id = input.id ?? "event-discovery";
  }
  private async ensure(tx: SqlExecutor, now: string): Promise<void> {
    await tx.query("INSERT INTO operations_discovery_state(id,quota_day) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [this.id, now.slice(0, 10)]);
  }
  private async locked(tx: SqlExecutor, now: string): Promise<StateRow> {
    await this.ensure(tx, now);
    const result = await tx.query<StateRow>("SELECT * FROM operations_discovery_state WHERE id=$1 FOR UPDATE", [this.id]);
    if (!result.rows[0]) throw new DomainError("DISCOVERY_STATE_MISSING", "发现调度状态不存在。", { status: 503 });
    return result.rows[0];
  }
  private async leased(tx: SqlExecutor, token: string, now: string): Promise<StateRow> {
    const row = await this.locked(tx, now);
    // A row-lock wait can outlive the caller's captured timestamp.
    if (row.lease_token !== token || !row.lease_expires_at || Date.parse(iso(row.lease_expires_at)!) <= this.clock.now().getTime()) throw new DomainError("DISCOVERY_LEASE_LOST", "发现调度租约已失效。", { status: 409 });
    if (row.paused) throw new DomainError("DISCOVERY_PAUSED", "发现调度已暂停。", { status: 409 });
    return row;
  }
  async beginCycle(input: Parameters<DiscoveryLedgerPort["beginCycle"]>[0]): ReturnType<DiscoveryLedgerPort["beginCycle"]> {
    return this.database.transaction(async tx => {
      const row = await this.locked(tx, input.now);
      const currentNow = this.clock.now().toISOString();
      if (row.paused) return { skipped: "paused" };
      if (row.lease_token && row.lease_expires_at && Date.parse(iso(row.lease_expires_at)!) > Date.parse(currentNow)) return { skipped: "busy" };
      if (row.next_eligible_at && Date.parse(iso(row.next_eligible_at)!) > Date.parse(currentNow)) return { skipped: "not_due" };
      const quotaDay = currentNow.slice(0, 10); const sameDay = row.quota_day === quotaDay;
      const searchCalls = (sameDay ? row.search_calls : 0) + input.reservation.searchCalls;
      const modelCalls = (sameDay ? row.model_calls : 0) + input.reservation.modelCalls;
      const estimatedCostMicros = (sameDay ? Number(row.estimated_cost_micros) : 0) + input.reservation.estimatedCostMicros;
      if (sameDay && Number(row.estimated_cost_micros) > 0 && row.currency !== input.limits.currency) throw new DomainError("DISCOVERY_CURRENCY_CHANGED", "同一配额日内不能更换费用币种。");
      if (searchCalls > input.limits.maxSearchCallsPerDay || modelCalls > input.limits.maxModelCallsPerDay || estimatedCostMicros > input.limits.maxEstimatedCostMicrosPerDay) return { skipped: "daily_limit" };
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.parse(currentNow) + input.leaseMs).toISOString();
      const nextEligibleAt = new Date(Date.parse(currentNow) + input.minimumIntervalMs).toISOString();
      await tx.query(`UPDATE operations_discovery_state SET revision=revision+1,quota_day=$2,search_calls=$3,model_calls=$4,
        estimated_cost_micros=$5,currency=$6,lease_token=$7,lease_expires_at=$8::timestamptz,worker_id=$9,
        reservation=$10::jsonb,next_eligible_at=$11::timestamptz WHERE id=$1`,
        [this.id, quotaDay, searchCalls, modelCalls, estimatedCostMicros, input.limits.currency, token, expiresAt, input.workerId, JSON.stringify(input.reservation), nextEligibleAt]);
      return { lease: { token, expiresAt } };
    });
  }
  async claimSearch(input: Parameters<DiscoveryLedgerPort["claimSearch"]>[0]): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new DomainError("INVALID_DISCOVERY_REQUEST_HASH", "发现搜索请求标识无效。");
    return this.database.transaction(async tx => {
      const lease = await this.leased(tx, input.token, input.now);
      const found = await tx.query<{ last_error_code: string | null }>("SELECT last_error_code FROM operations_discovery_search_attempts WHERE scheduler_id=$1 AND request_hash=$2 FOR UPDATE", [this.id, input.requestHash]);
      if (Date.parse(iso(lease.lease_expires_at)!) <= this.clock.now().getTime()) throw new DomainError("DISCOVERY_LEASE_LOST", "发现调度租约已失效。", { status: 409 });
      if (found.rows[0]?.last_error_code === DISCOVERY_SEARCH_REQUIRES_REVIEW) return false;
      await tx.query(`INSERT INTO operations_discovery_search_attempts(scheduler_id,request_hash,last_attempt_at,cycle_token,last_error_code)
        VALUES($1,$2,$3::timestamptz,$4,$5) ON CONFLICT(scheduler_id,request_hash)
        DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,cycle_token=EXCLUDED.cycle_token,last_error_code=EXCLUDED.last_error_code`,
        [this.id, input.requestHash, this.clock.now().toISOString(), input.token, DISCOVERY_SEARCH_REQUIRES_REVIEW]);
      if (Date.parse(iso(lease.lease_expires_at)!) <= this.clock.now().getTime()) throw new DomainError("DISCOVERY_LEASE_LOST", "发现搜索登记期间租约已失效。", { status: 409 });
      return true;
    });
  }
  async recordSearch(input: Parameters<DiscoveryLedgerPort["recordSearch"]>[0]): Promise<void> {
    await this.database.transaction(async tx => {
      const lease = await this.leased(tx, input.token, input.now);
      const result = await tx.query("UPDATE operations_discovery_search_attempts SET last_error_code=$4 WHERE scheduler_id=$1 AND request_hash=$2 AND cycle_token=$3",
        [this.id, input.requestHash, input.token, input.errorCode]);
      if (result.rowCount !== 1) conflict();
      if (Date.parse(iso(lease.lease_expires_at)!) <= this.clock.now().getTime()) throw new DomainError("DISCOVERY_LEASE_LOST", "发现搜索结算期间租约已失效。", { status: 409 });
    });
  }
  async claimUrl(input: Parameters<DiscoveryLedgerPort["claimUrl"]>[0]): ReturnType<DiscoveryLedgerPort["claimUrl"]> {
    return this.database.transaction(async tx => {
      const lease = await this.leased(tx, input.token, input.now);
      const found = await tx.query<{ last_attempt_at: string | Date; content_hash: string | null; last_error_code: string | null }>("SELECT last_attempt_at,content_hash,last_error_code FROM operations_discovery_urls WHERE scheduler_id=$1 AND canonical_url=$2 FOR UPDATE", [this.id, input.canonicalUrl]);
      const previous = found.rows[0];
      const currentNow = this.clock.now().toISOString();
      if (Date.parse(iso(lease.lease_expires_at)!) <= Date.parse(currentNow)) throw new DomainError("DISCOVERY_LEASE_LOST", "发现调度租约已失效。", { status: 409 });
      if (previous && Date.parse(iso(previous.last_attempt_at)!) + input.recrawlAfterMs > Date.parse(currentNow)) {
        // An unresolved model outcome remains a failure during cooldown. Returning
        // null here would let the worker report it as an unchanged success.
        return previous.last_error_code === DISCOVERY_MODEL_REQUIRES_REVIEW
          ? { previousContentHash: previous.content_hash, previousErrorCode: previous.last_error_code, fetchDue: false }
          : null;
      }
      await tx.query(`INSERT INTO operations_discovery_urls(scheduler_id,canonical_url,last_attempt_at,cycle_token)
        VALUES($1,$2,$3::timestamptz,$4) ON CONFLICT(scheduler_id,canonical_url)
        DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,cycle_token=EXCLUDED.cycle_token`, [this.id, input.canonicalUrl, currentNow, input.token]);
      return { previousContentHash: previous?.content_hash ?? null, previousErrorCode: previous?.last_error_code ?? null, fetchDue: true };
    });
  }
  async assertCycle(input: { token: string }): Promise<void> {
    await this.database.transaction(async tx => { await this.leased(tx, input.token, this.clock.now().toISOString()); });
  }
  async commitCandidate(input: Parameters<DiscoveryLedgerPort["commitCandidate"]>[0], save: Parameters<DiscoveryLedgerPort["commitCandidate"]>[1]): ReturnType<DiscoveryLedgerPort["commitCandidate"]> {
    return this.database.transaction(async tx => {
      const row = await this.leased(tx, input.token, this.clock.now().toISOString());
      if (input.signal.aborted) throw new DomainError("DISCOVERY_CANCELLED", "持续发现已停止。", { status: 409 });
      const claimed = await tx.query("SELECT 1 FROM operations_discovery_urls WHERE scheduler_id=$1 AND canonical_url=$2 AND cycle_token=$3 FOR UPDATE", [this.id, input.canonicalUrl, input.token]);
      if (claimed.rows.length !== 1) conflict();
      const result = await save();
      if (!result.id || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new DomainError("DISCOVERY_SAVE_INVALID", "发现卡片保存未返回有效版本。");
      if (input.signal.aborted || Date.parse(iso(row.lease_expires_at)!) <= this.clock.now().getTime()) throw new DomainError("DISCOVERY_LEASE_LOST", "发现卡片保存期间租约已停止。", { status: 409 });
      await tx.query("UPDATE operations_discovery_urls SET content_hash=$4,candidate_id=$5,last_error_code=NULL,last_completed_at=$6::timestamptz WHERE scheduler_id=$1 AND canonical_url=$2 AND cycle_token=$3",
        [this.id, input.canonicalUrl, input.token, input.contentHash, result.id, this.clock.now().toISOString()]);
      if (input.signal.aborted || Date.parse(iso(row.lease_expires_at)!) <= this.clock.now().getTime()) throw new DomainError("DISCOVERY_LEASE_LOST", "发现卡片提交前租约已停止。", { status: 409 });
      return result;
    });
  }
  async recordUrl(input: Parameters<DiscoveryLedgerPort["recordUrl"]>[0]): Promise<void> {
    await this.database.transaction(async tx => {
      await this.leased(tx, input.token, input.now);
      const result = await tx.query(`UPDATE operations_discovery_urls SET content_hash=COALESCE($4,content_hash),candidate_id=COALESCE($5,candidate_id),
        last_error_code=$6,last_completed_at=CASE WHEN $6::text IS NULL THEN $7::timestamptz ELSE last_completed_at END WHERE scheduler_id=$1 AND canonical_url=$2 AND cycle_token=$3`,
        [this.id, input.canonicalUrl, input.token, input.contentHash, input.candidateId, input.errorCode, this.clock.now().toISOString()]);
      if (result.rowCount !== 1) conflict();
    });
  }
  async finishCycle(input: Parameters<DiscoveryLedgerPort["finishCycle"]>[0]): Promise<void> {
    await this.database.transaction(async tx => {
      // Paused/expired work may release only its own lease; it cannot mutate a replacement cycle.
      const row = await this.locked(tx, input.now);
      if (row.lease_token !== input.token || !row.reservation) throw new DomainError("DISCOVERY_LEASE_LOST", "发现调度租约已失效。", { status: 409 });
      const reserved = row.reservation;
      await tx.query(`UPDATE operations_discovery_state SET revision=revision+1,search_calls=search_calls-$2+$3,
        model_calls=model_calls-$4+$5,estimated_cost_micros=estimated_cost_micros-$6+$7,lease_token=NULL,
        lease_expires_at=NULL,reservation=NULL,last_completed_at=$8::timestamptz,last_error_code=$9 WHERE id=$1`,
        [this.id, reserved.searchCalls, input.consumed.searchCalls, reserved.modelCalls, input.consumed.modelCalls,
          reserved.estimatedCostMicros, input.consumed.estimatedCostMicros, input.now, input.errorCode]);
    });
  }
  async readState(): Promise<DiscoveryState> {
    return this.database.transaction(async tx => state(await this.locked(tx, this.clock.now().toISOString())));
  }
  async setPaused(input: Parameters<DiscoveryLedgerPort["setPaused"]>[0]): Promise<DiscoveryState> {
    return this.database.transaction(async tx => {
      const current = await this.locked(tx, input.now);
      if (!Number.isSafeInteger(input.expectedRevision) || current.revision !== input.expectedRevision || typeof input.paused !== "boolean") conflict();
      const updated = await tx.query<StateRow>("UPDATE operations_discovery_state SET revision=revision+1,paused=$2 WHERE id=$1 AND revision=$3 RETURNING *", [this.id, input.paused, input.expectedRevision]);
      if (!updated.rows[0]) conflict();
      await tx.query("INSERT INTO operations_discovery_control_audit(scheduler_id,actor_id,revision,paused,occurred_at) VALUES($1,$2,$3,$4,$5::timestamptz)", [this.id, input.actorId, updated.rows[0].revision, input.paused, input.now]);
      return state(updated.rows[0]);
    });
  }
}
