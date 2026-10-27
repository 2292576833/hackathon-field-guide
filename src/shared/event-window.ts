export interface EventWindow {
  readonly status: "future" | "past" | "unknown";
  readonly startsAt: string | null;
  readonly startsOn: string | null;
  readonly evidence: readonly string[];
  readonly checkedAt: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const eventWords = /(?:比赛|競賽|赛事|賽事|黑客松|hackathon|competition|event|活动|活動|开赛|開賽|举办|舉辦|开始|開始|starts?|begins?|開催)/iu;
const datePattern = /(?:\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|T|\b)|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+)20\d{2}\b)/iu;
function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 9999 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}
function offsetIso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function dateInText(value: string, text: string): boolean {
  if (text.includes(value)) return true;
  const [year, month, day] = value.split("-");
  return new RegExp(`${year}[^\\d]{0,2}${Number(month)}[^\\d]{0,2}${Number(day)}`, "u").test(text);
}
function localDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function eventWindowStartsAt(window: Pick<EventWindow, "startsAt" | "startsOn">): string | null {
  if (window.startsAt !== null && window.startsOn !== null) return null;
  if (window.startsAt !== null) return offsetIso(window.startsAt);
  const on = calendarDate(window.startsOn);
  return on ? `${on}T00:00:00.000Z` : null;
}
export function normalizeEventWindow(value: unknown, input: { readonly texts: readonly string[]; readonly checkedAt: string }): EventWindow | null {
  const checkedAt = offsetIso(input.checkedAt);
  if (!checkedAt || !object(value) || Object.keys(value).some(key => !["status", "startsAt", "startsOn", "evidence", "checkedAt"].includes(key)) || !["future", "past", "unknown"].includes(value.status as string) || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 5) return null;
  const evidence = value.evidence as unknown[];
  const validQuote = (quote: unknown): quote is string => typeof quote === "string" && Boolean(quote.trim()) && quote.length <= 500 && input.texts.some(text => text.includes(quote)) && eventWords.test(quote) && datePattern.test(quote);
  if (evidence.some(quote => !validQuote(quote))) return null;
  const quotes = evidence as string[];
  const startsAt = value.startsAt === null ? null : offsetIso(value.startsAt);
  const startsOn = value.startsOn === null ? null : calendarDate(value.startsOn);
  if (value.startsAt !== null && !startsAt || value.startsOn !== null && !startsOn || startsAt && startsOn) return null;
  const dateEvidence = quotes.some(quote => startsAt ? quote.includes(value.startsAt as string) : startsOn ? dateInText(startsOn, quote) : false);
  if (!dateEvidence || (!startsAt && !startsOn)) return null;
  const instant = eventWindowStartsAt({ startsAt, startsOn });
  if (!instant) return null;
  const status = Date.parse(instant) > Date.parse(checkedAt) && (startsAt !== null || startsOn! > localDate(new Date(checkedAt))) ? "future" : "past";
  return { status, startsAt, startsOn, evidence: [...new Set(quotes)], checkedAt };
}
export function isEventWindowFuture(window: unknown, now: string | Date): boolean {
  const time = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(time.getTime()) || !object(window) || window.status !== "future" || !Array.isArray(window.evidence) || window.evidence.length < 1) return false;
  const startsAt = (window as Partial<EventWindow>).startsAt, startsOn = (window as Partial<EventWindow>).startsOn;
  if (typeof startsAt === "string") return Date.parse(startsAt) > time.getTime();
  if (typeof startsOn === "string") return startsOn > localDate(time);
  return false;
}
