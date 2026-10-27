import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact, PersonalGenerationRequest } from "../../shared/personal-ai.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { createParticipationService } from "./service.ts";
import { participationOutputExample, validateParticipationPlan } from "./validation.ts";
import type { ParticipationContext, ParticipationEvent, ParticipationModelOutput, WeatherSnapshot } from "./types.ts";

const actor: Actor = { userId: "person-1", platformRoles: ["user"] };
const anotherActor: Actor = { userId: "person-2", platformRoles: ["user"] };
const now = "2026-10-09T00:00:00.000Z";
const transaction: SqlExecutor = { async query() { return { rows: [], rowCount: 0 }; } };

function profile(overrides: Partial<ParticipantProfile> = {}): ParticipantProfile {
  return {
    userId: actor.userId, revision: 1, firstHackathon: true, developmentExperience: "beginner", city: "北京",
    skills: ["TypeScript"], interests: ["公益"], projectIdea: "帮助新人整理报名事项", availableHoursPerDay: 2,
    travelPreference: "rail", presentationExperience: "none", updatedAt: now, ...overrides,
  };
}

function event(overrides: Partial<ParticipationEvent> = {}): ParticipationEvent {
  return {
    id: "event-1", title: "真实赛事线索", summary: "需核对完整规则的已保存线索", eventDate: "十月中旬，日期待核实",
    location: "北京", city: "北京", eventStartAt: "2026-10-15T01:00:00.000Z", mode: "offline",
    sourceUrl: "https://example.com/official-event", registrationUrl: "https://example.com/register",
    status: "unverified", fetchedAt: now, evidence: ["官网说明需要报名"], ...overrides,
  };
}

function forecast(): WeatherSnapshot {
  return {
    status: "available", provider: "open-meteo", requestedCity: "北京",
    location: { name: "Beijing", country: "China", admin1: "Beijing", latitude: 39.9, longitude: 116.4, timeZone: "Asia/Shanghai" },
    days: [{ date: "2026-10-15", weatherCode: 3, temperatureMinC: 13, temperatureMaxC: 22, precipitationProbabilityMax: 30, windSpeedMaxKmh: 15 }],
    fetchedAt: now, sourceUrl: "https://open-meteo.com/", note: "天气是预报，请出发前再次核对。",
  };
}

function modelOutput(mode: "online" | "offline" = "offline"): ParticipationModelOutput {
  const output = structuredClone(participationOutputExample);
  if (mode === "offline") {
    output.travel = {
      suggestions: ["建议核对当地交通与住宿后决定行程"],
      checklist: ["请确认入场地址并保存报名凭证"], weatherAdvice: ["建议临行前重新核对天气预报"],
    };
  }
  return output;
}

interface HarnessOptions {
  profile?: ParticipantProfile;
  event?: ParticipationEvent | null;
  output?: unknown;
  forecast?: WeatherSnapshot;
  weatherError?: Error;
  onEventRead?: () => Promise<void> | void;
  onWeatherRead?: () => Promise<void> | void;
  onAiValidated?: () => Promise<void> | void;
}

function harness(options: HarnessOptions = {}) {
  const calls = {
    profiles: [] as Array<{ actor: Actor; guard?: FreshSessionGuard }>,
    events: [] as string[],
    weather: [] as Array<{ city: string; eventStartAt: string; now: string }>,
    generate: [] as Array<{ actor: Actor; request: PersonalGenerationRequest<unknown>; guard?: FreshSessionGuard }>,
    list: [] as Array<{ actor: Actor; kind: string; guard?: FreshSessionGuard }>,
    get: [] as Array<{ actor: Actor; id: string; guard?: FreshSessionGuard }>,
  };
  const artifacts: PersonalArtifact[] = [];
  const ai: PersonalAiPort = {
    async generate<T>(requestedActor: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard): Promise<PersonalArtifact<T>> {
      calls.generate.push({ actor: requestedActor, request: request as PersonalGenerationRequest<unknown>, guard });
      await guard?.(transaction);
      const data = request.validate(options.output ?? modelOutput(options.event?.mode === "online" ? "online" : "offline"));
      await options.onAiValidated?.();
      await guard?.(transaction);
      const artifact: PersonalArtifact<T> = { id: `plan-${requestedActor.userId}`, kind: request.kind, title: request.title, data, createdAt: now, provider: "dsh", sessionId: `session-${requestedActor.userId}` };
      artifacts.push(artifact);
      return artifact;
    },
    async list(requestedActor, kind, guard) {
      calls.list.push({ actor: requestedActor, kind, guard });
      await guard?.(transaction);
      return artifacts.filter(value => value.id === `plan-${requestedActor.userId}` && value.kind === kind);
    },
    async get(requestedActor, id, guard) {
      calls.get.push({ actor: requestedActor, id, guard });
      await guard?.(transaction);
      const artifact = artifacts.find(value => value.id === id && value.id === `plan-${requestedActor.userId}`);
      if (!artifact) throw new DomainError("PERSONAL_ARTIFACT_NOT_FOUND", "记录不可访问。", { status: 404 });
      return artifact;
    },
  };
  const service = createParticipationService({
    ai,
    profiles: {
      async get(requestedActor, guard) {
        calls.profiles.push({ actor: requestedActor, guard });
        await guard?.(transaction);
        return structuredClone(options.profile ?? profile({ userId: requestedActor.userId }));
      },
    },
    events: {
      async get(id) {
        calls.events.push(id);
        await options.onEventRead?.();
        return options.event === null ? null : structuredClone(options.event ?? event());
      },
    },
    weather: {
      async getForecast(input) {
        calls.weather.push(input);
        await options.onWeatherRead?.();
        if (options.weatherError) throw options.weatherError;
        return structuredClone(options.forecast ?? forecast());
      },
    },
    clock: { now: () => new Date(now) },
  });
  return { service, calls, artifacts };
}

