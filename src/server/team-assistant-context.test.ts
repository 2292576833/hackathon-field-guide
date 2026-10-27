import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { DomainError } from "../shared/errors.ts";
import type { Actor } from "../shared/contracts.ts";
import type { ParticipantProfile } from "../shared/participant.ts";
import { createTeamAssistantContextPorts, TEAM_ASSISTANT_CONTEXT_LIMITS,
  type AssistantProjectSource, type AssistantTaskSource, type AssistantPlanningSource,
  type AssistantOfficialRulesSource, type AssistantIntentionSource, type SharedAssistantAdviceSource,
  type TeamAssistantContextDependencies } from "./team-assistant-context.ts";

const at = "2026-10-09T12:00:00.000Z";
const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["user"] };
function task(id: string, patch: Partial<AssistantTaskSource> = {}): AssistantTaskSource {
  return { id, projectId: "p1", title: `任务 ${id}`, status: "todo", priority: "must", kind: "implementation",
    ownerMembershipId: "m1", reviewerMembershipId: "m2", deliverable: "可以演示的界面", acceptanceCriteria: ["可点击并看到结果"],
    dependencyTaskIds: [], blocker: null, revision: 1, updatedAt: at, acceptance: null, ...patch };
}
function project(projectId: string, userId = "alice"): AssistantProjectSource {
  const membership = { membershipId: projectId === "p1" ? "m1" : `m-${projectId}`, projectId, userId, role: "member" as const, status: "active", revision: 1 };
  return { project: { id: projectId, name: "会动的词卡", goal: "做一个词汇小游戏", minimumDeliverable: "答题、反馈、再次练习", stage: "active", timezone: "Asia/Shanghai", deadline: "2026-10-10T12:00:00.000Z", revision: 1 },
    membership, members: [membership, { membershipId: "m2", projectId, userId: "bob", role: "manager", status: "active", revision: 1 }] };
}
async function fixture() {
  const database = await createDatabase({});
  // A fresh isolated PostgreSQL engine, never the site's persistent directory.
  await database.query("CREATE TABLE auth_users(id text PRIMARY KEY,status text NOT NULL,email_verified_at timestamptz)");
  await database.query("CREATE TABLE personal_dsh_sessions(id text PRIMARY KEY,user_id text NOT NULL UNIQUE REFERENCES auth_users(id))");
  await database.query("CREATE TABLE personal_dsh_messages(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,session_id text NOT NULL REFERENCES personal_dsh_sessions(id),project_id text,role text NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL)");
  await database.query("INSERT INTO auth_users(id,status,email_verified_at) VALUES('alice','active',$1::timestamptz),('bob','active',$1::timestamptz)", [at]);
  await database.query("INSERT INTO personal_dsh_sessions(id,user_id) VALUES('session-alice','alice'),('session-bob','bob')");
  const projects = new Map<string, AssistantProjectSource>([["p1", project("p1")], ["other", project("other")], ["removed", project("removed")]]);
  projects.get("removed")!.membership.status = "removed";
  const intentions: AssistantIntentionSource[] = [{ userId: "bob", revision: 2, membershipRevision: 1, updatedAt: at, duties: ["presentation"] }];
  const mine = { projectId: "p1", needsConfirmation: false, intention: { userId: "alice", revision: 1, membershipRevision: 1, updatedAt: at,
    duties: ["design"], experience: "做过页面", helpQuestion: "希望分清工作", wantsAiHelp: true } };
  const current: AssistantPlanningSource = { plan: { id: "plan1", revision: 1, status: "applied" }, tasksRevision: 1, staleInputs: false, inputVersionsChanged: false,
    tasks: [task("mine", { status: "blocked", blocker: "等接口", dependencyTaskIds: ["api"] }), task("review", { status: "review", ownerMembershipId: "m2", reviewerMembershipId: "m1" }),
      task("api", { status: "in_progress", ownerMembershipId: "m2" })] };
  const participant: ParticipantProfile = { userId: "alice", revision: 1, firstHackathon: true, developmentExperience: "beginner", city: "上海", skills: ["CSS"], interests: ["游戏"],
    projectIdea: "练习交互", availableHoursPerDay: 3, presentationExperience: "none", travelPreference: "local", updatedAt: at };
  const rules: AssistantOfficialRulesSource = { eventId: "event", rulesVersion: 1, confirmationRevision: 1, latestPublishedRulesVersion: 1,
    catalog: { status: "confirmed", tracks: [{ id: "game", name: "游戏赛道", eligibility: { text: "可单人或组队" }, scoringFocus: { text: "可以试玩" } }] },
    requirements: [{ id: "demo", label: "可玩的 Demo", necessity: "required" }] };
  const advice: SharedAssistantAdviceSource[] = [{ id: "advice1", projectId: "p1", authorUserId: "bob", revision: 1, title: "减少功能", body: "先把一轮答题做通", status: "adopted", updatedAt: at, sourceKind: "space_assistant", sourceId: "response1", sourceRevision: 1 }];
  const recruiting = { userId: "alice", revision: 1, primaryRoles: ["design"], supportingRoles: ["frontend"], purposes: ["learn"], purposeNote: "练习协作",
    resume: "本人简历", workLinks: [{ title: "练习项目", url: "https://example.test/work" }], updatedAt: at,
    mbti: "NEVER_SEND_MBTI", age: 16, avatar: "NEVER_SEND_AVATAR", email: "private@example.test" };
  let afterCurrent: (() => Promise<void> | void) | null = null, membershipReads = 0, projectReads = 0, sessionActive = true, guardCalls = 0;
  let readFailure: Error | null = null, now = at;
  const deps: TeamAssistantContextDependencies = {
    database, clock: { now: () => new Date(now) },
    projects: {
      async getProject(actor, projectId) { projectReads++; const detail = projects.get(projectId);
        if (!detail || detail.membership.userId !== actor.userId || detail.membership.status !== "active") throw new DomainError("PROJECT_UNAVAILABLE", "no access", { status: 404 });
        return structuredClone(detail);
      },
      async getMembership(projectId, userId) { membershipReads++; if (readFailure) throw readFailure; const detail = projects.get(projectId);
        return detail && detail.membership.userId === userId ? structuredClone(detail.membership) : null; },
      async listProjects(actor) { return [...projects.values()].filter(item => item.membership.userId === actor.userId && item.membership.status === "active").map(item => structuredClone(item.project)); },
    },
    planning: { async getCurrent() { const result = structuredClone(current); await afterCurrent?.(); return result; }, async listProgress() { return [{ id: "progress1", projectId: "p1", taskId: "api", actorId: "bob", status: "in_progress", note: "已确定格式", blocker: null, evidenceRefs: [], createdAt: at }]; } },
    collaboration: { async getMyIntention() { return structuredClone(mine); }, async getSharedIntentions() { return { projectId: "p1", intentions: structuredClone(intentions) }; },
      async getOfficialTracks() { return { projectId: "p1", needsReview: false, selection: { eventId: "event", rulesVersion: 1, confirmationRevision: 1, trackId: "game", trackName: "游戏赛道", revision: 1, reason: "围绕试玩" } }; } },
    officialRules: { async getProjectTrackRules() { return structuredClone(rules); } }, participantProfiles: { async get() { return structuredClone(participant); } },
    recruiting: { async getPrivateProfile() { return structuredClone(recruiting); } }, teamCollaboration: { async readShared() { return structuredClone(advice); } },
  };
  const ports = createTeamAssistantContextPorts(deps);
  const guard = async () => { guardCalls++; if (!sessionActive) throw new DomainError("UNAUTHENTICATED", "session revoked", { status: 401 }); };
  const remember = async (owner: string, projectId: string | null, message: string, role = "user") => {
    const result = await database.query<{ id: string }>("INSERT INTO personal_dsh_messages(session_id,project_id,role,content,created_at) VALUES($1,$2,$3,$4,$5::timestamptz) RETURNING id::text", [`session-${owner}`, projectId, role, message, at]);
    return result.rows[0]!.id;
  };
  return { database, projects, current, mine, intentions, participant, rules, advice, recruiting, deps, ports, guard, remember,
    afterCurrent: (value: typeof afterCurrent) => { afterCurrent = value; }, revokeSession: () => { sessionActive = false; },
    failPermission: (value: Error | null) => { readFailure = value; }, clock: (value: string) => { now = value; },
    counts: () => ({ membershipReads, projectReads, guardCalls }),
    context: () => ports.context.read(alice, "p1", database, guard),
    memory: (question = "现在做什么", maxItems = 20, maxBytes = 16000) => ports.memory.select(alice, { projectId: "p1", question, maxItems, maxBytes }, database, guard),
  };
}
async function using(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(); try { await work(f); } finally { await f.database.close(); }
}

