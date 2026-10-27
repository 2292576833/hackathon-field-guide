import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact } from "../../shared/personal-ai.ts";
import { DomainError } from "../../shared/errors.ts";
import type { TeamAssistantDshRequest, TeamAssistantDshRunnerPort } from "./ports.ts";
import { FEASIBILITY_OUTPUT_EXAMPLE } from "./generation.ts";
import { createTeamAssistantService } from "./service.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] }, bob: Actor = { userId: "bob", platformRoles: ["user"] };
async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await work(f); } finally { await f.db.close(); }
}
async function setup() {
  const db = new PGlite();
  await db.exec("CREATE TABLE auth_users(id text PRIMARY KEY); CREATE TABLE projects_project(id text PRIMARY KEY); INSERT INTO auth_users VALUES('alice'),('bob'); INSERT INTO projects_project VALUES('one'),('two');");
  await db.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  const adapter = (executor: Pick<PGlite, "query">): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []) { const result = await executor.query<Row>(statement, [...parameters]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } });
  const database: DatabasePort = { ...adapter(db), transaction: work => db.transaction(sql => work(adapter(sql as unknown as PGlite))) };
  let serial = 0, now = new Date("2026-10-09T08:00:00Z"), contextVersion = "context-1", memoryVersion = "memory-1", access = true, archive = false, sourceAccess = true, configured = true;
  let onRun: (() => Promise<void>) | null = null, onGenerate: (() => Promise<void>) | null = null, answerContent = "先做最小演示，请队友检查运行记录。";
  const requests: TeamAssistantDshRequest<unknown>[] = [], artifacts: PersonalArtifact[] = [];
  const check = () => { if (!access) throw new DomainError("PROJECT_ACCESS_DENIED", "已退出空间", { status: 403 }); };
  const runner: TeamAssistantDshRunnerPort = {
    get configured() { return configured; },
    async run<T>(actor: Actor, request: TeamAssistantDshRequest<T>, guard?: FreshSessionGuard) {
      requests.push(request); await onRun?.();
      const data = request.validate({ reply: answerContent, linkIds: ["tasks"] });
      await database.transaction(async sql => { await guard?.(sql); await request.finalGuard(sql); });
      return { executionId: `reply-${++serial}`, provider: "dsh", data };
    },
  };
  const personalAi: PersonalAiPort = {
    async generate(actor, request, guard) {
      await database.transaction(async sql => guard?.(sql)); await onGenerate?.();
      const data = request.validate(FEASIBILITY_OUTPUT_EXAMPLE);
      await database.transaction(async sql => guard?.(sql));
      const artifact = { id: `report-${++serial}`, kind: request.kind, title: request.title, data, createdAt: now.toISOString(), provider: "dsh" as const, sessionId: `session-${actor.userId}` };
      artifacts.push(artifact); return artifact;
    },
    async list(actor, kind, guard) { await database.transaction(async sql => guard?.(sql)); return artifacts.filter(a => a.kind === kind && a.sessionId === `session-${actor.userId}`); },
    async get(actor, id, guard) { await database.transaction(async sql => guard?.(sql)); const artifact = artifacts.find(a => a.id === id && a.sessionId === `session-${actor.userId}`); if (!artifact) throw new DomainError("ARTIFACT_NOT_FOUND", "不存在", { status: 404 }); return artifact; },
  };
  const service = createTeamAssistantService({ database, clock: { now: () => now }, ids: { next: () => `id-${++serial}` }, runner, personalAi,
    context: {
      async read(actor, projectId) { check(); return { projectId, fingerprint: contextVersion, facts: { project: { name: "真实项目", goal: "做出一个可演示流程" }, ownRole: actor.userId === "alice" ? "前端" : "演示", sharedAdvice: "当前有效的共同建议" }, sources: [{ id: "official", label: "已确认规则" }], missing: ["未提供实际运行记录"], links: [{ id: "tasks", label: "团队任务", href: `/projects/${projectId}/planning` }, { id: "private", label: "禁止外链", href: "https://evil.test" }], capturedAt: now.toISOString() }; },
      async assertCurrent(_actor, snapshot) { check(); if (archive) throw new DomainError("PROJECT_ARCHIVED", "空间只读", { status: 409 }); if (snapshot.fingerprint !== contextVersion) throw new DomainError("ASSISTANT_CONTEXT_CHANGED", "资料已变", { status: 409 }); },
    },
    memory: {
      async select(actor) { return { fingerprint: `${memoryVersion}-${sourceAccess ? "allowed" : "revoked"}`, items: sourceAccess ? [{ id: `memory-${actor.userId}`, kind: "navigator" as const, content: `${actor.userId}本人导航记忆：偏好短步骤`, projectId: "two", createdAt: now.toISOString() }] : [], coverage: { retainedCount: 200, selectedCount: sourceAccess ? 1 : 0, description: "完整历史保留，本次只选择有权读取的本人记忆" }, sources: sourceAccess ? [{ id: `memory-${actor.userId}`, label: "本人导航记录" }] : [], missing: ["没有读取所有历史"] }; },
      async assertCurrent(_actor, snapshot) { if (!sourceAccess && snapshot.items.length) throw new DomainError("PROJECT_ACCESS_DENIED", "历史来源已撤权", { status: 403 }); if (snapshot.fingerprint !== `${memoryVersion}-${sourceAccess ? "allowed" : "revoked"}`) throw new DomainError("ASSISTANT_MEMORY_CHANGED", "记忆已变", { status: 409 }); },
    },
  });
  return { db, database, service, requests, artifacts, setContext: (value: string) => { contextVersion = value; }, setMemory: (value: string) => { memoryVersion = value; }, setAccess: (value: boolean) => { access = value; }, setArchive: (value: boolean) => { archive = value; }, setSourceAccess: (value: boolean) => { sourceAccess = value; }, setConfigured: (value: boolean) => { configured = value; }, setRun: (value: (() => Promise<void>) | null) => { onRun = value; }, setAnswer: (value: string) => { answerContent = value; }, setGenerate: (value: (() => Promise<void>) | null) => { onGenerate = value; }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
function hasCode(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

test("private space dialogue inherits only own bounded memory and saves real provider/source", async () => fixture(async f => {
  const answer = await f.service.send(alice, "one", { message: "我的下一步？", requestId: "ask-1", expectedRevision: 0 });
  assert.equal(answer.provider, "dsh"); assert.equal(answer.message.id, "reply-1"); assert.equal(answer.revision, 2);
  assert.equal(answer.message.coverage?.memory.retainedCount, 200);
  const input = f.requests[0]!.input as { memory: { content: string }[]; allowedLinks: unknown[] };
  assert.match(input.memory[0]!.content, /alice本人/); assert.equal(input.allowedLinks.length, 1);
  assert.equal((await f.service.conversation(alice, "one")).messages.length, 2);
  assert.equal((await f.service.conversation(bob, "one")).messages.length, 0);
  assert.equal((await f.service.conversation(alice, "two")).messages.length, 0);
  assert.equal((await f.service.getShareSource(alice, "one", "space_assistant", answer.message.id)).content, answer.message.content);
  await assert.rejects(f.service.getShareSource(bob, "one", "space_assistant", answer.message.id), hasCode("ASSISTANT_SOURCE_NOT_FOUND"));
  await assert.rejects(f.service.getShareSource(alice, "two", "space_assistant", answer.message.id), hasCode("ASSISTANT_SOURCE_NOT_FOUND"));
}));
test("same requestId replays saved response, never another model call; changed payload conflicts", async () => fixture(async f => {
  const first = await f.service.send(alice, "one", { message: "检查成果", requestId: "same", expectedRevision: 0 });
  const second = await f.service.send(alice, "one", { message: "检查成果", requestId: "same", expectedRevision: 0 });
  assert.deepEqual(first, second); assert.equal(f.requests.length, 1);
  await assert.rejects(f.service.send(alice, "one", { message: "更换内容", requestId: "same", expectedRevision: 2 }), hasCode("ASSISTANT_REQUEST_ID_REUSED"));
}));
test("only explicit DSH requests run models; no configuration never creates fake answer", async () => fixture(async f => {
  f.setConfigured(false); await f.service.getContext(alice, "one"); const conversation = await f.service.conversation(alice, "one");
  assert.equal(conversation.configured, false); assert.equal(f.requests.length, 0);
  await assert.rejects(f.service.send(alice, "one", { message: "问题", requestId: "ask", expectedRevision: 0 }), hasCode("DSH_NOT_CONFIGURED"));
  assert.equal((await f.service.conversation(alice, "one")).messages.length, 0);
}));
test("revocation, changed facts/memory and archival while responding stop saved success", async () => {
  for (const mutate of [(f: Awaited<ReturnType<typeof setup>>) => f.setAccess(false), (f: Awaited<ReturnType<typeof setup>>) => f.setContext("changed"), (f: Awaited<ReturnType<typeof setup>>) => f.setMemory("changed"), (f: Awaited<ReturnType<typeof setup>>) => f.setSourceAccess(false), (f: Awaited<ReturnType<typeof setup>>) => f.setArchive(true)]) await fixture(async f => {
    f.setRun(async () => mutate(f));
    await assert.rejects(f.service.send(alice, "one", { message: "给下一步", requestId: "ask", expectedRevision: 0 }));
    assert.equal((await f.database.query("SELECT id FROM team_assistant_messages")).rowCount, 0);
  });
});
test("unknown calls survive clearing, changing versions, IDs, and passing time; other questions may run", async () => fixture(async f => {
  f.setRun(async () => { throw new Error("network response unknown"); });
  await assert.rejects(f.service.send(alice, "one", { message: "同一问题", requestId: "ask", expectedRevision: 0 }));
  let c = await f.service.conversation(alice, "one"); assert.equal(c.pending?.status, "unknown"); assert.equal(c.pending?.message, "同一问题");
  await f.service.clearConversation(alice, "one", c.revision); f.advance(86400000); f.setContext("later-facts"); f.setMemory("later-memory");
  c = await f.service.conversation(alice, "one");
  await assert.rejects(f.service.send(alice, "one", { message: "同一问题", requestId: "different", expectedRevision: c.revision }), hasCode("AI_PREVIOUS_REQUEST_UNKNOWN"));
  assert.equal(f.requests.length, 1);
  f.setRun(null); await f.service.send(alice, "one", { message: "不同新问题", requestId: "new-question", expectedRevision: c.revision }); assert.equal(f.requests.length, 2);
}));
test("safe not_sent failures may be explicitly requested again with a new ID", async () => fixture(async f => {
  f.setRun(async () => { throw Object.assign(new Error("no dispatch"), { externalState: "not_sent", code: "AI_BUDGET_EXCEEDED" }); });
  await assert.rejects(f.service.send(alice, "one", { message: "问题", requestId: "ask", expectedRevision: 0 }));
  const c = await f.service.conversation(alice, "one"); assert.equal(c.pending?.status, "failed");
  f.setRun(null); await f.service.send(alice, "one", { message: "问题", requestId: "ask-2", expectedRevision: c.revision }); assert.equal(f.requests.length, 2);
}));
test("busy dialogues cannot be cleared or double-sent; request locks expire to unknown", async () => fixture(async f => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  f.setRun(async () => { started(); await waiting; });
  const first = f.service.send(alice, "one", { message: "问题", requestId: "ask", expectedRevision: 0 }); await began;
  let c = await f.service.conversation(alice, "one"); assert.equal(c.pending?.status, "running");
  await assert.rejects(f.service.clearConversation(alice, "one", c.revision), hasCode("ASSISTANT_BUSY"));
  await assert.rejects(f.service.send(alice, "one", { message: "另一问", requestId: "other", expectedRevision: c.revision }), hasCode("ASSISTANT_BUSY"));
  f.advance(300001); c = await f.service.conversation(alice, "one"); assert.equal(c.pending?.status, "unknown");
  release(); await assert.rejects(first, hasCode("ASSISTANT_REQUEST_CHANGED")); assert.equal((await f.service.conversation(alice, "one")).messages.length, 0);
}));
test("fresh request sessions are checked before and during final persistence", async () => fixture(async f => {
  let active = true, checks = 0;
  const guard = async () => { checks++; if (!active) throw new DomainError("UNAUTHENTICATED", "会话过期", { status: 401 }); };
  f.setRun(async () => { active = false; });
  await assert.rejects(f.service.send(alice, "one", { message: "给下一步", requestId: "ask", expectedRevision: 0 }, guard), hasCode("UNAUTHENTICATED"));
  assert.ok(checks >= 3); assert.equal((await f.database.query("SELECT id FROM team_assistant_messages")).rowCount, 0);
}));
test("changed shared inputs are not sent again from old paired chat history", async () => fixture(async f => {
  await f.service.send(alice, "one", { message: "旧共享建议相关问题", requestId: "ask", expectedRevision: 0 });
  f.setContext("shared-withdrawn"); await f.service.send(alice, "one", { message: "新下一步", requestId: "ask-2", expectedRevision: 2 });
  assert.deepEqual((f.requests[1]!.input as { history: unknown }).history, []);
}));
test("source-project memory revocation excludes derived old answers from later turns even when space facts stay current", async () => fixture(async f => {
  f.setAnswer("旧来源项目的私有交接信息");
  const first = await f.service.send(alice, "one", { message: "结合其他项目记忆给建议", requestId: "ask", expectedRevision: 0 });
  assert.equal(first.message.coverage?.contextFingerprint, "context-1");
  f.setSourceAccess(false); f.setAnswer("只使用当前空间授权事实给下一步。");
  await f.service.send(alice, "one", { message: "当前空间现在先做什么", requestId: "later", expectedRevision: 2 });
  const input = f.requests[1]!.input as { history: unknown[]; memory: unknown[] };
  assert.deepEqual(input.history, []); assert.deepEqual(input.memory, []);
  assert.doesNotMatch(JSON.stringify(input), /旧来源项目的私有交接信息/);
}));
test("memory revision changes exclude old paired dialogue while the space context remains unchanged", async () => fixture(async f => {
  f.setAnswer("根据此前记忆生成的旧建议");
  const first = await f.service.send(alice, "one", { message: "使用我的记忆", requestId: "ask", expectedRevision: 0 });
  assert.equal(first.message.coverage?.contextFingerprint, "context-1");
  f.setMemory("memory-edited"); f.setAnswer("根据本次记忆生成的新建议");
  const second = await f.service.send(alice, "one", { message: "请用最新资料给下一步", requestId: "later", expectedRevision: 2 });
  assert.equal(second.message.coverage?.contextFingerprint, first.message.coverage?.contextFingerprint);
  assert.notEqual(second.message.coverage?.memoryFingerprint, first.message.coverage?.memoryFingerprint);
  const input = f.requests[1]!.input as { history: unknown[] };
  assert.deepEqual(input.history, []); assert.doesNotMatch(JSON.stringify(input), /根据此前记忆生成的旧建议/);
}));
test("reports use personal_ai project_feasibility, stay private/per-space, indicate stale, never adopt", async () => fixture(async f => {
  const report = await f.service.generateFeasibility(alice, "one", { idea: "做一个简单演示", expectedContextFingerprint: "context-1" });
  assert.equal(report.provider, "dsh"); assert.equal(report.stale, false); assert.equal(f.artifacts[0]!.kind, "project_feasibility");
  assert.equal((await f.service.listFeasibility(bob, "one")).length, 0); assert.equal((await f.service.listFeasibility(alice, "two")).length, 0);
  const source = await f.service.getShareSource(alice, "one", "feasibility", report.id); assert.match(source.content, /待验证/);
  await assert.rejects(f.service.getShareSource(alice, "two", "feasibility", report.id), hasCode("ASSISTANT_SOURCE_NOT_FOUND"));
  f.setContext("new-facts"); assert.equal((await f.service.listFeasibility(alice, "one"))[0]!.stale, true);
  assert.equal((await f.database.query("SELECT id FROM team_assistant_messages")).rowCount, 0);
  await assert.rejects(f.service.getShareSource(alice, "one", "feasibility", report.id), hasCode("ASSISTANT_REPORT_STALE"));
  await assert.rejects(f.service.generateFeasibility(alice, "one", { idea: "新选题", expectedContextFingerprint: "context-1" }), hasCode("ASSISTANT_CONTEXT_CHANGED"));
}));
test("report facts changing during generation fail final guard before private artifact is saved", async () => fixture(async f => {
  f.setGenerate(async () => f.setContext("changed"));
  await assert.rejects(f.service.generateFeasibility(alice, "one", { idea: "想法", expectedContextFingerprint: "context-1" }), hasCode("ASSISTANT_CONTEXT_CHANGED"));
  assert.equal(f.artifacts.length, 0);
}));
test("revision conflicts preserve conversation and clear affects only own space", async () => fixture(async f => {
  await f.service.send(alice, "one", { message: "问题", requestId: "ask", expectedRevision: 0 });
  await f.service.send(bob, "one", { message: "我的问题", requestId: "ask", expectedRevision: 0 });
  await assert.rejects(f.service.clearConversation(alice, "one", 0), hasCode("ASSISTANT_REVISION_CONFLICT"));
  await f.service.clearConversation(alice, "one", 2);
  assert.equal((await f.service.conversation(alice, "one")).messages.length, 0); assert.equal((await f.service.conversation(bob, "one")).messages.length, 2);
  await assert.rejects(f.service.send(alice, "one", { message: "问题", requestId: "ask", expectedRevision: 3 }), hasCode("ASSISTANT_CONVERSATION_CLEARED"));
}));
