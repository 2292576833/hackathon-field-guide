import { DomainError } from "../../shared/errors.ts";
import type { EntityId } from "../../shared/contracts.ts";
import {
  DEFAULT_EVENT_COMMUNITY, EVENT_COMMUNITY_SCALES,
  type EventCommunityConfig,
} from "../../shared/organizer-contracts.ts";
import type {
  MyPeerReview, PeerReview, PeerReviewDimension, PeerReviewDisclosure, PeerReviewGateFailure,
  PeerReviewNotices, PeerReviewScale, PeerReviewScope, PeerReviewThreshold, PeerReviewValue,
  PeerReviewWork, WorkPeerReviewSummary, WorkPeerReviewView,
} from "./model.ts";

/**
 * 数值互评的全部业务判断（纯函数，无 IO、无 Date.now()）。
 *
 * 这一层只做五件事：
 * 1. 读主办方配置（量纲、冻结维度、参与率门槛），缺失或非法时保守处理，绝不自行补默认维度；
 * 2. 判定三层门禁与观看者/评分者资格，缺一给明确的 403 原因（不返回空数组）；
 * 3. 校验每条互评：每个冻结维度一个整数，未知/缺失维度与越界取值分别给 422；
 * 4. 计算参与率门槛，未达门槛时只给门槛值本身；
 * 5. 把互评投影成匿名的按作品汇总与逐条分值，并固定界面必须逐字使用的分列/不计名次口径。
 *
 * 它不做：排名、名次、百分比、评委分量纲、汇总、公布、导出、裁决、封禁、通知。
 * 它没有任何通往 event-judging 聚合或导出的引用。
 */

export function invalidInput(message: string): never { throw new DomainError("PEER_REVIEW_INVALID_INPUT", message, { status: 422 }); }
export function dimensionInvalid(message: string): never { throw new DomainError("PEER_REVIEW_DIMENSION_INVALID", message, { status: 422 }); }
export function valueOutOfRange(message: string): never { throw new DomainError("PEER_REVIEW_VALUE_OUT_OF_RANGE", message, { status: 422 }); }

export function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalidInput(label + "格式不正确或过长。");
  return value.trim();
}

/* ---------- 主办方配置（缺字段按未配置处理，不猜） ---------- */

/** 与 organizer/validation.ts 的上限一致；这里再做一次防御性截断。 */
export const maxPeerReviewDimensions = 12;
export const minPeerReviewPassRate = 0.1;
export const maxPeerReviewPassRate = 1;

export function peerReviewScaleOf(community: EventCommunityConfig): PeerReviewScale | null {
  const value: unknown = community.peerReviewScale;
  return typeof value === "string" && (EVENT_COMMUNITY_SCALES as readonly string[]).includes(value) ? value as PeerReviewScale : null;
}

/**
 * 冻结的互评维度。只保留 id/label 都是非空字符串、id 不重复的前 maxPeerReviewDimensions 项；
 * 任何缺失或畸形都当作"没有这个维度"，不补默认维度、不按顺序编号。
 */
export function peerReviewDimensionsOf(community: EventCommunityConfig): readonly PeerReviewDimension[] {
  const raw: unknown = community.peerReviewDimensions;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>(); const out: PeerReviewDimension[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { readonly id?: unknown; readonly label?: unknown };
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    if (!id || !label || id.length > 64 || label.length > 200 || seen.has(id)) continue;
    seen.add(id); out.push({ id, label });
    if (out.length >= maxPeerReviewDimensions) break;
  }
  return out;
}

/** 参与率门槛：只有 0.1-1 的有限数才生效，否则回退共享默认值（0.3），绝不放大也绝不缩小到 0。 */
export function peerReviewPassRateOf(community: EventCommunityConfig): number {
  const value: unknown = community.peerReviewPassRate;
  return typeof value === "number" && Number.isFinite(value) && value >= minPeerReviewPassRate && value <= maxPeerReviewPassRate
    ? value : DEFAULT_EVENT_COMMUNITY.peerReviewPassRate;
}