test("space context exposes actual own tasks, checks, dependencies, official rules and only deliberately shared peer fields", async () => using(async f => {
  const snapshot = await f.context(), facts = snapshot.facts;
  assert.equal((facts.project as { goal: string }).goal, "做一个词汇小游戏");
  assert.equal((facts.officialRules as { rulesVersion: number }).rulesVersion, 1);
  assert.equal((facts.myTasks as { id: string; status: string }[])[0]!.status, "blocked");
  assert.equal((facts.reviewTasks as { id: string }[])[0]!.id, "review");
  assert.equal((facts.dependencies as { id: string; status: string }[])[0]!.status, "in_progress");
  assert.equal((facts.sharedAdvice as { status: string }[])[0]!.status, "adopted");
  const peer = (facts.sharedIntentions as Record<string, unknown>[])[0]!;
  assert.deepEqual(peer.duties, ["presentation"]); assert.ok(!Object.hasOwn(peer, "experience"));
  assert.doesNotMatch(JSON.stringify(snapshot), /NEVER_SEND_MBTI|NEVER_SEND_AVATAR|private@example/);
  assert.equal((facts.ownProfile as { recruiting: { resume: string } }).recruiting.resume, "本人简历");
  assert.ok(snapshot.sources.some(item => item.id === "space-confirmed-rules"));
  assert.ok(snapshot.links.every(item => item.href.startsWith("/") && !item.href.startsWith("//")));
  assert.ok(f.counts().guardCalls >= 2);
}));

