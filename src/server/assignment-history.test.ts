import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { AssignmentVersion } from "../modules/assessments/types.ts";
import { createApplication, type Application } from "./application.ts";
import { createDatabase } from "./database.ts";
import { listAssignmentHistory } from "./assignment-history.ts";

let app: Application;
let manager: Actor;
let outsider: Actor;
before(async () => {
  const database = await createDatabase({});
  app = await createApplication({ mode: "local", origin: "http://localhost:3000", codePepper: "history-tests-only-pepper-at-least-32bytes", emailFrom: "test@localhost.invalid" }, database);
  async function login(email: string): Promise<Actor> {
    const challenge = await app.auth.requestLoginChallenge(email, "history-test-client");
    const mail = await database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
    const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0]; assert.ok(code);
    const result = await app.auth.verifyLoginChallenge({ challengeId: challenge.challengeId, code }, "history-test-client");
    return { userId: result.profile.id, platformRoles: ["user"] };
  }
  manager = await login("history-manager@example.test"); outsider = await login("history-outsider@example.test");
});
after(async () => { await app?.database.close(); });
async function project() {
  const value = await app.projects.createProject(manager, { name: "分工恢复验收", goal: "确认历史权限", minimumDeliverable: "可继续的分工草案", timezone: "Asia/Shanghai" });
  const detail = await app.projects.getProject(manager, value.id);
  return { value, membership: detail.membership };
}
async function createDraft(scope: Awaited<ReturnType<typeof project>>, baseVersionId: string | null = null): Promise<AssignmentVersion> {
  return app.assessments.createAssignment(manager, scope.value.id, baseVersionId, { assignments: [{ clientTaskId: app.ids.next(), title: "可恢复任务", priority: "must", ownerMembershipId: scope.membership.membershipId, helperMembershipIds: [], deliverable: "可验证的成果", acceptanceCriteria: ["完成操作"], dependencyTaskIds: [], proposedDeadlineRef: null, reason: "本人确认承担", evidenceLevel: "self_reported" }], gaps: [], assumptions: ["人工安排"] });
}
function code(expected: string) { return (error: unknown) => error instanceof DomainError && error.code === expected; }

test("history returns latest 30 project versions in updated order and live freshness", async () => {
  const scope = await project(); const created: AssignmentVersion[] = [];
  for (let index = 0; index < 32; index++) created.push(await createDraft(scope));
  const expected = [...created].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 30);
  const result = await listAssignmentHistory(app, manager, scope.value.id);
  assert.equal(result.length, 30); assert.deepEqual(result.map(value => value.id), expected.map(value => value.id));
  assert.ok(result.every(value => value.projectId === scope.value.id && value.inputFreshness === "current" && value.staleReason === null));
  assert.ok(result.every(value => !("answers" in value) && !("scores" in value) && !("profile" in value)));
  const freshProject = await app.projects.getProject(manager, scope.value.id);
  await app.projects.editProject(manager, scope.value.id, { expectedRevision: freshProject.project.revision, goal: "实际目标已经变化" });
  assert.ok((await listAssignmentHistory(app, manager, scope.value.id)).every(value => value.inputFreshness === "changed" && Boolean(value.staleReason)));
});

test("directory includes pending and applied statuses and archived history stays readable", async () => {
  const scope = await project(); const first = await createDraft(scope);
  const ready = await app.assessments.validateAssignment(manager, first.id, first.revision);
  const applied = await app.assessments.applyAssignment(manager, ready.id, ready.revision);
  await createDraft(scope, applied.id);
  const pending = await createDraft(scope, applied.id);
  await app.assessments.validateAssignment(manager, pending.id, pending.revision);
  assert.deepEqual(new Set((await listAssignmentHistory(app, manager, scope.value.id)).map(value => value.status)), new Set(["applied", "draft", "ready"]));
  const latest = await app.projects.getProject(manager, scope.value.id);
  await app.projects.transitionStage(manager, scope.value.id, { expectedRevision: latest.project.revision, stage: "archived", reason: "只读历史验收" });
  assert.equal((await listAssignmentHistory(app, manager, scope.value.id)).length, 3);
});

test("outsider is rejected before any assignment view is queried", async () => {
  const scope = await project(); await createDraft(scope); let reads = 0;
  const original = app.assessments.getAssignment.bind(app.assessments);
  app.assessments.getAssignment = async (...args) => { reads++; return original(...args); };
  try { await assert.rejects(listAssignmentHistory(app, outsider, scope.value.id), error => error instanceof DomainError && [403, 404].includes(error.status)); assert.equal(reads, 0); }
  finally { app.assessments.getAssignment = original; }
});

test("account must remain active and verified at admission", async () => {
  const scope = await project(); await createDraft(scope);
  await app.database.query("UPDATE auth_users SET status='suspended' WHERE id=$1", [manager.userId]);
  try { await assert.rejects(listAssignmentHistory(app, manager, scope.value.id), code("UNAUTHENTICATED")); }
  finally { await app.database.query("UPDATE auth_users SET status='active' WHERE id=$1", [manager.userId]); }
});

test("final locked member check rejects a collection whose access changes before return", async () => {
  const scope = await project(); await createDraft(scope);
  const original = app.assessments.getAssignment.bind(app.assessments); let changed = false;
  app.assessments.getAssignment = async (...args) => {
    const value = await original(...args);
    if (!changed) { changed = true; await app.database.query("UPDATE projects_project_membership SET status='left',left_at=now() WHERE project_id=$1 AND user_id=$2", [scope.value.id, manager.userId]); }
    return value;
  };
  try { await assert.rejects(listAssignmentHistory(app, manager, scope.value.id), code("NOT_FOUND")); }
  finally { app.assessments.getAssignment = original; }
  // The rejected outer transaction rolls the simulated change back with the collection.
  assert.equal((await app.projects.getProject(manager, scope.value.id)).membership.status, "active");
});
