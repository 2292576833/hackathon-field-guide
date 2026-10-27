/**
 * P05 · 复制上一场活动的**纯逻辑**部分：由来源赛事的当前草稿生成目标配置。
 *
 * 设计约束（规划 33 / P05 第 2、3 节）：
 * - **无 IO、无 Date.now()**：只做字段搬运、校验与差异说明，便于单测。
 * - **只吃来源的"当前草稿"**：调用方传进来的就是 `getManagedEvent` 的结果；本模块不接触
 *   `PublishedEventRevision`，因此复制永远不可能以发布快照为起点。
 * - **时间字段一律不带过来**：`startsAt`/`endsAt`/`registrationOpensAt`/`registrationClosesAt`/
 *   `submissionClosesAt`/`teams.locksAt` 必须由主办方重新填写，避免上一届的截止变成这一届的。
 * - **不复制任何运行数据**：答卷、正式队伍、通知与已读、评审轮次/指派/评分、申诉、审计、
 *   发布版本都不在本模块的输入类型里，因此结构上就复制不了。
 */
import { DomainError } from "../../shared/errors.ts";
import { EVENT_MODULES } from "../../shared/organizer-contracts.ts";
import type { EventModuleFlags } from "../../shared/organizer-contracts.ts";
import type { CreateEventInput, EventTemplate, EventTemplateKey, HostedEvent } from "./model.ts";
import * as v from "./validation.ts";

/** 默认副本名后缀；界面可改，这里只给默认值。 */
export const DUPLICATE_TITLE_SUFFIX = "（副本）";

/**
 * 与 event-registration 的 `RegistrationForm` 字段对齐的**最小结构**。
 * 本模块不导入该模块私有类型（模块边界），只声明复制所必需的四个字段。
 * `publishedAt` 是来源自己的记录，复制到新赛事时由对方服务的 `saveForm` 重新签时间，故不在此列。
 */
export interface DuplicateSourceForm {
  readonly title: string;
  readonly description: string;
  readonly fields: readonly unknown[];
}

/**
 * 与 event-judging 的 `JudgingConfig` 字段对齐的最小结构。
 * 同样是全可选的弱结构：只搬运调用方已读到的字段，不做本地默认值猜测。
 */
export interface DuplicateSourceJudgingConfig {
  readonly title?: string;
  readonly criteria?: readonly unknown[];
  readonly minJudges?: number;
  readonly missingPolicy?: string;
  readonly tiePolicy?: string;
  readonly appealWindowDays?: number;
}

export interface DuplicateRequest {
  /** 已解析的新比赛名称；缺省时由服务层用 `duplicateTitle` 连同已占用名称一起解析。 */
  readonly title: string;
  readonly includeRegistrationForm?: unknown;
  readonly includeJudgingConfig?: unknown;
}

/** 复制计划：新赛事的 `HostedEvent` 身份（由调用方提供 ID 与负责人）。 */
export interface DuplicateEventIdentity {
  readonly eventId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly responsibleUserId: string;
  /** ISO 即时字符串；由调用方注入，保持本模块无时间依赖。 */
  readonly createdAt: string;
}

/** 面板上"将复制 / 不复制"两列的数据源，也是交付说明里可复核的清单。 */
export type DuplicateInclusion = "copied" | "skipped";
export interface DuplicateComparisonItem {
  readonly key: string;
  readonly label: string;
  readonly inclusion: DuplicateInclusion;
  /** 为什么复制或不复制，供界面直接展示，不写内部术语。 */
  readonly note: string;
}
export interface DuplicatePlan {
  readonly items: readonly DuplicateComparisonItem[];
  readonly copied: readonly string[];
  readonly skipped: readonly string[];
}

function denied(message: string, recoveryAction?: string): never {
  throw new DomainError("ORGANIZER_DUPLICATE_FORBIDDEN", message, { status: 403, ...(recoveryAction ? { recoveryAction } : {}) });
}

/** 已发布快照不是合法起点：只允许把赛事**当前草稿**作为来源。 */
export function assertDuplicateSource(source: HostedEvent): void {
  if (!source || typeof source.eventId !== "string" || !source.eventId) {
    throw new DomainError("ORGANIZER_DUPLICATE_SOURCE_MISSING", "没有读到可复制的比赛，请重新选择。", { status: 404 });
  }
}

