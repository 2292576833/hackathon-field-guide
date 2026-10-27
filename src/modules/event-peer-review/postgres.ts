import type { EntityId } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { PeerReview, PeerReviewReport } from "./model.ts";

/**
 * 数值互评的持久适配。本模块只写两张自己的表：
 *
 * - epr_peer_reviews：互评记录。分值与维度**一次写入即冻结**；本人修改会新增一条 active 行
 *   并把旧行标为 superseded（旧行 revision 不变），撤回则把 active 行标为 withdrawn（revision 加一）。
 *   因此"分值不可改写"由 SQL 触发器保证，历史可追溯。
 * - epr_review_reports：举报事实（只记录、不裁决、不改分数）；由唯一约束保证同人同条只报一次。
 *
 * 两张表都以 (organization_id, event_id) 为读写边界：跨赛事读不到，也写不进别的赛事。
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
    throw new DomainError("EVENT_SCOPE_MISMATCH", "当前赛事与记录范围不匹配。", { status: 403 });
  }
}

/** 本场全部互评（含历史版本与已撤回/被取代的记录）。调用方按需要过滤。 */
export function listReviews(sql: SqlExecutor, scope: HostedEventScope): Promise<PeerReview[]> {
  return many<PeerReview>(sql, "SELECT document FROM epr_peer_reviews WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function getReview(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<PeerReview | null> {
  return first<PeerReview>(sql, "SELECT document FROM epr_peer_reviews WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
/** 同一评分者在本场的重试标识唯一；跨赛事互不干扰。 */
export function findReviewReplay(sql: SqlExecutor, scope: HostedEventScope, reviewerUserId: EntityId, idempotencyKey: string): Promise<PeerReview | null> {
  return first<PeerReview>(sql, "SELECT document FROM epr_peer_reviews WHERE organization_id=$1 AND event_id=$2 AND reviewer_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), reviewerUserId, idempotencyKey]);
}
/** 一队一件作品一个评分者最多一条有效记录；被取代与被撤回都不算有效。 */
export function findActiveReview(sql: SqlExecutor, scope: HostedEventScope, snapshotId: EntityId, reviewerUserId: EntityId): Promise<PeerReview | null> {
  return first<PeerReview>(sql, "SELECT document FROM epr_peer_reviews WHERE organization_id=$1 AND event_id=$2 AND snapshot_id=$3 AND reviewer_user_id=$4 AND status='active'", [...scopeParameters(scope), snapshotId, reviewerUserId]);
}
/** 只新增历史版本，不替换任何既有行。 */
export async function insertReview(sql: SqlExecutor, value: PeerReview): Promise<void> {
  await sql.query("INSERT INTO epr_peer_reviews(id,organization_id,event_id,snapshot_id,team_id,reviewer_user_id,scale,status,revision,created_at,updated_at,withdrawn_at,superseded_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)",
    [value.id, value.organizationId, value.eventId, value.snapshotId, value.teamId, value.reviewerUserId, value.scale, value.status, value.revision, value.createdAt, value.updatedAt, value.withdrawnAt, value.supersededAt, value.idempotencyKey, JSON.stringify(value)]);
}
/**
 * 关闭一条 active 互评：撤回（withdrawn，revision 加一）或被取代（superseded，revision 不变）。
 * 条件里同时带 reviewer_user_id 与 status='active'，并发下只有一笔能成功。
 */
export async function closeReview(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: PeerReview): Promise<boolean> {
  requireScope(scope, value);
  const result = await sql.query("UPDATE epr_peer_reviews SET status=$5,revision=$6,updated_at=$7,withdrawn_at=$8,superseded_at=$9,document=$10::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4 AND reviewer_user_id=$11 AND status='active'",
    [...scopeParameters(scope), value.id, expectedRevision, value.status, value.revision, value.updatedAt, value.withdrawnAt, value.supersededAt, JSON.stringify(value), value.reviewerUserId]);
  return result.rowCount === 1;
}

/** 本场全部举报事实。 */
export function listReports(sql: SqlExecutor, scope: HostedEventScope): Promise<PeerReviewReport[]> {
  return many<PeerReviewReport>(sql, "SELECT document FROM epr_review_reports WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function findReport(sql: SqlExecutor, scope: HostedEventScope, reviewId: EntityId, reporterUserId: EntityId): Promise<PeerReviewReport | null> {
  return first<PeerReviewReport>(sql, "SELECT document FROM epr_review_reports WHERE organization_id=$1 AND event_id=$2 AND review_id=$3 AND reporter_user_id=$4", [...scopeParameters(scope), reviewId, reporterUserId]);
}
/** 举报只新增事实，永不改写既有行（触发器同样禁止 UPDATE/DELETE）。 */
export async function insertReport(sql: SqlExecutor, value: PeerReviewReport): Promise<void> {
  await sql.query("INSERT INTO epr_review_reports(id,organization_id,event_id,review_id,snapshot_id,team_id,reporter_user_id,reason,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
    [value.id, value.organizationId, value.eventId, value.reviewId, value.snapshotId, value.teamId, value.reporterUserId, value.reason, value.createdAt, JSON.stringify(value)]);
}
