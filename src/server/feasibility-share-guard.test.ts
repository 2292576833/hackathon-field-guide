import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { Actor } from "../shared/contracts.ts";
import type { SqlExecutor } from "../shared/persistence.ts";
import type { SavedFeasibilityData, TeamAssistantContextSnapshot } from "../modules/team-assistant/model.ts";
import { FEASIBILITY_OUTPUT_EXAMPLE, validateFeasibilityReport } from "../modules/team-assistant/generation.ts";
import type { PublishSuggestionCommand, SuggestionReceipt, TeamFeedSnapshot } from "../modules/team-collaboration/types.ts";
import type { EventRuleVersion } from "../modules/events/domain.ts";
import { createApplication } from "./application.ts";
import { createDatabase } from "./database.ts";
import { dispatch } from "./router.ts";

const origin = "http://localhost:3000";
const alice: Actor = { userId: "share-guard-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "share-guard-bob", platformRoles: ["user"] };

async function fixture() {
  // Real root composition and migrations, isolated in-memory PGlite. No env,
  // worker, outbound model/mail/network or production directory is used.
  const database = await createDatabase({});
  let app: Awaited<ReturnType<typeof createApplication>>;
  try { app = await createApplication({ mode: "local", origin, codePepper: "share-guard-isolated-test-pepper-only", emailFrom: "test@example.test" }, database); }
  catch (error) { await database.close(); throw error; }
  const tokens = new Map<string, string>(), now = app.clock.now().toISOString();
  for (const actor of [alice, bob]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$5,$5)", [actor.userId, `${actor.userId}@example.test`, actor.userId, actor.platformRoles, now]);
    const token = randomBytes(32).toString("base64url"); tokens.set(actor.userId, token);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", [`${actor.userId}-session`, actor.userId, createHash("sha256").update(token).digest("hex"), now, new Date(app.clock.now().getTime() + 3_600_000).toISOString()]);
  }
  const project = await app.projects.createProject(alice, { name: "选题分享隔离练习", goal: "做一个可演示的原型", timezone: "Asia/Shanghai" });
  const detail = await app.projects.getProject(alice, project.id);
  const invite = await app.projects.createProjectInvitation(alice, project.id, { expectedRevision: detail.project.revision, role: "member", maxUses: 1, expiresAt: new Date(app.clock.now().getTime() + 3_600_000).toISOString() });
  await app.projects.acceptInvitation(bob, invite.token);
  async function request<T>(actor: Actor, path: string, method = "GET", body?: unknown, status = 200): Promise<T> {
    const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, {
      method, headers: { Origin: origin, Cookie: `hackathon_session=${tokens.get(actor.userId)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), path.split("/"));
    const envelope = await response.json() as { data: T; error?: { code: string } };
    assert.equal(response.status, status, `${method}: ${envelope.error?.code ?? "success"}`);
    return status >= 400 ? envelope.error as T : envelope.data;
  }
  const context = (actor = alice) => request<TeamAssistantContextSnapshot>(actor, `projects/${project.id}/assistant/context`);
  async function report(actor = alice, options: { projectId?: string; fingerprint?: string; kind?: string; jobActor?: string; jobStatus?: string } = {}) {
    const snapshot = await context(actor), id = randomUUID(), session = await app.personalWorkspace.session(actor);
    const data: SavedFeasibilityData = { projectId: options.projectId ?? project.id, contextFingerprint: options.fingerprint ?? snapshot.fingerprint,
      idea: "测试夹具的选题资料", sources: snapshot.sources, missing: snapshot.missing, report: validateFeasibilityReport(FEASIBILITY_OUTPUT_EXAMPLE, []) };
    // Explicit saved-artifact fixture, not a real provider success claim. The
    // root POST then validates the actual owner/job/scope and current facts.
    await database.transaction(async sql => {
      await sql.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,external_state,created_at,updated_at) VALUES($1,'personal_artifact',$1,1,$2,$3,$4,1,'response_received',$5,$5)", [id, `navigator-user:${actor.userId}`, options.jobActor ?? actor.userId, options.jobStatus ?? "succeeded", now]);
      await sql.query("INSERT INTO personal_ai_artifacts(id,user_id,session_id,kind,title,data,created_at) VALUES($1,$2,$3,$4,'隔离选题报告',$5::jsonb,$6)", [id, actor.userId, session.id, options.kind ?? "project_feasibility", JSON.stringify(data), now]);
    });
    return { id, data };
  }
  const command = (id: string): PublishSuggestionCommand => ({ sourceKind: "feasibility", sourceId: id, title: "请队友核对选题", body: "这是本人编辑后主动分享的摘录", idempotencyKey: randomUUID() });
  const publish = <T = SuggestionReceipt>(actor: Actor, input: PublishSuggestionCommand, status = 201) => request<T>(actor, `projects/${project.id}/team-feed`, "POST", input, status);
  return { app, database, project, request, context, report, command, publish };
}

test("root POST refuses a report made before the current project goal, with no suggestion/receipt/audit write", async () => {
  const f = await fixture();
  try {
    const report = await f.report(), detail = await f.app.projects.getProject(alice, f.project.id);
    await f.app.projects.editProject(alice, f.project.id, { expectedRevision: detail.project.revision, goal: "改为一个不同的核心流程" });
    const result = await f.publish<{ code: string }>(alice, f.command(report.id), 409);
    assert.equal(result.code, "ASSISTANT_REPORT_STALE");
    for (const table of ["r02_team_suggestions", "r02_team_suggestion_versions", "r02_team_suggestion_audit", "r02_team_suggestion_idempotency", "r02_team_feed_projects"]) {
      assert.equal((await f.database.query(`SELECT * FROM ${table}`)).rowCount, 0);
    }
    assert.equal((await f.database.query("SELECT * FROM ai_execution_jobs")).rowCount, 1, "publication does not create any model job");
  } finally { await f.database.close(); }
});

test("current report publishes once; its own new context and later edits do not invalidate a successful receipt", async () => {
  const f = await fixture();
  try {
    const report = await f.report(), input = f.command(report.id);
    const original = f.app.teamAssistant.getShareSource;
    let calls = 0;
    f.app.teamAssistant.getShareSource = async (...args) => { calls++; return original(...args); };
    const receipt = await f.publish(alice, input);
    assert.equal(receipt.replayed, false); assert.equal(calls, 2);
    assert.notEqual((await f.context()).fingerprint, report.data.contextFingerprint, "the newly shared suggestion changes later model context");
    const detail = await f.app.projects.getProject(alice, f.project.id);
    await f.app.projects.editProject(alice, f.project.id, { expectedRevision: detail.project.revision, goal: "发布之后调整目标" });
    const replay = await f.publish(alice, input);
    assert.equal(replay.id, receipt.id); assert.equal(replay.replayed, true); assert.equal(calls, 2);
    assert.equal((await f.database.query("SELECT * FROM r02_team_suggestions")).rowCount, 1);
    assert.equal((await f.database.query("SELECT * FROM r02_team_suggestion_idempotency")).rowCount, 1);
    assert.equal((await f.database.query("SELECT * FROM ai_execution_jobs")).rowCount, 1);
    await f.publish(alice, { ...input, idempotencyKey: randomUUID() }, 409);
    await f.publish<{ code: string }>(alice, { ...input, body: "同一标识不允许换正文" }, 409).then(error => assert.equal(error.code, "IDEMPOTENCY_CONFLICT"));
  } finally { await f.database.close(); }
});

test("historical shared report remains an explicitly labelled snapshot and reads never invoke the publication guard", async () => {
  const f = await fixture();
  try {
    const report = await f.report(), receipt = await f.publish(alice, f.command(report.id));
    const detail = await f.app.projects.getProject(alice, f.project.id);
    await f.app.projects.editProject(alice, f.project.id, { expectedRevision: detail.project.revision, goal: "历史报告之后的新目标" });
    f.app.teamAssistant.getShareSource = async () => { throw new Error("Shared-context reads must not recurse through a publication context guard"); };
    const feed = await f.request<TeamFeedSnapshot>(bob, `projects/${f.project.id}/team-feed`);
    const item = feed.items.find(item => item.id === receipt.id);
    assert.equal(item?.kind, "suggestion");
    if (item?.kind === "suggestion") assert.match(item.suggestion.source.label, /生成时资料快照/);
    assert.match(JSON.stringify((await f.context(bob)).facts), /生成时资料的检查建议/);
  } finally { await f.database.close(); }
});

test("new publication rejects changed confirmed rules and withdrawn shared advice", async () => {
  const f = await fixture();
  try {
    const now = f.app.clock.now().toISOString(), eventId = "share-guard-event";
    const rules: EventRuleVersion = { eventId, version: 1, createdAt: now,
      metadata: { name: "隔离规则", organizer: "测试主办方", format: "online", region: "线上", officialUrl: "https://example.test/rules" },
      sources: [{ id: "source", eventId, version: 1, sourceConfigId: null, url: "https://example.test/rules", kind: "official", contentHash: "a".repeat(64), fetchedAt: now, trustScope: "official_rules", status: "available" }],
      evidence: [{ id: "proof", eventId, version: 1, sourceId: "source", fieldKey: "requirements.demo", excerpt: "需要可运行原型", locator: "#demo", rawDateText: null, verifiedBy: "fixture-reviewer", verifiedAt: now, conflictsWith: [] }],
      facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "测试保留未知项", status: "unknown", evidenceIds: [] })),
      stages: [], requirements: [{ id: "demo", label: "可运行原型", necessity: "required", stageId: null, evidenceIds: ["proof"] }], qualityFlags: ["missing_information"] };
    await f.app.eventsRepository.transaction(async unit => {
      await unit.saveEvent({ id: eventId, revision: 1, publicationStatus: "published", candidateVersion: 1, publishedVersion: 1, lastVerifiedAt: now }, 0);
      await unit.insertRules(rules);
    });
    const confirmed = await f.app.events.confirmProjectRules(alice, f.project.id, eventId, 1, 0);
    const first = await f.report();
    await f.app.events.confirmProjectRules(alice, f.project.id, eventId, 1, confirmed.revision);
    assert.equal((await f.publish<{ code: string }>(alice, f.command(first.id), 409)).code, "ASSISTANT_REPORT_STALE");
    const manual = await f.publish(alice, { sourceKind: "manual", sourceId: null, title: "共享的选题条件", body: "需要可供队友检查的证据", idempotencyKey: randomUUID() });
    const second = await f.report();
    await f.request(alice, `projects/${f.project.id}/team-feed/${manual.id}/withdraw`, "POST", { expectedRevision: manual.revision, idempotencyKey: randomUUID() });
    assert.equal((await f.publish<{ code: string }>(alice, f.command(second.id), 409)).code, "ASSISTANT_REPORT_STALE");
    assert.equal((await f.database.query("SELECT * FROM r02_team_suggestions")).rowCount, 1);
  } finally { await f.database.close(); }
});

test("forged owner/scope/type/job and non-DSH result cannot become a feasibility share", async () => {
  const f = await fixture();
  try {
    const valid = await f.report(alice);
    assert.equal((await f.publish<{ code: string }>(bob, f.command(valid.id), 409)).code, "SHARE_SOURCE_UNAVAILABLE");
    for (const options of [{ projectId: "different-space" }, { kind: "profile_summary" }, { jobActor: bob.userId }, { jobStatus: "unknown" }]) {
      const forged = await f.report(alice, options);
      assert.equal((await f.publish<{ code: string }>(alice, f.command(forged.id), 409)).code, "SHARE_SOURCE_UNAVAILABLE");
    }
    assert.equal((await f.publish<{ code: string }>(alice, f.command("missing-source"), 409)).code, "SHARE_SOURCE_UNAVAILABLE");
    const get = f.app.personalWorkspace.get;
    // The production personal workspace fixes provider:dsh. An injected bad
    // result must still be rejected by the actual assistant publication guard.
    f.app.personalWorkspace.get = async (...args) => ({ ...await get(...args), provider: "other-provider" as "dsh" });
    assert.equal((await f.publish<{ code: string }>(alice, f.command(valid.id), 404)).code, "ASSISTANT_SOURCE_NOT_FOUND");
    assert.equal((await f.database.query("SELECT * FROM r02_team_suggestions")).rowCount, 0);
  } finally { await f.database.close(); }
});

test("publication rechecks facts immediately before insert, and replay still requires the current member/session", async () => {
  const f = await fixture();
  try {
    const report = await f.report(), input = f.command(report.id), original = f.app.teamAssistant.getShareSource;
    let calls = 0;
    f.app.teamAssistant.getShareSource = async (...args) => {
      if (++calls === 2) {
        const detail = await f.app.projects.getProject(alice, f.project.id);
        await f.app.projects.editProject(alice, f.project.id, { expectedRevision: detail.project.revision, goal: "两次发布检查之间的修改" });
      }
      return original(...args);
    };
    assert.equal((await f.publish<{ code: string }>(alice, input, 409)).code, "ASSISTANT_REPORT_STALE");
    assert.equal(calls, 2); assert.equal((await f.database.query("SELECT * FROM r02_team_suggestions")).rowCount, 0);
    assert.equal((await f.context()).fingerprint, report.data.contextFingerprint, "the guarded request transaction rolls back incidental changes too");
    f.app.teamAssistant.getShareSource = original;
    const own = await f.report(bob), ownInput = f.command(own.id);
    await f.publish(bob, ownInput);
    const detail = await f.app.projects.getProject(alice, f.project.id);
    await f.app.projects.removeProjectMember(alice, f.project.id, bob.userId, detail.project.revision);
    assert.equal((await f.publish<{ code: string }>(bob, ownInput, 403)).code, "PROJECT_ACCESS_DENIED");
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [alice.userId]);
    await f.publish(alice, input, 401);
  } finally { await f.database.close(); }
});

test("membership, shared-advice and request-session changes during new publication discard the entire write", async () => {
  for (const change of ["membership", "shared-advice", "request-session"] as const) {
    const f = await fixture();
    try {
      const advice = await f.publish(alice, { sourceKind: "manual", sourceId: null, title: "报告生成前的共同条件", body: "先完成一个实际演示", idempotencyKey: randomUUID() });
      const report = await f.report(bob), original = f.app.teamAssistant.getShareSource; let calls = 0;
      f.app.teamAssistant.getShareSource = async (...args) => {
        if (++calls === 2) {
          if (change === "membership") {
            const detail = await f.app.projects.getProject(alice, f.project.id);
            await f.app.projects.removeProjectMember(alice, f.project.id, bob.userId, detail.project.revision);
          } else if (change === "shared-advice") {
            await f.app.teamCollaboration.withdraw(alice, f.project.id, advice.id, { expectedRevision: advice.revision, idempotencyKey: randomUUID() });
          } else await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1", [bob.userId]);
        }
        return original(...args);
      };
      await f.publish(bob, f.command(report.id), change === "membership" ? 404 : change === "shared-advice" ? 409 : 401);
      assert.equal(calls, 2);
      assert.equal((await f.database.query("SELECT * FROM r02_team_suggestions")).rowCount, 1, "no new report share is saved");
      assert.equal((await f.app.projectRepository.getMembership(f.project.id, bob.userId))?.status, "active");
      const feed = await f.request<TeamFeedSnapshot>(alice, `projects/${f.project.id}/team-feed`);
      const prior = feed.items.find(item => item.id === advice.id);
      assert.equal(prior?.kind, "suggestion");
      if (prior?.kind === "suggestion") assert.equal(prior.suggestion.status, "discussion", "a failed request also rolls back a nested withdrawal");
      assert.equal((await f.database.query<{ revoked_at: unknown }>("SELECT revoked_at FROM auth_sessions WHERE user_id=$1", [bob.userId])).rows[0]?.revoked_at, null);
    } finally { await f.database.close(); }
  }
});

test("all feed mutations lock planning/assessment/project before feed using one executor; reads avoid feed writer locks", async () => {
  const f = await fixture();
  try {
    const transaction = f.database.transaction.bind(f.database), tapped = new WeakSet<SqlExecutor>();
    let observed: Array<{ sql: SqlExecutor; statement: string }> = [];
    f.database.transaction = work => transaction(async sql => {
      if (!tapped.has(sql)) {
        const query: SqlExecutor["query"] = sql.query.bind(sql); tapped.add(sql);
        sql.query = async <Row>(statement: string, parameters?: readonly unknown[]) => { observed.push({ sql, statement }); return query<Row>(statement, parameters); };
      }
      return work(sql);
    });
    const check = async <T>(work: () => Promise<T>) => {
      observed = []; const value = await work();
      const planning = observed.findIndex(row => row.statement.includes("pg_advisory_xact_lock(hashtextextended"));
      const assessment = observed.findIndex(row => row.statement.includes("SELECT project_id, version_id, revision FROM assessments_assignment_heads"));
      const project = observed.findIndex(row => row.statement.includes("projects_project") && row.statement.includes("FOR UPDATE"));
      const feed = observed.findIndex(row => row.statement.includes("r02_team_feed_projects") && row.statement.includes("FOR UPDATE"));
      assert.ok(planning >= 0 && assessment > planning && project > assessment && feed > project);
      // Principal resolution may read a session in a preceding transaction.
      // The mutation's protected locks and persisted feed writes must all use
      // the same executor; unrelated preflight reads need not share it.
      const executor = observed[planning]!.sql;
      for (const index of [assessment, project, feed]) assert.equal(observed[index]!.sql, executor);
      const writes = observed.filter(row => /INSERT INTO r02_team_(suggestions|suggestion_versions|suggestion_audit|suggestion_idempotency)|UPDATE r02_team_suggestions/.test(row.statement));
      assert.ok(writes.length > 0); assert.ok(writes.every(row => row.sql === executor));
      return value;
    };
    const receipt = await check(() => f.publish(alice, { sourceKind: "manual", sourceId: null, title: "成员备注", body: "先核对一个演示", idempotencyKey: randomUUID() }));
    const edited = await check(() => f.request<SuggestionReceipt>(alice, `projects/${f.project.id}/team-feed/${receipt.id}`, "PATCH", { expectedRevision: receipt.revision, title: "编辑后的备注", body: "按实际检查改方案", idempotencyKey: randomUUID() }));
    const adopted = await check(() => f.request<SuggestionReceipt>(alice, `projects/${f.project.id}/team-feed/${receipt.id}/adopt`, "POST", { expectedRevision: edited.revision, idempotencyKey: randomUUID() }));
    await check(() => f.request(alice, `projects/${f.project.id}/team-feed/${receipt.id}/withdraw`, "POST", { expectedRevision: adopted.revision, idempotencyKey: randomUUID() }));
    observed = []; await f.request<TeamFeedSnapshot>(bob, `projects/${f.project.id}/team-feed`); await f.context(bob);
    assert.ok(!observed.some(row => row.statement.includes("r02_team_feed_projects") && /INSERT|FOR UPDATE/.test(row.statement)));
  } finally { await f.database.close(); }
});

test("sharing has no model/budget effects and preserves an existing unknown request hold and busy account session", async () => {
  const f = await fixture();
  try {
    const report = await f.report(), id = randomUUID(), now = f.app.clock.now().toISOString(), period = now.slice(0, 10);
    await f.database.transaction(async sql => {
      await sql.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,external_state,created_at,updated_at) VALUES($1,'personal_artifact',$1,1,$2,$3,'unknown',1,'unknown',$4,$4)", [id, `navigator-user:${alice.userId}`, alice.userId, now]);
      await sql.query("INSERT INTO ai_usage_attempts(id,execution_id,project_id,actor_id,period,model_version,prompt_version,status,cost_configured,input_rate_micro_usd_per_million,output_rate_micro_usd_per_million,reserved_micro_usd,usage_verified,external_state,created_at) VALUES($1,$2,$3,$4,$5::date,'explicit-fixture-model','explicit-fixture-prompt','reserved',true,1,1,100,false,'unknown',$6)", [randomUUID(), id, `navigator-user:${alice.userId}`, alice.userId, period, now]);
      await sql.query("INSERT INTO ai_budget_buckets(project_id,period,calls,reserved_micro_usd,charged_micro_usd) VALUES($1,$2::date,1,100,0)", [`navigator-user:${alice.userId}`, period]);
      await sql.query("UPDATE personal_dsh_sessions SET active_job_id=$2 WHERE user_id=$1", [alice.userId, id]);
    });
    const before = { jobs: (await f.database.query("SELECT * FROM ai_execution_jobs ORDER BY id")).rows, usage: (await f.database.query("SELECT * FROM ai_usage_attempts ORDER BY id")).rows,
      budget: (await f.database.query("SELECT * FROM ai_budget_buckets")).rows, sessions: (await f.database.query("SELECT * FROM personal_dsh_sessions ORDER BY id")).rows };
    const input = f.command(report.id); await f.publish(alice, input); await f.publish(alice, input);
    await f.publish(alice, { ...input, idempotencyKey: randomUUID() }, 409);
    assert.deepEqual((await f.database.query("SELECT * FROM ai_execution_jobs ORDER BY id")).rows, before.jobs);
    assert.deepEqual((await f.database.query("SELECT * FROM ai_usage_attempts ORDER BY id")).rows, before.usage);
    assert.deepEqual((await f.database.query("SELECT * FROM ai_budget_buckets")).rows, before.budget);
    assert.deepEqual((await f.database.query("SELECT * FROM personal_dsh_sessions ORDER BY id")).rows, before.sessions);
  } finally { await f.database.close(); }
});
