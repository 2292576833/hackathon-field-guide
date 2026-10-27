import test from "node:test";
import assert from "node:assert/strict";
import { createEventRegistrationService } from "./service.ts";
import { PostgresRegistrationRepository } from "./postgres.ts";
import { registrationFixture, DEFAULT_FIELDS } from "./test-fixture.ts";

test("one account has separate registrations in two organizations; stale drafts preserve schema and cannot submit", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.publish("event-b");
    const a = await f.draft("alice"), b = await f.register("alice", "event-b");
    assert.notEqual(a.id, b.id); assert.equal(b.organizationId, "org-b");
    await assert.rejects(f.service.saveDraft(f.principals.alice, "event-a", { expectedRevision: 0, formRevision: 1, answers: { goal: "overwrite" } }), { code: "VERSION_CONFLICT", latestRevision: 1 });
    const updated = await f.publish("event-a", [...DEFAULT_FIELDS, { id: "role", type: "choice", label: "希望承担什么", description: "", required: true, options: ["设计", "开发"] }]);
    await assert.rejects(f.service.submit(f.principals.alice, "event-a", { expectedRevision: a.revision, idempotencyKey: "old-form" }), { code: "FORM_CHANGED" });
    const preserved = (await f.service.getMine(f.principals.alice, "event-a")).registration!;
    assert.equal(preserved.schema.revision, 1); assert.deepEqual(preserved.schema.fields.map(item => item.id), ["goal"]);
    assert.deepEqual(preserved.answers, { goal: "做一个小作品" });
    const incomplete = await f.service.saveDraft(f.principals.alice, "event-a", { expectedRevision: preserved.revision, formRevision: updated.revision, answers: { goal: "保留草稿" } });
    await assert.rejects(f.service.submit(f.principals.alice, "event-a", { expectedRevision: incomplete.revision, idempotencyKey: "incomplete" }), { code: "INVALID_INPUT" });
    await f.service.saveDraft(f.principals.alice, "event-a", { expectedRevision: incomplete.revision, formRevision: updated.revision, answers: { goal: "保留草稿", role: "设计" } });
    assert.equal((await f.database.query("SELECT id FROM event_registration_registrations WHERE user_id=$1", ["alice"])).rowCount, 2);
    const history = (await f.database.query<{ data: { schema: { revision: number } } }>("SELECT data FROM event_registration_history WHERE kind='registration' AND id=$1 ORDER BY revision", [a.id])).rows;
    assert.equal(history[0].data.schema.revision, 1); assert.equal(history.at(-1)!.data.schema.revision, 2);
  } finally { await f.engine.close(); }
});

