import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { JoinRequest, ProjectLinkRequest, Registration, RegistrationForm, RosterTeam, TeamSuggestion } from "./model.ts";
import { PostgresRegistrationRepository } from "./postgres.ts";

const now = "2026-10-11T03:00:00.000Z";
const later = "2026-10-11T04:00:00.000Z";
const digest = "a".repeat(64);
const form = (eventId = "event-a", revision = 1): RegistrationForm => ({ eventId, revision, title: "报名", description: "填写个人参赛意向", fields: [{ id: "goal", type: "text", label: "想做什么", description: "", required: true, maxLength: 300 }], changeNote: "", publishedAt: now });
const registration = (userId = "user-1", eventId = "event-a", status: Registration["status"] = "approved", id = `${eventId}-${userId}`): Registration => ({ id, eventId, organizationId: eventId === "event-b" ? "org-b" : "org-a", userId, status, revision: 1, formRevision: 1, schema: form(eventId), answers: { goal: "验证小作品" }, reviewNote: "", submittedAt: status === "draft" ? null : now, reviewedAt: status === "approved" ? now : null, createdAt: now, updatedAt: now });
const team = (id = "team-1", eventId = "event-a"): RosterTeam => ({ id, eventId, organizationId: eventId === "event-b" ? "org-b" : "org-a", name: "一起试试", introduction: "做一个小作品", track: "", captainUserId: "user-1", memberUserIds: ["user-1", "user-2"], revision: 1, status: "forming", projectId: null, eligible: true, lockedRoster: null, lockedAt: null, createdAt: now, updatedAt: now });
const joinRequest = (id = "join-1", teamId = "team-1", userId = "user-2", eventId = "event-a"): JoinRequest => ({ id, eventId, teamId, userId, message: "希望参与", status: "pending", revision: 1, note: "", createdAt: now, updatedAt: now });
const link = (id = "link-1", eventId = "event-a", teamId = "team-1"): ProjectLinkRequest => ({ id, eventId, teamId, projectId: "private-project", requestedByUserId: "user-1", status: "pending", revision: 1, expectedTeamRevision: 1, createdAt: now, confirmedAt: null });

async function setup() {
  // No local path, environment file, root application migration or external connection is opened.
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY); INSERT INTO auth_users(id) VALUES ('user-1'),('user-2'),('user-3'),('staff');");
  await engine.exec(await readFile(new URL("./sql/001-event-registration.sql", import.meta.url), "utf8"));
  const statements: string[] = [];
  function executor(value: { query: PGlite["query"] }): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      statements.push(statement);
      const result = await value.query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows || result.rows.length };
    } };
  }
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(tx => work(executor(tx))) };
  const repository = new PostgresRegistrationRepository(database);
  async function seed() {
    await database.transaction(async sql => {
      const store = repository.store(sql);
      await store.lockEvent("event-a", "org-a"); await store.lockEvent("event-b", "org-b");
      for (const userId of ["user-1", "user-2", "user-3"]) await store.saveRegistration(registration(userId), 0, userId);
      await store.saveRegistration(registration("user-1", "event-b"), 0, "user-1");
      await store.saveTeam(team(), 0, "user-1");
      await store.saveTeam(team("team-2"), 0, "user-1");
      await store.saveTeam(team("team-1", "event-b"), 0, "user-1");
    });
  }
  return { engine, repository, database, statements, seed };
}

