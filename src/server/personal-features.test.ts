import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./database.ts";
import { createApplication, type Application } from "./application.ts";
import { dispatch } from "./router.ts";
import type { ApplicationConfig } from "./config.ts";
import type { DshAccountSession } from "./personal-workspace.ts";
import type { ParticipantProfile } from "../shared/participant.ts";
import type { ParticipationContext } from "../modules/participation/index.ts";
import { PPT_TEMPLATES, PPT_TOOLS } from "../modules/ppt/index.ts";
import { ROADSHOW_EXAMPLES, ROADSHOW_REMINDERS } from "../modules/roadshow/index.ts";

const localOrigin = "http://localhost:3000";
const publicOrigin = "https://public-login.example.test";

async function fixture(config: Partial<ApplicationConfig> = {}) {
  // No localPath and no connectionString: each test owns a new ephemeral PGlite.
  const database = await createDatabase({});
  const application = await createApplication({ mode: "local", origin: localOrigin,
    codePepper: "personal-http-integration-only-pepper-32-bytes", emailFrom: "test@localhost.invalid", ...config }, database);
  return { application, database };
}

async function request<T = unknown>(app: Application, path: string, method = "GET", body?: unknown, cookie?: string, status = 200, requestOrigin = app.config.origin) {
  const headers = new Headers({ origin: requestOrigin, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  const response = await dispatch(app, new Request(`${app.config.origin}/api/v1/${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split("?", 1)[0]!.split("/"));
  const envelope = await response.json() as { data: T; error?: { code: string; message: string; latestRevision?: number } };
  // Deliberately never include request bodies, challenge codes or cookies in failures.
  assert.equal(response.status, status, `${method} ${path}: ${envelope.error?.code ?? "unexpected status"}`);
  return { data: envelope.data, error: envelope.error, response };
}

async function authenticate(app: Application, email: string, displayName?: string) {
  const kind = displayName === undefined ? "login" : "registration";
  const body = displayName === undefined ? { email } : { email, displayName };
  const challenge = (await request<{ challengeId: string }>(app, `auth/${kind}-challenges`, "POST", body)).data;
  const mail = await app.database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
  const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
  assert.ok(Boolean(code), "in-memory local transport produced a challenge");
  const verified = await request<{ profile: { id: string; displayName: string | null }; returnTo: string }>(app,
    `auth/${kind}-challenges/verify`, "POST", { challengeId: challenge.challengeId, code, returnTo: "/events" });
  const cookie = verified.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(Boolean(cookie), "successful verification sets an HttpOnly website session");
  assert.equal(verified.data.returnTo, "/events");
  return { cookie: cookie!, userId: verified.data.profile.id, displayName: verified.data.profile.displayName,
    replay: () => request(app, `auth/${kind}-challenges/verify`, "POST", { challengeId: challenge.challengeId, code }, undefined, 401) };
}

function profileInput(expectedRevision = 0) {
  return { expectedRevision, firstHackathon: true, developmentExperience: "beginner", city: "成都", skills: ["React"],
    interests: ["生活工具"], projectIdea: "整理一份可人工确认的会议行动卡", availableHoursPerDay: 3,
    travelPreference: "rail", presentationExperience: "none" };
}

async function saveEvent(app: Application) {
  const now = app.clock.now().toISOString();
  const startsOn = new Date(app.clock.now().getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const evidence = `黑客松比赛于 ${startsOn} 在上海开赛，详细会场与报名截止请查看原文。`;
  return app.discoveries.save({ canonicalUrl: "https://example.com/hackathon", title: "HTTP 测试黑客松", summary: "有来源的赛事分析快照",
    analysis: { fit: ["可尝试小范围作品"], risks: ["地点与规则仍需核对"], preparation: ["预留演示时间"], unknowns: ["报名截止待核实"] },
    sources: [{ url: "https://example.com/hackathon", title: "赛事原文", excerpt: evidence, fetchedAt: now }],
    discoveredAt: now, lastAnalyzedAt: now, provider: "dsh", registration: null,
    eventWindow: { status: "future", startsAt: null, startsOn, evidence: [evidence], checkedAt: now } });
}

async function noGeneration(app: Application, existingArtifactJobs = 0) {
  assert.equal((await app.database.query("SELECT id FROM ai_execution_jobs WHERE kind='personal_artifact'")).rowCount, existingArtifactJobs);
  assert.equal((await app.database.query("SELECT id FROM ai_usage_attempts")).rowCount, 0);
}

test("HTTP registration consumes its code once, saves the nickname, and allocates stable account-scoped DSH sessions", async () => {
  const { application: app, database } = await fixture();
  try {
    const alice = await authenticate(app, "personal-alice@example.test", "首赛新人");
    const bob = await authenticate(app, "personal-bob@example.test", "另一位选手");
    assert.equal(alice.displayName, "首赛新人");
    assert.equal((await request<{ profile: { displayName: string } }>(app, "me", "GET", undefined, alice.cookie)).data.profile.displayName, "首赛新人");
    await alice.replay();
    const first = (await request<DshAccountSession>(app, "me/dsh-session", "GET", undefined, alice.cookie)).data;
    const second = (await request<DshAccountSession>(app, "me/dsh-session", "GET", undefined, alice.cookie)).data;
    const other = (await request<DshAccountSession>(app, "me/dsh-session", "GET", undefined, bob.cookie)).data;
    assert.equal(first.id, second.id);
    assert.notEqual(first.id, other.id);
    assert.equal(first.provider, "dsh");
    assert.equal(first.busy, false);
    assert.equal((await database.query("SELECT id FROM personal_dsh_sessions")).rowCount, 2);

    const empty = (await request<ParticipantProfile>(app, "me/participant-profile", "GET", undefined, alice.cookie)).data;
    assert.equal(empty.userId, alice.userId); assert.equal(empty.revision, 0);
    const updated = (await request<ParticipantProfile>(app, "me/participant-profile", "PATCH", profileInput(), alice.cookie)).data;
    assert.equal(updated.userId, alice.userId); assert.equal(updated.revision, 1); assert.equal(updated.firstHackathon, true);
    const conflict = await request(app, "me/participant-profile", "PATCH", profileInput(), alice.cookie, 409);
    assert.equal(conflict.error?.code, "PARTICIPANT_PROFILE_CHANGED");
    const otherProfile = (await request<ParticipantProfile>(app, "me/participant-profile", "GET", undefined, bob.cookie)).data;
    assert.equal(otherProfile.userId, bob.userId); assert.equal(otherProfile.city, ""); assert.equal(otherProfile.revision, 0);
    await request(app, "me/participant-profile", "PATCH", { ...profileInput(1), userId: bob.userId }, alice.cookie, 422);

    const artifactId = randomUUID();
    await database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,created_at,updated_at) VALUES($1,'personal_artifact',$1,1,$2,$3,'succeeded',now(),now())",
      [artifactId, `navigator-user:${alice.userId}`, alice.userId]);
    await database.query("INSERT INTO personal_ai_artifacts(id,user_id,session_id,kind,title,data,created_at) VALUES($1,$2,$3,'roadshow','私人路演记录',$4::jsonb,now())",
      [artifactId, alice.userId, first.id, JSON.stringify({ input: { projectIdea: "仅 Alice 可读" } })]);
    assert.equal((await request<{ id: string }>(app, `me/artifacts/${artifactId}`, "GET", undefined, alice.cookie)).data.id, artifactId);
    await request(app, `me/artifacts/${artifactId}`, "GET", undefined, bob.cookie, 404);
    assert.deepEqual((await request(app, "me/artifacts?kind=roadshow", "GET", undefined, bob.cookie)).data, []);
    const own = (await request<{ id: string }[]>(app, "me/artifacts?kind=roadshow", "GET", undefined, alice.cookie)).data;
    assert.deepEqual(own.map(item => item.id), [artifactId]);
    await noGeneration(app, 1);
    await request(app, "auth/logout", "POST", {}, alice.cookie);
    await request(app, "me/dsh-session", "GET", undefined, alice.cookie, 401);
    const later = new Date(app.clock.now().getTime() + 61_000);
    app.clock.now = () => later;
    const returning = await authenticate(app, "personal-alice@example.test");
    assert.equal(returning.userId, alice.userId);
    assert.equal(returning.displayName, "首赛新人");
    assert.equal((await request<DshAccountSession>(app, "me/dsh-session", "GET", undefined, returning.cookie)).data.id, first.id);
    assert.equal((await database.query("SELECT id FROM personal_dsh_sessions")).rowCount, 2);
  } finally { await database.close(); }
});

test("new personal HTTP routes reject anonymous access and cross-origin mutations before generating or saving", async () => {
  const { application: app, database } = await fixture();
  try {
    for (const [path, method] of [
      ["me/dsh-session", "GET"], ["me/participant-profile", "GET"], ["me/participant-profile", "PATCH"],
      ["me/artifacts?kind=ppt", "GET"], ["me/artifacts/someone-elses-artifact", "GET"],
      ["me/participation/context?eventId=unknown", "GET"], ["me/participation/plans", "POST"],
      ["me/roadshow/scripts", "POST"], ["me/ppt/outlines", "POST"],
      ["navigator/conversation", "GET"], ["navigator/conversation", "DELETE"],
    ]) await request(app, path!, method!, method === "GET" ? undefined : {}, undefined, 401);
    const signedIn = await authenticate(app, "origin-guard@example.test");
    for (const [path, method] of [["me/participant-profile", "PATCH"], ["me/participation/plans", "POST"],
      ["me/roadshow/scripts", "POST"], ["me/ppt/outlines", "POST"], ["navigator/conversation", "DELETE"]]) {
      const response = await request(app, path!, method!, {}, signedIn.cookie, 403, "https://untrusted.example.test");
      assert.equal(response.error?.code, "ORIGIN_FORBIDDEN");
    }
    await noGeneration(app);
    assert.equal((await database.query("SELECT user_id FROM participant_profiles")).rowCount, 0);
  } finally { await database.close(); }
});

test("saved event context keeps source facts and profile separate, with no invented city, exact time or weather; invalid input never calls DSH", async () => {
  const { application: app, database } = await fixture();
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw new Error("unexpected external request from isolated HTTP fixture"); };
  try {
    const member = await authenticate(app, "context-reader@example.test");
    const saved = await saveEvent(app);
    const before = (await request<ParticipationContext>(app, `me/participation/context?eventId=${saved.id}`, "GET", undefined, member.cookie)).data;
    assert.equal(before.event.id, saved.id);
    assert.equal(before.event.sourceUrl, "https://example.com/hackathon");
    assert.equal(before.event.status, "unverified");
    assert.equal(before.event.registrationUrl, null);
    assert.ok(before.event.evidence?.[0]?.includes("上海"));
    assert.equal(before.facts.city.value, null); assert.equal(before.facts.city.origin, "unknown");
    assert.equal(before.facts.eventStartAt.value, null, "a source date without time zone is not promoted to an exact instant");
    assert.equal(before.weather.status, "city_unknown"); assert.deepEqual(before.weather.days, []);
    assert.deepEqual(new Set(before.missingProfileFields), new Set(["firstHackathon", "developmentExperience", "city", "availableHoursPerDay"]));
    await request(app, "me/participation/plans", "POST", { eventId: saved.id }, member.cookie, 422);
    await request(app, "me/participant-profile", "PATCH", profileInput(), member.cookie);
    const ready = (await request<ParticipationContext>(app, `me/participation/context?eventId=${saved.id}`, "GET", undefined, member.cookie)).data;
    assert.equal(ready.profile.city, "成都"); assert.deepEqual(ready.missingProfileFields, []);
    assert.equal(ready.facts.city.value, null, "home city never becomes the event destination");
    const invalidCases = [
      { path: "me/participation/plans", body: { eventId: saved.id, ownerUserId: "another-user" } },
      { path: "me/participation/plans", body: { eventId: saved.id, supplement: { eventStartAt: "2026-02-30T09:00:00+08:00" } } },
      { path: "me/roadshow/scripts", body: { projectIdea: "", durationSeconds: 30 } },
      { path: "me/ppt/outlines", body: { templateId: "made-up-template", durationMinutes: 3 } },
    ];
    for (const item of invalidCases) await request(app, item.path, "POST", item.body, member.cookie, 422);
    const unconfigured = await request(app, "me/participation/plans", "POST", { eventId: saved.id }, member.cookie, 503);
    assert.equal(unconfigured.error?.code, "DSH_NOT_CONFIGURED");
    await request(app, "navigator/conversation", "GET", undefined, member.cookie);
    for (const kind of ["participation_plan", "roadshow", "ppt"]) assert.deepEqual((await request(app, `me/artifacts?kind=${kind}`, "GET", undefined, member.cookie)).data, []);
    assert.ok(PPT_TEMPLATES.length >= 3); assert.ok(PPT_TOOLS.length > 0);
    assert.ok(ROADSHOW_EXAMPLES.length > 0); assert.ok(ROADSHOW_REMINDERS.length > 0);
    await noGeneration(app);
    assert.equal(externalCalls, 0, "reading context/templates or rejecting invalid/unconfigured requests has no external network side effect");
  } finally { globalThis.fetch = originalFetch; await database.close(); }
});

test("public HTTPS local deployment with Resend sends to the entered mailbox and does not expose development codes", async () => {
  const originalFetch = globalThis.fetch;
  const sent: { to: string; from: string; text: string }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    sent.push(JSON.parse(String(init?.body)) as { to: string; from: string; text: string });
    return Response.json({ id: "test-provider-receipt" });
  };
  const { application: app, database } = await fixture({ origin: publicOrigin, resendKey: "integration-fixture-not-a-live-key", emailFrom: "黑客松情报局 <login@sender.example.test>" });
  try {
    await request(app, "auth/registration-challenges", "POST", { email: "new-participant@example.test", displayName: "新用户" });
    await request(app, "auth/login-challenges", "POST", { email: "returning-participant@example.test" });
    assert.deepEqual(sent.map(message => message.to), ["new-participant@example.test", "returning-participant@example.test"]);
    assert.ok(sent.every(message => message.from === app.config.emailFrom));
    assert.ok(sent.every(message => /\b\d{8}\b/.test(message.text)), "each private provider request contains an OTP");
    assert.equal((await database.query("SELECT id FROM auth_login_challenges WHERE delivery='ready'")).rowCount, 2);
    assert.equal((await database.query("SELECT id FROM development_mailbox")).rowCount, 0);
    await request(app, "dev/mailbox", "GET", undefined, undefined, 404);
    const status = (await request<{ email: string }>(app, "system/status")).data;
    assert.equal(status.email, "configured");
  } finally { globalThis.fetch = originalFetch; await database.close(); }
});

test("public HTTPS deployment without email credentials fails honestly and never falls back to a public development mailbox", async () => {
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async () => { sent++; throw new Error("no configured provider"); };
  const { application: app, database } = await fixture({ origin: publicOrigin });
  try {
    const failed = await request(app, "auth/registration-challenges", "POST", { email: "blocked-participant@example.test", displayName: "待配置用户" }, undefined, 503);
    assert.equal(failed.error?.code, "AUTH_EMAIL_UNAVAILABLE");
    assert.equal((await database.query("SELECT id FROM auth_login_challenges WHERE delivery='failed'")).rowCount, 1);
    assert.equal((await database.query("SELECT id FROM development_mailbox")).rowCount, 0);
    assert.equal((await database.query("SELECT id FROM auth_users")).rowCount, 0);
    await request(app, "dev/mailbox", "GET", undefined, undefined, 404);
    assert.equal((await request<{ email: string }>(app, "system/status")).data.email, "unconfigured");
    assert.equal(sent, 0);
  } finally { globalThis.fetch = originalFetch; await database.close(); }
});

test("public SMTP configuration is represented without exposing mailbox credentials or initiating delivery on reads", async () => {
  const { application: app, database } = await fixture({ origin: publicOrigin,
    emailFrom: "黑客松情报局 <fixture@qq.com>", emailProvider: "smtp",
    smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "fixture@qq.com", password: "fixture-only-not-live" } });
  try {
    const status = (await request<{ email: string }>(app, "system/status")).data;
    assert.equal(status.email, "configured");
    assert.doesNotMatch(JSON.stringify(status), /fixture@qq|fixture-only|smtp.qq/);
    await request(app, "dev/mailbox", "GET", undefined, undefined, 404);
    assert.equal((await database.query("SELECT id FROM auth_login_challenges")).rowCount, 0);
    assert.equal((await database.query("SELECT id FROM development_mailbox")).rowCount, 0);
  } finally { await database.close(); }
});
