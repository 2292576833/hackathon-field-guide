import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, ProjectRole } from "../../../shared/contracts.ts";
import { createProjectsHttpHandlers } from "../handlers.ts";
import type { ProjectsHttpRoute } from "../handlers.ts";
import type { InvitationPreview, Project, ProjectMember, PublicInvitation, Team, TeamMember, TeamRole } from "../model.ts";
import { ProjectsService } from "../service.ts";
import type { ProjectsServiceDependencies } from "../service.ts";
import { createInvitationTokens } from "../tokens.ts";
import { MemoryProjectsRepository } from "./memory-repository.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["user"] };
const carol: Actor = { userId: "carol", platformRoles: ["user"] };
const outsider: Actor = { userId: "outsider", platformRoles: ["admin"] };

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; latestRevision?: number; recoveryAction?: string };
  requestId: string;
}

interface TeamView { team: Team; membership: TeamMember; members: TeamMember[]; projects: Project[] }
interface ProjectView { project: Project; membership: ProjectMember; members: ProjectMember[] }
interface TeamInvitationResult { invitation: PublicInvitation; token: string; teamRevision: number }
interface AcceptanceResult { scopeType: "project" | "team"; scopeId: string; membership: ProjectMember | TeamMember; revision: number; alreadyAccepted: boolean }

function fixture(overrides: Partial<Pick<ProjectsServiceDependencies, "identity" | "availabilityValidator">> = {}) {
  const repository = new MemoryProjectsRepository();
  let sequence = 0;
  let now = Date.parse("2026-10-08T02:00:00.000Z");
  let guardCalls = 0;
  const service = new ProjectsService({ repository, ids: { next: () => `http_entity_${++sequence}` }, clock: { now: () => new Date(now) }, tokens: createInvitationTokens(), ...overrides });
  return {
    repository, service,
    setTime: (time: string) => { now = Date.parse(time); },
    guardCalls: () => guardCalls,
    handlers: (actor: Actor | null) => createProjectsHttpHandlers({
      service, resolveActor: async () => actor,
      authorizeMutation: async () => { guardCalls += 1; }, requestId: () => "team_http_request",
    }),
  };
}

type Fixture = ReturnType<typeof fixture>;

