import { randomUUID } from "node:crypto";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DraftStorePort, FileChange, GitOperation, GitRepositoryStore, RepositoryBinding } from "./types.ts";

function decode<T>(payload: T | string): T { return typeof payload === "string" ? JSON.parse(payload) as T : payload; }
const conflict = () => new DomainError("VERSION_CONFLICT", "该记录已更新，请读取最新状态。", { status: 409, recoveryAction: "review_latest_version" });
function retainRecoveryContents(payload: "payload" | "operation.payload"): string {
  // A lease remains a recovery marker after expiry. Only reconciliation may settle an uncertain operation.
  return `(COALESCE(${payload}->>'status','') NOT IN ('draft','ready_for_preview','saved','blocked','failed')
    OR ${payload}->>'leaseUntil' IS NOT NULL
    OR COALESCE(${payload}->>'pullRequestStatus','')='unknown'
    OR (COALESCE(${payload}->>'step','')='pull_request' AND COALESCE(${payload}->>'pullRequestStatus','')='pending')
    OR (COALESCE(${payload}->>'status','')<>'saved' AND (${payload}->>'treeSha' IS NOT NULL OR ${payload}->>'commitSha' IS NOT NULL)))`;
}
async function audit(sql: SqlExecutor, type: string, id: string, projectId: string, version: number, actorId: string, details: Record<string, unknown>): Promise<void> {
  await sql.query("INSERT INTO github_audit_events (id,event_type,aggregate_id,project_id,version,actor_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)", [randomUUID(), type, id, projectId, version, actorId, JSON.stringify(details)]);
}

export class PostgresGitRepositoryStore implements GitRepositoryStore {
  private readonly db: DatabasePort;
  constructor(db: DatabasePort) { this.db = db; }
  async getBinding(projectId: string): Promise<RepositoryBinding | null> {
    const result = await this.db.query<{ payload: RepositoryBinding }>("SELECT payload FROM github_repository_bindings WHERE project_id=$1", [projectId]);
    return result.rows[0] ? decode(result.rows[0].payload) : null;
  }
  async saveBinding(binding: RepositoryBinding, expectedRevision: number | null): Promise<void> {
    await this.db.transaction(async sql => {
      const result = expectedRevision === null
        ? await sql.query("INSERT INTO github_repository_bindings (id,project_id,revision,payload) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (project_id) DO NOTHING RETURNING id", [binding.id, binding.projectId, binding.revision, JSON.stringify(binding)])
        : await sql.query("UPDATE github_repository_bindings SET revision=$3,payload=$4::jsonb WHERE project_id=$1 AND revision=$2 AND id=$5 RETURNING id", [binding.projectId, expectedRevision, binding.revision, JSON.stringify(binding), binding.id]);
      if (result.rowCount !== 1) throw conflict();
      await audit(sql, binding.status === "bound" ? "RepositoryBound" : "RepositoryUnbound", binding.id, binding.projectId, binding.revision, binding.lastChangedBy ?? binding.boundBy, { repositoryId: binding.repositoryId, status: binding.status });
    });
  }
  async createOperation(operation: GitOperation): Promise<GitOperation> {
    return this.db.transaction(async sql => {
      const result = await sql.query<{ payload: GitOperation }>("INSERT INTO github_operations (id,project_id,actor_id,idempotency_key,input_hash,revision,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (project_id,actor_id,idempotency_key) DO NOTHING RETURNING payload", [operation.id, operation.projectId, operation.actorId, operation.idempotencyKey, operation.inputHash, operation.revision, JSON.stringify(operation)]);
      if (result.rows[0]) {
        await audit(sql, "GitDraftCreated", operation.id, operation.projectId, operation.revision, operation.actorId, { inputHash: operation.inputHash });
        return decode(result.rows[0].payload);
      }
      const old = await sql.query<{ payload: GitOperation; input_hash: string }>("SELECT payload,input_hash FROM github_operations WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3", [operation.projectId, operation.actorId, operation.idempotencyKey]);
      if (!old.rows[0] || old.rows[0].input_hash !== operation.inputHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "相同幂等键已经用于不同内容，请使用新操作。", { status: 409 });
      return decode(old.rows[0].payload);
    });
  }
  async getOperation(projectId: string, operationId: string): Promise<GitOperation | null> {
    const result = await this.db.query<{ payload: GitOperation }>("SELECT payload FROM github_operations WHERE project_id=$1 AND id=$2", [projectId, operationId]);
    return result.rows[0] ? decode(result.rows[0].payload) : null;
  }
  async findOperationByKey(projectId: string, actorId: string, idempotencyKey: string): Promise<GitOperation | null> {
    const result = await this.db.query<{ payload: GitOperation }>("SELECT payload FROM github_operations WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3", [projectId, actorId, idempotencyKey]);
    return result.rows[0] ? decode(result.rows[0].payload) : null;
  }
  async listOperations(projectId: string): Promise<GitOperation[]> {
    const result = await this.db.query<{ payload: GitOperation }>("SELECT payload FROM github_operations WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100", [projectId]);
    return result.rows.map(row => decode(row.payload));
  }
  async updateOperation(operation: GitOperation, expectedRevision: number): Promise<void> {
    if (operation.revision !== expectedRevision + 1) throw conflict();
    await this.db.transaction(async sql => {
      const result = await sql.query("UPDATE github_operations SET revision=$4,payload=$5::jsonb WHERE project_id=$1 AND id=$2 AND revision=$3 AND actor_id=$6 AND input_hash=$7 RETURNING id", [operation.projectId, operation.id, expectedRevision, operation.revision, JSON.stringify(operation), operation.actorId, operation.inputHash]);
      if (result.rowCount !== 1) throw conflict();
      await audit(sql, operation.status === "saved" ? "GitSaveSucceeded" : operation.status === "blocked" ? "GitSaveBlocked" : "GitOperationUpdated", operation.id, operation.projectId, operation.revision, operation.actorId, { status: operation.status, step: operation.step, inputHash: operation.inputHash, errorCode: operation.errorCode, commitSha: operation.commitSha, pullRequestStatus: operation.pullRequestStatus });
    });
  }
}

