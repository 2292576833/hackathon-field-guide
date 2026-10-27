import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EVENT_COMMUNITY, type EventCommunityConfig } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { PeerReview, PeerReviewWork } from "./model.ts";
import {
  activeDisclosureOf, activeReviewsOf, latestWorkOf, myPeerReview, peerReviewDimensionsOf, peerReviewGate,
  peerReviewIdempotencyKey, peerReviewLimitations, peerReviewNotice, peerReviewNotices, peerReviewPassRateOf,
  peerReviewRevision, peerReviewScaleOf, peerReviewSelfReview, peerReviewThreshold, peerReviewValueRange,
  peerReviewValues, peerReviewViewerAccess, peerReviewReviewerAccess, samePeerReviewInput, submittedReviewerCount,
  workPeerReviewSummary, workPeerReviewView,
} from "./policy.ts";

/**
 * 数值互评的**纯逻辑**验收：三层门禁、量纲与维度、去自评、参与率门槛、匿名汇总、治理口径。
 * 全部是行为断言（不是目测），不依赖数据库或事务。
 */
const currentTime = "2026-10-16T08:00:00.000Z";
const dimensions = [{ id: "d1", label: "创意" }, { id: "d2", label: "完成度" }] as const;
const community = (overrides: Partial<EventCommunityConfig> = {}): EventCommunityConfig =>
  ({ ...DEFAULT_EVENT_COMMUNITY, workShowcase: true, peerReview: true, peerReviewDimensions: [...dimensions], ...overrides });
const disclosure = (scope: "private" | "participants" | "public", status: "active" | "withdrawn" = "active") => ({ scope, status });
const review = (overrides: Partial<PeerReview> = {}): PeerReview => ({
  id: "r1", organizationId: "org-a", eventId: "event-a", snapshotId: "snap-1", teamId: "team-a", reviewerUserId: "alice",
  scale: "1-5", dimensions: [...dimensions], values: [{ dimensionId: "d1", value: 4 }, { dimensionId: "d2", value: 5 }],
  status: "active", revision: 1, createdAt: currentTime, updatedAt: currentTime, withdrawnAt: null, supersededAt: null,
  idempotencyKey: "k1", ...overrides });
const code = (expected: string, status = 422) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === expected && error.status === status;

test("三层门禁：作品展示、数值互评、队伍本人公开缺一即 403，顺序固定且不返回空数组", () => {
  // ① 作品展示关闭：即使其余两层都满足也拒绝。
  const off = peerReviewGate(community({ workShowcase: false }), disclosure("public"))!;
  assert.equal(off.code, "WORK_SHOWCASE_DISABLED"); assert.equal(off.status, 403);
  // ② 展示已开、数值互评关闭：明确 PEER_REVIEW_DISABLED（不是"没有互评"）。
  assert.equal(peerReviewGate(community({ peerReview: false }), disclosure("participants"))!.code, "PEER_REVIEW_DISABLED");
  // ③ 两层开关都开，但队伍本人没有选择公开 / 选择不公开 / 记录已撤回：一律 PEER_REVIEW_NOT_DISCLOSED。
  assert.equal(peerReviewGate(community(), null)!.code, "PEER_REVIEW_NOT_DISCLOSED");
  assert.equal(peerReviewGate(community(), disclosure("private"))!.code, "PEER_REVIEW_NOT_DISCLOSED");
  assert.equal(peerReviewGate(community(), disclosure("public", "withdrawn"))!.code, "PEER_REVIEW_NOT_DISCLOSED");
  // 三层齐全才放行，participants 与 public 都放行。
  assert.equal(peerReviewGate(community(), disclosure("participants")), null);
  assert.equal(peerReviewGate(community(), disclosure("public")), null);
});

test("观看者与评分者资格：participants 档只有本场通过者；访客能看公开作品但不能互评", () => {
  assert.equal(peerReviewViewerAccess("participants", false)!.code, "PEER_REVIEW_PARTICIPANTS_ONLY");
  assert.equal(peerReviewViewerAccess("participants", true), null);
  assert.equal(peerReviewViewerAccess("public", false), null, "公开档对非参赛者的已登录账号同样开放");
  assert.equal(peerReviewViewerAccess("public", true), null);
  assert.equal(peerReviewReviewerAccess(false)!.code, "PEER_REVIEW_PARTICIPANT_REQUIRED");
  assert.equal(peerReviewReviewerAccess(false)!.status, 403);
  assert.equal(peerReviewReviewerAccess(true), null);
});