test("drafts reserve no seats; serialized last-slot exercise, review, reject, withdraw and receipt conflicts preserve quota", async () => {
  const f = await registrationFixture();
  try {
    const scope = f.scopes.get("event-a")!; f.scopes.set("event-a", { ...scope, registration: { capacity: 1, reviewRequired: true } });
    await f.publish(); const a = await f.draft("alice"), b = await f.draft("bob"), c = await f.draft("carol");
    assert.equal((await f.service.getRegistrationForm("event-a")).reservedCount, 0);
    // Single-engine PGlite queues transactions. This exercises isolation and business locks, not multi-connection PostgreSQL races.
    const values = await Promise.allSettled([
      f.service.submit(f.principals.alice, "event-a", { expectedRevision: a.revision, idempotencyKey: "last-alice" }),
      f.service.submit(f.principals.bob, "event-a", { expectedRevision: b.revision, idempotencyKey: "last-bob" }),
    ]);
    assert.equal(values.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(values.filter(item => item.status === "rejected").length, 1);
    const failure = values.find(item => item.status === "rejected") as PromiseRejectedResult;
    assert.equal(failure.reason.code, "REGISTRATION_FULL");
    const winnerId = values[0].status === "fulfilled" ? "alice" : "bob";
    const winner = (await f.service.getMine(f.principals[winnerId], "event-a")).registration!;
    assert.equal(winner.status, "pending");
    const command = { expectedRevision: 1, idempotencyKey: `last-${winnerId}` };
    assert.deepEqual(await f.service.submit(f.principals[winnerId], "event-a", command), winner);
    await assert.rejects(f.service.submit(f.principals[winnerId], "event-a", { ...command, expectedRevision: 2 }), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
    const approved = await f.service.review(f.principals.staff, "event-a", winner.id, { expectedRevision: winner.revision, decision: "approved", note: "", idempotencyKey: "approve-first" });
    assert.equal((await f.service.getRegistrationForm("event-a")).reservedCount, 1);
    await f.service.review(f.principals.staff, "event-a", winner.id, { expectedRevision: approved.revision, decision: "rejected", note: "资料需更正", idempotencyKey: "reject-first" });
    assert.equal((await f.service.getRegistrationForm("event-a")).reservedCount, 0);
    const next = await f.service.submit(f.principals.carol, "event-a", { expectedRevision: c.revision, idempotencyKey: "carol-after-release" });
    await f.service.withdraw(f.principals.carol, "event-a", { expectedRevision: next.revision, idempotencyKey: "carol-withdraw" });
    assert.equal((await f.service.getRegistrationForm("event-a")).reservedCount, 0);
    assert.equal((await f.service.getMine(f.principals.carol, "event-a")).registration?.status, "withdrawn");
  } finally { await f.engine.close(); }
});

test("server window, module disabling and archival retain real history without permitting new submissions", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); const draft = await f.draft("alice");
    f.setNow("2026-10-12T00:00:00.000Z");
    await assert.rejects(f.service.submit(f.principals.alice, "event-a", { expectedRevision: draft.revision, idempotencyKey: "deadline" }), { code: "REGISTRATION_CLOSED" });
    f.setNow("2026-10-11T03:00:00.000Z"); const event = f.scopes.get("event-a")!;
    f.scopes.set("event-a", { ...event, modules: { ...event.modules, registration: false } });
    await assert.rejects(f.draft("bob"), { code: "REGISTRATION_DISABLED" });
    assert.equal((await f.service.getMine(f.principals.alice, "event-a")).registration?.status, "draft");
    const withdrawn = await f.service.withdraw(f.principals.alice, "event-a", { expectedRevision: draft.revision, idempotencyKey: "disabled-withdraw" });
    f.scopes.set("event-a", { ...event, status: "archived" });
    await assert.rejects(f.service.withdraw(f.principals.alice, "event-a", { expectedRevision: withdrawn.revision, idempotencyKey: "archive" }), { code: "EVENT_READ_ONLY" });
    assert.equal((await f.service.getMine(f.principals.alice, "event-a")).registration?.status, "withdrawn");
  } finally { await f.engine.close(); }
});

test("staff capability/event scope limits answers and exports; private draft and withdrawn draft remain private", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.publish("event-b");
    const privateDraft = await f.draft("alice", "event-a", { goal: "草稿机密" });
    await f.service.withdraw(f.principals.alice, "event-a", { expectedRevision: privateDraft.revision, idempotencyKey: "private-withdraw" });
    await f.draft("bob", "event-a", { goal: "未提交机密" });
    const c = await f.register("carol"); await f.register("alice", "event-b");
    const list = await f.service.listStaff(f.principals.staff, "event-a");
    assert.deepEqual(list.registrations.items.map(item => item.userId), ["carol"]);
    assert.deepEqual((await f.service.listStaff(f.principals.staff, "event-a", { status: "withdrawn" })).registrations.items, []);
    await assert.rejects(f.service.listStaff(f.principals.staff, "event-a", { status: "draft" }), { code: "INVALID_INPUT" });
    await assert.rejects(f.service.listStaff(f.principals["team-staff"], "event-a"), { code: "EVENT_ACCESS_DENIED", status: 403 });
    await assert.rejects(f.service.exportRegistrations(f.principals["team-staff"], "event-a"), { code: "EVENT_ACCESS_DENIED", status: 403 });
    f.grant("team-staff", "event-a", "registration_manage");
    await assert.rejects(f.service.exportRegistrations(f.principals["team-staff"], "event-b"), { code: "EVENT_ACCESS_DENIED", status: 403 });
    await f.service.review(f.principals.staff, "event-a", c.id, { expectedRevision: c.revision, decision: "rejected", note: " =HYPERLINK(\"https://example.com\")", idempotencyKey: "formula-note" });
    const exported = await f.service.exportRegistrations(f.principals.staff, "event-a");
    assert.equal(exported.count, 1); assert.equal(exported.csv.includes("草稿机密"), false); assert.equal(exported.csv.includes("未提交机密"), false);
    assert.ok(exported.csv.includes("\"'=HYPERLINK(")); assert.ok(exported.csv.startsWith("\uFEFF"));
    await assert.rejects(f.service.review(f.principals.staff, "event-b", c.id, { expectedRevision: c.revision, decision: "rejected", note: "跨赛", idempotencyKey: "wrong-event" }), { code: "NOT_FOUND", status: 404 });
  } finally { await f.engine.close(); }
});

