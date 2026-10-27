import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, ProjectRole } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { Project, TeamRole } from "../model.ts";
import type { AvailabilityValidationPort } from "../ports.ts";
import { ProjectsService } from "../service.ts";
import type { ProjectsServiceDependencies } from "../service.ts";
import { MemoryProjectsRepository } from "./memory-repository.ts";
import { createMemberAvailabilityValidator } from "../../planning/index.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["user"] };
const carol: Actor = { userId: "carol", platformRoles: ["user"] };
const dave: Actor = { userId: "dave", platformRoles: ["admin"] };
const initialTime = "2026-10-08T02:00:00.000Z";

const validWindows = [{ id: "window_1", startsAt: "2026-10-09T02:00:00Z", endsAt: "2026-10-09T04:00:00Z", effectiveMinutes: 90 }];
const validator: AvailabilityValidationPort = {
  async validate(input) {
    return { windows: input.windows.map((item) => ({ ...item, revision: input.nextRevision })), effectiveMinutes: input.windows.reduce((total, item) => total + item.effectiveMinutes, 0) };
  },
};

function setup(overrides: Partial<ProjectsServiceDependencies> = {}) {
  const repository = new MemoryProjectsRepository();
  let time = Date.parse(initialTime);
  let sequence = 0;
  let tokenSequence = 0;
  const service = new ProjectsService({
    repository,
    ids: { next: () => `entity_${++sequence}` },
    clock: { now: () => new Date(time) },
    tokens: {
      issue() { const token = `fixture_token_${++tokenSequence}`; return { token, tokenHash: `fixture_hash_${token}` }; },
      hash: (token) => `fixture_hash_${token}`,
    },
    ...overrides,
  });
  return { repository, service, setTime: (instant: string) => { time = Date.parse(instant); } };
}

type Fixture = ReturnType<typeof setup>;

async function createProject(fixture: Fixture, actor = alice, overrides: Partial<Parameters<ProjectsService["createProject"]>[1]> = {}) {
  return fixture.service.createProject(actor, { name: "新人演示作品", timezone: "Asia/Shanghai", goal: "提交可运行的规则解读演示", minimumDeliverable: "演示页面和说明文档", ...overrides });
}

function projectRevision(fixture: Fixture, projectId: string): number { return fixture.repository.inspectProject(projectId).project.revision; }
function teamRevision(fixture: Fixture, teamId: string): number { return fixture.repository.inspectTeam(teamId).team.revision; }

async function addProjectMember(fixture: Fixture, project: Project, actor: Actor, role: ProjectRole = "member", manager = alice) {
  const invitation = await fixture.service.createProjectInvitation(manager, project.id, { expectedRevision: projectRevision(fixture, project.id), role });
  const accepted = await fixture.service.acceptInvitation(actor, invitation.token);
  return { ...invitation, accepted };
}

async function addTeamMember(fixture: Fixture, teamId: string, actor: Actor, role: TeamRole = "member", captain = alice) {
  const invitation = await fixture.service.createTeamInvitation(captain, teamId, { expectedRevision: teamRevision(fixture, teamId), role });
  return fixture.service.acceptInvitation(actor, invitation.token);
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    return true;
  });
}

test("personal creation grants only the creator's current membership and requires a session", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  assert.equal(project.teamId, null);
  assert.equal(project.stage, "draft");
  assert.equal(project.deadlineSource, "unknown");
  assert.equal((await fixture.service.getProject(alice, project.id)).membership.role, "manager");
  assert.equal((await fixture.service.getMembership(project.id, alice.userId))?.status, "active");
  assert.equal(await fixture.service.getMembership(project.id, bob.userId), null);
  assert.deepEqual((await fixture.service.listProjects(alice)).map((item) => item.id), [project.id]);
  assert.deepEqual(await fixture.service.listProjects(dave), []);
  await rejectsCode(fixture.service.getProject(dave, project.id), "PROJECT_UNAVAILABLE");
  await rejectsCode(createProject(fixture, { userId: "", platformRoles: [] }), "UNAUTHENTICATED");
});

test("M05 sees original local offsets before M02 canonicalizes a confirmed window", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  const validating = new ProjectsService({ repository: fixture.repository, clock: { now: () => new Date(initialTime) }, ids: { next: () => "availability" },
    tokens: { issue() { return { token: "unused", tokenHash: "unused" }; }, hash: value => value }, availabilityValidator: createMemberAvailabilityValidator(fixture.repository) });
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(validating.updateMyAvailability(alice, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [{ id: "local", startsAt: "2026-10-09T10:00:00+07:00", endsAt: "2026-10-09T11:00:00+07:00", effectiveMinutes: 60 }] }), "INVALID_AVAILABILITY");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const saved = await validating.updateMyAvailability(alice, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [{ id: "local", startsAt: "2026-10-09T10:00:00+08:00", endsAt: "2026-10-09T11:00:00+08:00", effectiveMinutes: 60 }] });
  assert.equal(saved.availability.windows[0]?.startsAt, "2026-10-09T02:00:00.000Z");
  assert.equal(saved.availability.timezone, "Asia/Shanghai");
});

