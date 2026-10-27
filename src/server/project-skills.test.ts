import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { PostgresProjectsRepository } from "../modules/projects/index.ts";
import { AGENT_IDS, INITIAL_SKILLS, createPostgresSkillsRepository, hash, seedInitialSkills } from "../modules/skills/index.ts";
import type { ProjectSkillSelectionState, ProjectSkillSelectionView, ReviewedSkillOption, SkillCandidate, SkillCandidateDocument, SkillCandidateEvidence, SkillReviewSnapshot, TaskSkillReference } from "../modules/skills/index.ts";
import type { SkillReview } from "../modules/operations/skill-review.ts";
import { createProjectSkillsIntegration } from "./project-skills.ts";

const at = "2026-10-10T08:00:00.000Z";
const manager: Actor = { userId: "manager", platformRoles: ["user"] };
const reviewer: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
interface Call { sql: string; params: readonly unknown[]; executorId: number }
interface Envelope<T> { data?: T; error?: { code: string }; requestId: string }
function req(userId = "manager", method = "GET", body?: unknown, path = "/fixture"): Request {
  return new Request(`https://site.example${path}`, { method, headers: { "x-fixture-session": `session-${userId}`, "content-type": "application/json", "x-fixture-csrf": "allowed" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function read<T>(response: Response, status = 200): Promise<T> {
  const envelope = await response.json() as Envelope<T>;
  assert.equal(response.status, status, JSON.stringify(envelope)); assert.ok(envelope.requestId); assert.ok(response.headers.get("cache-control")?.split(",").map(value => value.trim()).includes("no-store"));
  assert.ok("data" in envelope, JSON.stringify(envelope)); return envelope.data!;
}
async function error(response: Response, status: number, code?: string): Promise<void> {
  const envelope = await response.json() as Envelope<unknown>;
  assert.equal(response.status, status, JSON.stringify(envelope)); assert.ok(envelope.requestId); assert.ok(response.headers.get("cache-control")?.split(",").map(value => value.trim()).includes("no-store")); assert.ok(envelope.error);
  if (code) assert.equal(envelope.error.code, code);
}
function exact(candidate: SkillCandidate) { return { expectedCandidateRevision: candidate.revision, expectedContentHash: candidate.contentHash, expectedManifestHash: candidate.manifestHash }; }
function publicationTarget(candidate: SkillCandidate) { return { kind: candidate.kind, id: candidate.id, versionId: candidate.versionId }; }
function newCandidate(): { document: SkillCandidateDocument; evidence: SkillCandidateEvidence } {
  const skill = structuredClone(INITIAL_SKILLS[0]!); const version = skill.versions[0]!; const commit = "e".repeat(40);
  version.commit = commit; version.id = `${skill.id}@${commit}`;
  version.files = version.files.map(file => ({ ...file, downloadUrl: `https://raw.githubusercontent.com/${version.repository}/${commit}/${file.repositoryPath.split("/").map(encodeURIComponent).join("/")}` }));
  version.contentHash = hash(version.files); version.license.sourceUrl = version.files.find(file => file.relativePath === version.license.filePath)!.downloadUrl;
  skill.sourceUrl = `https://github.com/${version.repository}/tree/${commit}/${version.skillPath}`;
  return { document: { kind: "skill", skill }, evidence: { license: { status: "verified", sourceUrl: version.license.sourceUrl, sha256: version.license.sha256, checkedBy: reviewer.userId, checkedAt: at, noticesIncluded: true }, behavior: { status: "reviewed", checkedBy: reviewer.userId, checkedAt: at, note: "隔离测试元数据，不下载或执行第三方内容。" }, compatibility: version.compatibility.map(entry => ({ agentId: entry.agentId, level: "installer_declared", source: "official_documentation", clientVersion: null, os: null, checkedAt: null, evidenceUrl: entry.evidenceUrl, task: null, limitation: entry.limitation })) } };
}

/** Every database is memory-only. Synthetic session tokens and metadata never reach a live service. */
async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE auth_users(id text PRIMARY KEY,status text NOT NULL,email_verified_at timestamptz,platform_roles jsonb NOT NULL);
    CREATE TABLE auth_sessions(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth_users(id),revoked boolean NOT NULL DEFAULT false);
    CREATE TABLE projects_project(id text PRIMARY KEY,stage text NOT NULL);
    CREATE TABLE projects_project_membership(membership_id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects_project(id),user_id text NOT NULL REFERENCES auth_users(id),role text NOT NULL,status text NOT NULL,UNIQUE(project_id,user_id));
    CREATE TABLE assessments_assignment_heads(project_id text PRIMARY KEY REFERENCES projects_project(id));
  `);
  for (const name of ["../modules/skills/schema.sql", "../modules/skills/candidate-schema.sql", "../modules/operations/skill-review.sql", "project-skills.sql"]) await pg.exec(await readFile(new URL(name, import.meta.url), "utf8"));
  const calls: Call[] = []; let executorSequence = 0; const active = new AsyncLocalStorage<SqlExecutor>();
  let afterQuery: ((call: Call, executor: SqlExecutor) => Promise<void>) | undefined;
  const executor = (connection: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }, executorId: number): SqlExecutor => {
    const value: SqlExecutor = { async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      const call = { sql, params: parameters, executorId }; calls.push(call);
      const result = await connection.query(sql, [...parameters]); await afterQuery?.(call, value);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } }; return value;
  };
  const unscoped = executor(pg, 0);
  const database: DatabasePort = {
    query: (sql, params) => (active.getStore() ?? unscoped).query(sql, params),
    transaction: work => { const current = active.getStore(); return current ? work(current) : pg.transaction(connection => { const sql = executor(connection, ++executorSequence); return active.run(sql, () => work(sql)); }); },
  };
  for (const [userId, roles, verified, status] of [
    ["manager", ["user"], true, "active"], ["member", ["user"], true, "active"], ["reviewer", ["reviewer"], true, "active"], ["admin", ["admin"], true, "active"], ["other", ["user"], true, "active"], ["source-only", ["user"], true, "active"], ["target-only", ["user"], true, "active"], ["unverified", ["reviewer"], false, "active"], ["disabled", ["admin"], true, "disabled"],
  ] as const) {
    await database.query("INSERT INTO auth_users(id,status,email_verified_at,platform_roles) VALUES($1,$2,$3,$4::jsonb)", [userId, status, verified ? at : null, JSON.stringify(roles)]);
    await database.query("INSERT INTO auth_sessions(id,user_id) VALUES($1,$2)", [`session-${userId}`, userId]);
  }
  for (const projectId of ["project-a", "project-z", "project-other", "project-archived"]) {
    await database.query("INSERT INTO projects_project(id,stage) VALUES($1,$2)", [projectId, projectId === "project-archived" ? "archived" : "preparation"]);
    await database.query("INSERT INTO assessments_assignment_heads(project_id) VALUES($1)", [projectId]);
  }
  for (const [projectId, userId, role, status] of [
    ["project-a", "manager", "manager", "active"], ["project-z", "manager", "manager", "active"], ["project-archived", "manager", "manager", "active"], ["project-a", "member", "member", "active"], ["project-a", "source-only", "member", "active"], ["project-z", "target-only", "manager", "active"], ["project-other", "other", "manager", "active"],
  ]) await database.query("INSERT INTO projects_project_membership(membership_id,project_id,user_id,role,status) VALUES($1,$2,$3,$4,$5)", [`membership-${projectId}-${userId}`, projectId, userId, role, status]);
  await seedInitialSkills(createPostgresSkillsRepository(database));
  let sequence = 0; let mutationChecks = 0;
  const integration = createProjectSkillsIntegration({ database, projectRepository: new PostgresProjectsRepository(database), clock: { now: () => new Date(at) }, ids: { next: () => `project-skills-test-${++sequence}` },
    async resolveActor(request) {
      const sessionId = request.headers.get("x-fixture-session");
      if (!sessionId) return null;
      const row = (await database.query<{ user_id: string; platform_roles: Actor["platformRoles"] }>("SELECT s.user_id,u.platform_roles FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.id=$1 AND s.revoked=false AND u.status='active' AND u.email_verified_at IS NOT NULL", [sessionId])).rows[0];
      return row ? { userId: row.user_id, platformRoles: row.platform_roles } : null;
    },
    async assertMutationAllowed(request) { mutationChecks++; if (request.headers.get("x-fixture-csrf") !== "allowed") throw new DomainError("CSRF_INVALID", "请刷新。", { status: 403 }); },
  });
  await integration.initialize(); calls.length = 0;
  return { pg, database, integration, calls, mutations: () => mutationChecks,
    onceAfter(match: (call: Call) => boolean, run: (executor: SqlExecutor) => Promise<void>) { afterQuery = async (call, sql) => { if (match(call)) { afterQuery = undefined; await run(sql); } }; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function choice(f: Fixture, project = "project-a"): Promise<TaskSkillReference> {
  const catalog = await read<{ items: ReviewedSkillOption[] }>(await f.integration.handlers.selection.catalog(project)(req()));
  const option = catalog.items.find(item => item.reference.kind === "skill")!;
  return { reference: option.reference, purpose: "编写参赛作品说明", learningMinutes: 25, environment: { agentId: "codex", os: "Windows", clientVersion: "待核对" } };
}
async function count(f: Fixture, table: string): Promise<number> {
  const allowed = ["project_skill_selections", "project_skill_selection_history", "skill_installation_plans", "skill_installation_receipts", "skill_publication_operations", "operations_skill_review_audit", "skill_candidates"];
  assert.ok(allowed.includes(table)); return (await f.database.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count;
}

test("root selection GET/PUT pins reviewed version, CAS preserves history and clearing retains a revision tombstone", async () => {
  const f = await fixture(); try {
    const empty = await read<ProjectSkillSelectionView>(await f.integration.handlers.selection.read("project-a")(req())); assert.equal(empty.revision, 0); assert.equal(empty.canManage, true);
    const item = await choice(f); const saved = await read<ProjectSkillSelectionState>(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })));
    assert.equal(saved.revision, 1); assert.deepEqual(saved.selections, [item]); assert.equal(saved.updatedBy, "manager");
    const member = await read<ProjectSkillSelectionView>(await f.integration.handlers.selection.read("project-a")(req("member"))); assert.equal(member.canManage, false); assert.equal(member.availability[0]?.available, true);
    await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [] })), 409, "VERSION_CONFLICT");
    const cleared = await read<ProjectSkillSelectionState>(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 1, selections: [] }))); assert.equal(cleared.revision, 2); assert.deepEqual(cleared.selections, []);
    await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })), 409, "VERSION_CONFLICT");
    assert.equal(await count(f, "project_skill_selections"), 1); assert.equal(await count(f, "project_skill_selection_history"), 2); assert.equal(await count(f, "skill_installation_plans"), 0);
    const history = (await f.database.query<{ document: ProjectSkillSelectionState }>("SELECT document FROM project_skill_selection_history ORDER BY revision")).rows;
    assert.deepEqual(history.map(row => row.document.selections), [[item], []]);
    await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 2, selections: [{ ...item, purpose: "C:\\fixture\\local-project" }] })), 422, "INVALID_SKILL_REFERENCE");
    await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 2, selections: [{ ...item, reference: { ...item.reference, contentHash: "0".repeat(64) } }] })), 409, "SKILL_REFERENCE_STALE");
    assert.equal(await count(f, "project_skill_selection_history"), 2);
  } finally { await f.pg.close(); }
});

test("root membership is authoritative: member can read, unrelated platform admin cannot, unverified or disabled sessions fail", async () => {
  const f = await fixture(); try {
    await read<ProjectSkillSelectionView>(await f.integration.handlers.selection.read("project-a")(req("member")));
    await error(await f.integration.handlers.selection.save("project-a")(req("member", "PUT", { expectedRevision: 0, selections: [] })), 403, "PROJECT_SKILL_MANAGEMENT_REQUIRED");
    for (const userId of ["other", "admin", "reviewer"]) {
      await error(await f.integration.handlers.selection.read("project-a")(req(userId)), 403, "PROJECT_SKILL_ACCESS_DENIED");
      await error(await f.integration.handlers.selection.catalog("project-a")(req(userId)), 403, "PROJECT_SKILL_ACCESS_DENIED");
    }
    for (const userId of ["unverified", "disabled", "missing"]) await error(await f.integration.handlers.selection.read("project-a")(req(userId)), 401);
    for (const status of ["left", "removed"]) { await f.database.query("UPDATE projects_project_membership SET status=$1 WHERE project_id='project-a' AND user_id='member'", [status]); await error(await f.integration.handlers.selection.read("project-a")(req("member")), 403, "PROJECT_SKILL_ACCESS_DENIED"); }
    assert.equal(await count(f, "project_skill_selections"), 0);
  } finally { await f.pg.close(); }
});

test("root copy checks both projects, locks all M04 heads before sorted projects and memberships, and never installs", async () => {
  const f = await fixture(); try {
    const item = await choice(f); await read(await f.integration.handlers.selection.save("project-z")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })));
    await error(await f.integration.handlers.selection.copy("project-z")(req("source-only", "POST", { sourceProjectId: "project-a", expectedRevision: 1 })), 403);
    await error(await f.integration.handlers.selection.copy("project-z")(req("target-only", "POST", { sourceProjectId: "project-a", expectedRevision: 1 })), 403);
    await error(await f.integration.handlers.selection.copy("project-z")(req("manager", "POST", { sourceProjectId: "project-z", expectedRevision: 1 })), 422);
    f.calls.length = 0;
    const copied = await read<ProjectSkillSelectionState>(await f.integration.handlers.selection.copy("project-a")(req("manager", "POST", { sourceProjectId: "project-z", expectedRevision: 0 })));
    assert.deepEqual(copied.selections, [item]); assert.equal(copied.projectId, "project-a");
    const requestCalls = [...f.calls]; assert.equal(new Set(requestCalls.map(call => call.executorId)).size, 1); assert.ok(requestCalls.every(call => call.executorId !== 0));
    const heads = requestCalls.map((call, index) => ({ ...call, index })).filter(call => call.sql.includes("FROM assessments_assignment_heads"));
    const projects = requestCalls.map((call, index) => ({ ...call, index })).filter(call => /^SELECT id FROM projects_project WHERE/.test(call.sql));
    assert.deepEqual(heads.map(call => call.params[0]), ["project-a", "project-z"]); assert.deepEqual(projects.map(call => call.params[0]), ["project-a", "project-z"]);
    assert.ok(heads.at(-1)!.index < projects[0]!.index);
    assert.ok(projects.at(-1)!.index < requestCalls.findIndex(call => call.sql.includes("FROM projects_project_membership")));
    assert.ok(requestCalls.some(call => call.sql.includes("auth_sessions"))); assert.ok(requestCalls.some(call => call.sql.includes("FROM skill_catalog")));
    assert.ok(requestCalls.every(call => !call.sql.includes("skill_installation"))); assert.equal(await count(f, "skill_installation_plans"), 0); assert.equal(await count(f, "skill_installation_receipts"), 0);
    await error(await f.integration.handlers.selection.copy("project-a")(req("manager", "POST", { sourceProjectId: "project-z", expectedRevision: 0 })), 409, "VERSION_CONFLICT");
  } finally { await f.pg.close(); }
});

test("archived projects allow authorized reading but reject selection writes and reuse into an archived target", async () => {
  const f = await fixture(); try {
    const view = await read<ProjectSkillSelectionView>(await f.integration.handlers.selection.read("project-archived")(req())); assert.equal(view.readOnly, true); assert.equal(view.canManage, false);
    await error(await f.integration.handlers.selection.save("project-archived")(req("manager", "PUT", { expectedRevision: 0, selections: [] })), 409, "PROJECT_READ_ONLY");
    await error(await f.integration.handlers.selection.copy("project-archived")(req("manager", "POST", { sourceProjectId: "project-a", expectedRevision: 0 })), 409, "PROJECT_READ_ONLY");
    assert.equal(await count(f, "project_skill_selection_history"), 0);
  } finally { await f.pg.close(); }
});

test("session or role changes after the actual write cause response rejection and rollback selection plus history", async () => {
  const f = await fixture(); try {
    const item = await choice(f);
    for (const change of ["session", "role"]) {
      f.onceAfter(call => call.sql.startsWith("INSERT INTO project_skill_selection_history"), async tx => { await tx.query(change === "session" ? "UPDATE auth_sessions SET revoked=true WHERE id='session-manager'" : "UPDATE auth_users SET platform_roles='[\"admin\"]'::jsonb WHERE id='manager'"); });
      await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })), 401, "SESSION_CHANGED");
      assert.equal(await count(f, "project_skill_selections"), 0); assert.equal(await count(f, "project_skill_selection_history"), 0);
      const identity = (await f.database.query<{ revoked: boolean; platform_roles: string[] }>("SELECT s.revoked,u.platform_roles FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.id='session-manager'")).rows[0]!;
      assert.equal(identity.revoked, false); assert.deepEqual(identity.platform_roles, ["user"]);
    }
  } finally { await f.pg.close(); }
});

test("membership removal after save also rolls selection history back, rather than returning a stale successful state", async () => {
  const f = await fixture(); try {
    const item = await choice(f);
    f.onceAfter(call => call.sql.startsWith("INSERT INTO project_skill_selection_history"), async tx => { await tx.query("UPDATE projects_project_membership SET status='removed' WHERE project_id='project-a' AND user_id='manager'"); });
    await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })), 403, "PROJECT_SKILL_ACCESS_DENIED");
    assert.equal(await count(f, "project_skill_selections"), 0); assert.equal(await count(f, "project_skill_selection_history"), 0);
  } finally { await f.pg.close(); }
});

test("root services reject unscoped calls; wrapper identity/CSRF errors cannot perform a mutation", async () => {
  const f = await fixture(); try {
    const contextRequired = (failure: unknown) => failure instanceof DomainError && failure.code === "SESSION_CONTEXT_REQUIRED";
    await assert.rejects(f.integration.selectionService.read(manager, "project-a"), contextRequired);
    await assert.rejects(f.integration.selectionService.save(manager, "project-a", { expectedRevision: 0, selections: [] }), contextRequired);
    await assert.rejects(f.integration.reviewService.list(reviewer), contextRequired);
    await assert.rejects(f.integration.candidateService.list(reviewer), contextRequired);
    const version = INITIAL_SKILLS[0]!.versions[0]!;
    await assert.rejects(f.integration.candidateService.get(reviewer, { kind: "skill", id: INITIAL_SKILLS[0]!.id, versionId: version.id }), contextRequired);
    const blocked = req("manager", "PUT", { expectedRevision: 0, selections: [] }); blocked.headers.set("x-fixture-csrf", "bad");
    await error(await f.integration.handlers.selection.save("project-a")(blocked), 403, "CSRF_INVALID"); assert.equal(await count(f, "project_skill_selection_history"), 0);
    await error(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [], userId: "admin" })), 422, "INVALID_SKILL_REFERENCE");
  } finally { await f.pg.close(); }
});

test("root schema rejects forged payload identities, missing actor/project FKs and history update/delete", async () => {
  const f = await fixture(); try {
    const item = await choice(f); const saved = await read<ProjectSkillSelectionState>(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })));
    await assert.rejects(f.database.query("UPDATE project_skill_selection_history SET document=document WHERE project_id='project-a'"), /immutable/);
    await assert.rejects(f.database.query("DELETE FROM project_skill_selection_history WHERE project_id='project-a'"), /immutable/);
    await assert.rejects(f.database.query("UPDATE project_skill_selections SET document=jsonb_set(document,'{projectId}','\"project-z\"'::jsonb) WHERE project_id='project-a'"), /check constraint/);
    const missingActor = { ...saved, projectId: "project-z", updatedBy: "missing" };
    await assert.rejects(f.database.query("INSERT INTO project_skill_selections(project_id,revision,updated_by,updated_at,document) VALUES($1,$2,$3,$4,$5::jsonb)", [missingActor.projectId, 1, "missing", at, JSON.stringify(missingActor)]), /foreign key constraint/);
    const missingProject = { ...saved, projectId: "missing-project" };
    await assert.rejects(f.database.query("INSERT INTO project_skill_selections(project_id,revision,updated_by,updated_at,document) VALUES($1,$2,$3,$4,$5::jsonb)", [missingProject.projectId, 1, "manager", at, JSON.stringify(missingProject)]), /foreign key constraint/);
    assert.equal(await count(f, "project_skill_selection_history"), 1); assert.equal(await count(f, "project_skill_selections"), 1);
  } finally { await f.pg.close(); }
});

test("root admin handlers persist exact candidate/review cycle, preserve untested tools and filter review history by complete target", async () => {
  const f = await fixture(); try {
    const source = newCandidate(); const unknown = structuredClone(source.evidence); unknown.license = { status: "unknown", sourceUrl: null, sha256: null, checkedBy: null, checkedAt: null, noticesIncluded: false };
    const draft = await read<SkillCandidate>(await f.integration.handlers.candidates.save(req("reviewer", "POST", { expectedRevision: 0, document: source.document, evidence: unknown })));
    const first = await read<SkillReview>(await f.integration.handlers.reviews.register(publicationTarget(draft))(req("reviewer", "POST", exact(draft))), 201);
    const check = { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] };
    await error(await f.integration.handlers.reviews.decide(first.reviewId)(req("reviewer", "POST", { ...exact(draft), expectedRevision: 1, decision: "approved", reason: "未许可不能通过", verification: check })), 422, "SKILL_INVALID");
    const candidate = await read<SkillCandidate>(await f.integration.handlers.candidates.save(req("reviewer", "POST", { expectedRevision: 1, document: source.document, evidence: source.evidence })));
    await error(await f.integration.handlers.reviews.decide(first.reviewId)(req("reviewer", "POST", { ...exact(draft), expectedRevision: 1, decision: "approved", reason: "旧审核", verification: check })), 409, "VERSION_CONFLICT");
    const pending = await read<SkillReview>(await f.integration.handlers.reviews.register(publicationTarget(candidate))(req("reviewer", "POST", exact(candidate))), 201);
    await error(await f.integration.handlers.reviews.decide(pending.reviewId)(req("reviewer", "POST", { ...exact(candidate), expectedRevision: 1, decision: "approved", reason: "未确认工具", verification: { ...check, acknowledgedCompatibility: [] } })), 422, "UNKNOWN_NOT_ACKNOWLEDGED");
    const approved = await read<SkillReview>(await f.integration.handlers.reviews.decide(pending.reviewId)(req("reviewer", "POST", { ...exact(candidate), expectedRevision: 1, decision: "approved", reason: "许可行为已核验，八工具仍待真实任务验证", verification: check })));
    await error(await f.integration.handlers.reviews.publish(approved.reviewId)(req("reviewer", "POST", { ...exact(candidate), expectedManifestHash: "0".repeat(64), expectedRevision: approved.revision })), 409, "VERSION_CONFLICT");
    f.calls.length = 0;
    const published = await read<SkillReview>(await f.integration.handlers.reviews.publish(approved.reviewId)(req("reviewer", "POST", { ...exact(candidate), expectedRevision: approved.revision }))); assert.equal(published.status, "published");
    assert.equal(new Set(f.calls.map(call => call.executorId)).size, 1); assert.ok(f.calls.every(call => call.executorId !== 0));
    const snapshot = await read<SkillReviewSnapshot>(await f.integration.handlers.candidates.detail(publicationTarget(candidate))(req("reviewer"))); assert.equal(snapshot.state, "published"); assert.equal(snapshot.contentHash, candidate.contentHash); assert.equal(snapshot.manifestHash, candidate.manifestHash); assert.ok(snapshot.evidence.compatibility.every(entry => entry.level === "installer_declared"));
    const path = `/admin/reviews?kind=${candidate.kind}&id=${encodeURIComponent(candidate.id)}&versionId=${encodeURIComponent(candidate.versionId)}`;
    const reviews = await read<SkillReview[]>(await f.integration.handlers.reviews.list(req("reviewer", "GET", undefined, path))); assert.deepEqual(reviews.map(review => review.candidateRevision), [2, 1]); assert.ok(reviews.every(review => review.id === candidate.id && review.versionId === candidate.versionId));
    const unrelated = await read<SkillReview[]>(await f.integration.handlers.reviews.list(req("reviewer", "GET", undefined, "/admin/reviews?kind=skill&id=another&versionId=another%401"))); assert.deepEqual(unrelated, []);
    for (const suffix of ["&kind=bundle", "&status=approved"]) await error(await f.integration.handlers.reviews.list(req("reviewer", "GET", undefined, path + suffix)), 422, "INVALID_INPUT");
    await error(await f.integration.handlers.reviews.list(req("manager", "GET", undefined, path)), 403, "FORBIDDEN");
    const withdrawal = { ...exact(candidate), operationId: "root-withdraw", reason: "固定版本撤回" };
    const removed = await read(await f.integration.handlers.reviews.withdraw(publicationTarget(candidate))(req("reviewer", "POST", withdrawal))); const replay = await read(await f.integration.handlers.reviews.withdraw(publicationTarget(candidate))(req("reviewer", "POST", withdrawal))); assert.deepEqual(replay, removed);
    await error(await f.integration.handlers.reviews.publish(approved.reviewId)(req("reviewer", "POST", { ...exact(candidate), expectedRevision: approved.revision })), 409, "SKILL_WITHDRAWN");
    assert.equal(await count(f, "skill_installation_plans"), 0); assert.equal(await count(f, "skill_installation_receipts"), 0);
  } finally { await f.pg.close(); }
});

test("withdrawal preserves stored selection history with unavailable fact and prevents copying it as a new dependency", async () => {
  const f = await fixture(); try {
    const item = await choice(f); await read(await f.integration.handlers.selection.save("project-a")(req("manager", "PUT", { expectedRevision: 0, selections: [item] })));
    const selected = { kind: item.reference.kind, id: item.reference.id, versionId: item.reference.versionId };
    const snapshot = await read<SkillReviewSnapshot>(await f.integration.handlers.candidates.detail(selected)(req("reviewer"))); assert.equal(snapshot.evidence.behavior.status, "unknown"); assert.ok(snapshot.validationErrors.length > 0);
    await read(await f.integration.handlers.reviews.withdraw(selected)(req("reviewer", "POST", { ...exact(snapshot), operationId: "remove-old", reason: "撤回旧固定版本" })));
    const view = await read<ProjectSkillSelectionView>(await f.integration.handlers.selection.read("project-a")(req())); assert.deepEqual(view.selections, [item]); assert.equal(view.availability[0]?.available, false); assert.ok(view.availability[0]?.reason);
    await error(await f.integration.handlers.selection.copy("project-z")(req("manager", "POST", { sourceProjectId: "project-a", expectedRevision: 0 })), 409, "SKILL_REFERENCE_UNAVAILABLE");
    assert.equal(await count(f, "project_skill_selections"), 1); assert.equal(await count(f, "project_skill_selection_history"), 1); assert.equal(await count(f, "skill_installation_plans"), 0);
  } finally { await f.pg.close(); }
});

test("createApplication applies real migrations, imports old published candidates and exposes protected selection/admin routes without background or external calls", async t => {
  const [{ createDatabase }, { createApplication }, { dispatch }] = await Promise.all([import("./database.ts"), import("./application.ts"), import("./router.ts")]);
  const database = await createDatabase({});
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { fetchCalls++; throw new Error("Startup test must not contact external services"); });
  const origin = "http://localhost:3000";
  const config = { mode: "local" as const, origin, codePepper: "skills-application-startup-fixture-pepper-32bytes", emailFrom: "fixture@localhost.invalid" };
  try {
    const app = await createApplication(config, database);
    assert.equal(database.mode, "local"); assert.equal(app.aiWorker, null); assert.equal(app.inspirationWorker, null);
    const migrations = (await database.query<{ id: string }>("SELECT id FROM application_migrations ORDER BY id")).rows.map(row => row.id);
    for (const filename of ["038_skill_candidates.sql", "039_skill_review_publication.sql", "040_project_skill_selections.sql"]) assert.ok(migrations.includes(filename), `startup applied ${filename} to the isolated database`);
    const initial = (await database.query<{ document: SkillCandidate }>("SELECT document FROM skill_candidates ORDER BY kind,id,version_id")).rows.map(row => row.document);
    assert.equal(initial.length, 11); assert.ok(initial.every(candidate => candidate.state === "published" && candidate.recordedBy === "initial-curation"));
    assert.ok(initial.every(candidate => candidate.evidence.behavior.status === "unknown")); assert.ok(initial.every(candidate => candidate.evidence.compatibility.every(entry => entry.level === "installer_declared")));
    const now = new Date().toISOString(); const expires = new Date(Date.now() + 3_600_000).toISOString(); const fixtureSession = "s".repeat(43);
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$3,$4,'active',ARRAY['user','reviewer']::text[],$5,$5,1)", ["skills-boot-user", "skills-boot@example.test", "技能启动夹具", "Asia/Shanghai", now]);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$4,$5,$4)", ["skills-boot-session", "skills-boot-user", createHash("sha256").update(fixtureSession).digest("hex"), now, expires]);
    const request = (path: string, method = "GET", body?: unknown) => new Request(`${origin}/api/v1/${path}`, { method, headers: { origin, "content-type": "application/json", cookie: `hackathon_session=${fixtureSession}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const route = (path: string, method = "GET", body?: unknown) => dispatch(app, request(path, method, body), path.split("/"));
    const project = await read<{ id: string }>(await route("projects", "POST", { name: "技能启动集成夹具", goal: "核验固定版本选择", minimumDeliverable: "已保存选择可重新读取", timezone: "Asia/Shanghai", deadline: expires }), 201);
    const first = await read<ProjectSkillSelectionView>(await route(`projects/${project.id}/skills`)); assert.equal(first.revision, 0); assert.equal(first.canManage, true);
    const catalog = await read<{ items: ReviewedSkillOption[] }>(await route(`projects/${project.id}/skills/catalog`)); assert.equal(catalog.items.length, 11);
    const option = catalog.items.find(item => item.reference.kind === "skill")!;
    const selected = { reference: option.reference, purpose: "核对参赛作品文档", learningMinutes: 20, environment: { agentId: "codex" } };
    const saved = await read<ProjectSkillSelectionState>(await route(`projects/${project.id}/skills`, "PUT", { expectedRevision: 0, selections: [selected] })); assert.equal(saved.revision, 1);
    const candidates = await read<SkillCandidate[]>(await route("admin/skill-candidates")); assert.equal(candidates.length, 11);
    const target = initial.find(candidate => candidate.kind === "skill" && candidate.versionId === option.reference.versionId)!;
    const path = `admin/skill-candidates/${target.kind}/${target.id}/${target.versionId}`;
    const snapshot = await read<SkillReviewSnapshot>(await route(path)); assert.equal(snapshot.state, "published"); assert.equal(snapshot.evidence.behavior.status, "unknown"); assert.ok(snapshot.validationErrors.length > 0);
    await read(await route(`${path}/withdraw`, "POST", { ...exact(snapshot), operationId: "startup-withdraw", reason: "启动回归撤回固定版本" }));
    const restart = await createApplication(config, database);
    const after = (await database.query<{ document: SkillCandidate }>("SELECT document FROM skill_candidates WHERE kind=$1 AND id=$2 AND version_id=$3", [target.kind, target.id, target.versionId])).rows[0]!.document;
    assert.equal(after.state, "withdrawn"); assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM skill_candidates")).rows[0]!.count, 11);
    const restored = await read<ProjectSkillSelectionView>(await dispatch(restart, request(`projects/${project.id}/skills`), ["projects", project.id, "skills"])); assert.deepEqual(restored.selections, [selected]); assert.equal(restored.availability[0]?.available, false);
    assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM skill_installation_plans")).rows[0]!.count, 0); assert.equal(fetchCalls, 0);
  } finally { await database.close(); }
});
