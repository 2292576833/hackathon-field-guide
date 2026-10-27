import { DomainError } from "../../shared/errors.ts";

export const RESOURCE_TYPES = ["inspiration", "ai_design", "ui_visual", "practical_tool"] as const;
export const RESOURCE_STAGES = ["preparation", "design", "development", "delivery", "retrospective"] as const;
export const RESOURCE_STACKS = ["stack_agnostic", "html_css", "react", "vue", "unknown"] as const;
export const RESOURCE_PREREQUISITES = ["browse", "account", "basic_code", "environment"] as const;
export const RESOURCE_USES = ["layout", "workspace", "form", "flowchart", "icons", "prototype", "collaboration", "development", "deployment", "presentation", "review"] as const;
export const RESOURCE_COST_TYPES = ["free_plan", "free_and_paid", "usage_based", "self_hosted", "unknown"] as const;
export type ResourceType = typeof RESOURCE_TYPES[number];
export type ResourceStage = typeof RESOURCE_STAGES[number];
export type ResourceStack = typeof RESOURCE_STACKS[number];
export type ResourcePrerequisite = typeof RESOURCE_PREREQUISITES[number];
export type ResourceUse = typeof RESOURCE_USES[number];
export type ResourceCostType = typeof RESOURCE_COST_TYPES[number];
export type ResourcePublicationStatus = "draft" | "in_review" | "published" | "withdrawn";
export type ResourceLinkStatus = "unknown" | "available" | "unreachable";

export interface ResourceInput {
  name: string;
  officialUrl: string;
  type: ResourceType;
  stageTags: readonly ResourceStage[];
  useTags: readonly ResourceUse[];
  stackTags: readonly ResourceStack[];
  prerequisites: readonly ResourcePrerequisite[];
  summary: string;
  suitableFor: string;
  notSuitableFor: string;
  quickStart: readonly string[];
  costType: ResourceCostType;
  costNote: string;
  costSourceUrl: string | null;
  costVerifiedAt: string | null;
  licenseStatus: "unknown" | "source_verified";
  licenseNote: string;
  licenseSourceUrl: string | null;
  licenseVerifiedAt: string | null;
  verifiedAt: string | null;
  linkStatus: ResourceLinkStatus;
  displayOrder: number;
}

export interface Resource extends ResourceInput {
  id: string;
  /** Content version used by ResourceReview and task references. */
  version: number;
  /** Aggregate optimistic lock; changes on editing and publication actions. */
  revision: number;
  publicationStatus: ResourcePublicationStatus;
  reviewId: string | null;
  publishedAt: string | null;
  withdrawnReason: string | null;
  externalLinkBlocked: boolean;
  createdAt: string;
  updatedAt: string;
  recordedBy: string;
}

/** Separate working and public snapshots preserve live content during review. */
export interface ResourceRecord {
  resource: Resource;
  publicResource: Resource | null;
}
export interface ResourceCategory {
  id: ResourceType;
  name: string;
  kind: "resource_type";
  description: string;
  displayOrder: number;
  enabled: boolean;
}
export const RESOURCE_CATEGORIES: readonly ResourceCategory[] = [
  { id: "inspiration", name: "设计灵感", kind: "resource_type", description: "观察布局与交互，素材使用权需另行确认。", displayOrder: 1, enabled: true },
  { id: "ai_design", name: "AI 设计辅助", kind: "resource_type", description: "形成视觉和界面草稿，结果仍需检查。", displayOrder: 2, enabled: true },
  { id: "ui_visual", name: "UI 与视觉资源", kind: "resource_type", description: "实现界面，先检查技术栈、依赖和许可。", displayOrder: 3, enabled: true },
  { id: "practical_tool", name: "参赛实用工具", kind: "resource_type", description: "推进协作与交付，先检查账号、成本和环境。", displayOrder: 4, enabled: true },
];

