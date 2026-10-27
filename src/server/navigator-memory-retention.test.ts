import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { FreshSessionGuard } from "../shared/personal-ai.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens } from "../modules/projects/index.ts";
import { createBudgetedModel, type JsonModelPort, type JsonModelRequest } from "./ai.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import { createDatabase } from "./database.ts";
import { createNavigatorService } from "./navigator.ts";
import { createPersonalWorkspace } from "./personal-workspace.ts";

interface StoredMessage { id: string; role: "user" | "assistant"; content: string; project_id: string | null; user_id: string }

async function fixture() {
  // New in-memory PGlite, real migrations and services. Never reads .env or the
  // running application's directory; model calls below are explicit fixtures.
  const database = await createDatabase({});
  await database.migrate();
  const clock = { now: () => new Date("2026-10-09T03:00:00Z") };
  const alice: Actor = { userId: "retention-alice", platformRoles: ["user"] };
  const bob: Actor = { userId: "retention-bob", platformRoles: ["user"] };
  for (const actor of [alice, bob]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,'隔离记忆验收','UTC',$3,$3)",
    [actor.userId, `${actor.userId}@example.test`, clock.now().toISOString()]);
  const projects = new ProjectsService({ repository: new PostgresProjectsRepository(database), clock, ids: { next: randomUUID }, tokens: createInvitationTokens(),
    identity: { async getVerifiedEmail(userId) { return (await database.query<{ email: string }>("SELECT email FROM auth_users WHERE id=$1 AND status='active'", [userId])).rows[0]?.email ?? null; } } });
  const alpha = await projects.createProject(alice, { name: "Alpha 隔离记忆", goal: "Alpha 的任务", timezone: "UTC" });
  const beta = await projects.createProject(alice, { name: "Beta 隔离记忆", goal: "Beta 的任务", timezone: "UTC" });
  const invitation = await projects.createProjectInvitation(alice, alpha.id, { expectedRevision: alpha.revision, role: "member", expiresAt: "2026-10-10T03:00:00Z", maxUses: 1 });
  await projects.acceptInvitation(bob, invitation.token);
  const requests: JsonModelRequest[] = [];
  let provider: JsonModelPort["completeJSON"] = async request => ({
    content: { reply: `隔离 DSH 回复：${(request.input as { message: string }).message}`, linkIds: [] },
    usage: { inputTokens: 100, outputTokens: 20 }, requestId: null, modelVersion: "retention-test-model",
  });
  const raw: JsonModelPort = { modelVersion: "retention-test-model", async completeJSON(request, signal) { requests.push(structuredClone(request)); return provider(request, signal); } };
  const ledger = new PostgresAiLedger(database, { dailyProjectCallLimit: 20 });
  const model = createBudgetedModel({ model: raw, ledger, clock: clock.now, maxAttempts: 1 });
  const build = () => {
    const sessions = createPersonalWorkspace({ database, clock, ids: { next: randomUUID }, model, ledger });
    const navigator = createNavigatorService({ database, projects, clock, ids: { next: randomUUID }, model, ledger, sessions });
    return { sessions, navigator };
  };
  const service = build();
  const guard = (actor: Actor, projectId: string): FreshSessionGuard => async () => { await projects.getProject(actor, projectId); };
  const append = (actor: Actor, scope: string | undefined, message: string, reply: string) => database.transaction(sql => service.sessions.append(sql, actor, scope, message, reply));
  const rows = async (actor: Actor): Promise<readonly StoredMessage[]> => (await database.query<StoredMessage>(
    "SELECT m.id::text AS id,m.role,m.content,m.project_id,s.user_id FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1 ORDER BY m.id", [actor.userId])).rows;
  return { database, clock, alice, bob, alpha, beta, projects, requests, build, ...service, guard, append, rows,
    setProvider: (replacement: JsonModelPort["completeJSON"]) => { provider = replacement; } };
}

