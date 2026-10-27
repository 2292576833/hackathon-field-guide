import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type {
  EventCommunityConfig, EventNotificationPort, EventParticipationPort, EventStaffCapability,
  HostedEventAccessPort, HostedEventScope, OrganizerPrincipal,
} from "../../shared/organizer-contracts.ts";
import type {
  BlockResult, CommunityOverview, ConnectionInput, ConnectionMutationResult, ConnectionRespondInput,
  ConnectionResponseResult, ConnectionRevisionInput, ConversationView, DirectMessage, DirectMessageInput,
  DirectMessageView, DirectMessageWithdrawInput, EventConnection, NoticeDelivery, OrganizerReportView,
  OrganizerReportsView, ReportInput, ReportResult, RetentionMaintenanceResult, SendDirectMessageResult,
} from "./model.ts";
import * as store from "./postgres.ts";
import {
  CONNECTION_PENDING_LIMIT, CONNECTION_REJECT_COOLDOWN_DAYS, DIRECT_MESSAGE_MAX_LENGTH, DIRECT_MESSAGE_RATE_LIMIT,
  DIRECT_MESSAGE_RATE_WINDOW_MS, acceptedConnections, blockSilenceReason, communityCapabilities, communityGate,
  communityLimitations, communityLimits, communityNotices, communityPairKey, communityRecordId, communityUserId,
  connectionDecision, conversationView, directMessageView, expectedRevision, idempotencyKey, inRejectionCooldown,
  incomingRequests, invalid, messageContent, organizerReportsLimitations, organizerReportsNotice, outgoingRequests,
  pendingRequestsFor, purgeDaysOf, rateLimited, reportDetail, reportNotice, reportReason, reportReasonLabels, reportSnapshot,
  resolveCommunityConfig,
} from "./policy.ts";

/**
 * 选手社区服务：连接（双向同意）+ 私信（含屏蔽/举报/撤回/保留口径）。
 *
 * 写路径只有本模块自己的四张表；跨模块只经共享 Port：
 * - `HostedEventAccessPort` 读赛事与配置、`requireStaff` 判举报处理权限；
 * - `EventParticipationPort` 判"本场报名已通过"；
 * - `EventNotificationPort` 是**唯一**的通知写路径（不新建第二套通知系统）。
 *
 * 本服务不调用任何 AI，也不把消息内容写进任何模型输入（宪法 XII）。
 */
export interface EventCommunityDependencies {
  database: DatabasePort;
  clock: Clock;
  ids: IdGenerator;
  events: HostedEventAccessPort;
  participation: EventParticipationPort;
  /** 既有通知写路径。不注入时只记录站内事实，并在返回值里明确说明通知未发送。 */
  notification?: EventNotificationPort;
  /** 举报处理读权限；默认 `communication_manage`（通知与答疑）。 */
  staffCapability?: EventStaffCapability;
}