test("another account cannot read a space before any planning or personal memory is returned", async () => using(async f => {
  await assert.rejects(f.ports.context.read(bob, "p1", f.database), { code: "PROJECT_UNAVAILABLE" });
  await assert.rejects(f.ports.memory.select(bob, { projectId: "p1", question: "任务", maxItems: 12, maxBytes: 16000 }, f.database), { code: "PROJECT_UNAVAILABLE" });
}));

test("account suspension and revoked request session fail before context is revealed", async () => using(async f => {
  f.revokeSession(); await assert.rejects(f.context(), { code: "UNAUTHENTICATED" });
  await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='alice'");
  await assert.rejects(f.ports.context.read(alice, "p1", f.database), { code: "UNAUTHENTICATED" });
}));

test("membership and account are checked again after port reads in the sampling transaction", async () => using(async f => {
  f.afterCurrent(() => { f.projects.get("p1")!.membership.status = "removed"; });
  await assert.rejects(f.context(), { code: "PROJECT_UNAVAILABLE" });
  f.projects.get("p1")!.membership.status = "active";
  f.afterCurrent(async () => { await f.database.query("UPDATE auth_users SET status='suspended' WHERE id='alice'"); });
  await assert.rejects(f.context(), { code: "UNAUTHENTICATED" });
}));

test("archived current spaces do not produce new AI contexts", async () => using(async f => {
  f.projects.get("p1")!.project.stage = "archived";
  await assert.rejects(f.context(), { code: "PROJECT_ARCHIVED" });
}));

test("semantic context fingerprint ignores read-time refreshes and object property order", async () => using(async f => {
  const before = await f.context(); f.clock("2026-10-09T13:00:00.000Z");
  f.projects.get("p1")!.project = Object.fromEntries(Object.entries(f.projects.get("p1")!.project).reverse()) as AssistantProjectSource["project"];
  const after = await f.context(); assert.equal(before.fingerprint, after.fingerprint); assert.notEqual(before.capturedAt, after.capturedAt);
  await f.ports.context.assertCurrent(alice, before, f.database, f.guard);
}));

