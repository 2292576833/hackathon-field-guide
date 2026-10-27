import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Organization, OrganizationApplication, HostedEvent, StaffGrant } from "../modules/organizer/index.ts";
import type { RegistrationForm, Registration, RosterTeam } from "../modules/event-registration/index.ts";
import type { TicketView } from "../modules/event-communication/index.ts";
import type { IntakeReceipt, SubmissionPreview, JudgingRound, JudgeAssignment, ManualScore, ResultProjection, ResultSummary, CalibrationReport, IntegrityReport, ResultAppeal, DuplicateReport, FairnessReport } from "../modules/event-judging/index.ts";
import type { UserProfile } from "../modules/auth/index.ts";
import { createDatabase } from "./database.ts";
import { createApplication, type Application } from "./application.ts";
import { dispatch } from "./router.ts";

const origin = "http://localhost:3000";
interface Account { cookie: string; profile: UserProfile }
async function fixture(t: TestContext) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External network is forbidden in organizer root acceptance"); });
  const database = await createDatabase({}); t.after(() => database.close());
  const app = await createApplication({ mode: "local", origin, codePepper: "organizer-router-fixture-pepper-at-least-32-bytes", emailFrom: "fixture@localhost.invalid" }, database);
  return { app, database };
}
async function http<T>(app: Application, path: string, method = "GET", account?: Account, body?: unknown, expected = 200, requestOrigin = origin) {
  const headers = new Headers({ origin: requestOrigin, "content-type": "application/json" });
  if (account) headers.set("cookie", account.cookie);
  const request = new Request(`${origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const pathname = new URL(request.url).pathname.slice("/api/v1/".length);
  const response = await dispatch(app, request, pathname.split("/"));
  const envelope = await response.json() as { data: T; error?: { code: string; message: string } };
  // Never echo request bodies, verification codes, sessions or email contents.
  assert.equal(response.status, expected, `${method} ${pathname}: ${envelope.error?.code ?? "unexpected status"} ${envelope.error?.message ?? ""}`);
  return { data: envelope.data, response, error: envelope.error };
}
async function register(app: Application, name: string): Promise<Account> {
  const email = `${name}@organizer-acceptance.example.test`;
  const challenge = (await http<{ challengeId: string }>(app, "auth/registration-challenges", "POST", undefined, { email, displayName: name })).data;
  const mail = (await app.database.query<{ body: string }>("SELECT body FROM development_mailbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1", [email])).rows[0];
  const code = mail?.body.match(/\b\d{8}\b/)?.[0]; assert.ok(code, "isolated mailbox supplied an actual registration verification challenge");
  const result = await http<{ profile: UserProfile }>(app, "auth/registration-challenges/verify", "POST", undefined, { challengeId: challenge.challengeId, code, returnTo: "/competitions" });
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0]; assert.ok(cookie, "real registration installed an auth session");
  return { cookie, profile: result.data.profile };
}
async function promoteAdmin(app: Application, person: Account) {
  await app.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin'],revision=revision+1 WHERE id=$1", [person.profile.id]);
}
async function createCompetition(app: Application, admin: Account, owner: Account, title: string) {
  const application = (await http<OrganizationApplication>(app, "organizer/applications", "POST", owner, { name: `${title}主办方`, kind: "community", description: "为初次参赛者举办小型黑客松", contactName: "活动负责人", contactEmail: owner.profile.email, evidenceText: "测试夹具中的机构材料，仅隔离验收使用", evidenceUrls: [] })).data;
  await http(app, `admin/organizer/applications/${application.id}/review`, "POST", admin, { expectedRevision: application.revision, decision: "approved", note: "隔离夹具已人工核查" });
  const organization = (await http<Organization[]>(app, "organizer/organizations", "GET", owner)).data.find(item => item.id === application.organizationId)!;
  assert.ok(organization);
  const now = Date.now(), at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const event = (await http<HostedEvent>(app, `organizer/organizations/${organization.id}/events`, "POST", owner, {
    templateKey: "online", expectedOrganizationRevision: organization.revision, title, timezone: "Asia/Shanghai", startsAt: at(2), endsAt: at(26), registrationOpensAt: at(-1), registrationClosesAt: at(1), submissionClosesAt: at(24),
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: false, mealVouchers: false }, registration: { reviewRequired: false, capacity: 10 }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null },
    summary: "新手共同完成可演示的原型", rules: "先报名后组队；材料以本站正式收件回执为准；由人工评委评分。", location: "线上会议" })).data;
  const form = (await http<RegistrationForm>(app, `organizer/events/${event.eventId}/registration-form`, "PUT", owner, { expectedRevision: 0, title: "报名这场比赛", description: "先填写目标，再开始组队", fields: [{ id: "goal", type: "text", label: "参赛目标", description: "", required: true }], changeNote: "首次设置" })).data;
  const published = (await http<HostedEvent>(app, `organizer/events/${event.eventId}/publish`, "POST", owner, { expectedRevision: event.revision, changeSummary: "首次开放报名、组队和正式收件" })).data;
  return { event: published, form, organization, application };
}
async function enterAndLock(app: Application, account: Account, event: HostedEvent, form: RegistrationForm) {
  const draft = (await http<Registration>(app, `competitions/${event.eventId}/my-registration`, "PATCH", account, { expectedRevision: 0, formRevision: form.revision, answers: { goal: "学习做出一个完整原型" } })).data;
  const registration = (await http<Registration>(app, `competitions/${event.eventId}/my-registration/submit`, "POST", account, { expectedRevision: draft.revision, idempotencyKey: `registration-${event.eventId}` })).data;
  assert.equal(registration.status, "approved");
  const team = (await http<RosterTeam>(app, `competitions/${event.eventId}/teams`, "POST", account, { name: "新手行动队", introduction: "协作完成最小作品", track: "", idempotencyKey: `team-${event.eventId}` })).data;
  return (await http<RosterTeam>(app, `competitions/${event.eventId}/teams/${team.id}/lock`, "POST", account, { expectedRevision: team.revision, idempotencyKey: `roster-${event.eventId}` })).data;
}

test("真实根组织发信设置只读、当前权限和停用墓碑；未授权验证不联网", async t => {
  const { app, database } = await fixture(t);
  const admin = await register(app, "sender-admin"), owner = await register(app, "sender-owner"), other = await register(app, "sender-other");
  await promoteAdmin(app, admin);
  const { organization } = await createCompetition(app, admin, owner, "组织发信配置验收");
  const path = `organizer/organizations/${organization.id}/mail-account`;
  const input = { expectedRevision: 0, provider: "qq", email: "fixture@qq.com", authorizationCode: "isolated-noncredential" };
  await http(app, path, "GET", undefined, undefined, 401);
  await http(app, path, "GET", other, undefined, 403);
  await http(app, path, "PUT", other, input, 403);
  await http(app, path, "PUT", owner, input, 403, "https://foreign.example.test");
  const initial = (await http<{ organizationId: string; state: string; revision: number; maskedEmail: null }>(app, path, "GET", owner)).data;
  assert.equal(initial.organizationId, organization.id); assert.equal(initial.state, "unconfigured"); assert.equal(initial.revision, 0); assert.equal(initial.maskedEmail, null);
  assert.equal((await database.query("SELECT id FROM organizer_mail_verification_attempts")).rowCount, 0, "unauthorized requests and GET never start SMTP verification");
  assert.equal((await database.query("SELECT organization_id FROM organizer_mail_accounts")).rowCount, 0, "metadata GET does not initialize credentials");
  const disabled = (await http<{ state: string; revision: number }>(app, `${path}/disable`, "POST", owner, { expectedRevision: 0 })).data;
  assert.equal(disabled.state, "disabled"); assert.equal(disabled.revision, 1);
  await http(app, `${path}/disable`, "POST", owner, { expectedRevision: 0 }, 409);
  const latest = (await http<Record<string, unknown>>(app, path, "GET", owner)).data;
  assert.equal(latest.revision, 1); assert.equal("credential" in latest, false); assert.equal("authorizationCode" in latest, false); assert.equal("email" in latest, false);
  assert.equal((await database.query("SELECT id FROM organizer_mail_verification_attempts")).rowCount, 0);
  assert.equal((await database.query("SELECT id FROM organizer_mail_account_audit")).rowCount, 1);
  const counts = (await http<{ websiteConfigured: boolean; organizationSenders: number }>(app, "admin/organizer/notification-status", "GET", admin)).data;
  assert.equal(counts.websiteConfigured, false); assert.equal(counts.organizationSenders, 0);
});

test("真实根路由贯通注册会话、审核发赛、报名组队、私人沟通、正式收件、人工评审及本人赛事入口", async t => {
  const { app, database } = await fixture(t);
  const admin = await register(app, "admin"), owner = await register(app, "owner"), entrant = await register(app, "entrant"), judge = await register(app, "judge");
  await promoteAdmin(app, admin);
  const { event, form } = await createCompetition(app, admin, owner, "AI新手体验赛");
  const publicDetail = (await http<{ eventId: string; organizationName: string }>(app, `competitions/${event.eventId}`)).data;
  assert.equal(publicDetail.eventId, event.eventId); assert.equal(publicDetail.organizationName, event.organizationName);
  const team = await enterAndLock(app, entrant, event, form); assert.equal(team.status, "locked"); assert.equal(team.eligible, true);
  const mine = (await http<{ items: { eventId: string; registrationStatus: string }[] }>(app, "me/competitions", "GET", entrant)).data;
  assert.equal(mine.items.find(item => item.eventId === event.eventId)?.registrationStatus, "approved");

  const ticket = (await http<TicketView>(app, `competitions/${event.eventId}/help-tickets`, "POST", entrant, { question: "私人问题：我第一次参加，怎样提交作品？", visibility: "private" })).data;
  const answer = (await http<TicketView>(app, `organizer/events/${event.eventId}/help-tickets/${ticket.id}/replies`, "POST", owner, { expectedRevision: ticket.revision, body: "先在作品提交页预览，再由队长确认正式提交并保存回执。" })).data;
  assert.equal(answer.status, "answered");
  const ownTicket = (await http<TicketView>(app, `competitions/${event.eventId}/help-tickets/${ticket.id}`, "GET", entrant)).data;
  assert.equal(ownTicket.replies[0]?.role, "staff"); assert.deepEqual((await http(app, `competitions/${event.eventId}/help-tickets`)).data, []);

  const materials = { title: "AI学习助手", description: "为初次参赛者提供可复现的学习流程", links: [{ label: "演示地址", url: "https://example.test/demo" }], files: [] };
  const preview = (await http<SubmissionPreview>(app, `competitions/${event.eventId}/submissions/preview`, "POST", entrant, { teamId: team.id, materials })).data;
  const command = { teamId: team.id, materials, expectedEventRevision: preview.eventRevision, expectedTeamRevision: preview.teamRevision, expectedPreviousVersion: preview.previousVersion, expectedMaterialHash: preview.materialHash, idempotencyKey: "first-official-intake" };
  const receipt = (await http<IntakeReceipt>(app, `competitions/${event.eventId}/submissions/submit`, "POST", entrant, command)).data;
  assert.ok(receipt.receiptNumber); assert.equal(receipt.submissionRecordId, null, "unmapped official intake must remain a true organizer receipt without fabricated M06 verification");
  assert.equal((await http<IntakeReceipt>(app, `competitions/${event.eventId}/submissions/submit`, "POST", entrant, command)).data.id, receipt.id);
  assert.equal((await http<{ items: IntakeReceipt[] }>(app, `competitions/${event.eventId}/my-submissions?teamId=${team.id}`, "GET", entrant)).data.items.length, 1);

  const lookup = (await http<{ userId: string }>(app, `organizer/events/${event.eventId}/account-lookup`, "POST", owner, { email: judge.profile.email })).data; assert.equal(lookup.userId, judge.profile.id);
  const round = (await http<JudgingRound>(app, `organizer/events/${event.eventId}/judging/config`, "PUT", owner, { expectedRevision: 0, config: { title: "人工初评", criteria: [{ id: "usable", label: "可用性", weight: 100, min: 0, max: 10 }], minJudges: 1, missingPolicy: "block_publication", tiePolicy: "shared_rank" } })).data;
  const opened = (await http<JudgingRound>(app, `organizer/events/${event.eventId}/judging/rounds/${round.id}/start`, "POST", owner, { expectedRevision: round.revision })).data;
  let assignment = (await http<JudgeAssignment>(app, `organizer/events/${event.eventId}/judge-assignments`, "POST", owner, { roundId: opened.id, snapshotId: receipt.id, judgeUserId: judge.profile.id, expectedRoundRevision: opened.revision })).data;
  assert.equal(assignment.status, "needs_review");
  await http(app, `organizer/events/${event.eventId}/judging/relationship-review`, "POST", owner, { teamId: team.id, judgeUserId: judge.profile.id, status: "clear", note: "负责人已人工核查评委没有参与本队备赛", expectedTeamRevision: team.revision });
  assignment = (await http<JudgeAssignment>(app, `organizer/events/${event.eventId}/judging/assignments/${assignment.id}/review`, "POST", owner, { expectedRevision: assignment.revision, reason: "完成独立人工关系核查" })).data;
  assignment = (await http<JudgeAssignment>(app, `judging/${event.eventId}/assignments/${assignment.id}/conflicts`, "POST", judge, { expectedRevision: assignment.revision, hasConflict: false, reason: "本人确认没有参与本作品备赛" })).data;
  assert.equal((await http<{ receipt: { materials: { title: string } } }>(app, `judging/${event.eventId}/assignments/${assignment.id}/materials`, "GET", judge)).data.receipt.materials.title, materials.title);
  const score = (await http<ManualScore>(app, `judging/${event.eventId}/assignments/${assignment.id}/scores/submit`, "POST", judge, { expectedAssignmentRevision: assignment.revision, expectedScoreRevision: 0, values: { usable: 8 }, feedback: "人工评价：核心流程可用" })).data; assert.equal(score.state, "submitted");
  const judged = (await http<{ items: { eventId: string }[] }>(app, "me/judging-competitions", "GET", judge)).data; assert.equal(judged.items[0]?.eventId, event.eventId);
  assert.deepEqual((await http<{ items: unknown[] }>(app, "me/judging-competitions", "GET", entrant)).data.items, []);

  const locked = (await http<JudgingRound>(app, `organizer/events/${event.eventId}/judging/rounds/${opened.id}/lock`, "POST", owner, { expectedRevision: opened.revision })).data;
  const results = (await http<{ summary: ResultSummary; summaryHash: string }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data;
  assert.equal(results.summary.rows[0]?.total, 80);
  // 校准派生视图：只读、仅限本场工作人员，样本不足时不提供校准分，且不得改变原始汇总。
  const calibrationView = (await http<CalibrationReport>(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/calibration`, "GET", owner)).data;
  assert.equal(calibrationView.status, "insufficient_sample"); assert.equal(calibrationView.reason, "sample_size");
  assert.equal(calibrationView.rows[0]?.rawTotal, 80); assert.equal(calibrationView.rows[0]?.calibratedTotal, null);
  assert.equal(calibrationView.judges[0]?.judgeUserId, judge.profile.id); assert.equal(calibrationView.judges[0]?.eligible, false);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/calibration`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/calibration`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/calibration`, "GET", undefined, undefined, 401);
  const rechecked = (await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data;
  assert.equal(rechecked.summary.rows[0]?.total, 80, "读取校准视图不得改变原始汇总");
  // 隔离自检：只读、仅限本场工作人员；健康的一轮应通过且不改变任何事实。
  const selfCheck = (await http<IntegrityReport>(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/integrity`, "GET", owner)).data;
  assert.equal(selfCheck.status, "pass");
  assert.deepEqual(selfCheck.checks.map(item => item.id), ["conflict_blocked", "excluded_scores", "score_values", "duplicate_assignments", "round_snapshots"]);
  assert.ok(selfCheck.checks.every(item => item.status === "pass"));
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/integrity`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/integrity`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/integrity`, "GET", undefined, undefined, 401);
  const afterCheck = (await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data;
  assert.equal(afterCheck.summary.rows[0]?.total, 80, "读取自检不得改变原始汇总");
  await http(app, `organizer/events/${event.eventId}/judging/results/publish`, "POST", owner, { roundId: locked.id, expectedRevision: locked.revision, expectedSummaryHash: results.summaryHash, visibility: "public", approvedFeedback: [] });
  const publicResults = (await http<ResultProjection>(app, `competitions/${event.eventId}/results`)).data; assert.equal(publicResults.status, "published"); assert.equal(publicResults.rows[0]?.total, 80);
  assert.ok(!JSON.stringify(publicResults).includes(judge.profile.id)); assert.ok(!JSON.stringify(publicResults).includes("私人问题"));
  // 参赛者申诉：公布之后的新事实；可以提交与处理，但绝不改变分数、名次或公布。
  const appealReason = "第二位评委的评分与我们收到的书面反馈不一致，希望核对评分记录。";
  const filed = (await http<ResultAppeal>(app, `competitions/${event.eventId}/appeals`, "POST", entrant, { roundId: locked.id, reason: appealReason, requestedOutcome: "核对后给出说明", idempotencyKey: "appeal-first" })).data;
  assert.equal(filed.status, "submitted"); assert.equal(filed.resultVersion, 1); assert.equal(filed.teamId, team.id); assert.equal(filed.authorUserId, entrant.profile.id);
  assert.equal((await http<ResultAppeal>(app, `competitions/${event.eventId}/appeals`, "POST", entrant, { roundId: locked.id, reason: "重复提交", idempotencyKey: "appeal-first" })).data.id, filed.id, "同一重试标识必须返回同一条申诉");
  await http(app, `competitions/${event.eventId}/appeals`, "POST", entrant, { roundId: locked.id, reason: "再来一条", idempotencyKey: "appeal-second" }, 409);
  const ownAppeals = (await http<{ items: ResultAppeal[]; window: { filed: boolean; canFile: boolean; deadlineAt: string } | null }>(app, `competitions/${event.eventId}/appeals`, "GET", entrant)).data;
  assert.equal(ownAppeals.items.length, 1); assert.equal(ownAppeals.window?.filed, true); assert.equal(ownAppeals.window?.canFile, true);
  assert.deepEqual((await http<{ items: ResultAppeal[] }>(app, `competitions/${event.eventId}/appeals`, "GET", judge)).data.items, [], "非本队成员看不到这条申诉");
  await http(app, `competitions/${event.eventId}/appeals`, "GET", undefined, undefined, 401);
  await http(app, `organizer/events/${event.eventId}/judging/appeals`, "GET", entrant, undefined, 403);
  const appealQueue = (await http<{ items: { appeal: ResultAppeal }[]; openCount: number }>(app, `organizer/events/${event.eventId}/judging/appeals`, "GET", owner)).data;
  assert.equal(appealQueue.openCount, 1); assert.equal(appealQueue.items[0]?.appeal.id, filed.id);
  await http(app, `organizer/events/${event.eventId}/judging/appeals/${filed.id}/resolve`, "POST", entrant, { expectedRevision: filed.revision, decision: "handled", note: "无权限" }, 403);
  const resolved = (await http<ResultAppeal>(app, `organizer/events/${event.eventId}/judging/appeals/${filed.id}/resolve`, "POST", owner, { expectedRevision: filed.revision, decision: "handled", note: "已核对第二位评委的评分记录与书面反馈，分数无误，说明已回复队伍。" })).data;
  assert.equal(resolved.status, "handled"); assert.equal(resolved.revision, 2); assert.equal(resolved.resolvedBy, owner.profile.id);
  const afterAppeal = (await http<ResultProjection>(app, `competitions/${event.eventId}/results`)).data;
  assert.equal(afterAppeal.status, "published"); assert.equal(afterAppeal.rows[0]?.total, 80, "处理申诉不得改变已公布结果");
  assert.ok(!JSON.stringify(afterAppeal).includes("书面反馈"), "公开结果不得泄露申诉内容");
  assert.equal((await database.query("SELECT status FROM ej_result_appeals WHERE event_id=$1", [event.eventId])).rows[0]?.status, "handled");
  // 相似/重复材料线索：只读、仅本场工作人员；只有一支队伍时不得凭空造出线索。
  const duplicateReport = (await http<DuplicateReport>(app, `organizer/events/${event.eventId}/judging/duplicates`, "GET", owner)).data;
  assert.deepEqual(duplicateReport.pairs, []);
  assert.equal(duplicateReport.checkedTeams, 1);
  assert.match(duplicateReport.notice, /1 支队伍/);
  assert.equal(duplicateReport.limitations.length, 4);
  await http(app, `organizer/events/${event.eventId}/judging/duplicates`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/duplicates`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/duplicates`, "GET", undefined, undefined, 401);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM ej_intake_receipts WHERE event_id=$1", [event.eventId])).rows[0]?.count, 1, "读取重复线索不得写入任何收件");
  // 公开公平规则包与人工确认建议：只读，不自动扣分；非工作人员不可读。
  const fairness = (await http<FairnessReport>(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/fairness`, "GET", owner)).data;
  assert.equal(fairness.roundId, locked.id);
  assert.ok(fairness.declaration.lines.length >= 9);
  assert.ok(fairness.declaration.lines.some(line => line.includes("最少评委数")));
  assert.ok(fairness.suggestions.every(item => item.needsConfirmation === true), "所有建议都必须标注需人工确认");
  assert.ok(fairness.limitations.some(line => line.includes("系统不会自动执行")));
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/fairness`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/fairness`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/fairness`, "GET", undefined, undefined, 401);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "读取公平规则包不得改变原始汇总");
  // 赛前自检与赛后只读复用清单：只看本人队伍自己的事实。
  const checklists = (await http<{ preEvent: { items: { id: string }[]; total: number; ready: number }; postEvent: { entries: { kind: string }[]; published: boolean } }>(
    app, `competitions/${event.eventId}/my-checklists?teamId=${team.id}`, "GET", entrant)).data;
  assert.equal(checklists.preEvent.items.length, 7);
  assert.equal(checklists.preEvent.total, 5);
  assert.equal(checklists.postEvent.published, true);
  assert.deepEqual(checklists.postEvent.entries.slice(0, 2).map(entry => entry.kind), ["receipt", "rules"]);
  await http(app, `competitions/${event.eventId}/my-checklists?teamId=${team.id}`, "GET", judge, undefined, 403);
  await http(app, `competitions/${event.eventId}/my-checklists?teamId=${team.id}`, "GET", undefined, undefined, 401);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM ej_intake_receipts WHERE event_id=$1", [event.eventId])).rows[0]?.count, 1, "读取自检与复用清单不得写入任何事实");
  assert.equal((await database.query("SELECT id FROM ej_intake_receipts WHERE event_id=$1", [event.eventId])).rowCount, 1);
  assert.equal((await database.query("SELECT id FROM organizer_relationship_reviews WHERE event_id=$1", [event.eventId])).rowCount, 1);
  // 规划33 P05/P06/P08 根接线验收：与各模块自己的读数逐一相等，且不新增第二份事实。
  const progress = (await http<{ status: string; rows: { submittedCount: number; requiredJudges: number }[]; judges: { judgeUserId: string; submittedCount: number }[] }>(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/progress`, "GET", owner)).data;
  assert.equal(progress.status, "complete");
  assert.equal(progress.rows[0]?.submittedCount, 1);
  assert.equal(progress.rows[0]?.requiredJudges, 1);
  assert.equal(progress.judges.find(item => item.judgeUserId === judge.profile.id)?.submittedCount, 1, "评审进度的已提交数必须与校准视图同一口径");
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/progress`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/progress`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/progress`, "GET", undefined, undefined, 401);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "读取评审进度不得改变原始汇总");
  const resultsCsv = (await http<{ filename: string; csv: string }>(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/results-export`, "GET", owner)).data;
  assert.equal(resultsCsv.filename, "judging-results.csv");
  assert.ok(!resultsCsv.csv.includes(judge.profile.id), "对外留档件不得包含评委账号");
  assert.ok(resultsCsv.csv.includes("80"), "对外留档件逐行与公开结果投影一致");
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/results-export`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/rounds/${locked.id}/results-export`, "GET", undefined, undefined, 401);
  const ownSummary = (await http<{ deadlines: unknown[]; announcements: { total: number }; ruleVersion: number | null }>(app, `competitions/${event.eventId}/my-summary`, "GET", entrant)).data;
  assert.ok(Array.isArray(ownSummary.deadlines));
  await http(app, `competitions/${event.eventId}/my-summary`, "GET", judge, undefined, 403);
  await http(app, `competitions/${event.eventId}/my-summary`, "GET", undefined, undefined, 401);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM ej_intake_receipts WHERE event_id=$1", [event.eventId])).rows[0]?.count, 1, "进度、导出与选手汇总都是只读");
  // P05 复制上一场：只产出新草稿，来源逐字段不变，草稿不进公开目录。
  const sourceBefore = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "GET", owner)).data;
  const currentOrganization = (await http<Organization[]>(app, "organizer/organizations", "GET", owner)).data.find(item => item.id === sourceBefore.organizationId)!;
  await http(app, `organizer/events/${event.eventId}/duplicate`, "POST", undefined, { expectedOrganizationRevision: currentOrganization.revision }, 401);
  await http(app, `organizer/events/${event.eventId}/duplicate`, "POST", judge, { expectedOrganizationRevision: currentOrganization.revision }, 403);
  const duplicated = (await http<{ event: HostedEvent; skipped: Record<string, string> }>(app, `organizer/events/${event.eventId}/duplicate`, "POST", owner, { expectedOrganizationRevision: currentOrganization.revision, includeRegistrationForm: true, includeJudgingConfig: true })).data;
  assert.notEqual(duplicated.event.eventId, sourceBefore.eventId);
  assert.equal(duplicated.event.status, "draft");
  assert.equal(duplicated.event.publishedRevision, null);
  assert.notEqual(duplicated.event.startsAt, sourceBefore.startsAt, "副本时间平移到当前时刻，不沿用上一届的绝对时间");
  const sourceAfter = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "GET", owner)).data;
  assert.equal(sourceAfter.revision, sourceBefore.revision, "复制不得改动来源赛事");
  assert.equal(sourceAfter.publishedRevision, sourceBefore.publishedRevision);
  assert.equal(sourceAfter.title, sourceBefore.title);
  const directory = await http<unknown>(app, "competitions");
  assert.ok(!JSON.stringify(directory.data ?? []).includes(duplicated.event.eventId), "未发布的草稿不得出现在公开赛事目录");
  // 规划33 P07 根接线：看板口径必须与既有报名计数逐一相等，且只读、不改结果。
  const dashboard = (await http<{ panels: { panel: string; metrics: { key: string; value: number | undefined }[] }[] }>(app, `organizer/events/${event.eventId}/dashboard?panel=registration`, "GET", owner)).data;
  assert.equal(dashboard.panels.length, 1); assert.equal(dashboard.panels[0]?.panel, "registration");
  const countsNow = (await http<{ pending: number; counts: { approved: number } }>(app, `organizer/events/${event.eventId}/registration-counts`, "GET", owner)).data;
  assert.equal(dashboard.panels[0]?.metrics.find(metric => metric.key === "pending")?.value, countsNow.pending, "看板的待审核数必须等于既有报名计数");
  assert.equal(dashboard.panels[0]?.metrics.find(metric => metric.key === "approved")?.value, countsNow.counts.approved, "看板的已通过数必须等于既有报名计数");
  await http(app, `organizer/events/${event.eventId}/dashboard?panel=registration`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/dashboard?panel=logistics`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/dashboard?panel=registration`, "GET", undefined, undefined, 401);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "读取看板不得改变原始汇总");
  // 规划33 P09 根接线：默认不公开；只有本人明确选择后才对本场主办方可见；绝不改分数与名次。
  const closureBefore = (await http<{ outcomes: { intake: { count: number }; published: unknown[] }; contactWillingness: unknown[] }>(app, `organizer/events/${event.eventId}/closure`, "GET", owner)).data;
  assert.equal(closureBefore.outcomes.intake.count, 1, "赛后成果清单只数正式收件");
  assert.ok(closureBefore.outcomes.published.length >= 1, "赛后清单只列已公布版本");
  assert.deepEqual(closureBefore.contactWillingness, [], "默认不公开：队伍选择前主办方看不到任何联系意愿");
  await http(app, `organizer/events/${event.eventId}/closure`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/closure`, "GET", undefined, undefined, 401);
  await http(app, `competitions/${event.eventId}/contact-willingness?teamId=${team.id}`, "GET", undefined, undefined, 401);
  await http(app, `competitions/${event.eventId}/contact-willingness?teamId=${team.id}`, "GET", judge, undefined, 403);
  const willingness = (await http<{ id: string; willing: boolean; authorUserId: string; status: string }>(app, `competitions/${event.eventId}/contact-willingness`, "POST", entrant, { teamId: team.id, willing: true, idempotencyKey: "contact-first" })).data;
  assert.equal(willingness.willing, true); assert.equal(willingness.authorUserId, entrant.profile.id);
  assert.equal((await http<{ id: string }>(app, `competitions/${event.eventId}/contact-willingness`, "POST", entrant, { teamId: team.id, willing: true, idempotencyKey: "contact-first" })).data.id, willingness.id, "同一重试标识幂等");
  assert.deepEqual((await http<{ contactWillingness: { teamId: string }[] }>(app, `organizer/events/${event.eventId}/closure`, "GET", owner)).data.contactWillingness.map(item => item.teamId), [team.id], "只有本人选择后才对本场主办方可见");
  await http(app, `competitions/${event.eventId}/contact-willingness/${willingness.id}/withdraw`, "POST", judge, { expectedRevision: 1 }, 403);
  const withdrawn = (await http<{ status: string; revision: number }>(app, `competitions/${event.eventId}/contact-willingness/${willingness.id}/withdraw`, "POST", entrant, { expectedRevision: 1 })).data;
  assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.revision, 2);
  assert.deepEqual((await http<{ contactWillingness: unknown[] }>(app, `organizer/events/${event.eventId}/closure`, "GET", owner)).data.contactWillingness, [], "撤回后主办方侧不再显示");
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "提交联系意愿不得改变分数或名次");
  // 规划34 D1 根接线：参赛名录默认关闭；只有主办方开启且调用者是本场参赛者才可读。
  await http(app, `competitions/${event.eventId}/participants`, "GET", undefined, undefined, 401);
  await http(app, `competitions/${event.eventId}/participants`, "GET", entrant, undefined, 403);
  const beforeEnable = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "GET", owner)).data;
  const communityOn = { workShowcase: true, peerFeedback: true, peerReview: false, peerReviewScale: "1-5", peerReviewDimensions: [], peerReviewPassRate: 0.3, commentMaxLength: 500, participantDirectory: true, connections: false, directMessages: false, directMessageRetention: "freeze", directMessagePurgeDays: null };
  const enabledEvent = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "PATCH", owner, { title: beforeEnable.title, timezone: beforeEnable.timezone, startsAt: beforeEnable.startsAt, endsAt: beforeEnable.endsAt, registrationOpensAt: beforeEnable.registrationOpensAt, registrationClosesAt: beforeEnable.registrationClosesAt, submissionClosesAt: beforeEnable.submissionClosesAt, modules: beforeEnable.modules, registration: beforeEnable.registration, teams: beforeEnable.teams, community: communityOn, summary: beforeEnable.summary, rules: beforeEnable.rules, location: beforeEnable.location, expectedRevision: beforeEnable.revision })).data;
  await http(app, `organizer/events/${event.eventId}/publish`, "POST", owner, { expectedRevision: enabledEvent.revision, changeSummary: "开启本场参赛名录" });
  const participantDirectory = (await http<{ enabled: boolean; entries: { userId: string }[]; teams: { id: string }[]; limitations: string[] }>(app, `competitions/${event.eventId}/participants`, "GET", entrant)).data;
  assert.equal(participantDirectory.enabled, true);
  assert.deepEqual(participantDirectory.entries.map(item => item.userId), [], "本场还没有人发布名片，名录不补占位");
  assert.ok(participantDirectory.teams.some(team => team.id === participantDirectory.teams[0]!.id));
  await http(app, `competitions/${event.eventId}/participants`, "GET", judge, undefined, 403);
  assert.ok(!JSON.stringify(participantDirectory).includes("@organizer-acceptance.example.test"), "名录不得泄露邮箱");
  // 规划34：公开与社区的非法组合必须被拒绝（不静默放宽）；配置随正式版本冻结。
  const afterEnable = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "GET", owner)).data;
  await http(app, `organizer/events/${event.eventId}`, "PATCH", owner, { title: afterEnable.title, timezone: afterEnable.timezone, startsAt: afterEnable.startsAt, endsAt: afterEnable.endsAt, registrationOpensAt: afterEnable.registrationOpensAt, registrationClosesAt: afterEnable.registrationClosesAt, submissionClosesAt: afterEnable.submissionClosesAt, modules: afterEnable.modules, registration: afterEnable.registration, teams: afterEnable.teams, community: { ...communityOn, directMessages: true, connections: false }, summary: afterEnable.summary, rules: afterEnable.rules, location: afterEnable.location, expectedRevision: afterEnable.revision }, 422);
  const frozenPreview = (await http<{ changedFields: string[] }>(app, `organizer/events/${event.eventId}/preview`, "GET", owner)).data;
  assert.ok(!frozenPreview.changedFields.includes("community"), "刚发布过的公开与社区配置不应显示为待发布变化");
  // 规划34：复制上一场产出的新草稿，其「公开与社区」必须回到默认全关（默认关是宪法 XIII 的硬要求）。
  const duplicatedFull = (await http<HostedEvent>(app, `organizer/events/${duplicated.event.eventId}`, "GET", owner)).data;
  const duplicatedCommunity = duplicatedFull.community ?? { workShowcase: undefined };
  assert.equal(duplicatedCommunity.workShowcase, false);
  assert.equal(duplicatedCommunity.participantDirectory, false);
  assert.equal(duplicatedCommunity.connections, false);
  assert.equal(duplicatedCommunity.directMessages, false);
  assert.equal(duplicatedCommunity.peerReview, false);
  // 规划34 P4 根接线（助手目录）：未登录 401、非本场工作人员 403、只列拥有对应能力的助手、非 GET 405。
  await http(app, `organizer/events/${event.eventId}/module-assistants`, "GET", undefined, undefined, 401);
  await http(app, `organizer/events/${event.eventId}/module-assistants`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/module-assistants`, "GET", entrant, undefined, 403);
  const assistants = (await http<{ eventId: string; entries: { key: string; requiredCapability: string }[] }>(app, `organizer/events/${event.eventId}/module-assistants`, "GET", owner)).data;
  assert.equal(assistants.eventId, event.eventId);
  assert.equal(assistants.entries.length, 7, "B1+B2：7 个流程模块助手全部接入只读事实来源");
  assert.ok(assistants.entries.some(entry => entry.key === "judging" && entry.requiredCapability === "judging_manage"));
  await http(app, `organizer/events/${event.eventId}/module-assistants`, "POST", owner, {}, 405);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM ej_intake_receipts WHERE event_id=$1", [event.eventId])).rows[0]?.count, 1, "读取助手目录不得写入任何事实");
  // 规划34 P2 根接线（作品展示）：未开启时 403；开启后路由与权限正确，且不改变任何评审事实。
  const worksPublic = (await http<{ items: unknown[] }>(app, `competitions/${event.eventId}/works/public`, "GET", undefined)).data;
  assert.ok(Array.isArray(worksPublic.items), "公开（含访客）入口无需登录");
  await http(app, `competitions/${event.eventId}/works`, "GET", undefined, undefined, 401);
  const staffWorks = (await http<{ items: unknown[]; notDisclosedTeamCount: number }>(app, `organizer/events/${event.eventId}/judging/works`, "GET", owner)).data;
  assert.ok(Array.isArray(staffWorks.items)); assert.equal(staffWorks.notDisclosedTeamCount, 1, "未公开的队伍只计数、不显示身份");
  await http(app, `organizer/events/${event.eventId}/judging/works`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/judging/works`, "GET", undefined, undefined, 401);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "读取作品展示不得改变原始汇总");
  // 规划34 P3 根接线（受限邀请）：单次使用、绑已验证邮箱、领取只写既有 StaffGrant、列表不回显 token。
  const invitation = (await http<{ invitation: { id: string; status: string }; token: string }>(app, `organizer/organizations/${event.organizationId}/staff-invitations`, "POST", owner, { role: "staff", capabilities: ["judging_manage"], expiresInDays: 7, boundEmail: judge.profile.email })).data;
  assert.ok(typeof invitation.token === "string" && invitation.token.length > 10);
  assert.equal(invitation.invitation.status, "open");
  const invitationList = (await http<unknown>(app, `organizer/organizations/${event.organizationId}/staff-invitations`, "GET", owner)).data;
  assert.ok(!JSON.stringify(invitationList).includes(invitation.token), "列表不得回显邀请 token");
  await http(app, `my/staff-invitations/${invitation.token}`, "GET", undefined, undefined, 401);
  const invitationPreview = (await http<{ status: string }>(app, `my/staff-invitations/${invitation.token}`, "GET", judge)).data;
  assert.equal(invitationPreview.status, "open");
  const claimedInvitation = (await http<{ invitation: { status: string }; grant: { capabilities: string[] } }>(app, `my/staff-invitations/${invitation.token}/claim`, "POST", judge, {})).data;
  assert.equal(claimedInvitation.invitation.status, "claimed");
  assert.deepEqual([...claimedInvitation.grant.capabilities], ["judging_manage"]);
  await http(app, `my/staff-invitations/${invitation.token}/claim`, "POST", judge, {}, 409);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM organizer_staff_grants WHERE user_id=$1 AND event_id IS NULL", [judge.profile.id])).rows[0]?.count, 1, "领取只写既有 StaffGrant，且恰好一条");
  // 规划34 P4 根接线（助手运行）：未配置模型时如实降级、人工流程照常；B1 之外的助手与越权都被拒。
  await http(app, `organizer/events/${event.eventId}/module-assistants/judging`, "POST", undefined, { instruction: "汇总" }, 401);
  await http(app, `organizer/events/${event.eventId}/module-assistants/judging`, "POST", entrant, { instruction: "汇总" }, 403);
  await http(app, `organizer/events/${event.eventId}/module-assistants/not-a-module`, "POST", owner, { instruction: "汇总" }, 403);
  await http(app, `organizer/events/${event.eventId}/module-assistants/judging`, "GET", owner, undefined, 405);
  const assistantRun = (await http<{ status: string; reason: string; manualWorkflowUnaffected: boolean; provider: string }>(app, `organizer/events/${event.eventId}/module-assistants/judging`, "POST", owner, { instruction: "汇总当前收件与评审进度" })).data;
  assert.equal(assistantRun.status, "degraded");
  assert.equal(assistantRun.reason, "model_unavailable");
  assert.equal(assistantRun.manualWorkflowUnaffected, true);
  assert.equal(assistantRun.provider, "dsh");
  const teamsRun = (await http<{ status: string; reason: string; usage: { readScope: { factKeys: readonly string[]; missing: readonly string[] } } }>(app, `organizer/events/${event.eventId}/module-assistants/teams`, "POST", owner, { instruction: "汇总本场队伍情况" })).data;
  assert.equal(teamsRun.status, "degraded");
  assert.ok(teamsRun.usage.readScope.factKeys.length > 0, "B2 助手必须真的读到声明过的只读事实键");
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "调用助手不得改变原始汇总");
  // 规划34 P6 根接线（选手社区）：默认全关 403；开启后仅本场报名已通过者可读，非参赛者 403。
  await http(app, `competitions/${event.eventId}/community`, "GET", undefined, undefined, 401);
  await http(app, `competitions/${event.eventId}/community`, "GET", entrant, undefined, 403);
  const beforeCommunity = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "GET", owner)).data;
  const communityLive = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "PATCH", owner, { title: beforeCommunity.title, timezone: beforeCommunity.timezone, startsAt: beforeCommunity.startsAt, endsAt: beforeCommunity.endsAt, registrationOpensAt: beforeCommunity.registrationOpensAt, registrationClosesAt: beforeCommunity.registrationClosesAt, submissionClosesAt: beforeCommunity.submissionClosesAt, modules: beforeCommunity.modules, registration: beforeCommunity.registration, teams: beforeCommunity.teams, community: { ...communityOn, connections: true, directMessages: true }, summary: beforeCommunity.summary, rules: beforeCommunity.rules, location: beforeCommunity.location, expectedRevision: beforeCommunity.revision })).data;
  await http(app, `organizer/events/${event.eventId}/publish`, "POST", owner, { expectedRevision: communityLive.revision, changeSummary: "开启选手社区连接与私信" });
  await http(app, `competitions/${event.eventId}/community`, "GET", entrant);
  await http(app, `competitions/${event.eventId}/community`, "GET", judge, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/community/reports`, "GET", entrant, undefined, 403);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "开启社区不得改变原始汇总");
  // 规划34 C② 根接线（文字留言）：先由队伍本人公开作品，然后留言可读；匿名 401、非参赛者 403，且不影响汇总。
  const disclosure = (await http<{ scope: string }>(app, `competitions/${event.eventId}/works/${team.id}/disclosure`, "POST", entrant, { scope: "participants", fields: { title: true, description: true }, idempotencyKey: "disclose-first" })).data;
  assert.equal(disclosure.scope, "participants");
  const comments = (await http<{ items: unknown[] }>(app, `competitions/${event.eventId}/works/${receipt.id}/comments`, "GET", entrant)).data;
  assert.ok(Array.isArray(comments.items), "作品公开后本场参赛者可以读到留言区（当前为空）");
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/comments`, "GET", undefined, undefined, 401);
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/comments`, "GET", judge, undefined, 403);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "留言不得改变原始汇总");
  // 规划34 C② 根接线（留言写路径与治理）：发表、举报、隐藏都要可用，且都不改变原始汇总。
  const postedComment = (await http<{ id: string }>(app, `competitions/${event.eventId}/works/${receipt.id}/comments`, "POST", entrant, { text: "这个方向挺有意思，想看看更多细节。", idempotencyKey: "comment-first" })).data;
  assert.ok(postedComment.id);
  const afterPost = (await http<{ totalCount: number }>(app, `competitions/${event.eventId}/works/${receipt.id}/comments`, "GET", entrant)).data;
  assert.equal(afterPost.totalCount, 1);
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/comments/${postedComment.id}/report`, "POST", undefined, { reason: "x" }, 401);
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/comments/${postedComment.id}/report`, "POST", judge, { reason: "x" }, 403);
  const reportedComment = (await http<{ reportedCount: number }>(app, `competitions/${event.eventId}/works/${receipt.id}/comments/${postedComment.id}/report`, "POST", entrant, { reason: "需要主办方看看" })).data;
  assert.equal(reportedComment.reportedCount, 1);
  // 注：`judge` 在 P3 段已领到本场 `judging_manage`，属正当工作人员，隐藏返回 200 是正确的；这里只断言匿名与越权读取。
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/comments/${postedComment.id}/hide`, "POST", entrant, { reason: "作者撤回" });
  const afterHide = (await http<{ hiddenCount: number; items: readonly { readonly id: string; readonly text: string | null }[] }>(app, `competitions/${event.eventId}/works/${receipt.id}/comments`, "GET", entrant)).data;
  assert.equal(afterHide.hiddenCount, 1);
  assert.equal(afterHide.items.find(item => item.id === postedComment.id)?.text ?? null, null, "隐藏后正文不再返回");
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "留言与隐藏都不得改变原始汇总");
  // 规划34 P7 根接线（数值互评）：未登录 401；开启后未达门槛**不出任何汇总**；去自评；不影响评审汇总。
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/peer-review`, "GET", undefined, undefined, 401);
  const beforePeer = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "GET", owner)).data;
  const peerLive = (await http<HostedEvent>(app, `organizer/events/${event.eventId}`, "PATCH", owner, { title: beforePeer.title, timezone: beforePeer.timezone, startsAt: beforePeer.startsAt, endsAt: beforePeer.endsAt, registrationOpensAt: beforePeer.registrationOpensAt, registrationClosesAt: beforePeer.registrationClosesAt, submissionClosesAt: beforePeer.submissionClosesAt, modules: beforePeer.modules, registration: beforePeer.registration, teams: beforePeer.teams, community: { ...communityOn, connections: true, directMessages: true, peerReview: true, peerReviewDimensions: [{ id: "originality", label: "原创性" }] }, summary: beforePeer.summary, rules: beforePeer.rules, location: beforePeer.location, expectedRevision: beforePeer.revision })).data;
  await http(app, `organizer/events/${event.eventId}/publish`, "POST", owner, { expectedRevision: peerLive.revision, changeSummary: "开启数值互评" });
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/peer-review`, "GET", judge, undefined, 403);
  const peerView = (await http<{ threshold: { code: string; met: boolean }; summary: unknown; canReview: boolean }>(app, `competitions/${event.eventId}/works/${receipt.id}/peer-review`, "GET", entrant)).data;
  assert.equal(peerView.threshold.met, false, "本场参与率未达门槛");
  assert.equal(peerView.threshold.code, "PEER_REVIEW_THRESHOLD_NOT_MET");
  assert.equal(peerView.summary, null, "未达门槛时不得给出任何汇总、平均分或人数");
  await http(app, `competitions/${event.eventId}/works/${receipt.id}/peer-review`, "POST", entrant, { values: { originality: 4 }, idempotencyKey: "peer-self" }, 403);
  assert.equal((await http<{ summary: ResultSummary }>(app, `organizer/events/${event.eventId}/judging/results/preview`, "POST", owner, { roundId: locked.id })).data.summary.rows[0]?.total, 80, "互评不得改变原始汇总");
  // 规划34 P4 根接线（赛事级助手开关）：默认全开、可逐项关闭、关闭后该助手不再可用、写既有审计，且**不进版本语义**。
  const switchesBefore = (await database.query<{ revision: number; published_revision: number | null }>("SELECT revision, published_revision FROM organizer_hosted_events WHERE id=$1", [event.eventId])).rows[0];
  const switches = (await http<{ switches: readonly { assistantKey: string; enabled: boolean; revision: number }[] }>(app, `organizer/events/${event.eventId}/module-assistant-switches`, "GET", owner)).data;
  assert.equal(switches.switches.length, 7, "开关集覆盖全部 7 个流程模块助手");
  assert.ok(switches.switches.every(item => item.enabled), "默认全开");
  await http(app, `organizer/events/${event.eventId}/module-assistant-switches`, "GET", entrant, undefined, 403);
  await http(app, `organizer/events/${event.eventId}/module-assistant-switches`, "GET", undefined, undefined, 401);
  const switchedOff = (await http<{ switches: readonly { assistantKey: string; enabled: boolean }[] }>(app, `organizer/events/${event.eventId}/module-assistant-switches`, "POST", owner, { assistantKey: "judging", enabled: false, expectedRevision: 0 })).data;
  assert.equal(switchedOff.switches.find(item => item.assistantKey === "judging")?.enabled, false);
  const directoryAfterSwitch = (await http<{ enabledAssistants: readonly string[] }>(app, `organizer/events/${event.eventId}/module-assistants`, "GET", owner)).data;
  assert.ok(!directoryAfterSwitch.enabledAssistants.includes("judging"), "关闭后目录不再把该助手列为可用");
  await http(app, `organizer/events/${event.eventId}/module-assistants/judging`, "POST", owner, { instruction: "汇总" }, 403);
  const switchesAfter = (await database.query<{ revision: number; published_revision: number | null }>("SELECT revision, published_revision FROM organizer_hosted_events WHERE id=$1", [event.eventId])).rows[0];
  assert.deepEqual(switchesAfter, switchesBefore, "助手开关是内部运营项，不改变赛事 revision / publishedRevision");
  assert.equal((await database.query("SELECT count(*)::int AS count FROM organizer_audit_events WHERE event_id=$1 AND action='assistant_switch_changed'", [event.eventId])).rows[0]?.count, 1, "每次改动写恰一条既有审计");
  // 规划35 P1 根接线（专属页）：规格保存 → 发布 → 公开只读 → 停用 404 → 恢复；权限与草稿隔离。
  await http(app, `organizer/events/${event.eventId}/page`, "GET", undefined, undefined, 401);
  await http(app, `organizer/events/${event.eventId}/page`, "GET", entrant, undefined, 403);
  const pageBefore = (await http<{ exists: boolean; revision: number; suggestedSpec: { blocks: unknown[] } | null }>(app, `organizer/events/${event.eventId}/page`, "GET", owner)).data;
  assert.equal(pageBefore.exists, false, "还没建过的页面返回 exists:false，并给默认模块集起点");
  assert.ok((pageBefore.suggestedSpec?.blocks.length ?? 0) > 0);
  const savedPage = (await http<{ revision: number; shortCode: string; status: string; findings: readonly unknown[] }>(app, `organizer/events/${event.eventId}/page`, "PUT", owner, { spec: pageBefore.suggestedSpec, expectedRevision: pageBefore.revision })).data;
  assert.equal(savedPage.status, "draft");
  assert.ok(savedPage.shortCode.length >= 8);
  const publishedPage = (await http<{ revision: number; publishedRevision: number }>(app, `organizer/events/${event.eventId}/page/publish`, "POST", owner, { expectedRevision: savedPage.revision })).data;
  assert.equal(publishedPage.publishedRevision, 1);
  assert.equal((await app.organizerIntegration.eventSite.publicPage(savedPage.shortCode)).eventId, event.eventId, "公开页读已发布快照");
  const suspendedPage = (await http<{ revision: number }>(app, `organizer/events/${event.eventId}/page/suspend`, "POST", owner, { expectedRevision: publishedPage.revision, kind: "organizer", reason: "临时下线" })).data;
  await assert.rejects(app.organizerIntegration.eventSite.publicPage(savedPage.shortCode), { code: "EVENT_SITE_PAGE_NOT_FOUND" }, "停用后公开页 404");
  await http(app, `organizer/events/${event.eventId}/page/resume`, "POST", owner, { expectedRevision: suspendedPage.revision });
  assert.equal((await app.organizerIntegration.eventSite.publicPage(savedPage.shortCode)).eventId, event.eventId, "恢复后公开页回来");
  await http(app, `organizer/events/${event.eventId}/page/publish`, "POST", entrant, { expectedRevision: suspendedPage.revision + 1 }, 403);
  // 规划35 P2 根接线（生成/建议）：未登录 401、非本场 403；未配置模型时**如实** 503 而不是假装成功。
  await http(app, `organizer/events/${event.eventId}/page/generate`, "POST", undefined, { intent: { eventTitle: "校园编程挑战赛", kind: "校园赛", audience: "在校大学生", emphasis: ["评审标准"], tone: "简洁", notes: "" } }, 401);
  await http(app, `organizer/events/${event.eventId}/page/suggestions`, "POST", undefined, { spec: pageBefore.suggestedSpec }, 401);
  await http(app, `organizer/events/${event.eventId}/page/generate`, "POST", entrant, { intent: { eventTitle: "校园编程挑战赛", kind: "校园赛", audience: "在校大学生", emphasis: ["评审标准"], tone: "简洁", notes: "" } }, 403);
  await http(app, `organizer/events/${event.eventId}/page/suggestions`, "POST", entrant, { spec: pageBefore.suggestedSpec }, 403);
  const generationAttempt = await http(app, `organizer/events/${event.eventId}/page/generate`, "POST", owner, { intent: { eventTitle: "校园编程挑战赛", kind: "校园赛", audience: "在校大学生", emphasis: ["评审标准"], tone: "简洁", notes: "" } }).catch((error: unknown) => error);
  assert.ok(generationAttempt instanceof Error, "测试环境没有配置模型，生成必须失败而不是伪造页面");
  assert.equal((await database.query("SELECT count(*)::int AS count FROM organizer_page_specs WHERE event_id=$1", [event.eventId])).rows[0]?.count, 1, "生成不落库：仍只有前面保存的那一条");
  // 规划35 P3 根接线（批注/组件编辑）：权限；空批注与未知容器在**不调模型**前就被拒。
  await http(app, `organizer/events/${event.eventId}/page/annotations`, "POST", undefined, { annotations: [] }, 401);
  await http(app, `organizer/events/${event.eventId}/page/annotations`, "POST", entrant, { annotations: [] }, 403);
  await http(app, `organizer/events/${event.eventId}/page/ai-blocks/nope/refine`, "POST", entrant, { instruction: "改一下" }, 403);
  await http(app, `organizer/events/${event.eventId}/page/annotations`, "POST", owner, { annotations: [] }, 422);
  await http(app, `organizer/events/${event.eventId}/page/ai-blocks/nope/refine`, "POST", owner, { instruction: "改一下" }, 404);
  // 规划35 P4 根接线（能力报告）：未登录 401；没有流式提供方时**如实**报告 false 并给出原因。
  await http(app, `organizer/events/${event.eventId}/page/ai-capability`, "GET", undefined, undefined, 401);
  const capability = (await http<{ model: boolean; stream: boolean; reason: string | null }>(app, `organizer/events/${event.eventId}/page/ai-capability`, "GET", owner)).data;
  assert.equal(capability.stream, false, "测试环境没有流式提供方，能力报告不能谎称支持");
  assert.equal(capability.model, false);
  assert.equal(typeof capability.reason, "string");
  // 规划35 P4（版本回退）：历史可见、回退产生新草稿版本、线上快照不受影响。
  await http(app, `organizer/events/${event.eventId}/page/revisions`, "GET", undefined, undefined, 401);
  const revisions = (await http<{ revisions: readonly { revision: number }[]; truncated: boolean }>(app, `organizer/events/${event.eventId}/page/revisions`, "GET", owner)).data;
  assert.ok(revisions.revisions.length >= 1, "保存过草稿就应该有历史");
  const targetRevision = revisions.revisions[revisions.revisions.length - 1]!.revision;
  const beforeRestore = await app.organizerIntegration.eventSite.publicPage(savedPage.shortCode);
  const restored = (await http<{ revision: number }>(app, `organizer/events/${event.eventId}/page/revisions/${targetRevision}/restore`, "POST", owner, { expectedRevision: suspendedPage.revision + 1 })).data;
  assert.ok(restored.revision > suspendedPage.revision + 1, "回退必须产生新的草稿版本，不复用历史号");
  const afterRestore = await app.organizerIntegration.eventSite.publicPage(savedPage.shortCode);
  assert.equal(afterRestore.publishedRevision, beforeRestore.publishedRevision, "回退只改草稿，不动线上快照");
  // 规划35 方案 C（图片资产）：权限、类型闸门、去重、未发布图不公开长缓存。
  await http(app, `organizer/events/${event.eventId}/page/assets`, "POST", undefined, { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, 401);
  await http(app, `organizer/events/${event.eventId}/page/assets`, "POST", entrant, { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, 403);
  await http(app, `organizer/events/${event.eventId}/page/assets`, "POST", owner, { mimeType: "image/svg+xml", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, 422);
  // 声明的类型与字节魔数不一致（JPEG 的 FF D8 FF 冒充 PNG）。
  await http(app, `organizer/events/${event.eventId}/page/assets`, "POST", owner, { mimeType: "image/png", base64: "/9j/" }, 422);
  const uploaded = (await http<{ assetId: string; sha256: string; deduplicated: boolean }>(app, `organizer/events/${event.eventId}/page/assets`, "POST", owner, { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, 201)).data;
  assert.equal(uploaded.deduplicated, false);
  assert.equal(uploaded.sha256.length, 64);
  const uploadBody = (await http<{ size: { width: number; height: number } | null; suggestion: { aspect: string } | null }>(app, `organizer/events/${event.eventId}/page/assets`, "POST", owner, { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, 201)).data;
  assert.deepEqual(uploadBody.size, { width: 1, height: 1 }, "只读文件头拿宽高");
  assert.equal(uploadBody.suggestion?.aspect, "1:1", "方图建议 1:1");
  const again = (await http<{ assetId: string; deduplicated: boolean }>(app, `organizer/events/${event.eventId}/page/assets`, "POST", owner, { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, 201)).data;
  assert.equal(again.assetId, uploaded.assetId, "同赛事按内容去重");
  assert.equal(again.deduplicated, true);
  const assetResponse = await dispatch(app, new Request(`http://local/api/v1/page-assets/${uploaded.assetId}`), ["page-assets", uploaded.assetId]);
  assert.equal(assetResponse?.status, 200);
  assert.equal(assetResponse?.headers.get("Content-Type"), "image/png");
  assert.equal(assetResponse?.headers.get("Cache-Control"), "private, no-store", "未发布的图不能长缓存");
  assert.equal(assetResponse?.headers.get("X-Content-Type-Options"), "nosniff");
  // 规划35 P6（机构模板库）：权限、存模板、跨赛事套用、删除。
  const orgQuery = `?organizationId=${event.organizationId}`;
  await http(app, "organizer/page-templates" + orgQuery, "GET", undefined, undefined, 401);
  await http(app, "organizer/page-templates" + orgQuery, "GET", entrant, undefined, 403);
  assert.equal((await http<{ items: readonly unknown[] }>(app, "organizer/page-templates" + orgQuery, "GET", owner)).data.items.length, 0);
  const savedTemplate = (await http<{ template: { id: string } }>(app, "organizer/page-templates" + orgQuery, "POST", owner, { name: "校园赛标准页", spec: pageBefore.suggestedSpec })).data;
  assert.ok(savedTemplate.template.id.length > 0);
  const templates = (await http<{ items: readonly { id: string; name: string }[] }>(app, "organizer/page-templates" + orgQuery, "GET", owner)).data;
  assert.equal(templates.items.length, 1);
  assert.equal(templates.items[0]!.name, "校园赛标准页");
  const currentRevision = restored.revision;
  await http(app, `organizer/events/${event.eventId}/page/apply-template`, "POST", owner, { templateId: savedTemplate.template.id, expectedRevision: currentRevision });
  await http(app, `organizer/page-templates/${savedTemplate.template.id}` + orgQuery, "DELETE", owner);
  assert.equal((await http<{ items: readonly unknown[] }>(app, "organizer/page-templates" + orgQuery, "GET", owner)).data.items.length, 0);
  // 规划35 §6.5 流式生成：注入假流式端口才能真实驱动；生产环境按能力如实 409。
  const fakeStream = {
    modelVersion: "fake-stream-1",
    async *streamText(request: { readonly onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void }) {
      request.onUsage?.({ inputTokens: 12, outputTokens: 34 });
      const spec = JSON.stringify({ version: 1, blocks: [
        { kind: "richText", id: "gen-b1", variant: "prose", priority: 3, collapse: false, heading: "公告", text: "流式生成的一段话", items: [], image: null, binding: null },
        { kind: "faq", id: "gen-b2", variant: "accordion", priority: 3, collapse: false, heading: null, text: null, items: [], image: null, binding: { source: "eventFaq", field: "faqEntries" } },
      ] });
      for (let index = 0; index < spec.length; index += 5) yield spec.slice(index, index + 5);
    },
  };
  const streamingApp = await createApplication({ mode: "local", origin, codePepper: "organizer-router-fixture-pepper-at-least-32-bytes", emailFrom: "fixture@localhost.invalid" }, database, { aiStreamModel: fakeStream });
  await http(streamingApp, `organizer/events/${event.eventId}/page/generate/stream`, "POST", undefined, { intent: { eventTitle: "校园编程挑战赛", kind: "校园赛", audience: "在校大学生", emphasis: ["评审标准"], tone: "简洁", notes: "" } }, 401);
  await http(streamingApp, `organizer/events/${event.eventId}/page/generate/stream`, "POST", entrant, { intent: { eventTitle: "校园编程挑战赛", kind: "校园赛", audience: "在校大学生", emphasis: ["评审标准"], tone: "简洁", notes: "" } }, 403);
  await http(streamingApp, `organizer/events/${event.eventId}/page/generate/stream`, "POST", owner, { intent: { eventTitle: "x", kind: "未知类型", audience: "y", emphasis: [], tone: "z", notes: "" } }, 422);
  assert.equal((await http<{ stream: boolean }>(streamingApp, `organizer/events/${event.eventId}/page/ai-capability`, "GET", owner)).data.stream, true, "注入了流式端口，能力报告就该是 true");
  const streamResponse = await dispatch(streamingApp, new Request(`${origin}/api/v1/organizer/events/${event.eventId}/page/generate/stream`, {
    method: "POST", headers: { origin, "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ intent: { eventTitle: "校园编程挑战赛", kind: "校园赛", audience: "在校大学生", emphasis: ["评审标准"], tone: "简洁", notes: "" } }),
  }), ["organizer", "events", event.eventId, "page", "generate", "stream"]);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("Content-Type") ?? "", /text\/event-stream/);
  const sse = await streamResponse.text();
  assert.equal(sse.split("event: block").length - 1, 2, "两块各推一次");
  assert.ok(sse.includes("event: done"), "结束事件带最终规格");
  assert.ok(sse.includes("gen-b2"), "推送的是真实解析出的区块，不是原始 token");
  // 规划35 §6.5：流式也进既有账本——执行行成功、用量按最终值结算。
  const streamAttempts = (await database.query<{ status: string; input_tokens: number; output_tokens: number }>(
    "SELECT a.status,a.input_tokens,a.output_tokens FROM ai_usage_attempts a JOIN ai_execution_jobs j ON j.id=a.execution_id WHERE j.kind='page_builder_stream'")).rows;
  assert.equal(streamAttempts.length, 1, "流式调用必须留下一条用量尝试");
  assert.equal(streamAttempts[0]!.status, "settled");
  assert.equal(streamAttempts[0]!.input_tokens, 12, "按提供方给的最终用量结算");
  assert.equal(streamAttempts[0]!.output_tokens, 34);
  assert.equal((await database.query<{ status: string }>("SELECT status FROM ai_execution_jobs WHERE kind='page_builder_stream'")).rows[0]?.status, "succeeded");
  // 规划35 P6：复制赛事要带上页面规格（新短码、不带线上快照）。
  const orgNow = (await http<Organization[]>(app, "organizer/organizations", "GET", owner)).data.find(item => item.id === event.organizationId)!;
  const cloned = (await http<{ event: HostedEvent }>(app, `organizer/events/${event.eventId}/duplicate`, "POST", owner, { expectedOrganizationRevision: orgNow.revision })).data;
  const clonedPage = (await http<{ exists: boolean; shortCode: string | null; spec: unknown; published: unknown }>(app, `organizer/events/${cloned.event.eventId}/page`, "GET", owner)).data;
  assert.equal(clonedPage.exists, true, "复制赛事要带上页面规格");
  assert.ok(clonedPage.spec !== null, "副本的草稿来自源赛事");
  assert.ok(clonedPage.shortCode !== null && clonedPage.shortCode !== savedPage.shortCode, "副本用新短码，不复用旧链接");
  assert.equal(clonedPage.published, null, "副本不继承线上快照");
  // 规划35 §19.4：编辑器只要一个输入框，赛事名由根提供。
  await http(app, `organizer/events/${event.eventId}/page/context`, "GET", undefined, undefined, 401);
  await http(app, `organizer/events/${event.eventId}/page/context`, "GET", entrant, undefined, 403);
  const pageContext = (await http<{ eventTitle: string; organizerName: string }>(app, `organizer/events/${event.eventId}/page/context`, "GET", owner)).data;
  assert.ok(pageContext.eventTitle.length > 0, "赛事名必须来自根，不让主办方重填");
  // 规划35：编辑器预览与公开页共用同一份只读事实。
  await http(app, `organizer/events/${event.eventId}/page/facts`, "GET", undefined, undefined, 401);
  await http(app, `organizer/events/${event.eventId}/page/facts`, "GET", entrant, undefined, 403);
  const previewFacts = (await http<{ registrationCloses: string | null; scheduleNodes: readonly unknown[]; faqEntries: readonly unknown[] }>(app, `organizer/events/${event.eventId}/page/facts`, "GET", owner)).data;
  assert.ok("registrationCloses" in previewFacts && Array.isArray(previewFacts.scheduleNodes) && Array.isArray(previewFacts.faqEntries));
  assert.equal((await database.query("SELECT id FROM m06_submission_heads")).rowCount, 0);
  const migrations = (await database.query<{ id: string }>("SELECT id FROM application_migrations WHERE id>='042' ORDER BY id")).rows.map(item => item.id);
  assert.ok(migrations.some(id => id.startsWith("047"))); assert.ok(migrations.some(id => id.startsWith("049"))); assert.ok(migrations.some(id => id.startsWith("050")));
});

