import type { FixedSkillReference } from "../skills/index.ts";
import { DomainError } from "../../shared/errors.ts";

/** A member's account of using one fixed skill/bundle version, not installation
 * evidence, compatibility confirmation, or a task/delivery success state. */
export interface SkillUsage {
  reference: FixedSkillReference;
  purpose: string;
  feedback: string;
  limitations: string;
}
export interface SkillUsageParseOptions { allowIncomplete?: boolean }

function invalid(message: string, reference = false): never {
  throw new DomainError(reference ? "INVALID_SKILL_REFERENCE" : "INVALID_INPUT", message);
}
function object(value: unknown, keys: readonly string[], reference = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请提供有效的技能使用经验。", reference);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid("技能使用经验包含不支持的字段；成员记录不能替代安装、兼容或成功事实。", reference);
  return record;
}

/** Aligns with M10's public parseFixedSkillReference identity validation.
 * M10's public index and project-selection module have server crypto imports;
 * runtime-importing either would pull Node dependencies into the browser form.
 * Keep this structural parser client-safe and the shared reference type public.
 * Historical references deliberately do not look up current publication state. */
function fixedReference(value: unknown): FixedSkillReference {
  const input = object(value, ["kind", "id", "version", "versionId", "contentHash", "revision"], true);
  if (input.kind !== "skill" && input.kind !== "bundle") invalid("技能引用类型必须为技能或技能包。", true);
  const identity = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\x00-\x1f]/.test(value)) invalid("固定技能引用标识需在240字以内。", true);
    const result = value.trim();
    if (/(?:[a-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:Users|home|root|var|tmp)\/|\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]{8,}|\bBearer\s+\S+|(?:api[_ -]?key|password|secret|token|密钥|口令)\s*[:=]\s*\S+)/i.test(result)) invalid("固定技能引用不能包含本机路径或凭据。", true);
    if (!/^[a-zA-Z0-9_.@+-]+$/.test(result) || result === "latest") invalid("技能引用需要明确固定版本，不能使用动态版本或路径。", true);
    return result;
  };
  if (typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)) invalid("固定技能引用需要小写64位内容哈希。", true);
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) invalid("固定技能引用需要正整数版本。", true);
  return { kind: input.kind, id: identity(input.id), version: identity(input.version), versionId: identity(input.versionId), contentHash: input.contentHash, revision: input.revision as number };
}
function text(value: unknown, label: string, allowIncomplete: boolean): string {
  if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (!allowIncomplete && !value.trim())) invalid(`${label}${allowIncomplete ? "需要文字" : "不能为空"}，且需在2000字以内。`);
  return allowIncomplete ? value : value.trim();
}

/** Undefined preserves legacy content. [] explicitly represents no recorded use.
 * This validates only a historical reference and member-authored text; it invokes
 * no M10 lookup/installation/source port and makes no availability guarantee. */
export function parseSkillUsage(value: unknown, options: SkillUsageParseOptions = {}): SkillUsage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) invalid("技能使用经验最多支持12项。");
  const allowIncomplete = options.allowIncomplete === true;
  return value.map(item => {
    const input = object(item, ["reference", "purpose", "feedback", "limitations"]);
    return { reference: fixedReference(input.reference), purpose: text(input.purpose, "使用用途", allowIncomplete), feedback: text(input.feedback, "成员反馈", allowIncomplete), limitations: text(input.limitations, "限制与未知", allowIncomplete) };
  });
}