function invalidOutput(error: unknown): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "INVALID_PARTICIPATION_OUTPUT");
  return true;
}

async function validContext(overrides: Partial<ParticipationEvent> = {}): Promise<ParticipationContext> {
  return harness({ event: event(overrides) }).service.getContext(actor, "event-1");
}

test("context exposes actionable missing fields without invoking AI", async () => {
  const h = harness({ profile: profile({ firstHackathon: null, developmentExperience: null, city: "", availableHoursPerDay: null }) });
  const context = await h.service.getContext(actor, "event-1");
  assert.deepEqual(new Set(context.missingProfileFields), new Set(["firstHackathon", "developmentExperience", "city", "availableHoursPerDay"]));
  assert.match(context.profileHref, /^\//);
  assert.equal(h.calls.generate.length, 0);
});

for (const missing of [
  { firstHackathon: null }, { developmentExperience: null }, { city: "   " }, { availableHoursPerDay: null },
] satisfies Partial<ParticipantProfile>[]) {
  test(`generation rejects missing ${Object.keys(missing)[0]} before a billable request`, async () => {
    const h = harness({ profile: profile(missing) });
    await assert.rejects(h.service.generate(actor, { eventId: "event-1" }), error => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "PARTICIPANT_PROFILE_INCOMPLETE");
      assert.ok(error.recoveryAction);
      return true;
    });
    assert.equal(h.calls.generate.length, 0);
    assert.equal(h.artifacts.length, 0);
  });
}

test("context passes a fresh session guard through profile reads before and after remote work", async () => {
  let remoteRead = false;
  const checkpoints: boolean[] = [];
  const guard: FreshSessionGuard = async sql => { assert.equal(sql, transaction); checkpoints.push(remoteRead); };
  const h = harness({ onWeatherRead() { remoteRead = true; } });
  await h.service.getContext(actor, "event-1", guard);
  assert.ok(checkpoints.includes(false));
  assert.ok(checkpoints.includes(true), "permission must be checked again after weather resolves");
  assert.ok(h.calls.profiles.every(call => call.actor === actor && call.guard === guard));
});

test("revoking a session during remote context work prevents generation", async () => {
  let revoked = false;
  const guard: FreshSessionGuard = async () => {
    if (revoked) throw new DomainError("UNAUTHENTICATED", "会话已经失效。", { status: 401 });
  };
  const h = harness({ onWeatherRead() { revoked = true; } });
  await assert.rejects(h.service.generate(actor, { eventId: "event-1" }, guard), { code: "UNAUTHENTICATED" });
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.artifacts.length, 0);
});

test("permission is checked again after event reads even when no weather is needed", async () => {
  let revoked = false;
  const guard: FreshSessionGuard = async () => {
    if (revoked) throw new DomainError("UNAUTHENTICATED", "会话已经失效。", { status: 401 });
  };
  const h = harness({ event: event({ mode: "online" }), onEventRead() { revoked = true; } });
  await assert.rejects(h.service.getContext(actor, "event-1", guard), { code: "UNAUTHENTICATED" });
  assert.equal(h.calls.weather.length, 0);
});

test("profile changes during context work use the latest revision and disclose the change", async () => {
  const changingProfile = profile();
  const h = harness({
    profile: changingProfile,
    onWeatherRead() {
      changingProfile.revision = 2;
      changingProfile.firstHackathon = false;
      changingProfile.availableHoursPerDay = 3;
    },
  });
  const context = await h.service.getContext(actor, "event-1");
  assert.equal(context.profile.revision, 2);
  assert.equal(context.profile.firstHackathon, false);
  assert.equal(context.profile.availableHoursPerDay, 3);
  assert.match(context.notices.join(" "), /资料已更新/);
});

test("profile revision changed during AI generation rejects the stale result before adoption", async () => {
  const changingProfile = profile();
  const h = harness({
    profile: changingProfile,
    onAiValidated() { changingProfile.revision = 2; changingProfile.availableHoursPerDay = 1; },
  });
  await assert.rejects(h.service.generate(actor, { eventId: "event-1" }), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "PARTICIPANT_PROFILE_CHANGED");
    assert.equal(error.status, 409);
    assert.equal(error.latestRevision, 2);
    return true;
  });
  assert.equal(h.calls.generate.length, 1, "an already dispatched generation must not be replayed automatically");
  assert.equal(h.artifacts.length, 0, "the stale generation is not persisted as an adopted artifact");
});

