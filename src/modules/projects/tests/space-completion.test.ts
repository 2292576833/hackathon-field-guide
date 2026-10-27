import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import { createProjectsHttpHandlers } from "../handlers.ts";
import { invitationUsage } from "../invitation-usage.ts";
import type { Invitation } from "../model.ts";
import { PostgresProjectsRepository } from "../postgres.ts";
import { ProjectsService } from "../service.ts";
import { createInvitationTokens } from "../tokens.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const bob: Actor = { userId: "bob", platformRoles: ["user"] };
const carol: Actor = { userId: "carol", platformRoles: ["user"] };
const time = "2026-10-10T00:00:00.000Z";
type ScopeType = "project" | "team";
type AcceptanceRow = { invitation_id: string; user_id: string; membership_id: string | null; accepted_at: Date };

/** Memory-only PostgreSQL engine; these tests never open the website data directory. */
async function setup(context: TestContext, beforeCapacity?: (pg: PGlite) => Promise<void>) {
  const pg = new PGlite(); context.after(() => pg.close());
  await pg.exec(await readFile(new URL("../sql/001-projects.sql", import.meta.url), "utf8"));
  if (beforeCapacity) await beforeCapacity(pg);
  await pg.exec(await readFile(new URL("../sql/ux-invitation-capacity.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../sql/invitation-acceptance-membership.sql", import.meta.url), "utf8"));
  let failAfterAcceptance = false;
  const adapter = (client: Pick<PGlite, "query">): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await client.query<Row>(statement, [...parameters]);
      if (failAfterAcceptance && statement.startsWith("INSERT INTO projects_invitation_acceptance ")) {
        failAfterAcceptance = false;
        throw new Error("injected failure after real acceptance INSERT");
      }
      return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
    },
  });
  const database: DatabasePort = { ...adapter(pg), transaction: work => pg.transaction(transaction => work(adapter(transaction))) };
  const repository = new PostgresProjectsRepository(database); let sequence = 0;
  const service = new ProjectsService({ repository, tokens: createInvitationTokens(), ids: { next: () => `completion-${++sequence}` }, clock: { now: () => new Date(time) } });
  return { pg, database, repository, service, failNextAcceptanceInsert: () => { failAfterAcceptance = true; } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function makeScope(f: Fixture, type: ScopeType) {
  const scope = type === "project" ? await f.service.createProject(alice, { name: "团队空间", timezone: "Asia/Shanghai" }) : await f.service.createTeam(alice, { name: "固定队伍" });
  const revision = async () => type === "project" ? (await f.service.getProject(alice, scope.id)).project.revision : (await f.service.getTeam(alice, scope.id)).team.revision;
  const invite = async (maxUses = 1) => type === "project"
    ? f.service.createProjectInvitation(alice, scope.id, { expectedRevision: await revision(), maxUses })
    : f.service.createTeamInvitation(alice, scope.id, { expectedRevision: await revision(), maxUses });
  const leave = async () => type === "project" ? f.service.leaveProject(bob, scope.id, await revision()) : f.service.leaveTeam(bob, scope.id, await revision());
  return { id: scope.id, revision, invite, leave };
}

async function acceptances(f: Fixture, invitationId: string) {
  return (await f.database.query<AcceptanceRow>("SELECT * FROM projects_invitation_acceptance WHERE invitation_id=$1 ORDER BY user_id", [invitationId])).rows;
}

async function snapshot(f: Fixture) {
  const rows: Record<string, readonly unknown[]> = {};
  for (const [table, order] of [
    ["projects_project", "id"], ["projects_team", "id"],
    ["projects_project_membership", "membership_id"], ["projects_team_membership", "membership_id"],
    ["projects_invitation", "id"], ["projects_invitation_acceptance", "invitation_id,user_id"],
    ["projects_activity", "id"], ["projects_change_fact", "event_id"],
  ] as const) rows[table] = (await f.database.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
  return rows;
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => error instanceof DomainError && error.code === code);
}

test("direct invitation DELETE rejects archived managers and revoked authority without any SQL state change", async context => {
  const f = await setup(context); const s = await makeScope(f, "project");
  const managerInvite = await f.service.createProjectInvitation(alice, s.id, { expectedRevision: await s.revision(), role: "manager" });
  await f.service.acceptInvitation(bob, managerInvite.token);
  const memberInvite = await s.invite(); await f.service.acceptInvitation(carol, memberInvite.token);
  const target = await s.invite(3);
  let requestActor = bob;
  const api = createProjectsHttpHandlers({ service: f.service, resolveActor: async () => requestActor, authorizeMutation: async () => {} });
  const deleteInvitation = async () => api.handle(new Request("https://example.com/api/v1/projects/invitation", {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: await s.revision() }),
  }), { kind: "projectInvitation", projectId: s.id, invitationId: target.invitation.id });
  await f.service.changeProjectRole(alice, s.id, bob.userId, { expectedRevision: await s.revision(), role: "member" });
  for (const member of [bob, carol]) {
    requestActor = member; const before = await snapshot(f); const response = await deleteInvitation();
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "PROJECT_MANAGER_REQUIRED");
    assert.deepEqual(await snapshot(f), before, "membership role is rechecked; no invitation, revision, audit or fact write");
  }
  await f.service.removeProjectMember(alice, s.id, bob.userId, await s.revision());
  requestActor = bob; let before = await snapshot(f); let response = await deleteInvitation();
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "PROJECT_UNAVAILABLE");
  assert.deepEqual(await snapshot(f), before, "removed former manager cannot revoke");
  await f.service.transitionStage(alice, s.id, { expectedRevision: await s.revision(), stage: "archived", reason: "保留邀请和历史" });
  requestActor = alice; before = await snapshot(f); response = await deleteInvitation();
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "PROJECT_ARCHIVED");
  assert.deepEqual(await snapshot(f), before, "archived manager DELETE is wholly read-only");
  assert.equal((before.projects_invitation as { id: string; status: string }[]).find(row => row.id === target.invitation.id)?.status, "pending");
});