test("M09 sharing rechecks current reviewed version, merges by project/resource and retains the version", async () => {
  let liveVersion = 3; let published = true;
  const fixture = setup({ resources: { async getReviewedResource(id) { return published ? { id, title: "已审核真实标题", version: liveVersion } : null; } } });
  const project = await createProject(fixture);
  const input = { projectId: project.id, resourceId: "resource", resourceVersion: 3, title: "伪造标题", url: "https://untrusted.example", purposeNote: "界面参考" };
  const first = await fixture.service.addReviewedResource(alice, input);
  const beforeRetry = fixture.repository.inspectProject(project.id);
  const second = await fixture.service.addReviewedResource(alice, input);
  assert.deepEqual(second, first); assert.deepEqual(fixture.repository.inspectProject(project.id), beforeRetry);
  const saved = beforeRetry.bookmarks[0]!;
  assert.equal(saved.resourceVersion, 3); assert.equal(saved.title, "已审核真实标题"); assert.equal(saved.url, null);
  liveVersion = 4;
  await rejectsCode(fixture.service.addReviewedResource(alice, input), "RESOURCE_REFS_UNAVAILABLE");
  assert.deepEqual(fixture.repository.inspectProject(project.id), beforeRetry);
  const updated = await fixture.service.addReviewedResource(alice, { ...input, resourceVersion: 4 });
  assert.equal(updated.id, first.id); assert.equal(fixture.repository.inspectProject(project.id).bookmarks[0]?.resourceVersion, 4);
  published = false;
  await rejectsCode(fixture.service.addReviewedResource(alice, { ...input, resourceVersion: 4 }), "RESOURCE_NOT_REVIEWED");
  await rejectsCode(fixture.service.addReviewedResource(dave, { ...input, resourceVersion: 4 }), "PROJECT_UNAVAILABLE");
});

test("project creation rejects JSON fields that try to choose another identity or creator", async () => {
  const fixture = setup();
  for (const field of ["userId", "createdBy"]) {
    const input = { name: "伪造身份创建", timezone: "Asia/Shanghai", [field]: carol.userId };
    await rejectsCode(fixture.service.createProject(alice, input), "INVALID_INPUT");
  }
  assert.deepEqual(await fixture.service.listProjects(alice), []);
  assert.deepEqual(await fixture.service.listProjects(carol), []);
  assert.deepEqual(await fixture.repository.listPendingFacts(100), []);
});

test("team captain and historical createdBy never bypass project membership or manager role", async () => {
  const fixture = setup();
  const team = await fixture.service.createTeam(alice, { name: "同队不同项目" });
  await addTeamMember(fixture, team.id, bob);
  const project = await createProject(fixture, bob, { teamId: team.id });
  await rejectsCode(fixture.service.getProject(alice, project.id), "PROJECT_UNAVAILABLE");
  assert.deepEqual((await fixture.service.getTeam(alice, team.id)).projects, []);
  await addProjectMember(fixture, project, alice, "member", bob);
  await rejectsCode(fixture.service.editProject(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), goal: "队长越权修改" }), "PROJECT_MANAGER_REQUIRED");
  await addProjectMember(fixture, project, carol, "manager", bob);
  await fixture.service.leaveProject(bob, project.id, projectRevision(fixture, project.id));
  assert.equal(fixture.repository.inspectProject(project.id).project.createdBy, bob.userId);
  assert.equal((await fixture.service.getMembership(project.id, bob.userId))?.status, "left");
  await rejectsCode(fixture.service.getProject(bob, project.id), "PROJECT_UNAVAILABLE");
  assert.deepEqual(await fixture.service.listProjects(bob), []);
  await fixture.service.editProject(carol, project.id, { expectedRevision: projectRevision(fixture, project.id), goal: "当前管理员修改" });
});

test("a project can be created for a team only by its active member", async () => {
  const fixture = setup();
  const team = await fixture.service.createTeam(alice, { name: "团队" });
  await rejectsCode(createProject(fixture, bob, { teamId: team.id }), "TEAM_UNAVAILABLE");
  assert.deepEqual(await fixture.service.listProjects(bob), []);
  await addTeamMember(fixture, team.id, bob);
  await fixture.service.leaveTeam(bob, team.id, teamRevision(fixture, team.id));
  await rejectsCode(createProject(fixture, bob, { teamId: team.id }), "TEAM_UNAVAILABLE");
  await fixture.service.dissolveTeam(alice, team.id, teamRevision(fixture, team.id));
  await rejectsCode(createProject(fixture, alice, { teamId: team.id }), "TEAM_DISSOLVED");
});

