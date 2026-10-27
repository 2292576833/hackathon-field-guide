import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { createApplication, type Application } from "./application.ts";
import { dispatch } from "./router.ts";
import type { Project, ProjectMember } from "../modules/projects/model.ts";
import type { AssignmentVersion } from "../modules/assessments/types.ts";
import type { PlanningInput, PlanVersion, PlanningTask } from "../modules/planning/types.ts";
import type { TaskProposal } from "../modules/planning/service.ts";
import type { Retrospective } from "../modules/retrospectives/domain.ts";

const origin = "http://localhost:3000";
async function fixture() {
  const database = await createDatabase({});
  const application = await createApplication({ mode: "local", origin, codePepper: "integration-tests-only-pepper-32bytes", emailFrom: "test@localhost.invalid" }, database);
  return { application, database };
}
async function request<T>(app: Application, path: string, method = "GET", body?: unknown, cookie?: string, status = 200) {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  const response = await dispatch(app, new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split("/"));
  const envelope = await response.json() as { data: T; error?: { code: string; message: string } };
  assert.equal(response.status, status, `${method} ${path}: ${envelope.error?.code ?? "unexpected status"} ${envelope.error?.message ?? ""}`);
  return { data: envelope.data, error: envelope.error, response };
}
async function login(app: Application, email: string) {
  const { data } = await request<{ challengeId: string }>(app, "auth/login-challenges", "POST", { email });
  const mail = await app.database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email]);
  const code = mail.rows[0]?.body.match(/\b\d{8}\b/)?.[0];
  assert.ok(code, "local email transport produced a login challenge");
  const result = await request<{ profile: { id: string } }>(app, "auth/login-challenges/verify", "POST", { challengeId: data.challengeId, code });
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  assert.match(result.response.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  return { cookie, userId: result.data.profile.id };
}

