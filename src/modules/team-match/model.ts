import type { Actor, EntityId, Instant } from "../../shared/contracts.ts";
import type { EventRegistrationStatus } from "../../shared/organizer-contracts.ts";
import type { RecruitingRole } from "../recruiting/index.ts";

/**
 * AI 智能组队大厅 · 模块层（规划 36 §2.3、宪法 v1.24.0 原则 XII / XIII）。
 *
 * 本模块只做三件事：**过门槛、按职责缺口分组、写 1–2 句有依据的解释**。
 * 它不碰数据库、不写路由、不渲染界面；所有写入都通过根注入的端口完成。
 *
 * 硬边界（写在这里，避免后来者误加功能）：
 * 1. 三条门槛缺一不可：① 本场报名已通过；② 名片已发布；③ 本人开启「愿意被组队」。
 * 2. 第三条是**新增事实** `TeamMatchOptIn`，默认关闭；没有记录按未开启处理。
 * 3. 不评分、不给百分比、不排名、不写「最佳匹配」；同组内只按稳定中性顺序排列。
 * 4. 不展示简历全文、年龄、MBTI、头像、邮箱或任何联系方式；只给职责与可核对的事实。
 * 5. 不新建第二套邀请：接触只复用既有招募申请，通过 `TeamMatchInvitePort` 由根适配。
 * 6. 不发私信、不自动加入队伍、不替本人做任何选择。
 */

/** 与 `src/modules/recruiting/model.ts` 的 `recruitingRoles` 保持一致；新增角色时下面的完整性断言会让 tsc 报错。 */
export const teamMatchRoleOrder = [
  "product", "design", "frontend", "backend", "ai", "testing", "presentation", "coordination", "other",
] as const satisfies readonly RecruitingRole[];

type AssertTrue<T extends true> = T;
type _EveryRoleIsOrdered = AssertTrue<Exclude<RecruitingRole, typeof teamMatchRoleOrder[number]> extends never ? true : false>;

/** 标签必须与 recruiting 的 `roleLabels` 同文；不从 recruiting 运行时出口导入，避免纯逻辑测试被数据库依赖拖住。 */
export const teamMatchRoleLabels: Record<RecruitingRole, string> = {
  product: "需求与产品",
  design: "界面与设计",
  frontend: "前端开发",
  backend: "后端开发",
  ai: "AI 与算法",
  testing: "测试与文档",
  presentation: "演示与路演",
  coordination: "组织与协作",
  other: "其他职责",
};

/** 本场报名状态的只读投影；`none` 表示没有报名记录。 */
export type TeamMatchRegistrationStatus = EventRegistrationStatus | "none";
/** 名片状态；只有 `published` 才通过第二条门槛。 */
export type TeamMatchCardStatus = "published" | "withdrawn" | "none";

/**
 * 已发布名片里参与组队的字段。**刻意没有** age / mbti / avatar / resume / 邮箱：
 * 宪法 XII 明确这些不参与匹配，组队大厅也不展示简历全文。
 */
export interface TeamMatchPublishedCard {
  id: EntityId;
  headline: string;
  primaryRoles: readonly RecruitingRole[];
  supportingRoles: readonly RecruitingRole[];
  skills: readonly string[];
  city: string;
  publishedAt: Instant;
  updatedAt: Instant;
}

/**
 * 根从既有报名与既有名片合成的候选人投影（**不是新表**）。
 * 三条门槛的前两条在这里：`registrationStatus` 来自本场报名，`cardStatus`/`card` 来自 recruiting。
 */
export interface TeamMatchCandidateCard {
  userId: EntityId;
  displayName: string;
  registrationStatus: TeamMatchRegistrationStatus;
  cardStatus: TeamMatchCardStatus;
  /** 与 `cardStatus === "published"` 必须一致；不一致按未发布处理，绝不猜测。 */
  card: TeamMatchPublishedCard | null;
}

/**
 * 根从既有招募帖与 `recruiting/gap.ts` 合成的事实投影（**不是新表**）。
 * `coveredRoles` 必须来自 gapView 的口径（只统计通过本贴批准/已加入的人），本模块不另算一套覆盖。
 */
export interface TeamMatchPostFacts {
  postId: EntityId;
  projectId: EntityId;
  spaceName: string;
  title: string;
  status: "open" | "closed" | "withdrawn";
  neededRoles: readonly RecruitingRole[];
  coveredRoles: readonly RecruitingRole[];
  seats: number;
  takenSeats: number;
  updatedAt: Instant;
}

/** 查看者本人：只用于判断"哪些缺口不是自己已经声明的"和解释句里的同城事实。 */
export interface TeamMatchViewer {
  userId: EntityId;
  eventId: EntityId;
  primaryRoles: readonly RecruitingRole[];
  supportingRoles: readonly RecruitingRole[];
  /** 选填。没有真实城市就不传，解释句不得推断。 */
  city?: string;
}

/** 第三条门槛的唯一新增事实。默认关闭；没有记录 = 未开启。 */
export interface TeamMatchOptIn {
  userId: EntityId;
  eventId: EntityId;
  open: boolean;
  updatedAt: Instant;
}

export interface TeamMatchOptInInput {
  eventId: EntityId;
  open: boolean;
  now: Instant;
}