test("真实根专属入选通知模板、发布、本人收件与只读队列状态", async t => {
  const { app, database } = await fixture(t);
  const admin=await register(app,"notice-admin"),owner=await register(app,"notice-owner"),entrant=await register(app,"notice-entrant"),other=await register(app,"notice-other");
  await promoteAdmin(app,admin);
  const {event,form}=await createCompetition(app,admin,owner,"入选通知比赛");
  await enterAndLock(app,entrant,event,form);
  const registration=(await http<{registration:Registration}>(app,`competitions/${event.eventId}/my-registration`,"GET",entrant)).data.registration;
  const template=(await http<{revision:number}>(app,`organizer/events/${event.eventId}/selection-notice-template`,"PUT",owner,{expectedRevision:0,subject:"{name}，你已入选 {event}",body:"请查看本场安排。{organizer}",accent:"blue",theme:"letter"})).data;
  const input={recipientUserId:entrant.profile.id,expectedRegistrationRevision:registration.revision,templateRevision:template.revision,expectedNoticeVersion:0};
  const notice=(await http<{id:string;mailState:string;subject:string}>(app,`organizer/events/${event.eventId}/selection-notices`,"POST",owner,input)).data;
  assert.equal(notice.mailState,"unconfigured");assert.match(notice.subject,/notice-entrant/);
  assert.equal((await http<{id:string}>(app,`organizer/events/${event.eventId}/selection-notices`,"POST",owner,input)).data.id,notice.id);
  const own=(await http<{items:{id:string}[];registrationStatus:string}>(app,`competitions/${event.eventId}/selection-notices`,"GET",entrant)).data;
  assert.equal(own.registrationStatus,"approved");assert.equal(own.items[0].id,notice.id);
  await http(app,`competitions/${event.eventId}/selection-notices`,"GET",other,undefined,404);
  await http(app,`competitions/${event.eventId}/selection-notices`,"GET",undefined,undefined,401);
  await http(app,`organizer/events/${event.eventId}/selection-notice-template`,"PUT",other,{expectedRevision:1,subject:"无权编辑",body:"不能写入",accent:"blue",theme:"letter"},403);
  await http(app,`organizer/events/${event.eventId}/selection-notices`,"POST",owner,input,403,"https://other.example.test");
  assert.equal((await database.query("SELECT id FROM organizer_notification_outbox")).rowCount,0,"real notifications never fall back to the development mailbox");
  await http(app,"admin/organizer/notification-status","GET",entrant,undefined,403);
  const before=(await database.query("SELECT id FROM organizer_selection_notices")).rowCount;
  assert.equal((await http<{configured:boolean}>(app,"admin/organizer/notification-status","GET",admin)).data.configured,false);
  await app.organizerNotifications.drain();assert.equal((await database.query("SELECT id FROM organizer_selection_notices")).rowCount,before);
});

