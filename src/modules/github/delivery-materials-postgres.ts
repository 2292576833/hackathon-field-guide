import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DeliveryMaterialChecklist, DeliveryMaterialsStorePort } from "./delivery-materials-types.ts";

export class PostgresDeliveryMaterialsStore implements DeliveryMaterialsStorePort {
  private readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  async getCurrent(projectId: string, executor: SqlExecutor = this.database): Promise<DeliveryMaterialChecklist | null> {
    const result = await executor.query<{ body: DeliveryMaterialChecklist }>(`SELECT v.body FROM m06_delivery_material_versions v JOIN m06_delivery_material_heads h ON h.project_id=v.project_id AND h.id=v.id AND h.version=v.version WHERE h.project_id=$1`, [projectId]);
    return result.rows[0] ? structuredClone(result.rows[0].body) : null;
  }
  async listHistory(projectId: string): Promise<DeliveryMaterialChecklist[]> {
    const result = await this.database.query<{ body: DeliveryMaterialChecklist }>(`SELECT body FROM m06_delivery_material_versions WHERE project_id=$1 ORDER BY version DESC`, [projectId]);
    return result.rows.map(row => structuredClone(row.body));
  }
  async findByKey(projectId: string, actorId: string, key: string, executor: SqlExecutor): Promise<DeliveryMaterialChecklist | null> {
    const result = await executor.query<{ body: DeliveryMaterialChecklist }>(`SELECT body FROM m06_delivery_material_versions WHERE project_id=$1 AND recorded_by=$2 AND idempotency_key=$3`, [projectId, actorId, key]);
    return result.rows[0] ? structuredClone(result.rows[0].body) : null;
  }
  /** Call only inside the service transaction after live permission and confirmed-rule locks. */
  async save(record: DeliveryMaterialChecklist, expectedVersion: number | null, executor: SqlExecutor): Promise<void> {
    if (record.version !== (expectedVersion ?? 0) + 1) throw new DomainError("INVALID_DELIVERY_MATERIALS", "材料版本必须连续递增。");
    const result = expectedVersion === null
      ? await executor.query(`INSERT INTO m06_delivery_material_heads (project_id,id,version) VALUES ($1,$2,$3) ON CONFLICT (project_id) DO NOTHING RETURNING version`, [record.projectId, record.id, record.version])
      : await executor.query(`UPDATE m06_delivery_material_heads SET version=$1 WHERE project_id=$2 AND id=$3 AND version=$4 RETURNING version`, [record.version, record.projectId, record.id, expectedVersion]);
    if (result.rowCount !== 1) {
      const latest = await executor.query<{ version: number }>(`SELECT version FROM m06_delivery_material_heads WHERE project_id=$1`, [record.projectId]);
      throw new DomainError("VERSION_CONFLICT", "材料清单已更新，请重新核对。", { status: 409, latestRevision: latest.rows[0]?.version });
    }
    await executor.query(`INSERT INTO m06_delivery_material_versions (project_id,id,version,recorded_by,idempotency_key,input_hash,body) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [record.projectId, record.id, record.version, record.recordedBy, record.idempotencyKey, record.inputHash, JSON.stringify(record)]);
    await executor.query(`INSERT INTO m06_delivery_material_events (id,project_id,checklist_id,version,actor_id,occurred_at,details) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [`DeliveryMaterialsRecorded:${record.id}:${record.version}`, record.projectId, record.id, record.version, record.recordedBy, record.recordedAt, JSON.stringify({ eventId: record.eventId, requirementsVersion: record.requirementsVersion, repositoryCommitSha: record.repositoryCommitSha, requirementIds: record.entries.map(entry => entry.requirementId), verificationSource: "user_reported" })]);
  }
}
