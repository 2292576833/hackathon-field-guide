import assert from "node:assert/strict";
import test from "node:test";
import type { PublicCompetition } from "../organizer/model.ts";
import { eventCalendar, eventCalendarEntries, eventJsonLd, foldIcsLine, icsInstant, icsText } from "./public-structured-data.ts";

const event = (overrides: Partial<PublicCompetition> = {}): PublicCompetition => ({
  organizationId: "org", organizationName: "示例主办方", eventId: "event-1", title: "示例黑客松", status: "published", publishedRevision: 1,
  organizationStatus: "approved", availability: "available", timezone: "Asia/Shanghai",
  startsAt: "2026-11-01T01:00:00.000Z", endsAt: "2026-11-02T09:00:00.000Z",
  registrationOpensAt: "2026-10-20T00:00:00.000Z", registrationClosesAt: "2026-10-28T15:59:00.000Z", submissionClosesAt: null,
  modules: {} as PublicCompetition["modules"], summary: "面向新人的两天线上黑客松，作品以可运行的演示为准。", rules: "规则正文",
  location: "", format: "online", changeSummary: "首次发布", publishedAt: "2026-10-15T00:00:00.000Z", ...overrides,
});

test("JSON-LD 只输出已确认字段：线上场次不写地址、不写价格与名额", () => {
  const data = eventJsonLd(event());
  assert.equal(data["@type"], "Event"); assert.equal(data.name, "示例黑客松");
  assert.equal(data.startDate, "2026-11-01T01:00:00.000Z"); assert.equal(data.endDate, "2026-11-02T09:00:00.000Z");
  assert.equal(data.eventStatus, "https://schema.org/EventScheduled");
  assert.deepEqual(data.organizer, { "@type": "Organization", name: "示例主办方" });
  assert.equal(data.eventAttendanceMode, "https://schema.org/OnlineEventAttendanceMode");
  assert.equal("location" in data, false, "线上场次没有主办方填写的地址就不写 location");
  assert.equal("offers" in data, false, "不得声明价格或名额");
  assert.equal("url" in data, false, "没有真实站点来源时不写 url");
  assert.equal((data.description as string).length <= 300, true);
});

test("线下场次只在主办方填了地址时给出 Place，且照抄原文不改写", () => {
  const withLocation = eventJsonLd(event({ format: "onsite", location: "上海市浦东新区示例路 1 号 A 座" }));
  assert.deepEqual(withLocation.location, { "@type": "Place", name: "上海市浦东新区示例路 1 号 A 座" });
  assert.equal(withLocation.eventAttendanceMode, "https://schema.org/OfflineEventAttendanceMode");
  const blank = eventJsonLd(event({ format: "onsite", location: "   " }));
  assert.equal("location" in blank, false, "空白的地址等于未提供，不能补占位文字");
});

test("给出真实来源时才写 url；已结束的场次不声明 EventScheduled", () => {
  assert.equal(eventJsonLd(event(), "https://example.test/")["url"], "https://example.test/competitions/event-1");
  assert.equal(eventJsonLd(event({ status: "ended" }))["eventStatus"], undefined);
});

test("日历条目按有值的时间生成：缺失的截止项不出现", () => {
  const entries = eventCalendarEntries(event());
  assert.deepEqual(entries.map(item => item.uid), ["event-1-run@hackathon-field-guide", "event-1-registration-open@hackathon-field-guide", "event-1-registration-close@hackathon-field-guide"],
    "比赛时间 + 报名开始 + 报名截止；作品截止未提供就不生成");
  assert.equal(entries[0]!.summary.includes("比赛时间"), true);
  assert.equal(entries.some(item => item.summary.includes("作品提交截止")), false);
  const withSubmission = eventCalendarEntries(event({ submissionClosesAt: "2026-10-30T15:59:00.000Z" }));
  assert.equal(withSubmission.length, 4);
});

test("无效时间不生成日历条目，界面据此可以不显示入口", () => {
  const broken = { ...event(), startsAt: "不是时间", endsAt: "也不是", registrationOpensAt: null, registrationClosesAt: null } as PublicCompetition;
  assert.deepEqual(eventCalendarEntries(broken), []);
  assert.equal(eventCalendar(broken), null);
  assert.equal(icsInstant("2026-11-01T01:00:00+08:00"), "20261031T170000Z", "带时区的时间按 UTC 输出 ICS 格式");
  assert.equal(icsInstant("nope"), null);
});

test("生成的 .ics 结构合法、CRLF 结尾、长行折行且转义特殊字符", () => {
  const calendar = eventCalendar(event({ title: "示例; 黑客松, 第二天" }), "https://example.test")!;
  assert.equal(calendar.filename, "event-1.ics");
  assert.equal(calendar.body.startsWith("BEGIN:VCALENDAR\r\n"), true);
  assert.equal(calendar.body.endsWith("END:VCALENDAR\r\n"), true);
  assert.equal(calendar.body.includes("VERSION:2.0"), true);
  assert.equal((calendar.body.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  assert.equal(calendar.body.includes("SUMMARY:示例\\; 黑客松\\, 第二天 · 比赛时间"), true, "分号与逗号必须转义");
  assert.equal(calendar.body.includes("URL:https://example.test/competitions/event-1"), true);
  const long = "说明".repeat(200);
  const folded = foldIcsLine(`DESCRIPTION:${icsText(long)}`);
  assert.equal(folded.length > 1, true);
  assert.equal(folded.slice(1).every(line => line.startsWith(" ")), true, "续行必须以空格开头");
  assert.equal(new TextEncoder().encode(folded[0]!).length <= 75, true);
});
