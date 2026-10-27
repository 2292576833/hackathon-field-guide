export interface RegistrationWindow {
  readonly status: "open" | "closed" | "unknown";
  readonly closesAt: string | null;
  readonly closesOn: string | null;
  readonly evidence: readonly string[];
  readonly checkedAt: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const registration = /[报報]名|[参參][赛賽]申[请請]|申[请請][参參][赛賽]|\bregistration\b|\bregister\b|\bapplications?\b|\bapply\b|\bsign[ -]?ups?\b/iu;
const deadline = /截止|截至|结束|結束|关闭|關閉|期限|至|\bdeadline\b|\bclos(?:e|es|ed|ing)\b|\bends?\b|\buntil\b|\bby\b/iu;
const state = /开放|開放|接受|开启|開啟|启动|啟動|进行|進行|已满|已滿|不再|已.{0,8}(?:截止|结束|結束|关闭|關閉)|\bopen\b|\bclosed\b|\baccepting\b|\bfull\b|\bnot\s+accepting\b|\bended\b/iu;
const explicitlyClosed = /(?:[报報]名|[参參][赛賽]申[请請]|申[请請][参參][赛賽])[^\n。;；]{0,45}(?:已(?:经|經)?(?:截止|结束|結束|关闭|關閉)|现已.{0,6}(?:截止|结束|关闭)|不再接受|已满|已滿)|(?:不再接受|停止接受|关闭|關閉)[^\n。;；]{0,15}(?:[报報]名|[参參][赛賽]申[请請])|\b(?:registration|applications?|sign[ -]?ups?)\b(?:[ :–-]+(?:is|are|has|have|now|already|been|currently)){0,4}[ :–-]+(?:closed|ended|full|no\s+longer\s+accepted)\b|\b(?:registration|application)\s+deadline\b[^\n.;]{0,20}\b(?:has\s+passed|passed)\b/iu;
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
}
function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return calendarDate(year, month, day);
}
function offsetIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !dateOnly(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59 || Number(match[8] ?? 0) > 14 || Number(match[9] ?? 0) > 59 || Number(match[8] ?? 0) === 14 && Number(match[9] ?? 0) !== 0) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function dates(text: string, yearHint?: number): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\b)/gu)) {
    const date = calendarDate(Number(match[1]), Number(match[2]), Number(match[3])); if (date) found.push(date);
  }
  const monthIndex = (name: string) => months.findIndex(month => month.startsWith(name.toLowerCase().replace(/\.$/u, ""))) + 1;
  for (const match of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{4})\b/giu)) {
    const date = calendarDate(Number(match[3]), monthIndex(match[1]), Number(match[2])); if (date) found.push(date);
  }
  for (const match of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*,?\s+(\d{4})\b/giu)) {
    const date = calendarDate(Number(match[3]), monthIndex(match[2]), Number(match[1])); if (date) found.push(date);
  }
  if (yearHint !== undefined) for (const match of text.matchAll(/(?:^|[^\d])(\d{1,2})[\/.月](\d{1,2})(?:日|(?=[^\d]|$))/gu)) {
    const date = calendarDate(yearHint, Number(match[1]), Number(match[2])); if (date) found.push(date);
  }
  return [...new Set(found)];
}

