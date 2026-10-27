import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ExecutionAudit, SourceConfig } from "./source-domain.ts";
import type { ExecutionKind, ExecutionRun } from "./run-domain.ts";
import type { OperationsExecutionRepository, OperationsExecutionTransaction } from "./run-repository.ts";

interface SourceRow {
  data: SourceConfig;
  next_eligible_at: string | Date | null;
  last_success_at: string | Date | null;
  last_failure_at: string | Date | null;
  consecutive_failures: number;
}
const instant = (value: string | Date | null): string | null => value === null ? null : new Date(value).toISOString();
const mapSource = (row: SourceRow): SourceConfig => ({ ...row.data, health: { nextEligibleAt: instant(row.next_eligible_at), lastSuccessAt: instant(row.last_success_at), lastFailureAt: instant(row.last_failure_at), consecutiveFailures: row.consecutive_failures } });
const sourceColumns = "data,next_eligible_at,last_success_at,last_failure_at,consecutive_failures";
const conflict = (): never => { throw new DomainError("VERSION_CONFLICT", "记录已被其他操作更新，请重新加载。", { status: 409, recoveryAction: "review_latest_version" }); };

/** This adapter is a control-plane dependency. Never give the isolated worker the
 * DatabasePort or database credentials: worker calls authenticated narrow endpoints. */