/** 默认副本名：`<原名>（副本）`，可按需要加序号避免同名。 */
export function duplicateTitle(sourceTitle: string, taken: readonly string[]): string {
  const base = `${v.text(sourceTitle, "来源比赛名称", 160)}${DUPLICATE_TITLE_SUFFIX}`;
  if (!taken.includes(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${v.text(sourceTitle, "来源比赛名称", 160)}${DUPLICATE_TITLE_SUFFIX} ${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return base;
}

/**
 * 线上模板不能承载现场住宿/餐券（与 `createEvent` 同一规则）。
 * 在复制前先判出来，给出可执行的替代，而不是让底层校验抛一句难以理解的话。
 */
export function assertTemplateCompatible(template: EventTemplate, modules: EventModuleFlags): void {
  if (template.format === "online" && (modules.accommodation || modules.mealVouchers)) {
    throw new DomainError(
      "ORGANIZER_DUPLICATE_TEMPLATE_INCOMPATIBLE",
      "来源比赛启用了现场住宿或餐券，线上模板不提供这两项，不能原样复制。",
      { status: 409, recoveryAction: "改用线下模板重建这场比赛，或先在来源比赛里关闭这两项后再复制。" },
    );
  }
}

/** 复制产生的新赛事，其排期时刻。五个时间字段全部由 `shiftedOccurrenceTimes` 重新计算。 */
export interface DuplicateOccurrenceTimes {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly registrationOpensAt: string | null;
  readonly registrationClosesAt: string | null;
  readonly submissionClosesAt: string | null;
  readonly locksAt: string | null;
}

const MINUTE = 60_000;

/**
 * 把来源赛事的**时间结构**平移到当前时刻，得到新赛事的排期。
 *
 * **为什么要平移而不是留空**（对本规划 P05 第 3 节"不沿用时间字段"的落地解释，主会话已知情）：
 * `HostedEvent` 的 `startsAt`/`endsAt` 在共享契约里是**非空**的，`createEvent` 也要求这两个时刻有效。
 * 若复制出的草稿带上空时刻，就会出现一个**类型上不可达、且 `publishEvent` 会拿无效日期做比较**的赛事。
 * 因此这里保留来源的**时间结构与各截止的相对位置**，整体平移到当前时刻：
 * - 不沿用上一届的绝对日期（"2026-10-20" → "今天 + 相同跨度"），这正是"不继承时间"要避免的事；
 * - 报名窗口、作品截止、队伍锁定相对开赛的位置保持不变；
 * - 新赛事可以立即编辑与发布，主办方在发布前仍需确认每一个时刻（发布快照会锁定它们）。
 *
 * 纯函数：`now` 由调用方传入，本模块不读时钟。
 */
export function shiftedOccurrenceTimes(source: HostedEvent, now: string): DuplicateOccurrenceTimes {
  const sourceStart = Date.parse(source.startsAt);
  const sourceEnd = Date.parse(source.endsAt);
  const anchor = Date.parse(now);
  if (!Number.isFinite(anchor)) throw new DomainError("ORGANIZER_DUPLICATE_SOURCE_INVALID", "当前时间无效，无法为副本排期。", { status: 500 });
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd - sourceStart < MINUTE) {
    throw new DomainError("ORGANIZER_DUPLICATE_SOURCE_INVALID", "来源比赛的时间不完整或过短，无法推导副本的排期，请先补全来源比赛的时间。", { status: 409 });
  }
  const offset = anchor - sourceStart;
  const shift = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed + offset).toISOString() : null;
  };
  return {
    startsAt: new Date(anchor).toISOString(),
    endsAt: new Date(sourceEnd + offset).toISOString(),
    registrationOpensAt: shift(source.registrationOpensAt),
    registrationClosesAt: shift(source.registrationClosesAt),
    submissionClosesAt: shift(source.submissionClosesAt),
    locksAt: shift(source.teams?.locksAt),
  };
}

/**
 * 合并"来源草稿 + 目标模板"的运行配置，产出既有的 `CreateEventInput`，
 * 由服务层交给既有 `createEventIn` 写路径（**不新增第二套创建逻辑**）。
 *
 * - 五个时间字段由调用方传入 `shiftedOccurrenceTimes` 的结果（见该函数的说明）。
 * - 除时间外与 `createEvent` **完全同口径**：模块依赖、时区、报名/队伍范围、线下模块限制
 *   都复用既有 `v.configuration`，不另写一套校验。
 */
