import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { Actor, ProjectRole } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../../shared/persistence.ts";
import type { TeamRole } from "../model.ts";
import { PostgresProjectsRepository } from "../postgres.ts";
import { ProjectsService } from "../service.ts";

/**
 * These tests execute the complete M02 migration in an in-memory PGlite PostgreSQL engine.
 * They validate SQL constraints and transactions through the public module service/repository.
 * PGlite has one connection: these tests do not establish multi-connection PostgreSQL concurrency
 * or a configured production database, and this adapter exists only in this test file.
 */
const migration = readFile(new URL("../sql/001-projects.sql", import.meta.url), "utf8");
const initialTime = "2026-10-08T02:00:00.000Z";
const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["user"] };
const carol: Actor = { userId: "carol", platformRoles: ["user"] };
const dave: Actor = { userId: "dave", platformRoles: ["admin"] };
type Row = Record<string, unknown>;
type RoleUpdateFailure = { table: string; remaining: number; completed: number };

class PgliteTestDatabase implements DatabasePort {
  private readonly engine: PGlite;
  private failure: RoleUpdateFailure | null = null;
  transactionCount = 0;

  constructor(engine: PGlite) { this.engine = engine; }

  query<ResultRow = Record<string, unknown>>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<ResultRow>> {
    return this.execute<ResultRow>(this.engine, statement, parameters);
  }

  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount++;
    return this.engine.transaction(async (transaction) => work({
      query: <ResultRow = Record<string, unknown>>(statement: string, parameters: readonly unknown[] = []) => this.execute<ResultRow>(transaction, statement, parameters),
    }));
  }

  failAfterTwoRoleUpdates(table: "projects_team_membership" | "projects_project_membership"): RoleUpdateFailure {
    const failure = { table, remaining: 2, completed: 0 };
    this.failure = failure;
    return failure;
  }

  private async execute<ResultRow>(executor: PGlite | Transaction, statement: string, parameters: readonly unknown[]): Promise<SqlResult<ResultRow>> {
    const result = await executor.query<ResultRow>(statement, [...parameters]);
    if (this.failure && statement.startsWith(`UPDATE ${this.failure.table} SET`)) {
      this.failure.completed++;
      if (--this.failure.remaining === 0) {
        this.failure = null;
        // Both database UPDATE statements have succeeded; the transaction must undo both.
        throw new Error("injected failure after two completed role updates");
      }
    }
    return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
  }
}