export class PostgreSqlOperationsExecutionRepository implements OperationsExecutionRepository {
  private readonly db: DatabasePort;
  constructor(db: DatabasePort) { this.db = db; }
  transaction<T>(work: (tx: OperationsExecutionTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((sql) => work(new PostgreSqlExecutionTransaction(sql)));
  }
  async getSource(id: string): Promise<SourceConfig | null> { return new PostgreSqlExecutionTransaction(this.db).getSource(id); }
  async listSources(limit: number): Promise<readonly SourceConfig[]> {
    const result = await this.db.query<SourceRow>(`SELECT ${sourceColumns} FROM operations_source_configs ORDER BY created_at DESC,id DESC LIMIT $1`, [limit]);
    return result.rows.map(mapSource);
  }
  async getRun(id: string): Promise<ExecutionRun | null> { return new PostgreSqlExecutionTransaction(this.db).getRun(id); }
  async listRuns(limit: number): Promise<readonly ExecutionRun[]> {
    const result = await this.db.query<{ data: ExecutionRun }>("SELECT data FROM operations_execution_runs ORDER BY created_at DESC,id DESC LIMIT $1", [limit]);
    return result.rows.map((row) => row.data);
  }
  async findExpiredRuns(now: string, limit: number): Promise<readonly ExecutionRun[]> {
    const result = await this.db.query<{ data: ExecutionRun }>("SELECT r.data FROM operations_execution_runs r JOIN operations_source_configs s ON s.id=r.source_config_id WHERE r.status IN ('queued','running') AND ((r.status='running' AND r.lease_expires_at <= $1::timestamptz) OR s.status <> 'enabled' OR (r.kind='crawl' AND (r.data->'sourceSnapshot'->>'revision')::integer <> s.revision)) ORDER BY r.lease_expires_at NULLS FIRST,r.id LIMIT $2", [now, limit]);
    return result.rows.map((row) => row.data);
  }
}

class PostgreSqlExecutionTransaction implements OperationsExecutionTransaction {
  private readonly sql: SqlExecutor;
  constructor(sql: SqlExecutor) { this.sql = sql; }
  async acquireLock(key: string): Promise<void> {
    await this.sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
  }
  async getSource(id: string, lock = false): Promise<SourceConfig | null> {
    const result = await this.sql.query<SourceRow>(`SELECT ${sourceColumns} FROM operations_source_configs WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ? mapSource(result.rows[0]) : null;
  }
  async insertSource(source: SourceConfig): Promise<void> {
    await this.sql.query("INSERT INTO operations_source_configs(id,revision,status,data,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz,$6::timestamptz)", [source.id, source.revision, source.status, JSON.stringify(source), source.createdAt, source.updatedAt]);
  }
  async saveSource(source: SourceConfig, expectedRevision: number): Promise<void> {
    const result = await this.sql.query("UPDATE operations_source_configs SET revision=$2,status=$3,data=$4::jsonb,updated_at=$5::timestamptz WHERE id=$1 AND revision=$6", [source.id, source.revision, source.status, JSON.stringify(source), source.updatedAt, expectedRevision]);
    if (result.rowCount !== 1) conflict();
  }
  async reserveSourceInterval(sourceId: string, nextEligibleAt: string): Promise<void> {
    const result = await this.sql.query("UPDATE operations_source_configs SET next_eligible_at=GREATEST(COALESCE(next_eligible_at,$2::timestamptz),$2::timestamptz) WHERE id=$1", [sourceId, nextEligibleAt]);
    if (result.rowCount !== 1) throw new DomainError("SOURCE_NOT_FOUND", "未找到来源配置。", { status: 404 });
  }
  async recordSourceHealth(sourceId: string, success: boolean, at: string): Promise<void> {
    const result = await this.sql.query(success
      ? "UPDATE operations_source_configs SET last_success_at=$2::timestamptz,consecutive_failures=0 WHERE id=$1"
      : "UPDATE operations_source_configs SET last_failure_at=$2::timestamptz,consecutive_failures=consecutive_failures+1 WHERE id=$1", [sourceId, at]);
    if (result.rowCount !== 1) throw new DomainError("SOURCE_NOT_FOUND", "未找到来源配置。", { status: 404 });
  }
  async getRun(id: string, lock = false): Promise<ExecutionRun | null> {
    // Keys never change; NO KEY UPDATE lets a concurrent request alias take its FK
    // KEY SHARE lock without a source-lock/run-lock cycle.
    const result = await this.sql.query<{ data: ExecutionRun }>(`SELECT data FROM operations_execution_runs WHERE id=$1${lock ? " FOR NO KEY UPDATE" : ""}`, [id]);
    return result.rows[0]?.data ?? null;
  }
  async findIdempotentRun(actorId: string, kind: ExecutionKind, key: string): Promise<{ run: ExecutionRun; fingerprint: string } | null> {
    const result = await this.sql.query<{ data: ExecutionRun; fingerprint: string }>("SELECT r.data,q.fingerprint FROM operations_execution_requests q JOIN operations_execution_runs r ON r.id=q.run_id WHERE q.actor_id=$1 AND q.kind=$2 AND q.idempotency_key=$3", [actorId, kind, key]);
    return result.rows[0] ? { run: result.rows[0].data, fingerprint: result.rows[0].fingerprint } : null;
  }
  async bindIdempotencyRun(actorId: string, kind: ExecutionKind, key: string, fingerprint: string, runId: string): Promise<void> {
    await this.sql.query("INSERT INTO operations_execution_requests(actor_id,kind,idempotency_key,fingerprint,run_id) VALUES($1,$2,$3,$4,$5)", [actorId, kind, key, fingerprint, runId]);
  }
  async findActiveCrawl(sourceConfigId: string): Promise<ExecutionRun | null> {
    const result = await this.sql.query<{ data: ExecutionRun }>("SELECT data FROM operations_execution_runs WHERE source_config_id=$1 AND kind='crawl' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", [sourceConfigId]);
    return result.rows[0]?.data ?? null;
  }
  async findReusableAnalysis(sourceConfigId: string, fingerprint: string): Promise<ExecutionRun | null> {
    const result = await this.sql.query<{ data: ExecutionRun }>("SELECT data FROM operations_execution_runs WHERE source_config_id=$1 AND kind='analysis' AND fingerprint=$2 AND status IN ('queued','running','succeeded') ORDER BY created_at DESC LIMIT 1", [sourceConfigId, fingerprint]);
    return result.rows[0]?.data ?? null;
  }
  async insertRun(run: ExecutionRun): Promise<void> {
    await this.sql.query("INSERT INTO operations_execution_runs(id,kind,source_config_id,revision,status,fingerprint,data,available_at,lease_expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::timestamptz)", [run.id, run.kind, run.sourceConfigId, run.revision, run.status, run.fingerprint, JSON.stringify(run), run.availableAt, run.lease?.expiresAt ?? null, run.createdAt, run.updatedAt]);
  }
  async saveRun(run: ExecutionRun, expectedRevision: number): Promise<void> {
    const result = await this.sql.query("UPDATE operations_execution_runs SET revision=$2,status=$3,data=$4::jsonb,available_at=$5::timestamptz,lease_expires_at=$6::timestamptz,updated_at=$7::timestamptz WHERE id=$1 AND revision=$8", [run.id, run.revision, run.status, JSON.stringify(run), run.availableAt, run.lease?.expiresAt ?? null, run.updatedAt, expectedRevision]);
    if (result.rowCount !== 1) conflict();
  }
  async appendAudit(event: ExecutionAudit): Promise<void> {
    await this.sql.query("INSERT INTO operations_execution_audit(id,actor_kind,actor_id,action,entity_id,revision,reason,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)", [event.id, event.actorKind, event.actorId, event.action, event.entityId, event.revision, event.reason, event.occurredAt]);
  }
}
