import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { applicationInput, configurationOf, eventConfiguration, organizerError as code, organizerFixture } from "./testing.ts";

test("application approval is manual, owner/private scoped, and denies reviewer and own admin", async t => {
  const c = await organizerFixture(t);
  const application = await c.service.createApplication(c.users.ownerA, applicationInput());
  assert.equal(application.status, "pending");
  assert.deepEqual(await c.service.listOwnApplications(c.users.ownerB), []);
  assert.equal((await c.service.listOwnApplications(c.users.ownerA))[0]?.id, application.id);
  assert.deepEqual(await c.service.listOrganizations(c.users.ownerA), []);
  await assert.rejects(c.service.createEvent(c.users.ownerA, application.organizationId, { ...eventConfiguration(), templateKey: "online", expectedOrganizationRevision: 1 }), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.listApplicationsForReview(c.users.reviewer), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.reviewApplication(c.users.reviewer, application.id, { expectedRevision: 1, decision: "approved", note: "不能继承平台审核员权限" }), code("ORGANIZER_FORBIDDEN"));
  const ownAdminApplication = await c.service.createApplication(c.users.administrator, applicationInput("管理员自己的机构"));
  await assert.rejects(c.service.reviewApplication(c.users.administrator, ownAdminApplication.id, { expectedRevision: 1, decision: "approved", note: "自审" }), code("ORGANIZER_SELF_REVIEW"));
  await assert.rejects(c.service.createApplication(c.users.ownerA, { ...applicationInput(), actor: { userId: "administrator", platformRoles: ["admin"] } }), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.service.createApplication(c.users.ownerA, { ...applicationInput(), kind: ["community"] }), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.service.reviewApplication(c.users.administrator, application.id, { expectedRevision: 1, decision: ["approved"], note: "数组不能当审核决定" }), code("ORGANIZER_INPUT_INVALID"));
  const forged = c.principal("ownerA", { actor: { userId: "ownerA", platformRoles: ["admin"] } });
  await assert.rejects(c.service.listApplicationsForReview(forged), code("AUTH_SESSION_INVALID"));
  const rejected = await c.service.reviewApplication(c.users.administrator, application.id, { expectedRevision: 1, decision: "rejected", note: "补充公开活动依据" });
  const resubmitted = await c.service.updateApplication(c.users.ownerA, application.id, { ...applicationInput("补充后的社区"), expectedRevision: rejected.revision });
  assert.equal(resubmitted.status, "pending"); assert.equal(resubmitted.reviewNote, null);
  const approved = await c.service.reviewApplication(c.users.administrator, application.id, { expectedRevision: resubmitted.revision, decision: "approved", note: "完成核查" });
  assert.equal(approved.status, "approved"); assert.equal((await c.service.listStaffGrants(c.users.ownerA, approved.organizationId)).length, 1);
  await assert.rejects(c.service.updateApplication(c.users.ownerA, application.id, { ...applicationInput(), expectedRevision: approved.revision }), code("ORGANIZER_APPLICATION_LOCKED"));
});

test("two organizations and three events enforce organization and event-specific capabilities", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), b = await c.approvedOrganization("ownerB");
  const eventA = await c.createEvent(a.organization.id, a.principal, "甲赛"), eventB = await c.createEvent(a.organization.id, a.principal, "乙赛"), eventC = await c.createEvent(b.organization.id, b.principal, "丙赛");
  await c.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: eventA.eventId, role: "staff", capabilities: ["event_manage", "communication_manage"] });
  await c.service.grantStaff(b.principal, b.organization.id, { expectedOrganizationRevision: b.organization.revision, userId: "staff", eventId: eventC.eventId, role: "staff", capabilities: ["registration_manage"] });
  assert.deepEqual((await c.service.listOrganizationEvents(c.users.staff, a.organization.id)).map(e => e.eventId), [eventA.eventId]);
  assert.deepEqual((await c.service.listCompetitionIdentities(c.users.staff)).map(x => x.event.eventId).sort(), [eventA.eventId, eventC.eventId].sort());
  await assert.rejects(c.service.getManagedEvent(c.users.staff, eventB.eventId), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.getManagedEvent(a.principal, eventC.eventId), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.listStaffGrants(c.users.staff, a.organization.id), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.getManagedEvent(c.users.reviewer, eventA.eventId), code("ORGANIZER_FORBIDDEN"));
  await c.database.transaction(sql => c.service.eventAccess.requireStaff(sql, c.users.staff.actor, eventA.eventId, "event_manage"));
  await assert.rejects(c.database.transaction(sql => c.service.eventAccess.requireStaff(sql, c.users.staff.actor, eventC.eventId, "event_manage")), code("ORGANIZER_FORBIDDEN"));
  await c.database.transaction(sql => c.service.eventAccess.requireStaff(sql, c.users.staff.actor, eventC.eventId, "registration_manage"));
  assert.equal((await c.service.getManagedEvent(c.users.staff, eventC.eventId)).organizationId, b.organization.id);
});

