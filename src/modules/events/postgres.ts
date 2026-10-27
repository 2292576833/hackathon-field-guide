import type { PageResult } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { deriveEventPhase } from "./domain.ts";
import type { EventRuleVersion } from "./domain.ts";
import type {
  AnalysisRun, EventAnalysis, EventCorrection, EventFilter, EventRecord, EventsAudit,
  EventsRepository, EventsUnitOfWork, ProjectRuleConfirmation, PublicEvent,
} from "./model.ts";

type DocumentTable = "m03_events" | "m03_project_rules" | "m03_event_analyses" | "m03_analysis_runs";
function conflict(): never {
  throw new DomainError("VERSION_CONFLICT", "内容已被更新，请查看最新版本后重试。", { status: 409, recoveryAction: "review_latest_version" });
}
class PostgresEventsUnitOfWork implements EventsUnitOfWork {
  readonly executor: SqlExecutor;
  private readonly locking: boolean;
  constructor(executor: SqlExecutor, locking = false) { this.executor = executor; this.locking = locking; }
  private async get<T>(table: DocumentTable, id: string): Promise<T | null> {
    const result = await this.executor.query<{ body: T }>(`SELECT body FROM ${table} WHERE id = $1${this.locking ? " FOR UPDATE" : ""}`, [id]);
    return result.rows[0]?.body ?? null;
  }
  private async save(table: DocumentTable, id: string, value: { revision: number }, expectedRevision: number): Promise<void> {
    if (value.revision !== expectedRevision + 1) throw new DomainError("INVALID_REVISION", "写入版本必须递增一次。");
    const result = expectedRevision === 0
      ? await this.executor.query(`INSERT INTO ${table} (id, revision, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`, [id, value.revision, JSON.stringify(value)])
      : await this.executor.query(`UPDATE ${table} SET revision = $2, body = $3::jsonb WHERE id = $1 AND revision = $4`, [id, value.revision, JSON.stringify(value), expectedRevision]);
    if (result.rowCount !== 1) conflict();
  }
  getEvent(id: string): Promise<EventRecord | null> { return this.get("m03_events", id); }
  saveEvent(value: EventRecord, expected: number): Promise<void> { return this.save("m03_events", value.id, value, expected); }
  async getRules(eventId: string, version: number): Promise<EventRuleVersion | null> {
    const result = await this.executor.query<{ body: EventRuleVersion }>("SELECT body FROM m03_rule_versions WHERE event_id = $1 AND version = $2", [eventId, version]);
    return result.rows[0]?.body ?? null;
  }
  async insertRules(rules: EventRuleVersion): Promise<void> {
    const result = await this.executor.query("INSERT INTO m03_rule_versions (event_id, version, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING", [rules.eventId, rules.version, JSON.stringify(rules)]);
    if (result.rowCount !== 1) conflict();
  }
  getConfirmation(projectId: string): Promise<ProjectRuleConfirmation | null> { return this.get("m03_project_rules", projectId); }
  saveConfirmation(value: ProjectRuleConfirmation, expected: number): Promise<void> { return this.save("m03_project_rules", value.projectId, value, expected); }
  getAnalysis(id: string): Promise<EventAnalysis | null> { return this.get("m03_event_analyses", id); }
  saveAnalysis(value: EventAnalysis, expected: number): Promise<void> { return this.save("m03_event_analyses", value.id, value, expected); }
  getRun(id: string): Promise<AnalysisRun | null> { return this.get("m03_analysis_runs", id); }
  async findRun(projectId: string, actorId: string, key: string): Promise<AnalysisRun | null> {
    const result = await this.executor.query<{ body: AnalysisRun }>(`SELECT body FROM m03_analysis_runs WHERE body->>'projectId' = $1 AND body->>'actorId' = $2 AND body->>'idempotencyKey' = $3${this.locking ? " FOR UPDATE" : ""}`, [projectId, actorId, key]);
    return result.rows[0]?.body ?? null;
  }
  saveRun(value: AnalysisRun, expected: number): Promise<void> { return this.save("m03_analysis_runs", value.id, value, expected); }
  async insertCorrection(value: EventCorrection): Promise<void> {
    await this.executor.query("INSERT INTO m03_event_corrections (id, event_id, version, body) VALUES ($1, $2, $3, $4::jsonb)", [value.id, value.eventId, value.rulesVersion, JSON.stringify(value)]);
  }
  async appendAudit(value: EventsAudit): Promise<void> {
    await this.executor.query("INSERT INTO m03_events_outbox (id, type, aggregate_id, project_id, version, occurred_at, body) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)", [value.id, value.type, value.aggregateId, value.projectId, value.version, value.occurredAt, JSON.stringify(value)]);
  }
}

