import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { createModelRoleHelp } from "./role-help-model.ts";
import { createRoleHelpHttpHandlers, createRoleHelpRegistration, RoleHelpService } from "./role-help.ts";
import type { JsonModelPort } from "./ports.ts";
import type { AssignmentContextSnapshot } from "./types.ts";

// Real isolated embedded PostgreSQL; identity/model providers are explicit fixtures.
const ALICE: Actor = { userId: "alice", platformRoles: ["user"] };
const BOB: Actor = { userId: "bob", platformRoles: ["user"] };
const OUTSIDER: Actor = { userId: "outsider", platformRoles: ["admin"] };
const ANSWERS = { experience: "PRIVATE_ROLE_EXPERIENCE", interests: "想试试文档和界面", constraints: "PRIVATE_ROLE_CONSTRAINT" };
const OUTPUT = { suggestions: [{ taskDimension: "documentation", title: "写一页作品说明", deliverable: "队友可以直接使用的一页说明", reason: "可以从熟悉的文字整理开始", firstStep: "先列三条使用步骤" }], missingInformation: ["还需要核对提交材料"], limitations: ["这是愿意尝试的任务建议，不是能力测评"] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function code(expected: string) { return (error: unknown) => { assert.ok(error instanceof DomainError); assert.equal(error.code, expected); return true; }; }
function baseContext(): AssignmentContextSnapshot {
  return { projectId: "role-project", stage: "active", readOnly: false, projectRevision: 1, membershipRevision: 1, requirementVersionId: "rules:1",
    trackSelectionRevision: 1, memberIntentionRefs: [{ membershipId: "pm-alice", revision: 1 }], confirmedRequirements: [{ id: "intro", text: "作品说明", evidenceIds: ["evidence-1"] }],
    officialTracks: { eventId: "event-1", rulesVersion: 1, confirmationRevision: 1, catalogStatus: "confirmed", selectedTrackId: "official-agent", needsReview: false,
      tracks: [{ id: "official-agent", name: "主办方 Agent 赛道", eligibility: null, scoringFocus: { text: "演示可用性", evidenceIds: ["evidence-1"] }, deliverables: [{ requirementId: "intro", evidenceIds: ["evidence-1"] }], evidenceIds: ["evidence-1"] }], evidenceIds: ["evidence-1"] },
    members: [
      { membershipId: "pm-alice", userId: "alice", role: "member", status: "active", memberAvailabilityVersionId: "time-alice-1", availableMinutes: 120,
        sharedIntention: { revision: 1, membershipRevision: 1, duties: ["documentation", "design"], experience: "SHARED_EXPERIENCE" } },
      { membershipId: "pm-bob", userId: "bob", role: "manager", status: "active", memberAvailabilityVersionId: null, availableMinutes: null,
        sharedIntention: { revision: 2, membershipRevision: 1, experience: "BOB_OTHER_MEMBER_EXPERIENCE" } },
    ] };
}
let engine: PGlite; let database: DatabasePort; let serial = 0;
before(async () => {
  engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./sql/005-assessment-role-help.sql", import.meta.url), "utf8"));
  await engine.exec("CREATE TABLE role_help_test_context (project_id text PRIMARY KEY,data jsonb NOT NULL)");
  // Serialize independent connections in this in-memory PostgreSQL test only.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => { const next = tail.then(work); tail = next.then(() => undefined, () => undefined); return next; };
  database = {
    query: <Row>(statement: string, parameters: readonly unknown[] = []) => serialize(async () => { const result = await engine.query(statement, [...parameters]); return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length }; }),
    transaction: <T>(work: (sql: SqlExecutor) => Promise<T>) => serialize(() => engine.transaction(async (transaction) => {
      const sql: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) { const result = await transaction.query(statement, [...parameters]); return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length }; } };
      return work(sql);
    })),
  };
});
beforeEach(async () => { await engine.exec("TRUNCATE assessments_role_help_jobs,role_help_test_context"); await database.query("INSERT INTO role_help_test_context VALUES($1,$2::jsonb)", ["role-project", JSON.stringify(baseContext())]); });
after(async () => { await engine?.close(); });

