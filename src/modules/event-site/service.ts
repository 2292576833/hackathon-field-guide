import type { Clock, EntityId, IdGenerator, Instant } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSiteBindingField, EventSitePageSpec } from "./model.ts";
import { reviewSpec } from "./policy.ts";
import type { EventSitePolicyFinding } from "./policy.ts";
import { normalizeSpec, parseSpec, serializeSpec } from "./validation.ts";
import {
  createShortCodeSource, findPageByShortCode, isShortCode,
  type EventSitePageRecord, type EventSitePageStatus, type EventSiteShortCodeSource, type EventSiteSuspension,
  type EventSiteSuspensionKind, type EventSiteTemplateRecord, EVENT_SITE_SHORT_CODE_MAX_ATTEMPTS,
  EVENT_SITE_SUSPENSION_REASON_MAX,
} from "./postgres.ts";
import * as store from "./postgres.ts";
import type { EventSiteRevisionList } from "./history.ts";
import * as revisionHistory from "./history.ts";

/**
 * 专属页的**服务层**（规划 35 P1b）：权限、状态机、发布门槛、审计与只读投影。
 *
 * 一句话分工：postgres.ts 管"怎么存"，本文件管"谁能做什么、什么时候能做、做完留下什么"。
 *
 * 四条边界在这里落地：
 * 1. **权限只来自注入的端口**：event_manage 由 EventSiteAccessPort（根适配 organizer 的
 *    requireStaff）判定；机构模板要机构管理员；平台停用/平台恢复要平台管理员。
 *    本模块不读 auth 表、不缓存任何权限结论。
 * 2. **发布前必须过闸门**：publish() 先对**库里的草稿**跑 parseSpec（37 个 EVENT_SITE_* 码之一，
 *    失败 422），体检 findings（REVIEW_*）只附带、**不阻断**。
 * 3. **审计如实降级**：没注入 EventSiteAuditPort 时主流程照常，但每个写结果都带
 *    auditRecorded: false 与一句人话说明——不假装审计过。
 * 4. **公开面只读已发布快照**：未发布、已停用一律 404，不泄露草稿；事实值只从
 *    EventSiteFactPort 取，取不到就是 null（待确认），绝不推算。
 */

/* ------------------------------------------------------------------ *
 * 端口：根要注入的契约（实现都在根，本模块不碰别人的表）
 * ------------------------------------------------------------------ */

/** 公开只读赛事投影（页面标题/机构名）。不校验身份，只读已有赛事。 */
export interface EventSitePublicEvent {
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly title: string;
  readonly status: string;
}

/** 权限端口：全部由根适配既有 organizer / platform 角色判定，本模块不自己查授权表。 */
export interface EventSiteAccessPort {
  /** event_manage（根适配 organizer 的 requireStaff）。返回赛事范围（含机构）。 */
  requireEventManager(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: EntityId): Promise<HostedEventScope>;
  /** 机构管理员（根适配 organizer 的 requireOrganizationManager）。 */
  requireOrganizationAdmin(sql: SqlExecutor, principal: OrganizerPrincipal, organizationId: EntityId): Promise<void>;
  /** 平台管理员（根适配平台角色判定）。 */
  requirePlatformAdmin(sql: SqlExecutor, principal: OrganizerPrincipal): Promise<void>;
  /** 公开只读赛事投影。赛事不存在返回 null；不泄露任何主办方私有字段。 */
  publicEvent(sql: SqlExecutor, eventId: EntityId): Promise<EventSitePublicEvent | null>;
}

/** 审计事件类型。至少这 6 个页面事件；模板三个是 P6 模板库的同一套审计。 */
export const EVENT_SITE_AUDIT_ACTIONS = [
  "page_created",
  "page_draft_saved",
  "page_published",
  "page_short_code_rotated",
  "page_suspended",
  "page_resumed",
  "page_template_saved",
  "page_template_applied",
  "page_template_deleted",
  // P4：从草稿历史回退（只写草稿，不动 published，见 restoreRevision）。
  "page_revision_restored",
] as const;
export type EventSiteAuditAction = (typeof EVENT_SITE_AUDIT_ACTIONS)[number];

export interface EventSiteAuditDetail {
  readonly publishedRevision?: number;
  readonly shortCode?: string;
  readonly suspensionKind?: EventSiteSuspensionKind;
  readonly templateId?: EntityId;
  /** 这次回退是从哪一版历史来的（restoreRevision 专用）。 */
  readonly restoredFrom?: number;
}

/** 一条审计事实。根把它写进既有 organizer_audit_events，**不**新建审计表。 */
export interface EventSiteAuditEvent {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly eventId: EntityId | null;
  readonly actorUserId: EntityId;
  readonly action: EventSiteAuditAction;
  readonly entityId: EntityId;
  readonly revision: number;
  readonly createdAt: Instant;
  readonly detail?: EventSiteAuditDetail;
}

/** 审计端口：写**同一事务**（传进来的 sql），所以审计失败会连同业务一起回滚。 */
export interface EventSiteAuditPort {
  record(sql: SqlExecutor, event: EventSiteAuditEvent): Promise<void>;
}

export interface EventSiteScheduleFacts {
  readonly registrationCloses: Instant | null;
  readonly submissionCloses: Instant | null;
  readonly startsAt: Instant | null;
  readonly endsAt: Instant | null;
  readonly timezone: string | null;
}

export interface EventSiteScheduleNode {
  readonly id: EntityId;
  readonly title: string;
  readonly at: Instant | null;
  readonly kind: string;
}

export interface EventSiteFaqEntry {
  readonly id: EntityId;
  readonly question: string;
  readonly answer: string;
}

/** 事实端口：**只读**既有平台事实（赛程/赛程节点/公开 FAQ）。本模块只定义、不实现。 */
export interface EventSiteFactPort {
  schedule(sql: SqlExecutor, eventId: EntityId): Promise<EventSiteScheduleFacts>;
  scheduleNodes(sql: SqlExecutor, eventId: EntityId): Promise<readonly EventSiteScheduleNode[]>;
  faqEntries(sql: SqlExecutor, eventId: EntityId): Promise<readonly EventSiteFaqEntry[]>;
}

/* ------------------------------------------------------------------ *
 * 返回值
 * ------------------------------------------------------------------ */

