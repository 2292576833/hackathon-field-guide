import type { EntityId, Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventSitePageSpec } from "./model.ts";
import { serializeSpec } from "./validation.ts";

/**
 * 专属页的**存储适配**（规划 35 §10、§11；根迁移 migrations/080_event_site.sql）。
 *
 * 这一层只做四件事：读写 080 的两张表、把行解码成记录、把数据库的并发/唯一约束翻译成
 * DomainError、以及生成不透明短码。它**不**碰权限、不碰发布门槛、不碰审计——那些在
 * service.ts；它也不新建任何表、不写其他模块的表。
 *
 * 三条存储不变量都落在 SQL 的 WHERE 里，而不是只写在注释里：
 * 1. **CAS**：所有写语句都带 AND revision=$n，revision 每次写加一；改不到行就返回 null，
 *    由服务层翻译成 409 并带上最新版本。
 * 2. **published 只有一个写入者**：只有 publish() 的语句写 published；草稿、短码、停用、
 *    恢复的语句**都不出现** published=，因此线上快照不会被别的操作悄悄改写。
 * 3. **停用不删数据**：suspend() 只改状态与 suspended_*，draft 与 published 的值原样保留。
 *
 * 080 的两条 CHECK 决定了停用时的唯一合法写法（见 suspend() 注释与交付文档「CAS 与不可变证据」）。
 */

export type EventSitePageStatus = "draft" | "published" | "suspended";
export type EventSiteSuspensionKind = "organizer" | "platform";

/** 停用事实。kind 是**治理级别**：平台停用的页面主办方不能自行恢复（规划 35 §11）。 */
export interface EventSiteSuspension {
  readonly kind: EventSiteSuspensionKind;
  readonly reason: string | null;
  readonly at: Instant;
  readonly by: EntityId;
}

/** 一赛事一条的页面记录（= organizer_page_specs 一行）。 */
export interface EventSitePageRecord {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly eventId: EntityId;
  readonly shortCode: string;
  readonly status: EventSitePageStatus;
  readonly revision: number;
  /** 草稿规格（正在编辑的那一份）。 */
  readonly draft: EventSitePageSpec;
  /** 已发布的**不可变快照**；没发布过是 null。 */
  readonly published: EventSitePageSpec | null;
  /** 发布版本号（每发布一次加一）。 */
  readonly publishedRevision: number | null;
  readonly publishedAt: Instant | null;
  readonly suspension: EventSiteSuspension | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/** 机构级模板记录（= organizer_page_templates 一行）。只存规格快照。 */
export interface EventSiteTemplateRecord {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly name: string;
  readonly revision: number;
  readonly spec: EventSitePageSpec;
  readonly createdBy: EntityId;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/* ------------------------------------------------------------------ *
 * 短码：不透明随机串（规划 35 §2、§11）
 * ------------------------------------------------------------------ */

/** 根迁移里短码 CHECK 的上下界：只允许 8 到 32 位字母数字。 */
export const EVENT_SITE_SHORT_CODE_MIN_LENGTH = 8;
export const EVENT_SITE_SHORT_CODE_MAX_LENGTH = 32;
/** 实际生成长度：16 位 base62 约 95 bit，长到不担心撞，也短到能贴进二维码。 */
export const EVENT_SITE_SHORT_CODE_LENGTH = 16;
export const EVENT_SITE_SHORT_CODE_PATTERN = /^[A-Za-z0-9]{8,32}$/;
/** 一次生成最多重试几轮（每轮都换一个候选码）。冲突重试有上限，不无限循环。 */
export const EVENT_SITE_SHORT_CODE_MAX_ATTEMPTS = 5;

const SHORT_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 62 × 4 = 248：只接受 <248 的字节，避免取模偏置。 */
const SHORT_CODE_UNBIASED_LIMIT = 248;
const SHORT_CODE_ALPHABET_SIZE = SHORT_CODE_ALPHABET.length;

/** 注入式短码来源：测试可以给确定序列，生产默认用密码学随机源。 */
export interface EventSiteShortCodeSource {
  next(): string;
}

export function isShortCode(value: unknown): value is string {
  return typeof value === "string" && EVENT_SITE_SHORT_CODE_PATTERN.test(value);
}

function shortCodeFailure(message: string): never {
  throw new DomainError("EVENT_SITE_SHORT_CODE_INVALID", message, { status: 500 });
}

function shortCodeLength(length: number): number {
  if (!Number.isInteger(length) || length < EVENT_SITE_SHORT_CODE_MIN_LENGTH || length > EVENT_SITE_SHORT_CODE_MAX_LENGTH) {
    shortCodeFailure("短码长度必须在 " + String(EVENT_SITE_SHORT_CODE_MIN_LENGTH) + " 到 " + String(EVENT_SITE_SHORT_CODE_MAX_LENGTH) + " 之间。");
  }
  return length;
}

/**
 * 从字节序列派生短码（确定性、可测）：跳过 >=248 的样本以消除取模偏置。
 * 字节不够时抛错，**不**用重复或零填充凑长度。
 */
export function shortCodeFromBytes(bytes: readonly number[], length: number = EVENT_SITE_SHORT_CODE_LENGTH): string {
  const size = shortCodeLength(length);
  let code = "";
  for (const byte of bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) shortCodeFailure("随机源返回了非法字节，无法生成专属链接。");
    if (byte >= SHORT_CODE_UNBIASED_LIMIT) continue;
    code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET_SIZE];
    if (code.length === size) return code;
  }
  return shortCodeFailure("随机源不足，无法生成完整的专属链接。");
}

