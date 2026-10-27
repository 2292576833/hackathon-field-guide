import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { EVENT_STAFF_CAPABILITIES } from "../../shared/organizer-contracts.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { createOrganizerHttpHandlers, organizerHttpRoute } from "./handlers.ts";
import type { OrganizerHttpRoute } from "./handlers.ts";
import { hashInvitationToken, invitationExpiresAt, isInvitationToken } from "./invitations.ts";
import { TEST_EMAILS, accountEmailPort, organizerError, organizerFixture } from "./testing.ts";
import type { OrganizerTestFixture } from "./testing.ts";

const ORGANIZER = { role: "staff", capabilities: ["event_manage"] } as const;
/** 生成邀请的唯一入口：默认机构范围 staff/event_manage，用例只覆盖需要变化的字段。 */
function invite(f: OrganizerTestFixture, organizationId: string, overrides: Record<string, unknown> = {}) {
  return f.service.createStaffInvitation(f.users.ownerA, organizationId, { ...ORGANIZER, ...overrides });
}
const read = (value: Response) => value.json() as Promise<{ data?: unknown; requestId: string; error?: { code: string; message: string } }>;
const request = (method = "GET", body?: unknown) => new Request("https://organizer.local/api/v1/test", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});
const expiresAt = (f: OrganizerTestFixture) => f.now().toISOString();

test("邀请默认 7 天、上限 30 天，只存 sha256，原文 token 带格式且只在创建响应出现", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  assert.equal(created.invitation.status, "open");
  assert.equal(created.invitation.claimable, true);
  assert.equal(created.invitation.expiresAt, invitationExpiresAt(expiresAt(f), 7));
  assert.equal(isInvitationToken(created.token), true);
  assert.equal(created.token.length, 43);
  assert.equal(Object.hasOwn(created.invitation, "token"), false);
  assert.equal(Object.hasOwn(created.invitation, "tokenHash"), false);
  const row = await f.direct.query<{ token_hash: string; status: string }>("SELECT token_hash,status FROM organizer_staff_invitations WHERE id=$1", [created.invitation.id]);
  assert.equal(row.rows[0]!.token_hash, hashInvitationToken(created.token));
  assert.notEqual(row.rows[0]!.token_hash, created.token);

  const custom = await invite(f, a.organization.id, { expiresInDays: 30 });
  assert.equal(custom.invitation.expiresAt, invitationExpiresAt(expiresAt(f), 30));
  for (const expiresInDays of [0, 31, 1.5, "7", null]) {
    await assert.rejects(invite(f, a.organization.id, { expiresInDays }), organizerError("ORGANIZER_INPUT_INVALID"));
  }
  assert.equal((await f.counts()).organizer_staff_invitations, 2);
});

test("邀请输入只接受既有能力枚举、既有角色与合法邮箱，且不允许客户端指定领取人", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const invalid = [
    { role: "admin" },
    { role: "staff", capabilities: [] },
    { role: "staff", capabilities: ["read_private_projects"] },
    { role: "staff", capabilities: ["event_manage", "event_manage"] },
    { role: "staff", capabilities: ["event_manage"], boundEmail: "not-an-email" },
    { role: "organization_admin", capabilities: [], eventId: "event-x" },
    { role: "staff", capabilities: ["event_manage"], userId: "ownerA" },
    { role: "staff", capabilities: ["event_manage"], token: "forged" },
  ];
  for (const input of invalid) await assert.rejects(f.service.createStaffInvitation(f.users.ownerA, a.organization.id, input), organizerError("ORGANIZER_INPUT_INVALID"));
  assert.equal((await f.counts()).organizer_staff_invitations, 0);
});

