import assert from "node:assert/strict";
import test from "node:test";
import { isEventWindowFuture, normalizeEventWindow } from "./event-window.ts";

const checkedAt = "2026-10-09T08:00:00Z";
test("future event dates are verified against exact source evidence", () => {
  const evidence = "Hackathon starts 2026-11-20.";
  const window = normalizeEventWindow({ status: "future", startsAt: null, startsOn: "2026-11-20", evidence: [evidence], checkedAt }, { texts: [evidence], checkedAt });
  assert.equal(window?.status, "future");
  assert.equal(isEventWindowFuture(window, checkedAt), true);
});

test("past or unrelated dates cannot create a future event window", () => {
  for (const [evidence, startsOn] of [["Hackathon starts 2026-10-01.", "2026-10-01"], ["Registration deadline: 2026-11-20.", "2026-11-20"], ["Submission deadline: 2026-11-20.", "2026-11-20"]] as const) {
    const window = normalizeEventWindow({ status: "future", startsAt: null, startsOn, evidence: [evidence], checkedAt }, { texts: [evidence], checkedAt });
    assert.equal(window?.status, evidence.includes("2026-10-01") ? "past" : undefined);
  }
});

test("an explicit offset start time is canonicalized and an unknown date is rejected", () => {
  const evidence = "活动开始时间：2026-11-20T10:00:00+08:00。";
  const window = normalizeEventWindow({ status: "future", startsAt: "2026-11-20T10:00:00+08:00", startsOn: null, evidence: [evidence], checkedAt }, { texts: [evidence], checkedAt });
  assert.equal(window?.startsAt, "2026-11-20T02:00:00.000Z");
  assert.equal(normalizeEventWindow({ status: "future", startsAt: null, startsOn: null, evidence: ["活动即将开始。"], checkedAt }, { texts: ["活动即将开始。"], checkedAt }), null);
});