test("proposed SQL applies and every read remains read-only without event initialization", async () => {
  const { engine, repository, database, statements } = await setup();
  try {
    const store = repository.store(database);
    assert.equal(await store.getForm("missing"), null);
    assert.equal(await store.getRegistration("missing", "user-1"), null);
    assert.equal(await store.getRegistrationById("missing", "id"), null);
    assert.equal(await store.countReservations("missing"), 0);
    assert.deepEqual(await store.listRegistrations("missing", { limit: 2 }), { items: [], nextCursor: null });
    assert.deepEqual(await store.listOwnRegistrations("user-1", { limit: 2 }), { items: [], nextCursor: null });
    assert.equal(await store.getTeam("missing", "id"), null);
    assert.deepEqual(await store.listTeams("missing", { limit: 2 }), { items: [], nextCursor: null });
    assert.equal(await store.activeTeamId("missing", "user-1"), null);
    assert.deepEqual(await store.memberIds("missing", "id"), []);
    assert.equal(await store.getJoin("missing", "team", "id"), null);
    assert.equal(await store.getUserJoin("missing", "team", "user-1"), null);
    assert.deepEqual(await store.ownRequests("missing", "user-1"), []);
    assert.deepEqual(await store.pendingRequests("missing", "team"), []);
    assert.equal(await store.getLink("missing", "team"), null);
    assert.equal(await store.getSuggestion("missing", "id"), null);
    assert.deepEqual(await store.listSuggestions("missing"), []);
    assert.equal(await store.getReceipt("missing", "user-1", "submit", "key", digest), null);
    assert.equal(statements.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b|FOR UPDATE/i.test(sql)), false);
    assert.equal((await database.query("SELECT event_id FROM event_registration_event_state")).rowCount, 0);
  } finally { await engine.close(); }
});

test("event lock rejects another organization and forms remain immutable across versions", async () => {
  const { engine, repository, database } = await setup();
  try {
    await database.transaction(async sql => { const store = repository.store(sql); await store.lockEvent("event-a", "org-a"); await store.appendForm(form()); await store.appendForm({ ...form("event-a", 2), fields: [] }); });
    await assert.rejects(database.transaction(sql => repository.store(sql).lockEvent("event-a", "org-b")), { code: "EVENT_SCOPE_CONFLICT", status: 409 });
    await assert.rejects(database.transaction(sql => repository.store(sql).appendForm(form())), { code: "VERSION_CONFLICT" });
    assert.equal((await repository.store(database).getForm("event-a"))?.revision, 2);
    assert.equal(await repository.store(database).getForm("event-b"), null);
    await assert.rejects(database.query("UPDATE event_registration_forms SET data=data WHERE event_id='event-a' AND revision=1"), { code: "23514" });
    await assert.rejects(database.query("DELETE FROM event_registration_forms WHERE event_id='event-a' AND revision=1"), { code: "23514" });
    assert.equal((await database.query("SELECT revision FROM event_registration_forms WHERE event_id='event-a'")).rowCount, 2);
  } finally { await engine.close(); }
});

test("registrations reserve only pending or approved seats, preserve old schema and paginate by ownership", async () => {
  const { engine, repository, database } = await setup();
  try {
    await database.transaction(async sql => {
      const store = repository.store(sql); await store.lockEvent("event-a", "org-a"); await store.lockEvent("event-b", "org-b");
      await store.saveRegistration(registration("user-1", "event-a", "draft"), 0, "user-1");
      await store.saveRegistration(registration("user-2", "event-a", "pending"), 0, "user-2");
      await store.saveRegistration(registration("user-3"), 0, "user-3");
      await store.saveRegistration(registration("user-1", "event-b"), 0, "user-1");
      await store.appendForm({ ...form("event-a", 2), fields: [] });
    });
    const store = repository.store(database);
    assert.equal(await store.countReservations("event-a"), 2); assert.equal(await store.countReservations("event-b"), 1);
    assert.equal((await store.getRegistration("event-a", "user-2"))?.schema.fields[0]?.id, "goal");
    assert.equal(await store.getRegistrationById("event-b", "event-a-user-2"), null);
    const first = await store.listRegistrations("event-a", { limit: 1 });
    assert.deepEqual(first.items.map(value => value.userId), ["user-2"]); assert.equal(first.nextCursor, "event-a-user-2");
    assert.deepEqual((await store.listRegistrations("event-a", { limit: 2, cursor: first.nextCursor! })).items.map(value => value.userId), ["user-3"]);
    assert.deepEqual((await store.listRegistrations("event-a", { limit: 10, status: "draft" })).items, [], "staff cannot retrieve private drafts even with an explicit filter");
    const own = await store.listOwnRegistrations("user-1", { limit: 1 });
    assert.equal(own.items[0]?.eventId, "event-a"); assert.equal(own.nextCursor, "event-a-user-1");
    assert.equal((await store.listOwnRegistrations("user-1", { limit: 1, cursor: own.nextCursor! })).items[0]?.eventId, "event-b");
    assert.equal((await store.listRegistrations("event-a", { limit: 10, status: "pending" })).items.length, 1);
    await database.transaction(sql => repository.store(sql).saveRegistration({ ...registration("user-1", "event-a", "draft"), status: "withdrawn", revision: 2 }, 1, "user-1"));
    assert.equal((await store.listRegistrations("event-a", { limit: 10, status: "withdrawn" })).items.length, 0, "withdrawing a never submitted draft does not publish private answers");
    await assert.rejects(database.transaction(sql => repository.store(sql).saveRegistration(registration("user-2", "event-a", "pending", "duplicate-id"), 0, "user-2")), { code: "VERSION_CONFLICT" });
    await assert.rejects(store.listRegistrations("event-a", { limit: 101 }), { code: "INVALID_INPUT" });
  } finally { await engine.close(); }
});

