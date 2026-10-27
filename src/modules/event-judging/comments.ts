import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { EventCommunityConfig } from "../../shared/organizer-contracts.ts";
import { DEFAULT_EVENT_COMMUNITY } from "../../shared/organizer-contracts.ts";
import type { WorkComment, WorkCommentView, WorkDisclosure, WorkDisclosureScope } from "./model.ts";
import { invalid, text } from "./validation.ts";

/**
 * 规划 34 C②「文字留言」的**全部业务判断**（纯函数，无 IO、无 `Date.now()`）。
 *
 * 本文件只做四件事：
 * 1. 校验留言正文与重试标识（长度上限**取自主办方配置** `eventCommunity(scope).commentMaxLength`）；
 * 2. 判定三层门禁（赛事作品展示 → 赛事文字留言 → 队伍本人选择公开）与观看者资格；
 * 3. 计算同账号同赛事的留言冷却，并把留言记录投影成**不含作者身份、隐藏后不含正文**的视图；
 * 4. 固定界面与接口必须逐字使用的治理口径（分列、不计入名次、隐藏、举报、限频）。
 *
 * 它不做：评分、量纲、维度、名次、汇总、公布、导出、裁决、封禁、通知。
 * 它**没有**任何评分字段，也**不会**读或写任何互评数据——文字留言与数值互评（P7）分列存放。
 */

/** 留言长度上限的绝对上界：即使配置异常也不会得到无界文本（主办方校验范围为 50–2000）。 */
export const absoluteCommentMaxLength = 4000;
/** 同一账号在同一场比赛里的留言冷却（秒）。固定模块规则；主办方若要配置，属共享契约变更（见交付 NEEDS_INTERFACE）。 */
export const commentCooldownSeconds = 30;
/** 单个作品一次读取最多返回的留言条数（超出时只保留最新的若干条，并给出 totalCount）。 */
export const commentPageLimit = 200;

/** 本场留言长度上限：取自主办方配置；配置不是 1..4000 的正整数时回退到共享默认值（500），绝不放大成无界文本。 */
export function commentLimit(community: EventCommunityConfig): number {
  const configured = community.commentMaxLength;
  return Number.isSafeInteger(configured) && configured > 0 && configured <= absoluteCommentMaxLength
    ? configured : DEFAULT_EVENT_COMMUNITY.commentMaxLength;
}

/** 正文校验：非空、无控制字符、不超过本场长度上限。长度按 UTF-16 代码单元计（与既有 `text()` 同口径）。 */
export function commentText(value: unknown, max: number): string {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid("留言内容格式不正确。");
  if (!value.trim()) invalid("留言不能为空。");
  if (value.length > max) invalid(`留言最多 ${max} 个字符。`);
  return value.trim();
}

export function commentIdempotencyKey(value: unknown): string { return text(value, "重试标识", 120); }
/** 隐藏说明可选；隐藏后不再返回留言正文，这条说明只进既有审计。 */
export function commentHideReason(value: unknown): string { return text(value ?? "", "隐藏说明", 300, true); }
/** 举报说明可选；举报只记录事实，不在本模块裁决。 */
export function commentReportReason(value: unknown): string { return text(value ?? "", "举报说明", 1000, true); }

export interface CommentGateFailure { readonly code: string; readonly message: string; readonly status: number }

/**
 * 三层门禁：**缺一即 403**（规划 34 §3.1 / 宪法 XIII）。
 *
 * ① 赛事级 `community.workShowcase`（主办方配置，默认 false）；
 * ② 赛事级 `community.peerFeedback`（文字留言能力，默认 false）；
 * ③ 该作品所属队伍的**有效**披露记录，且范围不是 `private`（队伍本人的选择）。
 *
 * 顺序固定为 ① → ② → ③，因此返回的 code 能精确说明"缺的是哪一层"。
 * 开关关闭时**不返回空数组**充当"还没有留言"。
 */
export function commentGate(
  community: EventCommunityConfig,
  disclosure: { readonly scope: WorkDisclosureScope; readonly status: WorkDisclosure["status"] } | null,
): CommentGateFailure | null {
  if (!community.workShowcase) return { code: "WORK_SHOWCASE_DISABLED", message: "本场主办方尚未开启作品展示；作品一律不对外显示，也没有留言区。", status: 403 };
  if (!community.peerFeedback) return { code: "WORK_COMMENTS_DISABLED", message: "本场主办方尚未开启文字留言；这里不返回任何留言，也不能提交留言。", status: 403 };
  if (!disclosure || disclosure.status !== "active" || disclosure.scope === "private")
    return { code: "WORK_COMMENTS_NOT_DISCLOSED", message: "这件作品没有被它所属队伍本人选择公开，因此没有留言区。", status: 403 };
  return null;
}

/**
 * 观看者资格（规划 34 §3.1 第 3 层 / 宪法 XIII）：
 * `participants` 档只有本场报名**已通过**的选手能看到并留言；`public` 档任何已登录账号都可以（未登录由 HTTP 层 401）。
 * 与 P2 作品展示的可读范围同口径——看不到作品的人也不能留言。
 */