test("team association checks both authorities and never adds other team members", async () => {
  const fixture = setup();
  const team = await fixture.service.createTeam(alice, { name: "关联队伍" });
  await addTeamMember(fixture, team.id, bob);
  await addTeamMember(fixture, team.id, carol);
  const project = await createProject(fixture, bob);
  const initialRevision = projectRevision(fixture, project.id);
  await rejectsCode(fixture.service.associateTeam(alice, project.id, { expectedRevision: initialRevision, teamId: team.id, confirmNoAutomaticMembers: true }), "PROJECT_UNAVAILABLE");
  await addProjectMember(fixture, project, dave, "manager", bob);
  await rejectsCode(fixture.service.associateTeam(dave, project.id, { expectedRevision: projectRevision(fixture, project.id), teamId: team.id, confirmNoAutomaticMembers: true }), "TEAM_UNAVAILABLE");
  const associated = await fixture.service.associateTeam(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), teamId: team.id, confirmNoAutomaticMembers: true });
  assert.equal(associated.teamId, team.id);
  assert.deepEqual((await fixture.service.getProject(bob, project.id)).members.map((item) => item.userId).sort(), ["bob", "dave"]);
  await rejectsCode(fixture.service.getProject(carol, project.id), "PROJECT_UNAVAILABLE");
  assert.deepEqual((await fixture.service.getTeam(alice, team.id)).projects, []);
});

test("nested team and project transactions roll back both scopes and append-only history", async () => {
  const fixture = setup();
  const team = await fixture.service.createTeam(alice, { name: "事务队伍" });
  const project = await createProject(fixture);
  const beforeTeam = fixture.repository.inspectTeam(team.id);
  const beforeProject = fixture.repository.inspectProject(project.id);
  await assert.rejects(fixture.repository.withTeam(team.id, async (teamDraft) => {
    teamDraft.team.name = "未提交队名";
    await fixture.repository.withProject(project.id, async (projectDraft) => {
      projectDraft.project.name = "未提交项目名";
      projectDraft.activities.push({ ...beforeProject.activities[0]!, id: "rollback_activity" });
      projectDraft.facts.push({ ...beforeProject.facts[0]!, eventId: "rollback_fact" });
    });
    throw new Error("rollback nested work");
  }), /rollback nested work/);
  assert.deepEqual(fixture.repository.inspectTeam(team.id), beforeTeam);
  assert.deepEqual(fixture.repository.inspectProject(project.id), beforeProject);
});

test("leaving a team preserves independent project access, work, and confirmed availability", async () => {
  const fixture = setup({ availabilityValidator: validator });
  const team = await fixture.service.createTeam(alice, { name: "队伍退出" });
  await addTeamMember(fixture, team.id, bob);
  const project = await createProject(fixture, bob, { teamId: team.id });
  await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows });
  const beforeProject = fixture.repository.inspectProject(project.id);
  const result = await fixture.service.leaveTeam(bob, team.id, teamRevision(fixture, team.id));
  assert.equal(result.projectMembershipsUnchanged, true);
  assert.equal((await fixture.service.getProject(bob, project.id)).membership.role, "manager");
  assert.deepEqual(fixture.repository.inspectProject(project.id), beforeProject);
  assert.equal((await fixture.service.getPlanningContext(bob, project.id)).availability.length, 1);
});

test("same-user concurrent invitation retries consume once and preserve one membership", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  const issued = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member" });
  assert.equal(Object.hasOwn(issued.invitation, "tokenHash"), false);
  const results = await Promise.all(Array.from({ length: 8 }, () => fixture.service.acceptInvitation(bob, issued.token)));
  assert.equal(results.filter((item) => !item.alreadyAccepted).length, 1);
  const stored = fixture.repository.inspectProject(project.id);
  assert.equal(stored.members.filter((item) => item.userId === bob.userId).length, 1);
  assert.equal(stored.project.revision, issued.projectRevision + 1);
  assert.equal(stored.invitations[0]?.acceptedBy, bob.userId);
  assert.equal(stored.invitations[0]?.revision, 2);
  assert.equal(stored.facts.filter((item) => item.type === "ProjectMemberJoined").length, 1);
});

test("different users racing a single invitation cannot both acquire membership", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  const issued = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member" });
  const results = await Promise.allSettled([fixture.service.acceptInvitation(bob, issued.token), fixture.service.acceptInvitation(carol, issued.token)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof DomainError);
  assert.equal(rejected.reason.code, "INVITATION_ALREADY_USED");
  const stored = fixture.repository.inspectProject(project.id);
  assert.equal(stored.members.filter((item) => item.status === "active").length, 2);
  assert.equal(stored.facts.filter((item) => item.type === "ProjectMemberJoined").length, 1);
});