function cryptoRandomBytes(size: number): Uint8Array {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new DomainError("EVENT_SITE_SHORT_CODE_SOURCE_UNAVAILABLE", "当前运行环境没有可用的密码学随机源，无法生成专属链接。", { status: 500 });
  }
  const bytes = new Uint8Array(size);
  source.getRandomValues(bytes);
  return bytes;
}

export interface EventSiteShortCodeOptions {
  readonly length?: number;
  /** 只在测试里替换；生产必须走密码学随机源，**不得**用 Math.random。 */
  readonly random?: (size: number) => Uint8Array;
}

/**
 * 短码生成器。随机性来自 crypto.getRandomValues（不是 Math.random），
 * 每次 next() 都重新取随机字节，且**不**把任何随机值直接拼进 SQL（SQL 只收到参数）。
 */
export function createShortCodeSource(options: EventSiteShortCodeOptions = {}): EventSiteShortCodeSource {
  const length = shortCodeLength(options.length ?? EVENT_SITE_SHORT_CODE_LENGTH);
  const random = options.random ?? cryptoRandomBytes;
  return {
    next(): string {
      let code = "";
      for (let round = 0; round < 16 && code.length < length; round += 1) {
        const chunk = random(length);
        for (const byte of chunk) {
          if (byte >= SHORT_CODE_UNBIASED_LIMIT) continue;
          code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET_SIZE];
          if (code.length === length) break;
        }
      }
      if (code.length !== length || !isShortCode(code)) shortCodeFailure("随机源不足，无法生成完整的专属链接。");
      return code;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 停用级别与理由
 * ------------------------------------------------------------------ */

export const EVENT_SITE_SUSPENSION_REASON_MAX = 500;

/**
 * 停用理由只存人话，**不承载治理级别**：级别是 `suspended_kind` 列（迁移 080）。
 * 「平台停用主办方不能恢复」是治理事实，不能靠查当前角色反推（角色会变，历史结论就该跟着变）。
 */
export function suspensionReasonText(reason: string | null): string | null {
  if (reason === null) return null;
  const text = reason.trim();
  if (text.length > EVENT_SITE_SUSPENSION_REASON_MAX) {
    throw new DomainError("EVENT_SITE_INVALID_SUSPENSION_REASON", "停用理由最多 " + String(EVENT_SITE_SUSPENSION_REASON_MAX) + " 个字符。", { status: 422 });
  }
  return text.length > 0 ? text : null;
}

/* ------------------------------------------------------------------ *
 * 行解码
 * ------------------------------------------------------------------ */

interface PageRow {
  readonly id: string;
  readonly organization_id: string;
  readonly event_id: string;
  readonly short_code: string;
  readonly status: string;
  readonly revision: number;
  readonly draft: unknown;
  readonly published: unknown;
  readonly published_revision: number | null;
  readonly published_at: Date | string | null;
  readonly suspended_at: Date | string | null;
  readonly suspended_by: string | null;
  readonly suspended_kind: string | null;
  readonly suspended_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface TemplateRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly revision: number;
  readonly spec: unknown;
  readonly created_by: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const PAGE_COLUMNS = "id,organization_id,event_id,short_code,status,revision,draft,published,published_revision,published_at,suspended_at,suspended_by,suspended_kind,suspended_reason,created_at,updated_at";
const TEMPLATE_COLUMNS = "id,organization_id,name,revision,spec,created_by,created_at,updated_at";

function instant(value: Date | string | null | undefined, what: string): Instant {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new DomainError("EVENT_SITE_PAGE_STATE_INVALID", "这一页的" + what + "时间读取失败，请联系平台。", { status: 503 });
}

function decodeSpec(value: unknown, what: string): EventSitePageSpec {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DomainError("EVENT_SITE_PAGE_STATE_INVALID", "这一页的" + what + "记录已损坏，请联系平台。", { status: 503 });
  }
  return parsed as EventSitePageSpec;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function statusOf(value: string): EventSitePageStatus {
  if (value === "draft" || value === "published" || value === "suspended") return value;
  throw new DomainError("EVENT_SITE_PAGE_STATE_INVALID", "这一页的状态未知，请联系平台。", { status: 503 });
}

function suspensionOf(row: PageRow): EventSiteSuspension | null {
  if (row.suspended_at === null || row.suspended_by === null) return null;
  // 来源不明的行按平台停用保守处理：宁可让主办方找平台，也不让它自行解除。
  const kind: EventSiteSuspensionKind = row.suspended_kind === "organizer" ? "organizer" : "platform";
  const text = row.suspended_reason === null ? "" : row.suspended_reason.trim();
  return { kind, reason: text.length > 0 ? text : null, at: instant(row.suspended_at, "停用"), by: row.suspended_by };
}

function page(row: PageRow): EventSitePageRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventId: row.event_id,
    shortCode: row.short_code,
    status: statusOf(row.status),
    revision: row.revision,
    draft: decodeSpec(row.draft, "草稿"),
    published: row.published === null ? null : decodeSpec(row.published, "线上快照"),
    publishedRevision: row.published_revision,
    publishedAt: row.published_at === null ? null : instant(row.published_at, "发布"),
    suspension: suspensionOf(row),
    createdAt: instant(row.created_at, "创建"),
    updatedAt: instant(row.updated_at, "更新"),
  };
}

function template(row: TemplateRow): EventSiteTemplateRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    revision: row.revision,
    spec: decodeSpec(row.spec, "模板"),
    createdBy: row.created_by,
    createdAt: instant(row.created_at, "创建"),
    updatedAt: instant(row.updated_at, "更新"),
  };
}