test("真实根明确规则关联与当前发布版本装饰；撤回/更新不沿用关联", async t => {
  const {app,database}=await fixture(t),admin=await register(app,"rules-admin"),owner=await register(app,"rules-owner");await promoteAdmin(app,admin);
  const {event}=await createCompetition(app,admin,owner,"规则关联比赛"),at=new Date().toISOString();
  await app.eventsRepository.transaction(async tx=>{await tx.saveEvent({id:"linked-rules",revision:1,publicationStatus:"published",candidateVersion:1,publishedVersion:1,lastVerifiedAt:at},0);await tx.insertRules({eventId:"linked-rules",version:1,createdAt:at,metadata:{name:"已审核本场规则",organizer:"规则机构",format:"online",region:"线上",officialUrl:"https://rules.example.test/"},sources:[],evidence:[],facts:[],stages:[],requirements:[],qualityFlags:[]});});
  const path=`admin/organizer/events/${event.eventId}/rule-link`;
  await http(app,path,"GET",owner,undefined,403);
  const choices=(await http<{eventId:string}[]>(app,`${path}/candidates?query=已审核`,"GET",admin)).data;assert.equal(choices[0].eventId,"linked-rules");
  await http(app,path,"PUT",admin,{expectedRevision:0,expectedHostedPublishedRevision:event.publishedRevision,linkedEventId:"linked-rules",rulesVersion:1,auditNote:"人工核查主办方正式规则与本场对应"});
  await database.transaction(async sql=>assert.equal((await app.organizerIntegration.events.getEvent(sql,event.eventId))?.linkedEventId,"linked-rules"));
  await http(app,path,"DELETE",admin,{expectedRevision:1,auditNote:"主办方请求撤回本次对应"});
  await database.transaction(async sql=>assert.equal((await app.organizerIntegration.events.getEvent(sql,event.eventId))?.linkedEventId,null));
  await http(app,path,"PUT",admin,{expectedRevision:2,expectedHostedPublishedRevision:event.publishedRevision,linkedEventId:"linked-rules",rulesVersion:1,auditNote:"再次人工核对正式版本"});
  await app.eventsRepository.transaction(async tx=>{const old=await tx.getEvent("linked-rules");assert.ok(old);await tx.saveEvent({...old,revision:2,publicationStatus:"archived"},1);});
  await database.transaction(async sql=>assert.equal((await app.organizerIntegration.events.getEvent(sql,event.eventId))?.linkedEventId,null));
  assert.equal((await http<{state:string}>(app,path,"GET",admin)).data.state,"stale");
});

