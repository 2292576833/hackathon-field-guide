import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { ResourceCatalogCheckpoint, ResourceCatalogCheckpointPort } from "./catalog-types.ts";

export function createResourceCatalogCheckpointPort(transaction: SqlExecutor): ResourceCatalogCheckpointPort {
  return {
    async lock(candidateKey) {
      const hash = createHash("sha256").update(`resource-catalog:${candidateKey}`).digest("hex");
      const lockKey = BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`)).toString();
      await transaction.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);
      const result = await transaction.query<{document: ResourceCatalogCheckpoint}>("SELECT document FROM resource_catalog_imports WHERE candidate_key = $1 FOR UPDATE", [candidateKey]);
      return result.rows[0]?.document ?? null;
    },
    async insert(checkpoint) {
      await transaction.query("INSERT INTO resource_catalog_imports (candidate_key, revision, resource_id, document) VALUES ($1, $2, $3, $4::jsonb)",
        [checkpoint.candidateKey, checkpoint.revision, checkpoint.resourceId, JSON.stringify(checkpoint)]);
    },
    async save(checkpoint, expectedRevision) {
      const result = await transaction.query("UPDATE resource_catalog_imports SET revision = $2, document = $3::jsonb WHERE candidate_key = $1 AND revision = $4 RETURNING candidate_key",
        [checkpoint.candidateKey, checkpoint.revision, JSON.stringify(checkpoint), expectedRevision]);
      if (result.rowCount !== 1) throw new DomainError("CATALOG_CHECKPOINT_CONFLICT", "种子导入记录已更新，请重新核对后重试。", {status: 409});
    },
  };
}
