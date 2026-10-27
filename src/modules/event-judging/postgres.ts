import type { EntityId, Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { IntakeReceipt, JudgingRound, JudgeAssignment, ManualScore, PublishedResults, ResultAppeal, WorkDisclosure, WorkComment, WorkCommentReport } from "./model.ts";

/** Audit details include before/after documents so corrections preserve the prior facts. */
export interface JudgingAudit {
  id: EntityId; organizationId: EntityId; eventId: EntityId; actorUserId: EntityId;
  action: string; subjectId: EntityId; reason: string; createdAt: Instant; details: unknown;
}

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
    throw new DomainError("JUDGING_VERSION_CONFLICT", "保存版本必须接续当前记录，请重新读取。", { status: 409 });
  }
}

/** Caller must use one transaction: this serializes all O04 writes for the event. */
export async function lockEvent(sql: SqlExecutor, scope: HostedEventScope): Promise<void> {
  await sql.query("INSERT INTO ej_event_locks(organization_id,event_id) VALUES($1,$2) ON CONFLICT(organization_id,event_id) DO NOTHING", scopeParameters(scope));
  await sql.query("SELECT event_id FROM ej_event_locks WHERE organization_id=$1 AND event_id=$2 FOR UPDATE", scopeParameters(scope));
}

export function listReceipts(sql: SqlExecutor, scope: HostedEventScope): Promise<IntakeReceipt[]> {
  return many<IntakeReceipt>(sql, "SELECT document FROM ej_intake_receipts WHERE organization_id=$1 AND event_id=$2 ORDER BY submitted_at,id", scopeParameters(scope));
}
export function getReceipt(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<IntakeReceipt | null> {
  return first<IntakeReceipt>(sql, "SELECT document FROM ej_intake_receipts WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export function findReplay(sql: SqlExecutor, scope: HostedEventScope, authorUserId: EntityId, idempotencyKey: string): Promise<IntakeReceipt | null> {
  return first<IntakeReceipt>(sql, "SELECT document FROM ej_intake_receipts WHERE organization_id=$1 AND event_id=$2 AND author_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), authorUserId, idempotencyKey]);
}
/** No replacement, update or delete operation exists for a formal receipt. */
export async function insertReceipt(sql: SqlExecutor, value: IntakeReceipt): Promise<void> {
  await sql.query("INSERT INTO ej_intake_receipts(id,organization_id,event_id,team_id,author_user_id,version,receipt_number,idempotency_key,submitted_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
    [value.id, value.organizationId, value.eventId, value.teamId, value.authorUserId, value.version, value.receiptNumber, value.idempotencyKey, value.submittedAt, JSON.stringify(value)]);
}

export function listRounds(sql: SqlExecutor, scope: HostedEventScope): Promise<JudgingRound[]> {
  return many<JudgingRound>(sql, "SELECT document FROM ej_judging_rounds WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function getRound(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<JudgingRound | null> {
  return first<JudgingRound>(sql, "SELECT document FROM ej_judging_rounds WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export async function insertRound(sql: SqlExecutor, value: JudgingRound): Promise<void> {
  await sql.query("INSERT INTO ej_judging_rounds(id,organization_id,event_id,revision,status,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [value.id, value.organizationId, value.eventId, value.revision, value.status, value.createdAt, JSON.stringify(value)]);
}
export async function updateRound(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: JudgingRound): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ej_judging_rounds SET revision=$5,status=$6,document=$7::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4",
    [...scopeParameters(scope), value.id, expectedRevision, value.revision, value.status, JSON.stringify(value)]);
  return result.rowCount === 1;
}

export function listAssignments(sql: SqlExecutor, scope: HostedEventScope): Promise<JudgeAssignment[]> {
  return many<JudgeAssignment>(sql, "SELECT document FROM ej_judge_assignments WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
/** Discovery only: no assignment documents, scores or materials leave this own-only read. */
export async function listAssignedEventIds(sql: SqlExecutor, judgeUserId: EntityId, candidates?: readonly EntityId[]): Promise<EntityId[]> {
  if (candidates?.length === 0) return [];
  const result = await sql.query<{ event_id: EntityId }>(
    `SELECT DISTINCT event_id FROM ej_judge_assignments WHERE judge_user_id=$1 AND status IN ('active','needs_review')${candidates ? " AND event_id=ANY($2::text[])" : ""} ORDER BY event_id LIMIT 100`,
    candidates ? [judgeUserId, candidates] : [judgeUserId]);
  return result.rows.map(row => row.event_id);
}
export function getAssignment(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<JudgeAssignment | null> {
  return first<JudgeAssignment>(sql, "SELECT document FROM ej_judge_assignments WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export async function insertAssignment(sql: SqlExecutor, value: JudgeAssignment): Promise<void> {
  await sql.query("INSERT INTO ej_judge_assignments(id,organization_id,event_id,round_id,snapshot_id,judge_user_id,revision,status,declaration,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
    [value.id, value.organizationId, value.eventId, value.roundId, value.snapshotId, value.judgeUserId, value.revision, value.status, value.declaration, value.createdAt, JSON.stringify(value)]);
}
export async function updateAssignment(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: JudgeAssignment): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ej_judge_assignments SET revision=$5,status=$6,declaration=$7,document=$8::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4 AND round_id=$9 AND snapshot_id=$10 AND judge_user_id=$11",
    [...scopeParameters(scope), value.id, expectedRevision, value.revision, value.status, value.declaration, JSON.stringify(value), value.roundId, value.snapshotId, value.judgeUserId]);
  return result.rowCount === 1;
}

export function listScores(sql: SqlExecutor, scope: HostedEventScope): Promise<ManualScore[]> {
  return many<ManualScore>(sql, "SELECT document FROM ej_manual_scores WHERE organization_id=$1 AND event_id=$2 ORDER BY updated_at,id", scopeParameters(scope));
}
/** One current score per assignment; earlier versions live in append-only audit details. */
export function getScore(sql: SqlExecutor, scope: HostedEventScope, assignmentId: EntityId): Promise<ManualScore | null> {
  return first<ManualScore>(sql, "SELECT document FROM ej_manual_scores WHERE organization_id=$1 AND event_id=$2 AND assignment_id=$3", [...scopeParameters(scope), assignmentId]);
}
export async function insertScore(sql: SqlExecutor, value: ManualScore): Promise<void> {
  await sql.query("INSERT INTO ej_manual_scores(id,organization_id,event_id,assignment_id,revision,state,updated_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [value.id, value.organizationId, value.eventId, value.assignmentId, value.revision, value.state, value.updatedAt, JSON.stringify(value)]);
}
export async function updateScore(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: ManualScore): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ej_manual_scores SET revision=$5,state=$6,updated_at=$7,document=$8::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4 AND assignment_id=$9",
    [...scopeParameters(scope), value.id, expectedRevision, value.revision, value.state, value.updatedAt, JSON.stringify(value), value.assignmentId]);
  return result.rowCount === 1;
}

export async function insertAudit(sql: SqlExecutor, value: JudgingAudit): Promise<void> {
  await sql.query("INSERT INTO ej_judging_audits(id,organization_id,event_id,actor_user_id,action,subject_id,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [value.id, value.organizationId, value.eventId, value.actorUserId, value.action, value.subjectId, value.createdAt, JSON.stringify(value)]);
}
export function listAudits(sql: SqlExecutor, scope: HostedEventScope): Promise<JudgingAudit[]> {
  return many<JudgingAudit>(sql, "SELECT document FROM ej_judging_audits WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}

export function listAppeals(sql: SqlExecutor, scope: HostedEventScope): Promise<ResultAppeal[]> {
  return many<ResultAppeal>(sql, "SELECT document FROM ej_result_appeals WHERE organization_id=$1 AND event_id=$2 ORDER BY filed_at,id", scopeParameters(scope));
}
export function getAppeal(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<ResultAppeal | null> {
  return first<ResultAppeal>(sql, "SELECT document FROM ej_result_appeals WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export function findAppealReplay(sql: SqlExecutor, scope: HostedEventScope, authorUserId: EntityId, idempotencyKey: string): Promise<ResultAppeal | null> {
  return first<ResultAppeal>(sql, "SELECT document FROM ej_result_appeals WHERE organization_id=$1 AND event_id=$2 AND author_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), authorUserId, idempotencyKey]);
}
/** Only status/decision fields are mutable; the trigger keeps the participant's original text immutable. */
export async function insertAppeal(sql: SqlExecutor, value: ResultAppeal): Promise<void> {
  await sql.query("INSERT INTO ej_result_appeals(id,organization_id,event_id,round_id,published_result_id,result_version,team_id,snapshot_id,author_user_id,status,revision,filed_at,deadline_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)",
    [value.id, value.organizationId, value.eventId, value.roundId, value.publishedResultId, value.resultVersion, value.teamId, value.snapshotId,
      value.authorUserId, value.status, value.revision, value.filedAt, value.deadlineAt, value.idempotencyKey, JSON.stringify(value)]);
}
export async function updateAppeal(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: ResultAppeal): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ej_result_appeals SET status=$5,revision=$6,document=$7::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4",
    [...scopeParameters(scope), value.id, expectedRevision, value.status, value.revision, JSON.stringify(value)]);
  return result.rowCount === 1;
}

export function listPublished(sql: SqlExecutor, scope: HostedEventScope): Promise<PublishedResults[]> {  return many<PublishedResults>(sql, "SELECT document FROM ej_published_results WHERE organization_id=$1 AND event_id=$2 ORDER BY version,id", scopeParameters(scope));
}

/**
 * 规划 34 C①：队伍公开范围的**唯一**存储读写（本模块唯一新增表）。
 * 除这六个函数外，没有任何地方读写 `ej_work_disclosures`；
 * 公开投影全部是只读派生，不写第二份"作品公开状态"。
 */
export function listWorkDisclosures(sql: SqlExecutor, scope: HostedEventScope): Promise<WorkDisclosure[]> {
  return many<WorkDisclosure>(sql, "SELECT document FROM ej_work_disclosures WHERE organization_id=$1 AND event_id=$2 ORDER BY updated_at,id", scopeParameters(scope));
}
export function getWorkDisclosure(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<WorkDisclosure | null> {
  return first<WorkDisclosure>(sql, "SELECT document FROM ej_work_disclosures WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export function findWorkDisclosureReplay(sql: SqlExecutor, scope: HostedEventScope, authorUserId: EntityId, idempotencyKey: string): Promise<WorkDisclosure | null> {
  return first<WorkDisclosure>(sql, "SELECT document FROM ej_work_disclosures WHERE organization_id=$1 AND event_id=$2 AND author_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), authorUserId, idempotencyKey]);
}
/** 一队最多一条有效记录；部分唯一索引 `ej_work_disclosures_one_active` 是最终保证。 */
export function findActiveWorkDisclosure(sql: SqlExecutor, scope: HostedEventScope, teamId: EntityId): Promise<WorkDisclosure | null> {
  return first<WorkDisclosure>(sql, "SELECT document FROM ej_work_disclosures WHERE organization_id=$1 AND event_id=$2 AND team_id=$3 AND status='active'", [...scopeParameters(scope), teamId]);
}
export async function insertWorkDisclosure(sql: SqlExecutor, value: WorkDisclosure): Promise<void> {
  await sql.query("INSERT INTO ej_work_disclosures(id,organization_id,event_id,team_id,author_user_id,scope,status,revision,updated_at,withdrawn_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
    [value.id, value.organizationId, value.eventId, value.teamId, value.authorUserId, value.scope, value.status, value.revision,
      value.updatedAt, value.withdrawnAt, value.idempotencyKey, JSON.stringify(value)]);
}
/** 只允许 active → withdrawn：触发器保证范围、字段、原始收件版本与重试标识不可改写。 */
export async function updateWorkDisclosure(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: WorkDisclosure): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ej_work_disclosures SET status=$5,revision=$6,updated_at=$7,withdrawn_at=$8,document=$9::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4",
    [...scopeParameters(scope), value.id, expectedRevision, value.status, value.revision, value.updatedAt, value.withdrawnAt, JSON.stringify(value)]);
  return result.rowCount === 1;
}
/**
 * 规划 34 C②：文字留言的**唯一**存储读写（P5 新增两张表）。
 * 除下列函数外，没有任何地方读写 `ej_work_comments` / `ej_work_comment_reports`；
 * 留言是独立事实，**不参与**任何汇总、名次、公布或导出（那些读取路径不引用这两张表）。
 */
export function listWorkComments(sql: SqlExecutor, scope: HostedEventScope): Promise<WorkComment[]> {
  return many<WorkComment>(sql, "SELECT document FROM ej_work_comments WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function getWorkComment(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<WorkComment | null> {
  return first<WorkComment>(sql, "SELECT document FROM ej_work_comments WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
export function findWorkCommentReplay(sql: SqlExecutor, scope: HostedEventScope, authorUserId: EntityId, idempotencyKey: string): Promise<WorkComment | null> {
  return first<WorkComment>(sql, "SELECT document FROM ej_work_comments WHERE organization_id=$1 AND event_id=$2 AND author_user_id=$3 AND idempotency_key=$4", [...scopeParameters(scope), authorUserId, idempotencyKey]);
}
export async function insertWorkComment(sql: SqlExecutor, value: WorkComment): Promise<void> {
  await sql.query("INSERT INTO ej_work_comments(id,organization_id,event_id,team_id,snapshot_id,author_user_id,status,revision,created_at,hidden_at,idempotency_key,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
    [value.id, value.organizationId, value.eventId, value.teamId, value.snapshotId, value.authorUserId, value.status, value.revision,
      value.createdAt, value.hiddenAt, value.idempotencyKey, JSON.stringify(value)]);
}
/** 只允许 active → hidden：触发器保证正文、作者与原始作品版本不可改写，且版本只能加一。 */
export async function updateWorkComment(sql: SqlExecutor, scope: HostedEventScope, expectedRevision: number, value: WorkComment): Promise<boolean> {
  requireScope(scope, value); requireNextRevision(expectedRevision, value);
  const result = await sql.query("UPDATE ej_work_comments SET status=$5,revision=$6,hidden_at=$7,document=$8::jsonb WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND revision=$4",
    [...scopeParameters(scope), value.id, expectedRevision, value.status, value.revision, value.hiddenAt, JSON.stringify(value)]);
  return result.rowCount === 1;
}
/** 举报事实（append-only）：同账号同留言最多一条，重复举报由服务层幂等返回原记录。 */
export function listWorkCommentReports(sql: SqlExecutor, scope: HostedEventScope): Promise<WorkCommentReport[]> {
  return many<WorkCommentReport>(sql, "SELECT document FROM ej_work_comment_reports WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id", scopeParameters(scope));
}
export function findWorkCommentReport(sql: SqlExecutor, scope: HostedEventScope, commentId: EntityId, reporterUserId: EntityId): Promise<WorkCommentReport | null> {
  return first<WorkCommentReport>(sql, "SELECT document FROM ej_work_comment_reports WHERE organization_id=$1 AND event_id=$2 AND comment_id=$3 AND reporter_user_id=$4", [...scopeParameters(scope), commentId, reporterUserId]);
}
export async function insertWorkCommentReport(sql: SqlExecutor, value: WorkCommentReport): Promise<void> {
  await sql.query("INSERT INTO ej_work_comment_reports(id,organization_id,event_id,comment_id,reporter_user_id,reason,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [value.id, value.organizationId, value.eventId, value.commentId, value.reporterUserId, value.reason, value.createdAt, JSON.stringify(value)]);
}
export function getPublished(sql: SqlExecutor, scope: HostedEventScope, id: EntityId): Promise<PublishedResults | null> {
  return first<PublishedResults>(sql, "SELECT document FROM ej_published_results WHERE organization_id=$1 AND event_id=$2 AND id=$3", [...scopeParameters(scope), id]);
}
/** Publication withdrawal changes the round pointer, never the published document. */
export async function insertPublished(sql: SqlExecutor, value: PublishedResults): Promise<void> {
  await sql.query("INSERT INTO ej_published_results(id,organization_id,event_id,round_id,version,visibility,published_at,published_by,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
    [value.id, value.organizationId, value.eventId, value.roundId, value.version, value.visibility, value.publishedAt, value.publishedBy, JSON.stringify(value)]);
}