test("cross-organization grants, absent users and arbitrary capabilities leave no partial grant or revision", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), b = await c.approvedOrganization("ownerB"), event = await c.createEvent(b.organization.id, b.principal);
  const before = await c.counts();
  const base = { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: null, role: "staff", capabilities: ["event_manage"] };
  await assert.rejects(c.service.grantStaff(a.principal, a.organization.id, { ...base, eventId: event.eventId }), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.grantStaff(a.principal, a.organization.id, { ...base, userId: "nonexistent" }), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.service.grantStaff(a.principal, a.organization.id, { ...base, capabilities: ["read_private_projects"] }), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.service.grantStaff(a.principal, a.organization.id, { ...base, role: "admin" }), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.service.grantStaff(a.principal, a.organization.id, { ...base, role: ["staff"] }), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.direct.query("INSERT INTO organizer_staff_grants VALUES('forged',$1,$2,'staff','staff',ARRAY['event_manage'],'active',1,'{}')", [a.organization.id, event.eventId]), error => !!error && typeof error === "object" && "code" in error && error.code === "23503");
  assert.deepEqual(await c.counts(), before);
  assert.equal((await c.service.listOrganizations(a.principal))[0]?.revision, a.organization.revision);
});

test("revocation immediately blocks cached staff actors from writes and private publication exports", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal);
  const grant = await c.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: event.eventId, role: "staff", capabilities: ["event_manage", "communication_manage"] });
  assert.equal((await c.service.listPublicationChanges(c.users.staff, event.eventId)).length, 1);
  const cachedActor = c.users.staff.actor;
  await c.service.revokeStaff(a.principal, grant.id, { expectedRevision: grant.revision });
  await assert.rejects(c.database.transaction(sql => c.service.eventAccess.requireStaff(sql, cachedActor, event.eventId, "event_manage")), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.updateEvent(c.users.staff, event.eventId, { ...configurationOf(event), expectedRevision: event.revision, title: "无权修改" }), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.listPublicationHistory(c.users.staff, event.eventId), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.listPublicationChanges(c.users.staff, event.eventId), code("ORGANIZER_FORBIDDEN"));
  assert.deepEqual(await c.service.listCompetitionIdentities(c.users.staff), []);
  assert.equal((await c.service.getPublicCompetition(event.eventId)).title, event.title);
});

test("suspended organizations retain published history but stop operations and access Port", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal);
  await c.service.reviewApplication(c.users.administrator, a.application.id, { expectedRevision: a.application.revision, decision: "suspended", note: "暂停运营并保留历史" });
  assert.equal(await c.database.transaction(sql => c.service.eventAccess.getEvent(sql, event.eventId, { forUpdate: true })), null);
  await assert.rejects(c.database.transaction(sql => c.service.eventAccess.requireStaff(sql, a.principal.actor, event.eventId, "registration_manage")), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.listOrganizationEvents(a.principal, a.organization.id), code("ORGANIZER_FORBIDDEN"));
  assert.deepEqual(await c.service.listCompetitionIdentities(a.principal), []);
  const visible = await c.service.getPublicCompetition(event.eventId);
  assert.equal(visible.availability, "organization_unavailable"); assert.equal(visible.organizationStatus, "suspended");
  assert.equal(visible.rules, event.rules); assert.equal((await c.service.listPublicCompetitions()).length, 1);
  assert.equal((await c.counts()).organizer_event_publications, 1);
});

