import { DomainError } from "../../shared/errors.ts";
import { answerKeys, reusableFields } from "./domain.ts";
import type { Answers, EvidenceKind, EvidenceRef, ExperienceContent, GeneratedDraft, ReusableField, RetrospectiveContent, Scope, ToolExperience } from "./domain.ts";
import { parseSkillUsage } from "./skill-usage.ts";

export function invalid(message: string): never { throw new DomainError("INVALID_INPUT", message); }
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请提供有效的结构化内容。");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid("内容包含不支持的字段。");
  return record;
}
export function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`${label}不能为空，且需在${max}字以内。`);
  return value.trim();
}
export function identifier(value: unknown): string { return text(value, "标识", 200); }
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("请提供有效的预期版本。");
  return value as number;
}
export function scope(value: unknown): Scope {
  if (value !== "personal" && value !== "project") invalid("可见范围只能是本人或本项目。");
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`列表最多支持${max}项。`);
  return value;
}
export function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid("时间需要有效的日期与时区。");
  const iso = new Date(value).toISOString();
  // Reject normalized invalid dates such as February 30.
  const local = new Date(value.slice(0, 19) + "Z").toISOString().slice(0, 19);
  if (local !== value.slice(0, 19)) invalid("日期无效。");
  return iso;
}
export function url(value: unknown): string {
  const raw = text(value, "来源链接", 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return invalid("来源链接无效。"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) invalid("来源链接只能使用不含凭据的 HTTP 或 HTTPS 地址。");
  const credentialKey = /^(?:access[_-]?token|token|api[_-]?key|password|secret|authorization)$/i;
  let fragment = parsed.hash.slice(1);
  try { fragment = decodeURIComponent(fragment); } catch { /* The raw fragment still receives the credential check. */ }
  const fragmentParams = new URLSearchParams(fragment.replace(/^.*?\?/, ""));
  if ([...parsed.searchParams.keys(), ...fragmentParams.keys()].some(key => credentialKey.test(key)) || /(?:^|[&?;/])(?:access[_-]?token|token|api[_-]?key|password|secret|authorization)=/i.test(fragment)) invalid("来源链接不能包含账号令牌或密钥参数。");
  return parsed.href;
}
export function answers(value: unknown): Answers {
  const record = object(value, answerKeys);
  return Object.fromEntries(answerKeys.map(key => [key, text(record[key], "复盘回答")])) as Answers;
}
const evidenceKinds: EvidenceKind[] = ["rule", "plan", "task", "assignment", "git_save", "delivery_verification", "submission", "project_resource"];
export function evidenceKey(ref: EvidenceRef): string { return JSON.stringify([ref.kind, ref.id, ref.revision]); }
export function evidenceRefs(value: unknown): EvidenceRef[] {
  const refs = array(value, 50).map(item => {
    const record = object(item, ["kind", "id", "revision"]);
    if (!evidenceKinds.includes(record.kind as EvidenceKind)) invalid("证据类型不支持；不能引用原始测评或私人笔记。");
    return { kind: record.kind as EvidenceKind, id: identifier(record.id), revision: revision(record.revision) };
  });
  if (new Set(refs.map(evidenceKey)).size !== refs.length) invalid("证据引用不能重复。");
  return refs;
}
export function tools(value: unknown): ToolExperience[] {
  return array(value, 20).map(item => {
    const record = object(item, ["resourceId", "originalUrl", "usedFor", "limitations", "costAtUse", "verifiedAt", "source"]);
    if (record.source !== "member_record" || (!record.resourceId && !record.originalUrl)) invalid("工具经历需要审核资源标识或成员提供的原始链接，来源为成员记录。");
    return {
      ...(record.resourceId !== undefined ? { resourceId: identifier(record.resourceId) } : {}),
      ...(record.originalUrl !== undefined ? { originalUrl: url(record.originalUrl) } : {}),
      usedFor: text(record.usedFor, "工具用途", 1500), limitations: text(record.limitations, "工具限制", 1500), costAtUse: text(record.costAtUse, "当时费用", 500),
      ...(record.verifiedAt !== undefined ? { verifiedAt: instant(record.verifiedAt) } : {}),
      source: "member_record" as const,
    };
  });
}
export function retrospectiveContent(value: unknown): RetrospectiveContent {
  const record = object(value, ["answers", "evidenceRefs", "tools", "skillUsage"]);
  const skillUsage = parseSkillUsage(record.skillUsage);
  return { answers: answers(record.answers), evidenceRefs: evidenceRefs(record.evidenceRefs), tools: tools(record.tools), ...(skillUsage === undefined ? {} : { skillUsage }) };
}
export function experienceContent(value: unknown): ExperienceContent {
  const record = object(value, ["title", "scenario", "advice", "conditions", "limitations", "evidenceRefs", "tools", "skillUsage"]);
  const advice = array(record.advice, 20).map(item => text(item, "建议步骤", 1500));
  if (!advice.length) invalid("经验卡至少需要一条建议步骤。");
  const skillUsage = parseSkillUsage(record.skillUsage);
  return { title: text(record.title, "标题", 200), scenario: text(record.scenario, "问题场景", 2000), advice, conditions: text(record.conditions, "适用条件", 2000), limitations: text(record.limitations, "不适用或未知条件", 2000), evidenceRefs: evidenceRefs(record.evidenceRefs), tools: tools(record.tools), ...(skillUsage === undefined ? {} : { skillUsage }) };
}
export function fields(value: unknown): ReusableField[] {
  const selected = array(value, reusableFields.length);
  if (!selected.length || selected.some(item => !reusableFields.includes(item as ReusableField)) || new Set(selected).size !== selected.length) invalid("请选择不同的可复用字段；日期、授权、测评和交付状态不能复制。");
  return selected as ReusableField[];
}
export function generatedDraft(value: unknown, allowedRefs: EvidenceRef[], allowedResources: string[]): GeneratedDraft {
  const record = object(value, ["answers", "evidenceRefs", "resourceIds", "modelVersion"]);
  const refs = evidenceRefs(record.evidenceRefs);
  const allowed = new Set(allowedRefs.map(evidenceKey));
  if (refs.some(ref => !allowed.has(evidenceKey(ref)))) invalid("生成草稿引用了未授权或不存在的证据。");
  const resourceIds = array(record.resourceIds, 20).map(identifier);
  if (new Set(resourceIds).size !== resourceIds.length || resourceIds.some(id => !allowedResources.includes(id))) invalid("生成草稿只能引用输入中已审核的资源。");
  const resultAnswers = answers(record.answers);
  // Links belong to approved Resource IDs or the manually recorded tool fields, not model prose.
  if (Object.values(resultAnswers).some(answer => /(?:https?:\/\/|www\.|\]\s*\(|<\s*a\b)/i.test(answer))) invalid("生成草稿不能加入网址，请通过已审核资源标识引用工具。");
  return { answers: resultAnswers, evidenceRefs: refs, resourceIds, modelVersion: text(record.modelVersion, "模型版本", 200), promptVersion: "m07-v1" };
}
