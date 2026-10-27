import type { PublicRecruitingCard, RecruitingApplication, RecruitingPost, RecruitingRole } from "./model.ts";
import { roleLabels } from "./model.ts";

/**
 * 缺口互补：一个招募帖还缺哪些声明的职责、谁的名片声明了这些职责。
 *
 * 依据：竞品把"团队还缺哪几项技能、谁能补上"作为组队的第一性问题（HackerMate，公开源码
 * `yashshah1211/HackerMate_Backup` 的 `docs/architecture/matchmaking-v2/`：以缺口为主分量、
 * 用确定性证据而非 embeddings，并要求"证据覆盖率不足时降级为探索建议、禁止成功率式措辞"）。
 *
 * 我们只吸收其中与我们既有纪律相容的部分，并明确拒绝它的打分部分：
 * 1. **不产生匹配分、不排先后、不给百分比**（宪法 XII）。同一缺口下按名片更新时间排列，并在界面上说明这不是能力评价。
 * 2. **只陈述可核对的事实**：某人"声明了"哪些职责来自其**已发布名片**，标注为本人自述、未经平台核验。
 * 3. **口径写清楚**：覆盖只统计通过本招募帖批准/已加入的人；其他成员不在这个口径内，不假装是全队覆盖。
 * 4. 不读取未发布档案、不读取私人测评，也不因为缺口去自动邀请任何人——是否联系由本人决定。
 */

export interface GapCandidate {
  userId: string; displayName: string; cardId: string; headline: string;
  /** 名片里声明的全部职责。 */
  declaredRoles: readonly RecruitingRole[];
  /** 其中正好能补上缺口的那些职责。 */
  coveringRoles: readonly RecruitingRole[];
  publishedAt: string;
  city: string;
}
/** 公开名片本身不含账号标识（它在 `recruiting_cards.user_id` 列上），因此这里显式配对，避免猜。 */
export interface GapCard { userId: string; card: PublicRecruitingCard }
export interface GapView {
  postId: string; projectId: string; spaceName: string; title: string; postStatus: RecruitingPost["status"];
  seats: number; takenSeats: number; openSeats: number;
  neededRoles: readonly RecruitingRole[];
  /** 已被"通过本贴加入的人"覆盖的职责，附覆盖人。 */
  coveredRoles: readonly { role: RecruitingRole; label: string; by: readonly { userId: string; displayName: string }[] }[];
  /** 仍缺的职责，以及声明了该职责的候选人。 */
  gaps: readonly { role: RecruitingRole; label: string; candidates: readonly GapCandidate[] }[];
  notice: string;
  /** 面向界面的诚实性说明，必须原样展示。 */
  evidence: readonly string[];
}

/** 通过本贴真正加入的人：approved 与 joined；pending 只表示"在排队"。 */
export const joinedStatuses: readonly RecruitingApplication["status"][] = ["approved", "joined"];
/** 不再重复推给主办方的状态：在队列里、已加入、已拒绝。 */
const suppressedStatuses: readonly RecruitingApplication["status"][] = ["pending", "approved", "joined", "rejected"];

const uniqueRoles = (roles: readonly RecruitingRole[]): RecruitingRole[] => [...new Set(roles)];

export function gapView(input: { post: RecruitingPost; publisherUserId: string; applications: readonly RecruitingApplication[]; cards: readonly GapCard[]; takenSeats: number }): GapView {
  const { post, publisherUserId, applications, cards } = input;
  const declared = (card: PublicRecruitingCard): RecruitingRole[] => uniqueRoles([...(card.primaryRoles ?? []), ...(card.supportingRoles ?? [])]);

  const joined = applications.filter(item => joinedStatuses.includes(item.status));
  const coveredBy = new Map<RecruitingRole, { userId: string; displayName: string }[]>();
  for (const application of joined) {
    const roles = application.cardSnapshot ? declared(application.cardSnapshot) : [];
    for (const role of roles) coveredBy.set(role, [...(coveredBy.get(role) ?? []), { userId: application.applicantUserId, displayName: application.applicantDisplayName }]);
  }
  const neededRoles = uniqueRoles(post.neededRoles ?? []);
  const coveredRoles = neededRoles.filter(role => coveredBy.has(role)).map(role => ({ role, label: roleLabels[role], by: coveredBy.get(role)! }));
  const missing = neededRoles.filter(role => !coveredBy.has(role));

  const suppressed = new Set([publisherUserId, ...applications.filter(item => suppressedStatuses.includes(item.status)).map(item => item.applicantUserId)]);
  const gaps = missing.map(role => {
    const candidates = cards
      .filter(entry => !suppressed.has(entry.userId) && declared(entry.card).includes(role))
      .map(entry => ({ userId: entry.userId, displayName: entry.card.displayName, cardId: entry.card.id, headline: entry.card.headline, declaredRoles: declared(entry.card),
        coveringRoles: missing.filter(item => declared(entry.card).includes(item)), publishedAt: entry.card.publishedAt, city: entry.card.city }))
      // 中性顺序：名片更新时间（新的在前），其次账号标识；这不是能力排序。
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0))
      .slice(0, 12);
    return { role, label: roleLabels[role], candidates };
  });

  const openSeats = Math.max(0, post.seats - input.takenSeats);
  const notice = !neededRoles.length ? "这个招募帖还没有声明需要哪些职责。"
    : !missing.length ? "招募帖声明的职责都已经有通过本贴加入的人覆盖；如仍需人手，请先在帖子里补充职责。"
      : !openSeats ? `还有 ${missing.length} 项职责没有对应的人，但名额已满（${input.takenSeats}/${post.seats}）。请先处理名额或调整职责。`
        : `还有 ${missing.length} 项职责没有通过本贴加入的人覆盖，名额还剩 ${openSeats} 个。`;
  return { postId: post.id, projectId: post.projectId, spaceName: post.spaceName, title: post.title, postStatus: post.status,
    seats: post.seats, takenSeats: input.takenSeats, openSeats, neededRoles, coveredRoles, gaps, notice,
    evidence: [
      "覆盖口径：只统计通过本招募帖批准或已加入的人；其他成员不在这个口径内。",
      "候选依据：对方已发布名片里的职责声明，属于本人自述，未经平台核验。",
      "这里不评分、不给匹配度，也不排能力先后；同一缺口下按名片更新时间排列，是否联系由你决定。",
    ] };
}