test("concurrent edits of one revision allow exactly one commit and return latest revision", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.createEvent(a.organization.id, a.principal);
  const before = await c.counts();
  const results = await Promise.allSettled(["甲变更", "乙变更"].map(title => c.service.updateEvent(a.principal, event.eventId, { ...configurationOf(event), expectedRevision: event.revision, title })));
  const successful = results.filter(r => r.status === "fulfilled"), failed = results.filter(r => r.status === "rejected");
  assert.equal(successful.length, 1); assert.equal(failed.length, 1);
  const failure = failed[0]; assert.equal(failure?.status, "rejected");
  if (failure?.status === "rejected") { assert.equal(code("ORGANIZER_REVISION_CONFLICT")(failure.reason), true); assert.equal((failure.reason as DomainError).latestRevision, 2); }
  const saved = await c.service.getManagedEvent(a.principal, event.eventId);
  assert.equal(saved.revision, 2); assert.ok(["甲变更", "乙变更"].includes(saved.title));
  assert.equal((await c.counts()).organizer_audit_events, before.organizer_audit_events! + 1);
});

test("publication snapshots are immutable and unpublished edits never enter public or Port rules", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), draft = await c.createEvent(a.organization.id, a.principal);
  assert.deepEqual(await c.service.listPublicCompetitions(), []);
  await assert.rejects(c.service.getPublicCompetition(draft.eventId), code("ORGANIZER_NOT_FOUND"));
  const first = await c.publish(draft, a.principal);
  const edited = await c.service.updateEvent(a.principal, first.eventId, { ...configurationOf(first), expectedRevision: first.revision, title: "尚未发布的新标题", rules: "尚未发布的新规则", registration: { reviewRequired: true, capacity: 3 } });
  const publicBefore = await c.service.getPublicCompetition(first.eventId);
  assert.equal(publicBefore.title, first.title); assert.equal(publicBefore.rules, first.rules);
  const effective = await c.database.transaction(sql => c.service.eventAccess.getEvent(sql, first.eventId));
  assert.equal(effective?.title, first.title); assert.deepEqual(effective?.registration, first.registration); assert.equal(effective?.revision, edited.revision);
  const preview = await c.service.previewEvent(a.principal, first.eventId);
  assert.equal(preview.publicProjection.title, edited.title); assert.ok(preview.changedFields.includes("rules"));
  const second = await c.service.publishEvent(a.principal, first.eventId, { expectedRevision: edited.revision, changeSummary: "调整审核额度与公开规则，请重新核对" });
  assert.equal(second.publishedRevision, 2); assert.equal((await c.service.getPublicCompetition(first.eventId)).rules, edited.rules);
  const history = await c.service.listPublicationHistory(a.principal, first.eventId);
  assert.deepEqual(history.map(v => v.version), [2, 1]); assert.equal(history[1]?.snapshot.rules, first.rules);
  for (const statement of [
    "UPDATE organizer_event_publications SET document='{}' WHERE version=1",
    "DELETE FROM organizer_event_publications WHERE version=1",
    "UPDATE organizer_publication_changes SET document='{}' WHERE version=1",
    "DELETE FROM organizer_publication_changes WHERE version=1",
    "UPDATE organizer_audit_events SET action='rewritten'",
    "DELETE FROM organizer_audit_events",
  ]) await assert.rejects(c.direct.query(statement), error => !!error && typeof error === "object" && "code" in error && error.code === "23514");
  assert.deepEqual(await c.service.listPublicationHistory(a.principal, first.eventId), history);
});