async function call<T>(f: Fixture, actor: Actor | null, route: ProjectsHttpRoute, method = "GET", body?: object, query = "") {
  const request = new Request(`https://app.example/api/v1/projects-test${query}`, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await f.handlers(actor).handle(request, route);
  const envelope = await response.json() as Envelope<T>;
  assert.equal(envelope.requestId, "team_http_request");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return { response, envelope };
}

async function ok<T>(f: Fixture, actor: Actor, route: ProjectsHttpRoute, method = "GET", body?: object, status = 200, query = ""): Promise<T> {
  const { response, envelope } = await call<T>(f, actor, route, method, body, query);
  assert.equal(response.status, status, JSON.stringify(envelope));
  assert.equal(envelope.error, undefined);
  assert.ok(Object.hasOwn(envelope, "data"));
  return envelope.data as T;
}

async function denied(f: Fixture, actor: Actor | null, route: ProjectsHttpRoute, method: string, body: object | undefined, status: number, code: string, query = "") {
  const { response, envelope } = await call<never>(f, actor, route, method, body, query);
  assert.equal(response.status, status, JSON.stringify(envelope));
  assert.equal(envelope.error?.code, code);
  assert.equal(envelope.data, undefined);
  return { response, error: envelope.error! };
}

function teamRevision(f: Fixture, teamId: string): number { return f.repository.inspectTeam(teamId).team.revision; }
function projectRevision(f: Fixture, projectId: string): number { return f.repository.inspectProject(projectId).project.revision; }

async function createTeam(f: Fixture, actor = alice, name = "新手参赛队") {
  return ok<Team>(f, actor, { kind: "teams" }, "POST", { name }, 201);
}

async function createProject(f: Fixture, actor = alice, teamId: string | null = null) {
  return ok<Project>(f, actor, { kind: "projects" }, "POST", { name: "独立参赛项目", timezone: "Asia/Shanghai", teamId, goal: "完成可运行演示" }, 201);
}

async function inviteTeam(f: Fixture, teamId: string, role: TeamRole = "member", actor = alice, expiresAt?: string) {
  return ok<TeamInvitationResult>(f, actor, { kind: "teamInvitations", teamId }, "POST", { expectedRevision: teamRevision(f, teamId), role, ...(expiresAt ? { expiresAt } : {}) }, 201);
}

async function joinTeam(f: Fixture, teamId: string, member: Actor, role: TeamRole = "member", captain = alice) {
  const invitation = await inviteTeam(f, teamId, role, captain);
  await ok<AcceptanceResult>(f, member, { kind: "invitationAccept", token: invitation.token }, "POST");
  return invitation;
}

async function joinProject(f: Fixture, projectId: string, member: Actor, role: ProjectRole = "member", manager = alice) {
  const invitation = await ok<{ token: string }>(f, manager, { kind: "projectInvitations", projectId }, "POST", { expectedRevision: projectRevision(f, projectId), role }, 201);
  await ok<AcceptanceResult>(f, member, { kind: "invitationAccept", token: invitation.token }, "POST");
}

test("team HTTP creates, lists, retrieves, renames and dissolves with current membership authority", async () => {
  const f = fixture();
  const team = await createTeam(f);
  assert.equal(team.createdBy, alice.userId);
  assert.equal(team.status, "active");
  const view = await ok<TeamView>(f, alice, { kind: "team", teamId: team.id });
  assert.equal(view.membership.userId, alice.userId);
  assert.equal(view.membership.role, "captain");
  assert.deepEqual(view.members.map((item) => [item.userId, item.role]), [[alice.userId, "captain"]]);
  assert.deepEqual((await ok<Team[]>(f, alice, { kind: "teams" })).map((item) => item.id), [team.id]);
  assert.deepEqual(await ok<Team[]>(f, outsider, { kind: "teams" }), []);
  await denied(f, outsider, { kind: "team", teamId: team.id }, "GET", undefined, 404, "TEAM_UNAVAILABLE");
  await denied(f, null, { kind: "teams" }, "POST", { name: "匿名队伍" }, 401, "UNAUTHENTICATED");
  const renamed = await ok<Team>(f, alice, { kind: "team", teamId: team.id }, "PATCH", { expectedRevision: team.revision, name: "改名后的参赛队" });
  assert.equal(renamed.name, "改名后的参赛队");
  assert.equal(renamed.revision, team.revision + 1);
  const before = f.repository.inspectTeam(team.id);
  const conflict = await denied(f, alice, { kind: "team", teamId: team.id }, "PATCH", { expectedRevision: team.revision, name: "旧版本改名" }, 409, "VERSION_CONFLICT");
  assert.equal(conflict.error.latestRevision, renamed.revision);
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
  const dissolved = await ok<{ team: Team; projectsPreserved: boolean }>(f, alice, { kind: "team", teamId: team.id }, "DELETE", { expectedRevision: renamed.revision });
  assert.equal(dissolved.team.status, "dissolved");
  assert.equal(dissolved.projectsPreserved, true);
  await denied(f, alice, { kind: "team", teamId: team.id }, "PATCH", { expectedRevision: dissolved.team.revision, name: "解散后改名" }, 409, "TEAM_DISSOLVED");
});

test("team HTTP role changes, removal and self-leave preserve history and enforce captain ownership", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  await joinTeam(f, team.id, carol);
  const before = f.repository.inspectTeam(team.id);
  for (const [route, method, body] of [
    [{ kind: "team", teamId: team.id }, "PATCH", { expectedRevision: teamRevision(f, team.id), name: "普通成员不能改名" }],
    [{ kind: "teamMember", teamId: team.id, userId: carol.userId }, "PATCH", { expectedRevision: teamRevision(f, team.id), role: "captain" }],
    [{ kind: "teamMember", teamId: team.id, userId: carol.userId }, "DELETE", { expectedRevision: teamRevision(f, team.id) }],
    [{ kind: "team", teamId: team.id }, "DELETE", { expectedRevision: teamRevision(f, team.id) }],
  ] as const) await denied(f, bob, route, method, body, 403, "TEAM_CAPTAIN_REQUIRED");
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
  const promoted = await ok<{ membership: TeamMember }>(f, alice, { kind: "teamMember", teamId: team.id, userId: bob.userId }, "PATCH", { expectedRevision: teamRevision(f, team.id), role: "captain" });
  assert.equal(promoted.membership.role, "captain");
  await ok(f, bob, { kind: "teamMember", teamId: team.id, userId: carol.userId }, "DELETE", { expectedRevision: teamRevision(f, team.id) });
  assert.equal(f.repository.inspectTeam(team.id).members.find((item) => item.userId === carol.userId)?.status, "removed");
  await denied(f, carol, { kind: "team", teamId: team.id }, "GET", undefined, 404, "TEAM_UNAVAILABLE");
  assert.deepEqual(await ok<Team[]>(f, carol, { kind: "teams" }), []);
  await ok(f, bob, { kind: "teamLeave", teamId: team.id }, "POST", { expectedRevision: teamRevision(f, team.id) });
  assert.equal(f.repository.inspectTeam(team.id).members.find((item) => item.userId === bob.userId)?.status, "left");
  await denied(f, alice, { kind: "teamLeave", teamId: team.id }, "POST", { expectedRevision: teamRevision(f, team.id) }, 409, "LAST_TEAM_CAPTAIN");
});

test("team captain cannot view a private project or act as project manager", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  const project = await createProject(f, bob, team.id);
  assert.deepEqual((await ok<TeamView>(f, alice, { kind: "team", teamId: team.id })).projects, []);
  await denied(f, alice, { kind: "project", projectId: project.id }, "GET", undefined, 404, "PROJECT_UNAVAILABLE");
  await joinProject(f, project.id, alice, "member", bob);
  const before = f.repository.inspectProject(project.id);
  await denied(f, alice, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: projectRevision(f, project.id), goal: "队长越权改目标" }, 403, "PROJECT_MANAGER_REQUIRED");
  await denied(f, alice, { kind: "projectManagementTransfer", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id), targetUserId: bob.userId }, 403, "PROJECT_MANAGER_REQUIRED");
  assert.deepEqual(f.repository.inspectProject(project.id), before);
});