test("真实根权限拒绝匿名、外部 Origin、多组织串赛、授权撤销、失效会话与陈旧平台管理员身份", async t => {
  const { app, database } = await fixture(t);
  const admin = await register(app, "security-admin"), ownerA = await register(app, "owner-a"), ownerB = await register(app, "owner-b"), entrant = await register(app, "security-entrant"), staff = await register(app, "security-staff");
  await promoteAdmin(app, admin);
  const a = await createCompetition(app, admin, ownerA, "组织A的赛事"), b = await createCompetition(app, admin, ownerB, "组织B的赛事");
  const team = await enterAndLock(app, entrant, a.event, a.form);
  const ticket = (await http<TicketView>(app, `competitions/${a.event.eventId}/help-tickets`, "POST", entrant, { question: "PRIVATE_HELP_CONTENT", visibility: "private" })).data;
  await http(app, "organizer/organizations", "GET", undefined, undefined, 401);
  await http(app, `competitions/${a.event.eventId}/my-registration`, "GET", undefined, undefined, 401);
  await http(app, `competitions/${a.event.eventId}/help-tickets/${ticket.id}`, "GET", undefined, undefined, 404);
  await http(app, `organizer/events/${a.event.eventId}/help-tickets/${ticket.id}`, "GET", ownerB, undefined, 403);
  await http(app, `organizer/events/${b.event.eventId}/help-tickets/${ticket.id}`, "GET", ownerB, undefined, 404);
  await http(app, `organizer/events/${b.event.eventId}/judging/relationship-review`, "POST", ownerB, { teamId: team.id, judgeUserId: staff.profile.id, status: "clear", note: "错误赛事不能核查其他比赛的队伍", expectedTeamRevision: team.revision }, 404);
  await http(app, `organizer/events/${a.event.eventId}/account-lookup`, "POST", ownerB, { email: entrant.profile.email }, 403);
  const before = (await database.query("SELECT id FROM organizer_relationship_reviews")).rowCount;
  await http(app, `organizer/events/${a.event.eventId}/judging/relationship-review`, "POST", ownerA, { teamId: team.id, judgeUserId: staff.profile.id, status: "clear", note: "外部 Origin 操作", expectedTeamRevision: team.revision }, 403, "https://external.example.test");
  assert.equal((await database.query("SELECT id FROM organizer_relationship_reviews")).rowCount, before);

  const currentOrg = (await http<Organization[]>(app, "organizer/organizations", "GET", ownerA)).data.find(item => item.id === a.organization.id)!;
  const grant = (await http<StaffGrant>(app, `organizer/organizations/${a.organization.id}/staff-grants`, "POST", ownerA, { expectedOrganizationRevision: currentOrg.revision, userId: staff.profile.id, eventId: a.event.eventId, role: "staff", capabilities: ["communication_manage"] })).data;
  assert.equal((await http<TicketView>(app, `organizer/events/${a.event.eventId}/help-tickets/${ticket.id}`, "GET", staff)).data.question, "PRIVATE_HELP_CONTENT");
  await http(app, `organizer/events/${b.event.eventId}/help-tickets`, "GET", staff, undefined, 403);
  await http(app, `organizer/staff-grants/${grant.id}/revoke`, "POST", ownerA, { expectedRevision: grant.revision });
  await http(app, `organizer/events/${a.event.eventId}/help-tickets/${ticket.id}`, "GET", staff, undefined, 403);
  const beforeTarget = (await database.query("SELECT id FROM organizer_staff_grants WHERE organization_id=$1", [a.organization.id])).rowCount;
  const latestOrganization = (await http<Organization[]>(app, "organizer/organizations", "GET", ownerA)).data.find(item => item.id === a.organization.id)!;
  await database.query("UPDATE auth_users SET status='suspended',revision=revision+1 WHERE id=$1", [staff.profile.id]);
  await http(app, `organizer/organizations/${a.organization.id}/staff-grants`, "POST", ownerA, { expectedOrganizationRevision: latestOrganization.revision, userId: staff.profile.id, eventId: a.event.eventId, role: "staff", capabilities: ["communication_manage"] }, 409);
  assert.equal((await database.query("SELECT id FROM organizer_staff_grants WHERE organization_id=$1", [a.organization.id])).rowCount, beforeTarget);
  assert.equal((await http<Organization[]>(app, "organizer/organizations", "GET", ownerA)).data.find(item => item.id === a.organization.id)?.revision, latestOrganization.revision, "an inactive target must roll back the organization revision and grant together");

  const cachedAdmin = await app.resolvePrincipal(new Request(`${origin}/api/v1/admin/organizer/applications`, { headers: { cookie: admin.cookie } })); assert.ok(cachedAdmin);
  await database.query("UPDATE auth_users SET platform_roles=ARRAY['user'],revision=revision+1 WHERE id=$1", [admin.profile.id]);
  await assert.rejects(app.organizerIntegration.organizer.listApplicationsForReview(cachedAdmin), { code: "UNAUTHENTICATED" });
  await http(app, "admin/organizer/applications", "GET", admin, undefined, 403);
  await database.query("UPDATE auth_users SET status='suspended',revision=revision+1 WHERE id=$1", [entrant.profile.id]);
  await http(app, `competitions/${a.event.eventId}/help-tickets/${ticket.id}`, "GET", entrant, undefined, 404);
  await http(app, "me/competitions", "GET", entrant, undefined, 401);
  await database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [ownerA.profile.id]);
  await http(app, `organizer/events/${a.event.eventId}/help-tickets`, "GET", ownerA, undefined, 401);
  assert.equal((await database.query("SELECT id FROM organizer_relationship_reviews")).rowCount, before);
  assert.equal((await database.query("SELECT id FROM ej_intake_receipts")).rowCount, 0);
});