export function createEventCommunityService(deps: EventCommunityDependencies) {
  const { database, clock, ids, events, participation } = deps;
  const notification = deps.notification;
  const staffCapability: EventStaffCapability = deps.staffCapability ?? "communication_manage";
  const nowIso = () => clock.now().toISOString();
  const nowMs = () => clock.now().getTime();
  function fail(code: string, message: string, status = 409): never { throw new DomainError(code, message, { status }); }
  function conflict(revision: number): DomainError {
    return new DomainError("COMMUNITY_VERSION_CONFLICT", "记录已更新，请刷新后核对再继续。", { status: 409, latestRevision: revision, recoveryAction: "reload" });
  }
  function notSent(detail: string): NoticeDelivery { return { state: "not_sent", referenceId: null, detail }; }

  function errorMessage(error: unknown): string {
    if (error instanceof DomainError) return error.message;
    return "通知端口返回了未预期的错误";
  }

  /** 只经既有 `EventNotificationPort`；失败或被拒都不伪装成已发送。 */
  async function notify(sql: SqlExecutor, scope: HostedEventScope, actorUserId: string, recipientUserId: string, referenceId: string, revision: number): Promise<NoticeDelivery> {
    if (!notification) return { state: "unconfigured", referenceId: null, detail: "未注入既有通知端口：只记录站内事实，未发送任何通知。" };
    try {
      const result = await notification.enqueue(sql, { eventId: scope.eventId, announcementId: referenceId, revision, recipientUserIds: [recipientUserId], kind: "community", actorUserId });
      if (result.state === "queued") return { state: "queued", referenceId: result.referenceId, detail: "已通过既有通知端口入队；入队不代表收件人已收到或已读。" };
      return { state: "unconfigured", referenceId: null, detail: "既有通知端口当前未配置：只记录站内事实，未发送通知。" };
    } catch (error) {
      return { state: "not_sent", referenceId: null, detail: `既有通知端口未接受这条通知（${errorMessage(error)}）；站内事实已保存，通知未发送。` };
    }
  }

  async function requireParticipant(sql: SqlExecutor, scope: HostedEventScope, userId: string, label: string): Promise<void> {
    const registration = await participation.getRegistration(sql, scope.eventId, userId);
    if (!registration || registration.status !== "approved") fail("COMMUNITY_TARGET_NOT_PARTICIPANT", `${label}不是本场报名已通过的参赛者。`, 403);
  }

  async function requireNoBlock(sql: SqlExecutor, scope: HostedEventScope, left: string, right: string, message: string): Promise<void> {
    if (await store.findBlockBetween(sql, scope, left, right)) fail("COMMUNITY_BLOCKED", message, 403);
  }

  /** 已接受的连接；pending / rejected / cancelled 都不算连接。 */
  async function acceptedConnection(sql: SqlExecutor, scope: HostedEventScope, left: string, right: string): Promise<EventConnection | null> {
    const row = await store.findOpenConnection(sql, scope, communityPairKey(left, right));
    return row && row.status === "accepted" ? row : null;
  }

  async function transact<T>(
    principal: OrganizerPrincipal, eventId: string, mutate: boolean, need: "connections" | "directMessages",
    work: (sql: SqlExecutor, scope: HostedEventScope, config: EventCommunityConfig) => Promise<T>,
  ): Promise<T> {
    return database.transaction(async sql => {
      await principal.guard(sql);
      const scope = await events.getEvent(sql, communityRecordId(eventId, "赛事"), { forUpdate: mutate });
      if (!scope) fail("COMMUNITY_EVENT_NOT_FOUND", "没有找到这场比赛。", 404);
      if (mutate && scope.status === "archived") fail("COMMUNITY_EVENT_READ_ONLY", "比赛已归档，选手社区只能查看既有内容。");
      const config = resolveCommunityConfig(scope);
      const registration = await participation.getRegistration(sql, scope.eventId, principal.actor.userId);
      const gate = communityGate({ status: scope.status, config, registrationStatus: registration?.status ?? null }, need);
      if (!gate.ok) throw new DomainError(gate.code, gate.message, { status: gate.status });
      const output = await work(sql, scope, config);
      await principal.guard(sql);
      return output;
    });
  }

  return {
    /** 只读总览：本场能力开关 + 本人相关的请求/连接/屏蔽。名录本身复用既有参赛名片，本模块不另建。 */
    overview(principal: OrganizerPrincipal, eventId: string): Promise<CommunityOverview> {
      return transact(principal, eventId, false, "connections", async (sql, scope, config) => {
        const me = principal.actor.userId;
        const connections = await store.listConnections(sql, scope);
        const blocks = await store.listBlocks(sql, scope);
        const blockedPeers = new Set(blocks.filter(block => block.blockerUserId === me).map(block => block.blockedUserId));
        const blockedByPeers = new Set(blocks.filter(block => block.blockedUserId === me).map(block => block.blockerUserId));
        return {
          eventId: scope.eventId,
          capabilities: communityCapabilities(config),
          incoming: incomingRequests(connections, me),
          outgoing: outgoingRequests(connections, me),
          connections: acceptedConnections(connections, me).map(view => ({ ...view, blocked: blockedPeers.has(view.peerUserId) || blockedByPeers.has(view.peerUserId) })),
          blocks: blocks.filter(block => block.blockerUserId === me).map(block => ({ peerUserId: block.blockedUserId, blockedAt: block.createdAt })),
          limits: communityLimits(pendingRequestsFor(connections, me).length, 0),
          notices: communityNotices(),
          limitations: communityLimitations,
        };
      });
    },

    /** 发起"想认识"。对方接受才形成连接；被拒后有冷却；每人本场待处理请求有上限。 */
    requestConnection(principal: OrganizerPrincipal, eventId: string, input: ConnectionInput): Promise<ConnectionMutationResult> {
      return transact(principal, eventId, true, "connections", async (sql, scope) => {
        const me = principal.actor.userId;
        const peerUserId = communityUserId(input.peerUserId, "想认识的账号");
        if (peerUserId === me) invalid("不能向自己发起连接请求。");
        await requireParticipant(sql, scope, peerUserId, "你想认识的账号");
        await requireNoBlock(sql, scope, me, peerUserId, "你们之间存在屏蔽，不能发起连接请求。");
        const key = idempotencyKey(input.idempotencyKey);
        const replay = await store.findConnectionByRequestKey(sql, scope, me, key);
        if (replay) {
          if (replay.addresseeUserId !== peerUserId) fail("COMMUNITY_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一次连接请求，请刷新后重新提交。");
          return { connection: replay, notification: notSent("重试请求：沿用原记录，未重复发送通知。") };
        }
        const pairKey = communityPairKey(me, peerUserId);
        const open = await store.findOpenConnection(sql, scope, pairKey);
        if (open?.status === "accepted") fail("COMMUNITY_ALREADY_CONNECTED", "你们已经在本场连接上了，不需要重复发起。");
        if (open?.status === "pending") fail("COMMUNITY_REQUEST_EXISTS", "这条连接请求还在等待对方回应。");
        const rejection = await store.latestRejection(sql, scope, pairKey);
        if (rejection && inRejectionCooldown(rejection.respondedAt, nowMs(), CONNECTION_REJECT_COOLDOWN_DAYS))
          fail("COMMUNITY_REQUEST_COOLDOWN", `对方在最近 ${CONNECTION_REJECT_COOLDOWN_DAYS} 天内拒绝了连接请求，冷却期内不能再次发起。`);
        const pendingUsed = await store.countPendingForUser(sql, scope, me);
        if (pendingUsed >= CONNECTION_PENDING_LIMIT)
          throw new DomainError("COMMUNITY_REQUEST_LIMIT", `你在本场最多同时有 ${CONNECTION_PENDING_LIMIT} 条待处理连接请求，请先等待对方回应。`, { status: 429 });
        const value: EventConnection = {
          id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, pairKey,
          requesterUserId: me, addresseeUserId: peerUserId, status: "pending", revision: 1,
          requestedAt: nowIso(), respondedAt: null, decidedByUserId: null, idempotencyKey: key,
        };
        if (!await store.insertConnection(sql, value)) {
          const duplicate = await store.findConnectionByRequestKey(sql, scope, me, key);
          if (duplicate) {
            if (duplicate.addresseeUserId !== peerUserId) fail("COMMUNITY_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一次连接请求，请刷新后重新提交。");
            return { connection: duplicate, notification: notSent("重试请求：沿用原记录，未重复发送通知。") };
          }
          if (await store.findOpenConnection(sql, scope, pairKey)) fail("COMMUNITY_REQUEST_EXISTS", "这条连接请求还在等待对方回应。");
          fail("COMMUNITY_VERSION_CONFLICT", "连接请求没有保存成功，请刷新后重试。");
        }
        const notice = await notify(sql, scope, principal.actor.userId, peerUserId, value.id, value.revision);
        return { connection: value, notification: notice };
      });
    },

    /** 接受 / 拒绝一条连接请求。只有被邀请方可以处理；接受会通知发起人。 */
    respondConnection(principal: OrganizerPrincipal, eventId: string, connectionId: string, input: ConnectionRespondInput): Promise<ConnectionResponseResult> {
      return transact(principal, eventId, true, "connections", async (sql, scope) => {
        const me = principal.actor.userId;
        const record = await store.getConnection(sql, scope, communityRecordId(connectionId, "连接"));
        if (!record) fail("COMMUNITY_REQUEST_NOT_FOUND", "没有找到这条连接请求。", 404);
        if (record.status !== "pending") fail("COMMUNITY_REQUEST_NOT_PENDING", "这条连接请求已经处理过了。");
        if (record.addresseeUserId !== me) fail("COMMUNITY_NOT_ADDRESSEE", "只有被邀请的一方可以接受或拒绝这条连接请求。", 403);
        const decision = connectionDecision(input.decision);
        const expected = expectedRevision(input.expectedRevision);
        if (record.revision !== expected) throw conflict(record.revision);
        if (decision === "accept") await requireNoBlock(sql, scope, me, record.requesterUserId, "你们之间存在屏蔽，不能接受这条连接请求。");
        const value: EventConnection = {
          ...record, status: decision === "accept" ? "accepted" : "rejected",
          revision: record.revision + 1, respondedAt: nowIso(), decidedByUserId: me,
        };
        if (!await store.updateConnection(sql, scope, record.revision, value)) throw conflict(record.revision);
        const notice = decision === "accept" ? await notify(sql, scope, principal.actor.userId, record.requesterUserId, value.id, value.revision) : notSent("已拒绝这条连接请求，没有向对方发送通知。");
        return { connection: value, notification: notice };
      });
    },

    /** 发起人取消自己的待处理请求；取消不计入冷却（不是对方的拒绝）。 */
    cancelConnection(principal: OrganizerPrincipal, eventId: string, connectionId: string, input: ConnectionRevisionInput): Promise<ConnectionResponseResult> {
      return transact(principal, eventId, true, "connections", async (sql, scope) => {
        const me = principal.actor.userId;
        const record = await store.getConnection(sql, scope, communityRecordId(connectionId, "连接"));
        if (!record) fail("COMMUNITY_REQUEST_NOT_FOUND", "没有找到这条连接请求。", 404);
        if (record.status !== "pending") fail("COMMUNITY_REQUEST_NOT_PENDING", "这条连接请求已经处理过了。");
        if (record.requesterUserId !== me) fail("COMMUNITY_NOT_REQUESTER", "只有发起人可以取消这条连接请求。", 403);
        const expected = expectedRevision(input.expectedRevision);
        if (record.revision !== expected) throw conflict(record.revision);
        const value: EventConnection = { ...record, status: "cancelled", revision: record.revision + 1, respondedAt: nowIso(), decidedByUserId: me };
        if (!await store.updateConnection(sql, scope, record.revision, value)) throw conflict(record.revision);
        return { connection: value, notification: notSent("已取消自己的连接请求，没有向对方发送通知。") };
      });
    },

    /** 屏蔽是硬功能：屏蔽后对方不能发起连接、也不能发消息；同时自动拒绝双方之间待处理的请求。 */
    blockUser(principal: OrganizerPrincipal, eventId: string, peerUserId: string): Promise<BlockResult> {
      return transact(principal, eventId, true, "connections", async (sql, scope) => {
        const me = principal.actor.userId;
        const peer = communityUserId(peerUserId, "要屏蔽的账号");
        if (peer === me) invalid("不能屏蔽自己。");
        await requireParticipant(sql, scope, peer, "要屏蔽的账号");
        const existing = await store.findBlock(sql, scope, me, peer);
        if (existing) return { block: existing, rejectedRequests: 0 };
        const value = { id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, blockerUserId: me, blockedUserId: peer, createdAt: nowIso() };
        if (!await store.insertBlock(sql, value)) {
          const current = await store.findBlock(sql, scope, me, peer);
          if (current) return { block: current, rejectedRequests: 0 };
          fail("COMMUNITY_VERSION_CONFLICT", "屏蔽没有保存成功，请刷新后重试。");
        }
        const open = await store.findOpenConnection(sql, scope, communityPairKey(me, peer));
        let rejectedRequests = 0;
        if (open && open.status === "pending") {
          const rejected: EventConnection = { ...open, status: "rejected", revision: open.revision + 1, respondedAt: nowIso(), decidedByUserId: me };
          if (await store.updateConnection(sql, scope, open.revision, rejected)) rejectedRequests = 1;
        }
        return { block: value, rejectedRequests };
      });
    },

    /** 解除自己的屏蔽。不会撤销任何已记录的事实，也不会重置拒绝冷却。 */
    unblockUser(principal: OrganizerPrincipal, eventId: string, peerUserId: string): Promise<{ removed: boolean }> {
      return transact(principal, eventId, true, "connections", async (sql, scope) => {
        const me = principal.actor.userId;
        const peer = communityUserId(peerUserId, "要解除屏蔽的账号");
        if (peer === me) invalid("不能对自己解除屏蔽。");
        return { removed: await store.deleteBlock(sql, scope, me, peer) };
      });
    },

    /** 一段会话：只有双方已接受的连接可读；私信关闭时按保留口径只读。 */
    conversation(principal: OrganizerPrincipal, eventId: string, peerUserId: string): Promise<ConversationView> {
      return transact(principal, eventId, false, "connections", async (sql, scope, config) => {
        const me = principal.actor.userId;
        const peer = communityUserId(peerUserId, "对方账号");
        if (peer === me) invalid("不能和自己对话。");
        const connection = await acceptedConnection(sql, scope, me, peer);
        if (!connection) fail("COMMUNITY_NOT_CONNECTED", "你们还没有在本场连接；连接必须双方同意，之后才能看消息。", 403);
        const messages = await store.listMessages(sql, scope, connection.id);
        const blocked = Boolean(await store.findBlockBetween(sql, scope, me, peer));
        const rateUsed = await store.countMessagesSince(sql, scope, me, new Date(nowMs() - DIRECT_MESSAGE_RATE_WINDOW_MS).toISOString());
        return conversationView({ eventId: scope.eventId, connection, peerUserId: peer, viewerUserId: me, config, messages, blocked, nowMs: nowMs(), rateUsed });
      });
    },

    /** 发消息：只在已接受连接内；限长 + 同账号同赛事限频；成功后只经既有通知端口通知对方。 */
    sendDirectMessage(principal: OrganizerPrincipal, eventId: string, input: DirectMessageInput): Promise<SendDirectMessageResult> {
      return transact(principal, eventId, true, "directMessages", async (sql, scope, config) => {
        const me = principal.actor.userId;
        const peer = communityUserId(input.peerUserId, "对方账号");
        if (peer === me) invalid("不能给自己发消息。");
        const content = messageContent(input.content, DIRECT_MESSAGE_MAX_LENGTH);
        const key = idempotencyKey(input.idempotencyKey);
        const connection = await acceptedConnection(sql, scope, me, peer);
        if (!connection) fail("COMMUNITY_NOT_CONNECTED", "私信只在双方已接受的连接内可用。", 403);
        if (await store.findBlockBetween(sql, scope, me, peer)) fail("COMMUNITY_BLOCKED", blockSilenceReason, 403);
        const replay = await store.findMessageByKey(sql, scope, me, key);
        if (replay) {
          if (replay.recipientUserId !== peer || replay.connectionId !== connection.id || replay.content !== content)
            fail("COMMUNITY_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一条消息，请刷新后重新提交。");
          return { message: directMessageView(replay, me, config, nowMs()), notification: notSent("重试请求：沿用原消息，未重复发送通知。"), limits: communityLimits(0, 0) };
        }
        const since = new Date(nowMs() - DIRECT_MESSAGE_RATE_WINDOW_MS).toISOString();
        const used = await store.countMessagesSince(sql, scope, me, since);
        if (rateLimited(used, DIRECT_MESSAGE_RATE_LIMIT))
          throw new DomainError("COMMUNITY_RATE_LIMITED", `你在本场发送消息过于频繁：每 ${Math.round(DIRECT_MESSAGE_RATE_WINDOW_MS / 60000)} 分钟最多 ${DIRECT_MESSAGE_RATE_LIMIT} 条，请稍后再试。`, { status: 429 });
        const value: DirectMessage = {
          id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, connectionId: connection.id,
          senderUserId: me, recipientUserId: peer, content, status: "active", revision: 1,
          createdAt: nowIso(), withdrawnAt: null, purgedAt: null, idempotencyKey: key,
        };
        if (!await store.insertMessage(sql, value)) {
          const duplicate = await store.findMessageByKey(sql, scope, me, key);
          if (duplicate) {
            if (duplicate.recipientUserId !== peer || duplicate.connectionId !== connection.id || duplicate.content !== content)
              fail("COMMUNITY_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一条消息，请刷新后重新提交。");
            return { message: directMessageView(duplicate, me, config, nowMs()), notification: notSent("重试请求：沿用原消息，未重复发送通知。"), limits: communityLimits(0, used + 1) };
          }
          fail("COMMUNITY_VERSION_CONFLICT", "消息没有保存成功，请刷新后重试。");
        }
        const notice = await notify(sql, scope, principal.actor.userId, peer, value.id, value.revision);
        return { message: directMessageView(value, me, config, nowMs()), notification: notice, limits: communityLimits(0, used + 1) };
      });
    },

    /** 本人撤回自己发出的消息：正文清空，双方都只看到"已撤回"这个事实。 */
    withdrawDirectMessage(principal: OrganizerPrincipal, eventId: string, messageId: string, input: DirectMessageWithdrawInput): Promise<DirectMessageView> {
      return transact(principal, eventId, true, "connections", async (sql, scope, config) => {
        const me = principal.actor.userId;
        const record = await store.getMessage(sql, scope, communityRecordId(messageId, "消息"));
        if (!record) fail("COMMUNITY_MESSAGE_NOT_FOUND", "没有找到这条消息。", 404);
        if (record.senderUserId !== me) fail("COMMUNITY_ACCESS_DENIED", "只有发送这条消息的本人可以撤回。", 403);
        if (record.status !== "active") fail("COMMUNITY_STATE_INVALID", "这条消息已经撤回或已按保留口径清理，无需再次处理。");
        const expected = expectedRevision(input.expectedRevision);
        if (record.revision !== expected) throw conflict(record.revision);
        const value: DirectMessage = { ...record, content: null, status: "withdrawn", revision: record.revision + 1, withdrawnAt: nowIso(), purgedAt: null };
        if (!await store.updateMessage(sql, scope, record.revision, value)) throw conflict(record.revision);
        return directMessageView(value, me, config, nowMs());
      });
    },

    /** 举报：只记录事实与最近消息快照，不自行裁决、不自动隐藏、不改任何业务状态。 */
    reportUser(principal: OrganizerPrincipal, eventId: string, input: ReportInput): Promise<ReportResult> {
      return transact(principal, eventId, true, "connections", async (sql, scope, config) => {
        const me = principal.actor.userId;
        const peer = communityUserId(input.peerUserId, "被举报账号");
        if (peer === me) invalid("不能举报自己。");
        await requireParticipant(sql, scope, peer, "被举报的账号");
        const reason = reportReason(input.reason);
        const detail = reportDetail(input.detail ?? "");
        const key = idempotencyKey(input.idempotencyKey);
        const replay = await store.findReportByKey(sql, scope, me, key);
        if (replay) {
          if (replay.reportedUserId !== peer || replay.reason !== reason) fail("COMMUNITY_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一条举报，请刷新后重新提交。");
          return { report: replay, notice: reportNotice };
        }
        let connection: EventConnection | null;
        if (input.connectionId) {
          const requested = await store.getConnection(sql, scope, communityRecordId(input.connectionId, "连接"));
          if (!requested || requested.pairKey !== communityPairKey(me, peer) || requested.status !== "accepted")
            invalid("只能举报你们本场已连接的对话。");
          connection = requested;
        } else {
          connection = await acceptedConnection(sql, scope, me, peer);
        }
        const messages = connection ? await store.listMessages(sql, scope, connection.id) : [];
        const value = {
          id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, reporterUserId: me,
          reportedUserId: peer, connectionId: connection?.id ?? null, reason, detail,
          snapshot: reportSnapshot(messages, config, nowMs()), status: "open" as const, createdAt: nowIso(), idempotencyKey: key,
        };
        if (!await store.insertReport(sql, value)) {
          const duplicate = await store.findReportByKey(sql, scope, me, key);
          if (duplicate) return { report: duplicate, notice: reportNotice };
          fail("COMMUNITY_VERSION_CONFLICT", "举报没有保存成功，请刷新后重试。");
        }
        return { report: value, notice: reportNotice };
      });
    },

    /**
     * 主办方举报队列：只含被举报连接的快照，**没有读取任意私信的通道**。
     * 只读，处理发生在既有平台/主办方流程里。
     */
    organizerReports(principal: OrganizerPrincipal, eventId: string): Promise<OrganizerReportsView> {
      return database.transaction(async sql => {
        await principal.guard(sql);
        const scope = await events.getEvent(sql, communityRecordId(eventId, "赛事"));
        if (!scope) fail("COMMUNITY_EVENT_NOT_FOUND", "没有找到这场比赛。", 404);
        const current = await events.requireStaff(sql, principal.actor, scope.eventId, staffCapability);
        if (current.organizationId !== scope.organizationId || current.eventId !== scope.eventId)
          fail("COMMUNITY_EVENT_SCOPE_MISMATCH", "当前赛事权限不匹配。", 403);
        const reports: OrganizerReportView[] = (await store.listReports(sql, scope)).map(report => ({
          id: report.id, reporterUserId: report.reporterUserId, reportedUserId: report.reportedUserId,
          connectionId: report.connectionId, reason: report.reason, reasonLabel: reportReasonLabels[report.reason],
          detail: report.detail, snapshot: report.snapshot, status: report.status, createdAt: report.createdAt,
        }));
        await principal.guard(sql);
        return { eventId: scope.eventId, count: reports.length, reports, notice: organizerReportsNotice, limitations: organizerReportsLimitations };
      });
    },

    /**
     * 保留口径维护：只有 `retention=purge` 且设了正整数天数时才清理旧消息**正文**，
     * 保留可追溯的最小事实。建议由既有后台维护任务调用，不新建定时器。
     */
    maintainRetention(input: { eventId: string; organizationId: string; limit?: number }): Promise<RetentionMaintenanceResult> {
      return database.transaction(async sql => {
        const scope = await events.getEvent(sql, communityRecordId(input.eventId, "赛事"));
        if (!scope) fail("COMMUNITY_EVENT_NOT_FOUND", "没有找到这场比赛。", 404);
        if (scope.organizationId !== communityRecordId(input.organizationId, "机构")) fail("COMMUNITY_EVENT_SCOPE_MISMATCH", "当前赛事与机构范围不匹配。", 403);
        const config = resolveCommunityConfig(scope);
        const days = purgeDaysOf(config);
        if (days === null) {
          return { eventId: scope.eventId, retention: config.directMessageRetention, purgeDays: null, state: "skipped" as const, scanned: 0, purged: 0,
            notice: "本场保留口径不是「到期清理」或没有设置有效天数，因此不清理任何消息正文。" };
        }
        const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 500) : 200;
        const cutoff = new Date(nowMs() - days * 86_400_000).toISOString();
        const due = await store.listPurgeableMessages(sql, scope, cutoff, limit);
        let purged = 0;
        for (const record of due) {
          const value: DirectMessage = { ...record, content: null, status: "purged", revision: record.revision + 1, withdrawnAt: null, purgedAt: nowIso() };
          if (await store.updateMessage(sql, scope, record.revision, value)) purged += 1;
        }
        return { eventId: scope.eventId, retention: config.directMessageRetention, purgeDays: days, state: "purged" as const, scanned: due.length, purged,
          notice: `按本场保留口径清理了 ${purged} 条超过 ${days} 天的消息正文；只保留可追溯的最小事实。` };
      });
    },
  };
}
export type EventCommunityService = ReturnType<typeof createEventCommunityService>;