test("team invitations expose no stored hash or replay token and only captains may list or revoke them", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  const issued = await inviteTeam(f, team.id);
  const storedHash = f.repository.inspectTeam(team.id).invitations.find((item) => item.id === issued.invitation.id)!.tokenHash;
  assert.equal(Object.hasOwn(issued.invitation, "tokenHash"), false);
  assert.equal(f.repository.inspectTeam(team.id).invitations.some((item) => JSON.stringify(item).includes(issued.token)), false);
  const listed = await ok<PublicInvitation[]>(f, alice, { kind: "teamInvitations", teamId: team.id });
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes("tokenHash"), false);
  assert.equal(serialized.includes(storedHash), false);
  assert.equal(serialized.includes(issued.token), false);
  const before = f.repository.inspectTeam(team.id);
  await denied(f, bob, { kind: "teamInvitations", teamId: team.id }, "GET", undefined, 403, "TEAM_CAPTAIN_REQUIRED");
  await denied(f, bob, { kind: "teamInvitation", teamId: team.id, invitationId: issued.invitation.id }, "DELETE", { expectedRevision: teamRevision(f, team.id) }, 403, "TEAM_CAPTAIN_REQUIRED");
  await denied(f, outsider, { kind: "teamInvitations", teamId: team.id }, "GET", undefined, 404, "TEAM_UNAVAILABLE");
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
  await ok(f, alice, { kind: "teamInvitation", teamId: team.id, invitationId: issued.invitation.id }, "DELETE", { expectedRevision: teamRevision(f, team.id) });
  await denied(f, carol, { kind: "invitationAccept", token: issued.token }, "POST", undefined, 404, "INVITATION_UNAVAILABLE");
});

test("team invitation HTTP accepts before expiry and refuses the exact boundary without mutation", async () => {
  const f = fixture();
  const team = await createTeam(f);
  const expiresAt = "2026-10-08T02:15:00.000Z";
  const usable = await inviteTeam(f, team.id, "member", alice, expiresAt);
  const expired = await inviteTeam(f, team.id, "member", alice, expiresAt);
  f.setTime("2026-10-08T02:14:59.999Z");
  await ok<AcceptanceResult>(f, bob, { kind: "invitationAccept", token: usable.token }, "POST");
  f.setTime(expiresAt);
  const before = f.repository.inspectTeam(team.id);
  await denied(f, carol, { kind: "invitationAccept", token: expired.token }, "POST", undefined, 409, "INVITATION_EXPIRED");
  const listed = await ok<PublicInvitation[]>(f, alice, { kind: "teamInvitations", teamId: team.id });
  assert.equal(listed.find((item) => item.id === expired.invitation.id)?.displayStatus, "expired");
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
});

test("team invitation replay is idempotent while active and cannot reactivate a departed member", async () => {
  const f = fixture();
  const team = await createTeam(f);
  const issued = await inviteTeam(f, team.id);
  const accepted = await Promise.all([
    ok<AcceptanceResult>(f, bob, { kind: "invitationAccept", token: issued.token }, "POST"),
    ok<AcceptanceResult>(f, bob, { kind: "invitationAccept", token: issued.token }, "POST"),
  ]);
  assert.equal(accepted.filter((item) => !item.alreadyAccepted).length, 1);
  assert.equal(f.repository.inspectTeam(team.id).members.filter((item) => item.userId === bob.userId).length, 1);
  await denied(f, carol, { kind: "invitationAccept", token: issued.token }, "POST", undefined, 409, "INVITATION_ALREADY_USED");
  await ok(f, bob, { kind: "teamLeave", teamId: team.id }, "POST", { expectedRevision: teamRevision(f, team.id) });
  const before = f.repository.inspectTeam(team.id);
  await denied(f, bob, { kind: "invitationAccept", token: issued.token }, "POST", undefined, 409, "INVITATION_ALREADY_USED");
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
  await joinTeam(f, team.id, bob);
  assert.equal(f.repository.inspectTeam(team.id).members.filter((item) => item.userId === bob.userId).length, 1);
  assert.equal(f.repository.inspectTeam(team.id).members.find((item) => item.userId === bob.userId)?.status, "active");
});

