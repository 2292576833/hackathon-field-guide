import type { EntityId } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { CommunityBlock, CommunityReport, DirectMessage, EventConnection } from "./model.ts";

/**
 * 选手社区的持久适配。本模块**只**读写自己的四张表：
 *
 * | 表 | 唯一负责的事实 |
 * | --- | --- |
 * | `evc_connections` | 一场比赛里、一对账号之间的连接事实（请求/接受/拒绝/取消） |
 * | `evc_direct_messages` | 已连接两人之间的消息（撤回或清理后只留最小事实） |
 * | `evc_blocks` | 本人对本场某人的屏蔽 |
 * | `evc_reports` | 举报事实与举报时刻的最近消息快照 |
 *
 * 它**不**碰 `organizer_*`、`event_registration_*`、`ej_*` 或任何其他模块的表，也不建第二份参赛名片/名录。
 * 不可变边界由 SQL 触发器保证：范围、双方账号、方向、时间与重试标识不可改写；状态只能沿定义好的方向前进。
 */

const decode = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
async function many<T>(sql: SqlExecutor, statement: string, parameters: readonly unknown[]): Promise<T[]> {
  const result = await sql.query<{ document: unknown }>(statement, parameters);
  return result.rows.map(row => decode<T>(row.document));
}
async function first<T>(sql: SqlExecutor, statement: string, parameters: readonly unknown[]): Promise<T | null> {
  const result = await many<T>(sql, statement, parameters);
  return result[0] ?? null;
}
const scopeParameters = (scope: HostedEventScope): readonly unknown[] => [scope.organizationId, scope.eventId];
function requireScope(scope: HostedEventScope, value: { organizationId: EntityId; eventId: EntityId }): void {
  if (scope.organizationId !== value.organizationId || scope.eventId !== value.eventId) {
    throw new DomainError("COMMUNITY_EVENT_SCOPE_MISMATCH", "当前赛事与记录范围不匹配。", { status: 403 });
  }
}
function requireNextRevision(expectedRevision: number, value: { revision: number }): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || value.revision !== expectedRevision + 1) {
    throw new DomainError("COMMUNITY_VERSION_CONFLICT", "保存版本必须接续当前记录，请重新读取。", { status: 409 });
  }
}

/* ---------- evc_connections ---------- */