test("去自评：正式收件成员快照里的人不能评本队作品，其他人可以", () => {
  assert.equal(peerReviewSelfReview(["alice", "bob"], "alice")!.code, "PEER_REVIEW_SELF_REVIEW");
  assert.equal(peerReviewSelfReview(["alice", "bob"], "alice")!.status, 403);
  assert.equal(peerReviewSelfReview(["alice", "bob"], "carol"), null);
  assert.equal(peerReviewSelfReview([], "alice"), null, "没有成员快照时不误判为自评");
});

test("量纲与维度：只接受 EVENT_COMMUNITY_SCALES 与冻结维度，不补默认维度", () => {
  assert.equal(peerReviewScaleOf(community({ peerReviewScale: "1-5" })), "1-5");
  assert.equal(peerReviewScaleOf(community({ peerReviewScale: "0-10" })), "0-10");
  assert.equal(peerReviewScaleOf(community({ peerReviewScale: "yes-no" })), "yes-no");
  assert.equal(peerReviewScaleOf(community({ peerReviewScale: "1-10" as never })), null, "未冻结的量纲一律拒绝");
  assert.deepEqual(peerReviewValueRange("1-5"), { min: 1, max: 5 });
  assert.deepEqual(peerReviewValueRange("0-10"), { min: 0, max: 10 });
  assert.deepEqual(peerReviewValueRange("yes-no"), { min: 0, max: 1 });
  assert.deepEqual(peerReviewDimensionsOf(community()).map(item => item.id), ["d1", "d2"]);
  assert.deepEqual(peerReviewDimensionsOf(community({ peerReviewDimensions: [] })), [], "未配置就是空，不补默认维度");
  assert.deepEqual(peerReviewDimensionsOf(community({ peerReviewDimensions: [{ id: "", label: "x" }, { id: "d1", label: "创意" }, { id: "d1", label: "重复" }, { id: "d2" } as never] })).map(item => item.id), ["d1"], "畸形与重复维度被丢弃");
  assert.equal(peerReviewDimensionsOf(community({ peerReviewDimensions: Array.from({ length: 30 }, (_, index) => ({ id: "d" + index, label: "维度" + index })) })).length, 12, "防御性截断到 12");
});

test("参与率门槛：非法配置回退默认，未达门槛只给门槛值本身", () => {
  assert.equal(peerReviewPassRateOf(community({ peerReviewPassRate: 0.5 })), 0.5);
  assert.equal(peerReviewPassRateOf(community({ peerReviewPassRate: 0.1 })), 0.1);
  assert.equal(peerReviewPassRateOf(community({ peerReviewPassRate: 1 })), 1);
  for (const invalid of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0.3" as never]) {
    assert.equal(peerReviewPassRateOf(community({ peerReviewPassRate: invalid })), DEFAULT_EVENT_COMMUNITY.peerReviewPassRate, "配置异常必须回退默认值：" + String(invalid));
  }
  const notMet = peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 1, approvedParticipantCount: 10 });
  assert.equal(notMet.met, false); assert.equal(notMet.code, "PEER_REVIEW_THRESHOLD_NOT_MET"); assert.equal(notMet.requiredRate, 0.3);
  assert.equal(notMet.passRate, undefined); assert.equal(notMet.submittedReviewerCount, undefined); assert.equal(notMet.approvedParticipantCount, undefined);
  assert.match(notMet.message, /30%/);
  const noParticipants = peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 0, approvedParticipantCount: 0 });
  assert.equal(noParticipants.met, false, "没有报名已通过人数时不展示汇总");
  const same = peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 3, approvedParticipantCount: 10 });
  assert.equal(same.met, true); assert.equal(same.code, "PEER_REVIEW_SUMMARY_READY"); assert.equal(same.passRate, 0.3);
  const above = peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 9, approvedParticipantCount: 10 });
  assert.equal(above.met, true); assert.equal(above.passRate, 0.9);
  assert.equal(peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 99, approvedParticipantCount: 10 }).submittedReviewerCount, 10, "分子永远不会超过分母");
  assert.equal(submittedReviewerCount([review(), review({ id: "r2", reviewerUserId: "bob" }), review({ id: "r3", reviewerUserId: "carol", status: "withdrawn" })], ["alice", "bob", "carol"]), 2, "只统计仍有效的互评");
  assert.equal(submittedReviewerCount([review({ reviewerUserId: "left" })], ["alice"]), 0, "已不是报名已通过者不计入");
});