test("organization_admin 邀请只能由当前机构管理员创建；其他角色与跨机构一律拒绝", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization(), b = await f.approvedOrganization("ownerB");
  const event = await f.createEvent(a.organization.id, a.principal);
  await f.service.grantStaff(a.principal, a.organization.id, { expectedOrganizationRevision: a.organization.revision, userId: "staff", eventId: event.eventId, role: "staff", capabilities: ["event_manage"] });
  const adminInvite = { role: "organization_admin", capabilities: [], eventId: null };
  for (const caller of [f.users.staff, f.users.ownerB, f.users.administrator, f.users.reviewer]) {
    await assert.rejects(f.service.createStaffInvitation(caller, a.organization.id, adminInvite), organizerError("ORGANIZER_FORBIDDEN"));
  }
  await assert.rejects(f.service.createStaffInvitation(f.users.staff, a.organization.id, { role: "staff", capabilities: ["event_manage"] }), organizerError("ORGANIZER_FORBIDDEN"));
  // 赛事范围邀请不能引用别机构的比赛。
  await assert.rejects(invite(f, a.organization.id, { eventId: (await f.createEvent(b.organization.id, b.principal)).eventId }), organizerError("ORGANIZER_FORBIDDEN"));
  assert.equal((await f.counts()).organizer_staff_invitations, 0);

  const created = await f.service.createStaffInvitation(f.users.ownerA, a.organization.id, adminInvite);
  assert.equal(created.invitation.role, "organization_admin");
  assert.equal(created.invitation.eventId, null);
  assert.deepEqual([...created.invitation.capabilities].sort(), [...EVENT_STAFF_CAPABILITIES].sort());
});

test("领取写入恰好一条 StaffGrant、沿用既有能力枚举，机构 revision 只推进一次且无其他事实变化", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const event = await f.createEvent(a.organization.id, a.principal);
  const created = await invite(f, a.organization.id, { capabilities: ["registration_manage", "teams_manage"], eventId: event.eventId });
  const organizationBefore = (await f.service.listOrganizations(f.users.ownerA)).find(value => value.id === a.organization.id)!;
  const before = await f.counts();

  const result = await f.service.claimStaffInvitation(f.users.staff, created.token);
  assert.equal(result.grant.userId, "staff");
  assert.equal(result.grant.organizationId, a.organization.id);
  assert.equal(result.grant.eventId, event.eventId);
  assert.equal(result.grant.role, "staff");
  assert.deepEqual([...result.grant.capabilities].sort(), ["registration_manage", "teams_manage"]);
  assert.deepEqual(result.invitation.capabilities.map(value => value).sort(), ["registration_manage", "teams_manage"]);
  assert.equal(result.invitation.status, "claimed");

  const after = await f.counts();
  assert.equal(after.organizer_staff_grants! - before.organizer_staff_grants!, 1);
  assert.equal(after.organizer_staff_invitations, before.organizer_staff_invitations);
  assert.equal(after.organizer_hosted_events, before.organizer_hosted_events);
  assert.equal(after.organizer_organizations, before.organizer_organizations);
  assert.equal(after.organizer_applications, before.organizer_applications);
  assert.equal(after.organizer_event_publications, before.organizer_event_publications);
  assert.equal(after.organizer_publication_changes, before.organizer_publication_changes);
  assert.equal(after.organizer_claim_requests, before.organizer_claim_requests);
  assert.equal(after.organizer_event_profiles, before.organizer_event_profiles);
  const rows = await f.direct.query<{ count: number }>("SELECT count(*)::integer AS count FROM organizer_staff_grants WHERE user_id='staff'");
  assert.equal(rows.rows[0]!.count, 1);

  const organizationAfter = (await f.service.listOrganizations(f.users.staff)).find(value => value.id === a.organization.id)!;
  assert.equal(organizationAfter.revision, organizationBefore.revision + 1);
  assert.equal(organizationAfter.status, organizationBefore.status);
  assert.equal(organizationAfter.ownerUserId, organizationBefore.ownerUserId);
  assert.equal(organizationAfter.name, organizationBefore.name);
  assert.equal(organizationAfter.kind, organizationBefore.kind);
  assert.equal(organizationAfter.createdAt, organizationBefore.createdAt);
});

test("单次使用：第二次领取明确失败，且不再写第二条 grant；已领取行保留领取人与时间", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  await f.service.claimStaffInvitation(f.users.staff, created.token);
  const grants = (await f.counts()).organizer_staff_grants;
  await assert.rejects(f.service.claimStaffInvitation(f.users.staff, created.token), organizerError("ORGANIZER_INVITATION_CLAIMED"));
  await assert.rejects(f.service.claimStaffInvitation(f.users.outsider, created.token), organizerError("ORGANIZER_INVITATION_CLAIMED"));
  assert.equal((await f.counts()).organizer_staff_grants, grants);
  const row = await f.direct.query<{ status: string; claimed_by_user_id: string | null; claimed_at: string | null }>("SELECT status,claimed_by_user_id,claimed_at FROM organizer_staff_invitations WHERE id=$1", [created.invitation.id]);
  assert.equal(row.rows[0]!.status, "claimed");
  assert.equal(row.rows[0]!.claimed_by_user_id, "staff");
  assert.ok(row.rows[0]!.claimed_at);
});