/** 每个写结果都带上"审计到底记没记"，没记就明说（不阻断主流程）。 */
export interface EventSiteAuditFlag {
  readonly auditRecorded: boolean;
  readonly auditNotice: string | null;
}

export const eventSiteAuditUnavailableNotice = "这次操作已经生效，但没有接入审计端口，所以没有留下审计记录。";
export const eventSiteFactsUnavailableNotice = "还没有接入赛事事实读取，页面上的时间与 FAQ 会显示为待确认。";
/** P4：历史表（迁移 081）未应用时，保存照常生效但如实说明"这次没有留下历史"。 */
export const eventSiteRevisionHistoryDisabledNotice = "草稿历史还没有启用（迁移 081 未应用），这次保存没有留下历史版本；保存本身已经生效。";
export const eventSiteRevisionHistoryUnavailableNotice = "草稿历史还没有启用（迁移 081 未应用），暂时不能查看或回退版本；保存与发布照常。";
export const eventSitePublicPageLimitations: readonly string[] = Object.freeze([
  "这里只展示已发布快照：草稿与正在编辑的内容不会出现在公开页。",
  "时间与 FAQ 只来自平台记录；取不到时显示待确认，不推算、不补默认值。",
]);

/** 编辑页视图：覆盖交付文档要的 7 个字段（spec / published / revision / status / shortCode / findings / auditRecorded）。 */
export interface EventSiteOrganizerPageView extends EventSiteAuditFlag {
  readonly exists: boolean;
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly spec: EventSitePageSpec | null;
  readonly published: EventSitePageSpec | null;
  readonly revision: number;
  readonly status: EventSitePageStatus;
  readonly shortCode: string | null;
  readonly publishedRevision: number | null;
  readonly publishedAt: Instant | null;
  readonly suspension: EventSiteSuspension | null;
  /** 还没有这一页时给编辑器一份「默认全在」的起点；已有页面时为 null。 */
  readonly suggestedSpec: EventSitePageSpec | null;
  readonly findings: readonly EventSitePolicyFinding[];
}

export interface EventSiteSaveDraftInput {
  readonly spec: unknown;
  readonly expectedRevision: unknown;
}

export interface EventSiteSaveDraftResult extends EventSiteAuditFlag {
  readonly revision: number;
  readonly status: EventSitePageStatus;
  readonly shortCode: string;
  readonly publishedRevision: number | null;
  readonly created: boolean;
  readonly findings: readonly EventSitePolicyFinding[];
  /** 这次写入的草稿是否也进了历史（P4；迁移未应用时为 false，见 historyNotice）。 */
  readonly historyRecorded: boolean;
  readonly historyNotice: string | null;
}

export interface EventSitePublishInput {
  readonly expectedRevision: unknown;
}

export interface EventSitePublishResult extends EventSiteAuditFlag {
  readonly status: "published";
  readonly revision: number;
  readonly publishedRevision: number;
  readonly publishedAt: Instant;
  readonly findings: readonly EventSitePolicyFinding[];
}

export interface EventSiteRevisionInput {
  readonly expectedRevision: unknown;
}

export interface EventSiteRotateShortCodeResult extends EventSiteAuditFlag {
  readonly shortCode: string;
  readonly revision: number;
  readonly status: EventSitePageStatus;
}

export interface EventSiteSuspendInput {
  readonly expectedRevision: unknown;
  readonly kind: unknown;
  readonly reason?: unknown;
}

export interface EventSiteSuspendResult extends EventSiteAuditFlag {
  readonly status: "suspended";
  readonly revision: number;
  readonly suspension: EventSiteSuspension;
}

export interface EventSiteResumeResult extends EventSiteAuditFlag {
  readonly status: "published" | "draft";
  readonly revision: number;
  readonly publishedAt: Instant | null;
}

/* ---------------- P4：草稿历史与版本回退 ---------------- */

/**
 * 历史列表 = { revisions, truncated }，**不含 spec 正文**（避免一次拉全量），按 revision 倒序。
 * truncated 为真 = 已达保留窗口上限（每赛事只留最近 20 条，更早的版本不再保留）。
 * 形状来自 history.ts 的 EventSiteRevisionList，服务层原样返回，不再包一层。
 */
export interface EventSiteRestoreRevisionInput {
  /** 要回退到的那一版历史版本号。 */
  readonly revision: unknown;
  /** 当前草稿版本号（CAS；不符给 409）。 */
  readonly expectedRevision: unknown;
}

/**
 * 回退结果：产生一个**新的草稿版本**（不复用历史号），published 一个字节都不动。
 * restoredFrom 是这次取自哪一版历史，便于审计与界面说明。
 */
export interface EventSiteRestoreRevisionResult extends EventSiteAuditFlag {
  readonly revision: number;
  readonly restoredFrom: number;
  readonly status: EventSitePageStatus;
  readonly shortCode: string;
  /** 原样回传，证明线上快照没有被这次回退改动。 */
  readonly publishedRevision: number | null;
  readonly findings: readonly EventSitePolicyFinding[];
  readonly historyRecorded: boolean;
  readonly historyNotice: string | null;
}

/** 页面上的事实绑定值：每个字段都可能是 null（= 待确认），null 不是 0、也不是推算值。 */
export interface EventSiteFactValues {
  readonly registrationCloses: Instant | null;
  readonly submissionCloses: Instant | null;
  readonly startsAt: Instant | null;
  readonly endsAt: Instant | null;
  readonly scheduleNodes: readonly EventSiteScheduleNode[] | null;
  readonly faqEntries: readonly EventSiteFaqEntry[] | null;
  readonly timezone: string | null;
}

export interface EventSitePublicPageView {
  readonly shortCode: string;
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly event: EventSitePublicEvent | null;
  readonly spec: EventSitePageSpec;
  readonly publishedRevision: number;
  readonly publishedAt: Instant | null;
  readonly facts: EventSiteFactValues;
  readonly factsState: "read" | "unavailable";
  readonly factsNotice: string | null;
  readonly limitations: readonly string[];
}

export interface EventSitePageSummary {
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly shortCode: string;
  readonly status: EventSitePageStatus;
  readonly revision: number;
  readonly publishedRevision: number | null;
  readonly hasPublished: boolean;
  readonly suspensionKind: EventSiteSuspensionKind | null;
  readonly updatedAt: Instant;
}

