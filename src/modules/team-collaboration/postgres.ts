import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SuggestionAudit, TeamCollaborationRepository, TeamCollaborationTransaction } from "./repository.ts";
import type { SuggestionReceipt, TeamSuggestion } from "./types.ts";

type SuggestionRow = { body: TeamSuggestion | string };
function decode(row: SuggestionRow | undefined): TeamSuggestion | null { return row ? typeof row.body === "string" ? JSON.parse(row.body) as TeamSuggestion : structuredClone(row.body) : null; }
function conflict(latestRevision?: number): never { throw new DomainError("VERSION_CONFLICT", "建议已更新，请先读取最新版本。", { status: 409, latestRevision, recoveryAction: "review_latest_version" }); }
function valid(value: TeamSuggestion): void {
  if (!value.id || !value.projectId || !value.authorUserId || !value.authorMembershipId || !Number.isSafeInteger(value.revision) || value.revision < 1 || !["discussion", "adopted", "withdrawn"].includes(value.status) || !Number.isFinite(Date.parse(value.updatedAt)) || !Number.isFinite(Date.parse(value.createdAt))) throw new DomainError("INVALID_INPUT", "建议记录格式无效。");
  if (value.status === "withdrawn" && (value.title !== "" || value.body !== "" || value.withdrawnAt === null)) throw new DomainError("INVALID_INPUT", "撤回记录不能包含共享正文。");
}

class PostgresTeamCollaborationTransaction implements TeamCollaborationTransaction {
  readonly sql: SqlExecutor;
  private readonly projectId: string;
  private readonly readOnly: boolean;
  constructor(sql: SqlExecutor, projectId: string, readOnly = false) { this.sql = sql; this.projectId = projectId; this.readOnly = readOnly; }
  private assertWritable(): void { if (this.readOnly) throw new DomainError("READ_ONLY_TRANSACTION", "只读动态事务不能保存记录。", { status: 409 }); }
  async get(id: string): Promise<TeamSuggestion | null> {
    return decode((await this.sql.query<SuggestionRow>(`SELECT body FROM r02_team_suggestions WHERE project_id=$1 AND id=$2${this.readOnly ? "" : " FOR UPDATE"}`, [this.projectId, id])).rows[0]);
  }
  async list(limit: number): Promise<TeamSuggestion[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "读取数量无效。");
    return (await this.sql.query<SuggestionRow>("SELECT body FROM r02_team_suggestions WHERE project_id=$1 ORDER BY updated_at DESC, id ASC LIMIT $2", [this.projectId, limit])).rows.map(row => decode(row)!);
  }
  async insert(value: TeamSuggestion, audit: SuggestionAudit): Promise<void> {
    this.assertWritable();
    valid(value); if (value.projectId !== this.projectId || value.revision !== 1) throw new DomainError("INVALID_INPUT", "新建议必须属于当前项目并从第一版开始。");
    const result = await this.sql.query("INSERT INTO r02_team_suggestions (id,project_id,author_user_id,revision,status,updated_at,body) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id", [value.id, value.projectId, value.authorUserId, value.revision, value.status, value.updatedAt, JSON.stringify(value)]);
    if (result.rowCount !== 1) conflict();
    await this.record(value, audit);
  }
  async replace(value: TeamSuggestion, expectedRevision: number, audit: SuggestionAudit): Promise<void> {
    this.assertWritable();
    valid(value);
    const previous = await this.get(value.id);
    if (!previous) throw new DomainError("NOT_FOUND", "建议不存在。", { status: 404 });
    if (previous.revision !== expectedRevision) conflict(previous.revision);
    const sourceChanged = previous.source.sourceKind !== value.source.sourceKind || previous.source.sourceId !== value.source.sourceId || previous.source.label !== value.source.label || previous.source.revision !== value.source.revision;
    if (value.projectId !== this.projectId || value.revision !== expectedRevision + 1 || previous.authorUserId !== value.authorUserId || previous.authorMembershipId !== value.authorMembershipId || previous.createdAt !== value.createdAt || sourceChanged || previous.status === "withdrawn") throw new DomainError("INVALID_INPUT", "建议归属、来源与创建信息不能修改，撤回记录不能恢复。");
    const result = await this.sql.query("UPDATE r02_team_suggestions SET revision=$3,status=$4,updated_at=$5::timestamptz,body=$6::jsonb WHERE project_id=$1 AND id=$2 AND revision=$7 RETURNING id", [this.projectId, value.id, value.revision, value.status, value.updatedAt, JSON.stringify(value), expectedRevision]);
    if (result.rowCount !== 1) conflict();
    await this.record(value, audit);
  }
  private async record(value: TeamSuggestion, audit: SuggestionAudit): Promise<void> {
    if (audit.projectId !== value.projectId || audit.suggestionId !== value.id || audit.revision !== value.revision || audit.occurredAt !== value.updatedAt) throw new DomainError("INVALID_INPUT", "审计记录须对应当前建议版本。");
    await this.sql.query("INSERT INTO r02_team_suggestion_versions (suggestion_id,revision,body,recorded_at) VALUES ($1,$2,$3::jsonb,$4::timestamptz)", [value.id, value.revision, JSON.stringify(value), value.updatedAt]);
    await this.sql.query("INSERT INTO r02_team_suggestion_audit (id,project_id,suggestion_id,actor_user_id,action,revision,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)", [audit.id, audit.projectId, audit.suggestionId, audit.actorUserId, audit.action, audit.revision, audit.occurredAt]);
  }
  async getReceipt(scope: string, key: string, fingerprint: string): Promise<SuggestionReceipt | null> {
    const row = (await this.sql.query<{ fingerprint: string; receipt: SuggestionReceipt | string }>("SELECT fingerprint,receipt FROM r02_team_suggestion_idempotency WHERE project_id=$1 AND scope=$2 AND key=$3", [this.projectId, scope, key])).rows[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一操作标识对应的内容已变更，请核对后发起新的操作。", { status: 409 });
    return typeof row.receipt === "string" ? JSON.parse(row.receipt) as SuggestionReceipt : structuredClone(row.receipt);
  }
  async putReceipt(scope: string, key: string, fingerprint: string, receipt: SuggestionReceipt): Promise<void> {
    this.assertWritable();
    await this.sql.query("INSERT INTO r02_team_suggestion_idempotency (project_id,scope,key,fingerprint,receipt) VALUES ($1,$2,$3,$4,$5::jsonb)", [this.projectId, scope, key, fingerprint, JSON.stringify(receipt)]);
  }
}

/** Parameterized persistent storage; root applies the proposed migration and owns the actual connection. */
export class PostgresTeamCollaborationRepository implements TeamCollaborationRepository {
  private readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  readTransaction<T>(projectId: string, work: (transaction: TeamCollaborationTransaction) => Promise<T>): Promise<T> {
    // Reads take current M02/source guards first and never wait for the feed writer head.
    // This avoids the reverse project→feed order when called from a root AI context transaction.
    return this.database.transaction(sql => work(new PostgresTeamCollaborationTransaction(sql, projectId, true)));
  }
  transaction<T>(projectId: string, work: (transaction: TeamCollaborationTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(async sql => {
      await sql.query("INSERT INTO r02_team_feed_projects(project_id) VALUES ($1) ON CONFLICT(project_id) DO NOTHING", [projectId]);
      await sql.query("SELECT project_id FROM r02_team_feed_projects WHERE project_id=$1 FOR UPDATE", [projectId]);
      return work(new PostgresTeamCollaborationTransaction(sql, projectId));
    });
  }
}