test("more than 200 durable account messages survive new replies and service reconstruction while model context stays bounded", async () => {
  const f = await fixture();
  try {
    let firstUserId = "";
    for (let index = 0; index < 105; index++) {
      const saved = await f.append(f.alice, undefined, `个人记忆问题 ${index}`, `本人导航回复 ${index}`);
      if (index === 0) firstUserId = saved.userMessageId;
    }
    await f.append(f.alice, f.alpha.id, "Alpha 私人记忆", "Alpha 私人回复");
    await f.append(f.alice, f.beta.id, "Beta 私人记忆", "Beta 私人回复");
    const before = await f.rows(f.alice);
    assert.equal(before.length, 214, "retention is account-wide, not 200 per selected scope");
    assert.equal(before[0]?.id, firstUserId); assert.equal(before[0]?.content, "个人记忆问题 0");
    const sessionId = (await f.sessions.session(f.alice)).id;
    const rebuilt = f.build();
    const reply = await rebuilt.navigator.reply(f.alice, { message: "继续最近一轮", pagePath: "/events" });
    const input = f.requests[0]!.input as { history: { role: string; content: string }[] };
    assert.equal(input.history.length, 10); assert.equal(input.history[0]?.content, "个人记忆问题 100");
    assert.equal(input.history.at(-1)?.content, "本人导航回复 104");
    assert.ok(!JSON.stringify(input.history).includes("Alpha 私人"));
    assert.ok(Buffer.byteLength(JSON.stringify(input.history)) < 24_000);
    const after = await f.rows(f.alice);
    assert.equal(after.length, 216); assert.deepEqual(after.slice(0, before.length), before);
    assert.equal((await rebuilt.sessions.session(f.alice)).id, sessionId);
    assert.equal(after.at(-1)?.id, reply.sourceId); assert.equal(after.at(-1)?.role, "assistant");
    assert.equal(after.at(-1)?.content, reply.reply);
  } finally { await f.database.close(); }
});

test("conversation messageIds preserve exact role/content alignment, numeric order and multibyte trimming", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 6; index++) await f.append(f.alice, undefined, `问题 ${index}`, `${index}:` + "汉".repeat(5900));
    const original = await f.rows(f.alice);
    assert.equal(original.length, 12);
    const conversation = await f.sessions.conversation(f.alice);
    assert.equal(conversation.messages.length, conversation.messageIds.length);
    assert.ok(conversation.messages.length > 0 && conversation.messages.length < 10, "the byte cap trims complete old entries");
    assert.ok(conversation.messages.reduce((bytes, item) => bytes + Buffer.byteLength(item.content, "utf8"), 0) <= 24_000);
    const byId = new Map(original.map(item => [item.id, item]));
    for (let index = 0; index < conversation.messageIds.length; index++) {
      const id = conversation.messageIds[index]!;
      const stored = byId.get(id)!;
      assert.ok(stored); assert.deepEqual(conversation.messages[index], { role: stored.role, content: stored.content });
      if (index) assert.ok(BigInt(conversation.messageIds[index - 1]!) < BigInt(id));
    }
    assert.equal(conversation.messageIds.at(-1), original.at(-1)?.id);
    assert.equal(conversation.messages.at(-1)?.content, original.at(-1)?.content, "UTF-8 entries are not cut mid-message");
    assert.deepEqual((await f.build().sessions.conversation(f.alice)).messageIds, conversation.messageIds);
    assert.equal((await f.rows(f.alice)).length, 12, "bounded reads do not delete stored memory");
  } finally { await f.database.close(); }
});

test("clear removes only the chosen user's chosen project or general scope", async () => {
  const f = await fixture();
  try {
    await f.append(f.alice, undefined, "Alice 通用", "Alice 通用回复");
    await f.append(f.alice, f.alpha.id, "Alice Alpha", "Alice Alpha回复");
    await f.append(f.alice, f.beta.id, "Alice Beta", "Alice Beta回复");
    await f.append(f.bob, f.alpha.id, "Bob Alpha", "Bob Alpha回复");
    const before = await f.rows(f.alice); const bobBefore = await f.rows(f.bob);
    const aliceSession = (await f.sessions.session(f.alice)).id;
    assert.deepEqual(await f.sessions.clearConversation(f.alice, f.alpha.id, f.guard(f.alice, f.alpha.id)), { cleared: true });
    assert.deepEqual((await f.sessions.conversation(f.alice, f.alpha.id, f.guard(f.alice, f.alpha.id))).messages, []);
    assert.deepEqual(await f.rows(f.alice), before.filter(item => item.project_id !== f.alpha.id));
    assert.deepEqual(await f.rows(f.bob), bobBefore, "same-team conversations stay private to their authors");
    await f.sessions.clearConversation(f.alice);
    assert.deepEqual(await f.rows(f.alice), before.filter(item => item.project_id === f.beta.id));
    assert.deepEqual(await f.rows(f.bob), bobBefore);
    assert.equal((await f.sessions.session(f.alice)).id, aliceSession, "clear deletes messages, not the durable account workspace");
    await f.sessions.clearConversation(f.alice, f.alpha.id, f.guard(f.alice, f.alpha.id));
    assert.deepEqual(await f.rows(f.alice), before.filter(item => item.project_id === f.beta.id), "repeated clear is scoped and harmless");
  } finally { await f.database.close(); }
});

