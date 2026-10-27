import type { PublicCompetition } from "../organizer/model.ts";

/**
 * 把**已核验的公开赛事事实**转成机器可读的结构化数据与日历文件。
 *
 * 依据：竞品公开参赛页同时提供 schema.org/Event JSON-LD 与 .ics 日历导出（WeiToAGI Events 详情页；
 * REA 观测 ev_5021cb98… / ev_165bcd49…）。我们此前没有任何页面级结构化数据，也没有"加入日历"。
 *
 * 纪律（与宪法 II/XII 一致）：
 * 1. 只输出**主办方已确认并发布**的字段；未知、缺失或未核验的一律**省略**，不用占位符、不猜日期、不补地址。
 * 2. 不输出经纬度、不引入第二份地理事实：线下场次只用主办方填写的 `location` 文本。
 * 3. 不声明价格、名额、语言以外的属性；`url` 只在调用方给出真实站点来源时才写入。
 */

const SCHEMA = "https://schema.org";
const maxDescription = 300;

/** 只保留真正有值的字段；空字符串、纯空白都视为"未提供"。 */
function present(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function truncate(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`; }

/** 已发布的公开赛事 → schema.org/Event；`origin` 省略时不写 url。 */
export function eventJsonLd(event: PublicCompetition, origin?: string | null): Record<string, unknown> {
  const data: Record<string, unknown> = { "@context": SCHEMA, "@type": "Event", name: event.title, inLanguage: "zh-CN" };
  // 这两个时间属于已发布快照的必填字段，主办方发布即确认，可以直接输出。
  data.startDate = event.startsAt;
  data.endDate = event.endsAt;
  if (event.status === "published") data.eventStatus = `${SCHEMA}/EventScheduled`;
  data.organizer = { "@type": "Organization", name: event.organizationName };
  if (event.format === "online") data.eventAttendanceMode = `${SCHEMA}/OnlineEventAttendanceMode`;
  else {
    data.eventAttendanceMode = `${SCHEMA}/OfflineEventAttendanceMode`;
    const location = present(event.location);
    if (location) data.location = { "@type": "Place", name: location };
  }
  const description = present(event.summary);
  if (description) data.description = truncate(description, maxDescription);
  const site = present(origin);
  if (site) data.url = `${site.replace(/\/+$/, "")}/competitions/${encodeURIComponent(event.eventId)}`;
  return data;
}

/** RFC 5545 文本转义：反斜杠、分号、逗号与换行。 */
export function icsText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll(/\r?\n/g, "\\n");
}

/** 本地时区字符串按 UTC 输出；日期对象无效时返回 null，绝不编造时间。 */
export function icsInstant(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 每行不超过 75 个八位组，续行以空格开头（RFC 5545 折行）。 */
export function foldIcsLine(line: string): string[] {
  const encoder = new TextEncoder();
  const lines: string[] = []; let current = "";
  for (const character of line) {
    if (encoder.encode(current + character).length > 73) { lines.push(current); current = " "; }
    current += character;
  }
  lines.push(current);
  return lines;
}

export interface CalendarEntry {
  uid: string; summary: string; description: string;
  start: string; end: string; allDay: boolean;
}

/** 只对**有值**的时间生成条目：报名开放/报名截止/作品提交截止各自独立，缺失就不生成。 */
export function eventCalendarEntries(event: PublicCompetition): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  const add = (kind: string, summary: string, start: string | null, end: string | null) => {
    if (!start) return;
    const startValue = icsInstant(start); if (!startValue) return;
    const endValue = (end ? icsInstant(end) : null) ?? startValue;
    entries.push({ uid: `${event.eventId}-${kind}@hackathon-field-guide`, summary: `${event.title} · ${summary}`, description: truncate(present(event.summary) ?? "", maxDescription), start: startValue, end: endValue, allDay: false });
  };
  add("run", "比赛时间", event.startsAt, event.endsAt);
  add("registration-open", "报名开始", event.registrationOpensAt, event.registrationOpensAt);
  add("registration-close", "报名截止", event.registrationClosesAt, event.registrationClosesAt);
  add("submission-close", "作品提交截止", event.submissionClosesAt, event.submissionClosesAt);
  return entries;
}

/** 生成可下载的 .ics；没有任何可用时间时返回 null（界面据此不显示入口）。 */
export function eventCalendar(event: PublicCompetition, origin?: string | null): { filename: string; body: string } | null {
  const entries = eventCalendarEntries(event);
  if (!entries.length) return null;
  const stamp = icsInstant(event.publishedAt) ?? icsInstant(event.startsAt);
  if (!stamp) return null;
  const site = present(origin);
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hackathon Field Guide//Competition Calendar//CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(event.title)}`];
  for (const entry of entries) {
    lines.push("BEGIN:VEVENT", `UID:${entry.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${entry.start}`, `DTEND:${entry.end}`, `SUMMARY:${icsText(entry.summary)}`);
    if (entry.description) lines.push(`DESCRIPTION:${icsText(entry.description)}`);
    if (site) lines.push(`URL:${site.replace(/\/+$/, "")}/competitions/${encodeURIComponent(event.eventId)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return { filename: `${event.eventId}.ics`, body: `${lines.flatMap(foldIcsLine).join("\r\n")}\r\n` };
}