function harness(options: { timeoutMs?: number; noModel?: boolean } = {}) {
  const calls: { request: Parameters<JsonModelPort["completeJSON"]>[0]; signal: AbortSignal }[] = [];
  let responder: (signal: AbortSignal) => unknown | Promise<unknown> = () => OUTPUT;
  let now = Date.parse("2026-10-09T04:00:00Z"); let accountEnabled = true;
  const ids = { next: () => `role-test-${++serial}` };
  const jsonModel: JsonModelPort = { modelVersion: "explicit-role-help-fixture", async completeJSON(request, signal) {
    calls.push({ request: structuredClone(request), signal }); return { content: await responder(signal), usage: null, requestId: "fixture", modelVersion: "trusted-response-model" };
  } };
  const optionsForService = { database, clock: { now: () => new Date(now) }, ids, modelTimeoutMs: options.timeoutMs ?? 2000,
    assignmentContext: { async getSnapshot(projectId: string, sql?: SqlExecutor) {
      assert.ok(sql, "must reuse the project transaction"); const result = await sql.query<{ data: AssignmentContextSnapshot }>("SELECT data FROM role_help_test_context WHERE project_id=$1 FOR SHARE", [projectId]);
      assert.ok(result.rows[0]); return result.rows[0].data;
    } }, assertActor: async (_actor: Actor, _sql: SqlExecutor) => { if (!accountEnabled) throw new DomainError("UNAUTHENTICATED", "账号已不可用。", { status: 401 }); },
    ...(options.noModel ? {} : { model: createModelRoleHelp({ model: jsonModel }) }) };
  const service = new RoleHelpService(optionsForService);
  const handlers = createRoleHelpHttpHandlers({ service, requestIds: ids, resolveActor: async (request) => request.headers.get("X-Fixture-Actor") === "alice" ? ALICE : null });
  return { service, calls, handlers, optionsForService, setResponder: (next: typeof responder) => { responder = next; }, advance: (ms: number) => { now += ms; }, revokeAccount: () => { accountEnabled = false; },
    change: async (update: (context: AssignmentContextSnapshot) => AssignmentContextSnapshot) => database.transaction(async (sql) => {
      const result = await sql.query<{ data: AssignmentContextSnapshot }>("SELECT data FROM role_help_test_context WHERE project_id=$1 FOR UPDATE", ["role-project"]);
      await sql.query("UPDATE role_help_test_context SET data=$2::jsonb WHERE project_id=$1", ["role-project", JSON.stringify(update(result.rows[0]!.data))]);
    }) };
}
async function count() { return Number((await database.query<{ total: number }>("SELECT count(*)::integer AS total FROM assessments_role_help_jobs")).rows[0]!.total); }