test("real navigator sourceIds are persisted assistant rows and teammates cannot read or clear another account's message", async () => {
  const f = await fixture();
  try {
    const reply = await f.navigator.reply(f.alice, { message: "Alice 独有方案 sentinel_alice", pagePath: `/app/projects/${f.alpha.id}`, projectId: f.alpha.id });
    assert.equal(typeof reply.sourceId, "string"); assert.match(reply.sourceId!, /^[1-9]\d*$/);
    const ownerConversation = await f.sessions.conversation(f.alice, f.alpha.id, f.guard(f.alice, f.alpha.id));
    assert.equal(ownerConversation.messageIds.at(-1), reply.sourceId);
    assert.equal(ownerConversation.messages.at(-1)?.content, reply.reply);
    const source = (await f.rows(f.alice)).find(item => item.id === reply.sourceId)!;
    assert.equal(source.role, "assistant"); assert.equal(source.project_id, f.alpha.id);
    assert.equal(source.user_id, f.alice.userId); assert.notEqual(reply.sourceId, reply.requestId);
    const bobConversation = await f.sessions.conversation(f.bob, f.alpha.id, f.guard(f.bob, f.alpha.id));
    assert.deepEqual(bobConversation.messages, []); assert.deepEqual(bobConversation.messageIds, []);
    const bobReply = await f.navigator.reply(f.bob, { message: "Bob 当前问题", pagePath: `/app/projects/${f.alpha.id}`, projectId: f.alpha.id,
      history: ownerConversation.messages });
    assert.deepEqual((f.requests[1]!.input as { history: unknown }).history, [], "client-carried teammate history cannot become server memory");
    assert.notEqual(bobReply.sourceId, reply.sourceId);
    assert.ok(!(await f.sessions.conversation(f.bob, f.alpha.id, f.guard(f.bob, f.alpha.id))).messageIds.includes(reply.sourceId!));
    const before = await f.rows(f.alice);
    await f.sessions.clearConversation(f.bob, f.alpha.id, f.guard(f.bob, f.alpha.id));
    assert.deepEqual(await f.rows(f.alice), before);
    assert.equal((await f.rows(f.alice)).find(item => item.id === reply.sourceId)?.content, reply.reply);
  } finally { await f.database.close(); }
});

test("clearing while the same account is answering rejects without deleting memory, then normal completion persists its sourceId", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined;
  let answering: ReturnType<typeof f.navigator.reply> | undefined;
  try {
    await f.append(f.alice, undefined, "保留中的问题", "保留中的回复");
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    f.setProvider(async () => {
      started(); await gate;
      return { content: { reply: "隔离耗时回复", linkIds: [] }, usage: { inputTokens: 100, outputTokens: 20 }, requestId: null, modelVersion: "retention-test-model" };
    });
    answering = f.navigator.reply(f.alice, { message: "处理这项工作", pagePath: "/events" });
    await entered;
    const before = await f.rows(f.alice);
    await assert.rejects(f.sessions.clearConversation(f.alice), { code: "DSH_SESSION_BUSY" });
    assert.deepEqual(await f.rows(f.alice), before);
    finish!(); const result = await answering;
    assert.equal((await f.rows(f.alice)).at(-1)?.id, result.sourceId);
    assert.equal((await f.rows(f.alice)).length, 4);
    await f.sessions.clearConversation(f.alice);
    assert.deepEqual(await f.rows(f.alice), []);
  } finally { finish?.(); if (answering) await Promise.allSettled([answering]); await f.database.close(); }
});

test("failed session guards and removed project membership cannot retrieve or delete scoped saved messages", async () => {
  const f = await fixture();
  try {
    await f.append(f.bob, f.alpha.id, "仍保存在数据库的私人问题", "本人已保存的回答");
    const before = await f.rows(f.bob);
    const revoked: FreshSessionGuard = async () => { throw new DomainError("UNAUTHENTICATED", "隔离会话已撤销", { status: 401 }); };
    await assert.rejects(f.sessions.conversation(f.bob, f.alpha.id, revoked), { code: "UNAUTHENTICATED" });
    await assert.rejects(f.sessions.clearConversation(f.bob, f.alpha.id, revoked), { code: "UNAUTHENTICATED" });
    const detail = await f.projects.getProject(f.alice, f.alpha.id);
    await f.projects.removeProjectMember(f.alice, f.alpha.id, f.bob.userId, detail.project.revision);
    await assert.rejects(f.sessions.conversation(f.bob, f.alpha.id, f.guard(f.bob, f.alpha.id)), { code: "PROJECT_UNAVAILABLE" });
    await assert.rejects(f.sessions.clearConversation(f.bob, f.alpha.id, f.guard(f.bob, f.alpha.id)), { code: "PROJECT_UNAVAILABLE" });
    assert.deepEqual(await f.rows(f.bob), before);
    await f.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [f.bob.userId]);
    await assert.rejects(f.sessions.conversation(f.bob), { code: "UNAUTHENTICATED" });
    await assert.rejects(f.sessions.clearConversation(f.bob), { code: "UNAUTHENTICATED" });
    assert.deepEqual(await f.rows(f.bob), before);
  } finally { await f.database.close(); }
});
