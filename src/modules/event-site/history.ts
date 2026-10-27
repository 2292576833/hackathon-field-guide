import type { EntityId, Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventSitePageSpec } from "./model.ts";
import { serializeSpec } from "./validation.ts";

/**
 * 草稿历史与版本回退的**存储适配**（规划 35 §6.3「实时预览与修改」、§16 P4「版本回退」；
 * 根迁移建议 migrations/081_event_site_revisions.sql ← 本目录 002-page-revisions.sql）。
 *
 * 这一层只做四件事：写一条历史、按赛事裁剪、列摘要、读某一版规格。
 * 权限、CAS、闸门、审计都在 service.ts；它**不**碰 organizer_page_specs，也不写任何其他表。
 *
 * 五条不变量（都落在 SQL 与常量里，不只写在注释里）：
 * 1. **只存草稿历史**：发布快照仍然只在 organizer_page_specs.published，这张表里没有 published 列；
 * 2. **每赛事 revision 唯一**：UNIQUE(event_id, revision)，历史号与草稿行版本同一口径；
 * 3. **保留窗口有界**：每个赛事只留最近 EVENT_SITE_REVISION_HISTORY_LIMIT 条，插入后在同一事务里裁剪
 *    （pruneRevisions 只删本赛事、且只删窗口外的行，返回被删的版本号以便逐条核对）；
 * 4. **列表不带正文**：listRevisionSummaries 只 SELECT revision/created_by/created_at，
 *    规格正文必须走 readRevision 单条读，避免一次拉全量；
 * 5. **跨赛事默认不可见**：所有语句都以 event_id 为第一过滤条件，编号无法跨赛事复用。
 */

/** 保留窗口：每赛事只保留最近 20 条草稿历史（规划 35 §16 P4）。 */
export const EVENT_SITE_REVISION_HISTORY_LIMIT = 20;
/** 历史表名（迁移 081 建议；检测是否已应用时也用它）。 */
export const EVENT_SITE_REVISION_TABLE = "organizer_page_revisions";

/** 历史一条的**摘要**（列表用，不含 spec 正文）。 */
export interface EventSiteRevisionSummary {
  readonly revision: number;
  readonly createdBy: EntityId;
  readonly createdAt: Instant;
}

/** 列表结果：按 revision 倒序；truncated 为真表示已达保留窗口上限。 */
export interface EventSiteRevisionList {
  readonly revisions: readonly EventSiteRevisionSummary[];
  readonly truncated: boolean;
}

/** 历史一条的完整记录（仅单条回退时使用）。spec 是**未校验**的原始值，必须再过 parseSpec/normalizeSpec。 */
export interface EventSiteRevisionRecord {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly eventId: EntityId;
  readonly revision: number;
  readonly spec: unknown;
  readonly createdBy: EntityId;
  readonly createdAt: Instant;
}

export interface InsertRevisionInput {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly eventId: EntityId;
  readonly revision: number;
  readonly spec: EventSitePageSpec;
  readonly createdBy: EntityId;
  readonly createdAt: Instant;
}

interface RevisionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly event_id: string;
  readonly revision: number;
  readonly spec: unknown;
  readonly created_by: string;
  readonly created_at: Date | string;
}

interface SummaryRow {
  readonly revision: number;
  readonly created_by: string;
  readonly created_at: Date | string;
}

function instant(value: Date | string, what: string): Instant {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new DomainError("EVENT_SITE_PAGE_STATE_INVALID", "草稿历史的" + what + "时间读取失败，请联系平台。", { status: 503 });
}

/** 历史表是否已建（迁移未应用时，服务层如实降级而不是抛 SQL 错）。 */
export async function isRevisionHistoryReady(sql: SqlExecutor): Promise<boolean> {
  const result = await sql.query<{ present: boolean | null }>(
    "SELECT to_regclass($1::text) IS NOT NULL AS present",
    [EVENT_SITE_REVISION_TABLE],
  );
  return result.rows[0]?.present === true;
}

/**
 * 写一条历史。**调用方必须在同一个事务里**，并且 revision 必须等于这次写入的草稿版本号。
 * 重复写同一个 (event_id, revision) 会被 UNIQUE 挡住并翻译成 409（说明调用方算错了版本号）。
 */