test("a new invitation for an active member cannot silently promote their role", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob);
  const issued = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "manager" });
  const result = await fixture.service.acceptInvitation(bob, issued.token);
  assert.equal(result.membership.role, "member");
  assert.equal(fixture.repository.inspectProject(project.id).facts.filter((item) => item.type === "ProjectMemberJoined").length, 1);
  await rejectsCode(fixture.service.editProject(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), name: "不能提升权限" }), "PROJECT_MANAGER_REQUIRED");
});

test("expiry is exclusive at the precise instant; listing expired invitations changes no data", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  const expiresAt = "2026-10-08T02:10:00.000Z";
  const before = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member", expiresAt });
  const atBoundary = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member", expiresAt });
  fixture.setTime("2026-10-08T02:09:59.999Z");
  await fixture.service.acceptInvitation(bob, before.token);
  fixture.setTime(expiresAt);
  const snapshot = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.acceptInvitation(carol, atBoundary.token), "INVITATION_EXPIRED");
  const listed = await fixture.service.listProjectInvitations(alice, project.id);
  assert.equal(listed.find((item) => item.id === atBoundary.invitation.id)?.displayStatus, "expired");
  assert.deepEqual(fixture.repository.inspectProject(project.id), snapshot);
});

test("revocation blocks acceptance; a consumed invitation is not a removal operation", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  const issued = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member" });
  await fixture.service.revokeProjectInvitation(alice, project.id, issued.invitation.id, projectRevision(fixture, project.id));
  await rejectsCode(fixture.service.acceptInvitation(bob, issued.token), "INVITATION_UNAVAILABLE");
  const accepted = await addProjectMember(fixture, project, bob);
  await rejectsCode(fixture.service.revokeProjectInvitation(alice, project.id, accepted.invitation.id, projectRevision(fixture, project.id)), "INVITATION_ALREADY_USED");
  assert.equal((await fixture.service.getMembership(project.id, bob.userId))?.status, "active");
});

test("specified-email invitation trusts only verified identity and remains pending on mismatch", async () => {
  const fixture = setup({ identity: { getVerifiedEmail: async (userId) => userId === carol.userId ? "NEWCOMER@EXAMPLE.COM" : null } });
  const project = await createProject(fixture);
  const issued = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member", invitedEmail: "newcomer@example.com" });
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.acceptInvitation(bob, issued.token), "INVITATION_IDENTITY_MISMATCH");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const result = await fixture.service.acceptInvitation(carol, issued.token);
  assert.equal(result.membership.userId, carol.userId);
});

test("admission check runs under the project lock and rolls back rejected joins", async () => {
  const observedCounts: number[] = [];
  const fixture = setup({ admission: { async check(input) {
    observedCounts.push(input.activeUserIds.length);
    await Promise.resolve();
    if (input.activeUserIds.length >= 2) throw new DomainError("EVENT_CAPACITY", "核验名额已满。", { status: 409 });
  } } });
  const project = await createProject(fixture);
  const first = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member" });
  const second = await fixture.service.createProjectInvitation(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), role: "member" });
  const results = await Promise.allSettled([fixture.service.acceptInvitation(bob, first.token), fixture.service.acceptInvitation(carol, second.token)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.deepEqual(observedCounts, [1, 2]);
  const stored = fixture.repository.inspectProject(project.id);
  assert.equal(stored.invitations.filter((item) => item.status === "pending").length, 1);
  assert.equal(stored.members.filter((item) => item.status === "active").length, 2);
});

