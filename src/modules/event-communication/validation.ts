import { DomainError } from "../../shared/errors.ts";

/** Reject calendar normalization (e.g. February 30) and server-local timezone guesses. */
export function parseEventInstant(value: unknown, code = "COMMUNICATION_INVALID_INPUT"): string {
  const fail = (): never => { throw new DomainError(code, "请填写有效且包含时区的完整时间，例如 2026-10-11T18:00:00+08:00。"); };
  if (typeof value !== "string" || value.length > 40) return fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return fail();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59 || !Number.isFinite(Date.parse(value))) return fail();
  return new Date(value).toISOString();
}