export interface ResourceBookmark {
  id: string;
  userId: string;
  resourceId: string;
  purposeNote: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface ResourceBookmarkView {
  bookmark: ResourceBookmark;
  resource: Resource;
}
export interface ResourceRef { resourceId: string; version: number }
export interface ResourceQuery {
  search?: string;
  type?: ResourceType;
  stage?: ResourceStage;
  stack?: ResourceStack;
  prerequisite?: ResourcePrerequisite;
  use?: ResourceUse;
  costType?: ResourceCostType;
  sort?: "editorial" | "name" | "verified";
  cursor?: string;
  limit?: number;
}
export interface NormalizedResourceQuery extends ResourceQuery {
  search: string;
  sort: "editorial" | "name" | "verified";
  offset: number;
  limit: number;
}

export function resourceText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new DomainError("INVALID_RESOURCE_INPUT", `${field}格式不正确。`);
  }
  return value.trim();
}
export function resourceUrl(value: unknown, field = "链接"): string {
  const raw = resourceText(value, field, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { throw new DomainError("INVALID_RESOURCE_URL", `${field}需要完整的 HTTP(S) 地址。`); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new DomainError("INVALID_RESOURCE_URL", `${field}需要不含账号密码的 HTTP(S) 地址。`);
  }
  return url.href;
}
export function resourceInstant(value: unknown, field: string, now: Date): string | null {
  if (value === null) return null;
  const parts = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  let calendarValid = false;
  if (parts) {
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    calendar.setUTCHours(hour, minute, second, 0);
    calendarValid = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
  }
  if (typeof value !== "string" || !calendarValid || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now.getTime()) {
    throw new DomainError("INVALID_RESOURCE_TIME", `${field}需要已发生且带时区的时间。`);
  }
  return new Date(value).toISOString();
}
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new DomainError("INVALID_RESOURCE_TAG", `${field}不在受控选项中。`);
  return value as T;
}
function tags<T extends string>(value: unknown, choices: readonly T[], field: string): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > choices.length) throw new DomainError("INVALID_RESOURCE_TAG", `${field}需要选择受控选项。`);
  return [...new Set(value.map(v => choice(v, choices, field)))];
}
export function normalizeResourceInput(input: ResourceInput, now: Date): ResourceInput {
  if (!input || typeof input !== "object") throw new DomainError("INVALID_RESOURCE_INPUT", "请填写资源内容。");
  const costType = choice(input.costType, RESOURCE_COST_TYPES, "费用");
  const licenseStatus = choice(input.licenseStatus, ["unknown", "source_verified"], "许可状态");
  const costSourceUrl = input.costSourceUrl === null ? null : resourceUrl(input.costSourceUrl, "费用来源");
  const licenseSourceUrl = input.licenseSourceUrl === null ? null : resourceUrl(input.licenseSourceUrl, "许可来源");
  const costVerifiedAt = resourceInstant(input.costVerifiedAt, "费用核验", now);
  const licenseVerifiedAt = resourceInstant(input.licenseVerifiedAt, "许可核验", now);
  if (costType !== "unknown" && (!costSourceUrl || !costVerifiedAt)) throw new DomainError("RESOURCE_COST_EVIDENCE_REQUIRED", "费用分类需要来源和核验时间；尚未核实请选未知。");
  if (licenseStatus !== "unknown" && (!licenseSourceUrl || !licenseVerifiedAt)) throw new DomainError("RESOURCE_LICENSE_EVIDENCE_REQUIRED", "许可说明需要来源和核验时间；尚未核实请选未知。");
  if (!Array.isArray(input.quickStart) || !input.quickStart.length || input.quickStart.length > 6) throw new DomainError("INVALID_RESOURCE_INPUT", "开始步骤需要一至六条。");
  if (!Number.isSafeInteger(input.displayOrder) || input.displayOrder < 0 || input.displayOrder > 100000) throw new DomainError("INVALID_RESOURCE_INPUT", "编辑顺序不正确。");
  const verifiedAt = resourceInstant(input.verifiedAt, "链接核验", now);
  const linkStatus = choice(input.linkStatus, ["unknown", "available", "unreachable"], "链接状态");
  if (linkStatus !== "unknown" && !verifiedAt) throw new DomainError("RESOURCE_LINK_EVIDENCE_REQUIRED", "链接状态需要核验时间。");
  return {
    name: resourceText(input.name, "名称", 160), officialUrl: resourceUrl(input.officialUrl), type: choice(input.type, RESOURCE_TYPES, "类型"),
    stageTags: tags(input.stageTags, RESOURCE_STAGES, "阶段"), useTags: tags(input.useTags, RESOURCE_USES, "用途"),
    stackTags: tags(input.stackTags, RESOURCE_STACKS, "技术栈"), prerequisites: tags(input.prerequisites, RESOURCE_PREREQUISITES, "门槛"),
    summary: resourceText(input.summary, "用途说明", 1000), suitableFor: resourceText(input.suitableFor, "适合人群", 1000),
    notSuitableFor: resourceText(input.notSuitableFor, "使用限制", 1000), quickStart: input.quickStart.map(s => resourceText(s, "开始步骤", 500)),
    costType, costNote: resourceText(input.costNote, "费用说明", 1000), costSourceUrl, costVerifiedAt,
    licenseStatus, licenseNote: resourceText(input.licenseNote, "许可说明", 1000), licenseSourceUrl, licenseVerifiedAt,
    verifiedAt, linkStatus, displayOrder: input.displayOrder,
  };
}
export function normalizeResourceQuery(query: ResourceQuery = {}): NormalizedResourceQuery {
  if (!query || typeof query !== "object") throw new DomainError("INVALID_RESOURCE_QUERY", "筛选条件不正确。");
  const search = query.search === undefined ? "" : resourceText(query.search, "搜索", 200, true);
  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DomainError("INVALID_RESOURCE_QUERY", "每页条数需要在 1 到 50 之间。");
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  if (query.cursor !== undefined && !/^\d{1,7}$/.test(query.cursor) || !Number.isSafeInteger(offset) || offset > 1000000) throw new DomainError("INVALID_RESOURCE_QUERY", "分页位置不正确。");
  return { search, limit, offset, sort: query.sort === undefined ? "editorial" : choice(query.sort, ["editorial", "name", "verified"], "排序"),
    ...(query.type === undefined ? {} : {type: choice(query.type, RESOURCE_TYPES, "类型")}),
    ...(query.stage === undefined ? {} : {stage: choice(query.stage, RESOURCE_STAGES, "阶段")}),
    ...(query.stack === undefined ? {} : {stack: choice(query.stack, RESOURCE_STACKS, "技术栈")}),
    ...(query.prerequisite === undefined ? {} : {prerequisite: choice(query.prerequisite, RESOURCE_PREREQUISITES, "门槛")}),
    ...(query.use === undefined ? {} : {use: choice(query.use, RESOURCE_USES, "用途")}),
    ...(query.costType === undefined ? {} : {costType: choice(query.costType, RESOURCE_COST_TYPES, "费用")}),
  };
}
export function isReviewedResource(resource: Resource): boolean {
  return resource.publicationStatus === "published" && !!resource.reviewId && resource.linkStatus === "available" && !resource.externalLinkBlocked;
}
export function verificationState(resource: Resource, now: Date, reviewAfterDays = 90): "unknown" | "current" | "stale" {
  if (!Number.isFinite(reviewAfterDays) || reviewAfterDays <= 0) throw new DomainError("INVALID_REVIEW_WINDOW", "复核期限需要大于零。");
  if (!resource.verifiedAt) return "unknown";
  return now.getTime() - Date.parse(resource.verifiedAt) > reviewAfterDays * 86400000 ? "stale" : "current";
}
