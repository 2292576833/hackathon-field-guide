import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import { ProjectsService } from "../service.ts";
import type { ProjectsServiceDependencies } from "../service.ts";
import { createProjectsHttpHandlers } from "../handlers.ts";
import { PostgresProjectsRepository } from "../postgres.ts";
import { createInvitationTokens } from "../tokens.ts";
import { MemoryProjectsRepository } from "./memory-repository.ts";
import type { InvitationPreview, PublicSpaceInvitationPreview } from "../model.ts";

const alice: Actor = { userId: "alice", platformRoles: ["user"] };
const actor = (userId: string): Actor => ({ userId, platformRoles: ["user"] });
const bob = actor("bob"), carol = actor("carol"), dave = actor("dave");
const initialTime = "2026-10-09T00:00:00.000Z";
function setup(overrides: Partial<ProjectsServiceDependencies> = {}) {
  const repository = new MemoryProjectsRepository(); let sequence = 0; let time = Date.parse(initialTime);
  const service = new ProjectsService({ repository, ids: { next: () => `entry-${++sequence}` }, clock: { now: () => new Date(time) }, tokens: createInvitationTokens(), ...overrides });
  return { service, repository, setTime: (next: string) => { time = Date.parse(next); } };
}
async function reject(promise: Promise<unknown>, code: string) { await assert.rejects(promise, error => error instanceof DomainError && error.code === code); }
async function scopes(service: ProjectsService, type: "project" | "team") {
  const scope = type === "project" ? await service.createProject(alice, { name: "测试团队空间", timezone: "Asia/Shanghai", goal: "绝不能出现在预览里的私人目标", eventId: "public-event" }) : await service.createTeam(alice, { name: "固定队伍" });
  const revision = async () => type === "project" ? (await service.getProject(alice, scope.id)).project.revision : (await service.getTeam(alice, scope.id)).team.revision;
  const issue = async (maxUses = 1, extra: object = {}) => type === "project" ? service.createProjectInvitation(alice, scope.id, { expectedRevision: await revision(), maxUses, ...extra }) : service.createTeamInvitation(alice, scope.id, { expectedRevision: await revision(), maxUses, ...extra });
  const leave = async (who: Actor) => type === "project" ? service.leaveProject(who, scope.id, await revision()) : service.leaveTeam(who, scope.id, await revision());
  const remove = async (who: Actor) => type === "project" ? service.removeProjectMember(alice, scope.id, who.userId, await revision()) : service.removeTeamMember(alice, scope.id, who.userId, await revision());
  const revoke = async (id: string) => type === "project" ? service.revokeProjectInvitation(alice, scope.id, id, await revision()) : service.revokeTeamInvitation(alice, scope.id, id, await revision());
  return { id: scope.id, revision, issue, leave, remove, revoke };
}
test("anonymous pending preview exposes only a minimal public projection and consumes nothing", async () => {
  const calls: string[] = [];
  const f = setup({ publicInvitationDetails: {
    getPublicEventName: async input => { calls.push(`event:${input.projectId}`); return "当前公开比赛名称"; },
    getPublicDisplayName: async userId => { calls.push(`name:${userId}`); return "小橙"; },
  } });
  const s = await scopes(f.service, "project"); const invite = await s.issue(3, { invitedEmail: "private-target@example.com" });
  const before = f.repository.inspectProject(s.id);
  const api = createProjectsHttpHandlers({ service: f.service, resolveActor: async () => { throw new Error("public route must not resolve identity"); }, authorizeMutation: async () => { throw new Error("public GET must not mutate"); } });
  const response = await api.handle(new Request("https://example.com/public-preview"), { kind: "publicInvitationPreview", token: invite.token });
  assert.equal(response.status, 200); assert.equal(response.headers.get("Referrer-Policy"), "no-referrer"); assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const value = (await response.json()).data as PublicSpaceInvitationPreview;
  assert.deepEqual(value, { status: "pending", scopeType: "project", scopeName: "测试团队空间", eventName: "当前公开比赛名称", inviterDisplayName: "小橙", requestedRole: "member", expiresAt: "2026-10-12T00:00:00.000Z", maxUses: 3, usedUses: 0, remainingUses: 3 });
  assert.deepEqual(calls, [`event:${s.id}`, "name:alice"]);
  const text = JSON.stringify(value); assert.equal(text.includes("private-target"), false); assert.equal(text.includes("私人目标"), false);
  for (const key of ["scopeId", "projectId", "tokenHash", "acceptedBy", "members", "invitedEmail", "userId", "acceptances"]) assert.equal(key in value, false);
  assert.deepEqual(f.repository.inspectProject(s.id), before);
  assert.equal((await api.handle(new Request("https://example.com", { method: "POST" }), { kind: "publicInvitationPreview", token: invite.token })).status, 405);
});
test("public preview keeps expiry, revocation, full use and missing optional public details explicit", async () => {
  const f = setup(); const s = await scopes(f.service, "project");
  const expired = await s.issue(1, { expiresAt: "2026-10-09T00:01:00.000Z" });
  const revoked = await s.issue(); await s.revoke(revoked.invitation.id);
  const used = await s.issue(); await f.service.acceptInvitation(bob, used.token);
  f.setTime("2026-10-09T00:01:00.000Z");
  for (const [token, status] of [[expired.token, "expired"], [revoked.token, "revoked"], [used.token, "used"], ["Z".repeat(43), "unavailable"]]) {
    const preview = await f.service.previewPublicSpaceInvitation(token!); assert.equal(preview.status, status);
    assert.equal(preview.scopeName, null); assert.equal(preview.eventName, null); assert.equal(preview.inviterDisplayName, null);
  }
  const fresh = await s.issue(); const preview = await f.service.previewPublicSpaceInvitation(fresh.token);
  assert.equal(preview.eventName, null); assert.equal(preview.inviterDisplayName, null);
  const current = await f.service.previewInvitation(bob, used.token); assert.equal(current.alreadyMember, true); assert.equal(current.alreadyAccepted, true);
  await s.leave(bob); await reject(f.service.acceptInvitation(bob, used.token), "INVITATION_ALREADY_USED");
  await reject(f.service.previewInvitation(bob, used.token), "INVITATION_ALREADY_USED");
});
test("anonymous preview never weakens authenticated email checks or archive restrictions", async () => {
  const f = setup({ identity: { getVerifiedEmail: async id => id === "carol" ? "INVITEE@EXAMPLE.COM" : "wrong@example.com" } });
  const s = await scopes(f.service, "project"); const invite = await s.issue(3, { invitedEmail: "invitee@example.com" });
  assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).status, "pending");
  await reject(f.service.previewInvitation(bob, invite.token), "INVITATION_IDENTITY_MISMATCH");
  await reject(f.service.acceptInvitation(bob, invite.token), "INVITATION_IDENTITY_MISMATCH");
  assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).usedUses, 0);
  await f.service.acceptInvitation(carol, invite.token);
  await f.service.transitionStage(alice, s.id, { expectedRevision: await s.revision(), stage: "archived", reason: "测试" });
  assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).status, "unavailable");
  await reject(f.service.acceptInvitation(bob, invite.token), "PROJECT_ARCHIVED");
});
for (const type of ["project", "team"] as const) {
  for (const state of ["revoked", "expired", "closed"] as const) {
    test(`${type}: active consumers and other active members enter after ${state}; departed people stay rejected`, async () => {
      const f = setup({ identity: { getVerifiedEmail: async id => id === "carol" ? "different@example.com" : "recipient@example.com" } });
      const s = await scopes(f.service, type);
      const invite = await s.issue(3, { role: type === "project" ? "manager" : "captain", invitedEmail: "recipient@example.com", expiresAt: "2026-10-09T00:01:00.000Z" });
      await f.service.acceptInvitation(bob, invite.token);
      const separate = await s.issue(); await f.service.acceptInvitation(carol, separate.token);
      if (state === "revoked") await s.revoke(invite.invitation.id);
      else if (state === "expired") f.setTime("2026-10-09T00:01:00.000Z");
      else if (type === "project") await f.service.transitionStage(alice, s.id, { expectedRevision: await s.revision(), stage: "archived", reason: "只允许现有成员看历史" });
      else await f.service.dissolveTeam(alice, s.id, await s.revision());
      const before = type === "project" ? f.repository.inspectProject(s.id) : f.repository.inspectTeam(s.id);
      const publicPreview = await f.service.previewPublicSpaceInvitation(invite.token);
      assert.equal(publicPreview.status, state === "closed" ? type === "team" ? "revoked" : "unavailable" : state);
      assert.equal(publicPreview.scopeName, null); assert.equal(publicPreview.scopeType, null);
      for (const person of [bob, carol]) {
        const preview = await f.service.previewInvitation(person, invite.token);
        assert.equal(preview.alreadyMember, true); assert.equal(preview.scopeId, s.id);
        assert.equal(preview.currentRole, person.userId === "bob" ? type === "project" ? "manager" : "captain" : "member");
        assert.equal(preview.alreadyAccepted, person.userId === "bob");
        assert.equal(preview.usedUses, 1); assert.equal(preview.remainingUses, 2);
        const accepted = await f.service.acceptInvitation(person, invite.token);
        assert.equal(accepted.alreadyAccepted, true); assert.equal(accepted.membership.role, preview.currentRole);
      }
      assert.deepEqual(type === "project" ? f.repository.inspectProject(s.id) : f.repository.inspectTeam(s.id), before, "entry doesn't change roles, quota, audit or revisions");
      const newJoinError = state === "expired" ? "INVITATION_EXPIRED" : state === "closed" && type === "project" ? "PROJECT_ARCHIVED" : "INVITATION_UNAVAILABLE";
      await reject(f.service.previewInvitation(dave, invite.token), newJoinError);
      await reject(f.service.acceptInvitation(dave, invite.token), newJoinError);
      await s.leave(bob); await s.remove(carol);
      await reject(f.service.previewInvitation(bob, invite.token), "INVITATION_ALREADY_USED");
      await reject(f.service.acceptInvitation(bob, invite.token), "INVITATION_ALREADY_USED");
      await reject(f.service.previewInvitation(carol, invite.token), state === "closed" && type === "project" ? "INVITATION_IDENTITY_MISMATCH" : newJoinError);
      await reject(f.service.acceptInvitation(carol, invite.token), newJoinError);
      const after = type === "project" ? f.repository.inspectProject(s.id) : f.repository.inspectTeam(s.id);
      assert.equal(after.invitations.find(item => item.id === invite.invitation.id)?.usedUses, 1, "departures do not restore invitation admission or quota");
    });
  }
  test(`${type}: 3-use invite caps unique new members, active members don't consume and old consumers cannot rejoin`, async () => {
    const f = setup(); const s = await scopes(f.service, type); const invite = await s.issue(3);
    const pre = await f.service.acceptInvitation(alice, invite.token);
    assert.equal(pre.membership.role, type === "project" ? "manager" : "captain");
    assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).usedUses, 0);
    const retries = await Promise.all(Array.from({ length: 4 }, () => f.service.acceptInvitation(bob, invite.token)));
    assert.equal(retries.filter(item => !item.alreadyAccepted).length, 1);
    assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).usedUses, 1);
    await f.service.acceptInvitation(carol, invite.token);
    const final = await Promise.allSettled([f.service.acceptInvitation(dave, invite.token), f.service.acceptInvitation(actor("fifth"), invite.token)]);
    assert.equal(final.filter(item => item.status === "fulfilled").length, 1);
    const full = await f.service.previewPublicSpaceInvitation(invite.token); assert.equal(full.status, "used"); assert.equal(full.remainingUses, 0);
    await s.remove(carol); await reject(f.service.acceptInvitation(carol, invite.token), "INVITATION_ALREADY_USED");
    await s.leave(bob); await reject(f.service.acceptInvitation(bob, invite.token), "INVITATION_ALREADY_USED");
    assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).usedUses, 3);
    const newInvite = await s.issue(); await f.service.acceptInvitation(bob, newInvite.token);
    assert.equal((await f.service.previewInvitation(bob, newInvite.token)).alreadyMember, true);
  });
  test(`${type}: capacity defaults to one, accepts 1–50 integers and rollback preserves quota`, async () => {
    const f = setup(); const s = await scopes(f.service, type);
    const defaultInvite = type === "project" ? await f.service.createProjectInvitation(alice, s.id, { expectedRevision: await s.revision() }) : await f.service.createTeamInvitation(alice, s.id, { expectedRevision: await s.revision() });
    assert.equal(defaultInvite.invitation.maxUses, 1); assert.equal(defaultInvite.invitation.role, "member"); assert.equal("acceptances" in defaultInvite.invitation, false);
    for (const max of [0, -1, 1.1, 51, Number.NaN, Number.POSITIVE_INFINITY]) await reject(s.issue(max), "INVALID_INPUT");
    const invite = await s.issue(50);
    const before = type === "project" ? f.repository.inspectProject(s.id) : f.repository.inspectTeam(s.id);
    f.repository.failNextCommit(); await assert.rejects(f.service.acceptInvitation(bob, invite.token));
    assert.deepEqual(type === "project" ? f.repository.inspectProject(s.id) : f.repository.inspectTeam(s.id), before);
    assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).remainingUses, 50);
    await f.service.acceptInvitation(bob, invite.token); assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).remainingUses, 49);
    await s.revoke(invite.invitation.id); assert.equal((await f.service.previewPublicSpaceInvitation(invite.token)).status, "revoked");
    await reject(f.service.acceptInvitation(carol, invite.token), "INVITATION_UNAVAILABLE");
  });
}
test("legacy single-use accepted invitations remain full and don't reactivate a departed consumer", async () => {
  const f = setup(); const s = await scopes(f.service, "project"); const invite = await s.issue();
  await f.service.acceptInvitation(bob, invite.token);
  await f.repository.withProject(s.id, aggregate => { const value = aggregate.invitations[0]!; delete value.maxUses; delete value.usedUses; delete value.acceptances; return Promise.resolve(); });
  const preview = await f.service.previewInvitation(bob, invite.token); assert.equal(preview.maxUses, 1); assert.equal(preview.usedUses, 1);
  await s.leave(bob); await reject(f.service.acceptInvitation(bob, invite.token), "INVITATION_ALREADY_USED");
});
test("PGlite: acceptance records and quota are immutable/atomic and final place commits once", async context => {
  const pg = new PGlite(); context.after(() => pg.close());
  await pg.exec(await readFile(new URL("../sql/001-projects.sql", import.meta.url), "utf8"));
  // Seed an actual legacy accepted row before the new migration to verify backfill.
  await pg.exec(`BEGIN;
    INSERT INTO projects_project(id,name,team_id,event_id,created_by,goal,minimum_deliverable,stage,timezone,deadline,deadline_source,revision,created_at,updated_at) VALUES('legacy-project','旧空间',NULL,NULL,'alice','','','draft','Asia/Shanghai',NULL,'unknown',1,'2026-10-09Z','2026-10-09Z');
    INSERT INTO projects_project_membership(membership_id,project_id,user_id,role,status,revision,joined_at,left_at) VALUES('legacy-owner','legacy-project','alice','manager','active',1,'2026-10-09Z',NULL);
    INSERT INTO projects_invitation(id,scope_type,scope_id,project_id,team_id,token_hash,role,invited_email,created_by,created_at,expires_at,status,accepted_by,accepted_at,revoked_at,revision) VALUES('legacy-invite','project','legacy-project','legacy-project',NULL,'${"a".repeat(64)}','member',NULL,'alice','2026-10-09Z','2026-10-12Z','accepted','bob','2026-10-09Z',NULL,2); COMMIT;`);
  await pg.exec(await readFile(new URL("../sql/ux-invitation-capacity.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../sql/invitation-acceptance-membership.sql", import.meta.url), "utf8"));
  const query = (client: Pick<PGlite, "query">): SqlExecutor => ({ async query<Row>(sql: string, params: readonly unknown[] = []) { const result = await client.query<Row>(sql, [...params]); return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length }; } });
  const executor = query(pg); const database: DatabasePort = { ...executor, transaction: work => pg.transaction(transaction => work(query(transaction))) };
  let sequence = 0; const service = new ProjectsService({ repository: new PostgresProjectsRepository(database), tokens: createInvitationTokens(), ids: { next: () => `sql-${++sequence}` }, clock: { now: () => new Date(initialTime) } });
  const legacy = await executor.query<{ max_uses: number; used_uses: number }>("SELECT max_uses,used_uses FROM projects_invitation WHERE id=$1", ["legacy-invite"]);
  assert.deepEqual(legacy.rows[0], { max_uses: 1, used_uses: 1 });
  assert.equal((await executor.query("SELECT * FROM projects_invitation_acceptance WHERE invitation_id=$1", ["legacy-invite"])).rowCount, 1);
  const s = await scopes(service, "project"); const invite = await s.issue(3);
  await service.acceptInvitation(bob, invite.token); await service.acceptInvitation(carol, invite.token);
  await pg.exec("CREATE FUNCTION fail_join_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='ProjectMemberJoined' THEN RAISE EXCEPTION 'rollback join'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_join BEFORE INSERT ON projects_change_fact FOR EACH ROW EXECUTE FUNCTION fail_join_fact();");
  await assert.rejects(service.acceptInvitation(dave, invite.token));
  assert.equal((await service.previewPublicSpaceInvitation(invite.token)).usedUses, 2);
  assert.equal((await executor.query("SELECT * FROM projects_invitation_acceptance WHERE invitation_id=$1", [invite.invitation.id])).rowCount, 2);
  await pg.exec("DROP TRIGGER fail_join ON projects_change_fact");
  const races = await Promise.allSettled([service.acceptInvitation(dave, invite.token), service.acceptInvitation(actor("last-contender"), invite.token)]);
  assert.equal(races.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await executor.query("SELECT * FROM projects_invitation_acceptance WHERE invitation_id=$1", [invite.invitation.id])).rowCount, 3);
  await assert.rejects(executor.query("DELETE FROM projects_invitation_acceptance WHERE invitation_id=$1", [invite.invitation.id]));
  await assert.rejects(executor.query("UPDATE projects_invitation SET used_uses=2 WHERE id=$1", [invite.invitation.id]));
  assert.equal((await service.previewPublicSpaceInvitation(invite.token)).usedUses, 3);
});
