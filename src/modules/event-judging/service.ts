import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, isDomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { eventCommunity } from "../../shared/organizer-contracts.ts";
import type { OrganizerPrincipal, HostedEventAccessPort, HostedEventScope, EventParticipationPort, EventRosterTeamSnapshot, EventJudgeConflictPort, VerifiedEventSubmissionPort } from "../../shared/organizer-contracts.ts";
import type { SubmissionLinkContextPort } from "./ports.ts";
import type { IntakeReceipt, SubmissionMaterials, SubmissionInput, SubmissionPreview, JudgingRound, JudgingConfig, JudgeAssignment, ManualScore, ScoreInput, PublishInput, PublishedResults, ResultProjection, ResultSummary, JudgingWorkspace, JudgeWorkItem, JudgeRoundView, JudgeReceiptView, PublicationReview, ResultAppeal, AppealInput, AppealResolutionInput, AppealWindowView, WorkDisclosure, WorkDisclosureInput, WorkDisclosureWithdrawInput, WorkShowcaseList, OrganizerWorkShowcase, MyWorkDisclosure, WorkComment, WorkCommentInput, WorkCommentHideInput, WorkCommentReport, WorkCommentReportInput, WorkCommentReportReceipt, WorkCommentList, WorkCommentView } from "./model.ts";
import * as store from "./postgres.ts";
import { text, integer, invalid, materials, hash, config, scoreValues, aggregate, csvCell } from "./validation.ts";
import { calibration } from "./calibration.ts";
import type { CalibrationReport } from "./calibration.ts";
import { integrity } from "./integrity.ts";
import type { IntegrityReport } from "./integrity.ts";
import { progress } from "./progress.ts";
import type { ProgressReport } from "./progress.ts";
import { appealDeadline, appealIdempotencyKey, appealReason, appealRequestedOutcome, appealWindowDays, canFileAppeal, resolutionOf, resolveAppeal as resolveAppealRecord, withdrawAppeal as withdrawAppealRecord } from "./appeal.ts";
import { activeWorkDisclosure, latestReceiptOf, myWorkDisclosureView, sameWorkDisclosureChoice, workDisclosureFields, workDisclosureIdempotencyKey, workDisclosureRevision, workDisclosureScope, workDisclosureTeamId, workShowcaseEntries, workShowcaseLimitations, workShowcaseNotice, organizerWorkShowcaseNotice } from "./works.ts";
import { commentCooldownRemaining, commentCooldownSeconds, commentGate, commentHideReason, commentIdempotencyKey, commentLimit, commentPage, commentReportReason, commentText, commentView, commentViewerAccess, workCommentNotices, workCommentsLimitations, workCommentsNotice } from "./comments.ts";
import { duplicateReport } from "./duplicates.ts";
import type { DuplicateReport } from "./duplicates.ts";
import { fairnessReport } from "./fairness.ts";
import type { FairnessReport } from "./fairness.ts";
import { postEventReuse, preEventReadiness } from "./checklists.ts";
import type { PostEventReuse, PreEventChecklist } from "./checklists.ts";

export interface EventJudgingDependencies {
  database: DatabasePort; clock: Clock; ids: IdGenerator;
  events: HostedEventAccessPort; participation: EventParticipationPort;
  conflicts: EventJudgeConflictPort;
  verifiedSubmissions?: VerifiedEventSubmissionPort;
  submissionLinkContext?: SubmissionLinkContextPort;
}
/**
 * 规划33 P09：赛后闭环需要的**已公布投影**（只读）。与 `event-closure` 的
 * `ClosurePublishedResult` 结构兼容；`reviewRequired` 为真时 `rows` 必须为空，
 * 因此赛后清单不会列出需要复核的作品，也不会另算一套分数或名次。
 */