test("team dissolution revokes pending invitations and preserves each independent project's memberships and history", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  const aliceProject = await createProject(f, alice, team.id);
  await joinProject(f, aliceProject.id, bob);
  const bobProject = await createProject(f, bob, team.id);
  const personalProject = await createProject(f);
  await ok(f, alice, { kind: "project", projectId: aliceProject.id }, "PATCH", { expectedRevision: projectRevision(f, aliceProject.id), goal: "解散后也保留作品目标" });
  const pending = await inviteTeam(f, team.id);
  const before = [aliceProject, bobProject, personalProject].map((item) => f.repository.inspectProject(item.id));
  const result = await ok<{ team: Team; projectMembershipsUnchanged: boolean; projectsPreserved: boolean }>(f, alice, { kind: "team", teamId: team.id }, "DELETE", { expectedRevision: teamRevision(f, team.id) });
  assert.equal(result.team.status, "dissolved");
  assert.equal(result.projectMembershipsUnchanged, true);
  assert.equal(result.projectsPreserved, true);
  assert.deepEqual([aliceProject, bobProject, personalProject].map((item) => f.repository.inspectProject(item.id)), before);
  assert.equal((await ok<ProjectView>(f, bob, { kind: "project", projectId: aliceProject.id })).membership.status, "active");
  assert.equal((await ok<ProjectView>(f, bob, { kind: "project", projectId: bobProject.id })).membership.role, "manager");
  assert.deepEqual((await ok<TeamView>(f, alice, { kind: "team", teamId: team.id })).projects.map((item) => item.id), [aliceProject.id]);
  await denied(f, carol, { kind: "invitationAccept", token: pending.token }, "POST", undefined, 404, "INVITATION_UNAVAILABLE");
  await denied(f, alice, { kind: "project", projectId: bobProject.id }, "GET", undefined, 404, "PROJECT_UNAVAILABLE");
});

test("archiving retains project history and last-manager protection while rejecting ordinary edits", async () => {
  const f = fixture();
  const project = await createProject(f);
  await ok(f, alice, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: projectRevision(f, project.id), goal: "归档前目标" });
  const before = f.repository.inspectProject(project.id);
  await ok<Project>(f, alice, { kind: "projectStage", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id), stage: "archived", reason: "保留本次参赛历史" });
  const archived = f.repository.inspectProject(project.id);
  assert.equal((await ok<ProjectView>(f, alice, { kind: "project", projectId: project.id })).project.stage, "archived");
  assert.deepEqual(archived.activities.slice(0, before.activities.length), before.activities);
  assert.deepEqual(archived.facts.slice(0, before.facts.length), before.facts);
  await denied(f, alice, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: projectRevision(f, project.id), goal: "不能编辑归档" }, 409, "PROJECT_ARCHIVED");
  await denied(f, alice, { kind: "projectLeave", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id) }, 409, "LAST_PROJECT_MANAGER");
  await denied(f, alice, { kind: "projectMember", projectId: project.id, userId: alice.userId }, "DELETE", { expectedRevision: projectRevision(f, project.id) }, 409, "LAST_PROJECT_MANAGER");
  assert.deepEqual(f.repository.inspectProject(project.id), archived);
});

test("captain transfer is an explicit guarded POST that atomically replaces the sole captain", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  const route: ProjectsHttpRoute = { kind: "teamCaptainTransfer", teamId: team.id };
  const body = { expectedRevision: teamRevision(f, team.id), targetUserId: bob.userId };
  const guardsBefore = f.guardCalls();
  const wrongMethod = await denied(f, alice, route, "GET", undefined, 405, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.response.headers.get("Allow"), "POST");
  await denied(f, null, route, "POST", body, 401, "UNAUTHENTICATED");
  assert.equal(f.guardCalls(), guardsBefore);
  const before = f.repository.inspectTeam(team.id);
  await ok(f, alice, route, "POST", body);
  assert.equal(f.guardCalls(), guardsBefore + 1);
  const after = f.repository.inspectTeam(team.id);
  assert.deepEqual(after.members.map((item) => [item.userId, item.role, item.status]), [[alice.userId, "member", "active"], [bob.userId, "captain", "active"]]);
  assert.equal(after.team.revision, before.team.revision + 1);
  await denied(f, alice, { kind: "team", teamId: team.id }, "PATCH", { expectedRevision: after.team.revision, name: "旧队长不能改名" }, 403, "TEAM_CAPTAIN_REQUIRED");
  await ok(f, bob, { kind: "team", teamId: team.id }, "PATCH", { expectedRevision: after.team.revision, name: "新队长可改名" });
});

test("captain transfer leaves other captains untouched and allows a target who is already captain", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob, "captain");
  await joinTeam(f, team.id, carol, "captain");
  const before = f.repository.inspectTeam(team.id);
  const otherCaptain = before.members.find((item) => item.userId === carol.userId);
  await ok(f, alice, { kind: "teamCaptainTransfer", teamId: team.id }, "POST", { expectedRevision: before.team.revision, targetUserId: bob.userId });
  const after = f.repository.inspectTeam(team.id);
  assert.equal(after.members.find((item) => item.userId === alice.userId)?.role, "member");
  assert.equal(after.members.find((item) => item.userId === bob.userId)?.role, "captain");
  assert.deepEqual(after.members.find((item) => item.userId === carol.userId), otherCaptain);
});

