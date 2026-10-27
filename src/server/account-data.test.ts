import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { OwnDataBundle, JsonValue } from "../modules/auth/account-types.ts";
import { AccountCompletionService } from "../modules/auth/account-service.ts";
import { PostgresAccountStore } from "../modules/auth/account-postgres.ts";
import { createNodeAuthCrypto } from "../modules/auth/crypto.ts";
import { PILOT_QUESTION_SET, PILOT_RUBRIC } from "../modules/assessments/catalog.ts";
import { createAccountDataPorts } from "./account-data.ts";
import { createDatabase } from "./database.ts";

const alice: Actor = { userId: "data-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "data-bob", platformRoles: ["user"] };
const now = "2026-10-10T05:00:00.000Z";
const limits = { maxRecords: 5000, maxBytes: 5 * 1024 * 1024 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const json = (value: unknown) => JSON.stringify(value);
const source = (bundle: OwnDataBundle, kind: string) => Object.values(bundle.records).flat().filter(row => (row.data as Record<string, JsonValue>).source === kind);

async function fixture(t: TestContext) {
  // All real root migrations, on a fresh disposable in-memory SQL engine.
  // No .env, production database, network, model, worker or email provider.
  const database = await createDatabase({});
  t.after(() => database.close());
  await database.migrate();
  const crypto = createNodeAuthCrypto("account-data-root-isolated-fixture-pepper-only");
  const tokens = new Map<string, string>();
  for (const actor of [alice, bob]) {
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$4)", [actor.userId, `${actor.userId}@example.test`, actor.userId, now]);
    const token = crypto.generateSessionToken(); tokens.set(actor.userId, token);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", [`${actor.userId}-auth`, actor.userId, crypto.hashSessionToken(token), now, "2026-10-11T05:00:00.000Z"]);
  }
  const project = async (id: string, owner = alice, stage = "preparing") => {
    await database.transaction(async sql => {
      await sql.query("INSERT INTO projects_project(id,name,created_by,goal,minimum_deliverable,stage,timezone,deadline_source,revision,created_at,updated_at) VALUES($1,$2,$3,$4,'可演示原型',$5,'Asia/Shanghai','unknown',1,$6,$6)", [id, `${id} 团队`, owner.userId, `${id} 可读取目标`, stage, now]);
      await member(id, owner, "manager");
    });
  };
  const member = async (projectId: string, actor: Actor, role = "member") => {
    await database.query("INSERT INTO projects_project_membership(membership_id,project_id,user_id,role,status,revision,joined_at) VALUES($1,$2,$3,$4,'active',1,$5)", [`${projectId}-${actor.userId}`, projectId, actor.userId, role, now]);
  };
  const remove = async (projectId: string, actor = alice) => database.query("UPDATE projects_project_membership SET status='removed',left_at=$3,revision=revision+1 WHERE project_id=$1 AND user_id=$2", [projectId, actor.userId, now]);
  const workspace = async (actor = alice) => database.query("INSERT INTO personal_dsh_sessions(id,user_id,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(user_id) DO NOTHING", [`${actor.userId}-dsh`, actor.userId, now]);
  const navigation = async (actor: Actor, content: string, projectId: string | null = null) => {
    await workspace(actor);
    await database.query("INSERT INTO personal_dsh_messages(session_id,project_id,role,content,created_at) VALUES($1,$2,'assistant',$3,$4)", [`${actor.userId}-dsh`, projectId, content, now]);
  };
  const artifact = async (actor: Actor, id: string, kind: string, data: unknown, status = "succeeded") => {
    await workspace(actor);
    await database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,created_at,updated_at) VALUES($1,'personal_artifact',$1,1,'personal',$2,$3,$4,$4)", [id, actor.userId, status, now]);
    await database.query("INSERT INTO personal_ai_artifacts(id,user_id,session_id,kind,title,data,created_at) VALUES($1,$2,$3,$4,'隔离生成资料',$5::jsonb,$6)", [id, actor.userId, `${actor.userId}-dsh`, kind, json(data), now]);
  };
  const draft = async (actor: Actor, projectId: string, text: string) => {
    const id = `${projectId}-${actor.userId}-draft`;
    const body = { kind: "retrospective_edit_draft", id, ownerId: actor.userId, projectId, documentId: null, baseDocumentRevision: 0, visibility: "personal", requestedScope: "project", draftContent: { answers: { wentWell: text } }, revision: 1, createdAt: now, updatedAt: now };
    await database.query("INSERT INTO m07_edit_draft_roots(owner_id,project_id,document_key) VALUES($1,$2,'')", [actor.userId, projectId]);
    await database.query("INSERT INTO m07_edit_drafts(id,owner_id,project_id,document_key,document_id,base_document_revision,requested_scope,revision,created_at,updated_at,body) VALUES($1,$2,$3,'',NULL,0,'project',1,$4,$4,$5::jsonb)", [id, actor.userId, projectId, now, json(body)]);
  };
  const ports = createAccountDataPorts({ database });
  const collect = (actor = alice, policy = limits) => database.transaction(sql => ports.ownData.collectOwnData(actor, sql, policy));
  const service = new AccountCompletionService({ store: new PostgresAccountStore(database, { next: randomUUID }, { now: () => new Date(now) }), crypto, email: { async sendEmailChangeCode() { throw new Error("A data test must never send mail."); } }, ...ports, clock: { now: () => new Date(now) }, ids: { next: randomUUID } });
  return { database, ports, collect, service, tokens, project, member, remove, workspace, navigation, artifact, draft };
}