/** Private short-lived UTF-8 uploads; suitable for small first-version drafts. */
export class PostgresDraftStore implements DraftStorePort {
  private readonly db: DatabasePort;
  constructor(db: DatabasePort) { this.db = db; }
  async put(input: { projectId: string; actorId: string; changes: FileChange[]; expiresAt: string }): Promise<string> {
    const payload = JSON.stringify(input.changes);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (input.changes.length > 100 || bytes > 6 * 1024 * 1024) throw new DomainError("DRAFT_QUOTA_EXCEEDED", "草稿文件超过本次限制，请缩小选择范围。");
    const ref = randomUUID();
    await this.db.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`github-drafts:${input.projectId}`]);
      const quota = await sql.query<{ count: string; bytes: string }>("SELECT count(*)::text AS count,COALESCE(sum(bytes),0)::text AS bytes FROM github_file_drafts WHERE project_id=$1 AND expires_at>now()", [input.projectId]);
      if (Number(quota.rows[0]?.count ?? 0) >= 40 || Number(quota.rows[0]?.bytes ?? 0) + bytes > 40 * 1024 * 1024) throw new DomainError("DRAFT_QUOTA_EXCEEDED", "项目临时文件空间已满，请清理或等待过期。", { status: 429 });
      await sql.query("INSERT INTO github_file_drafts (id,project_id,actor_id,payload,bytes,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)", [ref, input.projectId, input.actorId, payload, bytes, input.expiresAt]);
    });
    return ref;
  }
  async get(ref: string, projectId: string, actorId: string): Promise<FileChange[] | null> {
    const result = await this.db.query<{ payload: FileChange[] }>("SELECT payload FROM github_file_drafts WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND expires_at>now()", [ref, projectId, actorId]);
    return result.rows[0] ? decode(result.rows[0].payload) : null;
  }
  async remove(ref: string): Promise<void> { await this.db.query("DELETE FROM github_file_drafts WHERE id=$1", [ref]); }
  async purgeExpired(now: string): Promise<number> {
    if (typeof now !== "string" || now.length > 40 || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(now) || !Number.isFinite(Date.parse(now))) {
      throw new DomainError("GITHUB_MAINTENANCE_TIME_INVALID", "清理时间不符合要求。");
    }
    return this.db.transaction(async sql => {
      // Advance CAS before deleting drafts, including operations with no preview yet. A racing confirmation
      // either claims first (and is protected below) or loses its CAS; it cannot restore expired text.
      const files = "CASE WHEN jsonb_typeof(payload #> '{preview,files}')='array' THEN payload #> '{preview,files}' ELSE '[]'::jsonb END";
      await sql.query(`UPDATE github_operations SET revision=revision+1,payload=jsonb_set(jsonb_set(
        CASE WHEN jsonb_typeof(payload->'preview')='object' THEN jsonb_set(payload,'{preview,files}',
          COALESCE((SELECT jsonb_agg(file || '{\"before\":null,\"after\":null}'::jsonb) FROM jsonb_array_elements(${files}) AS file),'[]'::jsonb)) ELSE payload END,
        '{revision}',to_jsonb(revision+1)),'{updatedAt}',to_jsonb($2::text))
        WHERE NOT ${retainRecoveryContents("payload")} AND (
          EXISTS (SELECT 1 FROM github_file_drafts AS draft WHERE draft.id=github_operations.payload->>'draftRef'
            AND draft.project_id=github_operations.project_id AND draft.actor_id=github_operations.actor_id AND draft.expires_at<=$1::timestamptz)
          OR ((payload->>'expiresAt')::timestamptz<=$1::timestamptz AND EXISTS
            (SELECT 1 FROM jsonb_array_elements(${files}) AS file WHERE file->>'before' IS NOT NULL OR file->>'after' IS NOT NULL)))`, [now, new Date(now).toISOString()]);
      // Keep metadata and all uncertain/executing recovery materials. TTL does not revoke authorization.
      const result = await sql.query(`DELETE FROM github_file_drafts WHERE expires_at<=$1::timestamptz AND NOT EXISTS (
        SELECT 1 FROM github_operations AS operation WHERE operation.payload->>'draftRef'=github_file_drafts.id
          AND operation.project_id=github_file_drafts.project_id AND operation.actor_id=github_file_drafts.actor_id
          AND ${retainRecoveryContents("operation.payload")})`, [now]);
      return result.rowCount;
    });
  }
}