test("withdrawn advice is omitted and a reply citing its prior context cannot commit", async () => using(async f => {
  const snapshot = await f.context(); f.advice[0]!.status = "withdrawn"; f.advice[0]!.revision++;
  assert.deepEqual((await f.context()).facts.sharedAdvice, []);
  await assert.rejects(f.ports.context.assertCurrent(alice, snapshot, f.database, f.guard), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
}));

test("cancelling peer sharing, changing own profile or actual task state invalidates the previous answer basis", async () => using(async f => {
  let before = await f.context(); delete f.intentions[0]!.duties; f.intentions[0]!.revision++;
  await assert.rejects(f.ports.context.assertCurrent(alice, before, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
  before = await f.context(); f.participant.skills = ["Figma"]; f.participant.revision++;
  await assert.rejects(f.ports.context.assertCurrent(alice, before, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
  before = await f.context(); f.current.tasks[0]!.status = "review"; f.current.tasks[0]!.revision++;
  await assert.rejects(f.ports.context.assertCurrent(alice, before, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
}));

test("unknown missing plans are explicit and historical done flags without checks are not confirmed completion", async () => using(async f => {
  f.current.plan = null; f.current.tasks = [];
  let snapshot = await f.context(); assert.match(snapshot.missing.join(" "), /没有生效计划/); assert.equal((snapshot.facts.plan as { status: string }).status, "not_applied");
  f.current.tasks = [task("old", { status: "done", acceptance: null, ownerMembershipId: "m1" })];
  snapshot = await f.context(); assert.equal((snapshot.facts.myTasks as { checkedComplete: boolean }[])[0]!.checkedComplete, false);
  assert.match(snapshot.missing.join(" "), /缺少检查依据/);
}));

test("navigator inheritance is account-private and excludes sources without current active membership", async () => using(async f => {
  await f.remember("alice", null, "GLOBAL_ALLOWED"); await f.remember("alice", "p1", "CURRENT_ALLOWED", "assistant");
  await f.remember("alice", "other", "OTHER_ALLOWED"); await f.remember("alice", "removed", "REMOVED_FORBIDDEN"); await f.remember("bob", null, "OTHER_ACCOUNT_FORBIDDEN");
  const snapshot = await f.memory(); const text = JSON.stringify(snapshot.items);
  assert.match(text, /GLOBAL_ALLOWED/); assert.match(text, /CURRENT_ALLOWED/); assert.match(text, /OTHER_ALLOWED/);
  assert.doesNotMatch(text, /REMOVED_FORBIDDEN|OTHER_ACCOUNT_FORBIDDEN/); assert.equal(snapshot.coverage.retainedCount, 4);
  assert.match(snapshot.missing.join(" "), /无权访问/); assert.ok(f.counts().membershipReads > 0);
  assert.equal(f.counts().projectReads, 2, "other memory sources use read-only M02 access, not cross-space project write locks");
}));

test("source removal, role change and archive change during DSH invalidate inherited memory", async () => using(async f => {
  await f.remember("alice", "other", "本人以前的项目建议");
  let snapshot = await f.memory(); f.projects.get("other")!.membership.status = "removed";
  await assert.rejects(f.ports.memory.assertCurrent(alice, snapshot, f.database, f.guard), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
  f.projects.get("other")!.membership.status = "active"; snapshot = await f.memory(); f.projects.get("other")!.membership.role = "manager";
  await assert.rejects(f.ports.memory.assertCurrent(alice, snapshot, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
  snapshot = await f.memory(); f.projects.get("other")!.project.stage = "archived";
  await assert.rejects(f.ports.memory.assertCurrent(alice, snapshot, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
}));

test("full retained navigation storage is read only while selection remains bounded and Unicode safe", async () => using(async f => {
  await f.database.query("INSERT INTO personal_dsh_messages(session_id,project_id,role,content,created_at) SELECT 'session-alice',NULL,'user',$1,$2::timestamptz FROM generate_series(1,230)", ["界面🎮".repeat(600), at]);
  const snapshot = await f.memory("界面", 20, 16000);
  assert.equal(snapshot.coverage.retainedCount, 230); assert.ok(snapshot.items.length <= TEAM_ASSISTANT_CONTEXT_LIMITS.memoryItems);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.items)) <= 16000);
  for (const item of snapshot.items) { assert.ok(Buffer.byteLength(item.content) <= 1200); assert.doesNotMatch(item.content, /\p{Surrogate}/u); }
  assert.match(snapshot.coverage.description, /60 条相关或最近候选/);
  assert.equal(Number((await f.database.query<{ n: string }>("SELECT count(*) AS n FROM personal_dsh_messages")).rows[0]!.n), 230);
}));

test("a relevant older navigator entry wins over unrelated recent entries inside the explicit candidate window", async () => using(async f => {
  await f.remember("alice", null, "PPT 模板和演示结构是我现在要准备的内容");
  for (let i = 0; i < 8; i++) await f.remember("alice", null, `无关近期记录 ${i}`);
  const snapshot = await f.memory("PPT 模板", 1, 4000);
  assert.equal(snapshot.items.length, 1); assert.match(snapshot.items[0]!.content, /PPT 模板/);
  assert.ok(snapshot.items[0]!.createdAt); assert.ok(/^navigator:\d+$/.test(snapshot.items[0]!.id));
}));

test("bounded relevant lookup can inherit an old retained entry outside the most recent sixty messages", async () => using(async f => {
  await f.remember("alice", null, "PPT 模板是以前明确讨论过的准备方向");
  await f.database.query("INSERT INTO personal_dsh_messages(session_id,project_id,role,content,created_at) SELECT 'session-alice',NULL,'user','无关后来记录',$1::timestamptz FROM generate_series(1,100)", [at]);
  const snapshot = await f.memory("PPT 模板", 1, 4000);
  assert.equal(snapshot.coverage.retainedCount, 101); assert.equal(snapshot.items.length, 1);
  assert.match(snapshot.items[0]!.content, /以前明确讨论过/); assert.match(snapshot.coverage.description, /21 条相关或最近候选/);
}));

test("deleted or changed original navigator content cannot remain inherited as a current source", async () => using(async f => {
  const messageId = await f.remember("alice", null, "原始记忆"); let snapshot = await f.memory();
  await f.database.query("UPDATE personal_dsh_messages SET content='修改后记忆' WHERE id=$1::bigint", [messageId]);
  await assert.rejects(f.ports.memory.assertCurrent(alice, snapshot, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
  snapshot = await f.memory(); await f.database.query("DELETE FROM personal_dsh_messages WHERE id=$1::bigint", [messageId]);
  await assert.rejects(f.ports.memory.assertCurrent(alice, snapshot, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
}));

test("changes beyond the displayed memory excerpt also invalidate its stored-source fingerprint", async () => using(async f => {
  const messageId = await f.remember("alice", null, "字".repeat(1200) + "before"); const snapshot = await f.memory();
  await f.database.query("UPDATE personal_dsh_messages SET content=$2 WHERE id=$1::bigint", [messageId, "字".repeat(1200) + "after"]);
  await assert.rejects(f.ports.memory.assertCurrent(alice, snapshot, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
}));

test("adding an unrelated navigator record does not invalidate the selected immutable sources", async () => using(async f => {
  await f.remember("alice", null, "已选择的本人建议"); const snapshot = await f.memory();
  await f.remember("alice", null, "其他页面新问的问题");
  await f.ports.memory.assertCurrent(alice, snapshot, f.database, f.guard);
  await assert.rejects(f.ports.memory.assertCurrent(bob, snapshot, f.database), { code: "TEAM_ASSISTANT_CONTEXT_CHANGED" });
}));

test("permission provider errors and private/shared-source failures are not relabelled as empty data", async () => using(async f => {
  await f.remember("alice", "other", "本人历史"); f.failPermission(new Error("temporary database failure"));
  await assert.rejects(f.memory(), /temporary database failure/);
  f.failPermission(null); f.deps.teamCollaboration!.readShared = async () => { throw new Error("shared source read failure"); };
  await assert.rejects(f.context(), /shared source read failure/);
}));

test("large legitimate projects stay within context bytes and explicitly disclose shortened coverage", async () => using(async f => {
  f.current.tasks = Array.from({ length: 80 }, (_, index) => task(`many-${index}`, { title: "任务🎮".repeat(50), deliverable: "交付内容".repeat(600), acceptanceCriteria: Array.from({ length: 12 }, () => "检查条件".repeat(100)) }));
  f.advice.push(...Array.from({ length: 35 }, (_, index) => ({ ...f.advice[0]!, id: `advice-${index}`, body: "共享内容".repeat(800) })));
  const snapshot = await f.context(); assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= TEAM_ASSISTANT_CONTEXT_LIMITS.contextBytes);
  assert.ok((snapshot.facts.myTasks as unknown[]).length <= 12); assert.match(snapshot.missing.join(" "), /共有 80 项/);
}));

test("invalid memory bounds fail explicitly while valid no-history remains an explained empty memory", async () => using(async f => {
  const snapshot = await f.memory(); assert.deepEqual(snapshot.items, []); assert.equal(snapshot.coverage.retainedCount, 0); assert.match(snapshot.missing.join(" "), /没有可带入/);
  await assert.rejects(f.memory("任务", 0), { code: "TEAM_ASSISTANT_CONTEXT_INPUT_INVALID" });
  await assert.rejects(f.memory("任务", 12, 0), { code: "TEAM_ASSISTANT_CONTEXT_INPUT_INVALID" });
  await assert.rejects(f.memory("x".repeat(6001)), { code: "TEAM_ASSISTANT_CONTEXT_INPUT_INVALID" });
}));

test("the composed convenience read runs both actual context and navigator memory in one isolated transaction", async () => using(async f => {
  await f.remember("alice", null, "本人喜欢把任务拆小");
  const snapshot = await f.ports.read(alice, "p1", "任务", f.guard);
  assert.equal(snapshot.context.projectId, "p1"); assert.equal(snapshot.memory.items.length, 1); assert.match(snapshot.memory.items[0]!.content, /本人喜欢/);
}));

test("planning version locks precede the first project read and reuse the actor's sampling transaction for context and memory", async () => using(async f => {
  const readProject = f.deps.projects.getProject;
  await f.database.transaction(async sql => {
    let versionsLocked = false;
    const order: string[] = [];
    const ports = createTeamAssistantContextPorts({ ...f.deps,
      planningFacts: { async lockVersions(projectId, transaction, actor) {
        assert.equal(projectId, "p1"); assert.equal(actor, alice); assert.equal(transaction, sql);
        assert.equal(order.length, 0, "a project read must not acquire its write lock before M04/M05 version locks");
        const account = await transaction.query<{ id: string }>("SELECT id FROM auth_users WHERE id=$1", [actor.userId]);
        assert.equal(account.rows[0]!.id, alice.userId);
        order.push("versions"); versionsLocked = true;
        return { projectRevision: 1, requirementVersionId: null, assignmentVersionId: null, availabilityVersions: {} };
      } },
      projects: { ...f.deps.projects, async getProject(actor, projectId) {
        assert.ok(versionsLocked, "space reads must protect planning versions before entering the project transaction");
        order.push("project"); return readProject(actor, projectId);
      } },
    });
    const guard = async (transaction: typeof sql) => { assert.equal(transaction, sql); await f.guard(); };
    await ports.context.read(alice, "p1", sql, guard);
    assert.deepEqual(order, ["versions", "project", "project"]);
    order.length = 0; versionsLocked = false;
    await ports.memory.select(alice, { projectId: "p1", question: "任务", maxItems: 12, maxBytes: 16000 }, sql, guard);
    assert.deepEqual(order, ["versions", "project", "project"]);
  });
}));