for (const type of ["project", "team"] as const) {
  test(`${type}: SQL acceptances record new and reactivated membership IDs while active entry and retries consume nothing`, async context => {
    const f = await setup(context); const s = await makeScope(f, type); const first = await s.invite(3);
    const ownerBefore = await snapshot(f); await f.service.acceptInvitation(alice, first.token);
    assert.deepEqual(await snapshot(f), ownerBefore); assert.deepEqual(await acceptances(f, first.invitation.id), []);
    const joined = await f.service.acceptInvitation(bob, first.token);
    assert.equal(joined.membership.role, "member"); assert.equal(joined.alreadyAccepted, false);
    const records = await acceptances(f, first.invitation.id);
    assert.equal(records.length, 1); assert.equal(records[0]?.user_id, bob.userId);
    assert.equal(records[0]?.membership_id, joined.membership.membershipId);
    assert.equal(records[0]?.accepted_at.toISOString(), time);
    const retryBefore = await snapshot(f); const retry = await f.service.acceptInvitation(bob, first.token);
    assert.equal(retry.alreadyAccepted, true); assert.deepEqual(await snapshot(f), retryBefore);
    await s.leave(); const departed = await snapshot(f);
    await rejectsCode(f.service.acceptInvitation(bob, first.token), "INVITATION_ALREADY_USED");
    assert.deepEqual(await snapshot(f), departed, "original invite cannot revive a consumed membership");
    const replacement = await s.invite(); const rejoined = await f.service.acceptInvitation(bob, replacement.token);
    assert.equal(rejoined.membership.membershipId, joined.membership.membershipId);
    assert.equal(rejoined.membership.revision, joined.membership.revision + 2);
    assert.equal((await acceptances(f, replacement.invitation.id))[0]?.membership_id, joined.membership.membershipId);
    const unconsumed = await s.invite(); const activeBefore = await snapshot(f);
    assert.equal((await f.service.acceptInvitation(bob, unconsumed.token)).alreadyAccepted, true);
    assert.deepEqual(await snapshot(f), activeBefore); assert.deepEqual(await acceptances(f, unconsumed.invitation.id), []);
    assert.equal((await f.service.previewPublicSpaceInvitation(first.token)).usedUses, 1, "leave and rejoin never return old quota");
  });

  test(`${type}: SQL membership trigger rejects null, wrong scope/user/type and departed membership`, async context => {
    const f = await setup(context); const s = await makeScope(f, type); const other = await makeScope(f, type);
    const otherType = await makeScope(f, type === "project" ? "team" : "project");
    const seedInvite = await s.invite(); const joined = await f.service.acceptInvitation(bob, seedInvite.token); await s.leave();
    const target = await s.invite(5);
    const membershipTable = type === "project" ? "projects_project_membership" : "projects_team_membership";
    const scopeColumn = type === "project" ? "project_id" : "team_id";
    const owner = async (id: string, table = membershipTable, column = scopeColumn) => (await f.database.query<{ membership_id: string }>(`SELECT membership_id FROM ${table} WHERE ${column}=$1 AND user_id=$2`, [id, alice.userId])).rows[0]!.membership_id;
    const localOwner = await owner(s.id); const remoteOwner = await owner(other.id);
    const foreignOwner = await owner(otherType.id, type === "project" ? "projects_team_membership" : "projects_project_membership", type === "project" ? "team_id" : "project_id");
    const before = await snapshot(f);
    for (const [userId, membershipId] of [
      [alice.userId, null], [alice.userId, ""], [alice.userId, remoteOwner],
      [carol.userId, localOwner], [alice.userId, foreignOwner], [bob.userId, joined.membership.membershipId],
    ]) {
      await assert.rejects(f.database.query("INSERT INTO projects_invitation_acceptance (invitation_id,user_id,membership_id,accepted_at) VALUES ($1,$2,$3,$4)", [target.invitation.id, userId, membershipId, time]),
        error => !!error && typeof error === "object" && "code" in error && error.code === "23514" && "constraint" in error && error.constraint === "projects_invitation_acceptance_membership_valid");
      assert.deepEqual(await snapshot(f), before, "rejected acceptance never changes quota or membership history");
    }
  });

  test(`${type}: failure after real acceptance INSERT rolls back both new and reactivated membership associations`, async context => {
    const f = await setup(context); const s = await makeScope(f, type);
    const first = await s.invite(); const joined = await f.service.acceptInvitation(bob, first.token); await s.leave();
    const target = await s.invite(3);
    for (const person of [bob, carol]) {
      const before = await snapshot(f); f.failNextAcceptanceInsert();
      await assert.rejects(f.service.acceptInvitation(person, target.token), /injected failure after real acceptance INSERT/);
      assert.deepEqual(await snapshot(f), before, "membership, invitation quota, acceptance, revision, audit and facts roll back together");
      assert.deepEqual(await acceptances(f, target.invitation.id), []);
    }
    const recovered = await f.service.acceptInvitation(bob, target.token);
    assert.equal(recovered.membership.membershipId, joined.membership.membershipId);
    assert.equal((await acceptances(f, target.invitation.id))[0]?.membership_id, joined.membership.membershipId);
    assert.equal((await f.service.previewPublicSpaceInvitation(target.token)).usedUses, 1);
  });

  test(`${type}: SQL retains accepted membership and invitation scope while allowing the member to leave`, async context => {
    const f = await setup(context); const s = await makeScope(f, type); const other = await makeScope(f, type);
    const invite = await s.invite(3); const joined = await f.service.acceptInvitation(bob, invite.token);
    const membershipTable = type === "project" ? "projects_project_membership" : "projects_team_membership";
    const scopeColumn = type === "project" ? "project_id" : "team_id";
    const assertDeleteRejected = async () => {
      const before = await snapshot(f);
      await assert.rejects(f.database.query(`DELETE FROM ${membershipTable} WHERE membership_id=$1`, [joined.membership.membershipId]),
        error => !!error && typeof error === "object" && "code" in error && error.code === "23503" && "constraint" in error && error.constraint === "projects_invitation_acceptance_membership_reference");
      assert.deepEqual(await snapshot(f), before, "accepted membership identity cannot become a dangling association");
    };
    await assertDeleteRejected();
    const beforeScopeMove = await snapshot(f);
    await assert.rejects(f.database.query(`UPDATE projects_invitation SET scope_id=$1,${scopeColumn}=$1 WHERE id=$2`, [other.id, invite.invitation.id]),
      error => !!error && typeof error === "object" && "code" in error && error.code === "23514" && "constraint" in error && error.constraint === "projects_invitation_acceptance_scope_reference");
    assert.deepEqual(await snapshot(f), beforeScopeMove, "immutable acceptance stays in the original scope");
    await s.leave();
    assert.equal((await f.database.query<{ status: string }>(`SELECT status FROM ${membershipTable} WHERE membership_id=$1`, [joined.membership.membershipId])).rows[0]?.status, "left");
    await assertDeleteRejected();
    assert.equal((await acceptances(f, invite.invitation.id))[0]?.membership_id, joined.membership.membershipId);
  });
}