test("teams-only staff get approved candidate IDs without answers/schema/email, while registration reads and exports still deny", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.publish("event-b"); await f.register("alice"); await f.register("dave"); await f.register("alice", "event-b");
    await f.draft("bob", "event-a", { goal: "私人草稿" });
    const event = f.scopes.get("event-a")!; f.scopes.set("event-a", { ...event, revision: 2, registration: { ...event.registration, reviewRequired: true } });
    await f.register("carol");
    f.statements.length = 0;
    const first = await f.service.getStaffCandidates(f.principals["team-staff"], "event-a", { limit: 1 });
    assert.equal(first.candidates.items.length, 1); assert.ok(first.candidates.nextCursor);
    const second = await f.service.getStaffCandidates(f.principals["team-staff"], "event-a", { limit: 1, cursor: first.candidates.nextCursor! });
    const candidates = [...first.candidates.items, ...second.candidates.items];
    assert.deepEqual(candidates.map(item => item.userId), ["alice", "dave"]);
    for (const candidate of candidates) assert.deepEqual(Object.keys(candidate).sort(), ["registrationId", "revision", "userId"]);
    assert.equal(JSON.stringify(candidates).includes("私人草稿"), false);
    assert.equal(f.statements.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
    await assert.rejects(f.service.listStaff(f.principals["team-staff"], "event-a"), { code: "EVENT_ACCESS_DENIED", status: 403 });
    await assert.rejects(f.service.exportRegistrations(f.principals["team-staff"], "event-a"), { code: "EVENT_ACCESS_DENIED", status: 403 });
    await assert.rejects(f.service.getStaffCandidates(f.principals["team-staff"], "event-b"), { code: "EVENT_ACCESS_DENIED", status: 403 });
  } finally { await f.engine.close(); }
});

test("review receipt cannot disclose its old answer after the applicant withdraws and saves a new private draft", async () => {
  const f = await registrationFixture();
  try {
    const event = f.scopes.get("event-a")!; f.scopes.set("event-a", { ...event, registration: { ...event.registration, reviewRequired: true } });
    await f.publish(); const pending = await f.register("alice");
    const reviewInput = { expectedRevision: pending.revision, decision: "approved" as const, note: "", idempotencyKey: "original-review" };
    const approved = await f.service.review(f.principals.staff, "event-a", pending.id, reviewInput);
    await f.service.withdraw(f.principals.alice, "event-a", { expectedRevision: approved.revision, idempotencyKey: "withdraw-approved" });
    const privateDraft = await f.draft("alice", "event-a", { goal: "新私人草稿" });
    await assert.rejects(f.service.review(f.principals.staff, "event-a", pending.id, reviewInput), { code: "REGISTRATION_NOT_REVIEWABLE" });
    assert.equal((await f.service.listStaff(f.principals.staff, "event-a")).registrations.items.length, 0);
    assert.equal((await f.service.exportRegistrations(f.principals.staff, "event-a")).count, 0);
    assert.equal((await f.service.getMine(f.principals.alice, "event-a")).registration?.revision, privateDraft.revision);
    assert.equal((await f.service.getMine(f.principals.alice, "event-a")).registration?.answers.goal, "新私人草稿");
  } finally { await f.engine.close(); }
});

test("session revocation at final guard rolls back current row and audit; staff revocation denies reads", async () => {
  const f = await registrationFixture();
  try {
    await f.publish();
    const revoked = f.principal("alice", async (sql, invocation) => { if (invocation === 2) await sql.query("UPDATE auth_users SET session_active=false WHERE id=$1", ["alice"]); });
    await assert.rejects(f.service.saveDraft(revoked, "event-a", { expectedRevision: 0, formRevision: 1, answers: { goal: "不能保存" } }), { code: "UNAUTHENTICATED", status: 401 });
    assert.equal((await f.service.getMine(f.principals.alice, "event-a")).registration, null);
    assert.equal((await f.database.query("SELECT id FROM event_registration_history WHERE actor_user_id=$1", ["alice"])).rowCount, 0);
    assert.equal((await f.database.query<{ session_active: boolean }>("SELECT session_active FROM auth_users WHERE id=$1", ["alice"])).rows[0].session_active, true, "fixture revocation and write both roll back");
    let calls = 0; const readRevoked = f.principal("staff", async () => { if (++calls === 2) f.grants.delete("staff:event-a"); });
    await assert.rejects(f.service.listStaff(readRevoked, "event-a"), { code: "EVENT_ACCESS_DENIED", status: 403 });
  } finally { await f.engine.close(); }
});