test("revoking a session during AI generation prevents adopting the generated artifact", async () => {
  let revoked = false;
  const guard: FreshSessionGuard = async () => {
    if (revoked) throw new DomainError("UNAUTHENTICATED", "会话已经失效。", { status: 401 });
  };
  const h = harness({ onAiValidated() { revoked = true; } });
  await assert.rejects(h.service.generate(actor, { eventId: "event-1" }, guard), { code: "UNAUTHENTICATED" });
  assert.equal(h.calls.generate.length, 1);
  assert.equal(h.artifacts.length, 0);
});

test("missing event fails before model generation", async () => {
  const h = harness({ event: null });
  await assert.rejects(h.service.generate(actor, { eventId: "missing-event" }), error => error instanceof DomainError && error.status === 404);
  assert.equal(h.calls.generate.length, 0);
});

test("user supplements are labeled while the original event snapshot stays intact", async () => {
  const original = event();
  const h = harness({ event: original });
  const artifact = await h.service.generate(actor, {
    eventId: original.id, projectIdea: "做一份可核对报名的工具",
    supplement: { city: "上海", eventStartAt: "2026-10-16T01:00:00.000Z", mode: "hybrid" },
  });
  const plan = artifact.data;
  for (const key of Object.keys(original) as Array<keyof ParticipationEvent>) {
    assert.deepEqual(plan.context.event[key], original[key], `source field ${key} remains independent of supplements`);
  }
  assert.equal(plan.context.facts.city.value, "上海");
  assert.equal(plan.context.facts.city.origin, "user_supplement");
  assert.equal(plan.context.facts.eventStartAt.value, "2026-10-16T01:00:00.000Z");
  assert.equal(plan.context.facts.eventStartAt.origin, "user_supplement");
  assert.equal(plan.context.facts.mode.origin, "user_supplement");
  assert.equal(plan.projectIdea, "做一份可核对报名的工具");
  assert.equal(h.calls.weather[0]!.city, "上海");
  assert.equal(h.calls.generate[0]!.request.kind, "participation_plan");
});

for (const date of ["2026-10-16", "2026-10-16T09:00:00", "2026-02-30T09:00:00Z"]) {
  test(`ambiguous or impossible user date ${date} is rejected before AI`, async () => {
    const h = harness();
    await assert.rejects(h.service.generate(actor, { eventId: "event-1", supplement: { eventStartAt: date } }), error => error instanceof DomainError);
    assert.equal(h.calls.generate.length, 0);
  });
}

test("raw display date never becomes an exact weather or event instant", async () => {
  const h = harness({ event: event({ eventDate: "2026-10-15", eventStartAt: null }) });
  const context = await h.service.getContext(actor, "event-1");
  assert.equal(context.facts.eventStartAt.value, null);
  assert.equal(context.facts.eventStartAt.origin, "unknown");
  assert.equal(context.weather.status, "date_unknown");
  assert.deepEqual(context.weather.days, []);
  assert.equal(h.calls.weather.length, 0);
});

test("far future event has no invented forecast and does not call weather provider", async () => {
  const h = harness({ event: event({ eventStartAt: "2026-11-02T01:00:00.000Z" }) });
  const context = await h.service.getContext(actor, "event-1");
  assert.equal(context.weather.status, "outside_forecast_window");
  assert.deepEqual(context.weather.days, []);
  assert.equal(h.calls.weather.length, 0);
});

test("weather horizon includes today plus fifteen days but excludes the following day", async () => {
  const lastForecastDay = forecast();
  lastForecastDay.days[0]!.date = "2026-10-24";
  const within = harness({ event: event({ eventStartAt: "2026-10-24T01:00:00.000Z" }), forecast: lastForecastDay });
  assert.equal((await within.service.getContext(actor, "event-1")).weather.status, "available");
  assert.equal(within.calls.weather.length, 1);
  const outside = harness({ event: event({ eventStartAt: "2026-10-25T01:00:00.000Z" }), forecast: lastForecastDay });
  assert.equal((await outside.service.getContext(actor, "event-1")).weather.status, "outside_forecast_window");
  assert.equal(outside.calls.weather.length, 1, "near the boundary the destination timezone must be parsed before deciding");
});

test("online participation neither requests weather nor forces travel", async () => {
  const h = harness({ event: event({ mode: "online" }), output: modelOutput("online") });
  const artifact = await h.service.generate(actor, { eventId: "event-1" });
  assert.equal(artifact.data.context.weather.status, "not_needed");
  assert.equal(h.calls.weather.length, 0);
  assert.equal(artifact.data.travel.required, false);
  assert.deepEqual(artifact.data.travel.suggestions, []);
  assert.deepEqual(artifact.data.travel.checklist, []);
});

test("weather provider failure becomes an unavailable snapshot without blocking advice", async () => {
  const h = harness({ weatherError: new Error("private remote diagnostic") });
  const artifact = await h.service.generate(actor, { eventId: "event-1" });
  assert.equal(artifact.data.context.weather.status, "unavailable");
  assert.deepEqual(artifact.data.context.weather.days, []);
  assert.equal(JSON.stringify(artifact.data).includes("private remote diagnostic"), false);
});