test("root account export gathers all six private categories and excludes another account and credential fields", async t => {
  const f = await fixture(t); await f.project("alpha"); await f.member("alpha", bob);
  for (const actor of [alice, bob]) {
    const tag = actor === alice ? "ALICE_OWN" : "BOB_PRIVATE_SENTINEL";
    await f.database.query("INSERT INTO participant_profiles(user_id,revision,first_hackathon,development_experience,city,skills,project_idea,updated_at) VALUES($1,1,true,'beginner',$2,ARRAY['TypeScript'],$2,$3)", [actor.userId, tag, now]);
    await f.database.query("INSERT INTO recruiting_profiles(user_id,revision,data,avatar_revision,updated_at) VALUES($1,1,$2::jsonb,0,$3)", [actor.userId, json({ primaryRoles: ["frontend"], supportingRoles: [], purposes: ["learn"], purposeNote: tag, resume: tag, workLinks: [], mbti: "INTP", age: 20, password: "RECRUITING_SECRET" }), now]);
    await f.navigation(actor, `${tag}_NAV`); await f.navigation(actor, `${tag}_PROJECT_NAV`, "alpha");
    await f.artifact(actor, `${actor.userId}-ppt`, "ppt", { slides: [{ title: tag }], credentials: "ARTIFACT_SECRET", nested: { api_key: "NESTED_SECRET", safe: tag } });
    await f.database.query("INSERT INTO team_assistant_conversations(user_id,project_id,created_at,updated_at) VALUES($1,'alpha',$2,$2)", [actor.userId, now]);
    await f.database.query("INSERT INTO team_assistant_requests(user_id,project_id,request_id,request_hash,message,status,created_at,expires_at) VALUES($1,'alpha','request-1','REQUEST_HASH_SECRET',$2,'succeeded',$3,$3)", [actor.userId, tag, now]);
    await f.database.query("INSERT INTO team_assistant_messages(user_id,project_id,request_id,id,role,content,created_at,provider,links) VALUES($1,'alpha','request-1',$2,'assistant',$3,$4,'dsh','[]')", [actor.userId, `${actor.userId}-space-msg`, `${tag}_SPACE`, now]);
    await f.draft(actor, "alpha", `${tag}_PRIVATE_DRAFT`);
    const id = `${actor.userId}-retrospective`;
    const body = { id, kind: "retrospective", projectId: "alpha", ownerId: actor.userId, scope: "personal", revision: 1, status: "draft", content: { answers: { wentWell: `${tag}_RETRO` }, tools: [], evidenceRefs: [] }, createdAt: now, updatedAt: now };
    await f.database.query("INSERT INTO m07_documents(id,kind,project_id,owner_id,scope,revision,created_at,updated_at,body) VALUES($1,'retrospective','alpha',$2,'personal',1,$3,$3,$4::jsonb)", [id, actor.userId, now, json(body)]);
    await f.database.query("INSERT INTO m07_document_versions(document_id,revision,body,recorded_at) VALUES($1,1,$2::jsonb,$3)", [id, json(body), now]);
  }
  await f.database.query("INSERT INTO assessments_rubrics(id,version,data) VALUES($1,1,$2::jsonb)", [PILOT_RUBRIC.id, json(PILOT_RUBRIC)]);
  await f.database.query("INSERT INTO assessments_question_sets(id,version,rubric_version_id,status,data) VALUES($1,1,$2,'draft',$3::jsonb)", [PILOT_QUESTION_SET.id, PILOT_RUBRIC.id, json(PILOT_QUESTION_SET)]);
  for (const actor of [alice, bob]) {
    const tag = actor === alice ? "ALICE_OWN" : "BOB_PRIVATE_SENTINEL";
    const id = `${actor.userId}-attempt`;
    const attempt = { id, projectId: "alpha", membershipId: `alpha-${actor.userId}`, userId: actor.userId, questionSetId: PILOT_QUESTION_SET.id, rubricVersionId: PILOT_RUBRIC.id, questionSetSnapshot: PILOT_QUESTION_SET, rubricSnapshot: PILOT_RUBRIC, status: "draft", revision: 1, latestScoreId: null, activeJobId: null, profile: { experience: `${tag}_PROFILE` }, answers: [{ text: `${tag}_RAW_ANSWER` }], createdAt: now, updatedAt: now };
    await f.database.query("INSERT INTO assessments_attempts(id,project_id,membership_id,user_id,question_set_id,rubric_version_id,status,revision,created_at,updated_at,data) VALUES($1,'alpha',$2,$3,$4,$5,'draft',1,$6,$6,$7::jsonb)", [id, `alpha-${actor.userId}`, actor.userId, PILOT_QUESTION_SET.id, PILOT_RUBRIC.id, now, json(attempt)]);
    const scoreId = `${actor.userId}-score`, score = { id: scoreId, attemptId: id, rubricVersionId: PILOT_RUBRIC.id, supersedesScoreId: null, status: "published", criterionScores: [{ reason: `${tag}_PRIVATE_REASON` }], validatedAt: now, provenance: "test_fixture" };
    await f.database.query("INSERT INTO assessments_scores(id,attempt_id,rubric_version_id,validated_at,data) VALUES($1,$2,$3,$4,$5::jsonb)", [scoreId, id, PILOT_RUBRIC.id, now, json(score)]);
  }
  await f.database.query("INSERT INTO resource_records(id,revision,working_document) VALUES('guide',1,$1::jsonb)", [json({ id: "guide", revision: 1, version: 1, publicationStatus: "draft", description: "EDITOR_INTERNAL_SENTINEL" })]);
  for (const actor of [alice, bob]) await f.database.query("INSERT INTO resource_bookmarks(id,user_id,resource_id,purpose_note,created_at,updated_at,revision) VALUES($1,$2,'guide',$3,$4,$4,1)", [`${actor.userId}-bookmark`, actor.userId, actor === alice ? "ALICE_OWN_BOOKMARK" : "BOB_PRIVATE_SENTINEL", now]);

  const bundle = await f.collect(); const text = json(bundle);
  for (const group of Object.values(bundle.records)) { assert.ok(group.length); assert.ok(group.every(record => record.userId === alice.userId)); }
  for (const expected of ["ALICE_OWN_RAW_ANSWER", "ALICE_OWN_PRIVATE_REASON", "ALICE_OWN_NAV", "ALICE_OWN_SPACE", "ALICE_OWN_PRIVATE_DRAFT", "ALICE_OWN_RETRO", "ALICE_OWN_BOOKMARK"]) assert.ok(text.includes(expected), expected);
  for (const forbidden of ["BOB_PRIVATE_SENTINEL", "EDITOR_INTERNAL_SENTINEL", "RECRUITING_SECRET", "ARTIFACT_SECRET", "NESTED_SECRET", "REQUEST_HASH_SECRET", "token_hash", "password", "credentials", "api_key"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(bundle.projects[0]?.projectId, "alpha"); assert.equal(source(bundle, "assessment_score").length, 1);
  assert.equal(source(bundle, "retrospective_version").length, 1); assert.equal(source(bundle, "navigator_message").length, 2);
  await f.database.query("UPDATE projects_project_membership SET role='manager',revision=revision+1 WHERE project_id='alpha' AND user_id=$1", [bob.userId]);
  await f.remove("alpha");
  const departed = await f.collect(); assert.deepEqual(departed.projects, []);
  assert.equal(source(departed, "assessment_attempt").length, 1); assert.equal(source(departed, "assessment_score").length, 1);
  assert.ok(json(departed).includes("ALICE_OWN_RAW_ANSWER")); assert.ok(json(departed).includes("ALICE_OWN_RETRO"));
});

test("private typed drafts, assessments and personal memories survive leaving; project-context messages and artifacts disappear", async t => {
  const f = await fixture(t); await f.project("alpha"); await f.member("alpha", bob, "manager"); await f.project("private-bob", bob);
  await f.navigation(alice, "GLOBAL_NAV_RETAIN"); await f.navigation(alice, "PROJECT_NAV_HIDE", "alpha");
  await f.draft(alice, "alpha", "LEFT_MEMBER_OWN_WORDS"); await f.draft(bob, "alpha", "BOB_DRAFT_HIDE");
  await f.artifact(alice, "alice-global-summary", "profile_summary", { introduction: "OWN_SUMMARY_RETAIN" });
  await f.artifact(alice, "alice-feasibility", "project_feasibility", { projectId: "alpha", answer: "FEASIBILITY_HIDE" });
  await f.artifact(alice, "alice-space-reply", "space_assistant_reply", { projectId: "alpha", answer: "SPACE_REPLY_HIDE" });
  await f.artifact(alice, "alice-foreign-source", "space_assistant_reply", { projectId: "private-bob", answer: "FOREIGN_PROJECT_HIDE" });
  await f.artifact(alice, "alice-invalid-source", "project_feasibility", { answer: "MISSING_PROJECT_HIDE" });
  await f.artifact(alice, "alice-failed-result", "ppt", { answer: "FAILED_RESULT_HIDE" }, "failed");
  const before = await f.collect(); assert.ok(json(before).includes("FEASIBILITY_HIDE"));
  await f.remove("alpha");
  await assert.rejects(f.database.transaction(sql => f.ports.ownData.assertProjectAccess(alice, before.projects.map(p => p.projectId), sql)), code("ACCOUNT_EXPORT_SCOPE_INVALID"));
  const after = await f.collect(); const text = json(after); assert.deepEqual(after.projects, []);
  for (const keep of ["GLOBAL_NAV_RETAIN", "LEFT_MEMBER_OWN_WORDS", "OWN_SUMMARY_RETAIN"]) assert.ok(text.includes(keep));
  for (const hide of ["PROJECT_NAV_HIDE", "FEASIBILITY_HIDE", "SPACE_REPLY_HIDE", "FOREIGN_PROJECT_HIDE", "MISSING_PROJECT_HIDE", "FAILED_RESULT_HIDE", "BOB_DRAFT_HIDE"]) assert.ok(!text.includes(hide), hide);
});

test("M10 export retains own installation status and precise skill IDs while omitting files, local paths and bridge payloads", async t => {
  const f = await fixture(t);
  for (const actor of [alice, bob]) {
    const id = `${actor.userId}-plan`, doc = { planId: id, agentId: "codex", scope: "project", bundleId: "game", bundleVersion: "v1", status: "installed", createdAt: now, expiresAt: now, userId: actor.userId, bridgeToken: "BRIDGE_SECRET", code: "PAIR_CODE_SECRET", tutorial: ["C:\\private\\TUTORIAL_PATH_SECRET"], items: [{ skillVersionId: actor === alice ? "skill-version-1" : "BOB_INSTALL_HIDE", targetDirectory: "C:\\private\\TARGET_PATH_SECRET", files: [{ path: "C:\\private\\FILE_PATH_SECRET", contents: "FILE_CODE_SECRET" }] }] };
    await f.database.query("INSERT INTO skill_installation_plans(id,user_id,revision,document,bridge_token_hash) VALUES($1,$2,1,$3::jsonb,'BRIDGE_HASH_SECRET')", [id, actor.userId, json(doc)]);
    const receipt = { id: `${id}-receipt`, agentId: "codex", status: "installed", fileStatus: "written", loadStatus: "not_verified", taskStatus: "not_verified", evidenceSource: "local_bridge_reported", createdAt: now, note: "C:\\private\\NOTE_PATH_SECRET", items: doc.items };
    await f.database.query("INSERT INTO skill_installation_receipts(id,plan_id,user_id,document) VALUES($1,$2,$3,$4::jsonb)", [receipt.id, id, actor.userId, json(receipt)]);
  }
  const bundle = await f.collect(), text = json(bundle);
  assert.equal(source(bundle, "skill_installation_plan").length, 1); assert.equal(source(bundle, "skill_installation_receipt").length, 1);
  assert.ok(text.includes("skill-version-1")); assert.ok(text.includes("not_verified"));
  for (const hide of ["BRIDGE_SECRET", "PAIR_CODE_SECRET", "TUTORIAL_PATH_SECRET", "TARGET_PATH_SECRET", "FILE_PATH_SECRET", "FILE_CODE_SECRET", "BRIDGE_HASH_SECRET", "NOTE_PATH_SECRET", "BOB_INSTALL_HIDE", "manifestHash", "bridgeToken", "files"]) assert.ok(!text.includes(hide), hide);
});

test("collection has no 200-message cap; exact bounds succeed and overflow fails instead of truncating", async t => {
  const f = await fixture(t); await f.workspace();
  await f.database.query("INSERT INTO personal_dsh_messages(session_id,role,content,created_at) SELECT $1,'assistant','MESSAGE_' || n::text,$2::timestamptz FROM generate_series(1,205) n", [`${alice.userId}-dsh`, now]);
  const bundle = await f.collect(); assert.equal(source(bundle, "navigator_message").length, 205);
  assert.ok(json(bundle).includes("MESSAGE_1")); assert.ok(json(bundle).includes("MESSAGE_205"));
  const count = Object.values(bundle.records).flat().length + bundle.projects.length;
  assert.equal(Object.values((await f.collect(alice, { ...limits, maxRecords: count })).records).flat().length, count);
  await assert.rejects(f.collect(alice, { ...limits, maxRecords: count - 1 }), code("ACCOUNT_EXPORT_TOO_LARGE"));
  const bytes = Buffer.byteLength(json(bundle), "utf8");
  assert.equal(Buffer.byteLength(json(await f.collect(alice, { ...limits, maxBytes: bytes })), "utf8"), bytes);
  await assert.rejects(f.collect(alice, { ...limits, maxBytes: bytes - 1 }), code("ACCOUNT_EXPORT_TOO_LARGE"));
  assert.equal((await f.database.query("SELECT id FROM personal_dsh_messages")).rowCount, 205);
});

test("actual M01 prepare/download rejects foreign owner and later project removal, new export remains available", async t => {
  const f = await fixture(t); await f.project("alpha"); await f.member("alpha", bob, "manager"); await f.navigation(alice, "ALICE_CURRENT_PROJECT", "alpha");
  const fullGoal = "目".repeat(4000), fullDeliverable = "交".repeat(4000);
  await f.database.query("UPDATE projects_project SET goal=$1,minimum_deliverable=$2,revision=revision+1 WHERE id='alpha'", [fullGoal, fullDeliverable]);
  const token = f.tokens.get(alice.userId)!, otherToken = f.tokens.get(bob.userId)!;
  const request = await f.service.requestExport(token);
  const ready = await f.service.prepareExport(token, request.id, request.revision); assert.equal(ready.status, "ready");
  const document = json(await f.service.downloadExport(token, ready.id));
  assert.ok(document.includes("ALICE_CURRENT_PROJECT")); assert.ok(document.includes(fullGoal)); assert.ok(!document.includes(fullDeliverable));
  await assert.rejects(f.service.downloadExport(otherToken, ready.id), code("ACCOUNT_EXPORT_NOT_FOUND"));
  await f.remove("alpha");
  await assert.rejects(f.service.downloadExport(token, ready.id), code("ACCOUNT_EXPORT_SCOPE_INVALID"));
  const next = await f.service.requestExport(token), nextReady = await f.service.prepareExport(token, next.id, next.revision);
  assert.equal(nextReady.status, "ready"); assert.ok(!(await f.service.downloadExport(token, nextReady.id)).json.includes("ALICE_CURRENT_PROJECT"));
});

test("actual M01 deletion rechecks current valid managers, blocks last manager with team link and makes no completed claim", async t => {
  const f = await fixture(t); await f.project("alpha"); await f.member("alpha", bob, "manager");
  const token = f.tokens.get(alice.userId)!;
  const pending = await f.service.requestDeletion(token); assert.equal(pending.status, "pending"); assert.deepEqual(pending.impact.lastManagerProjects, []);
  await f.database.query("UPDATE auth_users SET status='suspended',revision=revision+1 WHERE id=$1", [bob.userId]);
  const blocked = await f.service.beginDeletionProcessing(alice.userId, pending.id, pending.revision);
  assert.equal(blocked.status, "blocked"); assert.deepEqual(blocked.impact.lastManagerProjects, [{ projectId: "alpha", name: "alpha 团队", remediationUrl: "/app/projects/alpha/team" }]);
  assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [alice.userId])).rows[0]?.status, "active");
  assert.equal((await f.database.query("SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL", [alice.userId])).rowCount, 1);
  await f.database.query("UPDATE auth_users SET status='active',revision=revision+1 WHERE id=$1", [bob.userId]);
  await f.database.query("UPDATE projects_project_membership SET role='member',revision=revision+1 WHERE project_id='alpha' AND user_id=$1", [bob.userId]);
  const impact = await f.database.transaction(sql => f.ports.deletionImpact.inspectOwnDeletion(alice, sql)); assert.equal(impact.lastManagerProjects.length, 1, "an active member is not a manager");
  await f.database.query("UPDATE projects_project SET stage='archived',revision=revision+1 WHERE id='alpha'");
  const processing = await f.service.beginDeletionProcessing(alice.userId, blocked.id, blocked.revision); assert.equal(processing.status, "processing");
  assert.ok(!json(processing).includes("completed"));
  assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [alice.userId])).rows[0]?.status, "deletion_pending");
  assert.equal((await f.database.query("SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL", [alice.userId])).rowCount, 0);
});

