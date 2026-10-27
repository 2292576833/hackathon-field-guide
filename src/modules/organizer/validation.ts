import { isIP } from "node:net";
import { DomainError } from "../../shared/errors.ts";
import { DEFAULT_EVENT_COMMUNITY, EVENT_COMMUNITY_RETENTIONS, EVENT_COMMUNITY_SCALES, EVENT_MODULES, EVENT_STAFF_CAPABILITIES } from "../../shared/organizer-contracts.ts";
import type { EventCommunityConfig, EventCommunityRetention, EventCommunityScale, EventModuleFlags, EventStaffCapability } from "../../shared/organizer-contracts.ts";
import { CLAIM_VERIFICATIONS, READINESS_FIELDS } from "./model.ts";
import { DEFAULT_INVITATION_DAYS, MAX_INVITATION_DAYS, MIN_INVITATION_DAYS } from "./model.ts";
import type { ClaimCandidateInput, ClaimVerification, CreateApplicationInput, CreateStaffInvitationInput, EventConfigurationInput, EventTemplate, ReadinessField, SetEventAssistantSwitchInput } from "./model.ts";

export const invalid = (message: string): never => { throw new DomainError("ORGANIZER_INPUT_INVALID", message, { recoveryAction: "请检查填写内容后重试，当前输入已保留。" }); };
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("请提供完整的表单内容。"); return value as Record<string, unknown>; }
export function keys(value: Record<string, unknown>, allowed: readonly string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) invalid("表单包含不支持的字段，请刷新后核对输入。"); }
export function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") return invalid(`请填写${label}。`);
  const result = value.trim(); if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) return invalid(`${label}需${required ? "填写且" : ""}不超过${max}字。`); return result;
}
export function revision(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid("页面版本缺失，请重新读取后再保存。"); return value; }
/** 赛事补充资料以 0 表示"尚无记录"，因此这里接受非负整数。 */
export function nonnegativeRevision(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid("页面版本缺失，请重新读取后再保存。"); return value; }
export function integer(value: unknown, label: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid(`${label}应为${min}至${max}的整数。`); return value; }
export function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") return invalid(`请明确选择${label}。`); return value; }
export function instant(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return invalid(`${label}需要包含完整日期、时间和时区。`);
  const month = Number(value.slice(5,7)), day = Number(value.slice(8,10)), year = Number(value.slice(0,4));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate() || Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59) return invalid(`${label}日期无效。`);
  return new Date(value).toISOString();
}
export function timezone(value: unknown): string { const zone = text(value,"举办时区",80); try { new Intl.DateTimeFormat("zh-CN", { timeZone: zone }); } catch { return invalid("请选择有效的举办时区。"); } return zone; }
export function application(value: unknown, updating = false): CreateApplicationInput {
  const body = object(value); keys(body,["name","kind","description","contactName","contactEmail","evidenceText","evidenceUrls",...(updating ? ["expectedRevision"] : [])]);
  if (typeof body.kind !== "string" || !["school","company","community"].includes(body.kind)) return invalid("请选择学校、公司或社区。");
  const contactEmail = text(body.contactEmail,"联系邮箱",254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return invalid("请填写可联系的邮箱。");
  const evidenceUrls = publicEvidenceUrls(body.evidenceUrls);
  return { name: text(body.name,"机构名称",120), kind: body.kind as CreateApplicationInput["kind"], description: text(body.description,"机构简介",2000), contactName: text(body.contactName,"联系人",80), contactEmail, evidenceText: text(body.evidenceText,"活动或授权依据",4000), evidenceUrls };
}
export const CONFIGURATION_KEYS = ["title","timezone","startsAt","endsAt","registrationOpensAt","registrationClosesAt","submissionClosesAt","modules","registration","teams","community","summary","rules","location"] as const;
/** 证明用公开 HTTPS 链接：与入驻申请同一套边界，不接受凭据、IP 与本地/保留域名。 */
function publicEvidenceUrls(value: unknown, label = "证明链接"): string[] {
  const raw = value ?? []; if (!Array.isArray(raw) || raw.length > 5) return invalid(`${label}最多5条。`);
  return raw.map(item => {
    const address = text(item, label, 2048); let url: URL;
    try { url = new URL(address); } catch { return invalid(`${label}应是公开HTTPS网页。`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isIP(host.replace(/^\[|\]$/g,"")) || !host.includes(".") || host === "localhost" || /\.(localhost|local|internal|test|invalid|example)$/.test(host) || /^127\./.test(host)) return invalid(`请使用不含登录凭据的公开HTTPS${label}。`);
    return url.href;
  });
}
export function evidenceUrls(value: unknown, label = "证明链接"): string[] { return publicEvidenceUrls(value, label); }
/** 认领申请：核实方式与依据必需，目标发现由服务端复核可认领。 */
export function claim(value: unknown): ClaimCandidateInput {
  const body = object(value); keys(body,["discoveryId","verification","evidenceText","evidenceUrls"]);
  if (typeof body.verification !== "string" || !CLAIM_VERIFICATIONS.includes(body.verification as ClaimVerification)) return invalid("请选择一种归属核实方式。");
  return { discoveryId: text(body.discoveryId,"目标赛事线索",200), verification: body.verification as ClaimVerification,
    evidenceText: text(body.evidenceText,"归属依据",4000), evidenceUrls: evidenceUrls(body.evidenceUrls) };
}
/** P03：单个待补字段的取值。时间类字段要求带时区；其余为普通说明文字。 */
const INSTANT_FIELDS: readonly ReadinessField[] = ["registrationClosesAt","registrationOpensAt","startsAt","endsAt"];
export function readinessUpdate(value: unknown): { field: ReadinessField; value: string | null; expectedRevision: number } {
  const body = object(value); keys(body,["field","value","expectedRevision"]);
  const field = body.field;
  if (typeof field !== "string" || !READINESS_FIELDS.includes(field as ReadinessField)) return invalid("请选择要补充的赛事信息项。");
  const raw = body.value ?? null;
  let resolved: string | null;
  if (raw === null) resolved = null;
  else if (INSTANT_FIELDS.includes(field as ReadinessField)) resolved = instant(raw, "该时间") as string;
  else if (field === "timezone") resolved = timezone(raw);
  else resolved = text(raw, "填写内容", 2000);
  return { field: field as ReadinessField, value: resolved, expectedRevision: nonnegativeRevision(body.expectedRevision) };
}
/**
 * 赛事级「公开与社区」配置解析（宪法 XIII）。缺省即全关；不合法的组合直接拒绝，不静默放宽。
 * 与 `EventModuleFlags` 分开：它不改变报名/收件/评审规则，只决定选手侧社区能力是否出现。
 */
export function community(value: unknown): EventCommunityConfig {
  if (value === undefined || value === null) return { ...DEFAULT_EVENT_COMMUNITY };
  const body = object(value); keys(body, ["workShowcase","peerFeedback","peerReview","peerReviewScale","peerReviewDimensions","peerReviewPassRate","commentMaxLength","participantDirectory","connections","directMessages","directMessageRetention","directMessagePurgeDays"]);
  const scale = body.peerReviewScale ?? DEFAULT_EVENT_COMMUNITY.peerReviewScale;
  if (typeof scale !== "string" || !EVENT_COMMUNITY_SCALES.includes(scale as EventCommunityScale)) return invalid("请选择互评量纲。");
  const rawDimensions = body.peerReviewDimensions ?? [];
  if (!Array.isArray(rawDimensions) || rawDimensions.length > 12) return invalid("互评维度最多 12 项。");
  const dimensions = rawDimensions.map(item => { const dimension = object(item); keys(dimension, ["id","label"]); return { id: text(dimension.id, "互评维度标识", 60), label: text(dimension.label, "互评维度名称", 80) }; });
  const retention = body.directMessageRetention ?? DEFAULT_EVENT_COMMUNITY.directMessageRetention;
  if (typeof retention !== "string" || !EVENT_COMMUNITY_RETENTIONS.includes(retention as EventCommunityRetention)) return invalid("请选择私信保留口径。");
  const rawRate = body.peerReviewPassRate === undefined ? DEFAULT_EVENT_COMMUNITY.peerReviewPassRate : body.peerReviewPassRate;
  if (typeof rawRate !== "number" || !Number.isFinite(rawRate) || rawRate < 0.1 || rawRate > 1) return invalid("互评参与率门槛应在 0.1 到 1 之间。");
  const maxLength = body.commentMaxLength === undefined ? DEFAULT_EVENT_COMMUNITY.commentMaxLength : integer(body.commentMaxLength, "留言长度上限", 50, 2000);
  const rawPurge = body.directMessagePurgeDays ?? null;
  const purgeDays = rawPurge === null ? null : integer(rawPurge, "私信清理天数", 1, 3650);
  const result: EventCommunityConfig = {
    workShowcase: boolean(body.workShowcase ?? false, "作品展示"), peerFeedback: boolean(body.peerFeedback ?? false, "文字留言"), peerReview: boolean(body.peerReview ?? false, "数值互评"),
    peerReviewScale: scale as EventCommunityScale, peerReviewDimensions: dimensions, peerReviewPassRate: rawRate, commentMaxLength: maxLength,
    participantDirectory: boolean(body.participantDirectory ?? false, "本场名录"), connections: boolean(body.connections ?? false, "选手连接"), directMessages: boolean(body.directMessages ?? false, "站内私信"),
    directMessageRetention: retention as EventCommunityRetention, directMessagePurgeDays: purgeDays,
  };
  if (result.peerReview && result.peerReviewDimensions.length === 0) return invalid("启用数值互评前请先填写至少一个互评维度。");
  if (result.directMessages && !result.connections) return invalid("站内私信需要先启用选手连接。");
  if (result.directMessageRetention === "purge" && result.directMessagePurgeDays === null) return invalid("选择到期清理时请填写清理天数。");
  if ((result.peerFeedback || result.peerReview) && !result.workShowcase) return invalid("文字留言和数值互评需要先开启作品展示，否则没有可点评的作品。");
  return result;
}
export function configuration(value: Record<string, unknown>, template?: EventTemplate): EventConfigurationInput {
  const moduleInput = object(value.modules ?? template?.modules); keys(moduleInput,EVENT_MODULES);
  const modules = Object.fromEntries(EVENT_MODULES.map(key => [key,boolean(moduleInput[key],`${key}模块`)])) as unknown as EventModuleFlags;
  if (modules.teams && !modules.registration) return invalid("组队需要先启用报名。");
  if (modules.judging && (!modules.registration || !modules.teams)) return invalid("评审需要启用报名和队伍，以便正式收件。");
  if (!modules.registration && (modules.icebreaking || modules.accommodation || modules.mealVouchers)) return invalid("赛前交流、住宿和餐券需要先启用报名，以核对参赛资格。");
  const reg = object(value.registration ?? template?.registration); keys(reg,["reviewRequired","capacity"]);
  const teams = object(value.teams ?? template?.teams); keys(teams,["mode","minSize","maxSize","locksAt"]);
  if (typeof teams.mode !== "string" || !["free","assigned","mixed"].includes(teams.mode)) return invalid("请选择自愿组队、人工分配或混合组队。");
  const result: EventConfigurationInput = {
    title: text(value.title,"比赛名称",160), timezone: timezone(value.timezone ?? template?.timezone),
    startsAt: instant(value.startsAt,"开赛时间")!, endsAt: instant(value.endsAt,"结束时间")!,
    registrationOpensAt: instant(value.registrationOpensAt ?? null,"报名开始",true), registrationClosesAt: instant(value.registrationClosesAt ?? null,"报名截止",true),
    submissionClosesAt: instant(value.submissionClosesAt ?? null,"作品截止",true), modules,
    registration: { reviewRequired: boolean(reg.reviewRequired,"报名审核"), capacity: reg.capacity === null ? null : integer(reg.capacity,"报名人数上限",1,100000) },
    teams: { mode: teams.mode as EventConfigurationInput["teams"]["mode"], minSize: integer(teams.minSize,"队伍最少人数",1,100), maxSize: integer(teams.maxSize,"队伍最多人数",1,100), locksAt: instant(teams.locksAt ?? null,"队伍锁定时间",true) },
    community: community(value.community),
    summary: text(value.summary ?? "","比赛简介",4000,false), rules: text(value.rules ?? "","公开规则",30000,false), location: text(value.location ?? "","地点 / 在线参与说明",2000,false),
  };
  if (Date.parse(result.endsAt) <= Date.parse(result.startsAt)) return invalid("结束时间应晚于开赛时间。");
  if (result.teams.maxSize < result.teams.minSize) return invalid("队伍最多人数不能少于最少人数。");
  if (result.registrationOpensAt && result.registrationClosesAt && Date.parse(result.registrationOpensAt) >= Date.parse(result.registrationClosesAt)) return invalid("报名截止应晚于报名开始。");
  for (const [name,date] of [["报名截止",result.registrationClosesAt],["队伍锁定",result.teams.locksAt],["作品截止",result.submissionClosesAt]] as const) if (date && Date.parse(date) > Date.parse(result.endsAt)) return invalid(`${name}不能晚于比赛结束。`);
  if (result.submissionClosesAt && Date.parse(result.submissionClosesAt) < Date.parse(result.startsAt)) return invalid("作品截止不能早于开赛时间。");
  if (result.registrationOpensAt && Date.parse(result.registrationOpensAt) > Date.parse(result.endsAt)) return invalid("报名开始不能晚于比赛结束。");
  return result;
}
export function capabilities(value: unknown): readonly EventStaffCapability[] { if (!Array.isArray(value) || value.length > EVENT_STAFF_CAPABILITIES.length || value.some(item => !EVENT_STAFF_CAPABILITIES.includes(item as EventStaffCapability)) || new Set(value).size !== value.length) return invalid("请选择已有的工作人员权限，不支持自定义权限。"); return value as EventStaffCapability[]; }
/**
 * P3 受限邀请的生成输入（宪法 XIII）。能力仍取自既有 `EVENT_STAFF_CAPABILITIES`，
 * 不支持自定义权限；`organization_admin` 与既有 grant 规则一样强制机构范围并覆盖为全部能力。
 * 有效期默认 7 天、上限 30 天；绑定邮箱可选，填了就必须是有效邮箱。
 */
export function staffInvitation(value: unknown): CreateStaffInvitationInput {
  const body = object(value); keys(body,["role","capabilities","eventId","expiresInDays","boundEmail","note"]);
  if (typeof body.role !== "string" || !["organization_admin","staff"].includes(body.role)) return invalid("请选择机构管理员或赛事工作人员。");
  const role = body.role as CreateStaffInvitationInput["role"];
  const eventId = body.eventId === null || body.eventId === undefined ? null : text(body.eventId,"比赛标识",200);
  if (role === "organization_admin" && eventId !== null) return invalid("机构管理员邀请必须使用机构范围。");
  const allowed = role === "organization_admin" ? [...EVENT_STAFF_CAPABILITIES] : capabilities(body.capabilities);
  if (role === "staff" && !allowed.length) return invalid("请至少选择一项工作权限。");
  const expiresInDays = body.expiresInDays === undefined ? DEFAULT_INVITATION_DAYS : integer(body.expiresInDays,"有效期天数",MIN_INVITATION_DAYS,MAX_INVITATION_DAYS);
  const rawEmail = body.boundEmail ?? null; let boundEmail: string | null = null;
  if (rawEmail !== null) {
    boundEmail = text(rawEmail,"绑定邮箱",254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(boundEmail)) return invalid("请填写有效的绑定邮箱。");
  }
  return { role, capabilities: allowed, eventId, expiresInDays, boundEmail, note: text(body.note ?? "","邀请备注",500,false) };
}
/** P3 撤销邀请：只接受邀请自身的 expectedRevision，不推进机构 revision（不涉及任何权限事实）。 */
export function revokeInvitation(value: unknown): number {
  const body = object(value); keys(body,["expectedRevision"]); return revision(body.expectedRevision);
}
/**
 * P4 模块助手开关写入输入（规划34 §2.1 / §5.1）。只解析表单形状；`assistantKey` 是否属于本场
 * 支持的助手由服务按**根传入的 key 列表**判断（本模块不持有第二份注册表）。
 * `expectedRevision` 首次设置传 0，因此用 nonnegativeRevision。
 */
export function assistantSwitch(value: unknown): SetEventAssistantSwitchInput {
  const body = object(value); keys(body,["assistantKey","enabled","expectedRevision"]);
  return { assistantKey: text(body.assistantKey,"模块助手",120), enabled: boolean(body.enabled,"助手开关"), expectedRevision: nonnegativeRevision(body.expectedRevision) };
}
