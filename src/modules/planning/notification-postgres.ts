import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { PlanningNotification, PlanningNotificationReceipt, PlanningNotificationRepository, PlanningNotificationTransaction } from "./notification-types.ts";
import type { PlanningEvent } from "./types.ts";

interface Row { body: PlanningNotification; resolved_at: Date | string | null; updated_at: Date | string }
interface ReceiptRow { notification_id: string; user_id: string; membership_id: string; revision: string | number; read_at: Date | string | null; dismissed_at: Date | string | null; revoked_at: Date | string | null }
const instant = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
function notification(row: Row): PlanningNotification { return { ...row.body, resolvedAt: instant(row.resolved_at), updatedAt: instant(row.updated_at)! }; }
function transaction(sql: SqlExecutor, projectId: string): PlanningNotificationTransaction {
  return {
    sql,
    async claimEvents(limit) {
      const result = await sql.query<{ event_json: PlanningEvent }>("SELECT o.event_json FROM planning_outbox o WHERE o.project_id=$1 AND NOT EXISTS (SELECT 1 FROM planning_notification_consumptions c WHERE c.event_id=o.event_id) ORDER BY o.occurred_at,o.event_id LIMIT $2 FOR UPDATE OF o SKIP LOCKED", [projectId, limit]);
      return result.rows.map(row => row.event_json);
    },
    async completeEvents(events, at) {
      for (const event of events) {
        if (event.projectId !== projectId) throw new DomainError("PROJECT_MISMATCH", "提醒事件不属于此项目。");
        await sql.query("INSERT INTO planning_notification_consumptions(event_id,project_id,consumed_at) VALUES ($1,$2,$3) ON CONFLICT(event_id) DO NOTHING", [event.id, projectId, at]);
      }
    },
    async list() {
      const rows = await sql.query<Row>("SELECT body,resolved_at,updated_at FROM planning_notifications WHERE project_id=$1 ORDER BY updated_at DESC,id DESC", [projectId]);
      return rows.rows.map(notification);
    },
    async insert(record) {
      if (record.projectId !== projectId) throw new DomainError("PROJECT_MISMATCH", "提醒不属于此项目。");
      const result = await sql.query("INSERT INTO planning_notifications(id,project_id,cause,source_revision,created_at,updated_at,resolved_at,body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(project_id,cause,source_revision) DO NOTHING RETURNING id", [record.id, projectId, record.cause, record.sourceRevision, record.createdAt, record.updatedAt, record.resolvedAt, JSON.stringify(record)]);
      return result.rowCount === 1;
    },
    async resolve(id, at) { await sql.query("UPDATE planning_notifications SET resolved_at=$3,updated_at=$3 WHERE id=$1 AND project_id=$2 AND resolved_at IS NULL", [id, projectId, at]); },
    async reopen(id, at) {
      const updated = await sql.query("UPDATE planning_notifications SET resolved_at=NULL,updated_at=$3 WHERE id=$1 AND project_id=$2 AND resolved_at IS NOT NULL RETURNING id", [id, projectId, at]);
      if (updated.rowCount) await sql.query("UPDATE planning_notification_recipients SET read_at=NULL,dismissed_at=NULL,revision=revision+1 WHERE notification_id=$1 AND revoked_at IS NULL", [id]);
    },
    async ensureRecipient(id, member) {
      const result = await sql.query("INSERT INTO planning_notification_recipients(notification_id,user_id,membership_id,revision) SELECT id,$3,$4,1 FROM planning_notifications WHERE id=$1 AND project_id=$2 ON CONFLICT(notification_id,user_id) DO NOTHING RETURNING notification_id", [id, projectId, member.userId, member.membershipId]);
      return result.rowCount === 1;
    },
    async revokeRecipients(members, at) {
      const identities = members.filter(member => member.status === "active" && member.projectId === projectId).map(member => ({ userId: member.userId, membershipId: member.membershipId }));
      await sql.query("UPDATE planning_notification_recipients r SET revoked_at=$3,revision=revision+1 FROM planning_notifications n WHERE n.id=r.notification_id AND n.project_id=$1 AND r.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS m(\"userId\" text,\"membershipId\" text) WHERE m.\"userId\"=r.user_id AND m.\"membershipId\"=r.membership_id)", [projectId, JSON.stringify(identities), at]);
    },
    async getReceipt(id, userId) {
      const result = await sql.query<ReceiptRow>("SELECT r.* FROM planning_notification_recipients r JOIN planning_notifications n ON n.id=r.notification_id WHERE r.notification_id=$1 AND r.user_id=$2 AND n.project_id=$3 FOR UPDATE OF r", [id, userId, projectId]);
      const row = result.rows[0];
      return row ? { notificationId: row.notification_id, userId: row.user_id, membershipId: row.membership_id, revision: Number(row.revision), readAt: instant(row.read_at), dismissedAt: instant(row.dismissed_at), revokedAt: instant(row.revoked_at) } : null;
    },
    async saveReceipt(record, expectedRevision) {
      if (record.revision !== expectedRevision + 1) throw new DomainError("INVALID_REVISION", "提醒状态版本需要递增。");
      const saved = await sql.query("UPDATE planning_notification_recipients r SET revision=$4,read_at=$5,dismissed_at=$6 FROM planning_notifications n WHERE n.id=r.notification_id AND n.project_id=$7 AND r.notification_id=$1 AND r.user_id=$2 AND r.membership_id=$3 AND r.revision=$8 AND r.revoked_at IS NULL RETURNING r.revision", [record.notificationId, record.userId, record.membershipId, record.revision, record.readAt, record.dismissedAt, projectId, expectedRevision]);
      if (saved.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "提醒已更新，请刷新后再处理。", { status: 409, recoveryAction: "refresh_notifications" });
    },
  };
}
export function createPostgresPlanningNotificationRepository(database: DatabasePort): PlanningNotificationRepository {
  return {
    async pendingProjectIds(limit, afterProjectId) {
      const rows = await database.query<{ project_id: string }>("SELECT o.project_id FROM planning_outbox o WHERE NOT EXISTS (SELECT 1 FROM planning_notification_consumptions c WHERE c.event_id=o.event_id) AND ($2::text IS NULL OR o.project_id>$2) GROUP BY o.project_id ORDER BY o.project_id LIMIT $1", [limit, afterProjectId ?? null]);
      return rows.rows.map(row => row.project_id);
    },
    async ownReferences(userId, options) {
      const rows = await database.query<{ id: string; project_id: string; updated_at: string | Date }>("SELECT n.id,n.project_id,n.updated_at FROM planning_notification_recipients r JOIN planning_notifications n ON n.id=r.notification_id WHERE r.user_id=$1 AND r.revoked_at IS NULL AND r.dismissed_at IS NULL AND ($3::text IS NULL OR n.project_id=$3) AND ($4::timestamptz IS NULL OR (n.updated_at,n.id)<($4::timestamptz,$5::text)) ORDER BY n.updated_at DESC,n.id DESC LIMIT $2", [userId, options.limit, options.projectId ?? null, options.before?.updatedAt ?? null, options.before?.id ?? null]);
      return rows.rows.map(row => ({ id: row.id, projectId: row.project_id, updatedAt: instant(row.updated_at)! }));
    },
    async locateOwn(id, userId) {
      const rows = await database.query<{ project_id: string }>("SELECT n.project_id FROM planning_notification_recipients r JOIN planning_notifications n ON n.id=r.notification_id WHERE n.id=$1 AND r.user_id=$2 AND r.revoked_at IS NULL", [id, userId]);
      return rows.rows[0] ? { projectId: rows.rows[0].project_id } : null;
    },
    async transaction(projectId, work) {
      return database.transaction(async executor => {
        await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`planning:${projectId}`]);
        let active = true;
        const sql: SqlExecutor = { async query<Row>(statement: string, parameters?: readonly unknown[]) {
          if (!active) throw new DomainError("NOTIFICATION_TRANSACTION_CLOSED", "提醒操作已结束，请重新读取。", { status: 409 });
          return executor.query<Row>(statement, parameters);
        } };
        try { return await work(transaction(sql, projectId)); } finally { active = false; }
      });
    },
  };
}