test("root port only uses supplied executor, orders M04 before M02 and maps manager lock contention to recoverable 409", async t => {
  const f = await fixture(t); await f.project("zeta"); await f.project("alpha"); await f.member("alpha", bob, "manager");
  const forbiddenDatabase: DatabasePort = { async query() { throw new Error("Must not borrow a second connection."); }, async transaction() { throw new Error("Must not open a second transaction."); } };
  const ports = createAccountDataPorts({ database: forbiddenDatabase }); const statements: string[] = [];
  await f.database.transaction(async transaction => {
    const sql: SqlExecutor = { async query<Row>(statement: string, parameters?: readonly unknown[]) { statements.push(`${statement} ${json(parameters ?? [])}`); return transaction.query<Row>(statement, parameters); } };
    const bundle = await ports.ownData.collectOwnData(alice, sql, limits); assert.equal(bundle.projects.length, 2);
  });
  const heads = statements.map((s, i) => s.includes("assessments_assignment_heads") ? i : -1).filter(i => i >= 0);
  const roots = statements.map((s, i) => s.includes("SELECT id FROM projects_project WHERE") ? i : -1).filter(i => i >= 0);
  assert.ok(Math.max(...heads) < Math.min(...roots)); assert.ok(statements[heads[0]!]!.includes('"alpha"')); assert.ok(statements[heads[1]!]!.includes('"zeta"'));
  await assert.rejects(f.database.transaction(async transaction => {
    const sql: SqlExecutor = { async query<Row>(statement: string, parameters?: readonly unknown[]) {
      if (statement.includes("FOR SHARE OF u NOWAIT")) throw Object.assign(new Error("isolated lock contention"), { code: "55P03" });
      return transaction.query<Row>(statement, parameters);
    } };
    return ports.deletionImpact.inspectOwnDeletion(alice, sql);
  }), error => error instanceof DomainError && error.code === "ACCOUNT_DELETION_MANAGER_BUSY" && error.status === 409);
  assert.equal((await f.database.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1", [alice.userId])).rows[0]?.status, "active");
});

test("inactive owner cannot export even with retained membership or a forged Actor", async t => {
  const f = await fixture(t); await f.project("alpha");
  await f.database.query("UPDATE auth_users SET status='suspended',revision=revision+1 WHERE id=$1", [alice.userId]);
  await assert.rejects(f.collect(), code("AUTH_REQUIRED"));
  await assert.rejects(f.database.transaction(sql => f.ports.deletionImpact.inspectOwnDeletion(alice, sql)), code("AUTH_REQUIRED"));
  await assert.rejects(f.collect({ userId: "nonexistent-user", platformRoles: ["admin"] }), code("AUTH_REQUIRED"));
});