function relevantText(text: string, focus: readonly string[] = []): string {
  if (!focus.length) return /(?:正式期程|报名(?:时间|期間|期间)|竞赛年度|比赛年度)/u.test(text) && /\b20\d{2}\b/u.test(text) ? text : text;
  const index = focus.map(value => text.indexOf(value)).find(value => value >= 0);
  if (index === undefined) return /(?:正式期程|报名(?:时间|期間|期间)|竞赛年度|比赛年度)/u.test(text) || /\b20\d{2}\b/u.test(text) ? text : "";
  return text.slice(Math.max(0, index - 1200), Math.min(text.length, index + 1200));
}
function yearContext(texts: readonly string[], focus: readonly string[] = []): { year: number; evidence: string[] } | null {
  const candidates: { year: number; evidence: string[] }[] = [];
  const formal: string[] = [], yearSnippets: { year: number; text: string }[] = [];
  for (const text of texts) {
    const segment = relevantText(text, focus);
    if (!segment) continue;
    if (/(?:正式期程|报名(?:时间|期間|期间)|竞赛年度|比赛年度)/u.test(segment)) formal.push(segment.match(/[^\n]{0,120}(?:正式期程|报名(?:时间|期間|期间)|竞赛年度|比赛年度)[^\n]{0,120}/u)?.[0]?.trim() ?? segment.slice(0, 240));
    for (const yearMatch of segment.matchAll(/\b(20\d{2})\b/gu)) {
      yearSnippets.push({ year: Number(yearMatch[1]), text: segment.slice(Math.max(0, yearMatch.index - 80), Math.min(segment.length, yearMatch.index + 120)).trim() });
    }
    for (const match of segment.matchAll(/\b(20\d{2})\s*年?[^\n。;；]{0,55}?(?:黑客松|hackathon|正式期程|报名(?:时间|期間|期间)|[竞競][赛賽]年度)/giu)) {
      const before = segment.slice(Math.max(0, match.index - 80), match.index);
      if (!/(?:copyright|©)\s*$/iu.test(before) && !/(?:related|upcoming|past|previous|older|历年|往届|往屆|相關|相关)/iu.test(before)) candidates.push({ year: Number(match[1]), evidence: [match[0]] });
    }
    for (const match of segment.matchAll(/(?:正式期程|报名(?:时间|期間|期间)|竞赛年度|比赛年度)[^\n。;；]{0,100}?\b(20\d{2})\b/giu)) {
      const yearPrefix = match[0].slice(0, match[0].lastIndexOf(match[1]!));
      if (!/(?:©|copyright)\s*$/iu.test(yearPrefix)) candidates.push({ year: Number(match[1]), evidence: [match[0]] });
    }
    for (const match of segment.matchAll(/(?:民[国國]\s*(\d{2,3})\s*年|\b(\d{2,3})\s*年\s*(?:正式期程|[^\n。;；]{0,30}?黑客松))/gu)) {
      const year = Number(match[1] ?? match[2]) + 1911;
      const source = segment.match(new RegExp(`.{0,80}${year}.{0,80}`, "u"))?.[0]?.trim();
      if (source) candidates.push({ year, evidence: [match[0], source] });
    }
  }
  if (!candidates.length && formal.length) {
    const roc = /\b(\d{2,3})年\s*(?:正式期程|黑客松|hackathon)/u.exec(formal[0]!);
    const expected = roc ? Number(roc[1]) + 1911 : null;
    const matching = expected === null ? (new Set(yearSnippets.map(item => item.year)).size === 1 ? yearSnippets[0] : undefined) : yearSnippets.find(item => item.year === expected);
    if (matching) candidates.push({ year: matching.year, evidence: [formal[0]!, matching.text] });
  }
  const allYears = new Set(candidates.map(candidate => candidate.year));
  if (allYears.size !== 1) return null;
  return candidates.find(candidate => candidate.evidence.length === 2) ?? candidates[0] ?? null;
}

/** Exact annual context needed to re-check partial MM/DD deadlines in stored
 * snapshots. A copyright year alone is never used to guess an event year. */
export function registrationWindowYearEvidence(texts: readonly string[], focus: readonly string[] = []): readonly string[] {
  return yearContext(texts, focus)?.evidence ?? [];
}
/** Work only on the model's exact registration excerpts, never unrelated older
 * events or footer text elsewhere on the source page. */
function registrationClauses(evidence: readonly string[]): string[] {
  return evidence.flatMap(quote => quote.split(/[\n。;；!！]/u)).flatMap(clause => {
    const match = registration.exec(clause);
    if (!match) return [];
    const before = clause.slice(0, match.index);
    if (/\bsubmission\s+deadline\b|作品(?:提交|截止)|提交(?:截止|期限)/iu.test(before)) return [];
    const tail = deadline.test(before) ? clause : clause.slice(match.index);
    const nextTopic = /\b(?:submission\s+deadline|submissions?\s+(?:close|end)|event\s+(?:starts?|ends?)|hackathon\s+(?:starts?|ends?))\b|作品(?:提交|截止)|提交(?:截止|期限)|赛事(?:开始|结束)/iu.exec(tail);
    const bounded = nextTopic ? tail.slice(0, nextTopic.index) : tail;
    return deadline.test(bounded) ? [bounded] : [];
  });
}
function deadlineDates(clause: string, yearHint?: number): string[] {
  const match = deadline.exec(clause);
  if (!match) return [];
  const after = dates(clause.slice(match.index), yearHint);
  if (after.length) return after;
  const before = clause.slice(0, match.index), found = dates(before, yearHint);
  if (/(?:\bopens?\b|\bstarts?\b|报名开始|报名开放|开始报名|开放报名)/iu.test(before)) return [];
  if (found.length === 1) return found;
  return found.length === 2 && /(?:\)|）|日|\d)\s*(?:-|–|—|至|~|～)\s*\d/u.test(before) ? [found[1]] : [];
}
function sourceInstant(clause: string): string[] {
  const found: string[] = [];
  for (const match of clause.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/gu)) {
    const at = offsetIso(match[0]); if (at) found.push(at);
  }
  const sourceDates = deadlineDates(clause);
  const time = /(?:\bat\s+|\b)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:\(|\[)?\s*(UTC|GMT)(?:\s*([+-])(\d{1,2})(?::?(\d{2}))?)?/iu.exec(clause);
  if (sourceDates.length === 1 && time) {
    let hour = Number(time[1]);
    if (time[4]) { if (hour < 1 || hour > 12) return found; hour = hour % 12 + (time[4].toUpperCase() === "PM" ? 12 : 0); }
    const zone = time[6] ? `${time[6]}${String(Number(time[7])).padStart(2, "0")}:${time[8] ?? "00"}` : "Z";
    const at = offsetIso(`${sourceDates[0]}T${String(hour).padStart(2, "0")}:${time[2]}:${time[3] ?? "00"}${zone}`);
    if (at) found.push(at);
  }
  return [...new Set(found)];
}