test("legacy migration preserves unknown NULL associations, full quota and departed history without inference", async context => {
  const token = "L".repeat(43); const hash = createInvitationTokens().hash(token);
  const f = await setup(context, async pg => {
    await pg.transaction(async tx => {
      await tx.query("INSERT INTO projects_project(id,name,created_by,goal,minimum_deliverable,stage,timezone,deadline_source,revision,created_at,updated_at) VALUES ($1,$2,$3,'','','draft','Asia/Shanghai','unknown',1,$4,$4)", ["legacy-space", "旧空间", alice.userId, time]);
      await tx.query("INSERT INTO projects_project_membership(membership_id,project_id,user_id,role,status,revision,joined_at,left_at) VALUES ($1,$2,$3,'manager','active',1,$4,NULL),($5,$2,$6,'member','left',2,$4,$4)", ["legacy-owner", "legacy-space", alice.userId, time, "legacy-bob", bob.userId]);
      await tx.query("INSERT INTO projects_invitation(id,scope_type,scope_id,project_id,token_hash,role,created_by,created_at,expires_at,status,accepted_by,accepted_at,revision) VALUES ($1,'project',$2,$2,$3,'member',$4,$5,$6,'accepted',$7,$5,2)", ["legacy-invitation", "legacy-space", hash, alice.userId, time, "2026-10-13T00:00:00.000Z", bob.userId]);
    });
  });
  const records = await acceptances(f, "legacy-invitation");
  assert.equal(records.length, 1); assert.equal(records[0]?.membership_id, null);
  const internal = await f.repository.withProject("legacy-space", async aggregate => aggregate.invitations[0]!);
  assert.equal(internal.acceptances?.[0]?.membershipId, null);
  assert.deepEqual(invitationUsage(internal), { maxUses: 1, usedUses: 1, remainingUses: 0, acceptances: [{ invitationId: "legacy-invitation", userId: bob.userId, membershipId: null, acceptedAt: time }] });
  const before = await snapshot(f);
  await rejectsCode(f.service.acceptInvitation(bob, token), "INVITATION_ALREADY_USED");
  await rejectsCode(f.service.acceptInvitation(carol, token), "INVITATION_ALREADY_USED");
  assert.deepEqual(await snapshot(f), before, "migration and rejected retries never re-consume or revive departed history");
  await assert.rejects(f.database.query("UPDATE projects_invitation_acceptance SET membership_id=$1 WHERE invitation_id=$2", ["legacy-bob", "legacy-invitation"]),
    error => !!error && typeof error === "object" && "code" in error && error.code === "23514");
  assert.deepEqual(await snapshot(f), before, "legacy NULL acceptance remains immutable even if a historical membership exists");
});

test("invitation usage normalizes pre-association history without mutating the stored legacy object", () => {
  const legacy = {
    id: "old-invite", status: "accepted", acceptedBy: bob.userId, acceptedAt: time,
    maxUses: 1, usedUses: 1, acceptances: [{ invitationId: "old-invite", userId: bob.userId, acceptedAt: time }],
  } as Invitation;
  const before = structuredClone(legacy); const normalized = invitationUsage(legacy);
  assert.equal(normalized.acceptances[0]?.membershipId, null); assert.equal(normalized.usedUses, 1);
  assert.deepEqual(legacy, before); assert.equal("membershipId" in legacy.acceptances![0]!, false);
});
