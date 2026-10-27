import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { DEFAULT_EVENT_COMMUNITY, type EventCommunityConfig } from "../../shared/organizer-contracts.ts";
import {
  ageVerificationNotice, blockNotice, communityDefaultOffNotice, communityGate, communityLimitations,
  communityPairKey, connectionDecision, connectionMutualNotice, directMessageSafetyNotice, directMessageView,
  expectedRevision, idempotencyKey, inRejectionCooldown, incomingRequests, messageContent, messageVisibility,
  noAutoContactNotice, outgoingRequests, pendingRequestsFor, purgeDaysOf, rateLimited, rateRemaining,
  rejectionCooldownUntil, reportDetail, reportReason, reportSnapshot, resolveCommunityConfig, retentionNotice,
  trainingBoundaryNotice,
} from "./policy.ts";
import type { DirectMessage, EventConnection } from "./model.ts";

const failure = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

const config = (overrides: Partial<EventCommunityConfig> = {}): EventCommunityConfig =>
  ({ ...DEFAULT_EVENT_COMMUNITY, connections: true, directMessages: true, ...overrides });

const connection = (overrides: Partial<EventConnection> = {}): EventConnection => ({
  id: "c-1", organizationId: "org", eventId: "event-a", pairKey: communityPairKey("alice", "bob"),
  requesterUserId: "alice", addresseeUserId: "bob", status: "pending", revision: 1,
  requestedAt: "2026-10-16T00:00:00.000Z", respondedAt: null, decidedByUserId: null, idempotencyKey: "k-1", ...overrides,
});

const message = (overrides: Partial<DirectMessage> = {}): DirectMessage => ({
  id: "m-1", organizationId: "org", eventId: "event-a", connectionId: "c-1", senderUserId: "alice", recipientUserId: "bob",
  content: "你好", status: "active", revision: 1, createdAt: "2026-10-16T00:00:00.000Z",
  withdrawnAt: null, purgedAt: null, idempotencyKey: "k-1", ...overrides,
});

const gateCode = (result: ReturnType<typeof communityGate>): string => (result.ok ? "ok" : result.code);
const gateStatus = (result: ReturnType<typeof communityGate>): number => (result.ok ? 200 : result.status);

test("配置读取：整块缺失或逐字段缺失都按全关处理，只有显式 true 才算开启", () => {
  const off = resolveCommunityConfig(undefined);
  assert.equal(off.connections, false);
  assert.equal(off.directMessages, false);
  assert.equal(off.participantDirectory, false);
  assert.equal(off.directMessageRetention, "freeze");
  assert.deepEqual(resolveCommunityConfig(null), off);
  assert.deepEqual(resolveCommunityConfig({}), off);
  const partial = resolveCommunityConfig({ community: { connections: true } as unknown as EventCommunityConfig });
  assert.equal(partial.connections, true);
  assert.equal(partial.directMessages, false);
  assert.equal(partial.participantDirectory, false);
  const bogus = resolveCommunityConfig({ community: { connections: "yes", directMessages: 1, directMessageRetention: "forever", directMessagePurgeDays: -1 } as unknown as EventCommunityConfig });
  assert.equal(bogus.connections, false, "非布尔真值不算开启");
  assert.equal(bogus.directMessages, false);
  assert.equal(bogus.directMessageRetention, "freeze");
  assert.equal(bogus.directMessagePurgeDays, null);
});

test("门禁分层：连接关闭时连接与私信都 403；只有私信关闭时连接可用、发信被拒", () => {
  const closed = communityGate({ status: "published", config: resolveCommunityConfig({}), registrationStatus: "approved" }, "connections");
  assert.equal(gateCode(closed), "COMMUNITY_DISABLED");
  assert.equal(gateStatus(closed), 403);
  const closedSend = communityGate({ status: "published", config: resolveCommunityConfig({}), registrationStatus: "approved" }, "directMessages");
  assert.equal(gateCode(closedSend), "COMMUNITY_DISABLED", "连接关闭时私信也一起不可用");

  const dmOff = config({ directMessages: false });
  assert.equal(communityGate({ status: "published", config: dmOff, registrationStatus: "approved" }, "connections").ok, true);
  const send = communityGate({ status: "published", config: dmOff, registrationStatus: "approved" }, "directMessages");
  assert.equal(gateCode(send), "COMMUNITY_DIRECT_MESSAGES_DISABLED");
  assert.equal(gateStatus(send), 403);

  const draft = communityGate({ status: "draft", config: config(), registrationStatus: "approved" }, "connections");
  assert.equal(gateCode(draft), "COMMUNITY_EVENT_NOT_OPEN");
  assert.equal(gateStatus(draft), 403);
  for (const status of [null, "draft", "pending", "rejected", "withdrawn"] as const) {
    const denied = communityGate({ status: "published", config: config(), registrationStatus: status }, "connections");
    assert.equal(gateCode(denied), "COMMUNITY_PARTICIPANT_REQUIRED");
    assert.equal(gateStatus(denied), 403);
  }
  assert.equal(communityGate({ status: "ended", config: config(), registrationStatus: "approved" }, "directMessages").ok, true);
});