test("a forecast for another day is not substituted for the actual event day", async () => {
  const mismatch = forecast();
  mismatch.days[0]!.date = "2026-10-14";
  const h = harness({ forecast: mismatch });
  const context = await h.service.getContext(actor, "event-1");
  assert.equal(context.weather.status, "unavailable");
  assert.deepEqual(context.weather.days, []);
});

test("an invalid or stale weather payload never becomes a trusted forecast", async () => {
  const snapshots = [forecast(), forecast(), forecast()];
  snapshots[0]!.fetchedAt = "2026-10-07T00:00:00.000Z";
  snapshots[1]!.days[0]!.precipitationProbabilityMax = 101;
  snapshots[2]!.sourceUrl = "https://fake.example/weather";
  for (const snapshot of snapshots) {
    const h = harness({ forecast: snapshot });
    const context = await h.service.getContext(actor, "event-1");
    assert.equal(context.weather.status, "unavailable");
    assert.deepEqual(context.weather.days, []);
  }
});

test("a profile belonging to another account is rejected before external work", async () => {
  const h = harness({ profile: profile({ userId: anotherActor.userId }) });
  await assert.rejects(h.service.generate(actor, { eventId: "event-1" }), { code: "FORBIDDEN" });
  assert.equal(h.calls.weather.length, 0);
  assert.equal(h.calls.generate.length, 0);
});

test("valid plan fixes task ownership, facts, forecast and verification URLs from server context", async () => {
  const h = harness();
  const artifact = await h.service.generate(actor, { eventId: "event-1" });
  const plan = artifact.data;
  assert.equal(artifact.provider, "dsh");
  assert.equal(plan.status, "draft");
  assert.equal(plan.scheduleBasis, "suggested_dates");
  assert.deepEqual(plan.context.weather, forecast());
  assert.equal(plan.estimatedTotalMinutes, 170);
  assert.deepEqual(plan.phases.map(phase => phase.kind), ["prepare", "build", "roadshow", "submit", "review"]);
  for (const task of plan.phases.flatMap(phase => phase.tasks)) {
    assert.equal(task.owner, "本人");
    assert.equal(task.ownerUserId, actor.userId);
    assert.match(task.plannedDate, /^2026-10-\d{2}$/);
  }
  assert.equal(plan.verification.find(check => check.kind === "registration")!.sourceUrl, event().registrationUrl);
  assert.ok(plan.verification.every(check => check.status === "needs_confirmation"));
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "artifact validation returns only JSON data");
  assert.match(plan.notices.join(" "), /截止/);
});

test("validation snapshot does not change when the live context is later mutated", async () => {
  const context = await validContext();
  const plan = validateParticipationPlan(modelOutput(), context, "参赛工具");
  context.event.title = "之后更新的标题";
  context.weather.days[0]!.temperatureMaxC = 999;
  context.profile.skills.push("later-added");
  assert.equal(plan.context.event.title, "真实赛事线索");
  assert.equal(plan.context.weather.days[0]!.temperatureMaxC, 22);
  assert.deepEqual(plan.context.profile.skills, ["TypeScript"]);
});

for (const goal of [
  "已核对官方报名要求并记录结果",
  "已核实报名要求并整理待确认条款",
  "已确认报名规则并记录来源",
  "报名规则核对已完成",
  "已确认是否收费并记录核对结果",
  "已确认入场材料清单",
  "已备份演示和制作材料",
  "已确认作品提交方式并整理材料",
  "已核实比赛地点信息并记录官方说明",
  "已核对是否满足报名资格并保存核对记录",
]) {
  test(`future acceptance goal allows completed preparation wording: ${goal}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    output.phases[0]!.tasks[0]!.acceptance = [goal];
    const plan = validateParticipationPlan(output, context, "参赛工具");
    assert.deepEqual(plan.phases[0]!.tasks[0]!.acceptance, [goal]);
    assert.equal(plan.status, "draft");
    assert.ok(plan.verification.every(check => check.status === "needs_confirmation"));
    assert.match(plan.notices.join(" "), /验收条件.*任务完成后.*不表示.*已经/);
  });
}

for (const claim of [
  "报名已成功", "已报名成功", "本人已符合参赛资格", "已确认本人具备参赛资格",
  "资格已确认", "支付已完成", "已购票", "已提交并取得成功回执", "作品提交已成功",
  "已确认是否收费并确认报名成功", "已核对规则；报名已成功",
  "已确认天气晴朗", "已查看天气预报当天有雨", "气温为 25℃", "已核实费用为 100 元",
  "已确认作品提交截止为 2026-10-20", "已保存 https://fake.example/ 的成功回执",
]) {
  test(`future acceptance goals still reject unsupported outcomes: ${claim}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    output.phases[0]!.tasks[0]!.acceptance = [claim];
    assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
  });
}