test("registration CAS and history share the transaction and stale writers cannot overwrite", async () => {
  const { engine, repository, database, seed } = await setup();
  try {
    await seed();
    const original = registration();
    const updated: Registration = { ...original, revision: 2, status: "withdrawn", updatedAt: later };
    await database.transaction(sql => repository.store(sql).saveRegistration(updated, 1, "user-1"));
    await assert.rejects(database.transaction(sql => repository.store(sql).saveRegistration({ ...updated, status: "rejected" }, 1, "staff")), { code: "VERSION_CONFLICT", status: 409 });
    assert.equal((await repository.store(database).getRegistration("event-a", "user-1"))?.status, "withdrawn");
    const rows = (await database.query<{ revision: number; data: Registration; actor_user_id: string }>("SELECT revision,data,actor_user_id FROM event_registration_history WHERE event_id='event-a' AND kind='registration' AND id='event-a-user-1' ORDER BY revision")).rows;
    assert.deepEqual(rows.map(value => value.revision), [1, 2]); assert.equal(rows[0].data.status, "approved"); assert.equal(rows[1].actor_user_id, "user-1");
    await assert.rejects(database.query("UPDATE event_registration_history SET data=data WHERE event_id='event-a'"), { code: "23514" });
    await assert.rejects(database.transaction(async sql => { const store = repository.store(sql); await store.saveRegistration({ ...updated, revision: 3 }, 2, "staff"); await store.putReceipt("event-a", "staff", "review", "rollback", digest, { revision: 3 }); throw new Error("rollback"); }), /rollback/);
    assert.equal((await repository.store(database).getRegistration("event-a", "user-1"))?.revision, 2);
    assert.equal(await repository.store(database).getReceipt("event-a", "staff", "review", "rollback", digest), null);
    await assert.rejects(database.transaction(sql => repository.store(sql).saveRegistration({ ...registration("user-3"), id: "event-a-user-3", revision: 2 }, 1, "missing-user")), { code: "23503" });
    assert.equal((await repository.store(database).getRegistration("event-a", "user-3"))?.revision, 1, "failed actor audit rolls current row back");
  } finally { await engine.close(); }
});