test("输入校验：账号/连接/消息/举报/版本/重试标识与用户输入边界", () => {
  assert.equal(connectionDecision("accept"), "accept");
  assert.equal(connectionDecision("reject"), "reject");
  for (const bad of ["yes", "ACCEPT", 1, null]) assert.throws(() => connectionDecision(bad), failure("COMMUNITY_INVALID_INPUT"));
  assert.equal(expectedRevision(3), 3);
  for (const bad of [0, -1, 1.5, "1", NaN]) assert.throws(() => expectedRevision(bad), failure("COMMUNITY_INVALID_INPUT"));
  assert.equal(idempotencyKey("key-1"), "key-1");
  assert.throws(() => idempotencyKey("x".repeat(121)), failure("COMMUNITY_INVALID_INPUT"));
  assert.equal(messageContent("  你好  "), "你好");
  assert.throws(() => messageContent("   "), failure("COMMUNITY_INVALID_INPUT"));
  assert.throws(() => messageContent("x".repeat(1001)), failure("COMMUNITY_INVALID_INPUT"));
  assert.ok(messageContent("行一\n行二").includes("\n"), "正文允许换行");
  assert.throws(() => messageContent("bad\u0007char"), failure("COMMUNITY_INVALID_INPUT"));
  assert.equal(reportReason("harassment"), "harassment");
  assert.throws(() => reportReason("unknown"), failure("COMMUNITY_INVALID_INPUT"));
  assert.equal(reportDetail("  说明  "), "说明");
  assert.equal(reportDetail(""), "");
  assert.throws(() => reportDetail("x".repeat(1001)), failure("COMMUNITY_INVALID_INPUT"));
});

test("账号对键与拒绝冷却：同一对方向无关，冷却期内同一对不能再发起", () => {
  assert.equal(communityPairKey("alice", "bob"), communityPairKey("bob", "alice"));
  assert.notEqual(communityPairKey("alice", "bob"), communityPairKey("alice", "carol"));
  assert.equal(inRejectionCooldown(null, Date.parse("2026-10-16T00:00:00.000Z")), false);
  const rejectedAt = "2026-10-01T00:00:00.000Z";
  assert.equal(rejectionCooldownUntil(rejectedAt), "2026-10-31T00:00:00.000Z");
  assert.equal(inRejectionCooldown(rejectedAt, Date.parse("2026-10-16T00:00:00.000Z")), true);
  assert.equal(inRejectionCooldown(rejectedAt, Date.parse("2026-11-01T00:00:00.000Z")), false);
  assert.equal(inRejectionCooldown("not-a-date", Date.parse("2026-10-16T00:00:00.000Z")), false);
});

test("待处理请求与限频只按账号统计，不把取消/拒绝算进待处理", () => {
  const rows = [
    connection({ id: "c-1", requesterUserId: "alice", addresseeUserId: "bob", status: "pending" }),
    connection({ id: "c-2", requesterUserId: "carol", addresseeUserId: "alice", status: "pending" }),
    connection({ id: "c-3", requesterUserId: "alice", addresseeUserId: "dave", status: "rejected", respondedAt: "2026-10-16T01:00:00.000Z", decidedByUserId: "dave" }),
    connection({ id: "c-4", requesterUserId: "alice", addresseeUserId: "erin", status: "accepted", respondedAt: "2026-10-16T01:00:00.000Z", decidedByUserId: "erin" }),
  ];
  assert.deepEqual(pendingRequestsFor(rows, "alice").map(row => row.id), ["c-1", "c-2"]);
  assert.deepEqual(incomingRequests(rows, "alice").map(row => row.peerUserId), ["carol"]);
  assert.deepEqual(outgoingRequests(rows, "alice").map(row => row.peerUserId), ["bob"]);
  assert.equal(rateLimited(19, 20), false);
  assert.equal(rateLimited(20, 20), true);
  assert.equal(rateRemaining(17, 20), 3);
  assert.equal(rateRemaining(25, 20), 0);
});