export class PostgresEventsRepository extends PostgresEventsUnitOfWork implements EventsRepository {
  private readonly database: DatabasePort;
  constructor(database: DatabasePort) { super(database); this.database = database; }
  transaction<T>(work: (transaction: EventsUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction(executor => work(new PostgresEventsUnitOfWork(executor, true)));
  }
  async listAnalysisRuns(status: "queued" | "running", limit: number): Promise<readonly AnalysisRun[]> {
    if (!["queued", "running"].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DomainError("INVALID_WORKER_BATCH", "任务批次或状态无效。");
    const result = await this.database.query<{ body: AnalysisRun }>(
      "SELECT body FROM m03_analysis_runs WHERE body->>'status' = $1 ORDER BY CASE WHEN $1 = 'queued' THEN body->>'queuedAt' ELSE body->>'startedAt' END, id LIMIT $2", [status, limit],
    );
    return result.rows.map(row => row.body);
  }
  async listPublished(filter: EventFilter, now: Date): Promise<PageResult<PublicEvent>> {
    const limit = filter.limit ?? 20;
    const selected: PublicEvent[] = [];
    let cursor = filter.cursor ?? "";
    // SQL handles indexed public visibility and simple filters. Phase is calculated
    // from validated timezone-aware stage records, retaining unknown date precision.
    while (selected.length <= limit) {
      const parameters: unknown[] = [cursor];
      const conditions = ["e.id > $1 COLLATE \"C\"", "e.body->>'publicationStatus' <> 'archived'", "e.body->>'publishedVersion' IS NOT NULL"];
      const bind = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
      if (filter.query) conditions.push(`position(lower(${bind(filter.query)}) in lower(v.body->'metadata'->>'name')) > 0`);
      if (filter.region) conditions.push(`v.body->'metadata'->>'region' = ${bind(filter.region)}`);
      if (filter.format) conditions.push(`v.body->'metadata'->>'format' = ${bind(filter.format)}`);
      if (filter.beginnerEligibility === "verified") conditions.push("EXISTS (SELECT 1 FROM jsonb_array_elements(v.body->'facts') AS fact WHERE fact->>'key' = 'beginner_eligibility' AND fact->>'status' = 'verified')");
      if (filter.beginnerEligibility === "unknown") conditions.push("NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.body->'facts') AS fact WHERE fact->>'key' = 'beginner_eligibility' AND fact->>'status' = 'verified')");
      const rows = await this.database.query<{ event: EventRecord; rules: EventRuleVersion }>(`
        SELECT e.body AS event, v.body AS rules FROM m03_events e
        JOIN m03_rule_versions v ON v.event_id = e.id AND v.version = (e.body->>'publishedVersion')::integer
        WHERE ${conditions.join(" AND ")} ORDER BY e.id COLLATE "C" LIMIT 100`, parameters);
      for (const row of rows.rows) {
        cursor = row.event.id;
        if (!filter.phase || deriveEventPhase(row.rules, now) === filter.phase) selected.push(row);
        if (selected.length > limit) break;
      }
      if (selected.length > limit || rows.rows.length < 100) break;
    }
    return { items: selected.slice(0, limit), nextCursor: selected.length > limit ? selected[limit - 1]!.event.id : null };
  }
}