test("completed future checking wording is permitted only in task acceptance goals", async () => {
  const context = await validContext();
  const output = modelOutput();
  output.assumptions = ["已核实比赛地点信息并记录官方说明"];
  assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
});

for (const field of ["context", "event", "weather", "sourceUrl", "eventStartAt", "registrationFee"]) {
  test(`model factual ${field} metadata is never adopted`, async () => {
    const context = await validContext();
    const output = { ...modelOutput(), [field]: "fabricated" };
    const plan = validateParticipationPlan(output, context, "参赛工具");
    assert.deepEqual(plan, validateParticipationPlan(modelOutput(), context, "参赛工具"));
  });
}

test("extra metadata at every output boundary cannot replace server identity, dates, facts or status", async () => {
  const context = await validContext();
  const output = modelOutput();
  const baseline = validateParticipationPlan(output, context, "参赛工具");
  Object.assign(output, { context: { profile: { userId: anotherActor.userId } }, notices: ["fabricated"], estimatedTotalMinutes: 1 });
  for (const phase of output.phases) {
    Object.assign(phase, { id: "fake-phase", startDate: "2099-01-01", endDate: "2099-01-02", summary: "fabricated" });
    for (const task of phase.tasks) Object.assign(task, { id: "fake-task", owner: "管理员", ownerUserId: anotherActor.userId, plannedDate: "2099-01-01" });
  }
  Object.assign(output.travel, { required: false, reason: "fabricated", weather: { temperature: 100 } });
  for (const risk of output.risks) Object.assign(risk, { probability: 100 });
  for (const check of output.verification) Object.assign(check, { status: "confirmed", sourceUrl: "https://fake.example/", confirmedAt: now });
  Object.assign(output.roadshow, { officialDurationSeconds: 999, speakerUserId: anotherActor.userId });
  assert.deepEqual(validateParticipationPlan(output, context, "参赛工具"), baseline);
});

for (const phaseIndex of [0, 1, 2, 3, 4]) {
  test(`empty task list in phase ${phaseIndex + 1} is rejected even with explanatory metadata`, async () => {
    const context = await validContext();
    const output = modelOutput();
    const phase = output.phases[phaseIndex]!;
    const task = phase.tasks[0]!;
    phase.tasks = [];
    Object.assign(phase, { explanation: "信息需要核对", items: [task], startDate: "2099-01-01" });
    assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
  });
}

test("metadata projection does not substitute aliases for required tasks or required task fields", async () => {
  const context = await validContext();
  const missingTasks = modelOutput();
  const phase = missingTasks.phases[0]! as unknown as Record<string, unknown>;
  phase.items = phase.tasks;
  delete phase.tasks;
  assert.throws(() => validateParticipationPlan(missingTasks, context, "参赛工具"), invalidOutput);
  const missingMinutes = modelOutput();
  const task = missingMinutes.phases[0]!.tasks[0]! as unknown as Record<string, unknown>;
  task.minutes = task.durationMinutes;
  delete task.durationMinutes;
  assert.throws(() => validateParticipationPlan(missingMinutes, context, "参赛工具"), invalidOutput);
});

test("whole response is bounded and JSON-compatible before metadata projection", async () => {
  const context = await validContext();
  const oversized = Object.assign(modelOutput(), { unused: "x".repeat(100_000) });
  assert.throws(() => validateParticipationPlan(oversized, context, "参赛工具"), invalidOutput);
  const cyclic = Object.assign(modelOutput(), { unused: {} as Record<string, unknown> });
  cyclic.unused.self = cyclic;
  assert.throws(() => validateParticipationPlan(cyclic, context, "参赛工具"), invalidOutput);
});

for (const claim of [
  "请访问 https://fake.example/ 报名", "确定在 2026-10-16 开赛", "票价为 100 元", "预计当天为晴天",
  "气温为 25℃", "降雨概率为 90%", "报名已确认", "保证成功入场",
]) {
  test(`AI advice rejects unsupported factual claim: ${claim}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    output.assumptions = [claim];
    assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
  });
}

for (const change of [
  { label: "negative day", patch: { dayOffset: -1 } },
  { label: "fractional day", patch: { dayOffset: 0.5 } },
  { label: "more than ninety days", patch: { dayOffset: 91 } },
  { label: "too short task", patch: { durationMinutes: 4 } },
  { label: "fractional minutes", patch: { durationMinutes: 15.5 } },
  { label: "too long task", patch: { durationMinutes: 481 } },
]) {
  test(`task validation rejects ${change.label}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    Object.assign(output.phases[0]!.tasks[0]!, change.patch);
    assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
  });
}

test("all same-day work is summed before comparing the person's daily capacity", async () => {
  const context = await validContext();
  context.profile.availableHoursPerDay = 2;
  const output = modelOutput();
  for (const phase of output.phases) phase.tasks[0]!.dayOffset = 0;
  assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
});

test("known submission deadline prevents pre-submission tasks being scheduled late", async () => {
  const context = await validContext({ submissionDeadline: "2026-10-11T12:00:00.000Z" });
  assert.throws(() => validateParticipationPlan(modelOutput(), context, "参赛工具"), invalidOutput);
});