test("撤回与到期清理在读取时生效；冻结/保留口径仍可读", () => {
  const nowMs = Date.parse("2026-10-16T00:00:00.000Z");
  assert.deepEqual(messageVisibility(message(), config(), nowMs), { content: "你好", reason: "visible" });
  assert.deepEqual(messageVisibility(message({ status: "withdrawn", content: null, withdrawnAt: "2026-10-16T01:00:00.000Z" }), config(), nowMs), { content: null, reason: "withdrawn" });
  assert.deepEqual(messageVisibility(message({ status: "purged", content: null, purgedAt: "2026-10-16T01:00:00.000Z" }), config(), nowMs), { content: null, reason: "purged" });
  const purge = config({ directMessageRetention: "purge", directMessagePurgeDays: 7 });
  assert.equal(purgeDaysOf(purge), 7);
  assert.equal(purgeDaysOf(config({ directMessageRetention: "purge", directMessagePurgeDays: null })), null);
  const old = message({ createdAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(messageVisibility(old, purge, nowMs), { content: null, reason: "purged" }, "超过天数的正文即使后台没跑也不返回");
  const recent = message({ createdAt: "2026-10-15T00:00:00.000Z" });
  assert.equal(messageVisibility(recent, purge, nowMs).content, "你好");
  assert.equal(messageVisibility(old, config({ directMessageRetention: "keep" }), nowMs).content, "你好");
  assert.equal(messageVisibility(old, config(), nowMs).content, "你好", "默认冻结只读不清正文");

  const mine = directMessageView(message(), "alice", config(), nowMs);
  assert.equal(mine.mine, true);
  assert.equal(mine.display, "你好");
  const theirs = directMessageView(message({ status: "withdrawn", content: null }), "bob", config(), nowMs);
  assert.equal(theirs.mine, false);
  assert.equal(theirs.content, null);
  assert.match(theirs.display, /撤回/);
  assert.match(directMessageView(message({ status: "purged", content: null }), "alice", config(), nowMs).display, /清理/);
});

test("举报快照只取最近 N 条最小事实；到期清理口径不复制正文", () => {
  const nowMs = Date.parse("2026-10-16T00:00:00.000Z");
  const messages = Array.from({ length: 12 }, (_, index) => message({
    id: `m-${String(index).padStart(2, "0")}`, content: `第${index}条`,
    createdAt: new Date(Date.parse("2026-10-16T00:00:00.000Z") + index * 60_000).toISOString(),
  }));
  const snapshot = reportSnapshot(messages, config(), nowMs, 3);
  assert.deepEqual(snapshot.map(entry => entry.messageId), ["m-09", "m-10", "m-11"]);
  assert.equal(snapshot[0]!.content, "第9条");
  const withdrawn = reportSnapshot([message({ status: "withdrawn", content: null })], config(), nowMs);
  assert.equal(withdrawn[0]!.content, null);
  assert.equal(withdrawn[0]!.status, "withdrawn");
  const purge = reportSnapshot(messages, config({ directMessageRetention: "purge", directMessagePurgeDays: 7 }), nowMs, 3);
  assert.deepEqual(purge.map(entry => entry.content), [null, null, null], "到期清理口径下举报记录也不复制正文");
  assert.equal(purge[0]!.senderUserId, "alice");
  assert.equal(purge[0]!.createdAt, messages[9]!.createdAt, "最小事实（谁、何时）保留");
});

test("安全口径原文：双向同意、屏蔽举报、不暴露联系方式、不做年龄核验、不进模型训练", () => {
  assert.match(connectionMutualNotice, /双方同意/);
  assert.match(connectionMutualNotice, /单向关注/);
  assert.match(noAutoContactNotice, /不会补全/);
  assert.match(noAutoContactNotice, /邮箱、电话/);
  assert.match(directMessageSafetyNotice, /屏蔽/);
  assert.match(directMessageSafetyNotice, /举报/);
  assert.match(ageVerificationNotice, /不声称提供年龄核验/);
  assert.match(trainingBoundaryNotice, /不会进入任何模型训练/);
  assert.match(trainingBoundaryNotice, /不调用任何 AI/);
  assert.match(blockNotice, /不能向你发起连接/);
  assert.match(communityDefaultOffNotice, /403/);
  const keep = retentionNotice(config({ directMessageRetention: "keep" }));
  const freeze = retentionNotice(config());
  const purge = retentionNotice(config({ directMessageRetention: "purge", directMessagePurgeDays: 30 }));
  assert.match(keep, /保留可读/);
  assert.match(freeze, /冻结只读/);
  assert.match(purge, /30 天/);
  assert.match(retentionNotice(config({ directMessageRetention: "purge", directMessagePurgeDays: null })), /暂不清理/);
  assert.ok(communityLimitations.some(line => line.includes("模型训练")));
  assert.ok(communityLimitations.some(line => line.includes("不另建第二份名录")));
});