test("captain transfer rejects self or inactive targets, rolls back failures and conflicts on a stale revision", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  await joinTeam(f, team.id, carol);
  await ok(f, carol, { kind: "teamLeave", teamId: team.id }, "POST", { expectedRevision: teamRevision(f, team.id) });
  const route: ProjectsHttpRoute = { kind: "teamCaptainTransfer", teamId: team.id };
  const before = f.repository.inspectTeam(team.id);
  // Exact validation codes may evolve; these invalid handovers must stay rejected and atomic.
  for (const targetUserId of [alice.userId, carol.userId, outsider.userId]) {
    const result = await call(f, alice, route, "POST", { expectedRevision: before.team.revision, targetUserId });
    assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.envelope));
    assert.deepEqual(f.repository.inspectTeam(team.id), before);
  }
  await denied(f, bob, route, "POST", { expectedRevision: before.team.revision, targetUserId: alice.userId }, 403, "TEAM_CAPTAIN_REQUIRED");
  f.repository.failNextCommit(new Error("captain transfer persistence failed"));
  await denied(f, alice, route, "POST", { expectedRevision: before.team.revision, targetUserId: bob.userId }, 500, "INTERNAL_ERROR");
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
  await ok(f, alice, { kind: "team", teamId: team.id }, "PATCH", { expectedRevision: before.team.revision, name: "转交前另一笔修改" });
  const latest = f.repository.inspectTeam(team.id);
  const conflict = await denied(f, alice, route, "POST", { expectedRevision: before.team.revision, targetUserId: bob.userId }, 409, "VERSION_CONFLICT");
  assert.equal(conflict.error.latestRevision, latest.team.revision);
  assert.deepEqual(f.repository.inspectTeam(team.id), latest);
});

test("project management transfer atomically replaces a sole manager and revokes the old manager's edit permission", async () => {
  const f = fixture();
  const project = await createProject(f);
  await joinProject(f, project.id, bob);
  const route: ProjectsHttpRoute = { kind: "projectManagementTransfer", projectId: project.id };
  const before = f.repository.inspectProject(project.id);
  const guardsBefore = f.guardCalls();
  const wrongMethod = await denied(f, alice, route, "GET", undefined, 405, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.response.headers.get("Allow"), "POST");
  await denied(f, null, route, "POST", { expectedRevision: before.project.revision, targetUserId: bob.userId }, 401, "UNAUTHENTICATED");
  assert.equal(f.guardCalls(), guardsBefore);
  await ok(f, alice, route, "POST", { expectedRevision: before.project.revision, targetUserId: bob.userId });
  assert.equal(f.guardCalls(), guardsBefore + 1);
  const after = f.repository.inspectProject(project.id);
  assert.deepEqual(after.members.map((item) => [item.userId, item.role, item.status]), [[alice.userId, "member", "active"], [bob.userId, "manager", "active"]]);
  assert.equal(after.project.revision, before.project.revision + 1);
  assert.deepEqual(after.activities.slice(0, before.activities.length), before.activities);
  assert.deepEqual(after.facts.slice(0, before.facts.length), before.facts);
  await denied(f, alice, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: after.project.revision, goal: "创建者不能绕过转交" }, 403, "PROJECT_MANAGER_REQUIRED");
  await ok(f, bob, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: after.project.revision, goal: "新管理员修改目标" });
});

test("project management transfer preserves other managers and accepts an already-manager target", async () => {
  const f = fixture();
  const project = await createProject(f);
  await joinProject(f, project.id, bob, "manager");
  await joinProject(f, project.id, carol, "manager");
  const before = f.repository.inspectProject(project.id);
  await ok(f, alice, { kind: "projectManagementTransfer", projectId: project.id }, "POST", { expectedRevision: before.project.revision, targetUserId: bob.userId });
  const after = f.repository.inspectProject(project.id);
  assert.equal(after.members.find((item) => item.userId === alice.userId)?.role, "member");
  assert.equal(after.members.find((item) => item.userId === bob.userId)?.role, "manager");
  assert.deepEqual(after.members.find((item) => item.userId === carol.userId), before.members.find((item) => item.userId === carol.userId));
});

test("project management transfer rejects self or inactive targets and never commits half a transfer or stale writes", async () => {
  const f = fixture();
  const project = await createProject(f);
  await joinProject(f, project.id, bob);
  await joinProject(f, project.id, carol);
  await ok(f, carol, { kind: "projectLeave", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id) });
  const route: ProjectsHttpRoute = { kind: "projectManagementTransfer", projectId: project.id };
  const before = f.repository.inspectProject(project.id);
  for (const targetUserId of [alice.userId, carol.userId, outsider.userId]) {
    const result = await call(f, alice, route, "POST", { expectedRevision: before.project.revision, targetUserId });
    assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.envelope));
    assert.deepEqual(f.repository.inspectProject(project.id), before);
  }
  await denied(f, bob, route, "POST", { expectedRevision: before.project.revision, targetUserId: alice.userId }, 403, "PROJECT_MANAGER_REQUIRED");
  f.repository.failNextCommit(new Error("project transfer persistence failed"));
  const failure = await denied(f, alice, route, "POST", { expectedRevision: before.project.revision, targetUserId: bob.userId }, 500, "INTERNAL_ERROR");
  assert.equal(failure.error.message.includes("persistence"), false);
  assert.deepEqual(f.repository.inspectProject(project.id), before);
  await ok(f, alice, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: before.project.revision, goal: "转交前新版本" });
  const latest = f.repository.inspectProject(project.id);
  const conflict = await denied(f, alice, route, "POST", { expectedRevision: before.project.revision, targetUserId: bob.userId }, 409, "VERSION_CONFLICT");
  assert.equal(conflict.error.latestRevision, latest.project.revision);
  assert.deepEqual(f.repository.inspectProject(project.id), latest);
});