test("an already passed source submission deadline is rejected before charging AI", async () => {
  const h = harness({ event: event({ submissionDeadline: now }) });
  await assert.rejects(h.service.generate(actor, { eventId: "event-1" }), { code: "PARTICIPATION_DEADLINE_PASSED" });
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.artifacts.length, 0);
});

test("unknown submission deadline remains unknown in saved plan", async () => {
  const context = await validContext({ submissionDeadline: null });
  const plan = validateParticipationPlan(modelOutput(), context, "参赛工具");
  assert.equal(plan.context.facts.submissionDeadline.value, null);
  assert.equal(plan.context.facts.submissionDeadline.origin, "unknown");
  assert.match(plan.notices.join(" "), /截止/);
});

test("phase order and required verification categories cannot silently be skipped", async () => {
  const context = await validContext();
  const reordered = modelOutput();
  [reordered.phases[0], reordered.phases[1]] = [reordered.phases[1]!, reordered.phases[0]!];
  assert.throws(() => validateParticipationPlan(reordered, context, "参赛工具"), invalidOutput);
  const missingFees = modelOutput();
  missingFees.verification = missingFees.verification.filter(check => check.kind !== "fees");
  assert.throws(() => validateParticipationPlan(missingFees, context, "参赛工具"), invalidOutput);
});

test("a later phase cannot start before the previous phase", async () => {
  const context = await validContext();
  const output = modelOutput();
  output.phases[2]!.tasks[0]!.dayOffset = 0;
  assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
});

test("a plan with more than forty tasks is rejected even if each day fits capacity", async () => {
  const context = await validContext();
  const output = modelOutput();
  for (let phaseIndex = 0; phaseIndex < output.phases.length; phaseIndex++) {
    const phase = output.phases[phaseIndex]!;
    const template = phase.tasks[0]!;
    phase.tasks = Array.from({ length: 9 }, (_, index) => ({ ...template, dayOffset: phaseIndex * 9 + index, durationMinutes: 5 }));
  }
  assert.throws(() => validateParticipationPlan(output, context, "参赛工具"), invalidOutput);
});

test("online advice cannot sneak in an unwanted travel checklist", async () => {
  const context = await validContext({ mode: "online" });
  assert.throws(() => validateParticipationPlan(modelOutput("offline"), context, "参赛工具"), invalidOutput);
});

test("list and get delegate the requesting account and guard to personal storage", async () => {
  const checkpoints: SqlExecutor[] = [];
  const guard: FreshSessionGuard = async sql => { checkpoints.push(sql); };
  const h = harness();
  const own = await h.service.generate(actor, { eventId: "event-1" }, guard);
  assert.equal(typeof h.calls.generate[0]!.guard, "function", "generation adds a current profile revision check to the session guard");
  assert.equal(h.calls.generate[0]!.actor, actor);
  assert.deepEqual(await h.service.list(anotherActor, guard), []);
  await assert.rejects(h.service.get(anotherActor, own.id, guard), { code: "PERSONAL_ARTIFACT_NOT_FOUND" });
  assert.deepEqual(await h.service.list(actor, guard), [own]);
  assert.deepEqual(await h.service.get(actor, own.id, guard), own);
  assert.deepEqual(h.calls.list.map(call => call.kind), ["participation_plan", "participation_plan"]);
  assert.ok(h.calls.list.every(call => call.guard === guard));
  assert.equal(h.calls.get[0]!.actor, anotherActor);
  assert.equal(h.calls.get[0]!.id, own.id);
  assert.equal(h.calls.get[0]!.guard, guard);
  assert.ok(checkpoints.length > 0 && checkpoints.every(sql => sql === transaction));
});

for (const claim of [
  "参赛者必须为在校大学生；现场提供住宿。",
  "预计开赛日晴朗，出行穿短袖即可。",
  "比赛在十月十六日开幕。",
  "建议核对报名，现场提供住宿。",
  "建议准备材料；参赛资格已经确认。",
  "建议周五开赛前出发。",
  "建议准备 PPT，报名资格已核实。",
  "建议带好设备，天气预计有雨。",
]) {
  test(`narrative advice cannot introduce unsupported facts: ${claim}`, async () => {
    const context = await validContext({ city: null, eventStartAt: null });
    const output = modelOutput();
    output.assumptions = [claim];
    assert.throws(() => validateParticipationPlan(output, context, "小型作品"), invalidOutput);
  });
}

test("weather advice stays conditional even when forecast is unknown", async () => {
  const context = await validContext({ city: null, eventStartAt: null });
  const output = modelOutput();
  output.travel.weatherAdvice = ["若临行预报有降雨，请准备雨具并重新核对交通状况"];
  assert.deepEqual(validateParticipationPlan(output, context, "小型作品").travel.weatherAdvice, output.travel.weatherAdvice);
});