test("有效期：期内可领，过期后明确失败且不写任何 grant", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const live = await invite(f, a.organization.id, { expiresInDays: 1 });
  await f.advanceDays(0.5);
  const claimed = await f.service.claimStaffInvitation(f.users.staff, live.token);
  assert.equal(claimed.invitation.status, "claimed");

  const stale = await invite(f, a.organization.id, { expiresInDays: 1, eventId: null, capabilities: ["communication_manage"] });
  const grants = (await f.counts()).organizer_staff_grants;
  f.advanceDays(1);
  await assert.rejects(f.service.claimStaffInvitation(f.users.outsider, stale.token),
    (error: unknown) => error instanceof DomainError && error.code === "ORGANIZER_INVITATION_EXPIRED" && error.status === 410);
  assert.equal((await f.counts()).organizer_staff_grants, grants);
  const preview = await f.service.previewStaffInvitation(f.users.outsider, stale.token);
  assert.equal(preview.status, "expired");
  assert.equal(preview.claimable, false);
  await assert.rejects(f.service.revokeStaffInvitation(f.users.ownerA, stale.invitation.id, { expectedRevision: stale.invitation.revision }), organizerError("ORGANIZER_INVITATION_EXPIRED"));
});

test("撤销后不可领；重复撤销、版本冲突与非管理员撤销都明确报错", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  const baselineGrants = (await f.counts()).organizer_staff_grants;
  await assert.rejects(f.service.revokeStaffInvitation(f.users.staff, created.invitation.id, { expectedRevision: created.invitation.revision }), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.revokeStaffInvitation(f.users.ownerA, created.invitation.id, { expectedRevision: created.invitation.revision + 5 }), organizerError("ORGANIZER_REVISION_CONFLICT"));
  await assert.rejects(f.service.revokeStaffInvitation(f.users.ownerA, created.invitation.id, { expectedRevision: created.invitation.revision, extra: true }), organizerError("ORGANIZER_INPUT_INVALID"));
  const revoked = await f.service.revokeStaffInvitation(f.users.ownerA, created.invitation.id, { expectedRevision: created.invitation.revision });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedByUserId, "ownerA");
  assert.equal(revoked.claimable, false);
  await assert.rejects(f.service.claimStaffInvitation(f.users.staff, created.token), organizerError("ORGANIZER_INVITATION_REVOKED"));
  await assert.rejects(f.service.revokeStaffInvitation(f.users.ownerA, created.invitation.id, { expectedRevision: revoked.revision }), organizerError("ORGANIZER_INVITATION_REVOKED"));
  assert.equal((await f.counts()).organizer_staff_grants, baselineGrants);
});

test("未验证邮箱不能领取；绑定邮箱不一致明确拒绝；两者都不留 grant 且邀请保持 open", async t => {
  const f = await organizerFixture(t, { accountEmails: accountEmailPort({ staff: null, ownerA: TEST_EMAILS.ownerA }).port });
  const a = await f.approvedOrganization();
  const baselineGrants = (await f.counts()).organizer_staff_grants;
  const unverified = await invite(f, a.organization.id);
  await assert.rejects(f.service.claimStaffInvitation(f.users.staff, unverified.token), organizerError("ORGANIZER_INVITATION_EMAIL_UNVERIFIED"));
  assert.equal((await f.counts()).organizer_staff_grants, baselineGrants);
  assert.equal((await f.service.previewStaffInvitation(f.users.staff, unverified.token)).status, "open");

  // 绑定的是另一个人的邮箱：ownerA 即使已登录且已验证邮箱，也必须被明确拒绝。
  const bound = await invite(f, a.organization.id, { boundEmail: "someone-else@example.test" });
  assert.equal(bound.invitation.emailBound, true);
  assert.notEqual(bound.invitation.boundEmailMasked, TEST_EMAILS.ownerA);
  assert.ok(bound.invitation.boundEmailMasked!.includes("@"));
  await assert.rejects(f.service.claimStaffInvitation(f.users.ownerA, bound.token), organizerError("ORGANIZER_INVITATION_EMAIL_MISMATCH"));
  assert.equal((await f.counts()).organizer_staff_grants, baselineGrants);
  assert.equal((await f.service.previewStaffInvitation(f.users.ownerA, bound.token)).status, "open");

  // 大小写不同不改变结论；邮箱一致时领取成功（ownerB 在本机构还没有任何 grant）。
  const matched = await invite(f, a.organization.id, { boundEmail: TEST_EMAILS.ownerB.toUpperCase() });
  const claimed = await f.service.claimStaffInvitation(f.users.ownerB, matched.token);
  assert.equal(claimed.grant.userId, "ownerB");
});

