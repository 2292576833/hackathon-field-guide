import type { EntityId } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { ContactWillingness } from "./model.ts";

/**
 * 赛后闭环的持久适配。
 *
 * `ecl_contact_willingness` 是**本模块唯一新增的表**，也是"联系意愿"这一件新事实的**唯一存储**。
 * 它与既有 `ej_result_appeals`（申诉）**并存但不重叠**：两条表各管一件事，不存在同一事实两处存储。
 *
 * 不可变边界由 SQL 触发器保证：队伍、作者、提交时间与原始选择不可改写；撤回只把状态改成
 * `withdrawn` 并把 revision 加一，历史行保留可追溯。
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
function requireNextRevision(expectedRevision: number, value: { revision: number }): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || value.revision !== expectedRevision + 1) {
    throw new DomainError("CLOSURE_VERSION_CONFLICT", "保存版本必须接续当前记录，请重新读取。", { status: 409 });
  }
}

/** 本场全部联系意愿记录（主办方侧只投影主动愿意的，队伍侧只看本队）。 */
export function listWillingness(sql: SqlExecutor, scope: HostedEventScope): Promise<ContactWillingness[]> {
  return many<ContactWillingness>(sql, "SELECT document FROM ecl_contact_willingness WHERE organization_id=$1 AND event_id=$2 ORDER BY submitted_at,id", scopeParameters(scope));
}
export function getWillingness(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<ContactWillingness | null> {
  return first<ContactWillingness>(sql, "SELECT document FROM ecl_contact_willingness WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
/** 同一提交人在同一赛事下的重试标识唯一；与申诉的重试口径一致，但互不干扰。 */
export function findWillingnessReplay(sql: SqlExecutor, scope: HostedEventScope, authorUserId: EntityId, idempotencyKey: string): Promise<ContactWillingness | null> {
  return first<ContactWillingness>(sql, "SELECT document FROM ecl_contact_willingness WHERE organization_id=$1 AND event_id=$2 AND author_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), authorUserId, idempotencyKey]);
}
/** 一队一条有效记录；撤回后为 null，可重新提交。 */
export function findActiveWillingness(sql: SqlExecutor, scope: HostedEventScope, teamId: EntityId): Promise<ContactWillingness | null> {
  return first<ContactWillingness>(sql, "SELECT document FROM ecl_contact_willingness WHERE organization_id=$1 AND event_id=$2 AND team_id=$3 AND status='active'", [...scopeParameters(scope), teamId]);
}
/** 只新增历史版本，不替换；撤回走 updateWillingness 并保留原行。 */
export async function insertWillingness(sql: SqlExecutor, value: ContactWillingness): Promise<void> {
  await sql.query("INSERT INTO ecl_contact_willingness(id,organization_id,event_id,team_id,author_user_id,willing,status,revision,submitted_at,withdrawn_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
    [value.id, value.organizationId, value.eventId, value.teamId, value.authorUserId, value.willing, value.status, value.revision, value.submittedAt, value.withdrawnAt, value.idempotencyKey, JSON.stringify(value)]);
}
export async function updateWillingness(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: ContactWillingness): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ecl_contact_willingness SET status=$5,revision=$6,withdrawn_at=$7,document=$8::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4 AND team_id=$9 AND author_user_id=$10",
    [...scopeParameters(scope), value.id, expectedRevision, value.status, value.revision, value.withdrawnAt, JSON.stringify(value), value.teamId, value.authorUserId]);
  return result.rowCount === 1;
}