test("real application flow persists login, invitation, availability, assignment, plan, delivery and private retrospective", async () => {
  const { application: app, database } = await fixture();
  try {
    const manager = await login(app, "manager@example.test");
    const teammate = await login(app, "member@example.test");
    const deadline = new Date(Date.now() + 72 * 60 * 60_000).toISOString();
    const project = (await request<Project>(app, "projects", "POST", { name: "真实流程验收项目", goal: "做出可验收的最小作品", minimumDeliverable: "能完成主要使用流程", timezone: "Asia/Shanghai", deadline }, manager.cookie, 201)).data;
    await request(app, `projects/${project.id}`, "GET", undefined, teammate.cookie, 404);
    const invitation = (await request<{ token: string; projectRevision: number }>(app, `projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", invitedEmail: "member@example.test" }, manager.cookie, 201)).data;
    await request(app, `invitations/${invitation.token}/accept`, "POST", {}, teammate.cookie);
    const detail = (await request<{ project: Project; membership: ProjectMember; members: ProjectMember[] }>(app, `projects/${project.id}`, "GET", undefined, manager.cookie)).data;
    const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const endsAt = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    // UTC windows explicitly declare UTC; the server must not erase a mismatching offset before M05 validates it.
    for (const current of [manager, teammate]) await request(app, `projects/${project.id}/my-availability`, "PUT", { expectedRevision: 0, timezone: "UTC", windows: [{ id: `window-${current.userId}`, startsAt, endsAt, effectiveMinutes: 240 }] }, current.cookie);
    let assignment = (await request<AssignmentVersion>(app, `projects/${project.id}/assignment-versions`, "POST", { baseVersionId: null, draft: { assignments: [{ clientTaskId: "work", title: "完成最小作品", priority: "must", ownerMembershipId: detail.membership.membershipId, helperMembershipIds: [], deliverable: "可交付作品", acceptanceCriteria: ["按步骤能够使用"], dependencyTaskIds: [], proposedDeadlineRef: null, reason: "本人明确选择并确认时间", evidenceLevel: "self_reported" }], gaps: [], assumptions: ["人工安排"] } }, manager.cookie, 201)).data;
    assignment = (await request<AssignmentVersion>(app, `assignment-versions/${assignment.id}/validate`, "POST", { expectedRevision: assignment.revision }, manager.cookie)).data;
    assert.equal(assignment.status, "ready");
    assignment = (await request<AssignmentVersion>(app, `assignment-versions/${assignment.id}/apply`, "POST", { expectedRevision: assignment.revision }, manager.cookie)).data;
    assert.equal(assignment.status, "applied");
    const facts = (await request<PlanningInput>(app, `projects/${project.id}/planning-input`, "GET", undefined, manager.cookie)).data;
    assert.equal(facts.deadlines[0]?.verified, false, "a member-entered target is never presented as verified competition rules");
    assert.equal(facts.assignmentVersionId, assignment.id);
    const kinds = ["implementation" as const, ...facts.requiredTaskKinds];
    const tasks: TaskProposal[] = kinds.map((kind, index) => ({ id: `task-${index}`, projectId: project.id, title: `${kind}验收工作`, priority: "must", kind,
      ownerMembershipId: detail.membership.membershipId, helperEfforts: [], deliverable: "有记录的交付物", acceptanceCriteria: ["能够复现"], reviewerMembershipId: null,
      durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "人工估算" }, dependencyTaskIds: index === 0 ? [] : [`task-${index - 1}`],
      deadlineRef: facts.deadlines[0]!.id, requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0 }));
    const plan = (await request<PlanVersion>(app, `projects/${project.id}/plan-versions`, "POST", { tasks, buffers: [{ deadlineId: facts.deadlines[0]!.id, reservedMinutes: 20, basis: "预留提交窗口" }], reason: "首次人工计划", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "draft-first" }, manager.cookie, 201)).data;
    assert.equal(plan.status, "ready", JSON.stringify(plan.validation?.issues));
    const applied = (await request<PlanVersion>(app, `projects/${project.id}/plan-versions/${plan.id}/apply`, "POST", { expectedRevision: plan.revision, acknowledgedIssueCodes: [...new Set(plan.validation!.issues.map(issue => issue.code))], idempotencyKey: "apply-first" }, manager.cookie)).data;
    assert.equal(applied.status, "applied");
    let current = (await request<{ tasks: PlanningTask[] }>(app, `projects/${project.id}/plans/current`, "GET", undefined, manager.cookie)).data;
    let task = current.tasks[0]!;
    for (const status of ["in_progress", "review", "done"] as const) {
      await request(app, `projects/${project.id}/tasks/${task.id}/progress`, "POST", { expectedRevision: task.revision, status, remainingEstimate: null, blocker: null, evidenceRefs: status === "done" ? ["https://example.test/evidence"] : [], note: "实际操作记录", idempotencyKey: `progress-${status}` }, manager.cookie, 201);
      current = (await request<{ tasks: PlanningTask[] }>(app, `projects/${project.id}/plans/current`, "GET", undefined, manager.cookie)).data;
      task = current.tasks.find(item => item.id === task.id)!;
    }
    assert.ok(task.acceptance);
    const staleProgress = await request(app, `projects/${project.id}/tasks/${task.id}/progress`, "POST", { expectedRevision: 1, status: "in_progress", remainingEstimate: null, blocker: null, evidenceRefs: [], note: "过期编辑", idempotencyKey: "stale-progress" }, manager.cookie, 409);
    assert.equal(staleProgress.error?.code, "VERSION_CONFLICT");
    await request(app, `projects/${project.id}/delivery-verifications`, "POST", { verifiedAt: new Date().toISOString(), environmentSummary: "本地浏览器", steps: ["打开作品并完成核心操作"], outcome: "passed", blockers: [], evidenceRefs: ["https://example.test/run-evidence"] }, manager.cookie, 201);
    const content = { answers: { goalAndOutcome: "完成了核心操作", blockerAndResponse: "通过减少范围解决", helpfulPractice: "先确认交付物", scopeReduction: "移除未完成附加功能", nextChange: "早点准备演示" }, evidenceRefs: [], tools: [] };
    const retrospective = (await request<Retrospective>(app, `projects/${project.id}/retrospectives`, "POST", { scope: "personal", content }, manager.cookie, 201)).data;
    await request(app, `retrospectives/${retrospective.id}`, "GET", undefined, teammate.cookie, 404);
    const confirmed = (await request<Retrospective>(app, `retrospectives/${retrospective.id}/confirm`, "POST", { expectedRevision: retrospective.revision }, manager.cookie)).data;
    assert.equal(confirmed.status, "confirmed");
    assert.equal((await database.query("SELECT id FROM m07_documents WHERE id=$1", [retrospective.id])).rowCount, 1);
    await request(app, "auth/logout", "POST", {}, manager.cookie);
    await request(app, "projects", "GET", undefined, manager.cookie, 401);
  } finally { await database.close(); }
});

test("root HTTP boundary denies wrong methods, cross-origin writes and unauthenticated private access", async () => {
  const { application: app, database } = await fixture();
  try {
    await request(app, "projects", "GET", undefined, undefined, 401);
    await request(app, "events", "DELETE", {}, undefined, 405);
    const response = await dispatch(app, new Request(`${origin}/api/v1/auth/login-challenges`, { method: "POST", headers: { origin: "https://untrusted.example.test", "content-type": "application/json" }, body: JSON.stringify({ email: "x@example.test" }) }), ["auth", "login-challenges"]);
    assert.equal(response.status, 403);
    assert.equal((await database.query("SELECT id FROM development_mailbox")).rowCount, 0);
    const status = (await request<{ modelConfigured: boolean; githubConfigured: boolean }>(app, "system/status")).data;
    assert.equal(status.modelConfigured, false); assert.equal(status.githubConfigured, false);
    await request(app, "admin/event-reviews/not-real/publish", "POST", {}, undefined, 401);
    await request(app, "events/not-real/publish", "POST", {}, undefined, 404);
  } finally { await database.close(); }
});