test("根未接入账号邮箱 Port 时领取失败关闭（503），绝不静默放行", async t => {
  const f = await organizerFixture(t, { accountEmails: null });
  const a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  const baselineGrants = (await f.counts()).organizer_staff_grants;
  await assert.rejects(f.service.claimStaffInvitation(f.users.staff, created.token),
    (error: unknown) => error instanceof DomainError && error.code === "ORGANIZER_INVITATION_UNAVAILABLE" && error.status === 503);
  assert.equal((await f.counts()).organizer_staff_grants, baselineGrants);
});

test("未领取的邀请不产生任何权限：邀请写的是意图，权限仍只由既有 StaffGrant 判定", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const event = await f.createEvent(a.organization.id, a.principal);
  const created = await invite(f, a.organization.id, { eventId: event.eventId });
  await assert.rejects(f.service.getManagedEvent(f.users.staff, event.eventId), organizerError("ORGANIZER_FORBIDDEN"));
  await assert.rejects(f.service.listPublicationChanges(f.users.staff, event.eventId), organizerError("ORGANIZER_FORBIDDEN"));
  assert.deepEqual(await f.service.listCompetitionIdentities(f.users.staff), []);
  await f.service.claimStaffInvitation(f.users.staff, created.token);
  assert.equal((await f.service.getManagedEvent(f.users.staff, event.eventId)).eventId, event.eventId);
  assert.deepEqual((await f.service.listCompetitionIdentities(f.users.staff)).map(value => value.event.eventId), [event.eventId]);
});

test("机构管理员邀请领取后计入既有最后一名管理员保护，且不放松任何既有规则", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const ownerGrant = (await f.service.listStaffGrants(a.principal, a.organization.id)).find(value => value.userId === "ownerA")!;
  await assert.rejects(f.service.revokeStaff(f.users.ownerA, ownerGrant.id, { expectedRevision: ownerGrant.revision }), organizerError("ORGANIZER_LAST_ADMIN"));

  const created = await invite(f, a.organization.id, { role: "organization_admin", capabilities: [], eventId: null, boundEmail: TEST_EMAILS.staff });
  const claimed = await f.service.claimStaffInvitation(f.users.staff, created.token);
  assert.equal(claimed.grant.role, "organization_admin");
  // 现在有两位机构管理员，撤掉原管理员被既有规则允许（邀请没有绕过、也没有制造例外）。
  await f.service.revokeStaff(f.users.ownerA, ownerGrant.id, { expectedRevision: ownerGrant.revision });
  const remaining = (await f.service.listStaffGrants(f.users.staff, a.organization.id)).filter(value => value.role === "organization_admin" && value.status === "active");
  assert.equal(remaining.length, 1);
  await assert.rejects(f.service.revokeStaff(f.users.staff, remaining[0]!.id, { expectedRevision: remaining[0]!.revision }), organizerError("ORGANIZER_LAST_ADMIN"));
});

