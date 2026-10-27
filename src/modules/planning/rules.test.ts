import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAvailabilityWindows, validateAvailabilityWindows, validateDurationEstimate, validatePlan } from "./rules.ts";
import type { AvailabilityWindow, BufferPolicy, DurationEstimate, PlanningInput, PlanningTask } from "./types.ts";

const at = (hour: number, minute = 0) => `2026-10-08T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
const now = at(8);
const estimate = (likely = 60, pessimistic = likely): DurationEstimate => ({ optimisticMinutes: Math.min(30, likely), likelyMinutes: likely, pessimisticMinutes: pessimistic, basis: "成员试做估算" });
function window(id: string, start: string, end: string, purpose: AvailabilityWindow["purpose"] = "work", membershipId = "m1"): AvailabilityWindow {
  return { id, projectId: "p1", membershipId, startsAt: start, endsAt: end, sourceTimeZone: "Asia/Shanghai", purpose, version: 1 };
}
function input(): PlanningInput {
  return {
    projectId: "p1", projectRevision: 1, requirementVersionId: "req-v1", assignmentVersionId: null,
    capturedAt: now, availabilityVersions: { m1: 1, m2: 1 },
    members: [{ membershipId: "m1", projectId: "p1", userId: "u1", role: "manager", status: "active" }, { membershipId: "m2", projectId: "p1", userId: "u2", role: "member", status: "active" }],
    availability: [{ membershipId: "m1", version: 1, confirmedAt: now, windows: [window("w1", at(8), at(18))] }, { membershipId: "m2", version: 1, confirmedAt: now, windows: [window("w2", at(8), at(18), "work", "m2")] }],
    deadlines: [{ id: "submit", kind: "submission", instantUtc: at(18), sourceTimeZone: "Asia/Shanghai", sourceText: "官网明确截止点", verified: true }],
    requirements: [], approvedResourceIds: ["r-approved"], assumptions: [], requiredTaskKinds: [],
  };
}
function task(id = "a", change: Partial<PlanningTask> = {}): PlanningTask {
  return { id, projectId: "p1", title: "实现主流程", priority: "must", kind: "implementation", ownerMembershipId: "m1", helperEfforts: [], deliverable: "可运行主流程", acceptanceCriteria: ["可以按说明跑通"], reviewerMembershipId: "m2", durationEstimate: estimate(), remainingEstimate: null, dependencyTaskIds: [], deadlineRef: "submit", requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0, status: "todo", blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: now, ...change };
}
const policy = (reservedMinutes = 60): BufferPolicy[] => [{ deadlineId: "submit", reservedMinutes, basis: "材料与平台确认耗时" }];
function shortInput(end = 12, secondEnd = end): PlanningInput {
  const data = input();
  data.availability[0]!.windows = [window("w1", at(8), at(end))];
  data.availability[1]!.windows = [window("w2", at(8), at(secondEnd), "work", "m2")];
  data.deadlines[0]!.instantUtc = at(end);
  return data;
}
const codes = (result: ReturnType<typeof validatePlan>) => result.issues.map(item => item.code);

test("numeric offsets round-trip against IANA timezone, while canonical Z retains source timezone", () => {
  const canonical = window("w", at(8), at(9));
  assert.deepEqual(validateAvailabilityWindows("p1", "m1", [canonical]), []);
  const correct = { ...canonical, startsAt: "2026-10-08T16:00:00+08:00", endsAt: "2026-10-08T17:00:00+08:00" };
  assert.deepEqual(validateAvailabilityWindows("p1", "m1", [correct]), []);
  const wrong = { ...canonical, startsAt: "2026-10-08T16:00:00+09:00" };
  assert.ok(validateAvailabilityWindows("p1", "m1", [wrong]).some(item => item.code === "TIME_ZONE_OFFSET_CONFLICT"));
  const dst = { ...canonical, startsAt: "2026-07-01T12:00:00-05:00", endsAt: "2026-07-01T13:00:00-05:00", sourceTimeZone: "America/New_York" };
  assert.ok(validateAvailabilityWindows("p1", "m1", [dst]).some(item => item.code === "TIME_ZONE_OFFSET_CONFLICT"));
  dst.startsAt = "2026-07-01T12:00:00-04:00"; dst.endsAt = "2026-07-01T13:00:00-04:00";
  assert.deepEqual(validateAvailabilityWindows("p1", "m1", [dst]), []);
});

test("invalid calendar dates and timezone-free inputs never silently normalize", () => {
  for (const value of ["2026-02-30T12:00:00Z", "2026-10-08T24:00:00Z", "2026-10-08T08:00:00-00:00"]) assert.ok(validateAvailabilityWindows("p1", "m1", [window("w", value, at(18))]).some(item => item.severity === "error"));
  const ambiguous = validateAvailabilityWindows("p1", "m1", [window("w", "2026-10-08T08:00:00", at(18))]);
  assert.ok(ambiguous.some(item => item.code === "TIME_AMBIGUOUS" && item.severity === "unknown"));
  assert.ok(validateAvailabilityWindows("p1", "m1", [{ ...window("w", at(8), at(9)), sourceTimeZone: "+08:00" }]).some(item => item.code === "INVALID_TIME_ZONE"));
});

test("merged work and overlapping rest/occupied are counted once, clipped to current time", () => {
  const windows = [window("w1", at(7), at(11)), window("w2", at(9), at(12)), window("r1", at(8), at(9), "rest"), window("r2", at(8, 30), at(10), "rest"), window("o1", at(10, 30), at(11), "occupied"), window("r-outside", at(20), at(21), "rest")];
  const result = normalizeAvailabilityWindows("p1", "m1", windows, at(9, 30));
  assert.equal(result.capacityMinutes, 90);
  assert.deepEqual(result.windows, [{ startsAt: new Date(at(10)).toISOString(), endsAt: new Date(at(10, 30)).toISOString() }, { startsAt: new Date(at(11)).toISOString(), endsAt: new Date(at(12)).toISOString() }]);
  assert.equal(windows[0]!.startsAt, at(7));
});

test("window scope and estimates reject malformed input", () => {
  assert.ok(validateAvailabilityWindows("p1", "m1", [window("w", at(8), at(9), "work", "m2")]).some(item => item.code === "WINDOW_SCOPE_MISMATCH"));
  for (const value of [estimate(-1), { ...estimate(), pessimisticMinutes: 10 }, { ...estimate(), likelyMinutes: Number.NaN }, undefined]) assert.ok(validateDurationEstimate(value).some(item => item.severity === "error"));
  assert.ok(validateDurationEstimate({ ...estimate(), basis: "" }).some(item => item.code === "LOW_BASIS_ESTIMATE"));
});

test("cycle reports a concrete closed dependency chain", () => {
  const result = validatePlan(input(), [task("a", { dependencyTaskIds: ["b"] }), task("b", { dependencyTaskIds: ["c"] }), task("c", { dependencyTaskIds: ["a"] })], policy(), now);
  assert.equal(result.structuralValid, false);
  assert.deepEqual(result.issues.find(item => item.code === "DEPENDENCY_CYCLE")!.chain, ["a", "b", "c", "a"]);
  assert.equal(result.likely.scheduled.length, 0);
});

test("dangling, cancelled and cross-project dependencies cannot be applied", () => {
  assert.ok(codes(validatePlan(input(), [task("a", { dependencyTaskIds: ["gone"] })], policy(), now)).includes("DEPENDENCY_DANGLING"));
  const cancelled = task("b", { priority: "optional", status: "cancelled", cancellationReason: "缩小范围" });
  assert.ok(codes(validatePlan(input(), [task("a", { dependencyTaskIds: ["b"] }), cancelled], policy(), now)).includes("DEPENDENCY_CANCELLED"));
  assert.ok(codes(validatePlan(input(), [task("a", { dependencyTaskIds: ["b"] }), task("b", { projectId: "other" })], policy(), now)).includes("DEPENDENCY_SCOPE_MISMATCH"));
});

test("one person's overlapping tasks share actual remaining capacity", () => {
  const result = validatePlan(shortInput(), [task("a", { durationEstimate: estimate(150) }), task("b", { durationEstimate: estimate(150) })], policy(0), now);
  assert.equal(result.structuralValid, true);
  assert.equal(result.feasibility, "infeasible");
  assert.equal(result.likely.scheduled.length, 1);
  assert.equal(result.likely.issues[0]!.missingMinutes, 60);
  assert.equal(result.likely.capacityMinutes.m1, 240);
});

test("helper efforts consume each helper's real capacity without leaking a failed attempt", () => {
  const data = shortInput(12, 11);
  const helperEfforts = [{ membershipId: "m2", durationEstimate: estimate(120) }];
  const result = validatePlan(data, [task("a", { durationEstimate: estimate(30), helperEfforts }), task("b", { durationEstimate: estimate(30), helperEfforts }), task("c", { ownerMembershipId: "m2", reviewerMembershipId: "m1", durationEstimate: estimate(60) })], policy(0), now);
  assert.equal(result.likely.issues.find(item => item.taskIds.includes("b"))!.membershipId, "m2");
  assert.equal(result.likely.issues.find(item => item.taskIds.includes("b"))!.missingMinutes, 60);
  assert.equal(result.likely.scheduled.find(item => item.taskId === "c")!.allocations[0]!.segments[0]!.startsAt, new Date(at(10)).toISOString());
});

test("likely and pessimistic schedules are independent", () => {
  const result = validatePlan(shortInput(10), [task("a", { durationEstimate: estimate(60, 180) }), task("b", { durationEstimate: estimate(30) })], policy(0), now);
  assert.equal(result.feasibility, "at_risk");
  assert.equal(result.likely.scheduled.length, 2);
  assert.equal(result.pessimistic.scheduled.length, 1);
  assert.equal(result.likely.scheduled[1]!.startsAt, new Date(at(9)).toISOString());
  assert.ok(codes(result).includes("PESSIMISTIC_CONTIGUOUS_CAPACITY_EXCEEDED"));
});

test("indivisible tasks need one contiguous window; split work reserves resumption costs", () => {
  const data = shortInput(12);
  data.availability[0]!.windows = [window("w1", at(8), at(9)), window("w2", at(10), at(11))];
  const whole = validatePlan(data, [task("a", { durationEstimate: estimate(90) })], policy(0), now);
  assert.ok(codes(whole).includes("CONTIGUOUS_CAPACITY_EXCEEDED"));
  const split = validatePlan(data, [task("a", { durationEstimate: estimate(110), splittable: true, contextSwitchMinutes: 10 })], policy(0), now);
  assert.equal(split.feasibility, "feasible");
  assert.equal(split.likely.scheduled[0]!.allocations[0]!.overheadMinutes, 10);
  assert.equal(split.likely.scheduled[0]!.allocations[0]!.workMinutes, 110);
  const excessive = validatePlan(data, [task("a", { durationEstimate: estimate(120), splittable: true, contextSwitchMinutes: 10 })], policy(0), now);
  assert.equal(excessive.likely.issues[0]!.missingMinutes, 10);
});

test("waiting consumes elapsed time and delays dependents but does not occupy human work capacity", () => {
  const result = validatePlan(shortInput(), [task("a", { durationEstimate: estimate(30), waitMinutes: 60 }), task("b", { durationEstimate: estimate(60) }), task("c", { durationEstimate: estimate(30), dependencyTaskIds: ["a"] })], policy(0), now);
  assert.equal(result.feasibility, "feasible");
  assert.equal(result.likely.scheduled.find(item => item.taskId === "a")!.finishesAt, new Date(at(9, 30)).toISOString());
  assert.equal(result.likely.scheduled.find(item => item.taskId === "b")!.startsAt, new Date(at(8, 30)).toISOString());
  assert.equal(result.likely.scheduled.find(item => item.taskId === "c")!.startsAt, new Date(at(9, 30)).toISOString());
});

test("buffers cannot be consumed by implementation, matching submission can use reserved time", () => {
  const data = shortInput();
  const blocked = validatePlan(data, [task("a", { durationEstimate: estimate(210) })], policy(60), now);
  assert.ok(codes(blocked).includes("BUFFER_CAPACITY_EXCEEDED"));
  const allowed = validatePlan(data, [task("a", { durationEstimate: estimate(180) }), task("s", { kind: "submission", durationEstimate: estimate(60), dependencyTaskIds: ["a"] })], policy(60), now);
  assert.equal(allowed.feasibility, "feasible");
  assert.equal(allowed.likely.scheduled.find(item => item.taskId === "s")!.startsAt, new Date(at(11)).toISOString());
  assert.equal(allowed.likely.scheduled.find(item => item.taskId === "s")!.finishesAt, new Date(at(12)).toISOString());
});

test("multiple deadlines preserve every buffer and prioritize must work with its prerequisites", () => {
  const data = shortInput();
  data.deadlines.push({ ...data.deadlines[0]!, id: "register", kind: "registration", instantUtc: at(10) });
  const buffers = [...policy(30), { deadlineId: "register", reservedMinutes: 30, basis: "报名核对" }];
  const result = validatePlan(data, [task("optional", { priority: "optional", durationEstimate: estimate(120) }), task("pre", { priority: "optional", durationEstimate: estimate(60), deadlineRef: "register" }), task("must", { kind: "submission", durationEstimate: estimate(60), deadlineRef: "register", dependencyTaskIds: ["pre"] })], buffers, now);
  assert.deepEqual(result.likely.scheduled.slice(0, 2).map(item => item.taskId), ["pre", "must"]);
  assert.equal(result.likely.scheduled.find(item => item.taskId === "must")!.finishesAt, new Date(at(10)).toISOString());
  for (const scheduled of result.likely.scheduled.filter(item => item.taskId === "optional")) for (const allocation of scheduled.allocations) for (const segment of allocation.segments) assert.ok(Date.parse(segment.endsAt) <= Date.parse(at(9, 30)) || Date.parse(segment.startsAt) >= Date.parse(at(10)));
});

test("done tasks need acceptance, retain departed authors, and are never rescheduled", () => {
  const data = input();
  data.members[0] = { ...data.members[0]!, status: "left" };
  data.availability = data.availability.filter(item => item.membershipId !== "m1"); delete data.availabilityVersions.m1;
  const completed = task("done", { status: "done", updatedAt: at(7), acceptance: { acceptedByUserId: "u2", acceptedAt: at(7), mode: "reviewer", evidenceRefs: ["verified-demo"], note: "跑通" } });
  const result = validatePlan(data, [completed, task("next", { ownerMembershipId: "m2", reviewerMembershipId: "m2", dependencyTaskIds: ["done"] })], policy(), now);
  assert.equal(result.feasibility, "feasible");
  assert.deepEqual(result.likely.scheduled.map(item => item.taskId), ["next"]);
  assert.ok(codes(validatePlan(input(), [task("a", { status: "done" })], policy(), now)).includes("DONE_ACCEPTANCE_REQUIRED"));
});

test("blocked mandatory tasks and their chains are infeasible", () => {
  const result = validatePlan(input(), [task("a", { status: "blocked", blocker: "等待真实平台权限", remainingEstimate: estimate(30) }), task("b", { dependencyTaskIds: ["a"] })], policy(), now);
  assert.equal(result.structuralValid, true);
  assert.equal(result.feasibility, "infeasible");
  assert.ok(codes(result).includes("BLOCKED_TASK"));
  assert.deepEqual(result.likely.issues.find(item => item.code === "DEPENDENCY_UNSCHEDULED")!.chain, ["a", "b"]);
});

test("mandatory requirements, cancelled must tasks, current members and resource references are enforced", () => {
  const data = input(); data.requirements.push({ id: "video", deadlineRef: "submit", description: "演示视频", mandatory: true });
  assert.ok(codes(validatePlan(data, [task("a", { requirementRefs: ["video"], priority: "optional" })], policy(), now)).includes("MANDATORY_REQUIREMENT_OPTIONAL"));
  assert.ok(codes(validatePlan(input(), [task("a", { status: "cancelled", cancellationReason: "赶不上" })], policy(), now)).includes("MUST_TASK_CANCELLED"));
  assert.ok(codes(validatePlan(input(), [task("a", { ownerMembershipId: "team-captain" })], policy(), now)).includes("TASK_OWNER_INACTIVE"));
  assert.ok(codes(validatePlan(input(), [task("a", { resourceRefs: ["https://made-up.example"] })], policy(), now)).includes("RESOURCE_NOT_APPROVED"));
});

test("explicit required phases enforce learning, integration, testing and submission", () => {
  const data = input(); data.requiredTaskKinds = ["learning", "integration", "testing", "submission"];
  const result = validatePlan(data, [task()], policy(), now);
  assert.equal(result.issues.filter(item => item.code === "REQUIRED_TASK_KIND_MISSING").length, 4);
  const all = data.requiredTaskKinds.map((kind, index) => task(`phase-${index}`, { kind }));
  assert.equal(validatePlan(data, all, policy(), now).feasibility, "feasible");
});

test("unknown inputs and stale availability cannot produce a feasible conclusion", () => {
  const mutations: ((data: PlanningInput) => void)[] = [data => { data.deadlines[0]!.verified = false; }, data => { data.availability[0]!.confirmedAt = null; }, data => { data.availabilityVersions.m1 = 2; }, data => { data.assumptions = ["假设尚未确认截止点"]; }, data => { (data as unknown as Record<string, unknown>).requiredTaskKinds = undefined; }, data => { (data as unknown as Record<string, unknown>).availability = undefined; }, data => { data.deadlines[0]!.instantUtc = "周五晚上"; }];
  for (const mutate of mutations) { const data = input(); mutate(data); assert.equal(validatePlan(data, [task()], policy(), now).feasibility, "unknown"); }
  const data = input(); data.availabilityVersions.m1 = 2;
  assert.equal(validatePlan(data, [task()], policy(), now).staleInputs, true);
  assert.equal(validatePlan(input(), [task()], [], now).feasibility, "unknown");
});

test("remaining estimates replace original effort without erasing history", () => {
  const original = task("a", { durationEstimate: estimate(600), remainingEstimate: estimate(30), status: "in_progress" });
  const result = validatePlan(shortInput(9), [original], policy(0), now);
  assert.equal(result.feasibility, "feasible");
  assert.equal(result.likely.scheduled[0]!.allocations[0]!.workMinutes, 30);
  assert.equal(original.durationEstimate.likelyMinutes, 600);
});

test("runtime malformed JSON returns issues instead of throwing or claiming feasible", () => {
  const broken = [null, {}, { ...task(), helperEfforts: [null] }, { ...task(), dependencyTaskIds: undefined }, { ...task(), acceptanceCriteria: undefined }];
  for (const value of broken) assert.doesNotThrow(() => { assert.equal(validatePlan(input(), [value] as unknown as PlanningTask[], policy(), now).structuralValid, false); });
  assert.doesNotThrow(() => { assert.equal(validatePlan(null as unknown as PlanningInput, [], [], now).structuralValid, false); });
  assert.doesNotThrow(() => { assert.equal(validatePlan(input(), [], [], new Date("invalid")).structuralValid, false); });
  assert.doesNotThrow(() => { assert.equal(validatePlan(input(), undefined as unknown as PlanningTask[], policy(), now).structuralValid, false); });
});

test("scheduler output is deterministic and does not mutate caller snapshots", () => {
  const data = input(), tasks = [task("z"), task("a")], before = JSON.stringify({ data, tasks });
  const first = validatePlan(data, tasks, policy(), now);
  assert.deepEqual(first, validatePlan(data, tasks, policy(), now));
  assert.deepEqual(first.likely.scheduled.map(item => item.taskId), ["a", "z"]);
  assert.equal(JSON.stringify({ data, tasks }), before);
});

test("task startsAt reflects the first actual work window rather than dependency release", () => {
  const data = input(); data.availability[0]!.windows = [window("w1", at(10), at(12))];
  const result = validatePlan(data, [task()], policy(), now);
  assert.equal(result.likely.scheduled[0]!.startsAt, new Date(at(10)).toISOString());
});

test("done dependency acceptance must precede the accepted dependent", () => {
  const acceptance = (acceptedAt: string) => ({ acceptedByUserId: "u1", acceptedAt, mode: "manager" as const, evidenceRefs: ["verified"], note: "验收" });
  const result = validatePlan(input(), [task("pre", { status: "done", acceptance: acceptance(at(7, 30)) }), task("done", { status: "done", acceptance: acceptance(at(7)), dependencyTaskIds: ["pre"] })], policy(), now);
  assert.equal(result.structuralValid, false);
  assert.ok(codes(result).includes("DONE_DEPENDENCY_TIME_CONFLICT"));
});

test("child windows and availability collection must describe the same versioned fact", () => {
  const data = input(); data.availability[0]!.windows[0]!.version = 0;
  const result = validatePlan(data, [task()], policy(), now);
  assert.equal(result.staleInputs, true);
  assert.equal(result.feasibility, "unknown");
  assert.ok(codes(result).includes("STALE_AVAILABILITY_WINDOW_VERSION"));
});