/** Missing timezone/date is never interpreted as indefinitely open. Date-only
 * deadlines expire at the earliest global start of that date, UTC+14. */
export function registrationWindowClosesAt(window: Pick<RegistrationWindow, "closesAt" | "closesOn">): string | null {
  if (window.closesAt !== null && window.closesOn !== null) return null;
  if (window.closesAt !== null) return offsetIso(window.closesAt);
  const on = dateOnly(window.closesOn);
  return on ? new Date(Date.parse(`${on}T00:00:00+14:00`)).toISOString() : null;
}

/** A shared pure evidence gate for the worker and durable-card composition.
 * Unknown/malformed evidence returns null; valid uncertain status remains
 * unknown. checkedAt always comes from the trusted caller's real clock. */
export function normalizeRegistrationWindow(value: unknown, input: { readonly texts: readonly string[]; readonly checkedAt: string }): RegistrationWindow | null {
  const checkedAt = offsetIso(input.checkedAt);
  if (!checkedAt || !object(value) || Object.keys(value).some(key => !["status", "closesAt", "closesOn", "evidence", "checkedAt"].includes(key)) || !["open", "closed", "unknown"].includes(value.status as string) || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 5) return null;
  const evidence = value.evidence as unknown[];
  if (evidence.some(quote => typeof quote !== "string" || !quote.trim() || quote.length > 500 || !input.texts.some(text => text.includes(quote)) || !registration.test(quote) || !(deadline.test(quote) || state.test(quote)))) return null;
  const quotes = evidence as string[];
  const closesAt = value.closesAt === null ? null : offsetIso(value.closesAt);
  const closesOn = value.closesOn === null ? null : dateOnly(value.closesOn);
  if (value.closesAt !== null && !closesAt || value.closesOn !== null && !closesOn || closesAt && closesOn) return null;
  const clauses = registrationClauses(quotes);
  const yearHint = yearContext(input.texts, quotes)?.year;
  if (closesAt && !clauses.some(clause => { const instants = sourceInstant(clause); return instants.length === 1 && instants[0] === closesAt; }) || closesOn && !clauses.some(clause => { const on = deadlineDates(clause, yearHint); return on.length === 1 && on[0] === closesOn; })) return null;
  const cutoff = registrationWindowClosesAt({ closesAt, closesOn });
  const closed = quotes.some(quote => explicitlyClosed.test(quote) && !(cutoff && /\b20\d{2}\b/u.test(quote) && !quote.includes(cutoff.slice(0, 4)))) || cutoff !== null && Date.parse(cutoff) <= Date.parse(checkedAt);
  const status = closed ? "closed" : value.status === "open" && cutoff !== null ? "open" : "unknown";
  return { status, closesAt, closesOn, evidence: [...new Set(quotes)], checkedAt };
}

export function isRegistrationWindowOpen(window: unknown, now: string | Date): boolean {
  const time = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(time) || !object(window) || window.status !== "open" || !Array.isArray(window.evidence) || window.evidence.length < 1 || !offsetIso(window.checkedAt)) return false;
  const cutoff = registrationWindowClosesAt(window as unknown as RegistrationWindow);
  return cutoff !== null && Date.parse(cutoff) > time;
}