test("创建/领取/撤销各写一条既有不可变审计，action 可核对", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const claimed = await invite(f, a.organization.id);
  const revoked = await invite(f, a.organization.id, { capabilities: ["communication_manage"] });
  await f.service.claimStaffInvitation(f.users.staff, claimed.token);
  const current = await f.service.listStaffInvitations(f.users.ownerA, a.organization.id);
  const target = current.find(value => value.id === revoked.invitation.id)!;
  await f.service.revokeStaffInvitation(f.users.ownerA, revoked.invitation.id, { expectedRevision: target.revision });
  const audits = await f.direct.query<{ action: string; count: number }>("SELECT action,count(*)::integer AS count FROM organizer_audit_events WHERE action LIKE 'staff_invitation_%' GROUP BY action ORDER BY action");
  assert.deepEqual(audits.rows, [
    { action: "staff_invitation_claimed", count: 1 },
    { action: "staff_invitation_created", count: 2 },
    { action: "staff_invitation_revoked", count: 1 },
  ]);
  // 审计不可改写（既有 trigger）。
  await assert.rejects(f.direct.query("UPDATE organizer_audit_events SET action='x' WHERE action='staff_invitation_created'"), error => !!error && typeof error === "object" && "code" in error && error.code === "23514");
});

test("列表、预览、领取响应都不含 token 与 tokenHash", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  const hash = hashInvitationToken(created.token);
  const list = await f.service.listStaffInvitations(f.users.ownerA, a.organization.id);
  assert.equal(list.length, 1);
  for (const value of list) {
    assert.equal(Object.hasOwn(value, "token"), false);
    assert.equal(Object.hasOwn(value, "tokenHash"), false);
  }
  assert.equal(JSON.stringify(list).includes(created.token), false);
  assert.equal(JSON.stringify(list).includes(hash), false);
  const preview = await f.service.previewStaffInvitation(f.users.staff, created.token);
  assert.equal(JSON.stringify(preview).includes(created.token), false);
  assert.equal(JSON.stringify(preview).includes(hash), false);
  assert.equal(Object.hasOwn(preview, "createdByUserId"), false);
  assert.equal(Object.hasOwn(preview, "note"), false);
  const claimed = await f.service.claimStaffInvitation(f.users.staff, created.token);
  assert.equal(JSON.stringify(claimed).includes(created.token), false);
  assert.equal(JSON.stringify(claimed).includes(hash), false);
  assert.equal(JSON.stringify(claimed).includes("tokenHash"), false);
});

test("会话在写 grant 前失效时，邀请保持 open 且不留下任何授权", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  const baselineGrants = (await f.counts()).organizer_staff_grants;
  await assert.rejects(f.service.claimStaffInvitation(f.principal("staff", { failAt: 2 }), created.token), organizerError("AUTH_SESSION_INVALID"));
  assert.equal((await f.counts()).organizer_staff_grants, baselineGrants);
  const row = await f.direct.query<{ status: string }>("SELECT status FROM organizer_staff_invitations WHERE id=$1", [created.invitation.id]);
  assert.equal(row.rows[0]!.status, "open");
});

test("未知/非法 token 与不存在的邀请都按未找到处理，不泄露存在性", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  await assert.rejects(f.service.previewStaffInvitation(f.users.staff, "not-a-token"), organizerError("ORGANIZER_NOT_FOUND"));
  await assert.rejects(f.service.claimStaffInvitation(f.users.staff, "x".repeat(43)), organizerError("ORGANIZER_NOT_FOUND"));
  const altered = created.token.slice(0, -1) + (created.token.endsWith("A") ? "B" : "A");
  await assert.rejects(f.service.previewStaffInvitation(f.users.staff, altered), organizerError("ORGANIZER_NOT_FOUND"));
});

test("route selector recognizes invitation paths exactly and rejects lookalikes", () => {
  const cases: readonly [string, OrganizerHttpRoute][] = [
    ["organizer/organizations/o/staff-invitations", { kind: "staffInvitations", organizationId: "o" }],
    ["organizer/staff-invitations/i/revoke", { kind: "revokeInvitation", invitationId: "i" }],
    ["my/staff-invitations/token", { kind: "myInvitation", token: "token" }],
    ["my/staff-invitations/token/claim", { kind: "claimInvitation", token: "token" }],
  ];
  for (const [path, expected] of cases) assert.deepEqual(organizerHttpRoute(path.split("/")), expected);
  for (const path of ["organizer/staff-invitations/i", "my/staff-invitations", "my/staff-invitations/t/unknown", "organizer/organizations/o/staff-invitations/x", "my/staff-grants/t"]) {
    assert.equal(organizerHttpRoute(path.split("/")), null);
  }
});