test("team and project member endpoints expose history only to current members and validate the history filter", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  await joinTeam(f, team.id, carol);
  const project = await createProject(f, alice, team.id);
  await joinProject(f, project.id, bob);
  await joinProject(f, project.id, carol);
  await ok(f, alice, { kind: "teamMember", teamId: team.id, userId: carol.userId }, "DELETE", { expectedRevision: teamRevision(f, team.id) });
  await ok(f, carol, { kind: "projectLeave", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id) });
  const teamBefore = f.repository.inspectTeam(team.id);
  const projectBefore = f.repository.inspectProject(project.id);
  const currentTeam = await ok<{ members: TeamMember[]; membership: TeamMember }>(f, bob, { kind: "teamMembers", teamId: team.id });
  assert.equal(currentTeam.membership.userId, bob.userId);
  assert.deepEqual(currentTeam.members.map((member) => member.userId), [alice.userId, bob.userId]);
  const historyTeam = await ok<{ members: TeamMember[] }>(f, bob, { kind: "teamMembers", teamId: team.id }, "GET", undefined, 200, "?history=true");
  assert.equal(historyTeam.members.find((member) => member.userId === carol.userId)?.status, "removed");
  const currentProject = await ok<{ members: ProjectMember[] }>(f, bob, { kind: "projectMembers", projectId: project.id });
  assert.deepEqual(currentProject.members.map((member) => member.userId), [alice.userId, bob.userId]);
  const historyProject = await ok<{ members: ProjectMember[] }>(f, bob, { kind: "projectMembers", projectId: project.id }, "GET", undefined, 200, "?history=true");
  assert.equal(historyProject.members.find((member) => member.userId === carol.userId)?.status, "left");
  await denied(f, carol, { kind: "teamMembers", teamId: team.id }, "GET", undefined, 404, "TEAM_UNAVAILABLE", "?history=true");
  await denied(f, carol, { kind: "projectMembers", projectId: project.id }, "GET", undefined, 404, "PROJECT_UNAVAILABLE", "?history=true");
  await denied(f, outsider, { kind: "projectMembers", projectId: project.id }, "GET", undefined, 404, "PROJECT_UNAVAILABLE");
  for (const route of [{ kind: "teamMembers", teamId: team.id }, { kind: "projectMembers", projectId: project.id }] as const) await denied(f, alice, route, "GET", undefined, 422, "INVALID_INPUT", "?history=1");
  assert.deepEqual(f.repository.inspectTeam(team.id), teamBefore);
  assert.deepEqual(f.repository.inspectProject(project.id), projectBefore);
});

test("invitation preview reveals only the intended scope and role without joining or exposing roster, email or token hashes", async () => {
  const f = fixture();
  const team = await createTeam(f);
  const project = await createProject(f);
  const teamInvitation = await inviteTeam(f, team.id);
  const projectInvitation = await ok<{ token: string }>(f, alice, { kind: "projectInvitations", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id), role: "manager" }, 201);
  const beforeTeam = f.repository.inspectTeam(team.id);
  const beforeProject = f.repository.inspectProject(project.id);
  const guardsBefore = f.guardCalls();
  for (const [token, scopeType, scopeId, scopeName, requestedRole] of [
    [teamInvitation.token, "team", team.id, team.name, "member"],
    [projectInvitation.token, "project", project.id, project.name, "manager"],
  ] as const) {
    const preview = await ok<InvitationPreview>(f, bob, { kind: "invitationPreview", token });
    assert.deepEqual(preview, { scopeType, scopeId, scopeName, requestedRole, currentRole: null, expiresAt: "2026-10-11T02:00:00.000Z", alreadyMember: false, alreadyAccepted: false, maxUses: 1, usedUses: 0, remainingUses: 1 });
    const serialized = JSON.stringify(preview);
    for (const privateField of ["tokenHash", "invitedEmail", "members", "goal", "createdBy", token]) assert.equal(serialized.includes(privateField), false);
    await denied(f, null, { kind: "invitationPreview", token }, "GET", undefined, 401, "UNAUTHENTICATED");
    const wrongMethod = await denied(f, bob, { kind: "invitationPreview", token }, "POST", undefined, 405, "METHOD_NOT_ALLOWED");
    assert.equal(wrongMethod.response.headers.get("Allow"), "GET");
  }
  assert.equal(f.guardCalls(), guardsBefore);
  assert.deepEqual(f.repository.inspectTeam(team.id), beforeTeam);
  assert.deepEqual(f.repository.inspectProject(project.id), beforeProject);
});

