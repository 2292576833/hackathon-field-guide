import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { createRecruitingService } from "./service.ts";
import type { RecruitingDependencies, RecruitingService } from "./service.ts";
import { alice, bob, cardDraft, corruptedPngAvatar, errorCode, errorStatus, jpegAvatar, manager, outsider, pngAvatar, postData, profileData, projectId, recruitingFixture, testNow, webpAvatar } from "./test-fixture.ts";
import { validateAvatar } from "./validation.ts";

test("persistent recruiting service respects publication, permission and member-join boundaries in memory-only PGlite", async t => {
  const f = await recruitingFixture();
  const deps: RecruitingDependencies = { database: f.database, identity: f.identity, participant: f.participants, projects: f.projects, ai: f.ai, clock: f.clock, ids: f.ids };
  const service = createRecruitingService(deps);
  t.beforeEach(() => f.reset());
  t.after(() => f.close());
  const published = async (actor: Actor = alice, draft = cardDraft(), target: RecruitingService = service) => {
    const view = await target.getProfile(actor);
    return target.publishCard(actor, { expectedRevision: view.card.revision, profileRevision: view.profile.revision, participantRevision: view.participant.revision, avatarRevision: view.profile.avatarRevision, draft, confirmed: true });
  };
  const submitted = async (actor: Actor = alice, overrides: Record<string, unknown> = {}) => {
    const post = await service.getPost(manager, projectId) ?? await service.savePost(manager, projectId, { expectedRevision: 0, post: postData() });
    return service.apply(actor, post.id, { expectedPostRevision: post.revision, expectedRevision: 0, requestId: `fixture-apply-${actor.userId}`, message: "我愿意参与前端任务。", shareCard: false, ...overrides });
  };
  const approved = async (actor: Actor = alice) => {
    const application = await submitted(actor);
    return service.reviewApplication(manager, application.id, { expectedRevision: application.revision, decision: "approve", note: "请核对后明确加入。" });
  };
  const membershipCount = async (actor: Actor = alice) => (await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM fixture_memberships WHERE user_id=$1", [actor.userId])).rows[0].count;

  await t.test("assistant context reads create no row and return only the current account's bounded private context", async () => {
    assert.equal(await service.readPrivateProfile(alice, f.guardFor(alice)), null);
    assert.equal((await f.database.query("SELECT * FROM recruiting_profiles")).rowCount, 0);
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() });
    const context = await service.readPrivateProfile(alice, f.guardFor(alice)); assert.ok(context);
    assert.equal(context.userId, alice.userId); assert.equal(context.resume, profileData().resume); assert.equal(context.revision, 1);
    assert.ok(!("mbti" in context) && !("age" in context) && !("avatarRevision" in context) && !("hasAvatar" in context));
    assert.equal(await service.readPrivateProfile(bob), null);
    await f.database.query("UPDATE fixture_identities SET session_active=false WHERE user_id=$1", [alice.userId]);
    await assert.rejects(service.readPrivateProfile(alice, f.guardFor(alice)), errorStatus(401));
  });

  await t.test("no-op withdrawals still recheck time-sensitive sessions at the return boundary", async () => {
    let calls = 0;
    const expiredAtReturn = async () => { if (++calls === 2) throw new DomainError("UNAUTHENTICATED", "请求会话已到期。", { status: 401 }); };
    await assert.rejects(service.withdrawCard(alice, { expectedRevision: 0 }, expiredAtReturn), errorStatus(401)); assert.equal(calls, 2);
    const pending = await submitted(), withdrawn = await service.withdrawApplication(alice, pending.id, { expectedRevision: pending.revision }); calls = 0;
    await assert.rejects(service.withdrawApplication(alice, withdrawn.id, { expectedRevision: withdrawn.revision }, expiredAtReturn), errorStatus(401)); assert.equal(calls, 2);
  });

  await t.test("public nickname is included in the owner preview and cannot publish an account email as a display name", async () => {
    await f.database.query("UPDATE fixture_identities SET display_name='private@example.test' WHERE user_id=$1", [alice.userId]);
    const own = await service.getProfile(alice); assert.equal(own.displayName, "private@example.test");
    await assert.rejects(published(), errorCode("INVALID_RECRUITING_INPUT")); assert.equal((await service.listCards()).items.length, 0);
  });

  await t.test("public search uses chosen content and excludes optional MBTI, age, IDs and system revisions", async () => {
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData({ mbti: "INTP", age: 91 }) });
    const card = await published(alice, cardDraft({ showAge: true, showMbti: true }));
    for (const keyword of ["INTP", "91", card.id!]) assert.equal((await service.listCards({ keyword })).items.length, 0);
    assert.equal((await service.listCards({ keyword: "新人参赛助手" })).items.length, 1);
  });

  await t.test("default profile and saved roles, resume, MBTI and age remain private to their active account", async () => {
    const initial = await service.getProfile(alice, f.guardFor(alice));
    assert.equal(initial.profile.revision, 0); assert.equal(initial.profile.age, null); assert.equal(initial.card.status, "private");
    const saved = await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() }, f.guardFor(alice));
    assert.equal(saved.profile.userId, alice.userId); assert.equal(saved.profile.revision, 1); assert.equal(saved.profile.updatedAt, testNow);
    assert.equal((await service.getProfile(bob)).profile.resume, "");
    await service.saveProfile(bob, { expectedRevision: 0, profile: profileData({ resume: "其他账号自己的经历。" }) });
    assert.equal((await service.getProfile(alice)).profile.resume, profileData().resume);
    assert.deepEqual((await service.listCards()).items, []);
    await assert.rejects(service.saveProfile(bob, { expectedRevision: 1, profile: profileData(), userId: alice.userId }), errorCode("INVALID_RECRUITING_INPUT"));
    const recreated = createRecruitingService(deps);
    assert.equal((await recreated.getProfile(alice)).profile.revision, 1);
  });

  await t.test("initial saves and same-revision replacements have one winner and preserve the committed profile", async () => {
    for (const expectedRevision of [0, 1]) {
      const results = await Promise.allSettled([
        service.saveProfile(alice, { expectedRevision, profile: profileData({ resume: "first" }) }),
        service.saveProfile(alice, { expectedRevision, profile: profileData({ resume: "second" }) }),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const loser = results.find(result => result.status === "rejected");
      assert.ok(loser?.status === "rejected" && errorCode("RECRUITING_CHANGED")(loser.reason));
      assert.equal(loser.reason.latestRevision, expectedRevision + 1);
    }
    assert.equal((await service.getProfile(alice)).profile.revision, 2);
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE entity_type='profile'")).rowCount, 2);
  });

  await t.test("inactive identities and revoked sessions cannot read, generate, save, publish or apply", async () => {
    const post = await service.savePost(manager, projectId, { expectedRevision: 0, post: postData() });
    await f.database.query("UPDATE fixture_identities SET active=false WHERE user_id=$1", [alice.userId]);
    await assert.rejects(service.getProfile(alice), errorStatus(401));
    await assert.rejects(service.saveProfile(alice, { expectedRevision: 0, profile: profileData() }), errorStatus(401));
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 0 }), errorStatus(401));
    await assert.rejects(service.publishCard(alice, { expectedRevision: 0, profileRevision: 0, participantRevision: 1, avatarRevision: 0, draft: cardDraft(), confirmed: true }), errorStatus(401));
    await assert.rejects(service.apply(alice, post.id, { expectedPostRevision: post.revision, expectedRevision: 0, requestId: "inactive-apply", message: "参与", shareCard: false }), errorStatus(401));
    await f.database.query("UPDATE fixture_identities SET active=true,session_active=false WHERE user_id=$1", [alice.userId]);
    await assert.rejects(service.getProfile(alice, f.guardFor(alice)), errorStatus(401));
    await assert.rejects(service.saveProfile(alice, { expectedRevision: 0, profile: profileData() }, f.guardFor(alice)), errorStatus(401));
    assert.equal((await f.database.query("SELECT * FROM recruiting_profiles")).rowCount, 0);
    assert.equal(f.generated.length, 0);
  });

  await t.test("final session guard sees the same uncommitted profile and rolls back private edits and history", async () => {
    let checks = 0, transaction: SqlExecutor | undefined;
    await assert.rejects(service.saveProfile(alice, { expectedRevision: 0, profile: profileData() }, async sql => {
      if (transaction) assert.equal(sql, transaction); else transaction = sql;
      if (++checks === 2) {
        assert.equal((await sql.query("SELECT * FROM recruiting_profiles WHERE user_id=$1 AND revision=1", [alice.userId])).rowCount, 1);
        throw new DomainError("UNAUTHENTICATED", "会话失效。", { status: 401 });
      }
    }), errorStatus(401));
    assert.equal(checks, 2); assert.equal((await f.database.query("SELECT * FROM recruiting_profiles")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM recruiting_history")).rowCount, 0);
  });

  await t.test("public card requires explicit confirmation and current profile, participant and avatar revisions", async () => {
    const input = { expectedRevision: 0, profileRevision: 0, participantRevision: 1, avatarRevision: 0, draft: cardDraft(), confirmed: true };
    await assert.rejects(service.publishCard(alice, { ...input, confirmed: false }), errorCode("INVALID_RECRUITING_INPUT"));
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() });
    await assert.rejects(service.publishCard(alice, input), errorCode("RECRUITING_CHANGED"));
    await assert.rejects(service.publishCard(alice, { ...input, profileRevision: 1, participantRevision: 0 }), errorCode("RECRUITING_CHANGED"));
    await assert.rejects(service.publishCard(alice, { ...input, profileRevision: 1, avatarRevision: 1 }), errorCode("RECRUITING_CHANGED"));
    assert.deepEqual((await service.listCards()).items, []);
    const card = await published();
    assert.equal(card.status, "published"); assert.equal(card.card?.mbti, null); assert.equal(card.card?.age, null); assert.equal(card.card?.avatarUrl, null);
    assert.ok(card.card && !("userId" in card.card) && !("email" in card.card) && !("resume" in card.card));
  });

  await t.test("public snapshot and optional age/MBTI stay unchanged after private editing; withdrawal removes the visible snapshot", async () => {
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() });
    const first = await published(alice, cardDraft({ showAge: true, showMbti: true }));
    assert.equal(first.card?.mbti, "INTP"); assert.equal(first.card?.age, 23);
    await service.saveProfile(alice, { expectedRevision: 1, profile: profileData({ resume: "changed private", mbti: "ENFP", age: 30 }) });
    assert.deepEqual((await service.listCards()).items, [first.card]);
    await assert.rejects(service.withdrawCard(alice, { expectedRevision: 0 }), errorCode("RECRUITING_CHANGED"));
    const withdrawn = await service.withdrawCard(alice, { expectedRevision: first.revision });
    assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.card, null); assert.equal(withdrawn.revision, 2);
    assert.deepEqual((await service.listCards()).items, []);
    assert.equal((await service.getProfile(alice)).profile.resume, "changed private");
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE entity_type='card'")).rowCount, 2);
    await assert.rejects(service.publishCard(alice, { expectedRevision: 1, profileRevision: 2, participantRevision: 1, avatarRevision: 0, draft: cardDraft(), confirmed: true }), errorCode("RECRUITING_CHANGED"));
    assert.equal((await published()).revision, 3);
  });

  await t.test("public filters include supporting roles, retain real snapshots and hide deactivated publishers", async () => {
    await published(alice, cardDraft({ headline: "前端伙伴", supportingRoles: ["ai"], purposes: ["learn"] }));
    await published(bob, cardDraft({ headline: "后端伙伴", primaryRoles: ["backend"], supportingRoles: [], purposes: ["award"] }));
    assert.equal((await service.listCards({ role: "ai", purpose: "learn", keyword: "前端" })).items.length, 1);
    assert.equal((await service.listCards({ role: "ai", purpose: "award" })).items.length, 0);
    const first = await service.listCards({ limit: 1 }); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    const next = await service.listCards({ limit: 1, cursor: first.nextCursor! }); assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, first.items[0].id);
    await f.database.query("UPDATE fixture_identities SET active=false WHERE user_id=$1", [alice.userId]);
    assert.deepEqual((await service.listCards({ role: "ai" })).items, []);
  });

  await t.test("private avatar CAS and public image copies are separate, versioned and revoked with the card", async () => {
    await service.saveAvatar(alice, { expectedRevision: 0, avatar: pngAvatar });
    assert.equal((await service.getProfile(alice)).profile.avatarRevision, 1);
    await assert.rejects(service.saveAvatar(alice, { expectedRevision: 0, avatar: pngAvatar }), errorCode("RECRUITING_CHANGED"));
    await assert.rejects(service.getOwnAvatar(bob), errorStatus(404));
    const image = await service.getOwnAvatar(alice); assert.deepEqual(Buffer.from(image.bytes), Buffer.from(pngAvatar.base64, "base64"));
    const card = await published(alice, cardDraft({ showAvatar: true })); assert.ok(card.card?.avatarUrl && card.id);
    const snapshot = await service.getPublicAvatar(card.id!, card.revision);
    await service.removeAvatar(alice, { expectedRevision: 1 });
    await assert.rejects(service.getOwnAvatar(alice), errorStatus(404));
    assert.deepEqual(Buffer.from((await service.getPublicAvatar(card.id!, card.revision)).bytes), Buffer.from(snapshot.bytes));
    await assert.rejects(service.getPublicAvatar(card.id!, 0), errorStatus(404));
    await service.withdrawCard(alice, { expectedRevision: card.revision });
    await assert.rejects(service.getPublicAvatar(card.id!, card.revision), errorStatus(404));
    assert.equal((await f.database.query<{ avatar_bytes: unknown }>("SELECT avatar_bytes FROM recruiting_cards WHERE id=$1", [card.id])).rows[0].avatar_bytes, null);
  });

  await t.test("valid PNG, JPEG and WebP fully decode before saving and preserve their original raster bytes", async () => {
    let expectedRevision = 0;
    for (const avatar of [pngAvatar, jpegAvatar, webpAvatar]) {
      const saved = await service.saveAvatar(alice, { expectedRevision, avatar });
      assert.equal(saved.profile.avatarRevision, ++expectedRevision); assert.equal(saved.profile.hasAvatar, true);
      const image = await service.getOwnAvatar(alice); assert.equal(image.mimeType, avatar.mimeType);
      assert.deepEqual(Buffer.from(image.bytes), Buffer.from(avatar.base64, "base64"));
    }
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE entity_type='avatar'")).rowCount, 3);
  });

  await t.test("structurally plausible PNG with corrupt compressed pixels fails full decode without saving an avatar", async () => {
    assert.equal(validateAvatar(corruptedPngAvatar).mimeType, "image/png");
    await assert.rejects(service.saveAvatar(alice, { expectedRevision: 0, avatar: corruptedPngAvatar }), errorCode("INVALID_RECRUITING_INPUT"));
    assert.equal((await f.database.query("SELECT * FROM recruiting_profiles")).rowCount, 0);
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE entity_type='avatar'")).rowCount, 0);
  });

  await t.test("DSH preview uses saved personal facts, strips sensitive optional fields and does not publish", async () => {
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() });
    await service.saveAvatar(alice, { expectedRevision: 0, avatar: pngAvatar });
    const preview = await service.generateSummary(alice, { expectedRevision: 1 }, f.guardFor(alice));
    assert.equal(preview.provider, "dsh"); assert.equal(preview.profileRevision, 1); assert.equal(preview.participantRevision, 1); assert.equal(preview.avatarRevision, 1);
    assert.equal(preview.draft.showMbti, false); assert.equal(preview.draft.showAge, false); assert.equal(preview.draft.showAvatar, false);
    assert.equal(f.generated.length, 1); assert.equal(f.generated[0].request.kind, "profile_summary");
    assert.deepEqual(f.generated[0].request.requestIdentity, f.generated[0].request.input);
    const sent = JSON.stringify(f.generated[0].request.input);
    assert.match(sent, /私人经历/); assert.ok(!sent.includes('"mbti"') && !sent.includes('"age"') && !sent.includes('"avatar"') && !sent.includes(pngAvatar.base64));
    assert.deepEqual((await service.listCards()).items, []); assert.equal((await service.getProfile(alice)).card.status, "private");
    await assert.rejects(f.ai.get(bob, preview.id), errorStatus(404));
    assert.equal((await f.ai.list(alice, "profile_summary")).length, 1);
  });

  await t.test("AI outputs outside submitted roles/skills/links are rejected and privacy flags are forcibly off", async () => {
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() });
    f.state.aiOutput = cardDraft({ workLinks: profileData().workLinks, primaryRoles: ["backend"] });
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 1 }), errorCode("INVALID_RECRUITING_INPUT"));
    f.state.aiOutput = cardDraft({ workLinks: profileData().workLinks, skills: ["invented expertise"] });
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 1 }), errorCode("INVALID_RECRUITING_INPUT"));
    f.state.aiOutput = cardDraft({ workLinks: profileData().workLinks, showAge: true, showMbti: true, showAvatar: true });
    const preview = await service.generateSummary(alice, { expectedRevision: 1 });
    assert.equal(preview.draft.showAge, false); assert.equal(preview.draft.showMbti, false); assert.equal(preview.draft.showAvatar, false);
    assert.equal((await service.listCards()).items.length, 0);
  });

  await t.test("profile, participant, avatar and session changes during AI prevent a stale usable preview", async () => {
    await service.saveProfile(alice, { expectedRevision: 0, profile: profileData() });
    f.state.duringGeneration = async () => { await service.saveProfile(alice, { expectedRevision: 1, profile: profileData({ resume: "fresh private facts" }) }); };
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 1 }), errorCode("RECRUITING_CHANGED"));
    f.state.duringGeneration = async () => { await f.database.query("UPDATE fixture_participants SET body=jsonb_set(body,'{revision}','2'::jsonb) WHERE user_id=$1", [alice.userId]); };
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 2 }), errorCode("RECRUITING_CHANGED"));
    f.state.duringGeneration = async () => { await service.saveAvatar(alice, { expectedRevision: 0, avatar: pngAvatar }); };
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 2 }), errorCode("RECRUITING_CHANGED"));
    f.state.duringGeneration = async () => { await f.database.query("UPDATE fixture_identities SET session_active=false WHERE user_id=$1", [alice.userId]); };
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 2 }, f.guardFor(alice)), errorStatus(401));
    await f.database.query("UPDATE fixture_identities SET session_active=true WHERE user_id=$1", [alice.userId]);
    f.state.duringGeneration = async () => { await f.database.query("UPDATE fixture_identities SET active=false WHERE user_id=$1", [alice.userId]); };
    await assert.rejects(service.generateSummary(alice, { expectedRevision: 2 }), errorStatus(401));
    assert.deepEqual((await service.listCards()).items, []);
  });

  await t.test("unknown AI outcomes are surfaced once and cannot create a preview or public card", async () => {
    let requests = 0;
    const unknown = createRecruitingService({ ...deps, ai: { ...f.ai, async generate() { requests++; throw new DomainError("AI_RESULT_UNKNOWN", "付费请求结果未知。", { status: 503 }); } } });
    await assert.rejects(unknown.generateSummary(alice, { expectedRevision: 0 }), errorCode("AI_RESULT_UNKNOWN"));
    assert.equal(requests, 1); assert.equal(f.artifacts.size, 0); assert.deepEqual((await service.listCards()).items, []);
  });

  await t.test("only a current active manager can publish/update/read administration or review; archived spaces cannot write", async () => {
    for (const actor of [alice, bob, outsider]) await assert.rejects(service.savePost(actor, projectId, { expectedRevision: 0, post: postData() }), errorStatus(403));
    await f.database.query("INSERT INTO fixture_memberships(membership_id,project_id,user_id,role,status) VALUES('fixture-member',$1,$2,'member','active')", [projectId, bob.userId]);
    await assert.rejects(service.savePost(bob, projectId, { expectedRevision: 0, post: postData() }), errorStatus(403));
    const post = await service.savePost(manager, projectId, { expectedRevision: 0, post: postData() });
    await assert.rejects(service.savePost(manager, projectId, { expectedRevision: 0, post: postData({ title: "stale" }) }), errorCode("RECRUITING_CHANGED"));
    await assert.rejects(service.getPost(bob, projectId), errorStatus(403));
    await assert.rejects(service.listProjectApplications(bob, projectId), errorStatus(403));
    assert.deepEqual((await service.listPosts({ role: "frontend", purpose: "learn", keyword: "公开招募" })).items, [post]);
    await f.database.query("UPDATE fixture_projects SET archived=true WHERE project_id=$1", [projectId]);
    await assert.rejects(service.savePost(manager, projectId, { expectedRevision: 1, post: postData() }), errorCode("PROJECT_ARCHIVED"));
    assert.deepEqual((await service.listPosts()).items, []);
  });

  await t.test("post publisher losing management or active status immediately hides public recruiting", async () => {
    await service.savePost(manager, projectId, { expectedRevision: 0, post: postData() });
    await f.database.query("UPDATE fixture_memberships SET status='left' WHERE membership_id='fixture-manager'");
    assert.deepEqual((await service.listPosts()).items, []);
    await assert.rejects(service.savePost(manager, projectId, { expectedRevision: 1, post: postData() }), errorStatus(403));
    await f.database.query("UPDATE fixture_memberships SET status='active' WHERE membership_id='fixture-manager'");
    await f.database.query("UPDATE fixture_identities SET active=false WHERE user_id=$1", [manager.userId]);
    assert.deepEqual((await service.listPosts()).items, []);
  });

  await t.test("applying is idempotent per request, private per applicant and does not create membership", async () => {
    const application = await submitted();
    const duplicate = await submitted(); assert.deepEqual(duplicate, application);
    assert.equal((await service.listOwnApplications(alice)).length, 1); assert.deepEqual(await service.listOwnApplications(bob), []);
    assert.equal(await membershipCount(), 0); assert.equal(f.joins.length, 0);
    await assert.rejects(submitted(alice, { message: "不同内容" }), errorCode("RECRUITING_REQUEST_REUSED"));
    await assert.rejects(submitted(alice, { requestId: "new-request" }), errorCode("RECRUITING_CHANGED"));
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE entity_type='application'")).rowCount, 1);
    await assert.rejects(service.withdrawApplication(bob, application.id, { expectedRevision: application.revision }), errorStatus(403));
    await assert.rejects(service.joinApproved(bob, application.id, { expectedRevision: application.revision, confirmed: true }), errorStatus(403));
    assert.equal((await service.listProjectApplications(manager, projectId))[0].applicantUserId, alice.userId);
  });

  await t.test("card sharing requires a currently published own card and stores only its independent snapshot", async () => {
    await assert.rejects(submitted(alice, { shareCard: true }), errorCode("INVALID_RECRUITING_INPUT"));
    await published(); const application = await submitted(alice, { shareCard: true });
    assert.ok(application.cardSnapshot); assert.ok(!("resume" in application.cardSnapshot) && !("email" in application.cardSnapshot));
    await service.withdrawCard(alice, { expectedRevision: 1 });
    assert.deepEqual((await service.listProjectApplications(manager, projectId))[0].cardSnapshot, application.cardSnapshot);
    assert.deepEqual((await service.listCards()).items, []);
  });

  await t.test("review is versioned, never joins automatically and cannot exceed reserved seats", async () => {
    const post = await service.savePost(manager, projectId, { expectedRevision: 0, post: postData({ seats: 1 }) });
    const first = await submitted(alice), second = await submitted(bob);
    await assert.rejects(service.reviewApplication(bob, first.id, { expectedRevision: 1, decision: "approve", note: "" }), errorStatus(403));
    const decision = await service.reviewApplication(manager, first.id, { expectedRevision: 1, decision: "approve", note: "欢迎核对后加入" });
    assert.equal(decision.status, "approved"); assert.equal(decision.membershipId, null); assert.equal(decision.reviewedBy, manager.userId);
    assert.equal(await membershipCount(), 0); assert.equal(f.joins.length, 0); assert.equal((await service.listOwnApplications(alice))[0].canJoin, true);
    await assert.rejects(service.reviewApplication(manager, first.id, { expectedRevision: 1, decision: "reject", note: "stale" }), errorCode("RECRUITING_CHANGED"));
    await assert.rejects(service.reviewApplication(manager, second.id, { expectedRevision: 1, decision: "approve", note: "" }), errorCode("RECRUITING_SEATS_FULL"));
    const rejected = await service.reviewApplication(manager, first.id, { expectedRevision: 2, decision: "reject", note: "释放名额" }); assert.equal(rejected.status, "rejected");
    assert.equal((await service.reviewApplication(manager, second.id, { expectedRevision: 1, decision: "approve", note: "" })).status, "approved");
    const expanded = await service.savePost(manager, projectId, { expectedRevision: post.revision, post: postData({ seats: 2 }) });
    await service.reviewApplication(manager, first.id, { expectedRevision: rejected.revision, decision: "approve", note: "新增名额" });
    await assert.rejects(service.savePost(manager, projectId, { expectedRevision: expanded.revision, post: postData({ seats: 1 }) }), errorCode("RECRUITING_SEATS_RESERVED"));
  });

  await t.test("withdraw and resubmit retain the same application history and reject a stale request", async () => {
    const application = await submitted();
    await assert.rejects(service.withdrawApplication(alice, application.id, { expectedRevision: 0 }), errorCode("RECRUITING_CHANGED"));
    const withdrawn = await service.withdrawApplication(alice, application.id, { expectedRevision: 1 }); assert.equal(withdrawn.status, "withdrawn");
    const resubmitted = await submitted(alice, { expectedRevision: 2, requestId: "resubmitted-request", message: "补充作品后重新申请。" });
    assert.equal(resubmitted.id, application.id); assert.equal(resubmitted.revision, 3); assert.equal(resubmitted.status, "pending");
    assert.equal((await f.database.query("SELECT * FROM recruiting_applications")).rowCount, 1);
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE entity_type='application'")).rowCount, 3);
  });

  await t.test("parallel seat approvals reserve only one remaining place and leave the other application pending", async () => {
    await service.savePost(manager, projectId, { expectedRevision: 0, post: postData({ seats: 1 }) });
    const first = await submitted(alice), second = await submitted(bob);
    const results = await Promise.allSettled([
      service.reviewApplication(manager, first.id, { expectedRevision: 1, decision: "approve", note: "" }),
      service.reviewApplication(manager, second.id, { expectedRevision: 1, decision: "approve", note: "" }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const loser = results.find(result => result.status === "rejected");
    assert.ok(loser?.status === "rejected" && errorCode("RECRUITING_SEATS_FULL")(loser.reason));
    const statuses = (await service.listProjectApplications(manager, projectId)).map(application => application.status).sort();
    assert.deepEqual(statuses, ["approved", "pending"]); assert.equal(await membershipCount(alice), 0); assert.equal(await membershipCount(bob), 0);
  });

  await t.test("closed and archived recruiting reject fresh applicants; current members cannot create recruiting applications", async () => {
    const post = await service.savePost(manager, projectId, { expectedRevision: 0, post: postData({ status: "closed" }) });
    const input = { expectedPostRevision: post.revision, expectedRevision: 0, requestId: "closed-request", message: "参与", shareCard: false };
    await assert.rejects(service.apply(alice, post.id, input), errorCode("RECRUITING_POST_CLOSED"));
    const opened = await service.savePost(manager, projectId, { expectedRevision: 1, post: postData() });
    await f.database.query("UPDATE fixture_projects SET archived=true WHERE project_id=$1", [projectId]);
    await assert.rejects(service.apply(alice, opened.id, { ...input, expectedPostRevision: opened.revision }), errorCode("RECRUITING_POST_CLOSED"));
    await f.database.query("UPDATE fixture_projects SET archived=false WHERE project_id=$1", [projectId]);
    await f.database.query("INSERT INTO fixture_memberships(membership_id,project_id,user_id,role,status) VALUES('already-member',$1,$2,'member','active')", [projectId, alice.userId]);
    await assert.rejects(service.apply(alice, opened.id, { ...input, expectedPostRevision: opened.revision }), errorCode("ALREADY_PROJECT_MEMBER"));
    assert.equal((await f.database.query("SELECT * FROM recruiting_applications")).rowCount, 0);
  });

  await t.test("joining requires approval, explicit confirmation and the applicant; success shares one transaction and grants only member", async () => {
    const pending = await submitted();
    await assert.rejects(service.joinApproved(alice, pending.id, { expectedRevision: 1, confirmed: true }), errorCode("RECRUITING_APPROVAL_REQUIRED"));
    const approval = await service.reviewApplication(manager, pending.id, { expectedRevision: 1, decision: "approve", note: "" });
    await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: false }), errorCode("INVALID_RECRUITING_INPUT"));
    const joined = await service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }, f.guardFor(alice));
    assert.equal(joined.status, "joined"); assert.ok(joined.membershipId); assert.equal(joined.revision, approval.revision + 1);
    assert.equal(f.joins.length, 1); assert.equal(f.joins[0].input.actor.userId, alice.userId); assert.equal(f.joins[0].input.approvedBy, manager.userId); assert.equal(f.joins[0].input.projectId, projectId);
    const membership = (await f.database.query<{ role: string; status: string; membership_id: string }>("SELECT role,status,membership_id FROM fixture_memberships WHERE user_id=$1", [alice.userId])).rows[0];
    assert.equal(membership.role, "member"); assert.equal(membership.status, "active"); assert.equal(membership.membership_id, joined.membershipId);
    assert.deepEqual(await service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }), joined);
    assert.equal(f.joins.length, 1); assert.equal(await membershipCount(), 1);
    await assert.rejects(service.withdrawApplication(alice, approval.id, { expectedRevision: joined.revision }), errorCode("RECRUITING_ALREADY_JOINED"));
  });

  await t.test("approver withdrawal, archived project and closed recruitment revoke pending approval join", async () => {
    const approval = await approved();
    await f.database.query("UPDATE fixture_memberships SET role='member' WHERE membership_id='fixture-manager'");
    assert.equal((await service.listOwnApplications(alice))[0].canJoin, false);
    await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }), errorStatus(403));
    assert.equal(f.joins.length, 0); assert.equal(await membershipCount(), 0);
    await f.database.query("UPDATE fixture_memberships SET role='manager' WHERE membership_id='fixture-manager'");
    await f.database.query("UPDATE fixture_projects SET archived=true WHERE project_id=$1", [projectId]);
    await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }), errorCode("PROJECT_ARCHIVED"));
    await f.database.query("UPDATE fixture_projects SET archived=false WHERE project_id=$1", [projectId]);
    await service.savePost(manager, projectId, { expectedRevision: 1, post: postData({ status: "closed" }) });
    await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }), errorCode("RECRUITING_POST_CLOSED"));
    assert.equal(await membershipCount(), 0);
  });

  await t.test("parallel retries of an approved join consume the member-join Port only once", async () => {
    const approval = await approved();
    const results = await Promise.all([
      service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }),
      service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }),
    ]);
    assert.deepEqual(results[0], results[1]); assert.equal(f.joins.length, 1); assert.equal(await membershipCount(), 1);
    assert.equal((await f.database.query("SELECT * FROM fixture_consumed_joins")).rowCount, 1);
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE action='join_space'")).rowCount, 1);
  });

  await t.test("consumed application cannot reactivate a member who later left or was removed", async () => {
    const approval = await approved();
    const joined = await service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true });
    for (const status of ["left", "removed"]) {
      await f.database.query("UPDATE fixture_memberships SET status=$1 WHERE membership_id=$2", [status, joined.membershipId]);
      await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }), errorCode("RECRUITING_MEMBERSHIP_CHANGED"));
      assert.equal((await f.database.query<{ status: string }>("SELECT status FROM fixture_memberships WHERE membership_id=$1", [joined.membershipId])).rows[0].status, status);
    }
    assert.equal(f.joins.length, 1); assert.equal((await service.listOwnApplications(alice))[0].status, "joined");
  });

  await t.test("root member-write failure rolls back membership, consumption, application update and history together", async () => {
    const approval = await approved();
    f.state.joinFailAfterWrite = true;
    await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }), /simulated member insert rollback/);
    assert.equal(await membershipCount(), 0); assert.equal((await f.database.query("SELECT * FROM fixture_consumed_joins")).rowCount, 0);
    const unchanged = (await service.listOwnApplications(alice))[0]; assert.equal(unchanged.status, "approved"); assert.equal(unchanged.revision, approval.revision); assert.equal(unchanged.membershipId, null);
    assert.equal((await f.database.query("SELECT * FROM recruiting_history WHERE action='join_space'")).rowCount, 0);
    f.state.joinFailAfterWrite = false;
    assert.equal((await service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true })).status, "joined");
  });

  await t.test("session invalidation after member insertion rolls back the join rather than report a false success", async () => {
    const approval = await approved(); let checks = 0;
    await assert.rejects(service.joinApproved(alice, approval.id, { expectedRevision: approval.revision, confirmed: true }, async sql => {
      if (++checks === 2) {
        assert.equal((await sql.query("SELECT * FROM fixture_memberships WHERE user_id=$1", [alice.userId])).rowCount, 1);
        assert.equal((await sql.query("SELECT * FROM recruiting_applications WHERE id=$1 AND status='joined'", [approval.id])).rowCount, 1);
        throw new DomainError("UNAUTHENTICATED", "加入期间会话失效。", { status: 401 });
      }
    }), errorStatus(401));
    assert.equal(checks, 2); assert.equal(await membershipCount(), 0);
    assert.equal((await service.listOwnApplications(alice))[0].status, "approved");
  });
});