test("leaving preserves authorship and invalidates old invitation and availability; rejoining needs reconfirmation", async () => {
  const fixture = setup({ availabilityValidator: validator });
  const project = await createProject(fixture);
  const joined = await addProjectMember(fixture, project, bob);
  const saved = await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows });
  const bookmark = await fixture.service.addResource(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), url: "https://example.com/reference", title: "成员参考", purposeNote: "演示设计" });
  const historicalMembershipId = joined.accepted.membership.membershipId;
  const result = await fixture.service.leaveProject(bob, project.id, projectRevision(fixture, project.id));
  assert.equal(result.taskReassignmentPending, true);
  assert.equal(result.planReviewRequired, true);
  assert.equal((await fixture.service.getPlanningContext(alice, project.id)).members.some((item) => item.userId === bob.userId), false);
  assert.deepEqual(await fixture.service.getAvailability(alice, project.id), []);
  await rejectsCode(fixture.service.acceptInvitation(bob, joined.token), "INVITATION_ALREADY_USED");
  await rejectsCode(fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: saved.availability.revision, timezone: "Asia/Shanghai", windows: validWindows }), "PROJECT_UNAVAILABLE");
  const rejoined = await addProjectMember(fixture, project, bob);
  assert.equal(rejoined.accepted.membership.membershipId, historicalMembershipId);
  assert.equal(rejoined.accepted.membership.revision, 3);
  const own = await fixture.service.getMyAvailability(bob, project.id);
  assert.equal(own.availability?.revision, saved.availability.revision);
  assert.equal(own.confirmationRequired, true);
  assert.deepEqual(await fixture.service.getAvailability(alice, project.id), []);
  assert.deepEqual((await fixture.service.getPlanningContext(alice, project.id)).availability, []);
  const confirmed = await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: saved.availability.revision, timezone: "Asia/Shanghai", windows: validWindows });
  assert.equal(confirmed.availability.membershipRevision, rejoined.accepted.membership.revision);
  assert.equal((await fixture.service.getMyAvailability(bob, project.id)).confirmationRequired, false);
  assert.equal((await fixture.service.getPlanningContext(alice, project.id)).availability.length, 1);
  const stored = fixture.repository.inspectProject(project.id);
  assert.equal(stored.bookmarks.find((item) => item.id === bookmark.bookmark.id)?.savedBy, bob.userId);
  assert.equal(stored.facts.filter((item) => item.type === "ProjectMemberJoined").length, 2);
  const leftFact = stored.facts.find((item) => item.eventId === result.changeFactId);
  assert.ok(leftFact);
  assert.deepEqual(leftFact.payload.after, { userId: bob.userId, status: "left", unfinishedTasksNeedReassignment: true, preserveCompletedWork: true, invalidateAvailability: true });
});

test("failed persistence never commits departure without its fact or loses earlier history", async () => {
  const fixture = setup({ availabilityValidator: validator });
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob);
  await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows });
  const before = fixture.repository.inspectProject(project.id);
  fixture.repository.failNextCommit(new Error("storage offline"));
  await assert.rejects(fixture.service.removeProjectMember(alice, project.id, bob.userId, projectRevision(fixture, project.id)), /storage offline/);
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const result = await fixture.service.removeProjectMember(alice, project.id, bob.userId, projectRevision(fixture, project.id));
  const after = fixture.repository.inspectProject(project.id);
  assert.equal(after.members.find((item) => item.userId === bob.userId)?.status, "removed");
  assert.deepEqual(after.availability, before.availability);
  assert.deepEqual(after.activities.slice(0, before.activities.length), before.activities);
  assert.deepEqual(after.facts.slice(0, before.facts.length), before.facts);
  assert.equal(after.facts.at(-1)?.eventId, result.changeFactId);
  await fixture.repository.acknowledgeFact(result.changeFactId!);
  assert.equal((await fixture.repository.listPendingFacts(100)).some((item) => item.eventId === result.changeFactId), false);
  assert.equal(fixture.repository.inspectProject(project.id).facts.at(-1)?.eventId, result.changeFactId);
});

test("two managers racing to leave retain one manager and reject a retry by the last manager", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob, "manager");
  const revision = projectRevision(fixture, project.id);
  const results = await Promise.allSettled([fixture.service.leaveProject(alice, project.id, revision), fixture.service.leaveProject(bob, project.id, revision)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const managers = fixture.repository.inspectProject(project.id).members.filter((item) => item.status === "active" && item.role === "manager");
  assert.equal(managers.length, 1);
  const remaining = managers[0]!.userId === alice.userId ? alice : bob;
  await rejectsCode(fixture.service.leaveProject(remaining, project.id, projectRevision(fixture, project.id)), "LAST_PROJECT_MANAGER");
  await rejectsCode(fixture.service.removeProjectMember(remaining, project.id, remaining.userId, projectRevision(fixture, project.id)), "LAST_PROJECT_MANAGER");
});

test("concurrent self-demotion and manager exit retain one manager, including on latest-version retry", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob, "manager");
  const revision = projectRevision(fixture, project.id);
  const results = await Promise.allSettled([
    fixture.service.changeProjectRole(alice, project.id, alice.userId, { expectedRevision: revision, role: "member" }),
    fixture.service.leaveProject(bob, project.id, revision),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const managers = fixture.repository.inspectProject(project.id).members.filter((item) => item.status === "active" && item.role === "manager");
  assert.equal(managers.length, 1);
  const remaining = managers[0]!.userId === alice.userId ? alice : bob;
  await rejectsCode(fixture.service.changeProjectRole(remaining, project.id, remaining.userId, { expectedRevision: projectRevision(fixture, project.id), role: "member" }), "LAST_PROJECT_MANAGER");
});

test("stale project edits conflict without overwriting goals or adding history", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob, "manager");
  const revision = projectRevision(fixture, project.id);
  const updated = await fixture.service.editProject(alice, project.id, { expectedRevision: revision, goal: "先保存的作品目标" });
  const before = fixture.repository.inspectProject(project.id);
  await assert.rejects(fixture.service.editProject(bob, project.id, { expectedRevision: revision, goal: "过期作品目标" }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.latestRevision, updated.revision);
    assert.equal(error.recoveryAction, "review_latest_version");
    return true;
  });
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
});