test("member without assessment can queue private help; durable idempotency survives service recreation and concurrent POST", async () => {
  const h = harness(); const [left, right] = await Promise.all([h.service.queue(ALICE, "role-project", ANSWERS, "same"), h.service.queue(ALICE, "role-project", ANSWERS, "same")]);
  assert.equal(left.id, right.id); assert.equal(left.idempotencyKey, "same"); assert.equal(await count(), 1);
  const restarted = new RoleHelpService(h.optionsForService);
  assert.equal((await restarted.queue(ALICE, "role-project", ANSWERS, "same")).id, left.id);
  await assert.rejects(restarted.queue(ALICE, "role-project", { ...ANSWERS, interests: "different" }, "same"), code("IDEMPOTENCY_CONFLICT"));
  assert.equal(h.calls.length, 0, "queue is not a provider dispatch");
});
test("single atomic claim creates one private suggestion and never writes team intentions", async () => {
  const h = harness(); const job = await h.service.queue(ALICE, "role-project", ANSWERS, "claim");
  const results = await Promise.all([h.service.execute(job.id), h.service.execute(job.id)]);
  assert.ok(results.some((result) => result.status === "succeeded")); assert.equal(h.calls.length, 1);
  const view = await h.service.getJob(ALICE, job.id); assert.equal(view.result?.modelVersion, "trusted-response-model"); assert.equal(view.inputFreshness, "current");
  assert.equal(view.result?.suggestions[0]?.taskDimension, "documentation");
  const raw = JSON.stringify(view); assert.equal(raw.includes("PRIVATE_ROLE"), false); assert.equal(raw.includes("answers"), false);
  assert.equal(JSON.stringify(await h.service.listQueued(10)).includes("PRIVATE_ROLE"), false);
  assert.equal((await database.query<{ data: AssignmentContextSnapshot }>("SELECT data FROM role_help_test_context")).rows[0]!.data.members[0]!.sharedIntention!.revision, 1);
});
test("help model receives current official facts and own answers; no other member identity or shared/private profile", async () => {
  const h = harness(); const job = await h.service.queue(ALICE, "role-project", ANSWERS, "privacy"); await h.service.execute(job.id);
  const sent = JSON.stringify(h.calls[0]!.request.input); assert.ok(sent.includes("主办方 Agent 赛道")); assert.ok(sent.includes("PRIVATE_ROLE_EXPERIENCE")); assert.ok(sent.includes("SHARED_EXPERIENCE"));
  for (const forbidden of ["BOB_OTHER_MEMBER_EXPERIENCE", "pm-alice", "pm-bob", '"userId"', "summaries", "criterionScores"]) assert.equal(sent.includes(forbidden), false, forbidden);
  assert.ok(h.calls[0]!.request.systemPrompt.includes("不使用工具"));
});
test("manager and platform admin cannot read someone else's private job; departed original membership loses access", async () => {
  const h = harness(); const job = await h.service.queue(ALICE, "role-project", ANSWERS, "owner");
  await assert.rejects(h.service.getJob(BOB, job.id), code("NOT_FOUND")); await assert.rejects(h.service.getJob(OUTSIDER, job.id), code("NOT_FOUND"));
  await assert.rejects(h.service.getLatest(OUTSIDER, "role-project"), code("FORBIDDEN")); assert.equal((await h.service.getLatest(BOB, "role-project")).job, null);
  await h.change((context) => ({ ...context, members: context.members.map((member) => member.userId === "alice" ? { ...member, membershipId: "rejoined-alice" } : member) }));
  await assert.rejects(h.service.getJob(ALICE, job.id), code("FORBIDDEN")); assert.equal((await h.service.getLatest(ALICE, "role-project")).job, null);
});
test("latest and job GET are read-only, return request key for unknown POST reconciliation, and do not dispatch", async () => {
  const h = harness(); assert.equal((await h.service.getLatest(ALICE, "role-project")).job, null); assert.equal(await count(), 0);
  const job = await h.service.queue(ALICE, "role-project", ANSWERS, "saved-request");
  assert.equal((await h.service.getLatest(ALICE, "role-project")).job!.idempotencyKey, "saved-request");
  await h.service.getJob(ALICE, job.id); assert.equal(h.calls.length, 0); assert.equal(await count(), 1);
});