test("staff capability revoked after a form write rolls back its published version; organization change also rolls back draft", async () => {
  const f = await registrationFixture();
  try {
    await f.publish();
    const revokedStaff = f.principal("staff", async (_sql, invocation) => { if (invocation === 2) f.grants.delete("staff:event-a"); });
    await assert.rejects(f.service.saveForm(revokedStaff, "event-a", { expectedRevision: 1, title: "不能发布", description: "", fields: DEFAULT_FIELDS, changeNote: "新字段" }), { code: "EVENT_ACCESS_DENIED", status: 403 });
    assert.equal((await f.service.getRegistrationForm("event-a")).form?.revision, 1);
    assert.equal((await f.database.query("SELECT revision FROM event_registration_forms WHERE event_id=$1", ["event-a"])).rowCount, 1);
    const event = f.scopes.get("event-a")!;
    const changed = f.principal("alice", async (_sql, invocation) => { if (invocation === 2) f.scopes.set("event-a", { ...event, organizationId: "org-b", revision: event.revision + 1 }); });
    await assert.rejects(f.service.saveDraft(changed, "event-a", { expectedRevision: 0, formRevision: 1, answers: { goal: "不能跨机构写入" } }), { code: "EVENT_CHANGED", status: 409 });
    f.scopes.set("event-a", event);
    assert.equal((await f.service.getMine(f.principals.alice, "event-a")).registration, null);
    assert.equal((await f.database.query("SELECT id FROM event_registration_history WHERE actor_user_id=$1", ["alice"])).rowCount, 0);
  } finally { await f.engine.close(); }
});

test("accepted membership requires personal request and captain approval; pending requests do not consume last seat", async () => {
  const f = await registrationFixture();
  try {
    const event = f.scopes.get("event-a")!; f.scopes.set("event-a", { ...event, teams: { ...event.teams, maxSize: 2 } });
    await f.publish(); for (const id of ["alice", "bob", "carol"]) await f.register(id);
    const team = await f.createTeam();
    const b = await f.service.requestJoin(f.principals.bob, "event-a", team.id, { expectedTeamRevision: team.revision, message: "本人申请", idempotencyKey: "bob-request" });
    const c = await f.service.requestJoin(f.principals.carol, "event-a", team.id, { expectedTeamRevision: team.revision, message: "本人申请", idempotencyKey: "carol-request" });
    assert.deepEqual((await f.service.getTeam(f.database, "event-a", team.id))?.memberUserIds, ["alice"]);
    assert.equal((await f.service.listPublicTeams("event-a")).teams.items[0].availableSeats, 1);
    const accept = { expectedRevision: 1, expectedTeamRevision: team.revision, decision: "accepted" as const, note: "", idempotencyKey: "accept-bob" };
    await assert.rejects(f.service.respondJoin(f.principals.carol, "event-a", team.id, b.id, accept), { code: "EVENT_ACCESS_DENIED", status: 403 });
    const results = await Promise.allSettled([f.service.respondJoin(f.principals.alice, "event-a", team.id, b.id, accept), f.service.respondJoin(f.principals.alice, "event-a", team.id, c.id, { ...accept, idempotencyKey: "accept-carol" })]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    const failure = results.find(item => item.status === "rejected") as PromiseRejectedResult; assert.equal(failure.reason.code, "VERSION_CONFLICT");
    const current = (await f.service.getTeam(f.database, "event-a", team.id))!; assert.equal(current.memberUserIds.length, 2);
    const leftover = current.memberUserIds.includes("bob") ? c : b;
    await assert.rejects(f.service.respondJoin(f.principals.alice, "event-a", team.id, leftover.id, { ...accept, expectedTeamRevision: current.revision, idempotencyKey: "fresh-last-seat" }), { code: "TEAM_FULL" });
    await assert.rejects(f.service.requestJoin(f.principals.bob, "event-b", team.id, { expectedTeamRevision: team.revision, message: "跨赛", idempotencyKey: "guess" }), { code: "REGISTRATION_REQUIRED" });
    await f.publish("event-b"); await f.register("bob", "event-b");
    await assert.rejects(f.service.requestJoin(f.principals.bob, "event-b", team.id, { expectedTeamRevision: team.revision, message: "跨赛", idempotencyKey: "guess-after-reg" }), { code: "NOT_FOUND", status: 404 });
  } finally { await f.engine.close(); }
});

test("accepting one team cancels other pending requests and prevents another active roster; public projection remains minimal", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); for (const id of ["alice", "bob", "carol"]) await f.register(id);
    const a = await f.createTeam("alice"), c = await f.createTeam("carol");
    const first = await f.service.requestJoin(f.principals.bob, "event-a", a.id, { expectedTeamRevision: 1, message: "本人希望加入", idempotencyKey: "request-a" });
    await f.service.requestJoin(f.principals.bob, "event-a", c.id, { expectedTeamRevision: 1, message: "本人希望加入", idempotencyKey: "request-c" });
    await f.service.respondJoin(f.principals.alice, "event-a", a.id, first.id, { expectedRevision: 1, expectedTeamRevision: 1, decision: "accepted", note: "", idempotencyKey: "accept-one" });
    const mine = await f.service.listTeams(f.principals.bob, "event-a");
    assert.equal(mine.ownTeam?.id, a.id); assert.equal(mine.ownRequests.find(item => item.teamId === c.id)?.status, "cancelled");
    await assert.rejects(f.createTeam("bob"), { code: "ALREADY_IN_TEAM" });
    const publicItems = (await f.service.listPublicTeams("event-a")).teams.items;
    for (const item of publicItems) assert.deepEqual(Object.keys(item).sort(), ["availableSeats", "eventId", "id", "introduction", "memberCount", "name", "revision", "status", "track"].sort());
    await f.service.leaveTeam(f.principals.carol, "event-a", c.id, { expectedRevision: 1, idempotencyKey: "leave-c" });
    const injectedStatus = { status: "withdrawn" } as { cursor?: string; limit?: number };
    assert.equal((await f.service.listPublicTeams("event-a", injectedStatus)).teams.items.some(item => item.id === c.id), false);
    assert.equal((await f.service.getTeam(f.database, "event-b", a.id)), null);
  } finally { await f.engine.close(); }
});

