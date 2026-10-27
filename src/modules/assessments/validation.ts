import { DomainError } from "../../shared/errors.ts";
import type { AssessmentAnswer, AssessmentAttempt, MemberProfile, SharingSelection, TaskDimension } from "./types.ts";

export const DIMENSIONS: readonly TaskDimension[] = ["requirements", "design", "development", "testing", "documentation", "presentation"];
export function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label}格式不正确。`);
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label}包含不支持的字段。`);
}
export function string(value: unknown, label: string, maximum = 10000, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) invalid(`${label}不能为空或过长。`);
  return value.trim();
}
export function array(value: unknown, label: string, maximum = 100): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label}格式不正确或数量过多。`);
  return value;
}
export function strings(value: unknown, label: string, maximum = 100, itemMaximum = 1000): readonly string[] {
  const result = array(value, label, maximum).map((entry) => string(entry, label, itemMaximum));
  if (new Set(result).size !== result.length) invalid(`${label}不能重复。`);
  return result;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("请提供有效的预期修订号。");
  return value as number;
}
export function optionalId(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label, 200);
}
function dimensions(value: unknown, label: string): readonly TaskDimension[] {
  const result = strings(value, label, 6, 30);
  if (result.some((entry) => !DIMENSIONS.includes(entry as TaskDimension))) invalid(`${label}包含未知任务维度。`);
  return result as readonly TaskDimension[];
}
export function validateProfile(value: unknown): MemberProfile {
  const data = object(value, "成员意愿");
  keys(data, ["experience", "tools", "preferredTasks", "memberAvailabilityVersionId"], "成员意愿");
  return {
    experience: string(data.experience, "经历", 5000, true),
    tools: strings(data.tools, "工具", 30, 100),
    preferredTasks: dimensions(data.preferredTasks, "偏好"),
    memberAvailabilityVersionId: optionalId(data.memberAvailabilityVersionId, "可用时间版本"),
  };
}
export function validateAnswers(value: unknown, attempt: AssessmentAttempt): readonly AssessmentAnswer[] {
  const questionIds = new Set(attempt.questionSetSnapshot.questions.map((question) => question.id));
  const evidenceIds = new Set<string>();
  const answers = array(value, "回答", 30).map((entry) => {
    const answer = object(entry, "回答");
    keys(answer, ["questionId", "text", "evidence", "aiUsage"], "回答");
    const questionId = string(answer.questionId, "题目 ID", 200);
    if (!questionIds.has(questionId)) invalid("回答必须引用本次题组内的题目。");
    const evidence = array(answer.evidence, "证据", 20).map((item) => {
      const data = object(item, "证据");
      keys(data, ["id", "kind", "text", "url"], "证据");
      const id = string(data.id, "证据 ID", 200);
      if (evidenceIds.has(id) || questionIds.has(id) || attempt.followUps.some((followUp) => followUp.id === id)) invalid("证据 ID 不能重复或与题目/追问 ID 冲突。");
      evidenceIds.add(id);
      if (!["self_report", "work_sample", "verification_steps"].includes(data.kind as string)) invalid("证据类型不支持。");
      const url = optionalIdUrl(data.url);
      return { id, kind: data.kind as "self_report" | "work_sample" | "verification_steps", text: string(data.text, "证据说明", 10000), url };
    });
    return { questionId, text: string(answer.text, "回答", 20000, true), evidence, aiUsage: string(answer.aiUsage, "AI 使用说明", 2000, true) };
  });
  if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length) invalid("同一题目只能有一份回答。");
  return answers;
}
function optionalIdUrl(value: unknown): string | null {
  if (value === null) return null;
  const text = string(value, "证据链接", 2000);
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) invalid("证据链接必须是没有凭据的 HTTP(S) 链接。");
    return url.href;
  } catch { return invalid("证据链接格式不正确。"); }
}
export function validateSharing(value: unknown, attempt: AssessmentAttempt): SharingSelection {
  const data = object(value, "共享范围");
  keys(data, ["confirmedTasks", "criterionIds"], "共享范围");
  const criterionIds = strings(data.criterionIds, "共享评分项", 100, 200);
  if (criterionIds.some((id) => !attempt.rubricSnapshot.criteria.some((criterion) => criterion.id === id))) invalid("共享评分项必须属于本次量规。");
  return { confirmedTasks: dimensions(data.confirmedTasks, "确认可承担任务"), criterionIds };
}
export function ensureSubmittable(attempt: AssessmentAttempt): void {
  for (const question of attempt.questionSetSnapshot.questions.filter((entry) => entry.required)) {
    const answer = attempt.answers.find((entry) => entry.questionId === question.id);
    if (!answer || (!answer.text.trim() && answer.evidence.length === 0)) invalid("请先完成必答题；也可以取消测评并采用手动分工。");
  }
  if (attempt.followUps.some((entry) => entry.answer === null || !entry.answer.trim())) invalid("请先完成已追加的补充问题。");
}