/* ------------------------------------------------------------------ *
 * 约束错误翻译（唯一索引 → 可读 409）
 * ------------------------------------------------------------------ */

function errorField(error: unknown, field: "code" | "constraint"): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/** 23505 = unique_violation。只翻译**本模块**的约束，别把别人的错误说成短码冲突。 */
function translateUnique(error: unknown, constraint: string): never {
  if (errorField(error, "code") === "23505" && (errorField(error, "constraint") ?? "").includes(constraint)) {
    if (constraint === "short_code") throw new DomainError("EVENT_SITE_SHORT_CODE_TAKEN", "这个短码已被占用，请重新生成。", { status: 409, recoveryAction: "reload" });
    if (constraint === "organization_id_name") throw new DomainError("EVENT_SITE_TEMPLATE_NAME_TAKEN", "这个机构里已经有同名模板，请换个名字。", { status: 409 });
  }
  throw error;
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

export async function readPage(sql: SqlExecutor, eventId: EntityId): Promise<EventSitePageRecord | null> {
  const result = await sql.query<PageRow>("SELECT " + PAGE_COLUMNS + " FROM organizer_page_specs WHERE event_id=$1", [eventId]);
  const row = result.rows[0];
  return row === undefined ? null : page(row);
}

export async function findPageByShortCode(sql: SqlExecutor, shortCode: string): Promise<EventSitePageRecord | null> {
  const result = await sql.query<PageRow>("SELECT " + PAGE_COLUMNS + " FROM organizer_page_specs WHERE short_code=$1", [shortCode]);
  const row = result.rows[0];
  return row === undefined ? null : page(row);
}

/** 机构级清点（只读；按最近更新倒序，条数有上限）。 */
export async function listOrganizationPages(sql: SqlExecutor, organizationId: EntityId, limit: number): Promise<EventSitePageRecord[]> {
  const result = await sql.query<PageRow>(
    "SELECT " + PAGE_COLUMNS + " FROM organizer_page_specs WHERE organization_id=$1 ORDER BY updated_at DESC, id LIMIT $2",
    [organizationId, Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
  return result.rows.map(page);
}

/** 平台只读清点（跨机构；同样有上限，不做全表扫描式分页）。 */
export async function listAllPages(sql: SqlExecutor, limit: number): Promise<EventSitePageRecord[]> {
  const result = await sql.query<PageRow>(
    "SELECT " + PAGE_COLUMNS + " FROM organizer_page_specs ORDER BY updated_at DESC, id LIMIT $1",
    [Math.max(1, Math.min(500, Math.trunc(limit)))],
  );
  return result.rows.map(page);
}

/* ------------------------------------------------------------------ *
 * 写：页面
 * ------------------------------------------------------------------ */

export interface CreatePageInput {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly shortCode: string;
  readonly spec: EventSitePageSpec;
  readonly now: Instant;
}

/**
 * 建页（唯一入口：第一次保存草稿）。
 *
 * ON CONFLICT (event_id) DO NOTHING：两个人同时开编辑器时，后到的那次**不**覆盖先到的，
 * 返回 null 让服务层给 409；短码唯一冲突则翻译成 409（服务层会换一个候选码重试整个操作）。
 */
export async function createPage(sql: SqlExecutor, eventId: EntityId, input: CreatePageInput): Promise<number | null> {
  const draft = serializeSpec(input.spec);
  try {
    const result = await sql.query(
      "INSERT INTO organizer_page_specs(id,organization_id,event_id,short_code,status,revision,draft,published,published_revision,published_at,suspended_at,suspended_by,suspended_kind,suspended_reason,created_at,updated_at)"
      + " VALUES($1,$2,$3,$4,'draft',1,$5::jsonb,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$6::timestamptz,$6::timestamptz)"
      + " ON CONFLICT (event_id) DO NOTHING",
      [input.id, input.organizationId, eventId, input.shortCode, draft, input.now],
    );
    return result.rowCount === 0 ? null : 1;
  } catch (error) {
    return translateUnique(error, "short_code");
  }
}

export interface SaveDraftInput {
  readonly spec: EventSitePageSpec;
  readonly expectedRevision: number;
  readonly now: Instant;
}

/** 草稿 CAS：只改 draft 与 revision/updated_at，不碰 published。 */
export async function saveDraft(sql: SqlExecutor, eventId: EntityId, input: SaveDraftInput): Promise<number | null> {
  const draft = serializeSpec(input.spec);
  const result = await sql.query<{ revision: number }>(
    "UPDATE organizer_page_specs SET draft=$3::jsonb, revision=revision+1, updated_at=$4::timestamptz WHERE event_id=$1 AND revision=$2 RETURNING revision",
    [eventId, input.expectedRevision, draft, input.now],
  );
  return result.rows[0]?.revision ?? null;
}

export interface PublishInput {
  /** serializeSpec 之后的快照（服务层已用 parseSpec 过闸门）。 */
  readonly snapshot: string;
  readonly publishedRevision: number;
  readonly expectedRevision: number;
  readonly at: Instant;
}

/**
 * 发布：把**草稿快照**写进 published。
 *
 * - 这是 published 唯一的写入语句（整个文件只有这里出现 published=）；
 * - 从 draft/published 两态都可以发（改完再发 = 新发布版本），suspended 态被 WHERE 挡住；
 * - 同时把 revision 加一，于是同一份草稿的并发发布会有一方拿到 null（409）。
 */
export async function publish(sql: SqlExecutor, eventId: EntityId, input: PublishInput): Promise<number | null> {
  const result = await sql.query<{ revision: number }>(
    "UPDATE organizer_page_specs SET published=$3::jsonb, published_revision=$4, published_at=$5::timestamptz, status='published',"
    + " revision=revision+1, updated_at=$5::timestamptz"
    + " WHERE event_id=$1 AND revision=$2 AND status IN ('draft','published') RETURNING revision",
    [eventId, input.expectedRevision, input.snapshot, input.publishedRevision, input.at],
  );
  return result.rows[0]?.revision ?? null;
}

export interface RotateShortCodeInput {
  readonly shortCode: string;
  readonly expectedRevision: number;
  readonly now: Instant;
}

/** 换短码：旧链接立即失效（short_code 唯一，换掉就不再有行指向旧码）。 */
export async function rotateShortCode(sql: SqlExecutor, eventId: EntityId, input: RotateShortCodeInput): Promise<number | null> {
  try {
    const result = await sql.query<{ revision: number }>(
      "UPDATE organizer_page_specs SET short_code=$3, revision=revision+1, updated_at=$4::timestamptz WHERE event_id=$1 AND revision=$2 RETURNING revision",
      [eventId, input.expectedRevision, input.shortCode, input.now],
    );
    return result.rows[0]?.revision ?? null;
  } catch (error) {
    return translateUnique(error, "short_code");
  }
}

export interface SuspendInput {
  readonly expectedRevision: number;
  readonly kind: EventSiteSuspensionKind;
  readonly by: EntityId;
  readonly reason: string | null;
  readonly at: Instant;
}

/**
 * 停用：只改状态与 suspended_*，draft 与 published 原样保留。
 *
 * **为什么这里必须把 published_at 置空**：080 的一致性 CHECK 要求
 * (status='published') = (published IS NOT NULL AND published_revision IS NOT NULL AND published_at IS NOT NULL)，
 * 也就是说只要状态不是 published，这三个字段里就**必须**至少有一个是 NULL。停用不能丢快照
 * （published 是线上内容的唯一证据）、也不能丢发布版本（published_revision 是发布历史），
 * 于是只能清掉时间戳；恢复时由 resume() 写入「重新上线时间」。
 * 这一条是 080 现状下的**最小合法降级**，已登记在交付文档的 NEEDS_INTERFACE（建议 081 放宽该 CHECK）。
 */
export async function suspend(sql: SqlExecutor, eventId: EntityId, input: SuspendInput): Promise<number | null> {
  const reason = suspensionReasonText(input.reason);
  const result = await sql.query<{ revision: number }>(
    "UPDATE organizer_page_specs SET status='suspended', suspended_at=$3::timestamptz, suspended_by=$4, suspended_kind=$5, suspended_reason=$6,"
    + " published_at=NULL, revision=revision+1, updated_at=$3::timestamptz"
    + " WHERE event_id=$1 AND revision=$2 RETURNING revision",
    [eventId, input.expectedRevision, input.at, input.by, input.kind, reason],
  );
  return result.rows[0]?.revision ?? null;
}

export interface ResumeInput {
  readonly expectedRevision: number;
  /** 有线上快照就回 published，从没发布过就回 draft。 */
  readonly nextStatus: "published" | "draft";
  /** 回 published 时必须给：这是「重新上线时间」（原发布时间在 080 现状下无法保留）。 */
  readonly publishedAt: Instant | null;
  readonly at: Instant;
}

/** 恢复：清 suspended_*，按有没有线上快照回到 published 或 draft。**不碰** published 内容。 */
export async function resume(sql: SqlExecutor, eventId: EntityId, input: ResumeInput): Promise<number | null> {
  const result = await sql.query<{ revision: number }>(
    "UPDATE organizer_page_specs SET status=$3, published_at=$4::timestamptz, suspended_at=NULL, suspended_by=NULL, suspended_kind=NULL, suspended_reason=NULL,"
    + " revision=revision+1, updated_at=$5::timestamptz WHERE event_id=$1 AND revision=$2 RETURNING revision",
    [eventId, input.expectedRevision, input.nextStatus, input.publishedAt, input.at],
  );
  return result.rows[0]?.revision ?? null;
}

/* ------------------------------------------------------------------ *
 * 写：机构模板（套用=复制，不做跨赛事联动）
 * ------------------------------------------------------------------ */

export async function listTemplates(sql: SqlExecutor, organizationId: EntityId): Promise<EventSiteTemplateRecord[]> {
  const result = await sql.query<TemplateRow>(
    "SELECT " + TEMPLATE_COLUMNS + " FROM organizer_page_templates WHERE organization_id=$1 ORDER BY updated_at DESC, id LIMIT 500",
    [organizationId],
  );
  return result.rows.map(template);
}

export async function readTemplate(sql: SqlExecutor, organizationId: EntityId, templateId: EntityId): Promise<EventSiteTemplateRecord | null> {
  const result = await sql.query<TemplateRow>(
    "SELECT " + TEMPLATE_COLUMNS + " FROM organizer_page_templates WHERE organization_id=$1 AND id=$2",
    [organizationId, templateId],
  );
  const row = result.rows[0];
  return row === undefined ? null : template(row);
}

export interface InsertTemplateInput {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly name: string;
  readonly spec: EventSitePageSpec;
  readonly createdBy: EntityId;
  readonly now: Instant;
}

export async function insertTemplate(sql: SqlExecutor, input: InsertTemplateInput): Promise<EventSiteTemplateRecord> {
  const spec = serializeSpec(input.spec);
  try {
    await sql.query(
      "INSERT INTO organizer_page_templates(id,organization_id,name,revision,spec,created_by,created_at,updated_at) VALUES($1,$2,$3,1,$4::jsonb,$5,$6::timestamptz,$6::timestamptz)",
      [input.id, input.organizationId, input.name, spec, input.createdBy, input.now],
    );
  } catch (error) {
    return translateUnique(error, "organization_id_name");
  }
  return { id: input.id, organizationId: input.organizationId, name: input.name, revision: 1, spec: input.spec, createdBy: input.createdBy, createdAt: input.now, updatedAt: input.now };
}

export interface UpdateTemplateInput {
  readonly templateId: EntityId;
  readonly organizationId: EntityId;
  readonly name: string;
  readonly spec: EventSitePageSpec;
  readonly expectedRevision: number;
  readonly now: Instant;
}

export async function updateTemplate(sql: SqlExecutor, input: UpdateTemplateInput): Promise<number | null> {
  const spec = serializeSpec(input.spec);
  try {
    const result = await sql.query<{ revision: number }>(
      "UPDATE organizer_page_templates SET name=$3, spec=$4::jsonb, revision=revision+1, updated_at=$5::timestamptz WHERE organization_id=$1 AND id=$2 AND revision=$6 RETURNING revision",
      [input.organizationId, input.templateId, input.name, spec, input.now, input.expectedRevision],
    );
    return result.rows[0]?.revision ?? null;
  } catch (error) {
    return translateUnique(error, "organization_id_name");
  }
}

export async function deleteTemplate(sql: SqlExecutor, organizationId: EntityId, templateId: EntityId): Promise<boolean> {
  const result = await sql.query("DELETE FROM organizer_page_templates WHERE organization_id=$1 AND id=$2", [organizationId, templateId]);
  return result.rowCount === 1;
}