test("locked roster snapshots invalidate on leaving even above minimum, and withdrawn registration invalidates eligibility without erasing history", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.register("alice"); const b = await f.register("bob");
    const team = await f.createTeam(); await f.addMember(team.id, "bob");
    const locked = await f.service.lockRoster(f.principals.alice, "event-a", team.id, { expectedRevision: 2, idempotencyKey: "lock" });
    assert.equal(locked.eligible, true); assert.equal(locked.lockedRoster?.length, 2);
    const left = await f.service.leaveTeam(f.principals.bob, "event-a", team.id, { expectedRevision: locked.revision, idempotencyKey: "leave-bob" });
    assert.equal(left.status, "locked"); assert.equal(left.memberUserIds.length, 1); assert.equal(left.eligible, false);
    assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.eligible, false, "current accepted set no longer matches frozen roster");
    assert.equal((await f.database.query("SELECT user_id FROM event_registration_members WHERE team_id=$1 AND left_at IS NOT NULL", [team.id])).rowCount, 1);
    assert.equal((await f.service.getMine(f.principals.bob, "event-a")).registration?.id, b.id);
    await f.service.withdraw(f.principals.alice, "event-a", { expectedRevision: 2, idempotencyKey: "withdraw-captain" });
    assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.eligible, false);
    assert.equal((await f.database.query("SELECT data FROM event_registration_history WHERE kind='team' AND id=$1", [team.id])).rowCount, 5);
  } finally { await f.engine.close(); }
});

test("former captain cannot replay accepted join, lock or project-request receipts after transfer", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.register("alice"); await f.register("bob");
    const team = await f.createTeam(); const request = await f.addMember(team.id, "bob");
    const linkInput = { expectedRevision: 2, projectId: "private-project", idempotencyKey: "link-request" };
    await f.service.requestProjectLink(f.principals.alice, "event-a", team.id, linkInput);
    const lockInput = { expectedRevision: 2, idempotencyKey: "lock-receipt" };
    await f.service.lockRoster(f.principals.alice, "event-a", team.id, lockInput);
    await f.service.leaveTeam(f.principals.alice, "event-a", team.id, { expectedRevision: 3, successorUserId: "bob", idempotencyKey: "transfer" });
    await assert.rejects(f.service.respondJoin(f.principals.alice, "event-a", team.id, request.id, { expectedRevision: 1, expectedTeamRevision: 1, decision: "accepted", note: "", idempotencyKey: `accept-${request.id}` }), { code: "EVENT_ACCESS_DENIED", status: 403 });
    await assert.rejects(f.service.lockRoster(f.principals.alice, "event-a", team.id, lockInput), { code: "EVENT_ACCESS_DENIED", status: 403 });
    await assert.rejects(f.service.requestProjectLink(f.principals.alice, "event-a", team.id, linkInput), { code: "EVENT_ACCESS_DENIED", status: 403 });
  } finally { await f.engine.close(); }
});