test("public competition projection omits private contacts, evidence, responsible user and grant IDs", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal);
  const grant = (await c.service.listStaffGrants(a.principal, a.organization.id))[0]!;
  const publicEvent = await c.service.getPublicCompetition(event.eventId);
  const serialized = JSON.stringify(publicEvent);
  for (const secret of ["private-contact@organizer.org", "私人联系人", "PRIVATE_EVIDENCE_TEXT", "https://organizer.org/evidence", "ownerA", grant.id]) assert.equal(serialized.includes(secret), false);
  for (const key of ["contactName", "contactEmail", "evidenceText", "evidenceUrls", "ownerUserId", "responsibleUserId", "publishedBy", "registration", "teams", "linkedEventId"]) assert.equal(Object.hasOwn(publicEvent, key), false);
  assert.deepEqual(await c.service.listPublicCompetitions(), [publicEvent]);
});

test("published module closure is rejected with history and original persisted draft intact", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal), before = await c.counts();
  await assert.rejects(c.service.updateEvent(a.principal, event.eventId, { ...configurationOf(event), expectedRevision: event.revision, modules: { ...event.modules, schedule: false } }), code("ORGANIZER_MODULE_IN_USE"));
  assert.deepEqual(await c.service.getManagedEvent(a.principal, event.eventId), event); assert.deepEqual(await c.counts(), before);
  const draft = await c.createEvent(a.organization.id, a.principal, "未发布练习");
  const updated = await c.service.updateEvent(a.principal, draft.eventId, { ...configurationOf(draft), expectedRevision: draft.revision, modules: { registration: false, teams: false, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false } });
  assert.equal(updated.modules.registration, false);
});

test("input and revision failures preserve original values, audits and publication facts", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.createEvent(a.organization.id, a.principal), before = await c.counts();
  const base = { ...configurationOf(event), expectedRevision: event.revision };
  for (const input of [
    { ...base, title: "" }, { ...base, startsAt: "2026-02-30T02:00:00Z" }, { ...base, timezone: "Not/AZone" },
    { ...base, endsAt: event.startsAt }, { ...base, modules: { ...event.modules, executeScript: true } },
    { ...base, linkedEventId: "guessed-m03" }, { ...base, actor: { userId: "administrator" } },
    { ...base, teams: { ...event.teams, minSize: 6, maxSize: 5 } },
    { ...base, teams: { ...event.teams, mode: ["free"] } },
  ]) await assert.rejects(c.service.updateEvent(a.principal, event.eventId, input), code("ORGANIZER_INPUT_INVALID"));
  await assert.rejects(c.service.updateEvent(a.principal, event.eventId, { ...base, expectedRevision: 99 }), code("ORGANIZER_REVISION_CONFLICT"));
  assert.deepEqual(await c.service.getManagedEvent(a.principal, event.eventId), event); assert.deepEqual(await c.counts(), before);
});

test("same transaction guards run before and after work and late session failure rolls writes back", async t => {
  const c = await organizerFixture(t), before = await c.counts();
  await assert.rejects(c.service.createApplication(c.principal("ownerA", { failAt: 1 }), applicationInput()), code("AUTH_SESSION_INVALID"));
  assert.deepEqual(await c.counts(), before);
  const secondGuard = c.principal("ownerA", { failAt: 2 });
  await assert.rejects(c.service.createApplication(secondGuard, applicationInput()), code("AUTH_SESSION_INVALID"));
  assert.deepEqual(await c.counts(), before); assert.equal(c.guardCalls.get("ownerA"), 3);
  const a = await c.approvedOrganization(), event = await c.createEvent(a.organization.id, a.principal), checkpoint = await c.counts();
  await assert.rejects(c.service.publishEvent(c.principal("ownerA", { failAt: 2 }), event.eventId, { expectedRevision: event.revision, changeSummary: "会话在提交前失效" }), code("AUTH_SESSION_INVALID"));
  assert.deepEqual(await c.service.getManagedEvent(a.principal, event.eventId), event); assert.deepEqual(await c.counts(), checkpoint);
  await c.direct.query("UPDATE organizer_test_sessions SET active=false WHERE user_id='ownerA'");
  await assert.rejects(c.service.getManagedEvent(a.principal, event.eventId), code("AUTH_SESSION_INVALID"));
  await assert.rejects(c.service.updateEvent(a.principal, event.eventId, { ...configurationOf(event), expectedRevision: event.revision }), code("AUTH_SESSION_INVALID"));
  assert.deepEqual(await c.counts(), checkpoint);
});