/** 量纲的合法整数取值（yes-no 用 0/1 表示否/是）。 */
export function peerReviewValueRange(scale: PeerReviewScale): { readonly min: number; readonly max: number } {
  if (scale === "1-5") return { min: 1, max: 5 };
  if (scale === "0-10") return { min: 0, max: 10 };
  return { min: 0, max: 1 };
}

export const peerReviewScaleNames: Readonly<Record<PeerReviewScale, string>> = { "1-5": "1-5 分", "0-10": "0-10 分", "yes-no": "是 / 否" };

/** 单个取值的界面文字（yes-no 显示是/否；其余显示数字）。 */
export function peerReviewValueLabel(scale: PeerReviewScale, value: number): string {
  if (scale === "yes-no") return value === 1 ? "是" : "否";
  return String(value);
}

export function ratePercent(rate: number): string { return String(Math.round(rate * 100)) + "%"; }

/* ---------- 门禁（顺序固定，逐层说明缺的是哪一层） ---------- */

/**
 * 三层门禁：缺一即 403（规划 34 §3.1 / 宪法 XIII）。
 * 1. 赛事级 community.workShowcase（主办方配置，默认 false）；
 * 2. 赛事级 community.peerReview（数值互评能力，默认 false）；
 * 3. 该作品所属队伍当前有效的公开披露记录，且范围不是 private（队伍本人的选择）。
 * 开关关闭时不返回空数组冒充"还没有互评"。
 */
export function peerReviewGate(
  community: EventCommunityConfig,
  disclosure: Pick<PeerReviewDisclosure, "scope" | "status"> | null,
): PeerReviewGateFailure | null {
  if (!community.workShowcase) return { code: "WORK_SHOWCASE_DISABLED", message: "本场主办方尚未开启作品展示；作品一律不对外显示，也没有互评区。", status: 403 };
  if (!community.peerReview) return { code: "PEER_REVIEW_DISABLED", message: "本场主办方尚未开启数值互评；这里不返回任何互评，也不能提交互评。", status: 403 };
  if (!disclosure || disclosure.status !== "active" || disclosure.scope === "private")
    return { code: "PEER_REVIEW_NOT_DISCLOSED", message: "这件作品没有被它所属队伍本人选择公开，因此没有互评区。", status: 403 };
  return null;
}

/** 观看者资格：participants 档只有本场报名已通过的选手；public 档任何已登录账号。 */
export function peerReviewViewerAccess(scope: PeerReviewScope, viewerIsParticipant: boolean): PeerReviewGateFailure | null {
  if (scope === "participants" && !viewerIsParticipant)
    return { code: "PEER_REVIEW_PARTICIPANTS_ONLY", message: "这件作品只对本场报名已通过的选手公开；你当前不在本场通过名单里，看不到也无法互评。", status: 403 };
  return null;
}

/** 评分者资格：只有本场报名已通过的参赛者能提交互评（数值互评是选手之间的互评）。 */
export function peerReviewReviewerAccess(viewerIsParticipant: boolean): PeerReviewGateFailure | null {
  if (!viewerIsParticipant)
    return { code: "PEER_REVIEW_PARTICIPANT_REQUIRED", message: "只有本场报名已通过的参赛者能提交互评；访客与非本场参赛者不能互评。", status: 403 };
  return null;
}

/** 去自评：正式收件成员快照里的人不能评本队作品。 */
export function peerReviewSelfReview(memberUserIds: readonly EntityId[], reviewerUserId: EntityId): PeerReviewGateFailure | null {
  if (memberUserIds.includes(reviewerUserId))
    return { code: "PEER_REVIEW_SELF_REVIEW", message: "本队成员不能给本队作品互评（去自评）；请互评其他队伍的作品。", status: 403 };
  return null;
}

/* ---------- 输入校验 ---------- */

export function peerReviewIdempotencyKey(value: unknown): string { return text(value, "重试标识", 120); }
export function peerReviewReviewId(value: unknown): string { return text(value, "互评记录", 160); }
export function peerReviewReportReason(value: unknown): string { return text(value ?? "", "举报说明", 1000, true); }