async function setup(context: TestContext) {
  const engine = new PGlite();
  context.after(async () => { await engine.close(); });
  await engine.exec(await migration);
  await engine.exec(await readFile(new URL("../sql/ux-invitation-capacity.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("../sql/invitation-acceptance-membership.sql", import.meta.url), "utf8"));
  const database = new PgliteTestDatabase(engine);
  const repository = new PostgresProjectsRepository(database);
  let sequence = 0;
  let tokenSequence = 0;
  let time = Date.parse(initialTime);
  const service = new ProjectsService({
    repository,
    ids: { next: () => `sql_entity_${++sequence}` },
    clock: { now: () => new Date(time) },
    tokens: {
      issue() { const token = `test_token_${++tokenSequence}`; return { token, tokenHash: `test_hash_${token}` }; },
      hash: (token) => `test_hash_${token}`,
    },
  });
  return { database, repository, service, setTime: (instant: string) => { time = Date.parse(instant); } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function revision(fixture: Fixture, scope: "team" | "project", id: string): Promise<number> {
  const table = scope === "team" ? "projects_team" : "projects_project";
  const result = await fixture.database.query<{ revision: number }>(`SELECT revision FROM ${table} WHERE id=$1`, [id]);
  return result.rows[0]!.revision;
}

async function members(fixture: Fixture, scope: "team" | "project", id: string): Promise<readonly Row[]> {
  const table = scope === "team" ? "projects_team_membership" : "projects_project_membership";
  const column = scope === "team" ? "team_id" : "project_id";
  return (await fixture.database.query<Row>(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY user_id`, [id])).rows;
}

async function inviteToTeam(fixture: Fixture, teamId: string, member: Actor, role: TeamRole = "member", captain = alice) {
  const invitation = await fixture.service.createTeamInvitation(captain, teamId, { expectedRevision: await revision(fixture, "team", teamId), role });
  return { invitation, accepted: await fixture.service.acceptInvitation(member, invitation.token) };
}

async function inviteToProject(fixture: Fixture, projectId: string, member: Actor, role: ProjectRole = "member", manager = alice) {
  const invitation = await fixture.service.createProjectInvitation(manager, projectId, { expectedRevision: await revision(fixture, "project", projectId), role });
  return { invitation, accepted: await fixture.service.acceptInvitation(member, invitation.token) };
}

async function createProject(fixture: Fixture, actor = alice, teamId: string | null = null) {
  return fixture.service.createProject(actor, { name: "真实 SQL 引擎测试项目", teamId, timezone: "Asia/Shanghai", goal: "保留团队协作成果", minimumDeliverable: "演示与文档" });
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
}

async function projectHistory(fixture: Fixture, projectId: string) {
  const query = (table: string, order: string) => fixture.database.query<Row>(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY ${order}`, [projectId]);
  return {
    project: (await fixture.database.query<Row>("SELECT * FROM projects_project WHERE id=$1", [projectId])).rows,
    members: await members(fixture, "project", projectId),
    activities: (await query("projects_activity", "id")).rows,
    facts: (await query("projects_change_fact", "event_id")).rows,
    bookmarks: (await query("projects_resource_bookmark", "id")).rows,
  };
}

test("PGlite: team CRUD, invitation retry and departure persist real rows without granting project access", async (context) => {
  const fixture = await setup(context);
  const { service, repository, database } = fixture;
  const team = await service.createTeam(alice, { name: "第一支队伍" });
  assert.equal((await members(fixture, "team", team.id))[0]!.role, "captain");
  await rejectsCode(service.getTeam(dave, team.id), "TEAM_UNAVAILABLE");
  const edited = await service.editTeam(alice, team.id, { expectedRevision: 1, name: "改名后的队伍" });
  assert.equal(edited.name, "改名后的队伍");
  await rejectsCode(service.editTeam(alice, team.id, { expectedRevision: 1, name: "过期覆盖" }), "VERSION_CONFLICT");
  const joined = await inviteToTeam(fixture, team.id, bob);
  const retry = await service.acceptInvitation(bob, joined.invitation.token);
  assert.equal(retry.alreadyAccepted, true);
  assert.equal(retry.membership.membershipId, joined.accepted.membership.membershipId);
  assert.equal((await members(fixture, "team", team.id)).filter((row) => row.user_id === "bob").length, 1);
  const project = await createProject(fixture, bob, team.id);
  await rejectsCode(service.getProject(alice, project.id), "PROJECT_UNAVAILABLE");
  assert.deepEqual((await service.getTeam(alice, team.id)).projects, []);
  assert.deepEqual((await service.getTeam(bob, team.id)).projects.map((item) => item.id), [project.id]);
  const projectMembership = await repository.getMembership(project.id, bob.userId);
  const left = await service.leaveTeam(bob, team.id, await revision(fixture, "team", team.id));
  assert.equal(left.membership.status, "left");
  assert.deepEqual(await repository.getMembership(project.id, bob.userId), projectMembership);
  assert.equal((await service.getProject(bob, project.id)).membership.role, "manager");
  await rejectsCode(service.getTeam(bob, team.id), "TEAM_UNAVAILABLE");
  await rejectsCode(service.acceptInvitation(bob, joined.invitation.token), "INVITATION_ALREADY_USED");
  const rejoined = await inviteToTeam(fixture, team.id, bob);
  assert.equal(rejoined.accepted.membership.membershipId, joined.accepted.membership.membershipId);
  assert.equal(rejoined.accepted.membership.revision, joined.accepted.membership.revision + 2);
  await inviteToTeam(fixture, team.id, carol);
  await service.removeTeamMember(alice, team.id, carol.userId, await revision(fixture, "team", team.id));
  assert.equal((await members(fixture, "team", team.id)).find((row) => row.user_id === carol.userId)!.status, "removed");
  assert.equal((await database.query<{ count: number }>("SELECT count(*)::int AS count FROM projects_project WHERE id=$1", [project.id])).rows[0]!.count, 1);
});

test("PGlite: expired and revoked team invitations stay unusable and cannot join another scope", async (context) => {
  const fixture = await setup(context);
  const { service } = fixture;
  const team = await service.createTeam(alice, { name: "邀请校验队伍" });
  const otherTeam = await service.createTeam(carol, { name: "另一支队伍" });
  const expiring = await service.createTeamInvitation(alice, team.id, { expectedRevision: 1, role: "member", expiresAt: "2026-10-08T03:00:00.000Z" });
  fixture.setTime("2026-10-08T03:00:00.000Z");
  await rejectsCode(service.acceptInvitation(bob, expiring.token), "INVITATION_EXPIRED");
  const revoked = await service.createTeamInvitation(alice, team.id, { expectedRevision: await revision(fixture, "team", team.id), role: "member" });
  await rejectsCode(service.revokeTeamInvitation(carol, otherTeam.id, revoked.invitation.id, 1), "INVITATION_UNAVAILABLE");
  await service.revokeTeamInvitation(alice, team.id, revoked.invitation.id, await revision(fixture, "team", team.id));
  await rejectsCode(service.acceptInvitation(bob, revoked.token), "INVITATION_UNAVAILABLE");
  assert.equal((await members(fixture, "team", team.id)).some((row) => row.user_id === bob.userId), false);
  assert.equal((await members(fixture, "team", otherTeam.id)).some((row) => row.user_id === bob.userId), false);
  const invitations = await service.listTeamInvitations(alice, team.id);
  assert.equal(invitations.find((item) => item.id === expiring.invitation.id)!.displayStatus, "expired");
  assert.equal(invitations.find((item) => item.id === revoked.invitation.id)!.displayStatus, "revoked");
});

test("PGlite: captain handoff changes actor and target atomically and preserves other captains", async (context) => {
  const fixture = await setup(context);
  const { service, database } = fixture;
  const team = await service.createTeam(alice, { name: "队长交接" });
  await inviteToTeam(fixture, team.id, bob);
  await inviteToTeam(fixture, team.id, carol, "captain");
  const before = await members(fixture, "team", team.id);
  const beforeRevision = await revision(fixture, "team", team.id);
  await rejectsCode(service.transferTeamCaptain(alice, team.id, { expectedRevision: beforeRevision, targetUserId: alice.userId }), "INVALID_INPUT");
  await rejectsCode(service.transferTeamCaptain(alice, team.id, { expectedRevision: beforeRevision - 1, targetUserId: bob.userId }), "VERSION_CONFLICT");
  await rejectsCode(service.transferTeamCaptain(alice, team.id, { expectedRevision: beforeRevision, targetUserId: dave.userId }), "MEMBER_UNAVAILABLE");
  await rejectsCode(service.transferTeamCaptain(bob, team.id, { expectedRevision: beforeRevision, targetUserId: alice.userId }), "TEAM_CAPTAIN_REQUIRED");
  assert.deepEqual(await members(fixture, "team", team.id), before);
  const beforeTransactions = database.transactionCount;
  await service.transferTeamCaptain(alice, team.id, { expectedRevision: beforeRevision, targetUserId: bob.userId });
  assert.equal(database.transactionCount - beforeTransactions, 1);
  const after = await members(fixture, "team", team.id);
  assert.equal(after.find((row) => row.user_id === alice.userId)!.role, "member");
  assert.equal(after.find((row) => row.user_id === bob.userId)!.role, "captain");
  assert.deepEqual(after.find((row) => row.user_id === carol.userId), before.find((row) => row.user_id === carol.userId));
  assert.equal(await revision(fixture, "team", team.id), beforeRevision + 1);
  await rejectsCode(service.editTeam(alice, team.id, { expectedRevision: beforeRevision + 1, name: "旧队长越权" }), "TEAM_CAPTAIN_REQUIRED");
  await service.transferTeamCaptain(bob, team.id, { expectedRevision: await revision(fixture, "team", team.id), targetUserId: carol.userId });
  const transferredToCaptain = await members(fixture, "team", team.id);
  assert.equal(transferredToCaptain.find((row) => row.user_id === bob.userId)!.role, "member");
  assert.equal(transferredToCaptain.find((row) => row.user_id === carol.userId)!.role, "captain");
});

test("PGlite: project management handoff keeps other managers, records both role facts and removes creator privilege", async (context) => {
  const fixture = await setup(context);
  const { service, database, repository } = fixture;
  const project = await createProject(fixture);
  await inviteToProject(fixture, project.id, bob);
  await inviteToProject(fixture, project.id, carol, "manager");
  const before = await members(fixture, "project", project.id);
  const beforeRevision = await revision(fixture, "project", project.id);
  await rejectsCode(service.transferProjectManagement(alice, project.id, { expectedRevision: beforeRevision, targetUserId: alice.userId }), "INVALID_INPUT");
  await rejectsCode(service.transferProjectManagement(alice, project.id, { expectedRevision: beforeRevision - 1, targetUserId: bob.userId }), "VERSION_CONFLICT");
  await rejectsCode(service.transferProjectManagement(alice, project.id, { expectedRevision: beforeRevision, targetUserId: dave.userId }), "MEMBER_UNAVAILABLE");
  await rejectsCode(service.transferProjectManagement(bob, project.id, { expectedRevision: beforeRevision, targetUserId: alice.userId }), "PROJECT_MANAGER_REQUIRED");
  assert.deepEqual(await members(fixture, "project", project.id), before);
  const beforeTransactions = database.transactionCount;
  await service.transferProjectManagement(alice, project.id, { expectedRevision: beforeRevision, targetUserId: bob.userId });
  assert.equal(database.transactionCount - beforeTransactions, 1);
  const after = await members(fixture, "project", project.id);
  assert.equal(after.find((row) => row.user_id === alice.userId)!.role, "member");
  assert.equal(after.find((row) => row.user_id === bob.userId)!.role, "manager");
  assert.deepEqual(after.find((row) => row.user_id === carol.userId), before.find((row) => row.user_id === carol.userId));
  const facts = (await database.query<{ payload: { after: { userId: string } }; version: number }>("SELECT payload, version FROM projects_change_fact WHERE project_id=$1 AND type=$2 ORDER BY event_id", [project.id, "ProjectMemberRoleChanged"])).rows;
  assert.deepEqual(facts.map((fact) => fact.payload.after.userId).sort(), ["alice", "bob"]);
  assert.equal(facts.every((fact) => fact.version === beforeRevision + 1), true);
  assert.equal((await service.getProject(alice, project.id)).project.createdBy, "alice");
  await rejectsCode(service.editProject(alice, project.id, { expectedRevision: await revision(fixture, "project", project.id), name: "创建者越权" }), "PROJECT_MANAGER_REQUIRED");
  await service.transitionStage(bob, project.id, { expectedRevision: await revision(fixture, "project", project.id), stage: "archived", reason: "归档后仍可交接管理责任" });
  const archivedHistory = await projectHistory(fixture, project.id);
  await service.transferProjectManagement(bob, project.id, { expectedRevision: await revision(fixture, "project", project.id), targetUserId: carol.userId });
  assert.equal((await repository.getMembership(project.id, bob.userId))!.role, "member");
  assert.equal((await repository.getMembership(project.id, carol.userId))!.role, "manager");
  const afterArchivedTransfer = await projectHistory(fixture, project.id);
  assert.equal(afterArchivedTransfer.project[0]!.stage, "archived");
  for (const historical of archivedHistory.activities) assert.deepEqual(afterArchivedTransfer.activities.find((row) => row.id === historical.id), historical);
  for (const historical of archivedHistory.facts) assert.deepEqual(afterArchivedTransfer.facts.find((row) => row.event_id === historical.event_id), historical);
});

test("PGlite: failure after both role UPDATEs rolls back both handoff roles and scope revision", async (context) => {
  const fixture = await setup(context);
  const { service, database } = fixture;
  const team = await service.createTeam(alice, { name: "失败交接队伍" });
  await inviteToTeam(fixture, team.id, bob);
  const project = await createProject(fixture, alice, team.id);
  await inviteToProject(fixture, project.id, bob);
  const teamBefore = await members(fixture, "team", team.id);
  const teamRevision = await revision(fixture, "team", team.id);
  const teamFault = database.failAfterTwoRoleUpdates("projects_team_membership");
  await assert.rejects(service.transferTeamCaptain(alice, team.id, { expectedRevision: teamRevision, targetUserId: bob.userId }), /injected failure after two completed role updates/);
  assert.equal(teamFault.completed, 2);
  assert.deepEqual(await members(fixture, "team", team.id), teamBefore);
  assert.equal(await revision(fixture, "team", team.id), teamRevision);
  const projectBefore = await projectHistory(fixture, project.id);
  const projectRevision = await revision(fixture, "project", project.id);
  const projectFault = database.failAfterTwoRoleUpdates("projects_project_membership");
  await assert.rejects(service.transferProjectManagement(alice, project.id, { expectedRevision: projectRevision, targetUserId: bob.userId }), /injected failure after two completed role updates/);
  assert.equal(projectFault.completed, 2);
  assert.deepEqual(await projectHistory(fixture, project.id), projectBefore);
});

test("PGlite: deferred SQL constraints reject the last captain and last manager even for archived projects", async (context) => {
  const fixture = await setup(context);
  const { service, database, repository } = fixture;
  const team = await service.createTeam(alice, { name: "唯一队长" });
  const project = await createProject(fixture, alice, team.id);
  await service.transitionStage(alice, project.id, { expectedRevision: 1, stage: "archived", reason: "保留试用历史" });
  const assertConstraint = (constraint: string) => (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514" && "constraint" in error && error.constraint === constraint;
  await assert.rejects(database.transaction(async (transaction) => {
    await transaction.query("UPDATE projects_team_membership SET role=$1, revision=revision+1 WHERE team_id=$2 AND user_id=$3", ["member", team.id, alice.userId]);
  }), assertConstraint("projects_active_captain_required"));
  await assert.rejects(database.transaction(async (transaction) => {
    await transaction.query("UPDATE projects_project_membership SET role=$1, revision=revision+1 WHERE project_id=$2 AND user_id=$3", ["member", project.id, alice.userId]);
  }), assertConstraint("projects_active_manager_required"));
  assert.equal((await members(fixture, "team", team.id))[0]!.role, "captain");
  assert.equal((await members(fixture, "project", project.id))[0]!.role, "manager");
  await rejectsCode(repository.withTeam(team.id, async (aggregate) => { aggregate.members[0]!.role = "member"; aggregate.members[0]!.revision++; }), "LAST_TEAM_CAPTAIN");
  await rejectsCode(repository.withProject(project.id, async (aggregate) => { aggregate.members[0]!.role = "member"; aggregate.members[0]!.revision++; }), "LAST_PROJECT_MANAGER");
  await rejectsCode(service.leaveTeam(alice, team.id, await revision(fixture, "team", team.id)), "LAST_TEAM_CAPTAIN");
  await rejectsCode(service.leaveProject(alice, project.id, await revision(fixture, "project", project.id)), "LAST_PROJECT_MANAGER");
});

test("PGlite: dissolution revokes pending invitations while archived project history and departed authors survive", async (context) => {
  const fixture = await setup(context);
  const { service, database, repository } = fixture;
  const team = await service.createTeam(alice, { name: "历史保留队伍" });
  const bobInvitation = await inviteToTeam(fixture, team.id, bob);
  const project = await createProject(fixture, alice, team.id);
  await inviteToProject(fixture, project.id, bob);
  await service.addResource(bob, project.id, { expectedRevision: await revision(fixture, "project", project.id), url: "https://example.com/reference", title: "成员参考", purposeNote: "路演资料" });
  await service.transitionStage(alice, project.id, { expectedRevision: await revision(fixture, "project", project.id), stage: "archived", reason: "比赛结束，保留记录" });
  await service.leaveProject(bob, project.id, await revision(fixture, "project", project.id));
  const pending = await service.createTeamInvitation(alice, team.id, { expectedRevision: await revision(fixture, "team", team.id), role: "member" });
  const before = await projectHistory(fixture, project.id);
  const dissolved = await service.dissolveTeam(alice, team.id, await revision(fixture, "team", team.id));
  assert.equal(dissolved.team.status, "dissolved");
  assert.equal(dissolved.projectsPreserved, true);
  assert.deepEqual(await projectHistory(fixture, project.id), before);
  const invitationRows = (await database.query<{ id: string; status: string }>("SELECT id, status FROM projects_invitation WHERE team_id=$1 ORDER BY id", [team.id])).rows;
  assert.equal(invitationRows.find((row) => row.id === pending.invitation.id)!.status, "revoked");
  assert.equal(invitationRows.find((row) => row.id === bobInvitation.invitation.invitation.id)!.status, "accepted");
  assert.equal((await repository.getMembership(project.id, bob.userId))!.status, "left");
  assert.equal(before.bookmarks[0]!.saved_by, bob.userId);
  assert.ok(before.activities.some((row) => row.actor_id === bob.userId));
  assert.equal((await service.getProject(alice, project.id)).project.stage, "archived");
  await rejectsCode(service.editProject(alice, project.id, { expectedRevision: await revision(fixture, "project", project.id), goal: "静默改历史" }), "PROJECT_ARCHIVED");
  await rejectsCode(service.getProject(bob, project.id), "PROJECT_UNAVAILABLE");
  await rejectsCode(service.acceptInvitation(carol, pending.token), "INVITATION_UNAVAILABLE");
  await service.leaveTeam(alice, team.id, await revision(fixture, "team", team.id));
  assert.equal((await members(fixture, "team", team.id)).find((row) => row.user_id === alice.userId)!.status, "left");
  assert.equal((await service.getProject(alice, project.id)).membership.role, "manager");
  assert.deepEqual(await projectHistory(fixture, project.id), before);
});