export function commentViewerAccess(scope: WorkDisclosureScope, viewerIsParticipant: boolean): CommentGateFailure | null {
  if (scope === "participants" && !viewerIsParticipant)
    return { code: "WORK_COMMENTS_PARTICIPANTS_ONLY", message: "这件作品只对本场报名已通过的选手公开；你当前不在本场通过名单里，看不到也无法留言。", status: 403 };
  return null;
}

/**
 * 同账号同赛事限频：返回还需等待的秒数（0 表示可以留言）。
 * 只看该账号在本赛事的**全部**留言（含已隐藏），因此"先留言再隐藏"不能绕过冷却。
 */
export function commentCooldownRemaining(comments: readonly Pick<WorkComment, "authorUserId" | "createdAt">[], authorUserId: EntityId, now: Instant): number {
  let latest: string | null = null;
  for (const comment of comments) if (comment.authorUserId === authorUserId && (latest === null || comment.createdAt > latest)) latest = comment.createdAt;
  if (latest === null) return 0;
  const elapsed = (Date.parse(now) - Date.parse(latest)) / 1000;
  if (!Number.isFinite(elapsed)) return 0;
  return elapsed >= commentCooldownSeconds ? 0 : Math.max(1, Math.ceil(commentCooldownSeconds - elapsed));
}

/** 留言视图：**不含作者账号**；隐藏后正文为 `null`（隐藏即对所有读取面不再返回内容）。 */
export function commentView(comment: WorkComment, input: {
  readonly viewerUserId: EntityId; readonly viewerIsStaff: boolean;
  readonly reportedCount: number; readonly reportedByViewer: boolean;
}): WorkCommentView {
  const hidden = comment.status === "hidden";
  return {
    id: comment.id, teamId: comment.teamId, createdAt: comment.createdAt, status: comment.status,
    text: hidden ? null : comment.text,
    isMine: comment.authorUserId === input.viewerUserId,
    canHide: !hidden && (comment.authorUserId === input.viewerUserId || input.viewerIsStaff),
    canReport: !hidden,
    reportedCount: input.reportedCount, reportedByViewer: input.reportedByViewer,
    hiddenAt: hidden ? comment.hiddenAt : null,
    hiddenBy: hidden ? comment.hiddenByRole : null,
  };
}

/** 可见（未隐藏）留言，按时间升序、同时间按 id 升序稳定排序；不按任何分数或热度。 */
export function visibleComments(comments: readonly WorkComment[]): readonly WorkComment[] {
  return comments.filter(comment => comment.status === "active")
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** 单页投影：超出上限时保留**最新**的若干条（仍按升序返回），并报出全量计数。 */
export function commentPage(comments: readonly WorkComment[], limit = commentPageLimit): {
  readonly items: readonly WorkComment[]; readonly totalCount: number; readonly hiddenCount: number; readonly truncated: boolean;
} {
  const visible = visibleComments(comments);
  const items = visible.length <= limit ? visible : visible.slice(visible.length - limit);
  return { items, totalCount: visible.length, hiddenCount: comments.filter(comment => comment.status === "hidden").length, truncated: visible.length > items.length };
}

/** 治理与口径原文：界面必须逐字使用，避免出现"完成度""百分比"或人身评价措辞。 */
export const workCommentNotices = {
  separate: "本次只提供文字留言：没有评分、没有量纲、没有维度，也不做“有帮助”之类的计数。留言与评委评分分列存放、分列展示。",
  notRanked: "留言不计入名次，也不进入分数汇总、公布结果或任何对外导出；留言多少不影响成绩。",
  gate: "留言由本场主办方开启（作品展示 + 文字留言）；未开启时这里不返回任何留言。",
  visibility: "「仅本场参赛者」的作品只有本场报名已通过的选手能看到并留言；「公开（含访客）」的作品任何已登录账号都能看到并留言（未登录请先登录）。",
  hide: "留言作者本人，或本场负责评审模块的工作人员，可以隐藏这条留言；隐藏后对所有人都不再返回内容，同一条只能隐藏一次。",
  report: "任何能看到这条留言的人都可以举报；举报只记录事实，由主办方按既有流程处理，本页不做判定。",
  rate: `同一个账号在同一场比赛里留言有 ${commentCooldownSeconds} 秒冷却时间，请稍后再试。`,
} as const;

export const workCommentsLimitations: readonly string[] = [
  "留言是纯文字：本模块不建评分列、不读不写任何互评数据，也不做“有帮助”计数。",
  "留言永不进入 aggregate()、结果预览、公布、名次、公开结果投影或任何导出（内部对账表与对外留档件都不含）。",
  "评委侧（judgeMaterials 等）与主办方侧（eventWorkShowcase）都不返回留言；留言正文只在作品详情页的这个独立区返回（既有审计只记留言 ID、队伍、字数与治理说明，不含正文）。",
  "隐藏后的留言对所有读取面都不再返回正文；同一账号对同一条留言只能举报一次。",
  "本模块不裁决举报、不封禁账号；后续处理沿用主办方既有流程。",
  "留言挂在**队伍级作品展示单位**上：队伍重新交件后旧版本快照的评论入口不再可用，已写留言仍跟随该队伍当前展示的作品。",
];

export const workCommentsNotice = "这里是作品文字留言：与评委评分分列，不计入名次，也不进入结果与导出。";