test("invitation preview enforces consumption, departure, revocation and exact expiry", async () => {
  const f = fixture();
  const team = await createTeam(f);
  const consumed = await joinTeam(f, team.id, bob);
  const preview = await ok<InvitationPreview>(f, bob, { kind: "invitationPreview", token: consumed.token });
  assert.equal(preview.alreadyAccepted, true);
  assert.equal(preview.alreadyMember, true);
  assert.equal(preview.currentRole, "member");
  await denied(f, carol, { kind: "invitationPreview", token: consumed.token }, "GET", undefined, 409, "INVITATION_ALREADY_USED");
  await ok(f, bob, { kind: "teamLeave", teamId: team.id }, "POST", { expectedRevision: teamRevision(f, team.id) });
  await denied(f, bob, { kind: "invitationPreview", token: consumed.token }, "GET", undefined, 409, "INVITATION_ALREADY_USED");
  const revoked = await inviteTeam(f, team.id);
  await ok(f, alice, { kind: "teamInvitation", teamId: team.id, invitationId: revoked.invitation.id }, "DELETE", { expectedRevision: teamRevision(f, team.id) });
  await denied(f, carol, { kind: "invitationPreview", token: revoked.token }, "GET", undefined, 404, "INVITATION_UNAVAILABLE");
  const expiresAt = "2026-10-08T02:15:00.000Z";
  const expired = await inviteTeam(f, team.id, "member", alice, expiresAt);
  f.setTime(expiresAt);
  const before = f.repository.inspectTeam(team.id);
  await denied(f, carol, { kind: "invitationPreview", token: expired.token }, "GET", undefined, 409, "INVITATION_EXPIRED");
  assert.deepEqual(f.repository.inspectTeam(team.id), before);
});

test("archived project management can be transferred without restoring edits or erasing prior history", async () => {
  const f = fixture();
  const project = await createProject(f);
  await joinProject(f, project.id, bob);
  await ok(f, alice, { kind: "projectStage", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id), stage: "archived", reason: "历史项目交接" });
  const before = f.repository.inspectProject(project.id);
  await ok(f, alice, { kind: "projectManagementTransfer", projectId: project.id }, "POST", { expectedRevision: before.project.revision, targetUserId: bob.userId });
  const after = f.repository.inspectProject(project.id);
  assert.equal(after.project.stage, "archived");
  assert.equal(after.members.find((member) => member.userId === alice.userId)?.role, "member");
  assert.equal(after.members.find((member) => member.userId === bob.userId)?.role, "manager");
  assert.deepEqual(after.activities.slice(0, before.activities.length), before.activities);
  assert.deepEqual(after.facts.slice(0, before.facts.length), before.facts);
  await denied(f, bob, { kind: "project", projectId: project.id }, "PATCH", { expectedRevision: after.project.revision, goal: "仍是归档" }, 409, "PROJECT_ARCHIVED");
  await denied(f, bob, { kind: "projectLeave", projectId: project.id }, "POST", { expectedRevision: after.project.revision }, 409, "LAST_PROJECT_MANAGER");
  assert.deepEqual(f.repository.inspectProject(project.id), after);
});

test("email-restricted invitation previews reject mismatched verified identities without disclosing names or addresses", async () => {
  const recipientEmail = "private-recipient@example.com";
  const f = fixture({ identity: { getVerifiedEmail: async (userId) => userId === carol.userId ? recipientEmail : "other-user@example.com" } });
  const team = await createTeam(f, alice, "保密邀请队伍名称");
  const project = await ok<Project>(f, alice, { kind: "projects" }, "POST", { name: "保密项目名称", goal: "保密作品目标", timezone: "Asia/Shanghai" }, 201);
  const teamInvite = await ok<TeamInvitationResult>(f, alice, { kind: "teamInvitations", teamId: team.id }, "POST", { expectedRevision: teamRevision(f, team.id), role: "member", invitedEmail: recipientEmail }, 201);
  const projectInvite = await ok<{ token: string }>(f, alice, { kind: "projectInvitations", projectId: project.id }, "POST", { expectedRevision: projectRevision(f, project.id), role: "member", invitedEmail: recipientEmail }, 201);
  const beforeTeam = f.repository.inspectTeam(team.id);
  const beforeProject = f.repository.inspectProject(project.id);
  for (const [token, scopeName] of [[teamInvite.token, team.name], [projectInvite.token, project.name]]) {
    const result = await call<InvitationPreview>(f, bob, { kind: "invitationPreview", token });
    assert.equal(result.response.status, 403);
    assert.equal(result.envelope.error?.code, "INVITATION_IDENTITY_MISMATCH");
    assert.equal(result.envelope.data, undefined);
    const serialized = JSON.stringify(result.envelope);
    for (const privateValue of [scopeName!, recipientEmail, "other-user@example.com", "scopeName", "invitedEmail"]) assert.equal(serialized.includes(privateValue), false);
    const allowed = await ok<InvitationPreview>(f, carol, { kind: "invitationPreview", token: token! });
    assert.equal(allowed.scopeName, scopeName);
    assert.equal(JSON.stringify(allowed).includes(recipientEmail), false);
    assert.equal(allowed.alreadyAccepted, false);
  }
  assert.deepEqual(f.repository.inspectTeam(team.id), beforeTeam);
  assert.deepEqual(f.repository.inspectProject(project.id), beforeProject);
});