test("HTTP：创建返回一次 token，列表脱敏，领取页与领取走真实 principal，方法不匹配 405", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  let actor: OrganizerPrincipal = f.users.ownerA;
  const handler = createOrganizerHttpHandlers({ service: f.service, authenticate: async () => actor, authorizeMutation: async () => {}, requestId: () => "http-invitation" });

  const createdResponse = await handler.handle(request("POST", POLICY()), { kind: "staffInvitations", organizationId: a.organization.id });
  assert.equal(createdResponse.status, 200);
  const created = (await read(createdResponse)).data as { invitation: { id: string; status: string }; token: string };
  assert.equal(created.invitation.status, "open");
  assert.equal(isInvitationToken(created.token), true);

  const listResponse = await handler.handle(request(), { kind: "staffInvitations", organizationId: a.organization.id });
  const listBody = JSON.stringify(await read(listResponse));
  assert.equal(listBody.includes(created.token), false);
  assert.equal(listBody.includes(hashInvitationToken(created.token)), false);
  assert.equal(listBody.includes("tokenHash"), false);

  // 领取页：任意已登录账号可读，响应不含 token。
  actor = f.users.staff;
  const previewResponse = await handler.handle(request(), { kind: "myInvitation", token: created.token });
  assert.equal(previewResponse.status, 200);
  assert.equal(JSON.stringify(await read(previewResponse)).includes(created.token), false);

  // POST 到只读预览入口与方法不匹配都返回 405 且带 Allow。
  const wrongMethod = await handler.handle(request("POST", {}), { kind: "myInvitation", token: created.token });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal((await handler.handle(request("GET"), { kind: "claimInvitation", token: created.token })).status, 405);

  const claimResponse = await handler.handle(request("POST", {}), { kind: "claimInvitation", token: created.token });
  assert.equal(claimResponse.status, 200);
  const claimed = (await read(claimResponse)).data as { invitation: { status: string }; grant: { userId: string; capabilities: readonly string[] } };
  assert.equal(claimed.invitation.status, "claimed");
  assert.equal(claimed.grant.userId, "staff");
  assert.deepEqual([...claimed.grant.capabilities], ["event_manage"]);
  assert.equal(JSON.stringify(claimed).includes(created.token), false);

  // 第二次领取是明确 409，不是静默成功。
  actor = f.users.outsider;
  const second = await handler.handle(request("POST", {}), { kind: "claimInvitation", token: created.token });
  assert.equal(second.status, 409);
  assert.equal((await read(second)).error?.code, "ORGANIZER_INVITATION_CLAIMED");
});

test("HTTP：非机构管理员创建邀请 403，撤销按机构管理员校验", async t => {
  const f = await organizerFixture(t), a = await f.approvedOrganization();
  const created = await invite(f, a.organization.id);
  const baselineGrants = (await f.counts()).organizer_staff_grants;
  let actor: OrganizerPrincipal = f.users.staff;
  const handler = createOrganizerHttpHandlers({ service: f.service, authenticate: async () => actor, authorizeMutation: async () => {}, requestId: () => "http-invitation-auth" });
  const forbidden = await handler.handle(request("POST", POLICY()), { kind: "staffInvitations", organizationId: a.organization.id });
  assert.equal(forbidden.status, 403);
  assert.equal((await read(forbidden)).error?.code, "ORGANIZER_FORBIDDEN");
  const revokeForbidden = await handler.handle(request("POST", { expectedRevision: created.invitation.revision }), { kind: "revokeInvitation", invitationId: created.invitation.id });
  assert.equal(revokeForbidden.status, 403);

  actor = f.users.ownerA;
  const revoked = await handler.handle(request("POST", { expectedRevision: created.invitation.revision }), { kind: "revokeInvitation", invitationId: created.invitation.id });
  assert.equal(revoked.status, 200);
  assert.equal(((await read(revoked)).data as { status: string }).status, "revoked");
  assert.equal((await f.counts()).organizer_staff_grants, baselineGrants);
});

function POLICY() { return { role: "staff", capabilities: ["event_manage"] }; }