export interface ClosurePublishedProjection {
  readonly id: string; readonly roundId: string; readonly roundTitle: string; readonly version: number;
  readonly visibility: "public" | "participants"; readonly publishedAt: string; readonly reviewRequired: boolean;
  readonly rows: readonly { readonly teamId: string; readonly title: string; readonly total: number | null; readonly rank: number | null; readonly approvedFeedbackCount: number }[];
}
export function createEventJudgingService(deps: EventJudgingDependencies) {
  const { database, clock, ids, events, participation, conflicts } = deps;
  if (!!deps.verifiedSubmissions !== !!deps.submissionLinkContext) throw new Error("verifiedSubmissions and submissionLinkContext must be supplied together");
  function fail(code: string, message: string, status = 409): never { throw new DomainError(code, message, { status }); }
  const now = () => clock.now().toISOString();
  async function event(sql: SqlExecutor, id: string): Promise<HostedEventScope> {
    const scope = await events.getEvent(sql, text(id, "赛事", 160), { forUpdate: true });
    if (!scope) return fail("EVENT_NOT_FOUND", "没有找到这场比赛。", 404);
    return scope;
  }
  async function transact<T>(principal: OrganizerPrincipal, eventId: string, mutate: boolean, work: (sql: SqlExecutor, scope: HostedEventScope) => Promise<T>): Promise<T> {
    return database.transaction(async sql => {
      await principal.guard(sql);
      const scope = await event(sql, eventId);
      if (mutate) {
        if (scope.status === "archived") fail("EVENT_READ_ONLY", "比赛已归档，只能查看既有记录。");
        await store.lockEvent(sql, scope);
      }
      const output = await work(sql, scope);
      await principal.guard(sql);
      return output;
    });
  }
  async function staff(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope): Promise<void> {
    const current = await events.requireStaff(sql, principal.actor, scope.eventId, "judging_manage");
    if (current.organizationId !== scope.organizationId || current.eventId !== scope.eventId) fail("EVENT_SCOPE_MISMATCH", "当前赛事权限不匹配。", 403);
  }
  async function team(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, teamId: string, submit = false): Promise<EventRosterTeamSnapshot> {
    const value = await participation.getTeam(sql, scope.eventId, text(teamId, "队伍", 160));
    if (!value || value.organizationId !== scope.organizationId || value.eventId !== scope.eventId || !value.memberUserIds.includes(principal.actor.userId)) fail("TEAM_ACCESS_DENIED", "当前账号无法访问这支队伍。", 403);
    if (submit) {
      if (value.captainUserId !== principal.actor.userId) fail("SUBMISSION_CAPTAIN_REQUIRED", "请由当前队长确认正式提交。", 403);
      const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
      if (registration?.eventId !== scope.eventId || registration.userId !== principal.actor.userId || registration.status !== "approved" || !value.eligible || value.status !== "locked") fail("TEAM_NOT_ELIGIBLE", "名单须已锁定且全部成员报名已通过。");
      if (value.memberUserIds.length < scope.teams.minSize || value.memberUserIds.length > scope.teams.maxSize) fail("TEAM_SIZE_INVALID", "队伍人数不符合这场比赛要求。");
    }
    return value;
  }
  async function previewIn(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, teamId: string, raw: SubmissionMaterials): Promise<{ preview: SubmissionPreview; roster: EventRosterTeamSnapshot }> {
    if (!scope.modules.judging || scope.status !== "published" || scope.publishedRevision === null) fail("SUBMISSION_UNAVAILABLE", "这场比赛当前未开放正式收件。");
    if (!scope.submissionClosesAt) fail("SUBMISSION_DEADLINE_REQUIRED", "主办方尚未设置作品截止，请联系工作人员。");
    if (clock.now().getTime() >= Date.parse(scope.submissionClosesAt)) fail("SUBMISSION_CLOSED", "已到作品截止，正式材料不能再提交。");
    const roster = await team(sql, principal, scope, teamId, true), normalized = materials(raw);
    const previous = (await store.listReceipts(sql, scope)).filter(item => item.teamId === roster.id);
    return { roster, preview: { eventId: scope.eventId, organizationId: scope.organizationId, teamId: roster.id,
      eventRevision: scope.revision, publishedRevision: scope.publishedRevision, teamRevision: roster.revision,
      previousVersion: Math.max(0, ...previous.map(item => item.version)), submissionClosesAt: scope.submissionClosesAt,
      materials: normalized, materialHash: hash(normalized), warning: "正式收件冻结这份材料；链接和文件元数据不表示平台已下载、运行代码或验证文件哈希。" } };
  }
  async function roundIn(sql: SqlExecutor, scope: HostedEventScope, id: string): Promise<JudgingRound> {
    const value = await store.getRound(sql, scope, text(id, "评审轮", 160));
    if (!value) return fail("JUDGING_ROUND_NOT_FOUND", "没有找到这轮评审。", 404);
    return value;
  }
  function revision(value: { revision: number }, expected: number): void {
    integer(expected, "预期版本");
    if (value.revision !== expected) throw new DomainError("JUDGING_VERSION_CONFLICT", "记录已更新，请刷新后核对再继续。输入仍可保留。", { status: 409, latestRevision: value.revision, recoveryAction: "reload" });
  }
  async function audit(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, action: string, subjectId: string, reason: string, details: unknown): Promise<void> {
    await store.insertAudit(sql, { id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, actorUserId: principal.actor.userId, action, subjectId, reason, createdAt: now(), details });
  }
  /**
   * 越权尝试留痕。竞品源码把"试图读取同侪评分"本身记成审计事件（JUDGELAYER `server.ts` L178–199），
   * 我们保留同样的证据链：拒绝结论由既有权限判定给出，这里只补记录。
   *
   * 必须在本事务已经回滚之后单独开启事务：原事务里的写入会随拒绝一起回滚，而且在外层持有赛事锁时
   * 再锁同一赛事会死锁。留痕失败不改变原本的拒绝结论（不会把 403 变成 500），该边界记在 README。
   */
  async function auditDenied(principal: OrganizerPrincipal, eventId: string, action: string, method: string, subjectId: string, code: string): Promise<void> {
    try {
      await database.transaction(async sql => {
        await principal.guard(sql);
        const scope = await events.getEvent(sql, text(eventId, "赛事", 160), { forUpdate: true });
        if (!scope) return;
        await store.lockEvent(sql, scope);
        await audit(sql, principal, scope, action, subjectId, `被拒绝的${method}尝试：${code}。此记录只说明有人尝试越权，不改变任何材料、指派或评分。`, { code, method });
        await principal.guard(sql);
      });
    } catch { /* 留痕失败不放行、不改变拒绝结论；README 已登记该边界。 */ }
  }
  /** 评委侧入口统一经过这里：先按既有权限判定，被拒时补留痕，再抛出原错误。 */
  async function deniedAudited<T>(principal: OrganizerPrincipal, eventId: string, method: string, subjectId: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof DomainError && (error.code === "JUDGE_ACCESS_DENIED" || error.code === "JUDGE_CONFLICT")) await auditDenied(principal, eventId, "judge_access_denied", method, subjectId, error.code);
      throw error;
    }
  }
  async function updateRound(sql: SqlExecutor, scope: HostedEventScope, before: JudgingRound, after: JudgingRound): Promise<JudgingRound> {
    if (!await store.updateRound(sql, scope, before.revision, after)) fail("JUDGING_VERSION_CONFLICT", "评审轮已更新，请重新读取。");
    return after;
  }
  async function inspect(sql: SqlExecutor, scope: HostedEventScope, receipt: IntakeReceipt, judgeUserId: string) {
    const roster = await participation.getTeam(sql, scope.eventId, receipt.teamId);
    if (receipt.memberUserIds.includes(judgeUserId) || (roster?.eventId === scope.eventId && roster.organizationId === scope.organizationId && roster.memberUserIds.includes(judgeUserId))) return { status: "conflict" as const, reasons: ["评委是该作品正式队伍成员。"] };
    const check = await conflicts.inspect(sql, { eventId: scope.eventId, teamId: receipt.teamId, judgeUserId });
    if (!["clear", "conflict", "needs_review"].includes(check.status) || !Array.isArray(check.reasons)) fail("CONFLICT_CHECK_INVALID", "关联核查结果不可用，请人工核查。");
    return { status: check.status, reasons: check.reasons.map(reason => text(reason, "核查依据", 500, true)).slice(0, 12) };
  }
  async function assignmentIn(sql: SqlExecutor, scope: HostedEventScope, id: string): Promise<JudgeAssignment> {
    const value = await store.getAssignment(sql, scope, text(id, "指派", 160));
    if (!value) return fail("JUDGE_ASSIGNMENT_NOT_FOUND", "没有找到这项评审指派。", 404);
    return value;
  }
  async function judgeAccess(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, id: string) {
    const assignment = await assignmentIn(sql, scope, id);
    if (assignment.judgeUserId !== principal.actor.userId || assignment.status !== "active" || assignment.declaration !== "clear") fail("JUDGE_ACCESS_DENIED", "请先完成无冲突申报；已回避或撤销的作品不可读取和评分。", 403);
    const receipt = await store.getReceipt(sql, scope, assignment.snapshotId); if (!receipt) fail("INTAKE_NOT_FOUND", "正式材料不存在。", 404);
    const current = await inspect(sql, scope, receipt, principal.actor.userId);
    if (current.status !== "clear") fail("JUDGE_CONFLICT", "当前参赛或辅导关联须重新核查，暂时不能读取和评分。", 403);
    const round = await roundIn(sql, scope, assignment.roundId);
    return { assignment, receipt, round };
  }
  async function checkedIn(sql: SqlExecutor, scope: HostedEventScope, round: JudgingRound): Promise<{ receipts: IntakeReceipt[]; assignments: JudgeAssignment[]; checked: JudgeAssignment[]; scores: ManualScore[] }> {
    const receipts = await store.listReceipts(sql, scope), assignments = await store.listAssignments(sql, scope), scores = await store.listScores(sql, scope);
    const checked: JudgeAssignment[] = [];
    for (const assignment of assignments.filter(item => item.roundId === round.id)) {
      if (assignment.status !== "active" || assignment.declaration !== "clear") { checked.push(assignment); continue; }
      const receipt = receipts.find(item => item.id === assignment.snapshotId); if (!receipt) fail("INTAKE_NOT_FOUND", "正式材料不存在。", 404);
      const current = await inspect(sql, scope, receipt, assignment.judgeUserId);
      checked.push(current.status === "clear" ? assignment : { ...assignment, status: current.status === "conflict" ? "recused" : "needs_review" });
    }
    return { receipts, assignments, checked, scores };
  }
  async function summaryIn(sql: SqlExecutor, scope: HostedEventScope, round: JudgingRound): Promise<ResultSummary> {
    const { receipts, checked, scores } = await checkedIn(sql, scope, round);
    return aggregate(round, receipts, checked, scores);
  }
  function publicationReview(round: JudgingRound, summary: ResultSummary): PublicationReview {
    const required = round.status === "published" && (!round.lockedSummary || hash(summary) !== hash(round.lockedSummary));
    return { required, notice: required ? "本版结果需要主办方重新核查，当前暂停展示分数、排名和反馈。历史公布版本保留。" : null,
      nextSteps: required ? ["preview_results", "withdraw_results", "reopen_round", "review_assignments", "lock_round", "preview_results", "publish_results"] : [] };
  }
  async function appealIn(sql: SqlExecutor, scope: HostedEventScope, id: string): Promise<ResultAppeal> {
    const value = await store.getAppeal(sql, scope, text(id, "申诉", 160));
    if (!value) fail("APPEAL_NOT_FOUND", "没有找到这条申诉。", 404);
    return value;
  }
  /** 找到"本人当前所属队伍"在这一版已公布结果上的那一行；不是该队伍成员就拒绝。 */
  async function appealTarget(sql: SqlExecutor, scope: HostedEventScope, principal: OrganizerPrincipal, result: PublishedResults, receipts: readonly IntakeReceipt[]) {
    const own = receipts.filter(receipt => receipt.memberUserIds.includes(principal.actor.userId));
    const row = result.rows.find(item => own.some(receipt => receipt.id === item.snapshotId));
    if (!row) fail("APPEAL_NOT_PARTICIPANT", "只有本版结果中作品的当前队伍成员可以申诉。", 403);
    const roster = await participation.getTeam(sql, scope.eventId, row.teamId);
    if (roster?.eventId !== scope.eventId || roster.organizationId !== scope.organizationId || !roster.memberUserIds.includes(principal.actor.userId))
      fail("APPEAL_TEAM_CHANGED", "你已不在该作品的当前队伍中，不能提交或查看这条申诉。", 403);
    return { row, receipt: own.find(receipt => receipt.id === row.snapshotId)! };
  }
  /**
   * 规划 34 C① 的赛事级门禁：`community.workShowcase` 为假时，**既不能读也不能写**，
   * 明确 403（不是空数组、不是空占位），与规划 34 §3.1「三层开关缺一不公开」一致。
   * 开关随正式发布版本冻结，本模块只读取，不修改配置。
   */
  function requireWorkShowcase(scope: HostedEventScope): void {
    if (!eventCommunity(scope).workShowcase)
      fail("WORK_SHOWCASE_DISABLED", "本场主办方尚未开启作品展示；作品一律不对外显示，也不能提交公开范围。", 403);
  }
  /**
   * 队伍成员校验，**沿用申诉的成员校验口径**（见 `appealTarget`）：
   * ① 当前队伍名单（`participation.getTeam`）包含本人；② 该队**最新正式收件回执**的成员快照也包含本人。
   * 队长不能凭身份替其他成员决定，后加入但不在回执快照里的人也不能提交。
   */
  async function disclosureTeam(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, teamId: string) {
    const roster = await participation.getTeam(sql, scope.eventId, teamId);
    if (!roster || roster.eventId !== scope.eventId || roster.organizationId !== scope.organizationId || roster.status === "withdrawn")
      fail("WORK_DISCLOSURE_ACCESS_DENIED", "当前账号无法访问这支队伍。", 403);
    if (!roster.memberUserIds.includes(principal.actor.userId))
      fail("WORK_DISCLOSURE_ACCESS_DENIED", "只有本队当前成员可以查看或提交公开范围选择。", 403);
    const receipts = (await store.listReceipts(sql, scope)).filter(receipt => receipt.teamId === roster.id);
    const latest = [...receipts].sort((left, right) => right.version - left.version
      || (left.submittedAt < right.submittedAt ? 1 : left.submittedAt > right.submittedAt ? -1 : 0))[0] ?? null;
    if (latest && !latest.memberUserIds.includes(principal.actor.userId))
      fail("WORK_DISCLOSURE_ACCESS_DENIED", "你不在该作品正式收件时的队伍成员名单中，不能提交这项选择。", 403);
    return { roster, receipt: latest };
  }
  /** 公开列表投影的**唯一**读取实现：参赛者读、主办方读与访客公开读共用，避免第二套口径。 */
  async function buildWorkShowcase(sql: SqlExecutor, scope: HostedEventScope, principal: OrganizerPrincipal | null): Promise<WorkShowcaseList> {
    const receipts = await store.listReceipts(sql, scope), disclosures = await store.listWorkDisclosures(sql, scope);
    const isParticipant = async (): Promise<boolean> => {
      if (!principal) return false;
      const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
      return registration?.eventId === scope.eventId && registration.userId === principal.actor.userId && registration.status === "approved";
    };
    const items = workShowcaseEntries({ receipts, disclosures, viewerIsParticipant: await isParticipant() });
    // 投影只读既有事实，但资格仍是外部事实：返回前再复核一次，撤权后不再返回仅参赛者可见的作品。
    const stillParticipant = await isParticipant();
    const visible = stillParticipant ? items : items.filter(item => item.scope === "public");
    return { eventId: scope.eventId, showcaseEnabled: true, visibleCount: visible.length, items: visible, notice: workShowcaseNotice, limitations: workShowcaseLimitations };
  }
  /**
   * 规划 34 C②「文字留言」的赛事级两层开关 + 队伍级披露门禁。
   * 与 P2 的 `works()` 共用同一个 `commentGate()`，因此**不会**出现第二套"能不能公开/能不能留言"的口径。
   * 任一不满足 → 明确 403（**不是空数组**），且调用方事务里零行落库。
   */
  function requireComments(scope: HostedEventScope, disclosure: WorkDisclosure | null): WorkDisclosure {
    const failure = commentGate(eventCommunity(scope), disclosure);
    if (failure) fail(failure.code, failure.message, failure.status);
    return disclosure!;
  }
  /**
   * 留言目标定位：`snapshotId` 必须是该队**当前正在展示**（最新正式收件）的那一版，
   * 与 P2 公开投影取 `latestReceiptOf` 的口径一致——否则会出现"作品列表里没有、却有留言区"的第二套可见性。
   * 三层门禁在本函数内判定；观看者资格由调用方另行判定（读、写、举报都要，作者本人隐藏除外）。
   */
  async function commentTarget(sql: SqlExecutor, scope: HostedEventScope, snapshotId: string): Promise<{ receipt: IntakeReceipt; disclosure: WorkDisclosure }> {
    const id = text(snapshotId, "作品", 160);
    const receipts = await store.listReceipts(sql, scope);
    const receipt = receipts.find(item => item.id === id);
    if (!receipt) fail("INTAKE_NOT_FOUND", "没有找到这份正式作品。", 404);
    const latest = latestReceiptOf(receipts, receipt.teamId);
    if (!latest || latest.id !== receipt.id) fail("WORK_COMMENTS_NOT_DISCLOSED", "这个版本已不是该队伍当前展示的作品，留言区不在这里。", 403);
    const disclosure = await store.findActiveWorkDisclosure(sql, scope, receipt.teamId);
    return { receipt, disclosure: requireComments(scope, disclosure) };
  }
  /** 与 P2 作品可见性同口径：只有本场报名**已通过**的选手算"本场参赛者"。 */
  async function commentViewerParticipant(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope): Promise<boolean> {
    const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
    return registration?.eventId === scope.eventId && registration.userId === principal.actor.userId && registration.status === "approved";
  }
  async function requireCommentViewer(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, disclosure: WorkDisclosure): Promise<void> {
    const failure = commentViewerAccess(disclosure.scope, await commentViewerParticipant(sql, principal, scope));
    if (failure) fail(failure.code, failure.message, failure.status);
  }
  /**
   * 观看者是否是本场 `judging_manage` 工作人员。只用于把 `canHide` 如实告诉界面；
   * 非工作人员的 `STAFF_REQUIRED` 是预期结果，其他错误（例如赛事范围不匹配）照常抛出。
   */
  async function commentViewerIsStaff(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope): Promise<boolean> {
    try { await staff(sql, principal, scope); return true; }
    catch (error) {
      // 拒绝的写法在两个宿主里不同：模块夹具抛 `STAFF_REQUIRED`，真实根里 organizer 的
      // `eventAccess.requireStaff` 抛 `ORGANIZER_FORBIDDEN`。`canHide` 只是展示信息，
      // 因此**任何 403 都按"不是本场工作人员"处理**，绝不能让探测把 200 变成 403；
      // 非 403（会话失效、赛事范围不符、Port 故障）照常抛出，不静默吞掉。
      if (isDomainError(error) && (error.status === 403 || error.code === "STAFF_REQUIRED" || error.code === "ORGANIZER_FORBIDDEN")) return false;
      throw error;
    }
  }
  /** 留言必须属于这次请求定位到的作品（队伍），否则一律 404，不泄露他队留言是否存在。 */
  async function commentIn(sql: SqlExecutor, scope: HostedEventScope, commentId: string, teamId: string): Promise<WorkComment> {
    const value = await store.getWorkComment(sql, scope, text(commentId, "留言", 160));
    if (!value || value.teamId !== teamId) fail("WORK_COMMENT_NOT_FOUND", "没有找到这条留言。", 404);
    return value;
  }
  /** 留言视图的唯一投影：不含作者账号；隐藏后正文为 null；举报计数按事实统计。 */
  async function commentViews(sql: SqlExecutor, scope: HostedEventScope, comments: readonly WorkComment[], viewerUserId: string, viewerIsStaff: boolean): Promise<WorkCommentView[]> {
    const reports = await store.listWorkCommentReports(sql, scope);
    return comments.map(comment => commentView(comment, { viewerUserId, viewerIsStaff,
      reportedCount: reports.filter(report => report.commentId === comment.id).length,
      reportedByViewer: reports.some(report => report.commentId === comment.id && report.reporterUserId === viewerUserId) }));
  }
  async function score(principal: OrganizerPrincipal, eventId: string, assignmentId: string, input: ScoreInput, state: "draft" | "submitted") {
    return transact(principal, eventId, true, async (sql, scope) => {
      const { assignment, round } = await judgeAccess(sql, principal, scope, assignmentId);
      if (round.status !== "open") fail("JUDGING_NOT_OPEN", "本轮尚未开始或已锁定，不能修改评分。");
      revision(assignment, input.expectedAssignmentRevision);
      const old = await store.getScore(sql, scope, assignment.id);
      revision(old ?? { revision: 0 }, input.expectedScoreRevision);
      if (old?.state === "submitted" && state === "draft") fail("SCORE_ALREADY_SUBMITTED", "已正式提交的评分不能退回草稿，请直接提交带说明的纠正。");
      const correctionReason = text(input.correctionReason ?? "", "纠正说明", 1000, !old || old.state !== "submitted");
      const values = scoreValues(input.values, round, state === "submitted"), feedback = text(input.feedback, "评语", 3000, true);
      const value: ManualScore = { id: old?.id ?? ids.next(), eventId: scope.eventId, organizationId: scope.organizationId, assignmentId: assignment.id,
        revision: (old?.revision ?? 0) + 1, state, values, feedback, updatedAt: now() };
      if (old) { if (!await store.updateScore(sql, scope, old.revision, value)) fail("JUDGING_VERSION_CONFLICT", "评分已经更新。"); }
      else await store.insertScore(sql, value);
      await audit(sql, principal, scope, old?.state === "submitted" ? "score_corrected" : `score_${state}`, value.id, correctionReason, { before: old, after: value });
      await judgeAccess(sql, principal, scope, assignmentId);
      return value;
    });
  }
  async function projection(sql: SqlExecutor, scope: HostedEventScope, principal: OrganizerPrincipal | null): Promise<ResultProjection> {
    const rounds = await store.listRounds(sql, scope), rows: ResultProjection["rows"][number][] = [];
    let version: number | null = null, publishedAt: string | null = null;
    const published: { round: JudgingRound; result: PublishedResults }[] = [];
    for (const round of rounds.filter(item => item.status === "published" && item.publishedResultId)) { const result = await store.getPublished(sql, scope, round.publishedResultId!); if (result) published.push({ round, result }); }
    published.sort((a, b) => b.result.version - a.result.version);
    let visibleRound: JudgingRound | null = null;
    let visibleVisibility: PublishedResults["visibility"] | null = null;
    const privateFeedbackFallbacks = new Map<string, string | null>();
    for (const { round, result } of published) {
      if (result.visibility === "participants") {
        if (!principal) continue;
        const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
        if (registration?.eventId !== scope.eventId || registration.userId !== principal.actor.userId || registration.status !== "approved") continue;
      }
      version = Math.max(version ?? 0, result.version); publishedAt = result.publishedAt > (publishedAt ?? "") ? result.publishedAt : publishedAt;
      visibleRound = round;
      visibleVisibility = result.visibility;
      // Check before returning historical scores. Never silently recompute public rankings.
      const review = publicationReview(round, await summaryIn(sql, scope, round));
      if (review.required) {
        if (result.visibility === "participants" && principal) {
          const current = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
          if (current?.eventId !== scope.eventId || current.userId !== principal.actor.userId || current.status !== "approved") return waitingProjection();
        }
        return { status: "needs_review", reviewRequired: true, reviewNotice: review.notice, version, publishedAt, roundId: round.id, roundTitle: round.config.title, rows: [] };
      }
      for (const row of result.rows) {
        const publicFeedback = result.approvedFeedback.find(item => item.snapshotId === row.snapshotId && item.visibility === "public")?.text ?? null;
        let feedback = publicFeedback;
        if (principal) {
          const roster = await participation.getTeam(sql, scope.eventId, row.teamId);
          if (roster?.eventId === scope.eventId && roster.organizationId === scope.organizationId && roster.memberUserIds.includes(principal.actor.userId)) {
            const teamFeedback = result.approvedFeedback.find(item => item.snapshotId === row.snapshotId && item.visibility === "team")?.text;
            feedback = teamFeedback ?? publicFeedback;
            if (teamFeedback !== undefined) privateFeedbackFallbacks.set(row.teamId, publicFeedback);
            const current = await participation.getTeam(sql, scope.eventId, row.teamId);
            if (!current || current.eventId !== scope.eventId || current.organizationId !== scope.organizationId || !current.memberUserIds.includes(principal.actor.userId)) feedback = publicFeedback;
          }
        }
        rows.push({ teamId: row.teamId, title: row.title, total: row.total, rank: row.rank, feedback });
      }
      if (result.visibility === "participants" && principal) {
        const current = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
        if (current?.eventId !== scope.eventId || current.userId !== principal.actor.userId || current.status !== "approved") { rows.length = 0; version = null; publishedAt = null; visibleRound = null; }
      }
      break;
    }
    // Team-feedback or other reads may observe a changing trusted association source.
    if (visibleRound) {
      const review = publicationReview(visibleRound, await summaryIn(sql, scope, visibleRound));
      // Recheck private visibility after all trusted association reads, including the final summary.
      if (principal) for (const row of rows.filter(value => privateFeedbackFallbacks.has(value.teamId))) {
        const current = await participation.getTeam(sql, scope.eventId, row.teamId);
        if (!current || current.eventId !== scope.eventId || current.organizationId !== scope.organizationId || !current.memberUserIds.includes(principal.actor.userId)) row.feedback = privateFeedbackFallbacks.get(row.teamId) ?? null;
      }
      if (visibleVisibility === "participants" && principal) {
        const current = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
        if (current?.eventId !== scope.eventId || current.userId !== principal.actor.userId || current.status !== "approved") return waitingProjection();
      }
      if (review.required) return { status: "needs_review", reviewRequired: true, reviewNotice: review.notice, version, publishedAt, roundId: visibleRound.id, roundTitle: visibleRound.config.title, rows: [] };
    }
    return { status: version === null ? "waiting_publication" : "published", reviewRequired: false, reviewNotice: null, version, publishedAt, roundId: visibleRound?.id ?? null, roundTitle: visibleRound?.config.title ?? null, rows };
  }
  /**
   * 评审配置写入的**唯一实现**：`saveConfig`（自开事务）与 `saveConfigIn`（复用调用方事务，
   * 供规划 33 P05 的"复制上一场"）共用，避免出现第二套写逻辑。
   */
  async function writeConfig(sql: SqlExecutor, scope: HostedEventScope, principal: OrganizerPrincipal,
    input: { roundId?: string; expectedRevision: number; config: JudgingConfig }): Promise<JudgingRound> {
    await staff(sql, principal, scope);
    if (!scope.modules.judging) fail("JUDGING_DISABLED", "本场赛事未启用评审。");
    const normalized = config(input.config), old = input.roundId ? await roundIn(sql, scope, input.roundId) : null;
    revision(old ?? { revision: 0 }, input.expectedRevision);
    if (old && old.status !== "setup") fail("JUDGING_CONFIG_FROZEN", "开轮后评分标准已冻结，新标准请另建评审轮。");
    const value: JudgingRound = old ? { ...old, config: normalized, revision: old.revision + 1 } : { id: ids.next(), eventId: scope.eventId, organizationId: scope.organizationId,
      revision: 1, status: "setup", config: normalized, snapshotIds: [], createdAt: now(), startedAt: null, lockedAt: null, lockedSummary: null, publishedResultId: null };
    if (old) await updateRound(sql, scope, old, value); else await store.insertRound(sql, value);
    await audit(sql, principal, scope, "config_saved", value.id, "", { before: old, after: value }); await staff(sql, principal, scope); return value;
  }

  return {
    listAssignedEventIds(principal: OrganizerPrincipal): Promise<string[]> {
      return database.transaction(async sql => {
        await principal.guard(sql);
        const judgeUserId = principal.actor.userId;
        const candidates = await store.listAssignedEventIds(sql, judgeUserId);
        // Recheck current ownership/status after the discovery read; do not expand its bounded candidate set.
        const current = await store.listAssignedEventIds(sql, judgeUserId, candidates);
        await principal.guard(sql);
        return current;
      });
    },
    previewSubmission(principal: OrganizerPrincipal, eventId: string, input: { teamId: string; materials: SubmissionMaterials }): Promise<SubmissionPreview> {
      return transact(principal, eventId, false, async (sql, scope) => (await previewIn(sql, principal, scope, input.teamId, input.materials)).preview);
    },
    submit(principal: OrganizerPrincipal, eventId: string, input: SubmissionInput): Promise<IntakeReceipt> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const key = text(input.idempotencyKey, "重试标识", 120), normalized = materials(input.materials);
        const inputHash = hash({ teamId: text(input.teamId, "队伍", 160), materials: normalized,
          expectedEventRevision: integer(input.expectedEventRevision, "赛事版本"), expectedTeamRevision: integer(input.expectedTeamRevision, "队伍版本"),
          expectedPreviousVersion: integer(input.expectedPreviousVersion, "上一提交版本"), expectedMaterialHash: text(input.expectedMaterialHash, "材料哈希", 64) });
        const replay = await store.findReplay(sql, scope, principal.actor.userId, key);
        if (replay) {
          await team(sql, principal, scope, replay.teamId);
          if (replay.inputHash !== inputHash) fail("IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于不同材料，请重新预览并创建新提交。");
          return replay;
        }
        const { preview, roster } = await previewIn(sql, principal, scope, input.teamId, normalized);
        revision({ revision: preview.eventRevision }, input.expectedEventRevision); revision({ revision: preview.teamRevision }, input.expectedTeamRevision);
        if (preview.previousVersion !== input.expectedPreviousVersion || preview.materialHash !== input.expectedMaterialHash) fail("SUBMISSION_PREVIEW_STALE", "材料或上一版本已变化，请重新预览确认。");
        const id = ids.next(), submittedAt = now(); let submissionRecordId: string | null = null;
        if (deps.verifiedSubmissions && deps.submissionLinkContext && roster.projectId && scope.linkedEventId) {
          const link = await deps.submissionLinkContext.resolve(sql, principal, scope, roster);
          if (link) {
            const requirementsVersion = confirmedVersionKey(link.requirementsVersion, scope.linkedEventId);
            const receipt = await deps.verifiedSubmissions.recordReceipt(sql, principal, { id, eventId: scope.eventId, linkedEventId: scope.linkedEventId,
              teamId: roster.id, projectId: roster.projectId, stageId: text(link.stageId, "可信阶段", 160), requirementsVersion,
              submittedAt, materialHash: preview.materialHash, receiptUrl: `/competitions/${encodeURIComponent(scope.eventId)}/submit?receipt=${encodeURIComponent(id)}`, repositoryCommitSha: link.repositoryCommitSha });
            submissionRecordId = receipt.submissionRecordId;
          }
        }
        const value: IntakeReceipt = { ...preview, id, version: preview.previousVersion + 1, authorUserId: principal.actor.userId, submittedAt,
          ruleVersion: scope.publishedRevision!, memberUserIds: [...roster.memberUserIds], receiptNumber: `REC-${id}`, inputHash, idempotencyKey: key, submissionRecordId };
        await store.insertReceipt(sql, value);
        await team(sql, principal, scope, roster.id, true);
        return value;
      });
    },
    mySubmissions(principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<{ items: readonly IntakeReceipt[] }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await team(sql, principal, scope, teamId);
        const items = (await store.listReceipts(sql, scope)).filter(item => item.teamId === teamId);
        await team(sql, principal, scope, teamId); return { items };
      });
    },
    workspace(principal: OrganizerPrincipal, eventId: string): Promise<JudgingWorkspace> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        const rounds = await store.listRounds(sql, scope), submissions = await store.listReceipts(sql, scope), assignments = await store.listAssignments(sql, scope), scores = await store.listScores(sql, scope);
        const publicationReviews: JudgingWorkspace["publicationReviews"][number][] = [];
        for (const round of rounds.filter(item => item.status === "published" && item.publishedResultId)) publicationReviews.push({ roundId: round.id, publishedResultId: round.publishedResultId!, ...publicationReview(round, await summaryIn(sql, scope, round)) });
        await staff(sql, principal, scope);
        return { eventId, eventTitle: scope.title, organizationName: scope.organizationName, submissionClosesAt: scope.submissionClosesAt, rounds, submissions, assignments, scores, publicationReviews };
      });
    },
    /**
     * 规划33 P09：赛后闭环的只读来源（**在调用方事务里**，不写事实、不触发通知）。
     * 只返回正式收件回执；调用方据此核对成员快照与成果计数。
     */
    closureIntakeReceipts(sql: SqlExecutor, scope: HostedEventScope): Promise<readonly IntakeReceipt[]> {
      return store.listReceipts(sql, scope);
    },
    /**
     * 规划34 P7：数值互评模块的只读来源（**在调用方事务里**，不写事实）。
     * 只报「哪支队伍对作品做了哪种公开选择、是否仍有效」，不含任何字段内容，也不含队伍成员身份。
     */
    async closureWorkDisclosures(sql: SqlExecutor, scope: HostedEventScope): Promise<readonly { readonly teamId: string; readonly scope: "private" | "participants" | "public"; readonly status: "active" | "withdrawn" }[]> {
      return (await store.listWorkDisclosures(sql, scope)).map(item => ({ teamId: item.teamId, scope: item.scope, status: item.status }));
    },
    /** 规划33 P09：评审基准（最近一轮的已保存配置），只报数量与状态，不报分数。 */
    async closureJudgingRounds(sql: SqlExecutor, scope: HostedEventScope): Promise<readonly { readonly id: string; readonly title: string; readonly criteriaCount: number; readonly minJudges: number; readonly state: JudgingRound["status"] }[]> {
      const rounds = await store.listRounds(sql, scope);
      return rounds.map(round => ({ id: round.id, title: round.config.title, criteriaCount: round.config.criteria.length, minJudges: round.config.minJudges, state: round.status, appealWindowDays: appealWindowDays(round.config) }));
    },
    /**
     * 规划33 P09：每个**已公布**轮次一条只读投影；`needs_review` 时 `rows` 为空。
     * 复用本模块的 `publicationReview` / `summaryIn`，不另算一套判定。
     */
    async closurePublishedResults(sql: SqlExecutor, scope: HostedEventScope): Promise<readonly ClosurePublishedProjection[]> {
      const rounds = await store.listRounds(sql, scope), output: ClosurePublishedProjection[] = [];
      for (const round of rounds) {
        if (round.status !== "published" || !round.publishedResultId) continue;
        const result = await store.getPublished(sql, scope, round.publishedResultId);
        if (!result) continue;
        const review = publicationReview(round, await summaryIn(sql, scope, round));
        output.push({ id: result.id, roundId: round.id, roundTitle: round.config.title, version: result.version, visibility: result.visibility, publishedAt: result.publishedAt, reviewRequired: review.required,
          rows: review.required ? [] : result.rows.map(row => ({ teamId: row.teamId, title: row.title, total: row.total, rank: row.rank, approvedFeedbackCount: result.approvedFeedback.filter(item => item.snapshotId === row.snapshotId && item.visibility === "public").length })),
        });
      }
      return output;
    },
    saveConfig(principal: OrganizerPrincipal, eventId: string, input: { roundId?: string; expectedRevision: number; config: JudgingConfig }): Promise<JudgingRound> {
      return transact(principal, eventId, true, (sql, scope) => writeConfig(sql, scope, principal, input));
    },
    /**
     * 规划 33 P05：**在调用方的事务里**写评审配置，供根把它注入 `organizer` 的
     * `judgingConfig.saveConfig`，使"复制上一场"的
     * 建事件 → 存报名表 → 存评审配置 三步**同处一个事务**（任一步失败整体回滚）。
     *
     * 与 `saveConfig` 共用同一个 `writeConfig` 实现，**不新增第二套写逻辑**；
     * 区别只在事务边界与鉴权位置：本方法**只用传入的 `sql`**、不自己开事务，
     * 权限由调用方（organizer 的 `duplicateEvent`）在同一事务内先行核查，因此不重复鉴权。
     * 复制场景固定新建一轮（`roundId` 省略、`expectedRevision: 0`），
     * 因此必然落到"新轮次"分支；`config()` 校验与审计仍照常执行。
     */
    saveConfigIn(sql: SqlExecutor, scope: HostedEventScope, principal: OrganizerPrincipal, input: { roundId?: string; expectedRevision: number; config: JudgingConfig }): Promise<JudgingRound> {
      return writeConfig(sql, scope, principal, input);
    },
    startRound(principal: OrganizerPrincipal, eventId: string, roundId: string, expectedRevision: number): Promise<JudgingRound> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await roundIn(sql, scope, roundId); revision(old, expectedRevision);
        if (!scope.modules.judging || old.status !== "setup") fail("JUDGING_STATE_INVALID", "只有未开始且启用评审的轮次可以开始。");
        config(old.config);
        const latest = new Map<string, IntakeReceipt>(); for (const receipt of await store.listReceipts(sql, scope)) if (receipt.version > (latest.get(receipt.teamId)?.version ?? 0)) latest.set(receipt.teamId, receipt);
        if (!latest.size) fail("JUDGING_NO_SUBMISSIONS", "尚未收到正式作品，请先完成收件。");
        const value = await updateRound(sql, scope, old, { ...old, revision: old.revision + 1, status: "open", snapshotIds: [...latest.values()].map(item => item.id).sort(), startedAt: now() });
        await audit(sql, principal, scope, "round_started", roundId, "", { before: old, after: value }); await staff(sql, principal, scope); return value;
      });
    },
    assignJudge(principal: OrganizerPrincipal, eventId: string, input: { roundId: string; snapshotId: string; judgeUserId: string; expectedRoundRevision: number }): Promise<JudgeAssignment> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, input.roundId); revision(round, input.expectedRoundRevision);
        if (round.status !== "open" || !round.snapshotIds.includes(input.snapshotId)) fail("JUDGING_ASSIGNMENT_INVALID", "只能指派本轮冻结的正式作品。");
        const receipt = await store.getReceipt(sql, scope, input.snapshotId); if (!receipt) fail("INTAKE_NOT_FOUND", "正式材料不存在。", 404);
        const judgeUserId = text(input.judgeUserId, "评委账号", 160), check = await inspect(sql, scope, receipt, judgeUserId);
        if (check.status === "conflict") fail("JUDGE_CONFLICT", "存在已知参赛或辅导关联，不能指派这位评委。", 403);
        if ((await store.listAssignments(sql, scope)).some(item => item.roundId === round.id && item.snapshotId === receipt.id && item.judgeUserId === judgeUserId)) fail("JUDGE_ALREADY_ASSIGNED", "这位评委已有指派记录，请使用另一位评委或新评审轮。");
        const value: JudgeAssignment = { id: ids.next(), eventId, organizationId: scope.organizationId, roundId: round.id, snapshotId: receipt.id, judgeUserId,
          revision: 1, status: check.status === "clear" ? "active" : "needs_review", conflictReasons: check.reasons, declaration: "unconfirmed", createdAt: now() };
        await store.insertAssignment(sql, value); await audit(sql, principal, scope, "judge_assigned", value.id, "", value); await staff(sql, principal, scope); return value;
      });
    },
    reviewAssignment(principal: OrganizerPrincipal, eventId: string, assignmentId: string, input: { expectedRevision: number; reason: string }): Promise<JudgeAssignment> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await assignmentIn(sql, scope, assignmentId); revision(old, input.expectedRevision);
        if ((await roundIn(sql, scope, old.roundId)).status !== "open" || old.status !== "needs_review") fail("JUDGING_STATE_INVALID", "当前指派不在待核查状态。");
        const reason = text(input.reason, "人工核查依据", 1000), receipt = await store.getReceipt(sql, scope, old.snapshotId); if (!receipt) fail("INTAKE_NOT_FOUND", "正式材料不存在。", 404);
        const check = await inspect(sql, scope, receipt, old.judgeUserId);
        if (check.status !== "clear") fail("JUDGE_CONFLICT_UNRESOLVED", "请先在可信关联核查中解决待核查问题，不能覆盖已知冲突。", 403);
        const value = { ...old, revision: old.revision + 1, status: "active" as const, conflictReasons: check.reasons };
        if (!await store.updateAssignment(sql, scope, old.revision, value)) fail("JUDGING_VERSION_CONFLICT", "指派已更新。");
        await audit(sql, principal, scope, "conflict_reviewed", value.id, reason, { before: old, after: value }); await staff(sql, principal, scope); return value;
      });
    },
    revokeAssignment(principal: OrganizerPrincipal, eventId: string, assignmentId: string, input: { expectedRevision: number; reason: string }): Promise<JudgeAssignment> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await assignmentIn(sql, scope, assignmentId); revision(old, input.expectedRevision);
        const round = await roundIn(sql, scope, old.roundId); if (round.status !== "open") fail("JUDGING_NOT_OPEN", "请先撤回公布并重新打开本轮，再撤销指派。");
        const reason = text(input.reason, "撤销说明", 1000), value = { ...old, revision: old.revision + 1, status: "revoked" as const };
        if (!await store.updateAssignment(sql, scope, old.revision, value)) fail("JUDGING_VERSION_CONFLICT", "指派已更新。");
        await audit(sql, principal, scope, "assignment_revoked", value.id, reason, { before: old, after: value }); await staff(sql, principal, scope); return value;
      });
    },
    declareConflict(principal: OrganizerPrincipal, eventId: string, assignmentId: string, input: { expectedRevision: number; hasConflict: boolean; reason: string }): Promise<JudgeAssignment> {
      return deniedAudited(principal, eventId, "declareConflict", text(assignmentId, "指派", 160), () => transact(principal, eventId, true, async (sql, scope) => {
        const old = await assignmentIn(sql, scope, assignmentId); revision(old, input.expectedRevision);
        if (old.judgeUserId !== principal.actor.userId || old.status === "recused" || old.status === "revoked") fail("JUDGE_ACCESS_DENIED", "当前账号无权申报这项指派。", 403);
        if (typeof input.hasConflict !== "boolean") invalid("请明确是否存在利益冲突。");
        const round = await roundIn(sql, scope, old.roundId); if (round.status !== "open" && !input.hasConflict) fail("JUDGING_NOT_OPEN", "本轮已锁定；新发现冲突仍可立即申报回避。");
        const receipt = await store.getReceipt(sql, scope, old.snapshotId); if (!receipt) fail("INTAKE_NOT_FOUND", "正式材料不存在。", 404);
        const check = await inspect(sql, scope, receipt, principal.actor.userId), reason = text(input.reason, "申报说明", 1000, !input.hasConflict);
        const blocked = input.hasConflict || check.status === "conflict";
        const value: JudgeAssignment = { ...old, revision: old.revision + 1, declaration: blocked ? "conflict" : "clear", status: blocked ? "recused" : check.status === "clear" ? "active" : "needs_review", conflictReasons: [...check.reasons, ...(reason ? [reason] : [])] };
        if (!await store.updateAssignment(sql, scope, old.revision, value)) fail("JUDGING_VERSION_CONFLICT", "指派已更新。");
        await audit(sql, principal, scope, "conflict_declared", value.id, reason, { before: old, after: value }); return value;
      }));
    },
    judgeAssignments(principal: OrganizerPrincipal, eventId: string): Promise<{ items: readonly JudgeWorkItem[] }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        const items: JudgeWorkItem[] = [];
        for (const assignment of (await store.listAssignments(sql, scope)).filter(item => item.judgeUserId === principal.actor.userId)) {
          const round = await roundIn(sql, scope, assignment.roundId);
          const blocked = assignment.status !== "active" || assignment.declaration !== "clear";
          let title = "待完成无冲突申报", score: ManualScore | null = null, projectedAssignment = assignment;
          let accessStatus: JudgeWorkItem["accessStatus"] = assignment.status === "recused" ? "recused" : assignment.status === "revoked" ? "revoked" : assignment.status === "needs_review" ? "needs_review" : "pending_declaration";
          if (!blocked) {
            try {
              await judgeAccess(sql, principal, scope, assignment.id);
              const candidateScore = await store.getScore(sql, scope, assignment.id);
              const final = await judgeAccess(sql, principal, scope, assignment.id);
              title = final.receipt.materials.title; score = candidateScore; projectedAssignment = final.assignment; accessStatus = "available";
            } catch (error) {
              if (!(error instanceof DomainError) || !["JUDGE_ACCESS_DENIED", "JUDGE_CONFLICT"].includes(error.code)) throw error;
              const current = await store.getAssignment(sql, scope, assignment.id);
              if (!current || current.judgeUserId !== principal.actor.userId) continue;
              projectedAssignment = current.status === "active" ? { ...current, status: "needs_review", conflictReasons: [] } : current;
              accessStatus = current.status === "recused" ? "recused" : current.status === "revoked" ? "revoked" : "needs_review";
              title = "关联或指派已变化，暂不可读取"; score = null;
            }
          }
          items.push({ assignment: projectedAssignment, round: roundView(round), score, title, accessStatus });
        }
        // A later item's reads must not leave an earlier item's private score exposed.
        for (const item of items.filter(value => value.accessStatus === "available")) {
          try { const final = await judgeAccess(sql, principal, scope, item.assignment.id); item.assignment = final.assignment; item.round = roundView(final.round); }
          catch (error) {
            if (!(error instanceof DomainError) || !["JUDGE_ACCESS_DENIED", "JUDGE_CONFLICT"].includes(error.code)) throw error;
            const current = await store.getAssignment(sql, scope, item.assignment.id);
            if (!current || current.judgeUserId !== principal.actor.userId) { item.assignment = { ...item.assignment, status: "revoked", conflictReasons: [] }; item.accessStatus = "revoked"; }
            else { item.assignment = current.status === "active" ? { ...current, status: "needs_review", conflictReasons: [] } : current; item.accessStatus = current.status === "recused" ? "recused" : current.status === "revoked" ? "revoked" : "needs_review"; }
            item.title = "关联或指派已变化，暂不可读取"; item.score = null;
          }
        }
        return { items };
      });
    },
    judgeMaterials(principal: OrganizerPrincipal, eventId: string, assignmentId: string) {
      return deniedAudited(principal, eventId, "judgeMaterials", text(assignmentId, "指派", 160), () => transact(principal, eventId, false, async (sql, scope) => {
        const access = await judgeAccess(sql, principal, scope, assignmentId), score = await store.getScore(sql, scope, assignmentId);
        await judgeAccess(sql, principal, scope, assignmentId); return { assignment: access.assignment, receipt: receiptView(access.receipt), round: roundView(access.round), score };
      }));
    },
    saveScore(principal: OrganizerPrincipal, eventId: string, assignmentId: string, input: ScoreInput) { return deniedAudited(principal, eventId, "saveScore", text(assignmentId, "指派", 160), () => score(principal, eventId, assignmentId, input, "draft")); },
    submitScore(principal: OrganizerPrincipal, eventId: string, assignmentId: string, input: ScoreInput) { return deniedAudited(principal, eventId, "submitScore", text(assignmentId, "指派", 160), () => score(principal, eventId, assignmentId, input, "submitted")); },
    previewResults(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<{ round: JudgingRound; summary: ResultSummary; summaryHash: string; publicationReview: PublicationReview }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, roundId);
        const summary = await summaryIn(sql, scope, round); await staff(sql, principal, scope);
        return { round, summary, summaryHash: hash(summary), publicationReview: publicationReview(round, summary) };
      });
    },
    /**
     * 评委严格度校准：只读派生视图。原始分与名次由既有汇总决定，本方法不修改任何事实，
     * 也不会被公布流程消费；样本不足时只返回提示，不提供校准分。
     */
    calibration(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<CalibrationReport> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, roundId);
        const { receipts, checked, scores } = await checkedIn(sql, scope, round);
        await staff(sql, principal, scope);
        return calibration(round, receipts, checked, scores);
      });
    },
    /**
     * 评审隔离一键自检：只读派生，回答"当前这轮的边界是否仍然成立"。
     * 不写任何事实，也不改变汇总与公布；发现的问题由主办方决定如何处理。
     */
    integrity(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<IntegrityReport> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, roundId);
        const { receipts, assignments, checked, scores } = await checkedIn(sql, scope, round);
        await staff(sql, principal, scope);
        return integrity(round, receipts, assignments, checked, scores);
      });
    },
    /**
     * 相似 / 重复材料的人工复核线索：只读派生，跨队伍比较各自最新一版正式材料。
     * 不给分数、不下判定、不自动通知；是否处理由主办方决定。
     */
    duplicates(principal: OrganizerPrincipal, eventId: string): Promise<DuplicateReport> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        const report = duplicateReport(await store.listReceipts(sql, scope));
        await staff(sql, principal, scope);
        return report;
      });
    },
    /**
     * 评审进度追踪：只读派生视图。
     * 数据只取既有 `checkedIn()` 的返回（与 aggregate()/calibration() 同一套有效性判定），
     * 不新增读路径、不加表、不加查询，也不产生催办或任何写入。
     */
    progress(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<ProgressReport> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, roundId);
        const { receipts, checked, scores } = await checkedIn(sql, scope, round);
        await staff(sql, principal, scope);
        return progress(round, receipts, checked, scores);
      });
    },
    /**
     * 公开公平规则包与需要人工确认的扣分建议：只读派生，不自动扣分、不改结果、不取消资格。
     */
    fairness(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<FairnessReport> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, roundId);
        const { receipts, assignments, scores } = await checkedIn(sql, scope, round);
        const published = round.publishedResultId ? await store.getPublished(sql, scope, round.publishedResultId) : null;
        const report = fairnessReport({ round, receipts: receipts.filter(item => round.snapshotIds.includes(item.id)), assignments, scores, published, now: now() });
        await staff(sql, principal, scope);
        return report;
      });
    },
    /** 赛前自检与赛后只读复用清单：只看本人队伍自己的事实，不建立第二套完成状态。 */
    myChecklists(principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<{ preEvent: PreEventChecklist; postEvent: PostEventReuse }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await team(sql, principal, scope, teamId);
        const receipts = (await store.listReceipts(sql, scope)).filter(item => item.teamId === teamId);
        const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
        const roster = await participation.getTeam(sql, scope.eventId, teamId);
        const rounds = await store.listRounds(sql, scope);
        let published: PublishedResults | null = null;
        for (const round of rounds.filter(item => item.status === "published" && item.publishedResultId)) {
          const result = await store.getPublished(sql, scope, round.publishedResultId!); if (result) { published = result; break; }
        }
        await team(sql, principal, scope, teamId);
        return { preEvent: preEventReadiness({ registration, memberUserIds: roster?.memberUserIds ?? [], receipts, published, now: now() }),
          postEvent: postEventReuse({ receipts, published }) };
      });
    },
    /**
     * 选手提交对已公布结果的申诉。只看当前是否可见的已公布版本，按当前队伍成员资格校验，
     * 同一队伍对同一版结果只有一条有效申诉；申诉本身不改变分数、名次或公布。
     */
    fileAppeal(principal: OrganizerPrincipal, eventId: string, input: AppealInput): Promise<ResultAppeal> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const round = await roundIn(sql, scope, text(input.roundId, "评审轮", 160));
        if (round.status !== "published" || !round.publishedResultId) fail("APPEAL_RESULT_NOT_PUBLISHED", "只有已公布的结果可以提出申诉。");
        const result = await store.getPublished(sql, scope, round.publishedResultId);
        if (!result) fail("JUDGING_RESULT_MISSING", "本版公布结果暂时无法读取，请联系主办方。", 503);
        const key = appealIdempotencyKey(input.idempotencyKey);
        const replay = await store.findAppealReplay(sql, scope, principal.actor.userId, key);
        if (replay) return replay;
        const reason = appealReason(input.reason), requestedOutcome = appealRequestedOutcome(input.requestedOutcome);
        const receipts = await store.listReceipts(sql, scope);
        const { row } = await appealTarget(sql, scope, principal, result, receipts);
        const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
        if (registration?.eventId !== scope.eventId || registration.status !== "approved") fail("APPEAL_REGISTRATION_REQUIRED", "只有本场报名已通过的选手可以对结果提出申诉。", 403);
        const window = canFileAppeal(result.publishedAt, appealWindowDays(round.config), now());
        if (!window.ok) fail(window.code, window.message);
        const existing = (await store.listAppeals(sql, scope)).find(item => item.publishedResultId === result.id && item.teamId === row.teamId && item.status !== "withdrawn");
        if (existing) fail("APPEAL_ALREADY_FILED", "你们队已经对这版结果提交过申诉，请等待主办方处理；如需补充说明请联系主办方。");
        const value: ResultAppeal = { id: ids.next(), eventId: scope.eventId, organizationId: scope.organizationId, roundId: round.id, publishedResultId: result.id,
          resultVersion: result.version, teamId: row.teamId, snapshotId: row.snapshotId, authorUserId: principal.actor.userId, revision: 1, status: "submitted",
          reason, requestedOutcome, filedAt: now(), deadlineAt: window.deadlineAt, resolvedBy: null, resolvedAt: null, decisionNote: null, idempotencyKey: key };
        await store.insertAppeal(sql, value);
        await audit(sql, principal, scope, "appeal_filed", value.id, "", { after: value });
        return value;
      });
    },
    /** 只有提交人本人可以撤回；撤回后该队伍可以重新提交。 */
    withdrawAppeal(principal: OrganizerPrincipal, eventId: string, appealId: string, input: { expectedRevision: number; reason: string }): Promise<ResultAppeal> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const old = await appealIn(sql, scope, appealId); revision(old, input.expectedRevision);
        if (old.authorUserId !== principal.actor.userId) fail("APPEAL_ACCESS_DENIED", "只有提交人本人可以撤回这条申诉。", 403);
        const value = withdrawAppealRecord(old, now());
        if (!await store.updateAppeal(sql, scope, old.revision, value)) fail("JUDGING_VERSION_CONFLICT", "申诉已更新，请刷新后重试。");
        await audit(sql, principal, scope, "appeal_withdrawn", value.id, text(input.reason, "撤回说明", 1000, true), { before: old, after: value });
        return value;
      });
    },
    /** 选手侧：本人可见的申诉（本人提交的，或当前仍是所属队伍成员的）。 */
    ownAppeals(principal: OrganizerPrincipal, eventId: string): Promise<{ items: readonly ResultAppeal[]; window: AppealWindowView | null }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        const rounds = await store.listRounds(sql, scope), receipts = await store.listReceipts(sql, scope), appeals = await store.listAppeals(sql, scope);
        const visible: ResultAppeal[] = [];
        for (const appeal of appeals) {
          if (appeal.authorUserId === principal.actor.userId) { visible.push(appeal); continue; }
          const roster = await participation.getTeam(sql, scope.eventId, appeal.teamId);
          if (roster?.eventId === scope.eventId && roster.organizationId === scope.organizationId && roster.memberUserIds.includes(principal.actor.userId)
            && receipts.some(receipt => receipt.id === appeal.snapshotId && receipt.memberUserIds.includes(principal.actor.userId))) visible.push(appeal);
        }
        let window: AppealWindowView | null = null;
        for (const round of rounds.filter(item => item.status === "published" && item.publishedResultId)) {
          const result = await store.getPublished(sql, scope, round.publishedResultId!); if (!result) continue;
          const own = receipts.filter(receipt => receipt.memberUserIds.includes(principal.actor.userId));
          const row = result.rows.find(item => own.some(receipt => receipt.id === item.snapshotId)); if (!row) continue;
          const roster = await participation.getTeam(sql, scope.eventId, row.teamId);
          if (roster?.eventId !== scope.eventId || roster.organizationId !== scope.organizationId || !roster.memberUserIds.includes(principal.actor.userId)) continue;
          const days = appealWindowDays(round.config), decision = canFileAppeal(result.publishedAt, days, now());
          window = { roundId: round.id, roundTitle: round.config.title, publishedResultId: result.id, resultVersion: result.version, publishedAt: result.publishedAt,
            deadlineAt: appealDeadline(result.publishedAt, days), snapshotId: row.snapshotId,
            filed: visible.some(item => item.publishedResultId === result.id && item.teamId === row.teamId && item.status !== "withdrawn"),
            canFile: decision.ok, closedReason: decision.ok ? null : decision.message };
          break;
        }
        return { items: visible, window };
      });
    },
    /** 主办方侧：本场全部申诉与待处理数量。 */
    eventAppeals(principal: OrganizerPrincipal, eventId: string): Promise<{ items: readonly { appeal: ResultAppeal; roundTitle: string }[]; openCount: number }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        const rounds = await store.listRounds(sql, scope);
        const items = (await store.listAppeals(sql, scope)).map(appeal => ({ appeal, roundTitle: rounds.find(round => round.id === appeal.roundId)?.config.title ?? "" }));
        await staff(sql, principal, scope);
        return { items, openCount: items.filter(item => item.appeal.status === "submitted").length };
      });
    },
    /**
     * 主办方处理申诉：受理/不受理/已处理。它只改申诉状态并留审计，
     * **不改变分数、名次或公布**；需要更正分数时必须走撤回 → 重新开放 → 补评 → 重新锁定 → 人工公布。
     */
    resolveAppeal(principal: OrganizerPrincipal, eventId: string, appealId: string, input: AppealResolutionInput): Promise<ResultAppeal> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope);
        const old = await appealIn(sql, scope, appealId); revision(old, input.expectedRevision);
        const decision = resolutionOf(input.decision), note = text(input.note, "处理说明", 2000);
        const value = resolveAppealRecord(old, decision, note, principal.actor.userId, now());
        if (!await store.updateAppeal(sql, scope, old.revision, value)) fail("JUDGING_VERSION_CONFLICT", "申诉已更新，请刷新后重试。");
        await audit(sql, principal, scope, `appeal_${decision}`, value.id, note, { before: old, after: value });
        await staff(sql, principal, scope);
        return value;
      });
    },
    lockRound(principal: OrganizerPrincipal, eventId: string, roundId: string, expectedRevision: number): Promise<JudgingRound> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await roundIn(sql, scope, roundId); revision(old, expectedRevision);
        if (old.status !== "open") fail("JUDGING_NOT_OPEN", "只有进行中的评审轮可锁定。");
        const summary = await summaryIn(sql, scope, old);
        if (!summary.complete && old.config.missingPolicy === "block_publication") fail("JUDGING_MISSING_SCORES", "仍有作品缺少正式评分，请补齐或处理回避指派。");
        const value = await updateRound(sql, scope, old, { ...old, revision: old.revision + 1, status: "locked", lockedSummary: summary, lockedAt: now() });
        await audit(sql, principal, scope, "round_locked", old.id, "", { before: old, after: value }); await staff(sql, principal, scope); return value;
      });
    },
    reopenRound(principal: OrganizerPrincipal, eventId: string, roundId: string, input: { expectedRevision: number; reason: string }): Promise<JudgingRound> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await roundIn(sql, scope, roundId); revision(old, input.expectedRevision);
        if (old.status !== "locked") fail("JUDGING_STATE_INVALID", "须先撤回已公布结果，才可重新打开评审。");
        const reason = text(input.reason, "重开说明", 1000), value = await updateRound(sql, scope, old, { ...old, revision: old.revision + 1, status: "open", lockedSummary: null, lockedAt: null });
        await audit(sql, principal, scope, "round_reopened", old.id, reason, { before: old, after: value }); await staff(sql, principal, scope); return value;
      });
    },
    publishResults(principal: OrganizerPrincipal, eventId: string, roundId: string, input: PublishInput): Promise<PublishedResults> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await roundIn(sql, scope, roundId); revision(old, input.expectedRevision);
        if (old.status !== "locked" || !old.lockedSummary) fail("JUDGING_NOT_LOCKED", "请先补齐核查并锁定评分，再人工公布。");
        const summary = await summaryIn(sql, scope, old), summaryHash = hash(summary);
        if (summaryHash !== hash(old.lockedSummary) || summaryHash !== input.expectedSummaryHash) fail("JUDGING_PREVIEW_STALE", "有效评分或关联核查已变化，请重新打开评审后核对。");
        if (!summary.complete && old.config.missingPolicy === "block_publication") fail("JUDGING_MISSING_SCORES", "缺评尚未处理。");
        if (!["public", "participants"].includes(input.visibility) || !Array.isArray(input.approvedFeedback) || input.approvedFeedback.length > summary.rows.length * 2) invalid("公布范围或反馈格式不正确。");
        const feedbackKeys = new Set<string>();
        const approvedFeedback = input.approvedFeedback.map(item => {
          if (!summary.rows.some(row => row.snapshotId === item.snapshotId) || !["team", "public"].includes(item.visibility)) invalid("反馈必须对应本轮正式作品及明确可见范围。");
          const key = `${item.snapshotId}:${item.visibility}`; if (feedbackKeys.has(key)) invalid("同一作品的相同范围反馈不能重复。"); feedbackKeys.add(key);
          return { snapshotId: item.snapshotId, visibility: item.visibility, text: text(item.text, "批准反馈", 3000) };
        });
        let rows = summary.rows.map(row => ({ ...row }));
        if (old.config.tiePolicy === "manual_order") {
          const eligible = rows.filter(row => row.total !== null), order = input.orderedSnapshotIds;
          if (!Array.isArray(order) || order.length !== eligible.length || new Set(order).size !== order.length || order.some(id => !eligible.some(row => row.snapshotId === id))) invalid("请明确完整的有效作品顺序。");
          const ordered = order.map(id => eligible.find(row => row.snapshotId === id)!);
          for (let index = 1; index < ordered.length; index++) if (ordered[index - 1]!.total! < ordered[index]!.total!) invalid("人工同分顺序不能覆盖不同总分的先后。");
          rows = [...ordered.map((row, index) => ({ ...row, rank: index + 1 })), ...rows.filter(row => row.total === null)];
        }
        const prior = await store.listPublished(sql, scope);
        const result: PublishedResults = { id: ids.next(), eventId, organizationId: scope.organizationId, roundId, version: Math.max(0, ...prior.map(item => item.version)) + 1,
          visibility: input.visibility, publishedAt: now(), publishedBy: principal.actor.userId, rows, approvedFeedback };
        await store.insertPublished(sql, result);
        await updateRound(sql, scope, old, { ...old, revision: old.revision + 1, status: "published", publishedResultId: result.id });
        await audit(sql, principal, scope, "results_published", result.id, "", result); await staff(sql, principal, scope); return result;
      });
    },
    withdrawResults(principal: OrganizerPrincipal, eventId: string, roundId: string, input: { expectedRevision: number; reason: string }): Promise<JudgingRound> {
      return transact(principal, eventId, true, async (sql, scope) => {
        await staff(sql, principal, scope); const old = await roundIn(sql, scope, roundId); revision(old, input.expectedRevision);
        if (old.status !== "published") fail("JUDGING_STATE_INVALID", "当前没有可撤回的公布结果。");
        const reason = text(input.reason, "撤回说明", 1000), value = await updateRound(sql, scope, old, { ...old, revision: old.revision + 1, status: "locked", publishedResultId: null });
        await audit(sql, principal, scope, "results_withdrawn", old.publishedResultId!, reason, { before: old, after: value }); await staff(sql, principal, scope); return value;
      });
    },
    publicResults(eventId: string): Promise<ResultProjection> {
      return database.transaction(async sql => {
        const scope = await event(sql, eventId); if (!["published", "ended"].includes(scope.status)) fail("EVENT_NOT_FOUND", "没有找到公开赛事。", 404);
        return projection(sql, scope, null);
      });
    },
    myResults(principal: OrganizerPrincipal, eventId: string): Promise<ResultProjection> { return transact(principal, eventId, false, (sql, scope) => projection(sql, scope, principal)); },
    exportScores(principal: OrganizerPrincipal, eventId: string): Promise<{ filename: string; csv: string }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        const assignments = await store.listAssignments(sql, scope), scores = await store.listScores(sql, scope);
        const lines = [["指派编号", "评审轮", "作品快照", "评委账号", "指派状态", "评分状态", "分数", "评语"].map(csvCell).join(",")];
        for (const assignment of assignments) { const score = scores.find(item => item.assignmentId === assignment.id); lines.push([assignment.id, assignment.roundId, assignment.snapshotId, assignment.judgeUserId, assignment.status, score?.state ?? "未评分", score ? JSON.stringify(score.values) : "", score?.feedback ?? ""].map(csvCell).join(",")); }
        await staff(sql, principal, scope); return { filename: "judging-scores.csv", csv: `\uFEFF${lines.join("\r\n")}` };
      });
    },
    /**
     * 已公布结果的留档导出（与 `exportScores` 口径不同、**不覆盖它**）。
     *
     * 目的：`exportScores` 是"指派编号 + 评委账号 + 维度 JSON"的**内部对账表**，不能交给赞助方或学校；
     * 本方法产出的是**作品级**结果（作品名称 / 队伍标识 / 总分 / 名次 / 已批准反馈），
     * 用于留档与对外交付。
     *
     * 边界（规划 33 P06 第 2.2–2.4 节）：
     *  - 只输出主办方**已发布过**的投影字段，来源是既有的 `projection()`（它已实现 `needs_review`
     *    拦截与 `participants` 可见性复核），因此不另算一套分数或名次；
     *  - MUST NOT 导出评委账号或真名、联系人、答卷、私人求助、住宿、申诉正文；
     *  - `needs_review` 时不输出分数与名次，只输出状态与版本；
     *  - 未公布（或已撤回）时拒绝并说明原因；
     *  - 复用既有 `csvCell` 防公式注入；导出动作写既有审计。
     */
    exportResults(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<{ filename: string; csv: string }> {
      // `mutate: false` 与既有 `exportScores` 同口径：导出是 GET 读，只写一条审计，
      // 因此不索取赛事写锁，也不把归档赛事当成写操作拒绝（只读留档在归档后仍应可用）。
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope); const round = await roundIn(sql, scope, roundId);
        const published = round.status === "published" && round.publishedResultId ? await store.getPublished(sql, scope, round.publishedResultId) : null;
        if (!published) fail("RESULTS_NOT_PUBLISHED", "本轮还没有已公布结果，不能导出。请先完成人工汇总与公布；已撤回的版本也不会导出。", 409);
        // 留档件只含面向所有人的公开反馈；队伍专属反馈、评委身份与私人内容一律不进入本文件。
        const visible = await projection(sql, scope, null);
        if (visible.roundId && visible.roundId !== round.id)
          fail("RESULTS_NOT_PUBLISHED", "当前公开可见的是另一轮已公布结果，本轮的留档导出暂不可用。请在对应轮次导出，或先核对公布顺序。", 409);
        const generatedAt = now();
        const lines = [`# 已公布结果导出（留档用，不含评委身份与联系人）`,
          `# 赛事：${csvNote(scope.title)}`, `# 评审轮：${csvNote(round.config.title)}`,
          `# 公布版本：v${published.version}`, `# 公布时间：${published.publishedAt}`, `# 生成时间：${generatedAt}`];
        if (visible.status === "needs_review") {
          // 需复核时暂停分数与名次，只报状态与版本（与公开面行为一致）。
          lines.push(`# 状态：需复核（暂停展示分数、名次与反馈）`, `# 涉及作品数：${published.rows.length}`,
            ["作品名称", "队伍标识", "总分", "名次", "人工批准反馈"].map(csvCell).join(","));
          lines.push(["(需复核，未导出分数与名次)", "", "", "", ""].map(csvCell).join(","));
        } else {
          lines.push(["作品名称", "队伍标识", "总分", "名次", "人工批准反馈"].map(csvCell).join(","));
          for (const row of visible.rows) lines.push([row.title, row.teamId, row.total ?? "", row.rank ?? "", row.feedback ?? ""].map(csvCell).join(","));
        }
        await audit(sql, principal, scope, "results_exported", round.id,
          `导出已公布结果（公布版本 v${published.version}，${published.rows.length} 件作品）。只含公开投影字段。`, { roundId: round.id, version: published.version, status: visible.status });
        await staff(sql, principal, scope);
        return { filename: "judging-results.csv", csv: `\uFEFF${lines.join("\r\n")}` };
      });
    },
    /**
     * 规划 34 C①：本场作品展示（只读投影）。
     *
     * 赛事开关未开启 → 403 `WORK_SHOWCASE_DISABLED`（**不是**空数组）；开启但无人选择公开 → 200 空列表。
     * 只返回队伍**本人选择公开**的队伍的字段，且只含该队逐项勾选的内容；
     * `participants` 仅对本场报名已通过的选手返回，`public` 对所有已登录账号返回。
     */
    works(principal: OrganizerPrincipal, eventId: string): Promise<WorkShowcaseList> {
      return transact(principal, eventId, false, async (sql, scope) => {
        requireWorkShowcase(scope);
        return buildWorkShowcase(sql, scope, principal);
      });
    },
    /**
     * 含访客的公开读入口：与 `works` 共用同一个投影实现，只看 `scope === "public"` 的作品。
     * 根若不接这条路由，"公开（含访客）"这一档就只对已登录账号可见——三档语义会与界面说明不一致。
     */
    publicWorks(eventId: string): Promise<WorkShowcaseList> {
      return database.transaction(async sql => {
        const scope = await event(sql, eventId);
        if (!["published", "ended"].includes(scope.status)) fail("EVENT_NOT_FOUND", "没有找到公开赛事。", 404);
        requireWorkShowcase(scope);
        return buildWorkShowcase(sql, scope, null);
      });
    },
    /** 队伍侧：本队当前选择与历史；不做任何写入。无正式收件时也返回（说明还不能提交）。 */
    myWorkDisclosure(principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<MyWorkDisclosure> {
      return transact(principal, eventId, false, async (sql, scope) => {
        requireWorkShowcase(scope);
        const { roster, receipt } = await disclosureTeam(sql, principal, scope, workDisclosureTeamId(teamId));
        const view = myWorkDisclosureView({ teamId: roster.id, hasFormalReceipt: !!receipt, records: await store.listWorkDisclosures(sql, scope) });
        await disclosureTeam(sql, principal, scope, roster.id);
        return view;
      });
    },
    /**
     * 提交/重新提交本队的公开范围选择。
     *
     * - 只有**当前队伍成员**且在该队**最新正式收件回执成员快照**里的人可以提交（与申诉同口径）；
     * - 一队一条有效记录（部分唯一索引 + 赛事写锁）；再次提交会**取代**上一条（旧记录置 withdrawn，
     *   范围与字段不可改写，保留为可追溯历史）；
     * - 同一重试标识幂等：重放返回原记录，同键不同选择拒绝；
     * - 选择与既有分数、名次、公布、导出**完全无关**：本方法只写 `ej_work_disclosures` 与既有审计。
     */
    submitWorkDisclosure(principal: OrganizerPrincipal, eventId: string, teamId: string, input: WorkDisclosureInput): Promise<WorkDisclosure> {
      return transact(principal, eventId, true, async (sql, scope) => {
        requireWorkShowcase(scope);
        const id = workDisclosureTeamId(teamId);
        const key = workDisclosureIdempotencyKey(input.idempotencyKey);
        const scope_ = workDisclosureScope(input.scope), fields = workDisclosureFields(input.fields, scope_);
        const replay = await store.findWorkDisclosureReplay(sql, scope, principal.actor.userId, key);
        if (replay) {
          if (replay.teamId !== id || !sameWorkDisclosureChoice(replay, { scope: scope_, fields }))
            fail("IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一次公开范围选择，请刷新后重新提交。");
          await disclosureTeam(sql, principal, scope, replay.teamId);
          return replay;
        }
        const { roster, receipt } = await disclosureTeam(sql, principal, scope, id);
        const latest = receipt ?? fail("WORK_DISCLOSURE_NOT_PARTICIPATED", "本场还没有这支队伍的正式收件记录；正式交件后才能选择公开范围。");
        const active = await store.findActiveWorkDisclosure(sql, scope, roster.id);
        if (active && sameWorkDisclosureChoice(active, { scope: scope_, fields })) return active;
        if (active) {
          const at = now(), superseded: WorkDisclosure = { ...active, status: "withdrawn", revision: active.revision + 1, updatedAt: at, withdrawnAt: at };
          if (!await store.updateWorkDisclosure(sql, scope, active.revision, superseded)) fail("JUDGING_VERSION_CONFLICT", "公开范围刚刚更新，请刷新后核对再继续。");
          await audit(sql, principal, scope, "work_disclosure_superseded", superseded.id, "", { before: active, after: superseded });
        }
        const value: WorkDisclosure = { id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, teamId: roster.id,
          authorUserId: principal.actor.userId, revision: 1, receiptId: latest.id, receiptVersion: latest.version,
          scope: scope_, fields, status: "active", updatedAt: now(), withdrawnAt: null, idempotencyKey: key };
        await store.insertWorkDisclosure(sql, value);
        await audit(sql, principal, scope, "work_disclosure_submitted", value.id, "", { after: value });
        await disclosureTeam(sql, principal, scope, roster.id);
        return value;
      });
    },
    /** 撤回本队的公开范围选择：撤回后作品立即从展示中消失，之后仍可用新重试标识重新提交。 */
    withdrawWorkDisclosure(principal: OrganizerPrincipal, eventId: string, teamId: string, input: WorkDisclosureWithdrawInput): Promise<WorkDisclosure> {
      return transact(principal, eventId, true, async (sql, scope) => {
        requireWorkShowcase(scope);
        const id = workDisclosureTeamId(teamId);
        await disclosureTeam(sql, principal, scope, id);
        const active = await store.findActiveWorkDisclosure(sql, scope, id);
        if (!active) fail("WORK_DISCLOSURE_NOT_FOUND", "这支队伍当前没有有效的公开范围选择。", 404);
        const expected = workDisclosureRevision(input.expectedRevision);
        if (active.revision !== expected)
          throw new DomainError("JUDGING_VERSION_CONFLICT", "公开范围已更新，请刷新后核对再继续。", { status: 409, latestRevision: active.revision, recoveryAction: "reload" });
        const at = now(), value: WorkDisclosure = { ...active, status: "withdrawn", revision: active.revision + 1, updatedAt: at, withdrawnAt: at };
        if (!await store.updateWorkDisclosure(sql, scope, active.revision, value)) fail("JUDGING_VERSION_CONFLICT", "公开范围已更新，请刷新后核对再继续。");
        await audit(sql, principal, scope, "work_disclosure_withdrawn", value.id, "", { before: active, after: value });
        await disclosureTeam(sql, principal, scope, id);
        return value;
      });
    },
    /**
     * 主办方侧只读：本场已选择公开的作品 + 未公开队伍的**数量**（不含身份，不形成"谁没公开"的名单）。
     * 开关未开启同样 403；非本场 `judging_manage` 工作人员 403。此入口不改变任何分数、名次或公布。
     */
    eventWorkShowcase(principal: OrganizerPrincipal, eventId: string): Promise<OrganizerWorkShowcase> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        requireWorkShowcase(scope);
        const receipts = await store.listReceipts(sql, scope), disclosures = await store.listWorkDisclosures(sql, scope);
        const items = workShowcaseEntries({ receipts, disclosures, viewerIsParticipant: true });
        const disclosed = new Set(items.map(item => item.teamId));
        const notDisclosedTeamCount = [...new Set(receipts.map(receipt => receipt.teamId))].filter(teamId => !disclosed.has(teamId)).length;
        await staff(sql, principal, scope);
        return { eventId: scope.eventId, showcaseEnabled: true, visibleCount: items.length, items, notDisclosedTeamCount,
          notice: organizerWorkShowcaseNotice, limitations: workShowcaseLimitations };
      });
    },
    /**
     * 规划 34 C② 文字留言：读取一件**已由队伍本人选择公开**的作品的留言区。
     *
     * 三层门禁缺一即 403（不是空数组）；`participants` 档只对本场报名已通过的选手返回。
     * 返回面**不含作者账号**；隐藏后的留言正文不返回；留言与互评分列，绝不进入结果或导出。
     * 读取耗时内资格可能变化：返回前重新复核门禁与观看者资格，撤权后不再返回留言。
     */
    workComments(principal: OrganizerPrincipal, eventId: string, snapshotId: string): Promise<WorkCommentList> {
      return transact(principal, eventId, false, async (sql, scope) => {
        const { receipt, disclosure } = await commentTarget(sql, scope, snapshotId);
        await requireCommentViewer(sql, principal, scope, disclosure);
        const page = commentPage((await store.listWorkComments(sql, scope)).filter(comment => comment.teamId === receipt.teamId));
        const items = await commentViews(sql, scope, page.items, principal.actor.userId, await commentViewerIsStaff(sql, principal, scope));
        const again = await commentTarget(sql, scope, receipt.id);
        await requireCommentViewer(sql, principal, scope, again.disclosure);
        return { eventId: scope.eventId, snapshotId: receipt.id, teamId: receipt.teamId, commentsEnabled: true, scope: disclosure.scope as WorkCommentList["scope"],
          commentMaxLength: commentLimit(eventCommunity(scope)), cooldownSeconds: commentCooldownSeconds,
          items, totalCount: page.totalCount, hiddenCount: page.hiddenCount, truncated: page.truncated,
          notice: workCommentsNotice, notices: { ...workCommentNotices }, limitations: workCommentsLimitations };
      });
    },
    /**
     * 提交一条文字留言。
     *
     * - 三层门禁 + 观看者资格；长度上限取自 `community.commentMaxLength`（`commentLimit()`）；
     * - 同键幂等（同键不同正文 409 `IDEMPOTENCY_KEY_REUSED`）；
     * - 同账号同赛事限频（固定冷却 `commentCooldownSeconds`，已隐藏的留言同样计入，不能靠隐藏绕过）；
     * - 只写 `ej_work_comments` 与**既有** `audit()`：**不写评分、不碰互评数据**；
     *   审计只记留言 ID / 队伍 / 字数，**不记正文**（正文只在作品详情页的独立区返回）。
     */
    createWorkComment(principal: OrganizerPrincipal, eventId: string, snapshotId: string, input: WorkCommentInput): Promise<WorkCommentView> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const { receipt, disclosure } = await commentTarget(sql, scope, snapshotId);
        await requireCommentViewer(sql, principal, scope, disclosure);
        const body = commentText(input.text, commentLimit(eventCommunity(scope))), key = commentIdempotencyKey(input.idempotencyKey);
        const viewerIsStaff = await commentViewerIsStaff(sql, principal, scope);
        const replay = await store.findWorkCommentReplay(sql, scope, principal.actor.userId, key);
        if (replay) {
          if (replay.text !== body || replay.teamId !== receipt.teamId) fail("IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一条留言，请刷新后重新填写。");
          await requireCommentViewer(sql, principal, scope, (await commentTarget(sql, scope, receipt.id)).disclosure);
          return (await commentViews(sql, scope, [replay], principal.actor.userId, viewerIsStaff))[0]!;
        }
        const waiting = commentCooldownRemaining(await store.listWorkComments(sql, scope), principal.actor.userId, now());
        if (waiting) throw new DomainError("WORK_COMMENTS_RATE_LIMITED", `同一账号在同一场比赛里留言有 ${commentCooldownSeconds} 秒冷却，请 ${waiting} 秒后再试。`, { status: 429 });
        const value: WorkComment = { id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, teamId: receipt.teamId, snapshotId: receipt.id,
          authorUserId: principal.actor.userId, text: body, status: "active", revision: 1, createdAt: now(),
          hiddenAt: null, hiddenByUserId: null, hiddenByRole: null, hiddenReason: "", idempotencyKey: key };
        await store.insertWorkComment(sql, value);
        await audit(sql, principal, scope, "work_comment_created", value.id, "", { commentId: value.id, teamId: value.teamId, snapshotId: value.snapshotId, charCount: body.length });
        await requireCommentViewer(sql, principal, scope, (await commentTarget(sql, scope, receipt.id)).disclosure);
        return (await commentViews(sql, scope, [value], principal.actor.userId, viewerIsStaff))[0]!;
      });
    },
    /**
     * 隐藏一条留言：**留言作者本人**或**本场 `judging_manage` 工作人员**可以隐藏。
     * 幂等：已隐藏的留言直接返回原记录，不写第二次、不改版本（"一条留言只能被隐藏一次"）。
     * 隐藏后正文对所有读取面都不再返回（视图 `text` 为 `null`）；审计只记治理说明，不记正文。
     */
    hideWorkComment(principal: OrganizerPrincipal, eventId: string, snapshotId: string, commentId: string, input: WorkCommentHideInput): Promise<WorkCommentView> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const { receipt } = await commentTarget(sql, scope, snapshotId);
        const comment = await commentIn(sql, scope, commentId, receipt.teamId);
        const mine = comment.authorUserId === principal.actor.userId;
        // 作者本人走作者分支；否则必须持有本场 judging_manage（staff() 拒绝时给出既有的 403 STAFF_REQUIRED）。
        if (!mine) await staff(sql, principal, scope);
        const viewerIsStaff = !mine;
        if (comment.status === "hidden") return (await commentViews(sql, scope, [comment], principal.actor.userId, viewerIsStaff))[0]!;
        const reason = commentHideReason(input.reason);
        const value: WorkComment = { ...comment, status: "hidden", revision: comment.revision + 1, hiddenAt: now(),
          hiddenByUserId: principal.actor.userId, hiddenByRole: mine ? "author" : "staff", hiddenReason: reason };
        if (!await store.updateWorkComment(sql, scope, comment.revision, value)) {
          const current = await store.getWorkComment(sql, scope, comment.id);
          if (current?.status === "hidden") return (await commentViews(sql, scope, [current], principal.actor.userId, viewerIsStaff))[0]!;
          fail("JUDGING_VERSION_CONFLICT", "这条留言刚刚更新，请刷新后重试。");
        }
        await audit(sql, principal, scope, "work_comment_hidden", value.id, reason,
          { commentId: value.id, teamId: value.teamId, previousStatus: comment.status, status: value.status, role: mine ? "author" : "staff" });
        if (viewerIsStaff) await staff(sql, principal, scope);
        return (await commentViews(sql, scope, [value], principal.actor.userId, viewerIsStaff))[0]!;
      });
    },
    /**
     * 举报一条留言：任何**能看到这条留言**的人都可以举报。
     * 只记录举报事实（谁、何时、哪条、可选说明），**不改变留言状态、不做任何裁决、不封禁**；
     * 同账号同留言只有一条，重复举报幂等返回原记录。
     */
    reportWorkComment(principal: OrganizerPrincipal, eventId: string, snapshotId: string, commentId: string, input: WorkCommentReportInput): Promise<WorkCommentReportReceipt> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const { receipt, disclosure } = await commentTarget(sql, scope, snapshotId);
        await requireCommentViewer(sql, principal, scope, disclosure);
        const comment = await commentIn(sql, scope, commentId, receipt.teamId);
        if (comment.status === "hidden") fail("WORK_COMMENT_NOT_FOUND", "这条留言已不再返回，无法举报。", 404);
        const count = async (): Promise<number> => (await store.listWorkCommentReports(sql, scope)).filter(report => report.commentId === comment.id).length;
        const reason = commentReportReason(input.reason);
        const existing = await store.findWorkCommentReport(sql, scope, comment.id, principal.actor.userId);
        if (existing) return { reportId: existing.id, commentId: comment.id, reportedAt: existing.createdAt, reportedCount: await count(), alreadyReported: true };
        const value: WorkCommentReport = { id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, commentId: comment.id,
          reporterUserId: principal.actor.userId, reason, createdAt: now() };
        await store.insertWorkCommentReport(sql, value);
        // 审计只带举报说明与留言 ID（不复制留言正文），主办方按既有流程处理。
        await audit(sql, principal, scope, "work_comment_reported", comment.id, reason, { reportId: value.id, commentId: comment.id, teamId: comment.teamId, reasonLength: reason.length });
        await requireCommentViewer(sql, principal, scope, (await commentTarget(sql, scope, receipt.id)).disclosure);
        return { reportId: value.id, commentId: comment.id, reportedAt: value.createdAt, reportedCount: await count(), alreadyReported: false };
      });
    },
    auditHistory(principal: OrganizerPrincipal, eventId: string) {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope); const items = await store.listAudits(sql, scope); await staff(sql, principal, scope); return { items };
      });
    },
  };
}
export type EventJudgingService = ReturnType<typeof createEventJudgingService>;
function roundView(round: JudgingRound): JudgeRoundView { return { id: round.id, eventId: round.eventId, revision: round.revision, status: round.status, config: round.config, startedAt: round.startedAt, lockedAt: round.lockedAt }; }
function receiptView(receipt: IntakeReceipt): JudgeReceiptView { return { id: receipt.id, eventId: receipt.eventId, teamId: receipt.teamId, materials: receipt.materials, materialHash: receipt.materialHash, version: receipt.version, ruleVersion: receipt.ruleVersion, receiptNumber: receipt.receiptNumber, submittedAt: receipt.submittedAt, warning: receipt.warning }; }
function waitingProjection(): ResultProjection { return { status: "waiting_publication", reviewRequired: false, reviewNotice: null, version: null, publishedAt: null, roundId: null, roundTitle: null, rows: [] }; }
/** 导出文件头注释里的单行文本：去掉换行与控制字符，避免破坏注释行结构。 */
function csvNote(value: string): string { return value.replace(/[\r\n\u0000-\u001f]+/g, " ").trim().slice(0, 200); }
function confirmedVersionKey(value: unknown, linkedEventId: string): string {
  const key = typeof value === "string" ? value : "", prefix = `${linkedEventId}:`;
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (typeof value !== "string" || key.length > 200 || key !== key.trim() || !/^[1-9]\d*:[1-9]\d*$/.test(suffix) || suffix.split(":").some(part => !Number.isSafeInteger(Number(part)))) {
    throw new DomainError("TRUSTED_REQUIREMENTS_VERSION_INVALID", "可信收件上下文须提供当前关联赛事的完整确认规则版本键。", { status: 409 });
  }
  return key;
}