export function peerReviewRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidInput("预期版本必须是正整数。");
  return value;
}

/**
 * 每条评分必须是每个冻结维度一个整数：未知键、缺维度、非对象都拒绝（不自行补维度）；
 * 非整数或超出量纲取值一律拒绝。
 */
export function peerReviewValues(
  value: unknown,
  dimensions: readonly PeerReviewDimension[],
  scale: PeerReviewScale,
): readonly PeerReviewValue[] {
  if (!dimensions.length) dimensionInvalid("本场没有配置互评维度，无法提交互评。");
  if (!value || typeof value !== "object" || Array.isArray(value)) dimensionInvalid("请为每个互评维度填写一个整数。");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(dimensions.map(dimension => dimension.id));
  for (const key of Object.keys(raw)) if (!allowed.has(key)) dimensionInvalid("互评只能填写本场已冻结的维度，不能新增或改写维度。");
  const range = peerReviewValueRange(scale);
  const values: PeerReviewValue[] = [];
  for (const dimension of dimensions) {
    if (!Object.prototype.hasOwnProperty.call(raw, dimension.id)) dimensionInvalid("每个互评维度都必须填写；未填的维度不能用默认值补。");
    const item = raw[dimension.id];
    if (typeof item !== "number" || !Number.isSafeInteger(item)) valueOutOfRange("每个维度只能填一个整数；小数、空值或文字都不接受。");
    if (item < range.min || item > range.max) valueOutOfRange("每个维度只能填 " + String(range.min) + " 到 " + String(range.max) + " 之间的整数。");
    values.push({ dimensionId: dimension.id, value: item });
  }
  return values;
}

/** 同一队伍"当前展示"的作品：版本号最大，其次提交时间、id 倒序（与 event-judging 作品展示同口径）。 */
export function latestWorkOf(works: readonly PeerReviewWork[], teamId: EntityId): PeerReviewWork | null {
  const own = works.filter(work => work.teamId === teamId);
  if (!own.length) return null;
  return [...own].sort((left, right) =>
    right.version - left.version
    || (left.submittedAt < right.submittedAt ? 1 : left.submittedAt > right.submittedAt ? -1 : 0)
    || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))[0]!;
}

/** 一支队伍当前有效的公开披露记录；没有或已撤回返回 null。 */
export function activeDisclosureOf(disclosures: readonly PeerReviewDisclosure[], teamId: EntityId): PeerReviewDisclosure | null {
  return disclosures.find(disclosure => disclosure.teamId === teamId && disclosure.status === "active") ?? null;
}

/** 是否同一次互评输入（用于幂等重放判定：同键同输入返回原结果，同键不同输入拒绝）。 */
export function samePeerReviewInput(
  left: Pick<PeerReview, "snapshotId" | "teamId" | "scale" | "dimensions" | "values">,
  right: Pick<PeerReview, "snapshotId" | "teamId" | "scale" | "dimensions" | "values">,
): boolean {
  if (left.snapshotId !== right.snapshotId || left.teamId !== right.teamId || left.scale !== right.scale) return false;
  if (left.dimensions.length !== right.dimensions.length || left.values.length !== right.values.length) return false;
  for (let index = 0; index < left.dimensions.length; index += 1) {
    const a = left.dimensions[index]!, b = right.dimensions[index]!;
    if (a.id !== b.id || a.label !== b.label) return false;
  }
  for (let index = 0; index < left.values.length; index += 1) {
    const a = left.values[index]!, b = right.values[index]!;
    if (a.dimensionId !== b.dimensionId || a.value !== b.value) return false;
  }
  return true;
}

/* ---------- 参与率门槛与匿名汇总 ---------- */

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 参与率门槛：submittedReviewerCount / approvedParticipantCount。
 * 报名已通过人数为 0（或异常）时视为未达门槛，不显示汇总。
 * 未达门槛时只返回门槛值本身，不返回参与率、人数或任何平均分。
 */