test("frozen roster requires the exact approved registration revision and withdrawal leaves accepted members/history intact", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); const a = await f.register("alice"); const b = await f.register("bob");
    const team = await f.createTeam(); await f.addMember(team.id, "bob");
    const locked = await f.service.lockRoster(f.principals.alice, "event-a", team.id, { expectedRevision: 2, idempotencyKey: "lock-original-registrations" });
    assert.equal(locked.eligible, true);
    await f.service.review(f.principals.staff, "event-a", b.id, { expectedRevision: b.revision, decision: "approved", note: "重新核对资料", idempotencyKey: "review-approved-revision" });
    const revised = (await f.service.getTeam(f.database, "event-a", team.id))!;
    assert.equal(revised.memberUserIds.length, 2); assert.equal(revised.eligible, false, "approved status alone cannot make a changed confirmation snapshot valid");
    const original = (await f.service.listTeams(f.principals.alice, "event-a")).ownTeam!;
    assert.equal(original.lockedRoster?.find(item => item.userId === "bob")?.registrationRevision, b.revision);
    await f.service.withdraw(f.principals.alice, "event-a", { expectedRevision: a.revision, idempotencyKey: "withdraw-locked-registration" });
    const withdrawn = (await f.service.getTeam(f.database, "event-a", team.id))!;
    assert.equal(withdrawn.eligible, false); assert.deepEqual(withdrawn.memberUserIds, ["alice", "bob"]);
    assert.equal((await f.database.query("SELECT user_id FROM event_registration_members WHERE team_id=$1 AND left_at IS NULL", [team.id])).rowCount, 2);
    assert.equal((await f.database.query("SELECT id FROM event_registration_history WHERE kind='registration' AND id=$1", [a.id])).rowCount, 3);
  } finally { await f.engine.close(); }
});

test("private project linking stays pending until explicit manager confirmation; GET uses preview only and replay rechecks manager", async () => {
  const f = await registrationFixture({ preview: true });
  try {
    await f.publish(); await f.register("alice"); const team = await f.createTeam();
    const request = await f.service.requestProjectLink(f.principals.alice, "event-a", team.id, { expectedRevision: 1, projectId: "private-project", idempotencyKey: "link" });
    assert.equal(request.status, "pending"); assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.projectId, null); assert.equal(f.confirmCalls, 0);
    f.statements.length = 0;
    assert.equal((await f.service.getProjectLink(f.principals.manager, "event-a", team.id))?.id, request.id);
    assert.equal(f.previewCalls, 1); assert.equal(f.confirmCalls, 0); assert.equal(f.statements.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
    await assert.rejects(f.service.getProjectLink(f.principals.bob, "event-a", team.id), { code: "PROJECT_ACCESS_DENIED", status: 403 });
    const command = { expectedRevision: 1, expectedProjectRevision: 7, expectedTeamRevision: 1, idempotencyKey: "confirm" };
    await assert.rejects(f.service.confirmProjectLink(f.principals.alice, "event-a", team.id, request.id, command), { code: "PROJECT_ACCESS_DENIED", status: 403 });
    const confirmed = await f.service.confirmProjectLink(f.principals.manager, "event-a", team.id, request.id, command);
    assert.equal(confirmed.projectId, "private-project"); assert.equal((await f.service.getProjectLink(f.principals.alice, "event-a", team.id))?.status, "confirmed");
    await f.database.query("UPDATE auth_users SET project_manager=false WHERE id=$1", ["manager"]);
    await assert.rejects(f.service.confirmProjectLink(f.principals.manager, "event-a", team.id, request.id, command), { code: "PROJECT_ACCESS_DENIED", status: 403 });
    assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.revision, 2);
  } finally { await f.engine.close(); }
});