for (const preparation of [
  "建议携带雨具，以应对可能降雨",
  "请准备防雨袋，防范突发大雨影响设备",
  "准备饮水，避免高温带来的不适",
  "携带外套。防范低温导致的不适，并保留交通缓冲。",
  "如果当天下雨，携带雨具并保护设备",
  "准备设备备份；如果临行预报显示有雨，做好防雨准备",
  "出行前核对当天是否有雨，并按实际预报调整装备",
  "出行前查看当天高温预警，准备饮水",
  "若临行预报预计有大风，核对交通运行信息",
]) {
  test(`practical weather preparation is not rejected for natural wording: ${preparation}`, async () => {
    const context = await validContext({ city: null, eventStartAt: null });
    const output = modelOutput();
    output.travel.weatherAdvice = [preparation];
    assert.deepEqual(validateParticipationPlan(output, context, "小型作品").travel.weatherAdvice, [preparation]);
  });
}

for (const claim of [
  "携带雨具。当天有雨。",
  "建议携带外套，预计当地低温",
  "保护设备，因为当天会下雨",
  "准备防晒用品，天气晴朗",
  "若有雨就携带雨具；天气将保持晴朗。",
  "请查看天气，预报显示当天有大雨",
  "建议携带雨具，因为可能有雨",
  "出行携带雨具，降雨将持续",
  "携带雨具，降雨概率为 80%",
  "准备衣物，气温为 24℃",
]) {
  test(`unsafe optional weather reminder is omitted without discarding safe tasks: ${claim}`, async () => {
    const context = await validContext({ city: null, eventStartAt: null });
    const output = modelOutput();
    output.travel.weatherAdvice = [claim];
    const plan = validateParticipationPlan(output, context, "小型作品");
    assert.deepEqual(plan.travel.weatherAdvice, []);
    assert.equal(plan.phases.length, 5);
    assert.equal(plan.phases[0]!.tasks[0]!.title, output.phases[0]!.tasks[0]!.title);
    assert.deepEqual(plan.context.weather, context.weather);
    assert.match(plan.notices.join(" "), /天气提醒.*省略.*真实预报/);
    assert.equal(JSON.stringify(plan).includes(claim), false);
  });
}

test("mixed optional weather reminders adopt only valid items and preserve the real forecast", async () => {
  const context = await validContext();
  const output = modelOutput();
  const safe = ["携带雨具，以应对可能降雨", "出行前核对实际天气预报"];
  const unsafe = ["预计当天晴朗", "气温为 24℃", "请在 2026-10-16 前查看天气", "请访问 https://fake.example/weather", "报名免费"];
  output.travel.weatherAdvice = [safe[0]!, ...unsafe, safe[1]!];
  const plan = validateParticipationPlan(output, context, "小型作品");
  assert.deepEqual(plan.travel.weatherAdvice, safe);
  assert.deepEqual(plan.context.weather, forecast());
  assert.equal(plan.notices.filter(note => /天气提醒.*省略/.test(note)).length, 1);
  for (const rejected of unsafe) assert.equal(JSON.stringify(plan).includes(rejected), false);
});

test("safe optional weather reminders add no omission notice", async () => {
  const context = await validContext();
  const plan = validateParticipationPlan(modelOutput(), context, "小型作品");
  assert.equal(plan.notices.some(note => /天气提醒.*省略/.test(note)), false);
});

for (const malformed of [null, "携带雨具", [null], [{ text: "携带雨具" }], [" "], ["字".repeat(801)], ["准备\u0000雨具"], Array.from({ length: 13 }, () => "携带雨具")]) {
  test(`malformed optional weather advice remains a hard validation failure: ${JSON.stringify(malformed).slice(0, 50)}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    (output.travel as unknown as { weatherAdvice: unknown }).weatherAdvice = malformed;
    assert.throws(() => validateParticipationPlan(output, context, "小型作品"), invalidOutput);
  });
}

test("online plans cannot bypass empty travel requirements by filtering unsafe weather reminders", async () => {
  const context = await validContext({ mode: "online" });
  const output = modelOutput("online");
  output.travel.weatherAdvice = ["预计当天有雨"];
  assert.throws(() => validateParticipationPlan(output, context, "小型作品"), invalidOutput);
});

for (const field of ["travel", "risk", "verification", "task"] as const) {
  test(`omitting optional weather does not weaken ${field} validation`, async () => {
    const context = await validContext();
    const output = modelOutput();
    output.travel.weatherAdvice = ["预计当天晴朗"];
    if (field === "travel") output.travel.suggestions = ["票价为 100 元"];
    if (field === "risk") output.risks[0]!.mitigation = "天气将保持晴朗";
    if (field === "verification") output.verification[0]!.action = "报名已确认";
    if (field === "task") output.phases[0]!.tasks[0]!.durationMinutes = 481;
    assert.throws(() => validateParticipationPlan(output, context, "小型作品"), invalidOutput);
  });
}

test("actionable multi-sentence suggestions need no repeated fixed prefixes", async () => {
  const context = await validContext();
  const output = modelOutput();
  output.roadshow.rehearsalChecklist = ["提前排练主流程。保存一份离线录屏，并记录演示失败时的讲解步骤。"];
  output.risks[0]!.fallback = "缩减非必需功能。保留可验证的主流程和录屏备份。";
  const plan = validateParticipationPlan(output, context, "小型作品");
  assert.deepEqual(plan.roadshow.rehearsalChecklist, output.roadshow.rehearsalChecklist);
  assert.equal(plan.risks[0]!.fallback, output.risks[0]!.fallback);
});

for (const action of [
  "请核对费用是否免费",
  "请确认报名是否已经成功",
  "请核对场地是否提供免费住宿",
  "核对现场是否提供住宿，以及费用有无说明",
  "请查阅赛事是否允许使用 AI 工具",
  "查看参赛者是否必须为在校大学生",
  "请核对比赛在何地举办",
  "如果报名免费，仍需核对资格与报名窗口",
  "报名是否成功尚待核对。查看邮箱回执并联系主办方。",
  "报名费用待确定，核对官方条款后再准备预算",
  "住宿条件尚未确定，联系主办方核对",
]) {
  test(`verification questions do not assert completed operations or official terms: ${action}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    output.verification[0]!.action = action;
    assert.equal(validateParticipationPlan(output, context, "小型作品").verification[0]!.action, action);
  });
}

