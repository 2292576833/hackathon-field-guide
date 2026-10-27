import { DomainError } from "../../shared/errors.ts";

export function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message, { status: 422 });
}

export function textField(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") invalid(`${label}必须是文字。`);
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length === 0) || trimmed.length > max || trimmed.includes("\u0000")) invalid(`${label}长度不符合要求。`);
  return trimmed;
}

export function idField(value: unknown, label = "ID"): string {
  const id = textField(value, label, 200);
  if (id !== value || /[\s\p{Cc}]/u.test(id)) invalid(`${label}不能包含空白或控制字符。`);
  return id;
}

export function revisionField(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) invalid("请提供有效的预期版本。首次填写可用时间使用版本 0。");
  return value;
}

export function timezoneField(value: unknown): string {
  const timezone = textField(value, "时区", 100);
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(0); }
  catch { invalid("请选择有效的 IANA 时区，例如 Asia/Shanghai。"); }
  return timezone;
}

export function instantField(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid(`${label}必须包含时区。`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid(`${label}不是有效的时间。`);
  // Date normalizes e.g. February 30. Reject invalid calendar fields before conversion.
  const parts = value.slice(0, 19).split(/[-T:]/).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (month! < 1 || month! > 12 || day! < 1 || day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() || hour! > 23 || minute! > 59 || second! > 59) invalid(`${label}不是有效的日历时间。`);
  return date.toISOString();
}

export function emailField(value: unknown): string {
  const email = textField(value, "邀请邮箱", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid("请输入有效的邀请邮箱。");
  return email;
}

export function referenceUrl(value: unknown): string {
  const raw = textField(value, "资料链接", 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid("请输入完整的 HTTP 或 HTTPS 链接。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) invalid("资料链接必须使用 HTTP(S)，且不能包含账号或密码。");
  return url.toString();
}

export function assertKnownFields(value: object, allowed: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请求内容必须是一个对象。");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`不支持字段 ${key}。`);
}