test("逐维度整数校验：未知/缺失维度与越界取值分别 422，不自行补维度", () => {
  const values = peerReviewValues({ d1: 4, d2: 5 }, [...dimensions], "1-5");
  assert.deepEqual(values, [{ dimensionId: "d1", value: 4 }, { dimensionId: "d2", value: 5 }]);
  assert.deepEqual(peerReviewValues({ d1: 0, d2: 1 }, [...dimensions], "yes-no"), [{ dimensionId: "d1", value: 0 }, { dimensionId: "d2", value: 1 }]);
  assert.throws(() => peerReviewValues({ d1: 4, d2: 5, d3: 1 }, [...dimensions], "1-5"), code("PEER_REVIEW_DIMENSION_INVALID"));
  assert.throws(() => peerReviewValues({ d1: 4 }, [...dimensions], "1-5"), code("PEER_REVIEW_DIMENSION_INVALID"));
  assert.throws(() => peerReviewValues([4, 5], [...dimensions], "1-5"), code("PEER_REVIEW_DIMENSION_INVALID"));
  assert.throws(() => peerReviewValues({ d1: 4, d2: 5 }, [], "1-5"), code("PEER_REVIEW_DIMENSION_INVALID"), "没有冻结维度时不能提交");
  assert.throws(() => peerReviewValues({ d1: 4.5, d2: 5 }, [...dimensions], "1-5"), code("PEER_REVIEW_VALUE_OUT_OF_RANGE"));
  assert.throws(() => peerReviewValues({ d1: "4", d2: 5 }, [...dimensions], "1-5"), code("PEER_REVIEW_VALUE_OUT_OF_RANGE"));
  assert.throws(() => peerReviewValues({ d1: 0, d2: 5 }, [...dimensions], "1-5"), code("PEER_REVIEW_VALUE_OUT_OF_RANGE"), "1-5 不接受 0");
  assert.throws(() => peerReviewValues({ d1: 4, d2: 11 }, [...dimensions], "0-10"), code("PEER_REVIEW_VALUE_OUT_OF_RANGE"));
  assert.throws(() => peerReviewValues({ d1: 2, d2: 1 }, [...dimensions], "yes-no"), code("PEER_REVIEW_VALUE_OUT_OF_RANGE"), "yes-no 只接受 0/1");
  assert.deepEqual(peerReviewValues({ d1: 1, d2: 5 }, [...dimensions], "1-5"), [{ dimensionId: "d1", value: 1 }, { dimensionId: "d2", value: 5 }], "边界值合法");
  assert.equal(peerReviewIdempotencyKey(" k-1 "), "k-1");
  assert.throws(() => peerReviewRevision(0), code("PEER_REVIEW_INVALID_INPUT"));
  assert.equal(peerReviewRevision(3), 3);
});

test("作品定位与披露：取版本最大的当前作品；撤回或没有记录都返回 null", () => {
  const works: PeerReviewWork[] = [
    { id: "snap-a1", teamId: "team-a", version: 1, submittedAt: "2026-10-13T00:00:00.000Z", memberUserIds: ["alice"] },
    { id: "snap-a2", teamId: "team-a", version: 2, submittedAt: "2026-10-14T00:00:00.000Z", memberUserIds: ["alice", "bob"] },
    { id: "snap-b1", teamId: "team-b", version: 1, submittedAt: "2026-10-13T00:00:00.000Z", memberUserIds: ["carol"] },
  ];
  assert.equal(latestWorkOf(works, "team-a")!.id, "snap-a2");
  assert.equal(latestWorkOf(works, "team-z"), null);
  assert.equal(activeDisclosureOf([{ teamId: "team-a", scope: "public", status: "withdrawn" }, { teamId: "team-a", scope: "participants", status: "active" }], "team-a")!.scope, "participants");
  assert.equal(activeDisclosureOf([{ teamId: "team-a", scope: "public", status: "withdrawn" }], "team-a"), null);
});