test("same-version concurrent handoff and departure commit once and retain an active captain or manager", async () => {
  const f = fixture();
  const team = await createTeam(f);
  await joinTeam(f, team.id, bob);
  await joinTeam(f, team.id, carol, "captain");
  const beforeTeam = f.repository.inspectTeam(team.id);
  const teamResults = await Promise.all([
    call(f, alice, { kind: "teamCaptainTransfer", teamId: team.id }, "POST", { expectedRevision: beforeTeam.team.revision, targetUserId: bob.userId }),
    call(f, carol, { kind: "teamLeave", teamId: team.id }, "POST", { expectedRevision: beforeTeam.team.revision }),
  ]);
  assert.deepEqual(teamResults.map((result) => result.response.status).sort(), [200, 409]);
  assert.equal(teamResults.find((result) => result.response.status === 409)?.envelope.error?.code, "VERSION_CONFLICT");
  const afterTeam = f.repository.inspectTeam(team.id);
  assert.equal(afterTeam.team.revision, beforeTeam.team.revision + 1);
  assert.ok(afterTeam.members.some((member) => member.status === "active" && member.role === "captain"));
  const project = await createProject(f);
  await joinProject(f, project.id, bob);
  await joinProject(f, project.id, carol, "manager");
  const beforeProject = f.repository.inspectProject(project.id);
  const projectResults = await Promise.all([
    call(f, alice, { kind: "projectManagementTransfer", projectId: project.id }, "POST", { expectedRevision: beforeProject.project.revision, targetUserId: bob.userId }),
    call(f, carol, { kind: "projectLeave", projectId: project.id }, "POST", { expectedRevision: beforeProject.project.revision }),
  ]);
  assert.deepEqual(projectResults.map((result) => result.response.status).sort(), [200, 409]);
  assert.equal(projectResults.find((result) => result.response.status === 409)?.envelope.error?.code, "VERSION_CONFLICT");
  const afterProject = f.repository.inspectProject(project.id);
  assert.equal(afterProject.project.revision, beforeProject.project.revision + 1);
  assert.ok(afterProject.members.some((member) => member.status === "active" && member.role === "manager"));
});

test("management handoff invalidates both confirmed availability collections with role and availability facts in one project version", async () => {
  const f = fixture({ availabilityValidator: { async validate(input) {
    return { windows: input.windows.map((window) => ({ ...window, revision: input.nextRevision })), effectiveMinutes: input.windows.reduce((total, window) => total + window.effectiveMinutes, 0) };
  } } });
  const project = await createProject(f);
  await joinProject(f, project.id, bob);
  for (const actor of [alice, bob]) await ok(f, actor, { kind: "projectAvailability", projectId: project.id }, "PUT", {
    expectedRevision: 0, timezone: "Asia/Shanghai", windows: [{ id: `${actor.userId}_window`, startsAt: "2026-10-09T02:00:00Z", endsAt: "2026-10-09T04:00:00Z", effectiveMinutes: 90 }],
  });
  assert.equal((await f.service.getPlanningContext(alice, project.id)).availability.length, 2);
  const before = f.repository.inspectProject(project.id);
  const handoff = { expectedRevision: before.project.revision, targetUserId: bob.userId };
  f.repository.failNextCommit(new Error("reject all handoff writes"));
  await denied(f, alice, { kind: "projectManagementTransfer", projectId: project.id }, "POST", handoff, 500, "INTERNAL_ERROR");
  assert.deepEqual(f.repository.inspectProject(project.id), before);
  await ok(f, alice, { kind: "projectManagementTransfer", projectId: project.id }, "POST", handoff);
  const after = f.repository.inspectProject(project.id);
  assert.deepEqual(after.availability, before.availability);
  assert.deepEqual(after.activities.slice(0, before.activities.length), before.activities);
  assert.deepEqual(after.facts.slice(0, before.facts.length), before.facts);
  const newFacts = after.facts.slice(before.facts.length);
  const roleFacts = newFacts.filter((fact) => fact.type === "ProjectMemberRoleChanged");
  const availabilityFacts = newFacts.filter((fact) => fact.type === "MemberAvailabilityChanged");
  assert.equal(roleFacts.length, 2);
  assert.equal(availabilityFacts.length, 2);
  assert.deepEqual(availabilityFacts.map((fact) => (fact.payload.after as { userId: string }).userId).sort(), [alice.userId, bob.userId]);
  assert.ok(newFacts.every((fact) => fact.version === after.project.revision));
  const newActivities = after.activities.slice(before.activities.length);
  assert.equal(newActivities.filter((activity) => activity.type === "project_management_transferred").length, 1);
  assert.ok(newActivities.every((activity) => activity.revision === after.project.revision));
  for (const actor of [alice, bob]) {
    const own = await ok<Awaited<ReturnType<ProjectsService["getMyAvailability"]>>>(f, actor, { kind: "projectAvailability", projectId: project.id });
    assert.equal(own.confirmationRequired, true);
    assert.deepEqual(own.availability, before.availability.find((availability) => availability.userId === actor.userId));
  }
  assert.deepEqual((await f.service.getPlanningContext(bob, project.id)).availability, []);
});