/**
 * opt-in 读写端口。由根实现（建议独立表 `tmt_team_match_opt_in`，见交付文档 NEEDS_INTERFACE）。
 *
 * - `readOpen` 只返回本场 `open = true` 的记录；**关闭的记录不得返回**，不能靠调用方再过滤。
 * - `readOwn` 只返回本人记录；没有记录返回 `null`（界面显示"未开启"）。
 * - `setOwn` 只能写 `actor.userId` 本人；必须与账号当前有效报名/身份同一事务复核。
 */
export interface TeamMatchOptInPort {
  readOpen(actor: Actor, eventId: EntityId): Promise<readonly TeamMatchOptIn[]>;
  readOwn(actor: Actor, eventId: EntityId): Promise<TeamMatchOptIn | null>;
  setOwn(actor: Actor, input: TeamMatchOptInInput): Promise<TeamMatchOptIn>;
}

/** 邀请端口输入：复用既有招募申请，不是第二套邀请事实。 */
export interface TeamMatchInviteInput {
  eventId: EntityId;
  postId: EntityId;
  applicantUserId: EntityId;
  message: string;
  idempotencyKey: string;
}

/**
 * 邀请复用端口：根把**既有** `POST /api/v1/recruiting/posts/:postId/applications` 适配到这里。
 *
 * 不变量：
 * - `actor.userId === input.applicantUserId`，只能由申请人本人确认后调用；平台不代填、不代提交。
 * - 创建的是既有招募申请，**不是成员资格**；是否批准、是否加入仍走既有流程。
 * - 本模块**没有任何调用点**：这里只定义契约，绝不自动邀请或自动加入。
 */
export interface TeamMatchInvitePort {
  createApplication(actor: Actor, input: TeamMatchInviteInput): Promise<{ applicationId: EntityId }>;
}

/** 可选 AI 解释端口；根可适配共享 PersonalAiPort，但必须计入既有账本、禁工具、只读 facts。 */
export interface TeamMatchExplainModel {
  explain(input: { instruction: string; facts: TeamMatchExplanationFacts }): Promise<string>;
}

/** 解释句允许引用的事实字段。没有的字段不要传，传了才可能被提到。 */
export interface TeamMatchExplanationFacts {
  displayName: string;
  roles: readonly RecruitingRole[];
  skills: readonly string[];
  city: string;
  sameCity: boolean;
  /** 可选：招募贴标题，只用于让句子有上下文，不是候选人事实。 */
  postTitle?: string;
}

export type TeamMatchDegradedReason = "model_not_injected" | "model_failed" | "model_output_rejected";

export interface TeamMatchExplanation {
  text: string;
  /** true 表示模型未使用/不可用/输出被拒，text 是固定模板句。 */
  degraded: boolean;
  source: "model" | "template";
  degradedReason: TeamMatchDegradedReason | null;
}

/** 三条门槛的拒绝原因；仅供服务端内部与测试使用，不进入候选人投影。 */
export type TeamMatchGateReason =
  | "registration_not_approved"
  | "card_not_published"
  | "opt_in_missing_or_closed"
  | "viewer_self";

export interface TeamMatchGateResult {
  eligible: boolean;
  reasons: readonly TeamMatchGateReason[];
}

/** 分组中的一位候选人。字段就是界面允许展示的全部内容。 */
export interface TeamMatchCandidate {
  userId: EntityId;
  displayName: string;
  cardId: EntityId;
  headline: string;
  /** 名片自述的主/辅职责（全量，规范顺序）。 */
  primaryRoles: readonly RecruitingRole[];
  supportingRoles: readonly RecruitingRole[];
  /** 能补上的本场缺口职责；可能多于其归组的那一项，但绝不因此重复出现。 */
  coveringRoles: readonly RecruitingRole[];
  skills: readonly string[];
  city: string;
  sameCity: boolean;
  publishedAt: Instant;
  updatedAt: Instant;
}

export interface TeamMatchPostRef {
  postId: EntityId;
  projectId: EntityId;
  spaceName: string;
  title: string;
}

/** 一个职责缺口分组。组内顺序是中性稳定顺序，不是能力或适配排序。 */
export interface TeamMatchRoleGroup {
  role: RecruitingRole;
  roleLabel: string;
  /** 哪些招募贴缺这项职责。 */
  neededBy: readonly TeamMatchPostRef[];
  candidates: readonly TeamMatchCandidate[];
  notice: string;
}

export interface TeamMatchUnfilledRole {
  role: RecruitingRole;
  roleLabel: string;
  neededBy: readonly TeamMatchPostRef[];
}

/** 组队大厅只读派生结果。 */
export interface TeamMatchGrouping {
  eventId: EntityId;
  viewerUserId: EntityId;
  viewerRoles: readonly RecruitingRole[];
  groups: readonly TeamMatchRoleGroup[];
  /** 有缺口、但没有任何通过三门槛的候选人；界面只能提示"暂无可展示的人"。 */
  unfilledRoles: readonly TeamMatchUnfilledRole[];
  notice: string;
  /** 界面必须原文展示的口径说明。 */
  evidence: readonly string[];
}

/** 每个缺口组最多展示的人数；上限属于"避免变成排行榜"的展示约束，不是排序依据。 */
export const teamMatchGroupLimit = 12;