export function peerReviewThreshold(input: {
  readonly requiredRate: number;
  readonly submittedReviewerCount: number;
  readonly approvedParticipantCount: number;
}): PeerReviewThreshold {
  const denominator = Number.isSafeInteger(input.approvedParticipantCount) && input.approvedParticipantCount > 0 ? input.approvedParticipantCount : 0;
  const numerator = Number.isSafeInteger(input.submittedReviewerCount) && input.submittedReviewerCount > 0
    ? Math.min(input.submittedReviewerCount, denominator) : 0;
  const passRate = denominator > 0 ? numerator / denominator : 0;
  if (denominator === 0 || numerator === 0 || passRate < input.requiredRate) {
    return { code: "PEER_REVIEW_THRESHOLD_NOT_MET", met: false, requiredRate: input.requiredRate,
      message: "本场互评参与率还没有达到主办方设置的门槛（" + ratePercent(input.requiredRate) + "）。样本不足时只显示这一点与门槛值本身，不显示任何平均分、统计或逐条分值。" };
  }
  return { code: "PEER_REVIEW_SUMMARY_READY", met: true, requiredRate: input.requiredRate,
    message: "本场互评参与率已达到主办方设置的门槛（" + ratePercent(input.requiredRate) + "）。下面只按作品给出各维度平均与份数，以及匿名的逐条分值；不给任何人排名。",
    passRate: round(passRate, 4), submittedReviewerCount: numerator, approvedParticipantCount: denominator };
}

/** 只统计有效（active）的互评；被撤回或被新版本取代的记录不再计入。 */
export function activeReviewsOf(reviews: readonly PeerReview[], snapshotId: EntityId): readonly PeerReview[] {
  return reviews.filter(review => review.snapshotId === snapshotId && review.status === "active");
}

/** 本场至少有一条有效互评、且仍是报名已通过者的参赛者数（门槛的分子）。 */
export function submittedReviewerCount(reviews: readonly PeerReview[], approvedParticipantIds: readonly EntityId[]): number {
  const approved = new Set(approvedParticipantIds);
  const reviewers = new Set<string>();
  for (const review of reviews) if (review.status === "active" && approved.has(review.reviewerUserId)) reviewers.add(review.reviewerUserId);
  return reviewers.size;
}

/**
 * 按作品的匿名汇总：各维度平均与份数 + 匿名逐条分值。
 * - 平均值按当前冻结维度计算，只统计含该维度的有效互评；没有评分时为 null（不是 0）。
 * - 逐条分值只带 reviewId 与分值，不含评分者身份，且按 reviewId 排序（不按分值，避免变相排名）。
 */
export function workPeerReviewSummary(input: {
  readonly dimensions: readonly PeerReviewDimension[];
  readonly reviews: readonly PeerReview[];
  readonly requiredRate: number;
  readonly passRate: number;
  readonly submittedReviewerCount: number;
  readonly approvedParticipantCount: number;
}): WorkPeerReviewSummary {
  const dimensions = input.dimensions.map(dimension => {
    const collected: number[] = [];
    for (const review of input.reviews) {
      const item = review.values.find(value => value.dimensionId === dimension.id);
      if (item) collected.push(item.value);
    }
    const average = collected.length ? round(collected.reduce((sum, value) => sum + value, 0) / collected.length, 2) : null;
    return { id: dimension.id, label: dimension.label, average, count: collected.length };
  });
  const anonymousReviews = [...input.reviews]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(review => ({ reviewId: review.id, values: review.values.map(value => ({ dimensionId: value.dimensionId, value: value.value })) }));
  return { state: "met", reviewCount: input.reviews.length, dimensions, anonymousReviews,
    requiredRate: input.requiredRate, passRate: input.passRate, submittedReviewerCount: input.submittedReviewerCount, approvedParticipantCount: input.approvedParticipantCount };
}

/** 我的互评投影：只有本人那一条，且不含其他任何评分者。 */
export function myPeerReview(review: PeerReview | null): MyPeerReview | null {
  if (!review) return null;
  return { id: review.id, values: review.values.map(value => ({ dimensionId: value.dimensionId, value: value.value })), revision: review.revision, updatedAt: review.updatedAt };
}

