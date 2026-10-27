import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { RepositoryCreationOperation, RepositoryCreationStorePort } from "./authorization-types.ts";
import { repositoryCreationInputHash } from "./repository-creation.ts";

function decode(value: RepositoryCreationOperation | string): RepositoryCreationOperation { return typeof value === "string" ? JSON.parse(value) as RepositoryCreationOperation : value; }
async function audit(sql: SqlExecutor, operation: RepositoryCreationOperation): Promise<void> {
  await sql.query(`INSERT INTO github_repository_creation_audit (id,operation_id,project_id,user_id,revision,event_type,details)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [randomUUID(), operation.id, operation.projectId, operation.userId, operation.revision,
    operation.status === "created" ? "RepositoryCreated" : "RepositoryCreationUpdated",
    JSON.stringify({ status: operation.status, appId: operation.appId, githubUserId: operation.githubUserId, repositoryId: operation.repository?.repositoryId ?? null, private: operation.private, errorCode: operation.errorCode })]);
}

export class PostgresRepositoryCreationStore implements RepositoryCreationStorePort {
  private readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  async findByKey(projectId: string, userId: string, key: string): Promise<RepositoryCreationOperation | null> {
    const result = await this.database.query<{ payload: RepositoryCreationOperation | string }>(`SELECT payload FROM github_repository_creation_operations WHERE project_id=$1 AND user_id=$2 AND idempotency_key=$3`, [projectId, userId, key]);
    return result.rows[0] ? decode(result.rows[0].payload) : null;
  }
  async get(projectId: string, userId: string, id: string): Promise<RepositoryCreationOperation | null> {
    const result = await this.database.query<{ payload: RepositoryCreationOperation | string }>(`SELECT payload FROM github_repository_creation_operations WHERE project_id=$1 AND user_id=$2 AND id=$3`, [projectId, userId, id]);
    return result.rows[0] ? decode(result.rows[0].payload) : null;
  }
  async insert(operation: RepositoryCreationOperation): Promise<RepositoryCreationOperation> {
    return this.database.transaction(async sql => {
      const result = await sql.query<{ payload: RepositoryCreationOperation | string }>(`INSERT INTO github_repository_creation_operations (id,project_id,user_id,idempotency_key,input_hash,revision,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (project_id,user_id,idempotency_key) DO NOTHING RETURNING payload`,
      [operation.id, operation.projectId, operation.userId, operation.idempotencyKey, repositoryCreationInputHash(operation), operation.revision, JSON.stringify(operation)]);
      if (result.rows[0]) { await audit(sql, operation); return decode(result.rows[0].payload); }
      const existing = await sql.query<{ payload: RepositoryCreationOperation | string; input_hash: string }>(`SELECT payload,input_hash FROM github_repository_creation_operations WHERE project_id=$1 AND user_id=$2 AND idempotency_key=$3`, [operation.projectId, operation.userId, operation.idempotencyKey]);
      if (!existing.rows[0] || existing.rows[0].input_hash !== repositoryCreationInputHash(operation)) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "相同幂等键已经用于不同的新建仓库内容。", { status: 409 });
      return decode(existing.rows[0].payload);
    });
  }
  async update(operation: RepositoryCreationOperation, expectedRevision: number): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || operation.revision !== expectedRevision + 1) throw new DomainError("VERSION_CONFLICT", "新建仓库操作版本已变化。", { status: 409 });
    await this.database.transaction(async sql => {
      const result = await sql.query(`UPDATE github_repository_creation_operations SET revision=$4,payload=$5::jsonb
        WHERE project_id=$1 AND user_id=$2 AND id=$3 AND revision=$6 AND input_hash=$7 RETURNING id`,
      [operation.projectId, operation.userId, operation.id, operation.revision, JSON.stringify(operation), expectedRevision, repositoryCreationInputHash(operation)]);
      if (result.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "新建仓库操作已更新，请核对最新结果。", { status: 409 });
      await audit(sql, operation);
    });
  }
}