test("window validator failure rolls back; updates are self-only and collection versions conflict", async () => {
  let shouldFail = false;
  const users: string[] = [];
  const fixture = setup({ availabilityValidator: { async validate(input) {
    users.push(input.userId);
    if (shouldFail) throw new DomainError("INVALID_WINDOW", "窗口重叠。", { status: 422 });
    return validator.validate(input);
  } } });
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob);
  const first = await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows });
  assert.equal(first.availability.userId, bob.userId);
  assert.equal(first.availability.revision, 1);
  assert.equal(first.availability.effectiveMinutes, 90);
  shouldFail = true;
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 1, timezone: "Asia/Shanghai", windows: [] }), "INVALID_WINDOW");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  await rejectsCode(fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [] }), "VERSION_CONFLICT");
  assert.deepEqual(users, [bob.userId, bob.userId]);
  shouldFail = false;
  await fixture.service.updateMyAvailability(alice, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [] });
  assert.equal((await fixture.service.getMyAvailability(bob, project.id)).availability?.effectiveMinutes, 90);
  const foreignInput = { expectedRevision: 1, timezone: "Asia/Shanghai", windows: [], userId: alice.userId };
  await rejectsCode(fixture.service.updateMyAvailability(bob, project.id, foreignInput), "INVALID_INPUT");
});

test("concurrent availability saves use one collection revision and preserve the winner", async () => {
  const fixture = setup({ availabilityValidator: validator });
  const project = await createProject(fixture);
  const results = await Promise.allSettled([
    fixture.service.updateMyAvailability(alice, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows }),
    fixture.service.updateMyAvailability(alice, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: [] }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const winner = results.find((item) => item.status === "fulfilled");
  assert.ok(winner?.status === "fulfilled");
  const loser = results.find((item) => item.status === "rejected");
  assert.ok(loser?.status === "rejected" && loser.reason instanceof DomainError);
  assert.equal(loser.reason.code, "VERSION_CONFLICT");
  assert.deepEqual((await fixture.service.getMyAvailability(alice, project.id)).availability, winner.value.availability);
  assert.equal(fixture.repository.inspectProject(project.id).facts.filter((item) => item.type === "MemberAvailabilityChanged").length, 1);
});

test("role changes invalidate confirmed availability and atomically notify planning without rewriting the collection", async () => {
  const fixture = setup({ availabilityValidator: validator });
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob);
  const saved = await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows });
  const before = fixture.repository.inspectProject(project.id);
  fixture.repository.failNextCommit(new Error("cannot persist role facts"));
  await assert.rejects(fixture.service.changeProjectRole(alice, project.id, bob.userId, { expectedRevision: projectRevision(fixture, project.id), role: "manager" }), /cannot persist role facts/);
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const changed = await fixture.service.changeProjectRole(alice, project.id, bob.userId, { expectedRevision: projectRevision(fixture, project.id), role: "manager" });
  assert.equal(changed.availabilityConfirmationRequired, true);
  assert.equal(changed.membership.revision, saved.availability.membershipRevision + 1);
  assert.deepEqual(fixture.repository.inspectProject(project.id).availability, before.availability);
  assert.deepEqual((await fixture.service.getPlanningContext(alice, project.id)).availability, []);
  assert.equal((await fixture.service.getMyAvailability(bob, project.id)).confirmationRequired, true);
  const notification = (await fixture.repository.listPendingFacts(100)).find((item) => item.type === "MemberAvailabilityChanged" && item.version === changed.projectRevision);
  assert.ok(notification);
  assert.deepEqual(notification.payload.after, { userId: bob.userId, availabilityRevision: saved.availability.revision, membershipRevision: changed.membership.revision, confirmationRequired: true, reason: "membership_revision_changed" });
  await fixture.service.updateMyAvailability(bob, project.id, { expectedRevision: saved.availability.revision, timezone: "Asia/Shanghai", windows: validWindows });
  assert.equal((await fixture.service.getPlanningContext(alice, project.id)).availability.length, 1);
});

test("unconnected or invalid availability validation cannot claim a saved window collection", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.updateMyAvailability(alice, project.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows }), "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const invalidFixture = setup({ availabilityValidator: { async validate() { return { windows: [{ ...validWindows[0]!, revision: 999 }], effectiveMinutes: 90 }; } } });
  const invalidProject = await createProject(invalidFixture);
  await rejectsCode(invalidFixture.service.updateMyAvailability(alice, invalidProject.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows }), "INVALID_AVAILABILITY_RESULT");
  assert.deepEqual(invalidFixture.repository.inspectProject(invalidProject.id).availability, []);
});

