import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import {
  DEFAULT_EVENT_COMMUNITY, eventCommunity,
  type HostedEventAccessPort, type HostedEventScope, type OrganizerPrincipal,
} from "../../shared/organizer-contracts.ts";
import type {
  EventPeerReviewSourcePort, PeerReview, PeerReviewInput, PeerReviewReport, PeerReviewReportInput,
  PeerReviewReportReceipt, PeerReviewScope, PeerReviewWithdrawInput, PeerReviewWithdrawResult,
  PeerReviewWork, WorkPeerReviewView,
} from "./model.ts";
import * as store from "./postgres.ts";
import {
  activeDisclosureOf, activeReviewsOf, latestWorkOf, peerReviewDimensionsOf, peerReviewGate,
  peerReviewIdempotencyKey, peerReviewPassRateOf, peerReviewReportReason, peerReviewReviewId,
  peerReviewReviewerAccess, peerReviewRevision, peerReviewScaleOf, peerReviewSelfReview,
  peerReviewThreshold, peerReviewValues, peerReviewViewerAccess, samePeerReviewInput,
  submittedReviewerCount, text, workPeerReviewView,
} from "./policy.ts";

/**
 * 选手数值互评服务（规划 34 P7 / 宪法 XIII）。
 *
 * **写路径只有本模块自己的两张表**：
 * - submitMyReview / withdrawMyReview 写 epr_peer_reviews；
 * - reportReview 写 epr_review_reports。
 * 本服务**不写任何评审表**，也不导入 event-judging 的聚合或导出，因此结构上不存在
 * 通往 aggregate() / results / results-export / 名次的写路径，也没有任何评委侧入口。
 *
 * 跨模块读取一律通过注入的只读 EventPeerReviewSourcePort，与 root 共用同一个 SqlExecutor（同一事务）。
 */
export interface EventPeerReviewDependencies {
  database: DatabasePort;
  clock: Clock;
  ids: IdGenerator;
  events: HostedEventAccessPort;
  /** 只读来源端口：正式收件（作品版本 + 成员快照）、队伍公开披露、本场报名已通过账号。 */
  source: EventPeerReviewSourcePort;
}