test("without preview GET never calls confirm; confirmation replay uses reentrant authorization and session loss rolls root writes back", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.register("alice"); const team = await f.createTeam();
    const request = await f.service.requestProjectLink(f.principals.alice, "event-a", team.id, { expectedRevision: 1, projectId: "private-project", idempotencyKey: "request" });
    await assert.rejects(f.service.getProjectLink(f.principals.manager, "event-a", team.id), { code: "EVENT_ACCESS_DENIED", status: 403 }); assert.equal(f.confirmCalls, 0);
    const command = { expectedRevision: 1, expectedProjectRevision: 7, expectedTeamRevision: 1, idempotencyKey: "confirm" };
    const revoked = f.principal("manager", async (sql, invocation) => { if (invocation === 3) await sql.query("UPDATE auth_users SET session_active=false WHERE id=$1", ["manager"]); });
    await assert.rejects(f.service.confirmProjectLink(revoked, "event-a", team.id, request.id, command), { code: "UNAUTHENTICATED", status: 401 });
    assert.equal((await f.database.query("SELECT * FROM fixture_root_links")).rowCount, 0); assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.projectId, null);
    assert.equal((await f.service.getProjectLink(f.principals.alice, "event-a", team.id))?.status, "pending");
    const first = await f.service.confirmProjectLink(f.principals.manager, "event-a", team.id, request.id, command);
    assert.deepEqual(await f.service.confirmProjectLink(f.principals.manager, "event-a", team.id, request.id, command), first);
    const count = f.confirmCalls; await f.database.query("UPDATE auth_users SET project_manager=false WHERE id=$1", ["manager"]);
    await assert.rejects(f.service.confirmProjectLink(f.principals.manager, "event-a", team.id, request.id, command), { code: "PROJECT_ACCESS_DENIED", status: 403 }); assert.equal(f.confirmCalls, count + 1);
    assert.equal((await f.database.query("SELECT * FROM fixture_root_links")).rowCount, 1);
  } finally { await f.engine.close(); }
});

test("root manager revoked during confirmation causes the root side effect and roster/link writes to roll back together", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.register("alice"); const team = await f.createTeam();
    const request = await f.service.requestProjectLink(f.principals.alice, "event-a", team.id, { expectedRevision: 1, projectId: "private-project", idempotencyKey: "request" });
    const lostManager = f.principal("manager", async (sql, invocation) => { if (invocation === 3) await sql.query("UPDATE auth_users SET project_manager=false WHERE id=$1", ["manager"]); });
    await assert.rejects(f.service.confirmProjectLink(lostManager, "event-a", team.id, request.id, { expectedRevision: 1, expectedProjectRevision: 7, expectedTeamRevision: 1, idempotencyKey: "revoked-manager" }), { code: "PROJECT_ACCESS_DENIED", status: 403 });
    assert.equal((await f.database.query("SELECT * FROM fixture_root_links")).rowCount, 0);
    assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.projectId, null);
    assert.equal((await f.service.getProjectLink(f.principals.alice, "event-a", team.id))?.status, "pending");
    assert.equal((await f.database.query("SELECT key FROM event_registration_receipts WHERE operation LIKE 'team.project.confirm:%'")).rowCount, 0);
    assert.equal((await f.database.query<{ project_manager: boolean }>("SELECT project_manager FROM auth_users WHERE id=$1", ["manager"])).rows[0].project_manager, true);
  } finally { await f.engine.close(); }
});

test("assigned and mixed suggestions grant no membership; each candidate voluntarily requests and captain accepts", async () => {
  const f = await registrationFixture();
  try {
    const scope = f.scopes.get("event-a")!; f.scopes.set("event-a", { ...scope, teams: { ...scope.teams, mode: "assigned" } });
    await f.publish(); await f.register("alice"); await f.register("bob");
    await assert.rejects(f.createTeam(), { code: "TEAMS_ASSIGNED" });
    const suggestion = await f.service.proposeTeam(f.principals["team-staff"], "event-a", { captainUserId: "alice", memberUserIds: ["bob"], name: "建议队伍", track: "", note: "请各自确认意愿", idempotencyKey: "assigned" });
    assert.equal((await f.database.query("SELECT user_id FROM event_registration_members")).rowCount, 0);
    const team = await f.service.createTeam(f.principals.alice, "event-a", { name: "本人确认建队", introduction: "", track: "", suggestionId: suggestion.id, idempotencyKey: "agree" });
    assert.deepEqual(team.memberUserIds, ["alice"]); assert.equal((await f.service.listTeams(f.principals.bob, "event-a")).ownTeam, null);
    await f.register("carol"); await f.register("dave");
    const another = await f.service.proposeTeam(f.principals["team-staff"], "event-a", { captainUserId: "carol", memberUserIds: ["dave"], name: "另一个建议", track: "", note: "本人确认", idempotencyKey: "another-assigned" });
    const otherTeam = await f.service.createTeam(f.principals.carol, "event-a", { name: "另一支队伍", introduction: "", track: "", suggestionId: another.id, idempotencyKey: "another-agree" });
    await assert.rejects(f.service.requestJoin(f.principals.bob, "event-a", otherTeam.id, { expectedTeamRevision: 1, message: "错误队伍", idempotencyKey: "not-my-assignment" }), { code: "TEAM_SUGGESTION_REQUIRED" });
    assert.equal((await f.service.getTeam(f.database, "event-a", otherTeam.id))?.memberUserIds.length, 1);
    await f.addMember(team.id, "bob"); assert.equal((await f.service.getTeam(f.database, "event-a", team.id))?.memberUserIds.length, 2);
    f.scopes.set("event-b", { ...f.scopes.get("event-b")!, teams: { ...scope.teams, mode: "mixed" } });
    await f.publish("event-b"); await f.register("alice", "event-b"); await f.register("bob", "event-b");
    await f.service.proposeTeam(f.principals.staff, "event-b", { captainUserId: "alice", memberUserIds: ["bob"], name: "另一场建议", track: "", note: "自由选择", idempotencyKey: "mixed" });
    assert.equal((await f.database.query("SELECT user_id FROM event_registration_members WHERE event_id=$1", ["event-b"])).rowCount, 0);
  } finally { await f.engine.close(); }
});