test("stage transitions require real workflow facts and a passed deadline never becomes success", async () => {
  const fixture = setup();
  const project = await createProject(fixture, alice, { deadline: "2026-10-07T02:00:00Z" });
  await fixture.service.transitionStage(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), stage: "preparing", reason: "确认作品目标" });
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.transitionStage(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), stage: "active", reason: "尝试进入执行" }), "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const retrospective = await fixture.service.transitionStage(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), stage: "retrospective", reason: "未提交，记录过程" });
  assert.equal(retrospective.stage, "retrospective");
  assert.equal(fixture.repository.inspectProject(project.id).facts.some((item) => item.payload.after && (item.payload.after as { stage?: string }).stage === "submitted"), false);
  const noSubmission = setup({ workflow: { hasConfirmedPlanOrManualTasks: async () => true, hasSubmissionRecord: async () => false } });
  const secondProject = await createProject(noSubmission);
  for (const stage of ["preparing", "active", "finalizing"] as const) await noSubmission.service.transitionStage(alice, secondProject.id, { expectedRevision: projectRevision(noSubmission, secondProject.id), stage, reason: "具备实际依据" });
  const beforeSubmission = noSubmission.repository.inspectProject(secondProject.id);
  await rejectsCode(noSubmission.service.transitionStage(alice, secondProject.id, { expectedRevision: projectRevision(noSubmission, secondProject.id), stage: "submitted", reason: "没有记录仍尝试提交" }), "SUBMISSION_RECORD_REQUIRED");
  assert.deepEqual(noSubmission.repository.inspectProject(secondProject.id), beforeSubmission);
});

test("copy selects only requested goal and deliverable, resetting team, event, deadline, members, and stage", async () => {
  const fixture = setup({ workflow: { hasConfirmedPlanOrManualTasks: async () => true, hasSubmissionRecord: async () => true }, availabilityValidator: validator });
  const team = await fixture.service.createTeam(alice, { name: "旧赛队伍" });
  const source = await createProject(fixture, alice, { teamId: team.id, eventId: "old_event", deadline: "2026-10-20T12:00:00Z" });
  await addProjectMember(fixture, source, bob);
  await fixture.service.updateMyAvailability(alice, source.id, { expectedRevision: 0, timezone: "Asia/Shanghai", windows: validWindows });
  await fixture.service.addResource(bob, source.id, { expectedRevision: projectRevision(fixture, source.id), url: "https://example.com/old-reference", title: "旧资料", purposeNote: "仅旧项目" });
  for (const stage of ["preparing", "active", "finalizing", "submitted", "retrospective", "archived"] as const) await fixture.service.transitionStage(alice, source.id, { expectedRevision: projectRevision(fixture, source.id), stage, reason: "真实记录驱动" });
  const copied = await fixture.service.cloneProject(bob, source.id, { name: "下一场比赛", copyGoal: true, copyMinimumDeliverable: true });
  assert.equal(copied.goal, source.goal);
  assert.equal(copied.minimumDeliverable, source.minimumDeliverable);
  assert.equal(copied.teamId, null);
  assert.equal(copied.eventId, null);
  assert.equal(copied.deadline, null);
  assert.equal(copied.deadlineSource, "unknown");
  assert.equal(copied.stage, "draft");
  assert.equal(copied.createdBy, bob.userId);
  const aggregate = fixture.repository.inspectProject(copied.id);
  assert.deepEqual(aggregate.members.map((item) => [item.userId, item.role, item.status]), [[bob.userId, "manager", "active"]]);
  assert.deepEqual(aggregate.availability, []);
  assert.deepEqual(aggregate.invitations, []);
  assert.deepEqual(aggregate.bookmarks, []);
  assert.deepEqual(aggregate.facts.map((item) => item.type), ["ProjectCreated"]);
  await rejectsCode(fixture.service.getProject(alice, copied.id), "PROJECT_UNAVAILABLE");
});

test("personal favorites stay private until explicit project reference; only reviewed IDs are accepted", async () => {
  const personalFavorites = new Map([[bob.userId, ["reviewed_resource"]]]);
  const resourceLookups: string[] = [];
  const fixture = setup({ resources: { async getReviewedResource(resourceId) {
    resourceLookups.push(resourceId);
    return resourceId === "reviewed_resource" ? { id: resourceId, title: "审核资源名", version: 1 } : null;
  } } });
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob);
  assert.deepEqual(await fixture.service.listResources(alice, project.id), []);
  assert.deepEqual(personalFavorites.get(bob.userId), ["reviewed_resource"]);
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.addResource(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), resourceId: "not_reviewed", purposeNote: "不能假审核" }), "RESOURCE_NOT_REVIEWED");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  const saved = await fixture.service.addResource(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), resourceId: "reviewed_resource", title: "伪造资源名", purposeNote: "明确分享到项目" });
  assert.equal(saved.bookmark.title, "审核资源名");
  assert.equal(saved.bookmark.sourceStatus, "reviewed_resource");
  assert.deepEqual((await fixture.service.listResources(alice, project.id)).map((item) => item.resourceId), ["reviewed_resource"]);
  const duplicate = await fixture.service.addResource(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), resourceId: "reviewed_resource", purposeNote: "重复收藏" });
  assert.equal(duplicate.alreadySaved, true);
  assert.equal(duplicate.bookmark.id, saved.bookmark.id);
  assert.equal(duplicate.projectRevision, saved.projectRevision);
  assert.deepEqual(resourceLookups, ["not_reviewed", "reviewed_resource", "reviewed_resource"]);
  assert.deepEqual(personalFavorites.get(bob.userId), ["reviewed_resource"]);
});