test("real accepted members enforce one active team per event and support deliberate leave and rejoin", async () => {
  const { engine, repository, database, seed } = await setup();
  try {
    await seed(); const store = repository.store(database);
    assert.deepEqual(await store.memberIds("event-a", "team-1"), [], "cached team memberUserIds are not accepted members");
    await database.transaction(async sql => { const tx = repository.store(sql); await tx.acceptMember("event-a", "team-1", "user-1", now); await tx.acceptMember("event-b", "team-1", "user-1", now); });
    assert.equal(await store.activeTeamId("event-a", "user-1"), "team-1");
    await database.transaction(sql => repository.store(sql).acceptMember("event-a", "team-1", "user-1", later));
    assert.equal((await database.query<{ accepted_at: Date }>("SELECT accepted_at FROM event_registration_members WHERE event_id='event-a'")).rows[0].accepted_at.toISOString(), now, "duplicate acceptance keeps original fact");
    await assert.rejects(database.transaction(sql => repository.store(sql).acceptMember("event-a", "team-2", "user-1", now)), { code: "TEAM_MEMBERSHIP_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).acceptMember("event-b", "team-1", "user-2", now)), { code: "23503" }, "cannot use another event's registration");
    await database.transaction(sql => repository.store(sql).leaveMember("event-b", "team-1", "user-1", later));
    assert.equal(await store.activeTeamId("event-a", "user-1"), "team-1", "leave is event scoped");
    await database.transaction(async sql => { const tx = repository.store(sql); await tx.leaveMember("event-a", "team-1", "user-1", later); await tx.acceptMember("event-a", "team-2", "user-1", later); });
    assert.deepEqual(await store.memberIds("event-a", "team-1"), []); assert.deepEqual(await store.memberIds("event-a", "team-2"), ["user-1"]);
    await database.transaction(async sql => { const tx = repository.store(sql); await tx.leaveMember("event-a", "team-2", "user-1", later); await tx.acceptMember("event-a", "team-1", "user-1", later); });
    assert.equal((await database.query("SELECT user_id FROM event_registration_members WHERE event_id='event-a' AND team_id='team-1'")).rowCount, 1, "rejoin restores the existing record");
  } finally { await engine.close(); }
});

test("teams, joins and links use event and version guards, with immutable histories", async () => {
  const { engine, repository, database, seed } = await setup();
  try {
    await seed();
    await database.transaction(async sql => { const store = repository.store(sql); await store.saveTeam({ ...team(), status: "locked", revision: 2 }, 1, "user-1"); await store.saveTeam({ ...team("team-2"), status: "withdrawn", revision: 2 }, 1, "user-1"); await store.saveJoin(joinRequest(), 0, "user-2"); await store.saveLink(link(), 0, "user-1"); });
    const store = repository.store(database);
    assert.equal((await store.getTeam("event-b", "team-1"))?.status, "forming");
    assert.deepEqual((await store.listTeams("event-a", { limit: 5 })).items.map(value => value.id), ["team-1"]);
    assert.equal((await store.listTeams("event-a", { limit: 5, status: "locked" })).items.length, 1);
    assert.equal(await store.getJoin("event-b", "team-1", "join-1"), null); assert.equal(await store.getJoin("event-a", "team-2", "join-1"), null);
    assert.equal((await store.getUserJoin("event-a", "team-1", "user-2"))?.id, "join-1");
    assert.equal(await store.getLink("event-b", "team-1", "link-1"), null);
    await database.transaction(async sql => { const tx = repository.store(sql); await tx.saveJoin({ ...joinRequest(), status: "accepted", revision: 2 }, 1, "user-1"); await tx.saveLink({ ...link(), status: "confirmed", revision: 2, confirmedAt: later }, 1, "user-1"); await tx.saveLink({ ...link("link-2"), createdAt: later }, 0, "user-1"); });
    assert.equal((await store.getLink("event-a", "team-1"))?.id, "link-2");
    assert.equal((await store.getLink("event-a", "team-1", "link-1"))?.status, "confirmed");
    assert.deepEqual(await store.pendingRequests("event-a", "team-1"), []); assert.equal((await store.ownRequests("event-a", "user-2"))[0]?.status, "accepted");
    await assert.rejects(database.transaction(sql => repository.store(sql).saveTeam({ ...team(), revision: 2 }, 1, "user-1")), { code: "VERSION_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).saveJoin({ ...joinRequest(), revision: 2 }, 1, "user-2")), { code: "VERSION_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).saveLink({ ...link(), revision: 2 }, 1, "user-1")), { code: "VERSION_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).saveJoin(joinRequest("new-id"), 0, "user-2")), { code: "VERSION_CONFLICT" });
    assert.deepEqual((await database.query<{ kind: string; count: number }>("SELECT kind,count(*)::int AS count FROM event_registration_history WHERE event_id='event-a' AND kind IN ('team','join','link') GROUP BY kind ORDER BY kind")).rows, [{ kind: "join", count: 2 }, { kind: "link", count: 3 }, { kind: "team", count: 4 }]);
  } finally { await engine.close(); }
});

test("idempotency receipts bind event, user, operation, key and SHA-256 and retain first result", async () => {
  const { engine, repository, database } = await setup();
  try {
    await database.transaction(async sql => { const store = repository.store(sql); await store.lockEvent("event-a", "org-a"); await store.putReceipt("event-a", "user-1", "submit", "key", digest, { revision: 1 }); await store.putReceipt("event-a", "user-1", "submit", "key", digest, { revision: 999 }); });
    const store = repository.store(database);
    assert.deepEqual(await store.getReceipt("event-a", "user-1", "submit", "key", digest), { revision: 1 });
    assert.equal(await store.getReceipt("event-b", "user-1", "submit", "key", digest), null);
    assert.equal(await store.getReceipt("event-a", "user-2", "submit", "key", digest), null);
    assert.equal(await store.getReceipt("event-a", "user-1", "withdraw", "key", digest), null);
    await assert.rejects(store.getReceipt("event-a", "user-1", "submit", "key", "b".repeat(64)), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).putReceipt("event-a", "user-1", "submit", "key", "b".repeat(64), { revision: 2 })), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(store.getReceipt("event-a", "user-1", "submit", "key", "invalid-hash"), { code: "INVALID_INPUT" });
    await assert.rejects(database.query("DELETE FROM event_registration_receipts WHERE event_id='event-a'"), { code: "23514" });
  } finally { await engine.close(); }
});

test("staff proposals stay separate from accepted members and only their first confirmed team may be set", async () => {
  const { engine, repository, database, seed } = await setup();
  try {
    await seed();
    const proposal: TeamSuggestion = { id: "suggest-1", eventId: "event-a", captainUserId: "user-1", memberUserIds: ["user-1", "user-2"], name: "建议一起做", track: "", note: "可以先互相认识", createdByUserId: "staff", createdAt: now, teamId: null };
    await database.transaction(sql => repository.store(sql).saveSuggestion(proposal));
    const store = repository.store(database);
    assert.deepEqual(await store.memberIds("event-a", "team-1"), []);
    assert.equal((await store.listSuggestions("event-a", "user-2")).length, 1); assert.deepEqual(await store.listSuggestions("event-a", "user-3"), []);
    assert.equal(await store.getSuggestion("event-b", proposal.id), null); assert.equal((await store.listSuggestions("event-a")).length, 1);
    await database.transaction(sql => repository.store(sql).saveSuggestion({ ...proposal, teamId: "team-1" }));
    assert.equal((await store.getSuggestion("event-a", proposal.id))?.teamId, "team-1");
    assert.equal((await database.query<{ data: TeamSuggestion }>("SELECT data FROM event_registration_team_suggestions WHERE event_id='event-a'")).rows[0].data.teamId, null, "original staff proposal remains intact");
    await assert.rejects(database.transaction(sql => repository.store(sql).saveSuggestion({ ...proposal, teamId: "team-2" })), { code: "VERSION_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).saveSuggestion({ ...proposal, teamId: null })), { code: "VERSION_CONFLICT" });
    await assert.rejects(database.transaction(sql => repository.store(sql).saveSuggestion({ ...proposal, teamId: "team-1", note: "改写原提议" })), { code: "VERSION_CONFLICT" });
    await assert.rejects(database.query("UPDATE event_registration_team_suggestions SET data=data WHERE event_id='event-a'"), { code: "23514" });
  } finally { await engine.close(); }
});

test("isolated single-engine concurrent writers preserve one CAS winner and one accepted team", async () => {
  const { engine, repository, database, seed } = await setup();
  try {
    await seed();
    const writes = await Promise.allSettled(["first", "second"].map(reviewNote => database.transaction(async sql => {
      const store = repository.store(sql); await store.lockEvent("event-a", "org-a");
      await store.saveRegistration({ ...registration(), revision: 2, reviewNote }, 1, "staff");
    })));
    assert.equal(writes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal((writes.find(value => value.status === "rejected") as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
    assert.equal((await database.query("SELECT revision FROM event_registration_history WHERE event_id='event-a' AND kind='registration' AND id='event-a-user-1'")).rowCount, 2);
    const joins = await Promise.allSettled(["team-1", "team-2"].map(teamId => database.transaction(async sql => {
      const store = repository.store(sql); await store.lockEvent("event-a", "org-a"); await store.acceptMember("event-a", teamId, "user-2", now);
    })));
    assert.equal(joins.filter(value => value.status === "fulfilled").length, 1);
    assert.equal((joins.find(value => value.status === "rejected") as PromiseRejectedResult).reason.code, "TEAM_MEMBERSHIP_CONFLICT");
    assert.equal((await database.query("SELECT team_id FROM event_registration_members WHERE event_id='event-a' AND user_id='user-2' AND left_at IS NULL")).rowCount, 1);
  } finally { await engine.close(); }
});

test("bounded request lists cap at 100 in stable ID order and SQL rejects inconsistent snapshots", async () => {
  const { engine, repository, database, seed } = await setup();
  try {
    await seed();
    await database.transaction(async sql => {
      const store = repository.store(sql);
      for (let index = 0; index < 105; index++) {
        const suffix = String(index).padStart(3, "0"); const userId = `visitor-${suffix}`;
        await sql.query("INSERT INTO auth_users(id) VALUES ($1)", [userId]);
        await store.saveRegistration(registration(userId), 0, userId);
        await store.saveJoin(joinRequest(`pending-${suffix}`, "team-1", userId), 0, userId);
        const teamId = `recruit-${suffix}`; await store.saveTeam(team(teamId), 0, "user-1");
        await store.saveJoin(joinRequest(`own-${suffix}`, teamId, "user-2"), 0, "user-2");
      }
    });
    const store = repository.store(database);
    assert.equal((await store.pendingRequests("event-a", "team-1")).length, 100);
    assert.equal((await store.pendingRequests("event-a", "team-1")).at(-1)?.id, "pending-099");
    assert.equal((await store.ownRequests("event-a", "user-2")).length, 100);
    assert.equal((await store.ownRequests("event-a", "user-2")).at(-1)?.id, "own-099");
    await database.transaction(async sql => {
      const tx = repository.store(sql);
      for (let index = 0; index < 100; index++) {
        const suffix = String(index).padStart(3, "0");
        await tx.saveJoin({ ...joinRequest(`own-${suffix}`, `recruit-${suffix}`, "user-2"), status: "rejected", revision: 2, updatedAt: later }, 1, "user-1");
      }
    });
    assert.deepEqual((await store.ownRequests("event-a", "user-2")).slice(0, 5).map(value => value.id), ["own-100", "own-101", "own-102", "own-103", "own-104"], "remaining pending requests cannot be pushed out by more recent processed items");
    await assert.rejects(database.query("UPDATE event_registration_registrations SET data=jsonb_set(data,'{status}','null'::jsonb) WHERE event_id='event-a' AND user_id='user-1'"), { code: "23514" });
    await assert.rejects(database.query("UPDATE event_registration_registrations SET data=jsonb_set(data,'{eventId}','\"event-b\"'::jsonb) WHERE event_id='event-a' AND user_id='user-1'"), { code: "23514" });
    await assert.rejects(database.transaction(sql => repository.store(sql).saveRegistration({ ...registration(), revision: 4 }, 1, "user-1")), { code: "INVALID_INPUT" });
  } finally { await engine.close(); }
});