export function createEventPeerReviewService(deps: EventPeerReviewDependencies) {
  const { database, clock, ids, events, source } = deps;
  const now = () => clock.now().toISOString();
  function fail(code: string, message: string, status: number): never { throw new DomainError(code, message, { status }); }
  function conflict(message: string, latestRevision: number): never {
    throw new DomainError("PEER_REVIEW_VERSION_CONFLICT", message, { status: 409, latestRevision, recoveryAction: "reload" });
  }

  async function transact<T>(principal: OrganizerPrincipal, eventId: string, mutate: boolean, work: (sql: SqlExecutor, scope: HostedEventScope) => Promise<T>): Promise<T> {
    return database.transaction(async sql => {
      await principal.guard(sql);
      const scope = await events.getEvent(sql, text(eventId, "赛事", 160), { forUpdate: mutate });
      if (!scope) fail("EVENT_NOT_FOUND", "没有找到这场比赛。", 404);
      if (mutate && scope.status === "archived") fail("PEER_REVIEW_EVENT_READ_ONLY", "比赛已归档，互评只能查看既有记录。", 403);
      const output = await work(sql, scope);
      await principal.guard(sql);
      return output;
    });
  }

  /**
   * 定位作品：snapshotId 必须是该队**当前正在展示**（最新正式收件）的那一版，
   * 与 event-judging 作品展示取 latestReceiptOf 的口径一致——否则会出现"作品列表里没有、却有互评区"的第二套可见性。
   */
  async function resolveWork(sql: SqlExecutor, scope: HostedEventScope, snapshotId: string): Promise<PeerReviewWork> {
    const id = text(snapshotId, "作品", 160);
    const works = await source.intakeWorks(sql, scope.eventId);
    const work = works.find(item => item.id === id);
    if (!work) fail("PEER_REVIEW_WORK_NOT_FOUND", "没有找到这份正式作品。", 404);
    const latest = latestWorkOf(works, work.teamId);
    if (!latest || latest.id !== work.id) fail("PEER_REVIEW_WORK_NOT_CURRENT", "这个版本已不是该队伍当前展示的作品，互评区不在这里。", 403);
    return work;
  }

  /** 三层门禁（workShowcase + peerReview + 队伍本人选择公开）缺一即 403，且调用方事务里零行落库。 */
  async function target(sql: SqlExecutor, scope: HostedEventScope, snapshotId: string): Promise<{ work: PeerReviewWork; workScope: PeerReviewScope }> {
    const work = await resolveWork(sql, scope, snapshotId);
    const disclosure = activeDisclosureOf(await source.workDisclosures(sql, scope.eventId), work.teamId);
    const failure = peerReviewGate(eventCommunity(scope), disclosure);
    if (failure) fail(failure.code, failure.message, failure.status);
    return { work, workScope: disclosure!.scope === "public" ? "public" : "participants" };
  }

  async function approvedParticipants(sql: SqlExecutor, scope: HostedEventScope): Promise<readonly string[]> {
    return source.approvedParticipantIds(sql, scope.eventId);
  }

  /** 返回前重新复核门禁与观看者资格：撤权或撤回公开后不再返回互评内容。 */
  async function recheckViewer(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, snapshotId: string): Promise<void> {
    const again = await target(sql, scope, snapshotId);
    const failure = peerReviewViewerAccess(again.workScope, (await approvedParticipants(sql, scope)).includes(principal.actor.userId));
    if (failure) fail(failure.code, failure.message, failure.status);
  }

  /** 唯一的视图装配入口：只返回按作品的匿名汇总与本人那一条。 */
  async function view(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, work: PeerReviewWork, workScope: PeerReviewScope): Promise<WorkPeerReviewView> {
    const community = eventCommunity(scope);
    const scale = peerReviewScaleOf(community) ?? DEFAULT_EVENT_COMMUNITY.peerReviewScale;
    const dimensions = peerReviewDimensionsOf(community);
    const participants = await approvedParticipants(sql, scope);
    const reviews = await store.listReviews(sql, scope);
    const activeWorkReviews = activeReviewsOf(reviews, work.id);
    const mine = activeWorkReviews.find(review => review.reviewerUserId === principal.actor.userId) ?? null;
    const isParticipant = participants.includes(principal.actor.userId);
    const isOwnTeam = work.memberUserIds.includes(principal.actor.userId);
    const canReview = isParticipant && !isOwnTeam;
    const canReviewReason = canReview ? null : !isParticipant ? "只有本场报名已通过的参赛者能提交互评。" : "本队成员不能给本队作品互评（去自评）。";
    const threshold = peerReviewThreshold({
      requiredRate: peerReviewPassRateOf(community),
      submittedReviewerCount: submittedReviewerCount(reviews, participants),
      approvedParticipantCount: participants.length,
    });
    return workPeerReviewView({ eventId: scope.eventId, work, scope: workScope, scale, dimensions, reviews: activeWorkReviews, mine, canReview, canReviewReason, threshold });
  }

  return {
    /**
     * 本作品互评区：我的互评 + 门槛状态 + 达标后的按作品汇总。
     * 三层门禁 + 观看者资格；participants 档只有本场报名已通过的选手能读。
     */
    getWork(principal: OrganizerPrincipal, eventId: string, snapshotId: string): Promise<WorkPeerReviewView> {
      return transact(principal, eventId, false, async (sql, scope) => {
        const located = await target(sql, scope, snapshotId);
        const failure = peerReviewViewerAccess(located.workScope, (await approvedParticipants(sql, scope)).includes(principal.actor.userId));
        if (failure) fail(failure.code, failure.message, failure.status);
        const built = await view(sql, principal, scope, located.work, located.workScope);
        await recheckViewer(sql, principal, scope, located.work.id);
        return built;
      });
    },

    /**
     * 提交或修改我的互评。
     * - 去自评（收件成员快照）、仅本场报名已通过者可提交；
     * - 量纲与维度取主办方冻结配置，未知/缺失维度与越界取值分别 422；
     * - 修改必须先给出 expectedRevision（不给 409），旧版本保留为 superseded 历史；
     * - 同一重试标识幂等：同输入返回当前视图，同键不同输入 409。
     */
    submitMyReview(principal: OrganizerPrincipal, eventId: string, snapshotId: string, input: PeerReviewInput): Promise<WorkPeerReviewView> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const located = await target(sql, scope, snapshotId);
        const work = located.work, me = principal.actor.userId;
        const participants = await approvedParticipants(sql, scope);
        const reviewerFailure = peerReviewReviewerAccess(participants.includes(me));
        if (reviewerFailure) fail(reviewerFailure.code, reviewerFailure.message, reviewerFailure.status);
        const selfFailure = peerReviewSelfReview(work.memberUserIds, me);
        if (selfFailure) fail(selfFailure.code, selfFailure.message, selfFailure.status);
        const community = eventCommunity(scope);
        const scale = peerReviewScaleOf(community);
        if (!scale) fail("PEER_REVIEW_SCALE_INVALID", "本场互评量纲不是已冻结的取值，无法提交互评。", 422);
        const dimensions = peerReviewDimensionsOf(community);
        const values = peerReviewValues(input.values, dimensions, scale);
        const key = peerReviewIdempotencyKey(input.idempotencyKey);
        const replay = await store.findReviewReplay(sql, scope, me, key);
        if (replay) {
          if (!samePeerReviewInput(replay, { snapshotId: work.id, teamId: work.teamId, scale, dimensions, values }))
            fail("PEER_REVIEW_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一次互评，请刷新后重新提交。", 409);
          return view(sql, principal, scope, work, located.workScope);
        }
        const active = await store.findActiveReview(sql, scope, work.id, me);
        let revision: number;
        if (active) {
          if (input.expectedRevision === undefined)
            fail("PEER_REVIEW_REVISION_REQUIRED", "你已经提交过这件作品的互评；修改请带上当前版本号，避免覆盖最新修改。", 409);
          const expected = peerReviewRevision(input.expectedRevision);
          if (active.revision !== expected) conflict("这条互评已经更新，请刷新后核对再继续。", active.revision);
          const superseded: PeerReview = { ...active, status: "superseded", updatedAt: now(), supersededAt: now(), withdrawnAt: null };
          if (!await store.closeReview(sql, scope, active.revision, superseded)) conflict("这条互评已经更新，请刷新后核对再继续。", active.revision);
          revision = active.revision + 1;
        } else {
          // 没有有效记录时（首次提交或撤回后重提）版本接续本人在该作品上的历史最大值加一。
          const own = (await store.listReviews(sql, scope)).filter(review => review.snapshotId === work.id && review.reviewerUserId === me);
          revision = own.reduce((max, review) => Math.max(max, review.revision), 0) + 1;
        }
        const value: PeerReview = {
          id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, snapshotId: work.id, teamId: work.teamId,
          reviewerUserId: me, scale, dimensions, values, status: "active", revision,
          createdAt: now(), updatedAt: now(), withdrawnAt: null, supersededAt: null, idempotencyKey: key,
        };
        try { await store.insertReview(sql, value); }
        catch (error) {
          const current = await store.findActiveReview(sql, scope, work.id, me);
          if (current) conflict("这条互评刚刚更新，请刷新后核对再继续。", current.revision);
          throw error;
        }
        return view(sql, principal, scope, work, located.workScope);
      });
    },

    /**
     * 撤回我在本作品上的有效互评。
     * 撤回是撤回自己的数据：只要求是本人写的那一条，不要求作品此刻仍然公开、也不要求仍是参赛者。
     */
    withdrawMyReview(principal: OrganizerPrincipal, eventId: string, snapshotId: string, input: PeerReviewWithdrawInput): Promise<PeerReviewWithdrawResult> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const id = text(snapshotId, "作品", 160);
        const active = await store.findActiveReview(sql, scope, id, principal.actor.userId);
        if (!active) fail("PEER_REVIEW_NOT_FOUND", "没有找到你在这件作品上的有效互评。", 404);
        const expected = peerReviewRevision(input.expectedRevision);
        if (active.revision !== expected) conflict("这条互评已经更新，请刷新后核对再继续。", active.revision);
        const withdrawn: PeerReview = { ...active, status: "withdrawn", revision: active.revision + 1, updatedAt: now(), withdrawnAt: now() };
        if (!await store.closeReview(sql, scope, active.revision, withdrawn)) conflict("这条互评已经更新，请刷新后核对再继续。", active.revision);
        return { reviewId: withdrawn.id, snapshotId: withdrawn.snapshotId, revision: withdrawn.revision, withdrawnAt: withdrawn.withdrawnAt! };
      });
    },

    /**
     * 举报一条互评：任何能看到这件作品的人都可以举报。
     * 只记录事实（谁、何时、哪条、举报时刻的分值快照），**不改互评状态、不做裁决、不封禁**；
     * 同账号同一条互评只有一条记录，重复举报幂等返回原记录。
     */
    reportReview(principal: OrganizerPrincipal, eventId: string, snapshotId: string, reviewId: string, input: PeerReviewReportInput): Promise<PeerReviewReportReceipt> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const located = await target(sql, scope, snapshotId);
        const viewerFailure = peerReviewViewerAccess(located.workScope, (await approvedParticipants(sql, scope)).includes(principal.actor.userId));
        if (viewerFailure) fail(viewerFailure.code, viewerFailure.message, viewerFailure.status);
        const review = await store.getReview(sql, scope, peerReviewReviewId(reviewId));
        if (!review || review.snapshotId !== located.work.id || review.status !== "active") fail("PEER_REVIEW_NOT_FOUND", "没有找到这条互评。", 404);
        const reason = peerReviewReportReason(input.reason);
        const count = async (): Promise<number> => (await store.listReports(sql, scope)).filter(item => item.reviewId === review.id).length;
        const existing = await store.findReport(sql, scope, review.id, principal.actor.userId);
        if (existing) return { reportId: existing.id, reviewId: review.id, reportedAt: existing.createdAt, reportedCount: await count(), alreadyReported: true };
        const value: PeerReviewReport = {
          id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, reviewId: review.id,
          snapshotId: review.snapshotId, teamId: review.teamId, reporterUserId: principal.actor.userId,
          reason, values: review.values.map(item => ({ dimensionId: item.dimensionId, value: item.value })), scale: review.scale, createdAt: now(),
        };
        await store.insertReport(sql, value);
        return { reportId: value.id, reviewId: review.id, reportedAt: value.createdAt, reportedCount: await count(), alreadyReported: false };
      });
    },
  };
}
export type EventPeerReviewService = ReturnType<typeof createEventPeerReviewService>;
