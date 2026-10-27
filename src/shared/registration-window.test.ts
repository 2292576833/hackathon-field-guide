import assert from "node:assert/strict";
import test from "node:test";
import { isRegistrationWindowOpen, normalizeRegistrationWindow, registrationWindowClosesAt, registrationWindowYearEvidence } from "./registration-window.ts";

const checkedAt = "2026-10-09T08:00:00Z";
const quote = "Registration closes 2026-10-30T18:00:00+08:00.";
const open = { status: "open", closesAt: "2026-10-30T18:00:00+08:00", closesOn: null, evidence: [quote] };
const check = (value: unknown, texts: readonly string[] = [quote], at = checkedAt) => normalizeRegistrationWindow(value, { texts, checkedAt: at });

test("registration offset is verified against exact evidence and canonicalized independently of event dates", () => {
  const normalized = check(open)!;
  assert.equal(normalized.status, "open"); assert.equal(normalized.closesAt, "2026-10-30T10:00:00.000Z");
  assert.equal(normalized.checkedAt, "2026-10-09T08:00:00.000Z");
  assert.equal(isRegistrationWindowOpen(normalized, checkedAt), true);
  assert.equal(isRegistrationWindowOpen(normalized, "2026-10-30T10:00:00Z"), false);
  assert.deepEqual(check(normalized), normalized, "stored UTC timestamps must remain tied to their original offset evidence");
  assert.equal(check({ ...open, closesAt: "2026-10-30T19:00:00+08:00" }), null, "the model cannot move a quoted deadline by an hour");
});

test("a calendar deadline without timezone expires at the earliest start of that date in UTC+14", () => {
  const evidence = "报名截止日期：2026年10月30日。";
  const window = check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [evidence] }, [evidence])!;
  assert.equal(registrationWindowClosesAt(window), "2026-10-29T10:00:00.000Z");
  assert.equal(isRegistrationWindowOpen(window, "2026-10-29T09:59:59.999Z"), true);
  assert.equal(isRegistrationWindowOpen(window, "2026-10-29T10:00:00Z"), false);
  assert.equal(check(window, [evidence], "2026-10-29T10:00:00Z")?.status, "closed");
});

test("human English dates and a quoted explicit UTC offset can establish the cutoff", () => {
  for (const evidence of ["Registration deadline: October 30, 2026 at 11:59 PM UTC+8.", "Applications close 30 October 2026 at 23:59 UTC+08:00."]) {
    const window = check({ status: "open", closesAt: "2026-10-30T23:59:00+08:00", closesOn: null, evidence: [evidence] }, [evidence]);
    assert.equal(window?.closesAt, "2026-10-30T15:59:00.000Z"); assert.equal(window?.status, "open");
  }
  const evidence = "报名时间：2026年10月1日至2026年10月30日。";
  assert.equal(check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [evidence] }, [evidence])?.status, "open");
  const future = "Registration will be closed on October 30, 2026.";
  assert.equal(check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [future] }, [future])?.status, "open", "a future closure announcement is not a current closed status");
});

test("past deadlines and a selected closed statement cannot be overridden by a model open status", () => {
  assert.equal(check(open, [quote], "2026-11-01T00:00:00Z")?.status, "closed");
  for (const closed of ["报名已经截止。", "Registration is closed.", "Applications have ended."]) {
    const window = check({ ...open, evidence: [quote, closed] }, [quote, closed]);
    assert.equal(window?.status, "closed"); assert.equal(isRegistrationWindowOpen(window, checkedAt), false);
  }
  assert.equal(check(open, [quote, "Old 2025 registration is closed."])?.status, "open", "unselected historical or footer prose must not close the current event");
  assert.equal(check({ ...open, status: "closed" })?.status, "unknown", "a model closed label without source evidence cannot withdraw an open card");
});

test("unknown or missing deadlines never establish indefinite registration", () => {
  const evidence = "Registration is open.";
  assert.equal(check({ status: "open", closesAt: null, closesOn: null, evidence: [evidence] }, [evidence])?.status, "unknown");
  assert.equal(check(undefined), null); assert.equal(isRegistrationWindowOpen(undefined, checkedAt), false);
  assert.equal(check({ ...open, status: "unknown" })?.status, "unknown");
});