for (const claim of [
  "建议看原文，报名免费",
  "请核对要求；资格已确定",
  "请核对费用是否免费，报名免费",
  "请确认报名是否已成功，而且参赛资格已经确认",
  "核对场地是否提供住宿；现场提供免费住宿",
  "请查看赛事是否允许 AI 工具，同时官方确认参赛资格",
  "如果报名免费，请准备材料；住宿免费",
  "请核对报名已经成功",
]) {
  test(`a verification question cannot excuse a separate unsupported claim: ${claim}`, async () => {
    const context = await validContext();
    const output = modelOutput();
    output.verification[0]!.action = claim;
    assert.throws(() => validateParticipationPlan(output, context, "小型作品"), invalidOutput);
  });
}

test("display timezone does not preclude a destination's valid final forecast day", async () => {
  const snapshot = forecast();
  snapshot.location = { name: "Honolulu", country: "United States", admin1: "Hawaii", latitude: 21.3, longitude: -157.8, timeZone: "Pacific/Honolulu" };
  snapshot.days[0]!.date = "2026-10-24";
  // Fixed now is 10/8 in Hawaii. Use 10/24 local event only when today's local day is 10/9.
  const laterClock = { now: () => new Date("2026-10-09T12:00:00.000Z") };
  let weatherCalls = 0;
  snapshot.fetchedAt = laterClock.now().toISOString();
  const service = createParticipationService({
    ai: { generate: async () => { throw new Error("not used"); }, list: async () => [], get: async () => { throw new Error("not used"); } },
    profiles: { get: async () => profile() }, events: { get: async () => event({ city: "Honolulu", eventStartAt: "2026-10-25T01:00:00.000Z" }) },
    weather: { getForecast: async () => { weatherCalls++; return snapshot; } }, clock: laterClock,
  });
  const context = await service.getContext(actor, "event-1");
  assert.equal(context.planningTimeZone, "Asia/Shanghai");
  assert.equal(context.weather.status, "available");
  assert.equal(context.weather.days[0]!.date, "2026-10-24");
  assert.equal(weatherCalls, 1);
});

test("profile contract hours and project idea length remain usable for generation", async () => {
  const idea = "想".repeat(4000);
  const h = harness({ profile: profile({ availableHoursPerDay: 24, projectIdea: idea }) });
  const artifact = await h.service.generate(actor, { eventId: "event-1" });
  assert.equal(artifact.data.projectIdea.length, 4000);
  assert.deepEqual(artifact.data.context.missingProfileFields, []);
  assert.equal(artifact.data.context.profileHref, "/app/account#participant-profile");
  assert.equal(h.calls.generate[0]!.request.promptVersion, "participation-plan-v7");
  assert.match(h.calls.generate[0]!.request.systemPrompt, /priority.*must.*optional/);
  assert.match(h.calls.generate[0]!.request.systemPrompt, /tasks 必须有实际任务，绝不能是空数组/);
});

test("generation request identity excludes transient reads while retaining semantic inputs", async () => {
  const h = harness();
  const supplement = { city: "上海", eventStartAt: "2026-10-16T01:00:00.000Z", mode: "hybrid" as const };
  await h.service.generate(actor, { eventId: "event-1", projectIdea: "自己的项目想法", supplement });
  const request = h.calls.generate[0]!.request;
  const identity = request.requestIdentity as { event: ParticipationEvent; profileRevision: number; projectIdea: string; supplement: typeof supplement };
  assert.equal(identity.profileRevision, 1);
  assert.equal(identity.projectIdea, "自己的项目想法");
  assert.deepEqual(identity.supplement, supplement);
  assert.equal("fetchedAt" in identity.event, false);
  assert.equal(identity.event.sourceUrl, event().sourceUrl);
  assert.deepEqual(identity.event.evidence, event().evidence);
  assert.deepEqual(Object.keys(identity).sort(), ["event", "profileRevision", "projectIdea", "supplement"]);
  assert.equal((request.input as { context: ParticipationContext }).context.currentTime, now);
  assert.equal((request.input as { context: ParticipationContext }).context.event.fetchedAt, now);
});