export interface EventSitePageInventory extends EventSiteAuditFlag {
  readonly organizationId: EntityId | null;
  readonly items: readonly EventSitePageSummary[];
  readonly truncated: boolean;
}

export interface EventSiteTemplateView {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly name: string;
  readonly revision: number;
  readonly spec: EventSitePageSpec;
  readonly createdBy: EntityId;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface EventSiteSaveTemplateInput {
  readonly templateId?: unknown;
  readonly name: unknown;
  readonly spec: unknown;
  readonly expectedRevision?: unknown;
}

export interface EventSiteSaveTemplateResult extends EventSiteAuditFlag {
  readonly template: EventSiteTemplateView;
}

export interface EventSiteApplyTemplateInput {
  readonly templateId: unknown;
  readonly expectedRevision: unknown;
}

export interface EventSiteApplyTemplateResult extends EventSiteAuditFlag {
  readonly revision: number;
  readonly status: EventSitePageStatus;
  readonly shortCode: string;
  readonly created: boolean;
  readonly template: { readonly id: EntityId; readonly name: string; readonly revision: number };
  readonly findings: readonly EventSitePolicyFinding[];
  readonly historyRecorded: boolean;
  readonly historyNotice: string | null;
}

export interface EventSiteDeleteTemplateResult extends EventSiteAuditFlag {
  readonly deleted: true;
  readonly templateId: EntityId;
  readonly name: string;
  readonly revision: number;
}

/* ------------------------------------------------------------------ *
 * 常量与工具
 * ------------------------------------------------------------------ */

export const EVENT_SITE_PAGE_LIST_LIMIT = 200;
export const EVENT_SITE_PLATFORM_PAGE_LIST_LIMIT = 500;
export const EVENT_SITE_TEMPLATE_NAME_MAX = 60;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalidInput(message: string): never {
  throw new DomainError("EVENT_SITE_INVALID_INPUT", message, { status: 422 });
}

function pageMissing(): never {
  throw new DomainError("EVENT_SITE_PAGE_NOT_FOUND", "没有找到这个专属页。", { status: 404, recoveryAction: "reload" });
}

function revisionConflict(latest: number | null): never {
  throw new DomainError("EVENT_SITE_REVISION_CONFLICT", "这一页已被另一次修改更新，请重新读取后再试。", {
    status: 409, recoveryAction: "reload", latestRevision: latest === null ? undefined : latest,
  });
}

/** 目标历史版本不存在（含已被保留策略裁剪、或属于别的赛事——同一个 404，不泄露编号空间）。 */
function revisionNotFound(revision: number): never {
  throw new DomainError("EVENT_SITE_REVISION_NOT_FOUND", "没有找到第 " + String(revision) + " 版草稿历史，它可能已被保留策略裁剪（每场只留最近 20 版）。", {
    status: 404, recoveryAction: "reload",
  });
}

/** 历史表未应用：读/回退直接 503，不把"读不到历史"伪装成"没有历史"。 */
function revisionHistoryUnavailable(): never {
  throw new DomainError("EVENT_SITE_REVISION_HISTORY_UNAVAILABLE", eventSiteRevisionHistoryUnavailableNotice, { status: 503 });
}

function idOf(value: unknown, label: string): EntityId {
  if (typeof value !== "string") invalidInput("缺少有效的" + label + "。");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 160) invalidInput("缺少有效的" + label + "。");
  return trimmed;
}

function revisionOf(value: unknown, label: string = "版本号"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("EVENT_SITE_INVALID_REVISION", label + "必须是非负整数；请重新读取这一页再操作。", { status: 422 });
  }
  return value;
}

function suspensionKindOf(value: unknown): EventSiteSuspensionKind {
  if (value !== "organizer" && value !== "platform") {
    throw new DomainError("EVENT_SITE_INVALID_SUSPENSION_KIND", "停用来源只能是主办方或平台。", { status: 422 });
  }
  return value;
}

function suspensionReasonOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new DomainError("EVENT_SITE_INVALID_SUSPENSION_REASON", "停用理由必须是纯文本。", { status: 422 });
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (CONTROL_CHARACTERS.test(trimmed)) throw new DomainError("EVENT_SITE_INVALID_SUSPENSION_REASON", "停用理由里有不可见控制字符。", { status: 422 });
  if (Array.from(trimmed).length > EVENT_SITE_SUSPENSION_REASON_MAX) {
    throw new DomainError("EVENT_SITE_INVALID_SUSPENSION_REASON", "停用理由最多 " + String(EVENT_SITE_SUSPENSION_REASON_MAX) + " 个字符。", { status: 422 });
  }
  return trimmed;
}

function templateNameOf(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("EVENT_SITE_INVALID_TEMPLATE_NAME", "给模板起一个 1 到 60 字的名字。", { status: 422 });
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length === 0 || length > EVENT_SITE_TEMPLATE_NAME_MAX) {
    throw new DomainError("EVENT_SITE_INVALID_TEMPLATE_NAME", "模板名字要有 1 到 " + String(EVENT_SITE_TEMPLATE_NAME_MAX) + " 个字符。", { status: 422 });
  }
  if (CONTROL_CHARACTERS.test(trimmed)) throw new DomainError("EVENT_SITE_INVALID_TEMPLATE_NAME", "模板名字里有不可见控制字符。", { status: 422 });
  return trimmed;
}

function auditFlag(recorded: boolean): EventSiteAuditFlag {
  return recorded
    ? { auditRecorded: true, auditNotice: null }
    : { auditRecorded: false, auditNotice: eventSiteAuditUnavailableNotice };
}