test("匿名汇总：按作品给各维度平均与份数 + 匿名逐条分值，绝不含评分者身份或名次", () => {
  const reviews = [review(), review({ id: "r2", reviewerUserId: "bob", values: [{ dimensionId: "d1", value: 2 }, { dimensionId: "d2", value: 5 }] })];
  const summary = workPeerReviewSummary({ dimensions: [...dimensions], reviews, requiredRate: 0.3, passRate: 0.6, submittedReviewerCount: 6, approvedParticipantCount: 10 });
  assert.equal(summary.state, "met"); assert.equal(summary.reviewCount, 2);
  assert.deepEqual(summary.dimensions, [
    { id: "d1", label: "创意", average: 3, count: 2 },
    { id: "d2", label: "完成度", average: 5, count: 2 },
  ]);
  assert.deepEqual(summary.anonymousReviews.map(entry => entry.reviewId), ["r1", "r2"]);
  const text = JSON.stringify(summary);
  for (const hidden of ["alice", "bob", "reviewerUserId", "rank", "percent", "名次"]) assert.ok(!text.includes(hidden), "汇总不得出现：" + hidden);
  const none = workPeerReviewSummary({ dimensions: [...dimensions], reviews: [review({ values: [{ dimensionId: "d1", value: 4 }] })], requiredRate: 0.3, passRate: 0.6, submittedReviewerCount: 6, approvedParticipantCount: 10 });
  assert.equal(none.dimensions[1]!.average, null, "没有评分的维度是 null，不是 0"); assert.equal(none.dimensions[1]!.count, 0);
});

test("视图装配：未达门槛时 summary 为 null；达标后也只有按作品汇总与本人的那一条", () => {
  const off = workPeerReviewView({ eventId: "event-a", work: { id: "snap-1", teamId: "team-a" }, scope: "public", scale: "1-5", dimensions: [...dimensions],
    reviews: [review()], mine: review(), canReview: true, canReviewReason: null,
    threshold: peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 1, approvedParticipantCount: 10 }) });
  assert.equal(off.summary, null, "未达门槛不展示任何汇总");
  assert.equal(off.threshold.met, false);
  assert.equal(off.myReview!.revision, 1);
  assert.equal(JSON.stringify(off).includes("reviewerUserId"), false);
  const met = workPeerReviewView({ eventId: "event-a", work: { id: "snap-1", teamId: "team-a" }, scope: "participants", scale: "1-5", dimensions: [...dimensions],
    reviews: [review()], mine: null, canReview: false, canReviewReason: "本队成员不能给本队作品互评（去自评）。",
    threshold: peerReviewThreshold({ requiredRate: 0.3, submittedReviewerCount: 5, approvedParticipantCount: 10 }) });
  assert.equal(met.summary!.reviewCount, 1);
  assert.equal(met.myReview, null);
  assert.equal(JSON.stringify(met).includes("alice"), false);
  assert.equal(myPeerReview(null), null);
  assert.deepEqual(activeReviewsOf([review(), review({ id: "r2", status: "withdrawn" })], "snap-1").map(item => item.id), ["r1"]);
});

test("幂等输入比对：同一份输入相等，分值或维度不同即不等", () => {
  const base = { snapshotId: "snap-1", teamId: "team-a", scale: "1-5" as const, dimensions: [...dimensions], values: [{ dimensionId: "d1", value: 4 }, { dimensionId: "d2", value: 5 }] };
  assert.equal(samePeerReviewInput(base, { ...base, values: [{ dimensionId: "d1", value: 4 }, { dimensionId: "d2", value: 5 }] }), true);
  assert.equal(samePeerReviewInput(base, { ...base, values: [{ dimensionId: "d1", value: 5 }, { dimensionId: "d2", value: 5 }] }), false);
  assert.equal(samePeerReviewInput(base, { ...base, snapshotId: "snap-2" }), false);
  assert.equal(samePeerReviewInput(base, { ...base, dimensions: [{ id: "d1", label: "创意" }] }), false);
});

test("治理文案：写明与评委分列、不计名次、匿名、去自评、门槛，且不含排名或百分比口径", () => {
  const text = JSON.stringify({ peerReviewNotices, peerReviewLimitations, peerReviewNotice });
  assert.match(peerReviewNotices.separate, /分列/);
  assert.match(peerReviewNotices.notRanked, /不给任何人排名/);
  assert.match(peerReviewNotices.anonymous, /看不到谁打的分/);
  assert.match(peerReviewNotices.selfReview, /去自评/);
  assert.match(peerReviewNotices.threshold, /未达门槛/);
  for (const forbidden of ["排名第", "榜单", "完成度", "进度条", "百分比排名第"]) assert.ok(!text.includes(forbidden), "不得出现：" + forbidden);
  for (const required of ["不计入名次", "评委", "匿名", "门槛", "举报", "撤回"]) assert.ok(text.includes(required), "治理文案必须写明：" + required);
});