export function listConnections(sql: SqlExecutor, scope: HostedEventScope): Promise<EventConnection[]> {
  return many<EventConnection>(sql, "SELECT document FROM evc_connections WHERE organization_id=$1 AND event_id=$2 ORDER BY requested_at,id", scopeParameters(scope));
}
export function getConnection(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<EventConnection | null> {
  return first<EventConnection>(sql, "SELECT document FROM evc_connections WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
/** 同一对账号在本场最多一条 pending 或 accepted。 */
export function findOpenConnection(sql: SqlExecutor, scope: HostedEventScope, pairKey: string): Promise<EventConnection | null> {
  return first<EventConnection>(sql, "SELECT document FROM evc_connections WHERE organization_id=$1 AND event_id=$2 AND pair_key=$3 AND status IN ('pending','accepted')", [...scopeParameters(scope), pairKey]);
}
export function findConnectionByRequestKey(sql: SqlExecutor, scope: HostedEventScope, requesterUserId: EntityId, idempotencyKey: string): Promise<EventConnection | null> {
  return first<EventConnection>(sql, "SELECT document FROM evc_connections WHERE organization_id=$1 AND event_id=$2 AND requester_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), requesterUserId, idempotencyKey]);
}
/** 最近一次被拒绝的时间（用于冷却）；取消不计入冷却。 */
export function latestRejection(sql: SqlExecutor, scope: HostedEventScope, pairKey: string): Promise<EventConnection | null> {
  return first<EventConnection>(sql, "SELECT document FROM evc_connections WHERE organization_id=$1 AND event_id=$2 AND pair_key=$3 AND status='rejected' ORDER BY responded_at DESC NULLS LAST, id DESC LIMIT 1", [...scopeParameters(scope), pairKey]);
}
export function countPendingForUser(sql: SqlExecutor, scope: HostedEventScope, userId: EntityId): Promise<number> {
  return sql.query<{ count: string }>("SELECT count(*)::text AS count FROM evc_connections WHERE organization_id=$1 AND event_id=$2 AND status='pending' AND (requester_user_id=$3 OR addressee_user_id=$3)", [...scopeParameters(scope), userId])
    .then(result => Number(result.rows[0]?.count ?? "0"));
}
/** `ON CONFLICT DO NOTHING`：唯一冲突不抛异常、不让事务进入 aborted 状态，调用方按 rowCount 决定语义。 */
export async function insertConnection(sql: SqlExecutor, value: EventConnection): Promise<boolean> {
  const result = await sql.query("INSERT INTO evc_connections(id,organization_id,event_id,pair_key,requester_user_id,addressee_user_id,status,revision,requested_at,responded_at,decided_by_user_id,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT DO NOTHING",
    [value.id, value.organizationId, value.eventId, value.pairKey, value.requesterUserId, value.addresseeUserId, value.status, value.revision, value.requestedAt, value.respondedAt, value.decidedByUserId, value.idempotencyKey, JSON.stringify(value)]);
  return result.rowCount === 1;
}
export async function updateConnection(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: EventConnection): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE evc_connections SET status=$5,revision=$6,responded_at=$7,decided_by_user_id=$8,document=$9::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4",
    [...scopeParameters(scope), value.id, expectedRevision, value.status, value.revision, value.respondedAt, value.decidedByUserId, JSON.stringify(value)]);
  return result.rowCount === 1;
}

/* ---------- evc_direct_messages ---------- */

export function listMessages(sql: SqlExecutor, scope: HostedEventScope, connectionId: EntityId): Promise<DirectMessage[]> {
  return many<DirectMessage>(sql, "SELECT document FROM evc_direct_messages WHERE organization_id=$1 AND event_id=$2 AND connection_id=$3 ORDER BY created_at,id", [...scopeParameters(scope), connectionId]);
}
export function getMessage(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<DirectMessage | null> {
  return first<DirectMessage>(sql, "SELECT document FROM evc_direct_messages WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export function findMessageByKey(sql: SqlExecutor, scope: HostedEventScope, senderUserId: EntityId, idempotencyKey: string): Promise<DirectMessage | null> {
  return first<DirectMessage>(sql, "SELECT document FROM evc_direct_messages WHERE organization_id=$1 AND event_id=$2 AND sender_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), senderUserId, idempotencyKey]);
}
export function countMessagesSince(sql: SqlExecutor, scope: HostedEventScope, senderUserId: EntityId, sinceIso: string): Promise<number> {
  return sql.query<{ count: string }>("SELECT count(*)::text AS count FROM evc_direct_messages WHERE organization_id=$1 AND event_id=$2 AND sender_user_id=$3 AND created_at >= $4", [...scopeParameters(scope), senderUserId, sinceIso])
    .then(result => Number(result.rows[0]?.count ?? "0"));
}
/** 供既有后台维护任务调用：到期清理口径下、正文还没被清理的旧消息。 */
export function listPurgeableMessages(sql: SqlExecutor, scope: HostedEventScope, cutoffIso: string, limit: number): Promise<DirectMessage[]> {
  return many<DirectMessage>(sql, "SELECT document FROM evc_direct_messages WHERE organization_id=$1 AND event_id=$2 AND status='active' AND created_at < $3 ORDER BY created_at,id LIMIT $4", [...scopeParameters(scope), cutoffIso, limit]);
}
export async function insertMessage(sql: SqlExecutor, value: DirectMessage): Promise<boolean> {
  const result = await sql.query("INSERT INTO evc_direct_messages(id,organization_id,event_id,connection_id,sender_user_id,recipient_user_id,content,status,revision,created_at,withdrawn_at,purged_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT DO NOTHING",
    [value.id, value.organizationId, value.eventId, value.connectionId, value.senderUserId, value.recipientUserId, value.content, value.status, value.revision, value.createdAt, value.withdrawnAt, value.purgedAt, value.idempotencyKey, JSON.stringify(value)]);
  return result.rowCount === 1;
}
export async function updateMessage(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: DirectMessage): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE evc_direct_messages SET content=$5,status=$6,revision=$7,withdrawn_at=$8,purged_at=$9,document=$10::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4",
    [...scopeParameters(scope), value.id, expectedRevision, value.content, value.status, value.revision, value.withdrawnAt, value.purgedAt, JSON.stringify(value)]);
  return result.rowCount === 1;
}

/* ---------- evc_blocks ---------- */

export function listBlocks(sql: SqlExecutor, scope: HostedEventScope): Promise<CommunityBlock[]> {
  return many<CommunityBlock>(sql, "SELECT document FROM evc_blocks WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function findBlock(sql: SqlExecutor, scope: HostedEventScope, blockerUserId: EntityId, blockedUserId: EntityId): Promise<CommunityBlock | null> {
  return first<CommunityBlock>(sql, "SELECT document FROM evc_blocks WHERE organization_id=$1 AND event_id=$2 AND blocker_user_id=$3 AND blocked_user_id=$4", [...scopeParameters(scope), blockerUserId, blockedUserId]);
}
/** 任一方向的屏蔽都算；连接与发信都必须先过这一关。 */
export async function findBlockBetween(sql: SqlExecutor, scope: HostedEventScope, leftUserId: EntityId, rightUserId: EntityId): Promise<CommunityBlock | null> {
  const forward = await findBlock(sql, scope, leftUserId, rightUserId);
  return forward ?? await findBlock(sql, scope, rightUserId, leftUserId);
}
export async function insertBlock(sql: SqlExecutor, value: CommunityBlock): Promise<boolean> {
  const result = await sql.query("INSERT INTO evc_blocks(id,organization_id,event_id,blocker_user_id,blocked_user_id,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING",
    [value.id, value.organizationId, value.eventId, value.blockerUserId, value.blockedUserId, value.createdAt, JSON.stringify(value)]);
  return result.rowCount === 1;
}
export async function deleteBlock(sql: SqlExecutor, scope: HostedEventScope, blockerUserId: EntityId, blockedUserId: EntityId): Promise<boolean> {
  const result = await sql.query("DELETE FROM evc_blocks WHERE organization_id=$1 AND event_id=$2 AND blocker_user_id=$3 AND blocked_user_id=$4", [...scopeParameters(scope), blockerUserId, blockedUserId]);
  return result.rowCount === 1;
}

/* ---------- evc_reports ---------- */

export function listReports(sql: SqlExecutor, scope: HostedEventScope): Promise<CommunityReport[]> {
  return many<CommunityReport>(sql, "SELECT document FROM evc_reports WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function findReportByKey(sql: SqlExecutor, scope: HostedEventScope, reporterUserId: EntityId, idempotencyKey: string): Promise<CommunityReport | null> {
  return first<CommunityReport>(sql, "SELECT document FROM evc_reports WHERE organization_id=$1 AND event_id=$2 AND reporter_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), reporterUserId, idempotencyKey]);
}
export async function insertReport(sql: SqlExecutor, value: CommunityReport): Promise<boolean> {
  const result = await sql.query("INSERT INTO evc_reports(id,organization_id,event_id,reporter_user_id,reported_user_id,connection_id,reason,detail,snapshot,status,created_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb) ON CONFLICT DO NOTHING",
    [value.id, value.organizationId, value.eventId, value.reporterUserId, value.reportedUserId, value.connectionId, value.reason, value.detail, JSON.stringify(value.snapshot), value.status, value.createdAt, value.idempotencyKey, JSON.stringify(value)]);
  return result.rowCount === 1;
}
