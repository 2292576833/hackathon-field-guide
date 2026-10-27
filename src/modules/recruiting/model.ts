import type { ParticipantProfile } from "../../shared/participant.ts";

export const recruitingRoles = ["product", "design", "frontend", "backend", "ai", "testing", "presentation", "coordination", "other"] as const;
export type RecruitingRole = typeof recruitingRoles[number];
export const recruitingPurposes = ["award", "learn", "meet", "build", "other"] as const;
export type RecruitingPurpose = typeof recruitingPurposes[number];
export const roleLabels: Record<RecruitingRole, string> = { product: "需求与产品", design: "界面与设计", frontend: "前端开发", backend: "后端开发", ai: "AI 与算法", testing: "测试与文档", presentation: "演示与路演", coordination: "组织与协作", other: "其他职责" };
export const purposeLabels: Record<RecruitingPurpose, string> = { award: "争取拿奖", learn: "学习实践", meet: "认识伙伴", build: "做出作品", other: "其他目的" };

export interface WorkLink { title: string; url: string }
export interface RecruitingProfileData {
  primaryRoles: RecruitingRole[]; supportingRoles: RecruitingRole[]; purposes: RecruitingPurpose[];
  purposeNote: string; resume: string; workLinks: WorkLink[]; mbti: string; age: number | null;
}
export interface RecruitingProfile extends RecruitingProfileData { userId: string; revision: number; updatedAt: string | null; avatarRevision: number; hasAvatar: boolean }
export type PrivateRecruitingContext = Pick<RecruitingProfile, "userId" | "revision" | "primaryRoles" | "supportingRoles" | "purposes" | "purposeNote" | "resume" | "workLinks" | "updatedAt">;
/** Only these explicitly previewed fields are published; private inputs stay private. */
export interface CardDraft {
  headline: string; introduction: string; primaryRoles: RecruitingRole[]; supportingRoles: RecruitingRole[];
  purposes: RecruitingPurpose[]; purposeNote: string; skills: string[]; city: string;
  availableHoursPerDay: number | null; workLinks: WorkLink[]; showMbti: boolean; showAge: boolean; showAvatar: boolean;
}
export interface PublicRecruitingCard extends Omit<CardDraft, "showMbti" | "showAge" | "showAvatar"> {
  id: string; displayName: string; revision: number; publishedAt: string; mbti: string | null; age: number | null; avatarUrl: string | null;
}
export interface OwnCardState { id: string | null; revision: number; status: "private" | "published" | "withdrawn"; card: PublicRecruitingCard | null }
export interface RecruitingProfileView { displayName: string; profile: RecruitingProfile; participant: ParticipantProfile; card: OwnCardState }
export interface CardSummaryPreview { id: string; provider: "dsh"; profileRevision: number; participantRevision: number; avatarRevision: number; createdAt: string; draft: CardDraft }

export interface RecruitingPostData { spaceName: string; title: string; description: string; neededRoles: RecruitingRole[]; purposes: RecruitingPurpose[]; seats: number; status: "open" | "closed" | "withdrawn" }
export interface RecruitingPost extends RecruitingPostData { id: string; projectId: string; revision: number; publishedAt: string; updatedAt: string }
export interface RecruitingApplication {
  id: string; postId: string; projectId: string; applicantUserId: string; applicantDisplayName: string;
  message: string; cardSnapshot: PublicRecruitingCard | null; status: "pending" | "approved" | "rejected" | "withdrawn" | "joined";
  revision: number; reviewNote: string; reviewedBy: string | null; reviewedAt: string | null;
  membershipId: string | null; createdAt: string; updatedAt: string;
}
export interface OwnApplication extends RecruitingApplication { post: RecruitingPost | null; canJoin: boolean }
export interface RecruitingListFilter { role?: RecruitingRole; purpose?: RecruitingPurpose; keyword?: string; cursor?: string; limit?: number }
export interface RecruitingPage<T> { items: T[]; nextCursor: string | null }
export interface AvatarUpload { mimeType: "image/png" | "image/jpeg" | "image/webp"; base64: string }
export interface AvatarContent { mimeType: AvatarUpload["mimeType"]; bytes: Uint8Array }
