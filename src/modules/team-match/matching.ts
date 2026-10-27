import type { RecruitingRole } from "../recruiting/index.ts";
import {
  teamMatchGroupLimit,
  teamMatchRoleLabels,
  teamMatchRoleOrder,
  type TeamMatchCandidate,
  type TeamMatchCandidateCard,
  type TeamMatchGateReason,
  type TeamMatchGateResult,
  type TeamMatchGrouping,
  type TeamMatchOptIn,
  type TeamMatchPostFacts,
  type TeamMatchPostRef,
  type TeamMatchPublishedCard,
  type TeamMatchRoleGroup,
  type TeamMatchUnfilledRole,
  type TeamMatchViewer,
} from "./model.ts";

/**
 * 组队大厅的分组算法。刻意**没有**任何评分、权重、百分比、名次或"最佳"判定。
 *
 * 分组口径：
 * 1. 只考虑查看者自己**开放中且有剩余名额**的招募贴；
 * 2. 缺口 = 招募贴声明的职责 − gap.ts 已覆盖职责 − 查看者本人已声明的职责
 *    （"互补"：自己能补的职责不再重复找人）；
 * 3. 候选人必须同时过三道门槛；同一账号只出现一次，归入其名片**主角色优先、再辅角色**能补的第一个缺口，
 *    其余能补的缺口在 `coveringRoles` 里如实列出；
 * 4. 组按固定职责顺序排列；组内按名片最近更新在前、时间相同再按 userId；
 *    这是稳定中性顺序，不是能力或适配排序。
 */

const roleIndex = new Map<RecruitingRole, number>(teamMatchRoleOrder.map((role, index) => [role, index]));

export function isTeamMatchRole(value: string): value is RecruitingRole {
  return roleIndex.has(value as RecruitingRole);
}