test("assigned membership eligibility checks exact team suggestion beyond the first hundred listed suggestions", async () => {
  const f = await registrationFixture();
  try {
    const event = f.scopes.get("event-a")!; f.scopes.set("event-a", { ...event, teams: { ...event.teams, mode: "assigned" } });
    await f.publish(); await f.register("alice"); await f.register("bob");
    const repository = new PostgresRegistrationRepository(f.database);
    await f.database.transaction(async sql => {
      const store = repository.store(sql); await store.lockEvent("event-a", "org-a");
      for (let index = 1; index <= 101; ++index) await store.saveSuggestion({ id: `suggestion-${String(index).padStart(3, "0")}`, eventId: "event-a", captainUserId: "alice", memberUserIds: ["alice", "bob"], name: "建议队伍", track: "", note: "各自确认意愿", createdByUserId: "team-staff", createdAt: "2026-10-11T03:00:00.000Z", teamId: null });
    });
    const team = await f.service.createTeam(f.principals.alice, "event-a", { name: "第101项建议", introduction: "", track: "", suggestionId: "suggestion-101", idempotencyKey: "last-suggestion" });
    const listed = (await f.service.listTeams(f.principals.bob, "event-a")).suggestions;
    assert.equal(listed.length, 100); assert.equal(listed.some(item => item.id === "suggestion-101"), false);
    const requested = await f.service.requestJoin(f.principals.bob, "event-a", team.id, { expectedTeamRevision: 1, message: "本人确认第101项", idempotencyKey: "join-101" });
    assert.equal(requested.status, "pending"); assert.equal(requested.teamId, team.id);
    assert.deepEqual((await f.service.getTeam(f.database, "event-a", team.id))?.memberUserIds, ["alice"]);
  } finally { await f.engine.close(); }
});

test("official tracks require a configured identity and cannot borrow the other event's track", async () => {
  const f = await registrationFixture();
  try {
    await f.publish(); await f.register("alice");
    await assert.rejects(f.service.createTeam(f.principals.alice, "event-a", { name: "test", introduction: "", track: "AI赛道", idempotencyKey: "unconfigured" }), { code: "TRACKS_NOT_CONFIGURED" });
    const configured = createEventRegistrationService({ database: f.database, events: f.events, projectLinks: { async confirmLink() { throw new Error("Unused"); } }, clock: { now: () => new Date("2026-10-11T03:00:00.000Z") }, ids: { next: () => "official-track-team" },
      tracks: { async getConfiguration(_sql, eventId) { return { configured: true, required: true, revision: 2, options: [{ id: `${eventId}-ai`, title: "AI赛道" }] }; } } });
    await assert.rejects(configured.createTeam(f.principals.alice, "event-a", { name: "test", introduction: "", track: "", idempotencyKey: "required" }), { code: "INVALID_INPUT" });
    await assert.rejects(configured.createTeam(f.principals.alice, "event-a", { name: "test", introduction: "", track: "event-b-ai", idempotencyKey: "cross-track" }), { code: "INVALID_INPUT" });
    assert.equal((await configured.createTeam(f.principals.alice, "event-a", { name: "test", introduction: "", track: "event-a-ai", idempotencyKey: "official" })).track, "event-a-ai");
  } finally { await f.engine.close(); }
});