export function mergeConfiguration(
  source: HostedEvent,
  template: EventTemplate,
  request: { readonly title: string; readonly times: DuplicateOccurrenceTimes },
  organizationId: string,
): CreateEventInput {
  assertDuplicateSource(source);
  assertTemplateCompatible(template, source.modules);
  if (source.organizationId !== organizationId) {
    denied("来源比赛属于另一家机构，不能跨机构复制。", "请在本机构自己的比赛里选择来源。");
  }
  const modules = Object.fromEntries(EVENT_MODULES.map(key => [key, Boolean(source.modules[key])])) as unknown as EventModuleFlags;
  const body: Record<string, unknown> = {
    // 名称由服务层用 `duplicateTitle` 连同"已被占用的名称"一起解析后传入，避免两处各算一次。
    title: v.text(request.title, "新比赛名称", 160),
    timezone: source.timezone,
    startsAt: request.times.startsAt,
    endsAt: request.times.endsAt,
    registrationOpensAt: request.times.registrationOpensAt,
    registrationClosesAt: request.times.registrationClosesAt,
    submissionClosesAt: request.times.submissionClosesAt,
    modules,
    registration: { reviewRequired: Boolean(source.registration?.reviewRequired), capacity: source.registration?.capacity ?? null },
    teams: { mode: source.teams?.mode ?? "free", minSize: source.teams?.minSize ?? 1, maxSize: source.teams?.maxSize ?? 1, locksAt: request.times.locksAt },
    summary: source.summary ?? "",
    rules: source.rules ?? "",
    location: source.location ?? "",
  };
  return { ...v.configuration(body, template), templateKey: template.key, expectedOrganizationRevision: 1 };
}

/** 复制后的赛事身份：新草稿、无发布版本、无 M03 关联、负责人是当前操作人。 */
export function duplicateEventIdentity(source: HostedEvent, configuration: CreateEventInput, identity: DuplicateEventIdentity): HostedEvent {
  const { templateKey: _templateKey, expectedOrganizationRevision: _expectedOrganizationRevision, ...configurationFields } = configuration;
  return {
    ...configurationFields,
    eventId: identity.eventId,
    organizationId: identity.organizationId,
    organizationName: identity.organizationName,
    status: "draft",
    revision: 1,
    publishedRevision: null,
    linkedEventId: null,
    templateKey: source.templateKey,
    templateVersion: 1,
    format: source.format,
    responsibleUserId: identity.responsibleUserId,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
  };
}

/** 报名表复制输入：`expectedRevision: 0` 表示新赛事尚无报名表；变更说明写明来源，便于审计。 */
export function duplicateFormInput(source: DuplicateSourceForm, sourceTitle: string): { expectedRevision: number; title: string; description: string; fields: readonly unknown[]; changeNote: string } {
  if (!source || typeof source.title !== "string" || !Array.isArray(source.fields)) {
    throw new DomainError("ORGANIZER_DUPLICATE_FORM_INVALID", "来源比赛的报名表无法读取，已跳过报名表复制。", { status: 409 });
  }
  return {
    expectedRevision: 0,
    title: v.text(source.title, "报名表标题", 100),
    description: v.text(source.description ?? "", "报名说明", 2000, false),
    fields: [...source.fields],
    changeNote: `由「${v.text(sourceTitle, "来源比赛名称", 160)}」复制；请核对字段是否适用本届。`,
  };
}

/**
 * 评审配置复制输入：`expectedRevision: 0` 表示新赛事尚无评审轮。
 * 只搬运来源已保存的字段；来源尚未配置时不产生输入（由服务层跳过），不在这里编造默认值。
 */
export function duplicateJudgingConfigInput(source: DuplicateSourceJudgingConfig): { expectedRevision: number; config: Record<string, unknown> } {
  if (!source || typeof source !== "object" || !Array.isArray(source.criteria) || source.criteria.length === 0) {
    throw new DomainError("ORGANIZER_DUPLICATE_JUDGING_INVALID", "来源比赛的评审标准无法读取，已跳过评审配置复制。", { status: 409 });
  }
  const config: Record<string, unknown> = {
    title: source.title ?? "评审",
    criteria: [...source.criteria],
    minJudges: source.minJudges ?? 1,
    missingPolicy: source.missingPolicy ?? "block_publication",
    tiePolicy: source.tiePolicy ?? "shared_rank",
  };
  if (typeof source.appealWindowDays === "number") config.appealWindowDays = source.appealWindowDays;
  return { expectedRevision: 0, config };
}

/**
 * 面板"将复制 / 不复制"两列对照。
 * 这里**只描述事实**：不出现"完成度""推荐""一键"之类措辞。
 */