export async function insertRevision(sql: SqlExecutor, input: InsertRevisionInput): Promise<void> {
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
    throw new DomainError("EVENT_SITE_INVALID_REVISION", "历史版本号必须是正整数。", { status: 422 });
  }
  const spec = serializeSpec(input.spec);
  try {
    await sql.query(
      "INSERT INTO organizer_page_revisions(id,organization_id,event_id,revision,spec,created_by,created_at)"
      + " VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)",
      [input.id, input.organizationId, input.eventId, input.revision, spec, input.createdBy, input.createdAt],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError("EVENT_SITE_REVISION_HISTORY_CONFLICT", "这一版草稿已经在历史里了，没有重复写入。", { status: 409, recoveryAction: "reload" });
    }
    throw error;
  }
}

/**
 * 裁剪：只删**本赛事**、且落在最近 keep 条之外的行。
 * 返回被删掉的版本号（升序），于是"删了什么"是可断言的事实，不是一句注释。
 */
export async function pruneRevisions(
  sql: SqlExecutor,
  eventId: EntityId,
  keep: number = EVENT_SITE_REVISION_HISTORY_LIMIT,
): Promise<readonly number[]> {
  const window = Number.isSafeInteger(keep) && keep > 0 ? keep : EVENT_SITE_REVISION_HISTORY_LIMIT;
  const result = await sql.query<{ revision: number }>(
    "DELETE FROM organizer_page_revisions WHERE event_id=$1 AND revision NOT IN ("
    + "SELECT revision FROM organizer_page_revisions WHERE event_id=$1 ORDER BY revision DESC LIMIT $2"
    + ") RETURNING revision",
    [eventId, window],
  );
  return result.rows.map(row => row.revision).sort((left, right) => left - right);
}

/** 一次"留痕"= 插入 + 同一个事务里裁剪。返回被裁掉的版本号（通常为空数组）。 */
export async function recordRevision(
  sql: SqlExecutor,
  input: InsertRevisionInput,
  keep: number = EVENT_SITE_REVISION_HISTORY_LIMIT,
): Promise<readonly number[]> {
  await insertRevision(sql, input);
  return pruneRevisions(sql, input.eventId, keep);
}

/**
 * 列表：按 revision 倒序，**只读摘要、不读 spec**。
 * truncated：返回条数达到保留窗口上限时为真（更早的版本按保留策略已不再保留）。
 */
export async function listRevisionSummaries(
  sql: SqlExecutor,
  eventId: EntityId,
  limit: number = EVENT_SITE_REVISION_HISTORY_LIMIT,
): Promise<EventSiteRevisionList> {
  const window = Number.isSafeInteger(limit) && limit > 0 ? limit : EVENT_SITE_REVISION_HISTORY_LIMIT;
  const result = await sql.query<SummaryRow>(
    "SELECT revision,created_by,created_at FROM organizer_page_revisions WHERE event_id=$1 ORDER BY revision DESC LIMIT $2",
    [eventId, window],
  );
  const revisions = result.rows.map(row => ({
    revision: row.revision, createdBy: row.created_by, createdAt: instant(row.created_at, "创建"),
  }));
  return { revisions, truncated: revisions.length >= window };
}

/** 读某一版的完整记录；不存在（含已被裁剪、或属于别的赛事）返回 null。 */
export async function readRevision(
  sql: SqlExecutor,
  eventId: EntityId,
  revision: number,
): Promise<EventSiteRevisionRecord | null> {
  if (!Number.isSafeInteger(revision) || revision <= 0) return null;
  const result = await sql.query<RevisionRow>(
    "SELECT id,organization_id,event_id,revision,spec,created_by,created_at FROM organizer_page_revisions WHERE event_id=$1 AND revision=$2",
    [eventId, revision],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const spec = typeof row.spec === "string" ? parseJson(row.spec) : row.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new DomainError("EVENT_SITE_REVISION_SPEC_INVALID", "这一版草稿历史已损坏，不能回退。", { status: 503 });
  }
  return {
    id: row.id, organizationId: row.organization_id, eventId: row.event_id, revision: row.revision,
    spec, createdBy: row.created_by, createdAt: instant(row.created_at, "创建"),
  };
}

/** 本赛事现有历史条数（只用于核对保留窗口，不对外暴露）。 */
export async function countRevisions(sql: SqlExecutor, eventId: EntityId): Promise<number> {
  const result = await sql.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM organizer_page_revisions WHERE event_id=$1",
    [eventId],
  );
  return result.rows[0]?.total ?? 0;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = (error as Record<string, unknown>).code;
  return value === "23505";
}