test("last organization admin cannot be revoked; replacement retains management and old admin loses it", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), ownerGrant = (await c.service.listStaffGrants(a.principal, a.organization.id))[0]!;
  await assert.rejects(c.service.revokeStaff(a.principal, ownerGrant.id, { expectedRevision: ownerGrant.revision }), code("ORGANIZER_LAST_ADMIN"));
  await c.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: null, role: "organization_admin", capabilities: [] });
  await c.service.revokeStaff(c.users.staff, ownerGrant.id, { expectedRevision: ownerGrant.revision });
  await assert.rejects(c.service.listStaffGrants(a.principal, a.organization.id), code("ORGANIZER_FORBIDDEN"));
  const replacement = (await c.service.listStaffGrants(c.users.staff, a.organization.id)).find(grant => grant.userId === "staff")!;
  assert.equal(replacement.capabilities.length, 7);
  await assert.rejects(c.service.revokeStaff(c.users.staff, replacement.id, { expectedRevision: replacement.revision }), code("ORGANIZER_LAST_ADMIN"));
});

test("templates provide independent defaults and incomplete publication exposes actionable blockers", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), defaults = c.service.listTemplates();
  assert.deepEqual(defaults.map(template => template.key), ["online", "onsite", "practice"]);
  (defaults[0]!.modules as { registration: boolean }).registration = false;
  assert.equal(c.service.listTemplates()[0]!.modules.registration, true);
  const event = await c.service.createEvent(a.principal, a.organization.id, { title: "使用默认值", templateKey: "online", expectedOrganizationRevision: a.organization.revision, startsAt: "2026-10-20T10:00:00+08:00", endsAt: "2026-10-22T18:00:00+08:00" });
  assert.equal(event.timezone, "Asia/Shanghai"); assert.equal(event.teams.mode, "free"); assert.equal(event.registration.reviewRequired, false); assert.equal(event.startsAt, "2026-10-20T02:00:00.000Z");
  const preview = await c.service.previewEvent(a.principal, event.eventId);
  assert.ok(preview.publicationBlockers.includes("明确报名开始和截止时间")); assert.ok(preview.publicationBlockers.includes("明确作品提交截止时间"));
  await assert.rejects(c.service.publishEvent(a.principal, event.eventId, { expectedRevision: event.revision, changeSummary: "材料不全" }), code("ORGANIZER_PUBLICATION_INCOMPLETE"));
  assert.deepEqual(await c.service.listPublicCompetitions(), []);
});

test("archiving blocks Port writes while published archive remains available as history", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), event = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal);
  const archived = await c.service.archiveEvent(a.principal, event.eventId, { expectedRevision: event.revision });
  assert.equal(archived.status, "archived");
  await assert.rejects(c.database.transaction(sql => c.service.eventAccess.requireStaff(sql, a.principal.actor, event.eventId, "event_manage")), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.updateEvent(a.principal, event.eventId, { ...configurationOf(archived), expectedRevision: archived.revision }), code("ORGANIZER_FORBIDDEN"));
  assert.equal((await c.database.transaction(sql => c.service.eventAccess.getEvent(sql, event.eventId)))?.status, "archived");
  assert.equal((await c.service.getPublicCompetition(event.eventId)).status, "archived");
  assert.equal((await c.service.listPublicationHistory(a.principal, event.eventId)).length, 1);
});