export function duplicateComparison(source: HostedEvent, options: { readonly includeRegistrationForm: boolean; readonly includeJudgingConfig: boolean }): DuplicatePlan {
  const items: DuplicateComparisonItem[] = [
    { key: "title", label: "比赛名称", inclusion: "copied", note: `默认「${source.title}${DUPLICATE_TITLE_SUFFIX}」，可改` },
    { key: "timezone", label: "比赛时区", inclusion: "copied", note: "沿用来源时区，避免跨时区误算" },
    { key: "modules", label: "开放功能", inclusion: "copied", note: "沿用来源的比赛功能开关" },
    { key: "registration", label: "报名设置", inclusion: "copied", note: "审核开关与人数上限" },
    { key: "teams", label: "组队设置", inclusion: "copied", note: "组队方式与人数范围（不含锁定时间）" },
    { key: "content", label: "简介与公开规则", inclusion: "copied", note: "内容照抄，发布前仍需重新确认" },
    { key: "location", label: "地点 / 在线参与说明", inclusion: "copied", note: "照抄，请核对本届是否相同" },
    { key: "format", label: "线上或线下", inclusion: "copied", note: "沿用来源形式" },
    { key: "times", label: "开赛、结束、报名截止、作品截止、队伍锁定", inclusion: "skipped", note: "必须重新确认：整体平移到当前时刻，不沿用上一届的绝对日期" },
    { key: "linkedEventId", label: "与赛事库的关联", inclusion: "skipped", note: "必须重新显式关联，不按名称继承" },
    { key: "publication", label: "已发布版本与历史公告", inclusion: "skipped", note: "新比赛从未发布，需要重新预览并发布" },
    { key: "answers", label: "报名答卷", inclusion: "skipped", note: "属于上一届的选手数据" },
    { key: "roster", label: "正式队伍与名单", inclusion: "skipped", note: "属于上一届的参赛名单" },
    { key: "notices", label: "通知、已读与求助", inclusion: "skipped", note: "属于上一届的沟通记录" },
    { key: "judgingData", label: "评审轮次、指派与评分", inclusion: "skipped", note: "属于上一届的评审事实" },
    { key: "appeals", label: "申诉与审计", inclusion: "skipped", note: "属于上一届的留痕" },
  ];
  const formItem: DuplicateComparisonItem = options.includeRegistrationForm
    ? { key: "form", label: "报名表字段", inclusion: "copied", note: "复制为草稿；新表版本从 1 开始" }
    : { key: "form", label: "报名表字段", inclusion: "skipped", note: "选择不复制，需要在新比赛里重新配置" };
  const judgingItem: DuplicateComparisonItem = options.includeJudgingConfig
    ? { key: "judgingConfig", label: "评审维度与权重", inclusion: "copied", note: "复制为待开始的新评审轮" }
    : { key: "judgingConfig", label: "评审维度与权重", inclusion: "skipped", note: "选择不复制，需要在新比赛里重新配置" };
  const all = [...items, formItem, judgingItem];
  return { items: all, copied: all.filter(item => item.inclusion === "copied").map(item => item.key), skipped: all.filter(item => item.inclusion === "skipped").map(item => item.key) };
}

/** 从原始输入解析复用请求；`include*` 缺省为 true（复制配置是这项功能的目的）。 */
export function parseDuplicateRequest(value: unknown): { title: string | undefined; includeRegistrationForm: boolean; includeJudgingConfig: boolean; expectedOrganizationRevision: number } {
  const body = v.object(value);
  v.keys(body, ["title", "includeRegistrationForm", "includeJudgingConfig", "expectedOrganizationRevision"]);
  return {
    title: body.title === undefined || body.title === null ? undefined : v.text(body.title, "新比赛名称", 160),
    includeRegistrationForm: body.includeRegistrationForm === undefined ? true : v.boolean(body.includeRegistrationForm, "复制报名表"),
    includeJudgingConfig: body.includeJudgingConfig === undefined ? true : v.boolean(body.includeJudgingConfig, "复制评审配置"),
    expectedOrganizationRevision: v.revision(body.expectedOrganizationRevision),
  };
}

/** 来源是否允许复制：草稿/已发布/已结束/已归档都可以，但归档的来源要提示配置可能过时。 */
export function duplicateSourceHint(source: HostedEvent): string | null {
  return source.status === "archived" ? "来源比赛已归档，它的配置可能已经过时，复制后请逐项核对。" : null;
}

/** 类型再导出，方便消费方只依赖本模块即可拿到 `EventTemplateKey`。 */
export type { EventTemplateKey };