function templateView(record: EventSiteTemplateRecord): EventSiteTemplateView {
  return {
    id: record.id, organizationId: record.organizationId, name: record.name, revision: record.revision,
    spec: record.spec, createdBy: record.createdBy, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function pageSummary(record: EventSitePageRecord): EventSitePageSummary {
  return {
    eventId: record.eventId, organizationId: record.organizationId, shortCode: record.shortCode,
    status: record.status, revision: record.revision, publishedRevision: record.publishedRevision,
    hasPublished: record.published !== null, suspensionKind: record.suspension === null ? null : record.suspension.kind,
    updatedAt: record.updatedAt,
  };
}

/** 规格里真正被引用到的事实字段：只读这些，不整页拉一遍。 */
function boundFields(spec: EventSitePageSpec): Set<EventSiteBindingField> {
  const fields = new Set<EventSiteBindingField>();
  for (const block of spec.blocks) {
    // 只有内容区块带 binding；动作跳板与 AI 容器在类型上就没有这个字段。
    if ("binding" in block && block.binding !== null) fields.add(block.binding.field);
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

export interface EventSiteDependencies {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly access: EventSiteAccessPort;
  /** 未注入 = 如实降级：主流程照常，结果里 auditRecorded 为 false。 */
  readonly audit?: EventSiteAuditPort | null;
  /** 未注入 = 公开页 factsState 为 unavailable，时间显示待确认。 */
  readonly facts?: EventSiteFactPort | null;
  /** 短码来源；默认 crypto 随机。测试可注入确定序列。 */
  readonly shortCodes?: EventSiteShortCodeSource;
}

export function createEventSiteService(deps: EventSiteDependencies) {
  const { database, clock, ids, access } = deps;
  const auditPort = deps.audit ?? null;
  const factPort = deps.facts ?? null;
  const shortCodes = deps.shortCodes ?? createShortCodeSource();

  const now = (): Instant => clock.now().toISOString();

  async function transact<T>(principal: OrganizerPrincipal, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return database.transaction(async sql => {
      await principal.guard(sql);
      const result = await work(sql);
      await principal.guard(sql);
      return result;
    });
  }

  async function record(
    sql: SqlExecutor,
    principal: OrganizerPrincipal,
    input: { organizationId: EntityId; eventId: EntityId | null; action: EventSiteAuditAction; entityId: EntityId; revision: number; detail?: EventSiteAuditDetail },
  ): Promise<boolean> {
    if (auditPort === null) return false;
    const event: EventSiteAuditEvent = {
      id: ids.next(), organizationId: input.organizationId, eventId: input.eventId,
      actorUserId: principal.actor.userId, action: input.action, entityId: input.entityId,
      revision: input.revision, createdAt: now(), ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    await auditPort.record(sql, event);
    return true;
  }

  /**
   * 历史表是否可用。探测一次成功后缓存 true（迁移应用后不会回退成 false）。
   * 未应用时**如实降级**：保存照常生效，结果带 historyRecorded:false 与一句人话；
   * 但 listRevisions / restoreRevision 直接 503——不把"读不到历史"伪装成"没有历史"。
   */
  let revisionHistoryReady: boolean | null = null;

  async function canRecordHistory(sql: SqlExecutor): Promise<boolean> {
    if (revisionHistoryReady === true) return true;
    const ready = await revisionHistory.isRevisionHistoryReady(sql);
    if (ready) revisionHistoryReady = true;
    return ready;
  }

  /**
   * 把**这次写入的新草稿**连同新版本号与操作者写进历史（同一个事务）。
   * 插入后在同一事务里裁剪：本赛事只留最近 20 条（有界、返回被删版本号）。
   */
  async function recordDraftHistory(
    sql: SqlExecutor,
    principal: OrganizerPrincipal,
    input: { organizationId: EntityId; eventId: EntityId; revision: number; spec: EventSitePageSpec },
  ): Promise<boolean> {
    if (!(await canRecordHistory(sql))) return false;
    await revisionHistory.recordRevision(sql, {
      id: ids.next(), organizationId: input.organizationId, eventId: input.eventId,
      revision: input.revision, spec: input.spec, createdBy: principal.actor.userId, createdAt: now(),
    });
    return true;
  }

  function historyFlags(recorded: boolean): { historyRecorded: boolean; historyNotice: string | null } {
    return recorded
      ? { historyRecorded: true, historyNotice: null }
      : { historyRecorded: false, historyNotice: eventSiteRevisionHistoryDisabledNotice };
  }

  /** 短码分配：候选码先查重，撞了就换一个；重试有上限，不无限循环。 */
  async function allocateShortCode(sql: SqlExecutor): Promise<string> {
    for (let attempt = 0; attempt < EVENT_SITE_SHORT_CODE_MAX_ATTEMPTS; attempt += 1) {
      const candidate = shortCodes.next();
      if (!isShortCode(candidate)) {
        throw new DomainError("EVENT_SITE_SHORT_CODE_INVALID", "短码生成器返回了不合规的短码。", { status: 500 });
      }
      if (await findPageByShortCode(sql, candidate) === null) return candidate;
    }
    throw new DomainError("EVENT_SITE_SHORT_CODE_EXHAUSTED", "连续生成的短码都被占用了，请稍后重试。", { status: 503 });
  }

  /** 平台管理员的赛事范围：先验平台管理员，再读公开投影；赛事不存在就 404。 */
  async function platformScope(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: EntityId): Promise<EventSitePublicEvent> {
    await access.requirePlatformAdmin(sql, principal);
    const event = await access.publicEvent(sql, eventId);
    if (event === null) pageMissing();
    return event;
  }

  async function factValues(sql: SqlExecutor, eventId: EntityId, spec: EventSitePageSpec): Promise<{ values: EventSiteFactValues; state: "read" | "unavailable"; notice: string | null }> {
    const fields = boundFields(spec);
    const empty: EventSiteFactValues = {
      registrationCloses: null, submissionCloses: null, startsAt: null, endsAt: null,
      scheduleNodes: null, faqEntries: null, timezone: null,
    };
    if (factPort === null) return { values: empty, state: "unavailable", notice: eventSiteFactsUnavailableNotice };
    if (fields.size === 0) return { values: empty, state: "read", notice: null };
    const needsSchedule = fields.has("registrationCloses") || fields.has("submissionCloses") || fields.has("startsAt") || fields.has("endsAt");
    const needsNodes = fields.has("scheduleNodes");
    const needsFaq = fields.has("faqEntries");
    const schedule = needsSchedule ? await factPort.schedule(sql, eventId) : null;
    const nodes = needsNodes ? await factPort.scheduleNodes(sql, eventId) : null;
    const faq = needsFaq ? await factPort.faqEntries(sql, eventId) : null;
    const values: EventSiteFactValues = {
      registrationCloses: schedule === null ? null : schedule.registrationCloses,
      submissionCloses: schedule === null ? null : schedule.submissionCloses,
      startsAt: schedule === null ? null : schedule.startsAt,
      endsAt: schedule === null ? null : schedule.endsAt,
      scheduleNodes: nodes,
      faqEntries: faq,
      timezone: schedule === null ? null : schedule.timezone,
    };
    return { values, state: "read", notice: null };
  }

  /** 恢复的共用实现：主办方路径与平台路径只差"平台停用能不能解"。 */
  async function resumePage(
    sql: SqlExecutor, principal: OrganizerPrincipal, eventId: EntityId, expectedRevision: number, byPlatform: boolean,
  ): Promise<EventSiteResumeResult> {
    const row = await store.readPage(sql, eventId);
    if (row === null) pageMissing();
    if (row.status !== "suspended" || row.suspension === null) {
      throw new DomainError("EVENT_SITE_PAGE_NOT_SUSPENDED", "这一页现在是启用状态，不需要恢复。", { status: 409 });
    }
    if (!byPlatform && row.suspension.kind === "platform") {
      throw new DomainError("EVENT_SITE_PLATFORM_SUSPENSION_LOCKED", "这一页由平台停用，只有平台管理员可以恢复。", {
        status: 403, recoveryAction: "contact_platform",
      });
    }
    if (row.revision !== expectedRevision) revisionConflict(row.revision);
    const nextStatus: "published" | "draft" = row.published === null ? "draft" : "published";
    if (nextStatus === "published" && row.publishedRevision === null) {
      throw new DomainError("EVENT_SITE_PAGE_STATE_INVALID", "这一页的发布版本记录不完整，请联系平台。", { status: 503 });
    }
    const at = now();
    const revision = await store.resume(sql, eventId, {
      expectedRevision, nextStatus, publishedAt: nextStatus === "published" ? at : null, at,
    });
    if (revision === null) revisionConflict((await store.readPage(sql, eventId))?.revision ?? null);
    const recorded = await record(sql, principal, {
      organizationId: row.organizationId, eventId: row.eventId, action: "page_resumed", entityId: row.id, revision,
    });
    return { status: nextStatus, revision, publishedAt: nextStatus === "published" ? at : null, ...auditFlag(recorded) };
  }

  return {
    /* ---------------- 主办方编辑页（只读视图） ---------------- */
    async pageForOrganizer(principal: OrganizerPrincipal, eventId: string): Promise<EventSiteOrganizerPageView> {
      const event = idOf(eventId, "赛事");
      return transact(principal, async sql => {
        const scope = await access.requireEventManager(sql, principal, event);
        const row = await store.readPage(sql, event);
        const recorded = auditPort !== null;
        if (row === null) {
          const suggested = defaultPageSpec();
          return {
            exists: false, eventId: scope.eventId, organizationId: scope.organizationId,
            spec: null, published: null, revision: 0, status: "draft" as const, shortCode: null,
            publishedRevision: null, publishedAt: null, suspension: null,
            suggestedSpec: suggested, findings: reviewSpec(suggested), ...auditFlag(recorded),
          };
        }
        return {
          exists: true, eventId: row.eventId, organizationId: row.organizationId,
          spec: row.draft, published: row.published, revision: row.revision, status: row.status,
          shortCode: row.shortCode, publishedRevision: row.publishedRevision, publishedAt: row.publishedAt,
          suspension: row.suspension, suggestedSpec: null, findings: reviewSpec(row.draft), ...auditFlag(recorded),
        };
      });
    },

    /* ---------------- 草稿（CAS） ---------------- */
    async saveDraft(principal: OrganizerPrincipal, eventId: string, input: EventSiteSaveDraftInput): Promise<EventSiteSaveDraftResult> {
      const event = idOf(eventId, "赛事");
      const expected = revisionOf(input?.expectedRevision);
      // 入库前先过归一/闸门：不合规的规格根本到不了 SQL。
      const spec = normalizeSpec(input?.spec);
      return transact(principal, async sql => {
        const scope = await access.requireEventManager(sql, principal, event);
        const row = await store.readPage(sql, event);
        const at = now();
        if (row === null) {
          if (expected !== 0) revisionConflict(null);
          const shortCode = await allocateShortCode(sql);
          const pageId = ids.next();
          const created = await store.createPage(sql, event, {
            id: pageId, organizationId: scope.organizationId, shortCode, spec, now: at,
          });
          if (created === null) revisionConflict(null);
          // 建页那一次也算"保存"：历史第 1 版就是这次的草稿（同一事务，失败一起回滚）。
          const historyRecorded = await recordDraftHistory(sql, principal, {
            organizationId: scope.organizationId, eventId: event, revision: 1, spec,
          });
          const auditCreated = await record(sql, principal, {
            organizationId: scope.organizationId, eventId: event, action: "page_created", entityId: pageId, revision: 1, detail: { shortCode },
          });
          const auditSaved = await record(sql, principal, {
            organizationId: scope.organizationId, eventId: event, action: "page_draft_saved", entityId: pageId, revision: 1,
          });
          return {
            revision: 1, status: "draft" as const, shortCode, publishedRevision: null, created: true,
            findings: reviewSpec(spec), ...auditFlag(auditCreated && auditSaved), ...historyFlags(historyRecorded),
          };
        }
        if (expected !== row.revision) revisionConflict(row.revision);
        const revision = await store.saveDraft(sql, event, { spec, expectedRevision: expected, now: at });
        if (revision === null) revisionConflict((await store.readPage(sql, event))?.revision ?? null);
        // 保存即留痕：这次写入的新草稿连同新版本号进历史（同一事务；裁剪只在本赛事内）。
        const historyRecorded = await recordDraftHistory(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, revision, spec,
        });
        const recorded = await record(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, action: "page_draft_saved", entityId: row.id, revision,
        });
        return {
          revision, status: row.status, shortCode: row.shortCode, publishedRevision: row.publishedRevision, created: false,
          findings: reviewSpec(spec), ...auditFlag(recorded), ...historyFlags(historyRecorded),
        };
      });
    },

    /* ---------------- 发布（闸门 + 不可变快照） ---------------- */
    async publish(principal: OrganizerPrincipal, eventId: string, input: EventSitePublishInput): Promise<EventSitePublishResult> {
      const event = idOf(eventId, "赛事");
      const expected = revisionOf(input?.expectedRevision);
      return transact(principal, async sql => {
        await access.requireEventManager(sql, principal, event);
        const row = await store.readPage(sql, event);
        if (row === null) pageMissing();
        if (row.status === "suspended") {
          throw new DomainError("EVENT_SITE_PAGE_SUSPENDED", "这一页已停用，先恢复再发布。", { status: 409, recoveryAction: "reload" });
        }
        if (row.revision !== expected) revisionConflict(row.revision);
        // 发布前闸门：失败就是 422 + 37 个 EVENT_SITE_* 码之一，不带半截状态出门。
        const spec = parseSpec(row.draft);
        const snapshot = serializeSpec(spec);
        if (row.published !== null) {
          let current: string | null = null;
          try {
            current = serializeSpec(row.published);
          } catch {
            current = null;
          }
          if (current === snapshot) {
            throw new DomainError("EVENT_SITE_NOTHING_TO_PUBLISH", "草稿与线上完全一致，没有需要发布的改动。", { status: 409, recoveryAction: "reload" });
          }
        }
        const publishedRevision = (row.publishedRevision ?? 0) + 1;
        const at = now();
        const revision = await store.publish(sql, event, { snapshot, publishedRevision, expectedRevision: expected, at });
        if (revision === null) revisionConflict((await store.readPage(sql, event))?.revision ?? null);
        const recorded = await record(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, action: "page_published", entityId: row.id, revision,
          detail: { publishedRevision },
        });
        // 体检 findings 只附带：REVIEW_* 永不阻断发布。
        return { status: "published" as const, revision, publishedRevision, publishedAt: at, findings: reviewSpec(spec), ...auditFlag(recorded) };
      });
    },

    /* ---------------- 换短码（旧链接立即失效） ---------------- */
    async rotateShortCode(principal: OrganizerPrincipal, eventId: string, input: EventSiteRevisionInput): Promise<EventSiteRotateShortCodeResult> {
      const event = idOf(eventId, "赛事");
      const expected = revisionOf(input?.expectedRevision);
      return transact(principal, async sql => {
        await access.requireEventManager(sql, principal, event);
        const row = await store.readPage(sql, event);
        if (row === null) pageMissing();
        if (row.revision !== expected) revisionConflict(row.revision);
        const shortCode = await allocateShortCode(sql);
        const revision = await store.rotateShortCode(sql, event, { shortCode, expectedRevision: expected, now: now() });
        if (revision === null) revisionConflict((await store.readPage(sql, event))?.revision ?? null);
        const recorded = await record(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, action: "page_short_code_rotated", entityId: row.id, revision,
          detail: { shortCode },
        });
        return { shortCode, revision, status: row.status, ...auditFlag(recorded) };
      });
    },

    /* ---------------- 停用（主办方 / 平台） ---------------- */
    async suspend(principal: OrganizerPrincipal, eventId: string, input: EventSiteSuspendInput): Promise<EventSiteSuspendResult> {
      const event = idOf(eventId, "赛事");
      const expected = revisionOf(input?.expectedRevision);
      const kind = suspensionKindOf(input?.kind);
      const reason = suspensionReasonOf(input?.reason);
      return transact(principal, async sql => {
        // 授权先于取数：kind 决定走哪条权限路径，避免"先看数据再看权限"。
        const organizationId = kind === "platform"
          ? (await platformScope(sql, principal, event)).organizationId
          : (await access.requireEventManager(sql, principal, event)).organizationId;
        const row = await store.readPage(sql, event);
        if (row === null) pageMissing();
        if (row.organizationId !== organizationId) {
          throw new DomainError("EVENT_SITE_SCOPE_MISMATCH", "当前账号与该页面不属于同一机构。", { status: 403 });
        }
        if (row.status === "suspended") {
          throw new DomainError("EVENT_SITE_PAGE_ALREADY_SUSPENDED", "这一页已经停用了。", { status: 409, recoveryAction: "reload" });
        }
        if (row.revision !== expected) revisionConflict(row.revision);
        const at = now();
        const revision = await store.suspend(sql, event, {
          expectedRevision: expected, kind, by: principal.actor.userId, reason, at,
        });
        if (revision === null) revisionConflict((await store.readPage(sql, event))?.revision ?? null);
        const recorded = await record(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, action: "page_suspended", entityId: row.id, revision,
          detail: { suspensionKind: kind },
        });
        return { status: "suspended" as const, revision, suspension: { kind, reason, at, by: principal.actor.userId }, ...auditFlag(recorded) };
      });
    },

    /* ---------------- 恢复（平台停用只有平台能解） ---------------- */
    async resume(principal: OrganizerPrincipal, eventId: string, input: EventSiteRevisionInput): Promise<EventSiteResumeResult> {
      const event = idOf(eventId, "赛事");
      const expected = revisionOf(input?.expectedRevision);
      return transact(principal, async sql => {
        await access.requireEventManager(sql, principal, event);
        return resumePage(sql, principal, event, expected, false);
      });
    },

    async resumeByPlatform(principal: OrganizerPrincipal, eventId: string, input: EventSiteRevisionInput): Promise<EventSiteResumeResult> {
      const event = idOf(eventId, "赛事");
      const expected = revisionOf(input?.expectedRevision);
      return transact(principal, async sql => {
        await access.requirePlatformAdmin(sql, principal);
        return resumePage(sql, principal, event, expected, true);
      });
    },

    /* ---------------- 公开只读视图 ---------------- */
    async publicPage(shortCode: unknown): Promise<EventSitePublicPageView> {
      if (!isShortCode(shortCode)) pageMissing();
      return database.transaction(async sql => {
        const row = await findPageByShortCode(sql, shortCode);
        // 未发布、已停用、短码不存在：同一个 404，不给出"存在但停用"的信号，也不泄露草稿。
        if (row === null || row.published === null || row.status === "suspended") pageMissing();
        let spec: EventSitePageSpec;
        try {
          spec = parseSpec(row.published);
        } catch (error) {
          if (error instanceof DomainError) {
            throw new DomainError("EVENT_SITE_PUBLISHED_SPEC_INVALID", "这一页的线上快照没有通过校验，已停止展示。", { status: 503 });
          }
          throw error;
        }
        const event = await access.publicEvent(sql, row.eventId);
        if (event === null || event.organizationId !== row.organizationId) pageMissing();
        if (row.publishedRevision === null) {
          throw new DomainError("EVENT_SITE_PAGE_STATE_INVALID", "这一页的发布版本记录不完整，已停止展示。", { status: 503 });
        }
        const facts = await factValues(sql, row.eventId, spec);
        return {
          shortCode: row.shortCode, eventId: row.eventId, organizationId: row.organizationId, event,
          spec, publishedRevision: row.publishedRevision, publishedAt: row.publishedAt,
          facts: facts.values, factsState: facts.state, factsNotice: facts.notice,
          limitations: eventSitePublicPageLimitations,
        };
      });
    },

    /* ---------------- 机构模板库（套用=复制） ---------------- */
    async listTemplates(principal: OrganizerPrincipal, organizationId: string): Promise<{ organizationId: EntityId; items: readonly EventSiteTemplateView[]; auditRecorded: boolean; auditNotice: string | null }> {
      const orgId = idOf(organizationId, "机构");
      return transact(principal, async sql => {
        await access.requireOrganizationAdmin(sql, principal, orgId);
        const items = (await store.listTemplates(sql, orgId)).map(templateView);
        return { organizationId: orgId, items, ...auditFlag(auditPort !== null) };
      });
    },

    async saveTemplate(principal: OrganizerPrincipal, organizationId: string, input: EventSiteSaveTemplateInput): Promise<EventSiteSaveTemplateResult> {
      const orgId = idOf(organizationId, "机构");
      const name = templateNameOf(input?.name);
      const spec = normalizeSpec(input?.spec);
      const templateId = input?.templateId === undefined || input?.templateId === null ? null : idOf(input.templateId, "模板");
      const expected = input?.expectedRevision === undefined || input?.expectedRevision === null ? null : revisionOf(input.expectedRevision);
      return transact(principal, async sql => {
        await access.requireOrganizationAdmin(sql, principal, orgId);
        const at = now();
        if (templateId === null) {
          const created = await store.insertTemplate(sql, {
            id: ids.next(), organizationId: orgId, name, spec, createdBy: principal.actor.userId, now: at,
          });
          const recorded = await record(sql, principal, {
            organizationId: orgId, eventId: null, action: "page_template_saved", entityId: created.id, revision: 1,
            detail: { templateId: created.id },
          });
          return { template: templateView(created), ...auditFlag(recorded) };
        }
        const existing = await store.readTemplate(sql, orgId, templateId);
        if (existing === null) throw new DomainError("EVENT_SITE_TEMPLATE_NOT_FOUND", "没有找到这个模板。", { status: 404 });
        if (expected === null) {
          throw new DomainError("EVENT_SITE_INVALID_REVISION", "更新模板需要带上当前版本号。", { status: 422 });
        }
        if (existing.revision !== expected) revisionConflict(existing.revision);
        const revision = await store.updateTemplate(sql, {
          templateId, organizationId: orgId, name, spec, expectedRevision: expected, now: at,
        });
        if (revision === null) revisionConflict((await store.readTemplate(sql, orgId, templateId))?.revision ?? null);
        const updated = await store.readTemplate(sql, orgId, templateId);
        if (updated === null) throw new DomainError("EVENT_SITE_TEMPLATE_NOT_FOUND", "没有找到这个模板。", { status: 404 });
        const recorded = await record(sql, principal, {
          organizationId: orgId, eventId: null, action: "page_template_saved", entityId: templateId, revision,
          detail: { templateId },
        });
        return { template: templateView(updated), ...auditFlag(recorded) };
      });
    },

    async applyTemplate(principal: OrganizerPrincipal, eventId: string, input: EventSiteApplyTemplateInput): Promise<EventSiteApplyTemplateResult> {
      const event = idOf(eventId, "赛事");
      const templateId = idOf(input?.templateId, "模板");
      const expected = revisionOf(input?.expectedRevision);
      return transact(principal, async sql => {
        const scope = await access.requireEventManager(sql, principal, event);
        const template = await store.readTemplate(sql, scope.organizationId, templateId);
        if (template === null) throw new DomainError("EVENT_SITE_TEMPLATE_NOT_FOUND", "这个机构里没有这个模板。", { status: 404 });
        let spec: EventSitePageSpec;
        try {
          spec = normalizeSpec(template.spec);
        } catch {
          throw new DomainError("EVENT_SITE_TEMPLATE_INVALID", "这个模板的内容已损坏，不能套用。", { status: 422 });
        }
        const at = now();
        const row = await store.readPage(sql, event);
        const templateRef = { id: template.id, name: template.name, revision: template.revision };
        if (row === null) {
          if (expected !== 0) revisionConflict(null);
          const shortCode = await allocateShortCode(sql);
          const pageId = ids.next();
          const created = await store.createPage(sql, event, {
            id: pageId, organizationId: scope.organizationId, shortCode, spec, now: at,
          });
          if (created === null) revisionConflict(null);
          const historyRecorded = await recordDraftHistory(sql, principal, {
            organizationId: scope.organizationId, eventId: event, revision: 1, spec,
          });
          await record(sql, principal, {
            organizationId: scope.organizationId, eventId: event, action: "page_created", entityId: pageId, revision: 1, detail: { shortCode },
          });
          const recorded = await record(sql, principal, {
            organizationId: scope.organizationId, eventId: event, action: "page_template_applied", entityId: pageId, revision: 1,
            detail: { templateId },
          });
          return {
            revision: 1, status: "draft" as const, shortCode, created: true, template: templateRef,
            findings: reviewSpec(spec), ...auditFlag(recorded), ...historyFlags(historyRecorded),
          };
        }
        if (row.revision !== expected) revisionConflict(row.revision);
        const revision = await store.saveDraft(sql, event, { spec, expectedRevision: expected, now: at });
        if (revision === null) revisionConflict((await store.readPage(sql, event))?.revision ?? null);
        // 套用模板也是一次草稿写入，同样留痕（否则历史里会出现"内容凭空变了"的缺口）。
        const historyRecorded = await recordDraftHistory(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, revision, spec,
        });
        const recorded = await record(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, action: "page_template_applied", entityId: row.id, revision,
          detail: { templateId },
        });
        // 只复制快照：从此模板再改也不影响这一页（没有跨赛事联动）。
        return {
          revision, status: row.status, shortCode: row.shortCode, created: false, template: templateRef,
          findings: reviewSpec(spec), ...auditFlag(recorded), ...historyFlags(historyRecorded),
        };
      });
    },

    async deleteTemplate(principal: OrganizerPrincipal, organizationId: string, templateId: string): Promise<EventSiteDeleteTemplateResult> {
      const orgId = idOf(organizationId, "机构");
      const template = idOf(templateId, "模板");
      return transact(principal, async sql => {
        await access.requireOrganizationAdmin(sql, principal, orgId);
        const existing = await store.readTemplate(sql, orgId, template);
        if (existing === null) throw new DomainError("EVENT_SITE_TEMPLATE_NOT_FOUND", "没有找到这个模板。", { status: 404 });
        const deleted = await store.deleteTemplate(sql, orgId, template);
        if (!deleted) throw new DomainError("EVENT_SITE_TEMPLATE_NOT_FOUND", "没有找到这个模板。", { status: 404 });
        const recorded = await record(sql, principal, {
          organizationId: orgId, eventId: null, action: "page_template_deleted", entityId: template, revision: existing.revision,
          detail: { templateId: template },
        });
        return { deleted: true as const, templateId: template, name: existing.name, revision: existing.revision, ...auditFlag(recorded) };
      });
    },

    /* ---------------- 只读清点（机构 / 平台） ---------------- */
    async organizationPages(principal: OrganizerPrincipal, organizationId: string): Promise<EventSitePageInventory> {
      const orgId = idOf(organizationId, "机构");
      return transact(principal, async sql => {
        await access.requireOrganizationAdmin(sql, principal, orgId);
        const rows = await store.listOrganizationPages(sql, orgId, EVENT_SITE_PAGE_LIST_LIMIT + 1);
        return {
          organizationId: orgId, items: rows.slice(0, EVENT_SITE_PAGE_LIST_LIMIT).map(pageSummary),
          truncated: rows.length > EVENT_SITE_PAGE_LIST_LIMIT, ...auditFlag(auditPort !== null),
        };
      });
    },

    async platformPages(principal: OrganizerPrincipal): Promise<EventSitePageInventory> {
      return transact(principal, async sql => {
        await access.requirePlatformAdmin(sql, principal);
        const rows = await store.listAllPages(sql, EVENT_SITE_PLATFORM_PAGE_LIST_LIMIT + 1);
        return {
          organizationId: null, items: rows.slice(0, EVENT_SITE_PLATFORM_PAGE_LIST_LIMIT).map(pageSummary),
          truncated: rows.length > EVENT_SITE_PLATFORM_PAGE_LIST_LIMIT, ...auditFlag(auditPort !== null),
        };
      });
    },

    /* ---------------- P4：草稿历史列表（只给摘要，按 revision 倒序） ---------------- */
    async listRevisions(principal: OrganizerPrincipal, eventId: string): Promise<EventSiteRevisionList> {
      const event = idOf(eventId, "赛事");
      return transact(principal, async sql => {
        await access.requireEventManager(sql, principal, event);
        if (!(await canRecordHistory(sql))) revisionHistoryUnavailable();
        // 只 SELECT revision/created_by/created_at：一次不拉全量正文（历史面板用不到）。
        return revisionHistory.listRevisionSummaries(sql, event);
      });
    },

    /* ---------------- P4：回退到某一版（只写草稿，published 一个字节都不动） ---------------- */
    async restoreRevision(principal: OrganizerPrincipal, eventId: string, input: EventSiteRestoreRevisionInput): Promise<EventSiteRestoreRevisionResult> {
      const event = idOf(eventId, "赛事");
      const target = revisionOf(input?.revision, "要回退的版本号");
      const expected = revisionOf(input?.expectedRevision);
      return transact(principal, async sql => {
        const scope = await access.requireEventManager(sql, principal, event);
        if (!(await canRecordHistory(sql))) revisionHistoryUnavailable();
        const row = await store.readPage(sql, event);
        if (row === null) pageMissing();
        // 授权 → 存在 → CAS：CAS 不符时连历史都不读，先让人重新加载当前草稿。
        if (row.revision !== expected) revisionConflict(row.revision);
        const targetRecord = await revisionHistory.readRevision(sql, event, target);
        if (targetRecord === null) revisionNotFound(target);
        // 同赛事同机构再核一次：编号不可跨赛事复用，也不允许串到别机构。
        if (targetRecord.organizationId !== row.organizationId || targetRecord.organizationId !== scope.organizationId) revisionNotFound(target);
        // 写回草稿必须过既有闸门（与保存草稿同一条：normalizeSpec 归一，serializeSpec 落库）。
        let spec: EventSitePageSpec;
        try {
          spec = normalizeSpec(targetRecord.spec);
        } catch (error) {
          if (error instanceof DomainError) {
            throw new DomainError("EVENT_SITE_REVISION_SPEC_INVALID", "这一版历史按当前规则已不合法，不能直接回退：" + error.message, { status: 422, recoveryAction: "reload" });
          }
          throw error;
        }
        const at = now();
        const revision = await store.saveDraft(sql, event, { spec, expectedRevision: expected, now: at });
        if (revision === null) revisionConflict((await store.readPage(sql, event))?.revision ?? null);
        // 回退本身也留痕：新草稿版本进历史，于是"回退"也能再被回退（不复用历史号）。
        const historyRecorded = await recordDraftHistory(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, revision, spec,
        });
        const recorded = await record(sql, principal, {
          organizationId: row.organizationId, eventId: row.eventId, action: "page_revision_restored", entityId: row.id,
          revision, detail: { restoredFrom: target },
        });
        return {
          revision, restoredFrom: target, status: row.status, shortCode: row.shortCode,
          publishedRevision: row.publishedRevision, findings: reviewSpec(spec),
          ...auditFlag(recorded), ...historyFlags(historyRecorded),
        };
      });
    },
  };
}

export type EventSiteService = ReturnType<typeof createEventSiteService>;
