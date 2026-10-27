import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { RecruitingApplication, RecruitingPost, RecruitingProfileView, OwnCardState, CardDraft, RecruitingProfileData } from "../modules/recruiting/model.ts";
import type { AssistantConversation, TeamAssistantContextSnapshot } from "../modules/team-assistant/model.ts";
import type { SuggestionReceipt, TeamFeedSnapshot } from "../modules/team-collaboration/types.ts";
import { createBudgetedModel, type JsonModelPort } from "./ai.ts";
import { createApplication } from "./application.ts";
import { createDatabase } from "./database.ts";
import { createNavigatorService } from "./navigator.ts";
import { dispatch } from "./router.ts";

const origin = "http://localhost:3000";
const alice: Actor = { userId: "mission-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "mission-bob", platformRoles: ["user"] };
const carol: Actor = { userId: "mission-carol", platformRoles: ["user"] };
const profile: RecruitingProfileData = { primaryRoles: ["frontend"], supportingRoles: ["design"], purposes: ["learn", "build"], purposeNote: "先完成可演示作品", resume: "PRIVATE_RESUME_SENTINEL", workLinks: [], mbti: "INTP", age: 23 };
const draft: CardDraft = { headline: "愿意做前端", introduction: "这是本人确认公开的介绍", primaryRoles: ["frontend"], supportingRoles: ["design"], purposes: ["learn", "build"], purposeNote: "一起学习", skills: ["TypeScript"], city: "上海", availableHoursPerDay: 2, workLinks: [], showMbti: false, showAge: false, showAvatar: false };

async function fixture() {
  // No env, provider config, worker, production path or network. Root migrations
  // and root application composition run on a fresh in-memory real SQL engine.
  const database = await createDatabase({});
  let app: Awaited<ReturnType<typeof createApplication>>;
  try { app = await createApplication({ mode: "local", origin, codePepper: "mission-integration-isolated-test-pepper-only", emailFrom: "test@example.test" }, database); }
  catch (error) { await database.close(); throw error; }
  const now = app.clock.now().toISOString(); const tokens = new Map<string, string>();
  for (const actor of [alice, bob, carol]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$5,$5)", [actor.userId, `${actor.userId}@example.test`, actor.userId, actor.platformRoles, now]);
    const token = randomBytes(32).toString("base64url"); tokens.set(actor.userId, token);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", [`${actor.userId}-session`, actor.userId, createHash("sha256").update(token).digest("hex"), now, new Date(app.clock.now().getTime() + 3_600_000).toISOString()]);
  }
  const alpha = await app.projects.createProject(alice, { name: "Alpha 团队练习", goal: "完成 Alpha 原型", minimumDeliverable: "可操作的 Alpha Demo", timezone: "Asia/Shanghai" });
  const beta = await app.projects.createProject(alice, { name: "Beta 团队练习", goal: "完成 Beta 原型", timezone: "Asia/Shanghai" });
  const gamma = await app.projects.createProject(alice, { name: "Gamma 招募练习", goal: "一起验证招募闭环", timezone: "Asia/Shanghai" });
  const join = async (actor: Actor, projectId: string, role: "member" | "manager" = "member") => {
    const detail = await app.projects.getProject(alice, projectId);
    const invitation = await app.projects.createProjectInvitation(alice, projectId, { expectedRevision: detail.project.revision, role, expiresAt: new Date(app.clock.now().getTime() + 3_600_000).toISOString(), maxUses: 1 });
    return app.projects.acceptInvitation(actor, invitation.token);
  };
  await join(bob, alpha.id);
  async function request<T>(actor: Actor | null, path: string, method = "GET", body?: unknown, expectedStatus = 200, requestOrigin = origin): Promise<T> {
    const headers = new Headers({ Origin: requestOrigin });
    if (actor) headers.set("Cookie", `hackathon_session=${tokens.get(actor.userId)}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("?")[0]!.split("/"));
    const envelope = await response.json() as { data: T; error?: { code: string; message: string }; requestId: string };
    assert.equal(response.status, expectedStatus, `${method} ${path.split("?")[0]}: ${envelope.error?.code ?? "unexpected status"}`);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.ok(envelope.requestId);
    return expectedStatus >= 400 ? envelope.error as T : envelope.data;
  }
  let fixtureModelCalls = 0;
  const navigatorReply = async (actor: Actor, message: string, projectId?: string) => {
    const raw: JsonModelPort = { modelVersion: "explicit-test-fixture-model", async completeJSON() { fixtureModelCalls++; return { content: { reply: `隔离模型回复：${message}`, linkIds: [] }, usage: { inputTokens: 30, outputTokens: 20 }, requestId: null, modelVersion: "explicit-test-fixture-model" }; } };
    const model = createBudgetedModel({ model: raw, ledger: app.aiLedger, clock: app.clock.now, maxAttempts: 1 });
    // Only the navigator's provider port is a fixture. Identity, request session,
    // budget, lease, append, source validation, router and root services are real.
    app.navigator = createNavigatorService({ database, projects: app.projects, clock: app.clock, ids: app.ids, model, ledger: app.aiLedger, sessions: app.personalWorkspace });
    return request<{ sourceId: string; reply: string; requestId: string }>(actor, "navigator/messages", "POST", { message, pagePath: projectId ? `/app/projects/${projectId}` : "/events", ...(projectId ? { projectId } : {}) });
  };
  const approve = async () => {
    const post = await request<RecruitingPost>(alice, `projects/${gamma.id}/recruiting-post`, "POST", { expectedRevision: 0, post: { spaceName: "Gamma 招募练习", title: "寻找前端伙伴", description: "明确公开的团队招募", neededRoles: ["frontend"], purposes: ["learn", "build"], seats: 2, status: "open" } }, 201);
    const application = await request<RecruitingApplication>(bob, `recruiting/posts/${post.id}/applications`, "POST", { expectedPostRevision: post.revision, expectedRevision: 0, requestId: randomUUID(), message: "我愿意承担前端任务", shareCard: false }, 201);
    const approved = await request<RecruitingApplication>(alice, `recruiting/applications/${application.id}/review`, "POST", { expectedRevision: application.revision, decision: "approve", note: "已核对意愿，请本人确认加入" });
    return { post, application, approved };
  };
  return { app, database, alpha, beta, gamma, request, join, approve, navigatorReply, modelCalls: () => fixtureModelCalls };
}

test("root application applies 028–031 and private routes reject anonymous, foreign-space and revoked-session reads", async () => {
  const f = await fixture();
  try {
    const applied = (await f.database.query<{ id: string }>("SELECT id FROM application_migrations WHERE id IN ('028_personal_ai_extensions.sql','029_recruiting.sql','030_team_collaboration.sql','031_team_assistant.sql') ORDER BY id")).rows;
    assert.equal(applied.length, 4);
    const paths = [`projects/${f.alpha.id}/assistant/conversation`, `projects/${f.alpha.id}/assistant/context`, `projects/${f.alpha.id}/assistant/feasibility`, `projects/${f.alpha.id}/team-feed`, `projects/${f.alpha.id}/task-pool`, "me/recruiting-profile", "me/recruiting-applications"];
    for (const path of paths) await f.request(null, path, "GET", undefined, 401);
    for (const path of paths.slice(0, 3)) await f.request(carol, path, "GET", undefined, 404);
    await f.request(carol, `projects/${f.alpha.id}/team-feed`, "GET", undefined, 403);
    await f.request(carol, `projects/${f.alpha.id}/task-pool`, "GET", undefined, 404);
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [bob.userId]);
    for (const path of paths) await f.request(bob, path, "GET", undefined, 401);
    assert.equal(f.modelCalls(), 0); assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("root assistant conversations isolate accounts and spaces and clear never touches navigation history", async () => {
  const f = await fixture();
  try {
    for (const [actor, projectId, content] of [[alice, f.alpha.id, "Alice Alpha 私人记录"], [alice, f.beta.id, "Alice Beta 私人记录"], [bob, f.alpha.id, "Bob Alpha 私人记录"]] as const) {
      const conversation = await f.request<AssistantConversation>(actor, `projects/${projectId}/assistant/conversation`);
      assert.deepEqual(conversation.messages, []); assert.equal(conversation.configured, false);
      const requestId = randomUUID(), now = f.app.clock.now().toISOString();
      // Saved-history fixtures verify read/clear scopes; this is not a successful
      // provider call and does not assert any generated assistant result.
      await f.database.query("INSERT INTO team_assistant_requests(user_id,project_id,request_id,request_hash,message,status,created_at,expires_at) VALUES($1,$2,$3,'fixture-history',$4,'failed',$5,$5)", [actor.userId, projectId, requestId, content, now]);
      await f.database.query("INSERT INTO team_assistant_messages(user_id,project_id,request_id,id,role,content,created_at,provider,links,coverage) VALUES($1,$2,$3,$4,'user',$5,$6,NULL,'[]'::jsonb,NULL)", [actor.userId, projectId, requestId, randomUUID(), content, now]);
    }
    await f.database.transaction(sql => f.app.personalWorkspace.append(sql, alice, undefined, "导航记忆独立", "本人导航回答"));
    const alpha = await f.request<AssistantConversation>(alice, `projects/${f.alpha.id}/assistant/conversation?userId=${bob.userId}`);
    assert.deepEqual(alpha.messages.map(item => item.content), ["Alice Alpha 私人记录"]);
    assert.deepEqual((await f.request<AssistantConversation>(bob, `projects/${f.alpha.id}/assistant/conversation`)).messages.map(item => item.content), ["Bob Alpha 私人记录"]);
    assert.deepEqual((await f.request<AssistantConversation>(alice, `projects/${f.beta.id}/assistant/conversation`)).messages.map(item => item.content), ["Alice Beta 私人记录"]);
    await f.request(alice, `projects/${f.alpha.id}/assistant/conversation`, "DELETE", { expectedRevision: alpha.revision });
    assert.deepEqual((await f.request<AssistantConversation>(alice, `projects/${f.alpha.id}/assistant/conversation`)).messages, []);
    assert.equal((await f.request<AssistantConversation>(alice, `projects/${f.beta.id}/assistant/conversation`)).messages.length, 1);
    assert.equal((await f.request<AssistantConversation>(bob, `projects/${f.alpha.id}/assistant/conversation`)).messages.length, 1);
    assert.equal((await f.app.personalWorkspace.conversation(alice)).messages.length, 2);
    assert.equal((await f.database.query("SELECT request_id FROM team_assistant_requests")).rowCount, 3, "clear preserves request uncertainty records");
  } finally { await f.database.close(); }
});

test("unconfigured root DSH refuses assistant, feasibility and profile generation without pretending success or charging", async () => {
  const f = await fixture();
  try {
    const conversation = await f.request<AssistantConversation>(alice, `projects/${f.alpha.id}/assistant/conversation`);
    const error = await f.request<{ code: string }>(alice, `projects/${f.alpha.id}/assistant/messages`, "POST", { message: "现在先做什么", requestId: randomUUID(), expectedRevision: conversation.revision }, 503);
    assert.equal(error.code, "DSH_NOT_CONFIGURED");
    const context = await f.request<TeamAssistantContextSnapshot>(alice, `projects/${f.alpha.id}/assistant/context`);
    const report = await f.request<{ code: string }>(alice, `projects/${f.alpha.id}/assistant/feasibility`, "POST", { idea: "做一个可操作的小原型", expectedContextFingerprint: context.fingerprint }, 503);
    assert.equal(report.code, "DSH_NOT_CONFIGURED");
    const card = await f.request<{ code: string }>(alice, "me/recruiting-profile/summary", "POST", { expectedRevision: 0 }, 503);
    assert.equal(card.code, "DSH_NOT_CONFIGURED");
    assert.equal((await f.database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
    assert.equal((await f.database.query("SELECT request_id FROM team_assistant_requests")).rowCount, 0);
    assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("root sharing requires the author's successful navigator assistant source and an explicit POST", async () => {
  const f = await fixture();
  try {
    const source = await f.navigatorReply(alice, "PRIVATE_FULL_REPLY_SENTINEL：先核对工具再拆任务", f.alpha.id);
    assert.match(source.sourceId, /^[1-9]\d*$/);
    assert.deepEqual((await f.request<TeamFeedSnapshot>(bob, `projects/${f.alpha.id}/team-feed`)).items, []);
    const input = { sourceKind: "navigator", sourceId: source.sourceId, title: "需要共同核对的建议", body: "仅明确分享这一小段", idempotencyKey: randomUUID() };
    const forged = await f.request<{ code: string }>(bob, `projects/${f.alpha.id}/team-feed`, "POST", input, 409);
    assert.equal(forged.code, "SHARE_SOURCE_UNAVAILABLE");
    const userMessage = (await f.database.query<{ id: string }>("SELECT id::text AS id FROM personal_dsh_messages WHERE role='user'")).rows[0]!;
    await f.request(alice, `projects/${f.alpha.id}/team-feed`, "POST", { ...input, sourceId: userMessage.id, idempotencyKey: randomUUID() }, 409);
    await f.request(alice, `projects/${f.alpha.id}/team-feed`, "POST", { ...input, sourceId: source.requestId, idempotencyKey: randomUUID() }, 409);
    const receipt = await f.request<SuggestionReceipt>(alice, `projects/${f.alpha.id}/team-feed`, "POST", input, 201);
    const feed = await f.request<TeamFeedSnapshot>(bob, `projects/${f.alpha.id}/team-feed`);
    const item = feed.items.find(item => item.id === receipt.id)!;
    assert.equal(item.kind, "suggestion");
    if (item.kind === "suggestion") { assert.equal(item.suggestion.body, input.body); assert.equal(item.suggestion.source.sourceId, source.sourceId); }
    assert.ok(!JSON.stringify(feed).includes("PRIVATE_FULL_REPLY_SENTINEL"), "source validation does not copy the private full answer");
    assert.equal((await f.request<SuggestionReceipt>(alice, `projects/${f.alpha.id}/team-feed`, "POST", input, 201)).replayed, true);
    assert.equal((await f.database.query("SELECT id FROM r02_team_suggestions")).rowCount, 1);
  } finally { await f.database.close(); }
});

test("cleared navigator sources and withdrawn suggestions disappear from later team context and expose only tombstones", async () => {
  const f = await fixture();
  try {
    const source = await f.navigatorReply(alice, "来源失效前的建议", f.alpha.id);
    const saved = await f.request<SuggestionReceipt>(alice, `projects/${f.alpha.id}/team-feed`, "POST", { sourceKind: "navigator", sourceId: source.sourceId, title: "已发布片段", body: "SHARED_OLD_BODY_SENTINEL", idempotencyKey: randomUUID() }, 201);
    const current = await f.request<TeamAssistantContextSnapshot>(bob, `projects/${f.alpha.id}/assistant/context`);
    assert.ok(JSON.stringify(current.facts).includes("SHARED_OLD_BODY_SENTINEL"));
    await f.request(alice, `navigator/conversation?projectId=${f.alpha.id}`, "DELETE");
    const next = await f.request<TeamAssistantContextSnapshot>(bob, `projects/${f.alpha.id}/assistant/context`);
    assert.ok(!JSON.stringify(next.facts).includes("SHARED_OLD_BODY_SENTINEL")); assert.notEqual(next.fingerprint, current.fingerprint);
    const feed = await f.request<TeamFeedSnapshot>(bob, `projects/${f.alpha.id}/team-feed`);
    assert.equal(feed.items.find(item => item.id === saved.id)?.kind, "unavailable");
    assert.ok(!JSON.stringify(feed).includes("SHARED_OLD_BODY_SENTINEL"));
    const manual = await f.request<SuggestionReceipt>(alice, `projects/${f.alpha.id}/team-feed`, "POST", { sourceKind: "manual", sourceId: null, title: "团队备注", body: "WITHDRAWN_BODY_SENTINEL", idempotencyKey: randomUUID() }, 201);
    await f.request(alice, `projects/${f.alpha.id}/team-feed/${manual.id}/withdraw`, "POST", { expectedRevision: manual.revision, idempotencyKey: randomUUID() });
    assert.ok(!JSON.stringify((await f.request<TeamAssistantContextSnapshot>(bob, `projects/${f.alpha.id}/assistant/context`)).facts).includes("WITHDRAWN_BODY_SENTINEL"));
    assert.ok(!JSON.stringify(await f.request<TeamFeedSnapshot>(bob, `projects/${f.alpha.id}/team-feed`)).includes("WITHDRAWN_BODY_SENTINEL"));
  } finally { await f.database.close(); }
});

test("private recruiting profile stays private until explicit card publication and withdraw removes the public card", async () => {
  const f = await fixture();
  try {
    const saved = await f.request<RecruitingProfileView>(alice, "me/recruiting-profile", "PATCH", { expectedRevision: 0, profile });
    assert.equal(saved.profile.resume, profile.resume); assert.equal(saved.card.status, "private");
    assert.equal((await f.request<RecruitingProfileView>(bob, `me/recruiting-profile?userId=${alice.userId}`)).profile.resume, "");
    assert.deepEqual((await f.request<{ items: unknown[] }>(null, "recruiting/cards")).items, []);
    const published = await f.request<OwnCardState>(alice, "me/recruiting-card/publish", "POST", { expectedRevision: saved.card.revision, profileRevision: saved.profile.revision, participantRevision: saved.participant.revision, avatarRevision: saved.profile.avatarRevision, draft, confirmed: true }, 201);
    const cards = await f.request<{ items: unknown[] }>(null, "recruiting/cards");
    assert.equal(cards.items.length, 1); assert.ok(!JSON.stringify(cards).includes(profile.resume));
    assert.equal(published.card?.mbti, null); assert.equal(published.card?.age, null);
    await f.request(alice, "me/recruiting-card/withdraw", "POST", { expectedRevision: published.revision });
    assert.deepEqual((await f.request<{ items: unknown[] }>(null, "recruiting/cards")).items, []);
    assert.equal((await f.request<RecruitingProfileView>(alice, "me/recruiting-profile")).profile.resume, profile.resume);
  } finally { await f.database.close(); }
});

test("recruiting approval is not membership; applicant explicit join uses real M02 member admission and retries once", async () => {
  const f = await fixture();
  try {
    const { approved } = await f.approve();
    assert.equal(approved.status, "approved"); assert.equal(approved.membershipId, null);
    assert.equal(await f.app.projectRepository.getMembership(f.gamma.id, bob.userId), null);
    await f.request(bob, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: false }, 400);
    await f.request(carol, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: true }, 403);
    const joined = await f.request<RecruitingApplication>(bob, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: true });
    assert.equal(joined.status, "joined"); assert.equal(joined.reviewedBy, alice.userId);
    const member = await f.app.projectRepository.getMembership(f.gamma.id, bob.userId);
    assert.equal(member?.membershipId, joined.membershipId); assert.equal(member?.role, "member"); assert.equal(member?.status, "active");
    const invitations = (await f.app.projects.listProjectInvitations(alice, f.gamma.id)).length;
    assert.deepEqual(await f.request<RecruitingApplication>(bob, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: true }), joined);
    assert.equal((await f.app.projects.listProjectInvitations(alice, f.gamma.id)).length, invitations);
    assert.equal((await f.database.query("SELECT membership_id FROM projects_project_membership WHERE project_id=$1 AND user_id=$2", [f.gamma.id, bob.userId])).rowCount, 1);
  } finally { await f.database.close(); }
});

test("M02 join failure rolls back admission, invitation and application, allowing an explicit safe retry", async () => {
  const f = await fixture();
  try {
    const { approved } = await f.approve();
    const before = await f.app.projects.getProject(alice, f.gamma.id);
    const originalAccept = f.app.projects.acceptInvitation.bind(f.app.projects);
    f.app.projects.acceptInvitation = async (actor, token) => {
      await originalAccept(actor, token);
      throw new DomainError("FIXTURE_JOIN_FAILURE", "隔离测试的加入后保存故障", { status: 503 });
    };
    const failed = await f.request<{ code: string }>(bob, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: true }, 503);
    assert.equal(failed.code, "FIXTURE_JOIN_FAILURE");
    assert.equal(await f.app.projectRepository.getMembership(f.gamma.id, bob.userId), null);
    assert.equal((await f.app.projects.listProjectInvitations(alice, f.gamma.id)).length, 0);
    assert.equal((await f.app.projects.getProject(alice, f.gamma.id)).project.revision, before.project.revision);
    const application = (await f.app.recruiting.listOwnApplications(bob)).find(item => item.id === approved.id)!;
    assert.equal(application.status, "approved"); assert.equal(application.revision, approved.revision);
    f.app.projects.acceptInvitation = originalAccept;
    assert.equal((await f.request<RecruitingApplication>(bob, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: true })).status, "joined");
  } finally { await f.database.close(); }
});

test("a demoted original approver cannot admit an applicant through an old approved application", async () => {
  const f = await fixture();
  try {
    const { approved } = await f.approve();
    await f.join(carol, f.gamma.id, "manager");
    const detail = await f.app.projects.getProject(alice, f.gamma.id);
    await f.app.projects.transferProjectManagement(alice, f.gamma.id, { expectedRevision: detail.project.revision, targetUserId: carol.userId });
    const rejected = await f.request<{ code: string }>(bob, `recruiting/applications/${approved.id}/join`, "POST", { expectedRevision: approved.revision, confirmed: true }, 403);
    assert.equal(rejected.code, "RECRUITING_FORBIDDEN");
    assert.equal(await f.app.projectRepository.getMembership(f.gamma.id, bob.userId), null);
    assert.equal((await f.app.recruiting.listOwnApplications(bob)).find(item => item.id === approved.id)?.canJoin, false);
  } finally { await f.database.close(); }
});

test("root mutations reject a foreign Origin and revoked sessions before changing profiles or shared cards", async () => {
  const f = await fixture();
  try {
    await f.request(alice, "me/recruiting-profile", "PATCH", { expectedRevision: 0, profile }, 403, "https://foreign.example.test");
    assert.equal((await f.app.recruiting.getProfile(alice)).profile.revision, 0);
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [alice.userId]);
    await f.request(alice, "me/recruiting-profile", "PATCH", { expectedRevision: 0, profile }, 401);
    await f.request(alice, `projects/${f.alpha.id}/team-feed`, "POST", { sourceKind: "manual", sourceId: null, title: "不应保存", body: "无效会话内容", idempotencyKey: randomUUID() }, 401);
    assert.equal((await f.app.recruiting.getProfile(alice)).profile.revision, 0);
    assert.equal((await f.app.teamCollaboration.listSharedContext(bob, f.alpha.id)).length, 0);
  } finally { await f.database.close(); }
});

async function seedPersonalArtifact(f: Awaited<ReturnType<typeof fixture>>, actor: Actor, kind: "space_assistant_reply" | "project_feasibility" | "profile_summary", data: Record<string, unknown>) {
  // Explicit successful fixture rows exercise retrieval; no provider is called
  // and these rows never enter a production database or a paid usage ledger.
  const id = randomUUID(), now = f.app.clock.now().toISOString();
  const session = await f.app.personalWorkspace.session(actor);
  await f.database.transaction(async sql => {
    await sql.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,external_state,created_at,updated_at) VALUES($1,$2,$1,1,$3,$4,'succeeded',1,'response_received',$5,$5)", [id, `personal_${kind}`, `navigator-user:${actor.userId}`, actor.userId, now]);
    await sql.query("INSERT INTO personal_ai_artifacts(id,user_id,session_id,kind,title,data,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [id, actor.userId, session.id, kind, "隔离验收记录", JSON.stringify(data), now]);
  });
  return { id, kind, data };
}

test("root artifact routes recheck source-space membership for assistant replies and feasibility without deleting private history", async () => {
  const f = await fixture();
  try {
    await f.join(bob, f.beta.id);
    const records = [];
    for (const kind of ["space_assistant_reply", "project_feasibility"] as const) {
      const first = await seedPersonalArtifact(f, bob, kind, { projectId: f.alpha.id, answer: `${kind}: ALPHA_PRIVATE_ARTIFACT` });
      const other = await seedPersonalArtifact(f, bob, kind, { projectId: f.beta.id, answer: `${kind}: BETA_PRIVATE_ARTIFACT` });
      records.push({ kind, first, other });
      const list = await f.request<Array<{ id: string; data: unknown }>>(bob, `me/artifacts?kind=${kind}`);
      assert.deepEqual(new Set(list.map(item => item.id)), new Set([first.id, other.id]));
      assert.deepEqual((await f.request<{ data: unknown }>(bob, `me/artifacts/${first.id}`)).data, first.data);
      await f.request(alice, `me/artifacts/${first.id}`, "GET", undefined, 404);
      assert.deepEqual(await f.request(alice, `me/artifacts?kind=${kind}&userId=${bob.userId}`), []);
      await f.request(null, `me/artifacts/${first.id}`, "GET", undefined, 401);
    }
    const detail = await f.app.projects.getProject(alice, f.alpha.id);
    await f.app.projects.removeProjectMember(alice, f.alpha.id, bob.userId, detail.project.revision);
    for (const { kind, first, other } of records) {
      assert.deepEqual((await f.request<Array<{ id: string }>>(bob, `me/artifacts?kind=${kind}`)).map(item => item.id), [other.id]);
      await f.request(bob, `me/artifacts/${first.id}`, "GET", undefined, 404);
      assert.deepEqual((await f.request<{ data: unknown }>(bob, `me/artifacts/${other.id}`)).data, other.data);
      assert.equal((await f.database.query("SELECT id FROM personal_ai_artifacts WHERE id=$1", [first.id])).rowCount, 1, "revoked source permission hides the record, preserving its history");
    }
    assert.equal(f.modelCalls(), 0);
  } finally { await f.database.close(); }
});

test("root profile-summary artifacts remain own-account private and never appear in public recruiting cards", async () => {
  const f = await fixture();
  try {
    const record = await seedPersonalArtifact(f, bob, "profile_summary", { summary: "PRIVATE_PROFILE_SUMMARY_SENTINEL", primaryRoles: ["frontend"] });
    const own = await f.request<{ data: unknown }>(bob, `me/artifacts/${record.id}`);
    assert.deepEqual(own.data, record.data);
    assert.deepEqual((await f.request<Array<{ id: string }>>(bob, "me/artifacts?kind=profile_summary")).map(item => item.id), [record.id]);
    await f.request(alice, `me/artifacts/${record.id}`, "GET", undefined, 404);
    await f.request(null, `me/artifacts/${record.id}`, "GET", undefined, 401);
    assert.deepEqual(await f.request(alice, `me/artifacts?kind=profile_summary&userId=${bob.userId}`), []);
    assert.ok(!JSON.stringify(await f.request(null, "recruiting/cards")).includes("PRIVATE_PROFILE_SUMMARY_SENTINEL"));
    const detail = await f.app.projects.getProject(alice, f.alpha.id);
    await f.app.projects.removeProjectMember(alice, f.alpha.id, bob.userId, detail.project.revision);
    assert.deepEqual((await f.request<{ data: unknown }>(bob, `me/artifacts/${record.id}`)).data, record.data);
    assert.deepEqual((await f.request<Array<{ id: string }>>(bob, "me/artifacts?kind=profile_summary")).map(item => item.id), [record.id]);
    assert.equal(f.modelCalls(), 0);
  } finally { await f.database.close(); }
});

test("root source sharing uses M02 membership share locks on the original source project and its transaction executor", async () => {
  const f = await fixture();
  try {
    await f.join(bob, f.beta.id);
    const source = await f.navigatorReply(bob, "来源位于 Alpha，仅分享用户选择的片段", f.alpha.id);
    const original = f.app.projectRepository.getMembershipForShare.bind(f.app.projectRepository);
    const calls: Array<{ projectId: string; userId: string; status: string | null }> = [];
    f.app.projectRepository.getMembershipForShare = async (sql, projectId, userId) => {
      assert.notEqual(sql, f.database, "the source permission lock must use the sharing transaction executor");
      const member = await original(sql, projectId, userId);
      calls.push({ projectId, userId, status: member?.status ?? null });
      return member;
    };
    const receipt = await f.request<SuggestionReceipt>(bob, `projects/${f.beta.id}/team-feed`, "POST", { sourceKind: "navigator", sourceId: source.sourceId, title: "跨空间分享本人片段", body: "EXPLICIT_CROSS_SPACE_SENTINEL", idempotencyKey: randomUUID() }, 201);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => call.projectId === f.alpha.id && call.userId === bob.userId && call.status === "active"));
    const detail = await f.app.projects.getProject(alice, f.alpha.id);
    await f.app.projects.removeProjectMember(alice, f.alpha.id, bob.userId, detail.project.revision);
    const rejected = await f.request<{ code: string }>(bob, `projects/${f.beta.id}/team-feed`, "POST", { sourceKind: "navigator", sourceId: source.sourceId, title: "已失去来源空间权限", body: "不应再次分享", idempotencyKey: randomUUID() }, 409);
    assert.equal(rejected.code, "SHARE_SOURCE_UNAVAILABLE");
    assert.deepEqual(calls.at(-1), { projectId: f.alpha.id, userId: bob.userId, status: "removed" });
    const feed = await f.request<TeamFeedSnapshot>(alice, `projects/${f.beta.id}/team-feed`);
    assert.equal(feed.items.find(item => item.id === receipt.id)?.kind, "unavailable");
    assert.ok(!JSON.stringify(feed).includes("EXPLICIT_CROSS_SPACE_SENTINEL"));
  } finally { await f.database.close(); }
});