test("manual references reject credentials and executable schemes, while valid links remain unverified", async () => {
  const fixture = setup();
  const project = await createProject(fixture);
  for (const url of ["javascript:alert(1)", "https://user:password@example.com/design", "https://user@example.com/design", "data:text/html,test", "/relative/path"]) {
    const before = fixture.repository.inspectProject(project.id);
    await rejectsCode(fixture.service.addResource(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), url, title: "链接", purposeNote: "参考" }), "INVALID_INPUT");
    assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  }
  const saved = await fixture.service.addResource(alice, project.id, { expectedRevision: projectRevision(fixture, project.id), url: "https://example.com/design", title: "成员设计参考", purposeNote: "尚未核验许可" });
  assert.equal(saved.bookmark.resourceId, null);
  assert.equal(saved.bookmark.sourceStatus, "member_reference_unverified");
});

test("project resource removal is restricted to its owner or current manager and retains source/history", async () => {
  const fixture = setup({ resources: { getReviewedResource: async (id) => ({ id, title: "来源资源", version: 1 }) } });
  const project = await createProject(fixture);
  await addProjectMember(fixture, project, bob);
  await addProjectMember(fixture, project, carol);
  const saved = await fixture.service.addResource(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), resourceId: "reviewed_resource", purposeNote: "完成演示" });
  const before = fixture.repository.inspectProject(project.id);
  await rejectsCode(fixture.service.removeResource(carol, project.id, saved.bookmark.id, projectRevision(fixture, project.id)), "BOOKMARK_OWNER_REQUIRED");
  assert.deepEqual(fixture.repository.inspectProject(project.id), before);
  await fixture.service.removeResource(bob, project.id, saved.bookmark.id, projectRevision(fixture, project.id));
  assert.deepEqual(await fixture.service.listResources(alice, project.id), []);
  assert.equal(fixture.repository.inspectProject(project.id).bookmarks[0]?.resourceId, "reviewed_resource");
  assert.equal(fixture.repository.inspectProject(project.id).bookmarks[0]?.savedBy, bob.userId);
  const restored = await fixture.service.addResource(bob, project.id, { expectedRevision: projectRevision(fixture, project.id), resourceId: "reviewed_resource", purposeNote: "重新共享" });
  assert.equal(restored.bookmark.id, saved.bookmark.id);
  await fixture.service.removeResource(alice, project.id, saved.bookmark.id, projectRevision(fixture, project.id));
  assert.equal(fixture.repository.inspectProject(project.id).bookmarks[0]?.status, "removed");
});

test("team invitation retries and last-captain protection are independent of project managers", async () => {
  const fixture = setup();
  const team = await fixture.service.createTeam(alice, { name: "队长职责" });
  await rejectsCode(fixture.service.leaveTeam(alice, team.id, teamRevision(fixture, team.id)), "LAST_TEAM_CAPTAIN");
  await rejectsCode(fixture.service.changeTeamRole(alice, team.id, alice.userId, { expectedRevision: teamRevision(fixture, team.id), role: "member" }), "LAST_TEAM_CAPTAIN");
  const issued = await fixture.service.createTeamInvitation(alice, team.id, { expectedRevision: teamRevision(fixture, team.id), role: "captain" });
  const accepted = await Promise.all([fixture.service.acceptInvitation(bob, issued.token), fixture.service.acceptInvitation(bob, issued.token)]);
  assert.equal(accepted.filter((item) => !item.alreadyAccepted).length, 1);
  assert.equal(fixture.repository.inspectTeam(team.id).members.length, 2);
  await fixture.service.leaveTeam(alice, team.id, teamRevision(fixture, team.id));
  await rejectsCode(fixture.service.acceptInvitation(alice, issued.token), "INVITATION_ALREADY_USED");
  await rejectsCode(fixture.service.leaveTeam(bob, team.id, teamRevision(fixture, team.id)), "LAST_TEAM_CAPTAIN");
  await fixture.service.dissolveTeam(bob, team.id, teamRevision(fixture, team.id));
  await fixture.service.leaveTeam(bob, team.id, teamRevision(fixture, team.id));
});