const changes: readonly [string, (context: AssignmentContextSnapshot) => AssignmentContextSnapshot][] = [
  ["official rule revision", (c) => ({ ...c, officialTracks: { ...c.officialTracks!, rulesVersion: 2 } })],
  ["track selection", (c) => ({ ...c, trackSelectionRevision: 2 })],
  ["shared intention withdrawal", (c) => ({ ...c, memberIntentionRefs: [{ membershipId: "pm-alice", revision: 2 }], members: c.members.map((m) => m.userId === "alice" ? { ...m, sharedIntention: { revision: 2, membershipRevision: 1 } } : m) })],
  ["available time", (c) => ({ ...c, members: c.members.map((m) => m.userId === "alice" ? { ...m, availableMinutes: 30 } : m) })],
];
for (const [name, change] of changes) for (const phase of ["queued", "running"] as const) test(`${phase} ${name} rejects outdated suggestion`, async () => {
  const h = harness(); const entered = deferred<void>(); const output = deferred<unknown>(); h.setResponder(() => { entered.resolve(); return output.promise; });
  const job = await h.service.queue(ALICE, "role-project", ANSWERS, `stale-${name}-${phase}`);
  let work: ReturnType<RoleHelpService["execute"]> | undefined;
  if (phase === "running") { work = h.service.execute(job.id); await entered.promise; }
  await h.change(change); output.resolve(OUTPUT);
  const failed = await (work ?? h.service.execute(job.id)); assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "ASSIGNMENT_INPUT_CHANGED");
  assert.equal(h.calls.length, phase === "queued" ? 0 : 1); const view = await h.service.getJob(ALICE, job.id); assert.equal(view.result, null); assert.equal(view.inputFreshness, "changed");
});
test("archive forbids dispatch/new help while allowing own historical reads", async () => {
  const h = harness(); const job = await h.service.queue(ALICE, "role-project", ANSWERS, "archive");
  await h.change((c) => ({ ...c, stage: "archived", readOnly: true }));
  assert.equal((await h.service.execute(job.id)).failureCode, "PROJECT_READ_ONLY"); assert.equal(h.calls.length, 0);
  await assert.rejects(h.service.queue(ALICE, "role-project", ANSWERS, "archive-new"), code("PROJECT_READ_ONLY"));
  assert.equal((await h.service.getJob(ALICE, job.id)).status, "failed");
});
test("account revocation and membership loss during model run prevent late private result commit", async () => {
  for (const kind of ["account", "membership"]) {
    const h = harness(); const entered = deferred<void>(); const output = deferred<unknown>(); h.setResponder(() => { entered.resolve(); return output.promise; });
    const job = await h.service.queue(ALICE, "role-project", ANSWERS, `loss-${kind}`); const work = h.service.execute(job.id); await entered.promise;
    if (kind === "account") h.revokeAccount(); else await h.change((c) => ({ ...c, members: c.members.map((m) => m.userId === "alice" ? { ...m, status: "left" } : m) }));
    output.resolve(OUTPUT); assert.equal((await work).failureCode, kind === "account" ? "UNAUTHENTICATED" : "FORBIDDEN");
    assert.equal((await database.query<{ data: { result: unknown } }>("SELECT data FROM assessments_role_help_jobs WHERE id=$1", [job.id])).rows[0]!.data.result, null);
    if (kind === "membership") await h.change(() => baseContext());
  }
});
test("unknown paid response keeps safe failure and one dispatch; GET/recover/replay cannot automatically retry", async () => {
  const h = harness(); h.setResponder(() => { throw new DomainError("AI_NETWORK_UNCERTAIN", "PRIVATE_PROVIDER_BODY", { status: 503 }); });
  const job = await h.service.queue(ALICE, "role-project", ANSWERS, "uncertain"); assert.equal((await h.service.execute(job.id)).failureCode, "AI_NETWORK_UNCERTAIN");
  await h.service.execute(job.id); await h.service.recover(job.id); const replayed = await h.service.queue(ALICE, "role-project", ANSWERS, "uncertain");
  assert.equal(replayed.status, "failed"); assert.equal(h.calls.length, 1); assert.equal(JSON.stringify(replayed).includes("PRIVATE_PROVIDER_BODY"), false);
});
test("a fresh key or next UTC day cannot replay the same unresolved role-help request", async () => {
  const h=harness(); h.setResponder(()=>{throw new DomainError("AI_NETWORK_UNCERTAIN","结果未知。",{status:503});});
  const job=await h.service.queue(ALICE,"role-project",ANSWERS,"original-hold");
  await h.service.execute(job.id);
  h.advance(24*60*60*1000);
  const restarted=new RoleHelpService(h.optionsForService);
  await assert.rejects(restarted.queue(ALICE,"role-project",ANSWERS,"new-key"),code("AI_REQUEST_UNRESOLVED"));
  assert.equal(await count(),1);assert.equal(h.calls.length,1);
  assert.equal((await restarted.queue(ALICE,"role-project",ANSWERS,"original-hold")).id,job.id);
});
test("different keys cannot duplicate one pending semantic request", async () => {
  const h=harness();
  const results=await Promise.allSettled([h.service.queue(ALICE,"role-project",ANSWERS,"key-a"),h.service.queue(ALICE,"role-project",ANSWERS,"key-b")]);
  assert.equal(results.filter(item=>item.status==="fulfilled").length,1);
  const failed=results.find(item=>item.status==="rejected") as PromiseRejectedResult;assert.equal(failed.reason.code,"AI_REQUEST_PENDING");
  assert.equal(await count(),1);assert.equal(h.calls.length,0);
});
test("expired worker recovery is terminal, exposes only metadata, and rejects late provider result", async () => {
  const h = harness(); const entered = deferred<void>(); const output = deferred<unknown>(); h.setResponder(() => { entered.resolve(); return output.promise; });
  const job = await h.service.queue(ALICE, "role-project", ANSWERS, "recovery"); const work = h.service.execute(job.id); await entered.promise;
  h.advance(32001); assert.equal((await h.service.listRecoverable(10))[0]?.id, job.id);
  const recovered = await h.service.recover(job.id); assert.equal(recovered.failureCode, "AI_WORKER_EXPIRED_UNCERTAIN");
  output.resolve(OUTPUT); assert.equal((await work).revision, recovered.revision); await h.service.execute(job.id);
  assert.equal(h.calls.length, 1); assert.equal((await h.service.getJob(ALICE, job.id)).result, null);
  assert.equal(createRoleHelpRegistration(h.service).kind, "m04_role_help");
});
test("timeout aborts transport once; delayed result stays discarded", async () => {
  const h = harness({ timeoutMs: 10 }); const output = deferred<unknown>(); h.setResponder(() => output.promise);
  const job = await h.service.queue(ALICE, "role-project", ANSWERS, "timeout"); assert.equal((await h.service.execute(job.id)).failureCode, "AI_TIMEOUT_UNCERTAIN");
  assert.equal(h.calls[0]!.signal.aborted, true); output.resolve(OUTPUT); await Promise.resolve();
  assert.equal((await h.service.getJob(ALICE, job.id)).result, null); assert.equal(h.calls.length, 1);
});
test("model unavailable rejects queue; malformed dimension, forged version, percentage or extra result fields are rejected", async () => {
  const unavailable = harness({ noModel: true }); await assert.rejects(unavailable.service.queue(ALICE, "role-project", ANSWERS, "no-model"), code("MODEL_UNAVAILABLE")); assert.equal(await count(), 0);
  const h = harness();
  for (const [index, output] of [
    { ...OUTPUT, modelVersion: "FORGED" },
    { ...OUTPUT, suggestions: [{ ...OUTPUT.suggestions[0]!, taskDimension: "ceo" }] },
    { ...OUTPUT, suggestions: [{ ...OUTPUT.suggestions[0]!, reason: "你有80%能力匹配度" }] },
    { ...OUTPUT, suggestions: [] },
  ].entries()) {
    h.setResponder(() => output); const job = await h.service.queue(ALICE, "role-project", ANSWERS, `invalid-${index}`);
    assert.equal((await h.service.execute(job.id)).failureCode, "INVALID_INPUT"); assert.equal((await h.service.getJob(ALICE, job.id)).result, null);
  }
});
test("SQL rejects private input edits and terminal-state resurrection", async () => {
  const h = harness(); const job = await h.service.queue(ALICE, "role-project", ANSWERS, "immutable"); await h.service.execute(job.id);
  await assert.rejects(database.query("UPDATE assessments_role_help_jobs SET data=jsonb_set(data,'{answers,interests}','\"changed\"'),revision=revision+1 WHERE id=$1", [job.id]));
  await assert.rejects(database.query("UPDATE assessments_role_help_jobs SET status='queued',revision=revision+1,data=jsonb_set(jsonb_set(data,'{status}','\"queued\"'),'{revision}',to_jsonb(revision+1)) WHERE id=$1", [job.id]));
  assert.equal((await h.service.getJob(ALICE, job.id)).status, "succeeded");
});
test("service independently validates a custom model adapter; unknown view cannot imply retry permission", async () => {
  const h = harness(); const custom = new RoleHelpService({ ...h.optionsForService, model: { async suggest() {
    return { ...OUTPUT, suggestions: [{ ...OUTPUT.suggestions[0]!, taskDimension: "not-a-domain-task" }], modelVersion: "custom-fixture", promptVersion: "project-private-role-help-v1" } as never;
  } } });
  const invalid = await custom.queue(ALICE, "role-project", ANSWERS, "custom-invalid"); assert.equal((await custom.execute(invalid.id)).failureCode, "INVALID_INPUT");
  assert.equal((await custom.getJob(ALICE, invalid.id)).result, null);
  h.setResponder(() => { throw new DomainError("AI_PROVIDER_UNCERTAIN", "provider-body"); });
  const unknown = await h.service.queue(ALICE, "role-project", ANSWERS, "custom-unknown"); await h.service.execute(unknown.id);
  const view = await h.service.getJob(ALICE, unknown.id); assert.equal(view.status, "failed"); assert.equal(view.execution?.status, "unknown"); assert.equal(view.execution?.canRetry, false);
});
test("HTTP accepts only private questions and idempotency header, forbids spoofed identity and caps streaming UTF-8 body", async () => {
  const h = harness();
  const request = (body: unknown, key = "http") => new Request("https://fixture.invalid/api", { method: "POST", headers: { "Content-Type": "application/json", "X-Fixture-Actor": "alice", "Idempotency-Key": key }, body: JSON.stringify(body) });
  const result = await h.handlers.queue(request({ answers: ANSWERS }), { projectId: "role-project" }); assert.equal(result.status, 202);
  const data = (await result.json()).data as { id: string }; assert.equal(h.calls.length, 0);
  assert.equal((await h.handlers.queue(request({ answers: ANSWERS, userId: "bob" }), { projectId: "role-project" })).status, 422);
  assert.equal((await h.handlers.queue(request({ answers: { ...ANSWERS, scores: [] } }), { projectId: "role-project" })).status, 422);
  assert.equal((await h.handlers.queue(request({ answers: { ...ANSWERS, experience: "x".repeat(32769) } }), { projectId: "role-project" })).status, 413);
  assert.equal((await h.handlers.job(new Request("https://fixture.invalid/api"), { jobId: data.id })).status, 401);
  const latest = await h.handlers.latest(new Request("https://fixture.invalid/api", { headers: { "X-Fixture-Actor": "alice" } }), { projectId: "role-project" });
  assert.equal(latest.headers.get("Cache-Control"), "no-store"); assert.equal((await latest.json()).data.job.idempotencyKey, "http"); assert.equal(h.calls.length, 0);
});
test("mutation authorization runs before queue; oversized stream returns promptly even if source cancellation never resolves", async () => {
  const h = harness();
  const protectedHandlers = createRoleHelpHttpHandlers({ service: h.service, requestIds: { next: () => "protected-test" }, resolveActor: async () => ALICE,
    authorizeMutation: async () => { throw new DomainError("FORBIDDEN", "跨站写入被拒绝。", { status: 403 }); } });
  const blocked = await protectedHandlers.queue(new Request("https://fixture.invalid/api", { method: "POST", body: JSON.stringify({ answers: ANSWERS }), headers: { "Content-Type": "application/json", "Idempotency-Key": "blocked" } }), { projectId: "role-project" });
  assert.equal(blocked.status, 403); assert.equal(await count(), 0);
  const never = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { return never.promise; } });
  const request = new Request("https://fixture.invalid/api", { method: "POST", body: stream, duplex: "half", headers: { "Content-Type": "application/json", "X-Fixture-Actor": "alice", "Idempotency-Key": "oversized-stream" } } as RequestInit);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([h.handlers.queue(request, { projectId: "role-project" }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("stream cancellation must not block rejection")), 300); })]);
    assert.equal(response.status, 413); assert.equal(await count(), 0);
  } finally { if (timeout) clearTimeout(timeout); never.resolve(); }
});