test("submission, event dates and another later topic cannot be substituted for registration deadlines", () => {
  for (const evidence of ["Hackathon starts 2026-10-30.", "Submission deadline: 2026-10-30.", "作品提交截止：2026年10月30日。", "报名开放。赛事开始：2026年10月30日。", "Registration is open; submission deadline: 2026-10-30.", "Registration is open, event starts 2026-10-30."]) {
    assert.equal(check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [evidence] }, [evidence]), null);
  }
  const multiple = "Registration deadline: 2026-07-26. Upcoming Events: registration deadline: 2026-10-30.";
  assert.equal(check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [multiple] }, [multiple]), null, "a quote mixing multiple registration deadlines cannot establish which event remains open");
});

test("deadline evidence is bounded, exact, dated and calendar-valid without guessed timezone", () => {
  for (const value of [
    { ...open, evidence: [] }, { ...open, evidence: Array(6).fill(quote) },
    { ...open, evidence: [quote.toUpperCase()] }, { ...open, evidence: ["Registration closes on " + "x".repeat(500)] },
    { ...open, closesAt: "2026-10-30T18:00:00" }, { ...open, closesAt: "2026-02-30T18:00:00Z" },
    { ...open, closesAt: "2026-10-30T18:00:00+14:01" }, { ...open, closesOn: "2026-10-30" },
    { ...open, closesAt: null, closesOn: "2026-02-30" }, { ...open, closesAt: null, closesOn: "2026-10-31" },
    { ...open, sourceUrl: "https://untrusted.example/" },
  ]) assert.equal(check(value), null);
  const evidence = "Registration closes October 30, 2026 at 18:00.";
  assert.equal(check({ ...open, evidence: [evidence] }, [evidence]), null, "a date and time without timezone cannot prove an offset timestamp");
});

test("a current annual heading binds reverse MM/DD cutoff rows without guessing timezone or current year", () => {
  const evidence = "9/16（三）- 10/30（五）23:59 截止 書審報名";
  const page = `115年正式期程\n時間 內容 備註\n${evidence}\n©2026 115新竹政策黑客松`;
  const payload = { status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [evidence] };
  const window = check(payload, [page])!;
  assert.equal(window?.status, "open"); assert.equal(window?.closesAt, null); assert.equal(window?.closesOn, "2026-10-30");
  const context = registrationWindowYearEvidence([page]);
  assert.ok(context.length >= 1); assert.ok(context.every(quote => page.includes(quote)));
  assert.deepEqual(check(window, [evidence, ...context]), window, "the same verified annual context survives a retained snapshot");
  assert.equal(check(payload, [evidence, "©2026 115新竹政策黑客松"]), null, "copyright alone does not establish the event's year");
  assert.equal(check(payload, [evidence, "115年正式期程"]), null, "ROC heading needs a matching same-source Gregorian year");
  assert.equal(check(payload, [page.replace("115年正式期程", "114年正式期程")]), null, "conflicting year context is not repaired from now");
  const reverse = "2026年10月30日 23:59 截止报名";
  assert.equal(check({ ...payload, evidence: [reverse] }, [reverse])?.status, "open");
  assert.equal(check({ ...payload, closesAt: "2026-10-30T23:59:00+08:00", closesOn: null }, [page]), null, "no timezone was stated in the official table");
});

test("unrelated years and an opening date cannot establish or close this registration window", () => {
  const cutoff = "Registration deadline: 2026-10-30.";
  const related = "Registration deadline: 10/30. Related events: 2027 Other Hackathon.";
  assert.equal(check({ status: "open", closesAt: null, closesOn: "2027-10-30", evidence: [related] }, [related]), null);
  assert.equal(check({ ...open, evidence: [quote, "Old 2025 registration is closed."] }, [quote, "Old 2025 registration is closed."])?.status, "open");
  const starts = "Registration opens 2026-10-30T18:00:00Z, deadline TBD.";
  assert.equal(check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [starts] }, [starts]), null);
  assert.equal(check({ status: "open", closesAt: null, closesOn: "2026-10-30", evidence: [cutoff] }, [cutoff])?.status, "open");
});
