import type { Clock } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { PostgresAccountStore } from "../modules/auth/index.ts";
import { createRetentionPolicy } from "../modules/operations/retention-policy.ts";

/** Only known, separable temporary stores expire. Immutable ingestion receipts,
 * references, histories and unknown paid requests have no deletion path here. */
export function createRetentionMaintenance({database,accountStore,clock}:{database:DatabasePort;accountStore:Pick<PostgresAccountStore,"clearExpiredExportDocuments">;clock:Clock}) {
  let running = false;
  return {
    async run() {
      if (running) return {status:"skipped" as const};
      running = true;
      try {
        const exports = await accountStore.clearExpiredExportDocuments(100);
        const mailbox = await database.query("DELETE FROM development_mailbox WHERE created_at < $1::timestamptz - interval '15 minutes' RETURNING id", [clock.now().toISOString()]);
        return {status:"completed" as const, expiredExportDocuments:exports, expiredDevelopmentMessages:mailbox.rowCount};
      } finally { running = false; }
    },
    async status() {
      const receipts = await database.query<{count:string}>("SELECT count(*)::text AS count FROM integration_source_results");
      const exports = await database.query<{count:string}>("SELECT count(*)::text AS count FROM auth_data_exports WHERE expires_at<=$1::timestamptz AND body->>'document' IS NOT NULL", [clock.now().toISOString()]);
      return { checkedAt:clock.now().toISOString(), temporarySourceStorage:"not_present" as const,
        sourcePolicy:createRetentionPolicy(), preservedReceiptCount:receipts.rows[0]?.count ?? "0", eligibleTemporarySourceCount:0,
        expiredExportDocuments:exports.rows[0]?.count ?? "0",
        explanation:"当前采集原文是后续分析与核验依赖的不可变回执，完整保留。没有单独的临时原文缓存可清理；未来独立缓存适用临时保留策略。导出文件过期后清空正文，保留请求状态。" };
    },
  };
}