/** 去重并按固定职责顺序排列，保证输出与输入数组顺序无关。 */
export function canonicalRoles(roles: readonly RecruitingRole[]): RecruitingRole[] {
  return [...new Set(roles)].filter(isTeamMatchRole).sort((left, right) => roleIndex.get(left)! - roleIndex.get(right)!);
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * opt-in 生效状态：同一账号同一场只有最后更新的一条算数；没有记录按**未开启**。
 * 存储层应保证唯一，这里仍做确定性兜底，不把"有记录"当成"已开启"。
 */
export function isOptInOpen(optIns: readonly TeamMatchOptIn[], userId: string, eventId: string): boolean {
  const matches = optIns.filter(item => item.userId === userId && item.eventId === eventId);
  if (!matches.length) return false;
  matches.sort((left, right) => compareText(right.updatedAt, left.updatedAt) || compareText(left.userId, right.userId));
  return matches[0]!.open === true;
}

/** 三条门槛（外加"不把自己推给自己"）。顺序固定，便于测试与排查。 */
export function teamMatchGate(input: {
  card: TeamMatchCandidateCard;
  eventId: string;
  optIns: readonly TeamMatchOptIn[];
  viewerUserId: string;
}): TeamMatchGateResult {
  const reasons: TeamMatchGateReason[] = [];
  if (input.card.registrationStatus !== "approved") reasons.push("registration_not_approved");
  if (input.card.cardStatus !== "published" || !input.card.card) reasons.push("card_not_published");
  if (!isOptInOpen(input.optIns, input.card.userId, input.eventId)) reasons.push("opt_in_missing_or_closed");
  if (input.card.userId === input.viewerUserId) reasons.push("viewer_self");
  return { eligible: reasons.length === 0, reasons };
}

const isOpenPost = (post: TeamMatchPostFacts): boolean =>
  post.status === "open" && Number.isFinite(post.seats) && post.seats - post.takenSeats > 0;

const postRef = (post: TeamMatchPostFacts): TeamMatchPostRef => ({
  postId: post.postId,
  projectId: post.projectId,
  spaceName: post.spaceName,
  title: post.title,
});

const byRole = (left: RecruitingRole, right: RecruitingRole): number => roleIndex.get(left)! - roleIndex.get(right)!;

/** 名片主角色优先、再辅角色；组内去重后得到"本人声明的优先顺序"。 */
const declaredPreference = (card: TeamMatchPublishedCard): RecruitingRole[] => {
  const primary = canonicalRoles(card.primaryRoles);
  const primarySet = new Set(primary);
  return [...primary, ...canonicalRoles(card.supportingRoles).filter(role => !primarySet.has(role))];
};

interface EligibleCandidate {
  card: TeamMatchCandidateCard;
  published: TeamMatchPublishedCard;
  covering: readonly RecruitingRole[];
}

const candidateView = (entry: EligibleCandidate, viewerCity: string | undefined): TeamMatchCandidate => {
  const city = entry.published.city.trim();
  const viewer = viewerCity?.trim() ?? "";
  return {
    userId: entry.card.userId,
    displayName: entry.card.displayName,
    cardId: entry.published.id,
    headline: entry.published.headline,
    primaryRoles: canonicalRoles(entry.published.primaryRoles),
    supportingRoles: canonicalRoles(entry.published.supportingRoles),
    coveringRoles: canonicalRoles(entry.covering),
    skills: [...new Set(entry.published.skills.map(skill => skill.trim()).filter(Boolean))],
    city,
    sameCity: Boolean(city && viewer && city.toLowerCase() === viewer.toLowerCase()),
    publishedAt: entry.published.publishedAt,
    updatedAt: entry.published.updatedAt,
  };
};

const sortCandidates = (candidates: TeamMatchCandidate[]): TeamMatchCandidate[] =>
  [...candidates]
    .sort((left, right) => compareText(right.updatedAt, left.updatedAt) || compareText(left.userId, right.userId))
    .slice(0, teamMatchGroupLimit);

/**
 * 按角色缺口分组。**返回值里没有分数、百分比、名次或"最佳匹配"字段**，也没有简历全文。
 *
 * @param input.cards 候选人投影（报名状态 + 名片状态 + 已发布名片），来自既有事实
 * @param input.posts 查看者自己的招募贴投影（`coveredRoles` 来自 gap.ts）
 * @param input.viewer 查看者本人
 * @param input.optIns 本场 `open = true` 的 opt-in；缺失按未开启
 */
export function groupCandidates(input: {
  cards: readonly TeamMatchCandidateCard[];
  posts: readonly TeamMatchPostFacts[];
  viewer: TeamMatchViewer;
  optIns: readonly TeamMatchOptIn[];
}): TeamMatchGrouping {
  const { viewer, cards, posts, optIns } = input;
  const viewerRoles = canonicalRoles([...viewer.primaryRoles, ...viewer.supportingRoles]);
  const viewerRoleSet = new Set(viewerRoles);

  const openPosts = [...posts].filter(isOpenPost).sort((left, right) => compareText(left.postId, right.postId));

  const gaps = new Map<RecruitingRole, TeamMatchPostFacts[]>();
  for (const post of openPosts) {
    const covered = new Set(canonicalRoles(post.coveredRoles));
    for (const role of canonicalRoles(post.neededRoles)) {
      if (covered.has(role) || viewerRoleSet.has(role)) continue;
      gaps.set(role, [...(gaps.get(role) ?? []), post]);
    }
  }
  const gapRoles = [...gaps.keys()].sort(byRole);

  // 先按账号合并重复投影：同一人只保留最近更新的一张已发布名片，避免同一候选重复出现。
  const eligible = new Map<string, EligibleCandidate>();
  for (const card of cards) {
    const gate = teamMatchGate({ card, eventId: viewer.eventId, optIns, viewerUserId: viewer.userId });
    if (!gate.eligible || !card.card) continue;
    const preference = declaredPreference(card.card);
    const covering = preference.filter(role => gaps.has(role));
    if (!covering.length) continue;
    const candidate: EligibleCandidate = { card, published: card.card, covering };
    const current = eligible.get(card.userId);
    if (
      !current
      || compareText(card.card.updatedAt, current.published.updatedAt) > 0
      || (card.card.updatedAt === current.published.updatedAt && compareText(card.card.id, current.published.id) < 0)
    ) {
      eligible.set(card.userId, candidate);
    }
  }

  const groupCandidatesByRole = new Map<RecruitingRole, TeamMatchCandidate[]>();
  const coveredRoles = new Set<RecruitingRole>();
  for (const entry of eligible.values()) {
    for (const role of entry.covering) coveredRoles.add(role);
    const assigned = entry.covering[0]!;
    groupCandidatesByRole.set(assigned, [...(groupCandidatesByRole.get(assigned) ?? []), candidateView(entry, viewer.city)]);
  }

  const groups: TeamMatchRoleGroup[] = gapRoles
    .filter(role => (groupCandidatesByRole.get(role)?.length ?? 0) > 0)
    .map(role => ({
      role,
      roleLabel: teamMatchRoleLabels[role],
      neededBy: (gaps.get(role) ?? []).map(postRef),
      candidates: sortCandidates(groupCandidatesByRole.get(role) ?? []),
      notice: "同组内按名片最近更新时间排列，时间相同再按账号标识；顺序不代表能力高低，也不构成推荐结论。",
    }));

  const unfilledRoles: TeamMatchUnfilledRole[] = gapRoles
    .filter(role => !coveredRoles.has(role))
    .map(role => ({ role, roleLabel: teamMatchRoleLabels[role], neededBy: (gaps.get(role) ?? []).map(postRef) }));

  const notice = !openPosts.length
    ? "你还没有开放中、且尚有名额的招募贴。先在团队空间发布招募并写清需要的职责，再回来这里看候选人。"
    : !gapRoles.length
      ? "你的招募贴当前没有需要别人补的职责缺口（已覆盖的职责和你自己已声明的职责不在这里重复找人）。"
      : !groups.length
        ? `还有 ${gapRoles.length} 项职责缺口，但目前没有同时满足"报名已通过 + 名片已发布 + 本人开启愿意被组队"的候选人。`
        : `有 ${groups.length} 项职责缺口找到了可展示的候选人；同组内按名片最近更新排列，时间相同再按账号标识，顺序不代表能力高低。`;

  return {
    eventId: viewer.eventId,
    viewerUserId: viewer.userId,
    viewerRoles,
    groups,
    unfilledRoles,
    notice,
    evidence: [
      "只列出本场报名已通过、名片已发布、且本人开启「愿意被组队」的人；三者缺一不出现。",
      "「愿意被组队」是本人的选择，未开启、关闭或没有这条记录都按未开启处理。",
      "候选人能补哪些职责来自本人名片里的主/辅角色声明，属于本人自述，未经平台核验。",
      "这里不给出任何数值评价或先后判定；组内顺序只按名片更新时间和账号标识，是否接触由双方通过既有招募申请决定。",
    ],
  };
}
