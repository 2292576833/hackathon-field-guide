import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";
import type { JudgingConfig, SubmissionMaterials, ManualScore, ResultRow, ResultSummary, JudgingRound, IntakeReceipt, JudgeAssignment } from "./model.ts";

export function invalid(message: string): never { throw new DomainError("JUDGING_INVALID_INPUT", message); }
export function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`${label}格式不正确或过长。`);
  return value.trim();
}
export function integer(value: unknown, label: string, min = 0, max = 1000000): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid(`${label}必须是${min}到${max}的整数。`);
  return value;
}
export function httpsUrl(value: unknown): string {
  const raw = text(value, "材料链接", 2048);
  try { const url = new URL(raw); if (url.protocol !== "https:" || url.username || url.password) invalid("材料链接须为无账号密码的 HTTPS 地址。"); return url.href; }
  catch { return invalid("材料链接须为完整 HTTPS 地址。"); }
}
export function materials(value: SubmissionMaterials): SubmissionMaterials {
  if (!value || !Array.isArray(value.links) || value.links.length > 12 || !Array.isArray(value.files) || value.files.length > 12) invalid("最多提供12个链接和12份文件元数据。");
  const result = { title: text(value.title, "作品名称", 160), description: text(value.description, "作品说明", 12000),
    links: value.links.map(link => ({ label: text(link?.label, "链接名称", 100), url: httpsUrl(link?.url) })),
    files: value.files.map(file => {
      const sha256 = text(file?.sha256, "文件哈希", 64).toLowerCase(); if (!/^[a-f0-9]{64}$/.test(sha256)) invalid("文件哈希须为64位SHA256。");
      return { name: text(file?.name, "文件名称", 180), url: httpsUrl(file?.url), sizeBytes: integer(file?.sizeBytes, "文件大小", 0, 1073741824), sha256, mediaType: text(file?.mediaType, "文件类型", 120) };
    }) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 24000) invalid("材料总长度超过24KB，请缩短说明。");
  return result;
}
/** JSONB may reorder object keys; fingerprints must be stable across persistence. */
export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export function config(value: JudgingConfig): JudgingConfig {
  if (!value || !Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 12) invalid("评分维度须有1到12项。");
  const criteria = value.criteria.map(item => {
    const id = text(item?.id, "维度标识", 64); if (!/^[a-zA-Z0-9_-]+$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) invalid("维度标识只能使用普通字母、数字、下划线和短横线。");
    const min = integer(item?.min, "最低分", 0, 1000), max = integer(item?.max, "最高分", 1, 1000);
    if (min >= max) invalid("最高分必须大于最低分。");
    return { id, label: text(item?.label, "维度名称", 100), weight: integer(item?.weight, "权重", 1, 100), min, max };
  });
  if (new Set(criteria.map(item => item.id)).size !== criteria.length || criteria.reduce((sum, item) => sum + item.weight, 0) !== 100) invalid("维度标识不能重复，权重合计必须为100%。");
  if (!["block_publication", "exclude_incomplete"].includes(value.missingPolicy) || !["shared_rank", "manual_order"].includes(value.tiePolicy)) invalid("请选择缺评和同分处理方式。");
  return { title: text(value.title, "评审轮名称", 100), criteria, minJudges: integer(value.minJudges, "最少评委数", 1, 20), missingPolicy: value.missingPolicy, tiePolicy: value.tiePolicy,
    appealWindowDays: integer(value.appealWindowDays ?? 7, "结果申诉时限（天）", 1, 90) };
}
export function scoreValues(values: Readonly<Record<string, number>>, round: JudgingRound, complete = true): Record<string, number> {
  if (!values || typeof values !== "object" || Array.isArray(values) || (complete && Object.keys(values).length !== round.config.criteria.length)
    || Object.keys(values).some(id => !round.config.criteria.some(item => item.id === id))) invalid("评分维度不完整或含未知维度。");
  const result: Record<string, number> = {};
  for (const criterion of round.config.criteria) { if (!Object.hasOwn(values, criterion.id)) { if (complete) invalid("请填写全部评分维度。"); continue; } result[criterion.id] = integer(values[criterion.id], criterion.label, criterion.min, criterion.max); }
  return result;
}
/** Fixed integer precision: normalize each integer score onto 0..1000000, then average. */
export function aggregate(round: JudgingRound, receipts: readonly IntakeReceipt[], assignments: readonly JudgeAssignment[], scores: readonly ManualScore[]): ResultSummary {
  const rows: ResultRow[] = round.snapshotIds.map(snapshotId => {
    const snapshot = receipts.find(item => item.id === snapshotId); if (!snapshot) invalid("评审材料快照缺失。");
    const effective = assignments.filter(item => item.roundId === round.id && item.snapshotId === snapshotId && item.status === "active" && item.declaration === "clear");
    const submitted = effective.map(item => scores.find(score => score.assignmentId === item.id && score.state === "submitted")).filter((score): score is ManualScore => !!score);
    const missingJudges = Math.max(0, round.config.minJudges - submitted.length);
    const units = submitted.map(score => round.config.criteria.reduce((sum, c) => sum + Math.round((score.values[c.id]! - c.min) * 10000 / (c.max - c.min)) * c.weight, 0));
    const total = missingJudges ? null : Math.round(units.reduce((a, b) => a + b, 0) / units.length) / 10000;
    return { snapshotId, teamId: snapshot.teamId, title: snapshot.materials.title, submittedJudgeCount: submitted.length, missingJudges, total, rank: null };
  });
  rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0));
  let hasTies = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.total === null) continue;
    const tied = i > 0 && rows[i - 1]!.total === rows[i]!.total;
    if (tied) hasTies = true;
    rows[i]!.rank = tied ? rows[i - 1]!.rank : i + 1;
  }
  return { rows, complete: rows.every(item => !item.missingJudges), hasTies, missingPolicy: round.config.missingPolicy, tiePolicy: round.config.tiePolicy };
}
export function csvCell(value: unknown): string {
  const raw = String(value ?? ""); const guarded = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replaceAll('"', '""')}"`;
}