test("reapproval after suspension and resubmission neither duplicates admin grants nor revives a revoked owner", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), ownerGrant = (await c.service.listStaffGrants(a.principal, a.organization.id))[0]!;
  await c.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: null, role: "organization_admin", capabilities: [] });
  await c.service.revokeStaff(c.users.staff, ownerGrant.id, { expectedRevision: ownerGrant.revision });
  const suspended = await c.service.reviewApplication(c.users.administrator, a.application.id, { expectedRevision: a.application.revision, decision: "suspended", note: "暂停" });
  const rejected = await c.service.reviewApplication(c.users.administrator, a.application.id, { expectedRevision: suspended.revision, decision: "rejected", note: "要求重新补充依据" });
  const resubmitted = await c.service.updateApplication(a.principal, a.application.id, { ...applicationInput(), expectedRevision: rejected.revision });
  await c.service.reviewApplication(c.users.administrator, a.application.id, { expectedRevision: resubmitted.revision, decision: "approved", note: "恢复机构状态，不恢复旧授权" });
  assert.deepEqual(await c.service.listOrganizations(a.principal), []);
  const grants = await c.service.listStaffGrants(c.users.staff, a.organization.id);
  assert.equal(grants.length, 2); assert.equal(grants.filter(grant => grant.status === "active").length, 1);
  assert.equal(grants.find(grant => grant.userId === "ownerA")?.status, "revoked");
});

test("responsible handoff requires current organization admin and current event permission before republishing", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization(), first = await c.publish(await c.createEvent(a.organization.id, a.principal), a.principal), ownerGrant = (await c.service.listStaffGrants(a.principal, a.organization.id))[0]!;
  await c.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: null, role: "organization_admin", capabilities: [] });
  await c.service.revokeStaff(c.users.staff, ownerGrant.id, { expectedRevision: ownerGrant.revision });
  const edited = await c.service.updateEvent(c.users.staff, first.eventId, { ...configurationOf(first), expectedRevision: first.revision, rules: "交接后待发布的新规则" });
  await assert.rejects(c.service.publishEvent(c.users.staff, first.eventId, { expectedRevision: edited.revision, changeSummary: "原负责人已撤权" }), code("ORGANIZER_RESPONSIBLE_UNAVAILABLE"));
  await assert.rejects(c.service.changeEventResponsible(a.principal, first.eventId, { expectedRevision: edited.revision, responsibleUserId: "staff" }), code("ORGANIZER_FORBIDDEN"));
  await assert.rejects(c.service.changeEventResponsible(c.users.staff, first.eventId, { expectedRevision: edited.revision, responsibleUserId: "ownerA" }), code("ORGANIZER_RESPONSIBLE_UNAVAILABLE"));
  const transferred = await c.service.changeEventResponsible(c.users.staff, first.eventId, { expectedRevision: edited.revision, responsibleUserId: "staff" });
  assert.equal(transferred.responsibleUserId, "staff"); assert.equal(transferred.revision, edited.revision + 1);
  const second = await c.service.publishEvent(c.users.staff, first.eventId, { expectedRevision: transferred.revision, changeSummary: "负责人已明确交接，公开新版规则" });
  assert.equal(second.publishedRevision, 2); assert.equal((await c.service.getPublicCompetition(first.eventId)).rules, edited.rules);
});

test("participant services require registration while schedule-only and all-disabled drafts remain valid", async t => {
  const c = await organizerFixture(t), a = await c.approvedOrganization();
  const modules = { registration: false, teams: false, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false };
  const input = { ...eventConfiguration(), templateKey: "onsite", expectedOrganizationRevision: a.organization.revision, modules };
  const before = await c.counts();
  for (const key of ["icebreaking", "accommodation", "mealVouchers"] as const) {
    await assert.rejects(c.service.createEvent(a.principal, a.organization.id, { ...input, modules: { ...modules, [key]: true } }), code("ORGANIZER_INPUT_INVALID"));
  }
  assert.deepEqual(await c.counts(), before);
  const noModules = await c.service.createEvent(a.principal, a.organization.id, input);
  assert.deepEqual(noModules.modules, modules);
  const scheduleOnly = await c.service.createEvent(a.principal, a.organization.id, { ...input, title: "仅公开行程", modules: { ...modules, schedule: true } });
  assert.equal(scheduleOnly.modules.schedule, true); assert.equal(scheduleOnly.modules.registration, false);
});
