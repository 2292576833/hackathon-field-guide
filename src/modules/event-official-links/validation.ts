import { DomainError } from "../../shared/errors.ts";
import type { PublishedOfficialRules } from "./model.ts";

export function invalid(message = "请核对规则关联内容。", status = 422): never {
  throw new DomainError("OFFICIAL_LINK_INVALID_INPUT", message, { status });
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请求内容必须是对象。", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !keys.includes(key))) invalid("请求包含不支持的字段。", 400);
  return body;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) invalid("比赛标识无效。", 400);
  return value;
}
export function version(value: unknown, zero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) invalid("请重新读取当前版本。");
  return value;
}
export function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid("请填写有效的核对备注。");
  return value.trim();
}
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function published(value: PublishedOfficialRules | null, expectedId?: string): PublishedOfficialRules | null {
  if (!value || value.status !== "published" || typeof value.eventId !== "string" || (expectedId !== undefined && value.eventId !== expectedId)
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 500
    || !Number.isSafeInteger(value.publishedVersion) || value.publishedVersion < 1 || value.publishedVersion > 2147483647) return null;
  try { id(value.eventId); } catch { return null; }
  const sourceUrl = safeSourceUrl(value.sourceUrl);
  return { eventId: value.eventId, title: value.title, publishedVersion: value.publishedVersion, status: "published", ...(sourceUrl ? { sourceUrl } : {}) };
}