/** 作品互评视图的唯一装配点；服务层与测试都走这里，避免出现第二套投影口径。 */
export function workPeerReviewView(input: {
  readonly eventId: EntityId;
  readonly work: Pick<PeerReviewWork, "id" | "teamId">;
  readonly scope: PeerReviewScope;
  readonly scale: PeerReviewScale;
  readonly dimensions: readonly PeerReviewDimension[];
  readonly reviews: readonly PeerReview[];
  readonly mine: PeerReview | null;
  readonly canReview: boolean;
  readonly canReviewReason: string | null;
  readonly threshold: PeerReviewThreshold;
}): WorkPeerReviewView {
  const summary = input.threshold.met
    ? workPeerReviewSummary({ dimensions: input.dimensions, reviews: input.reviews, requiredRate: input.threshold.requiredRate,
      passRate: input.threshold.passRate ?? 0, submittedReviewerCount: input.threshold.submittedReviewerCount ?? 0, approvedParticipantCount: input.threshold.approvedParticipantCount ?? 0 })
    : null;
  return {
    eventId: input.eventId, snapshotId: input.work.id, teamId: input.work.teamId,
    scope: input.scope, enabled: true, scale: input.scale, dimensions: input.dimensions,
    valueRange: peerReviewValueRange(input.scale), myReview: myPeerReview(input.mine),
    canReview: input.canReview, canReviewReason: input.canReviewReason,
    threshold: input.threshold, summary, notices: peerReviewNotices, limitations: peerReviewLimitations,
  };
}

/* ---------- 界面必须逐字展示的口径 ---------- */

export const peerReviewNotices: PeerReviewNotices = {
  separate: "数值互评与评委评分分列存放、分列展示：互评不进入正式汇总、名次、公布或任何对外导出，两者也不可等价换算。",
  notRanked: "互评只按作品汇总各维度平均与份数，不给任何人排名，也不给参赛者打分排名；互评多少不影响成绩。",
  gate: "互评由本场主办方开启（作品展示 + 数值互评）；队伍本人没有选择公开的作品没有互评区，未开启时接口明确返回 403，而不是一个空列表。",
  anonymous: "评分者身份不对参赛者展示：你只会看到按作品汇总的各维度平均与份数，以及匿名的逐条分值，看不到谁打的分。",
  selfReview: "本队成员不能给本队作品互评（去自评）：判断依据是正式收件时的队伍成员快照。",
  threshold: "本场参与率低于主办方设置的门槛时，只显示「样本不足 / 未达门槛」与门槛值本身；不显示平均分、百分比排名或逐条分值。",
  governance: "你可以随时修改或撤回自己的互评；任一能看到这件作品的人都可以举报一条互评，举报只记录事实、不做裁决，也不会改变任何分数。",
  scale: "互评的量纲与维度由本场主办方配置，且与评委维度分开定义，MUST NOT 暗示两者等价。",
};

export const peerReviewLimitations: readonly string[] = [
  "互评只写本模块自己的表：不写评审表、不进 aggregate()、不进结果预览、公布、名次或任何对外导出。",
  "本模块不导入 event-judging 的聚合与导出，也不提供任何评委侧入口；评分期间评委侧看不到互评数据。",
  "评分者身份不对参赛者展示：参赛者只看得到按作品汇总的各维度平均与份数，以及不含身份信息的匿名逐条分值。",
  "参与率未达门槛时只返回「样本不足 / 未达门槛」与门槛值本身，不返回参与率、人数或任何平均分。",
  "举报只记录事实（谁、何时、哪条互评、举报时刻的分值快照），本模块不裁决、不隐藏、不改分数；处理沿用主办方既有流程。",
  "作品是否公开由提交的队伍本人决定；队伍撤回公开后互评区随作品一起消失，既有记录不再返回。",
  "量纲与维度取自主办方配置的冻结值；不在冻结维度里的键一律拒绝，本模块不自行补默认维度。",
];

/** 供界面展示的一句话说明（页面标题下方）。 */
export const peerReviewNotice = "这里是选手数值互评：与评委评分分列，不计入名次，也不进入结果与导出。";
