import type {
  AvatarUpload, CardDraft, CardSummaryPreview, OwnApplication, OwnCardState,
  RecruitingApplication, RecruitingListFilter, RecruitingPage, RecruitingPost,
  RecruitingPostData, RecruitingProfileData, RecruitingProfileView, PublicRecruitingCard,
} from "./model.ts";
import type { GapView } from "./gap.ts";

export interface PublishCardInput {
  expectedRevision: number; profileRevision: number; participantRevision: number;
  avatarRevision: number; draft: CardDraft; confirmed: true;
}
export interface ApplyInput {
  expectedPostRevision: number; expectedRevision: number; requestId: string;
  message: string; shareCard: boolean;
}
export interface RecruitingClient {
  getProfile(signal?: AbortSignal): Promise<RecruitingProfileView>;
  saveProfile(input: { expectedRevision: number; profile: RecruitingProfileData }): Promise<RecruitingProfileView>;
  summarizeProfile(input: { expectedRevision: number }): Promise<CardSummaryPreview>;
  uploadAvatar(input: { expectedRevision: number; avatar: AvatarUpload }): Promise<RecruitingProfileView>;
  removeAvatar(input: { expectedRevision: number }): Promise<RecruitingProfileView>;
  privateAvatarUrl(): string;
  publishCard(input: PublishCardInput): Promise<OwnCardState>;
  withdrawCard(input: { expectedRevision: number }): Promise<OwnCardState>;
  listCards(filter?: RecruitingListFilter, signal?: AbortSignal): Promise<RecruitingPage<PublicRecruitingCard>>;
  listPosts(filter?: RecruitingListFilter, signal?: AbortSignal): Promise<RecruitingPage<RecruitingPost>>;
  getApplications(signal?: AbortSignal): Promise<OwnApplication[]>;
  apply(postId: string, input: ApplyInput): Promise<RecruitingApplication>;
  withdrawApplication(id: string, input: { expectedRevision: number }): Promise<RecruitingApplication>;
  joinApplication(id: string, input: { expectedRevision: number; confirmed: true }): Promise<RecruitingApplication>;
  getPost(projectId: string, signal?: AbortSignal): Promise<RecruitingPost | null>;
  savePost(projectId: string, input: { expectedRevision: number; post: RecruitingPostData }): Promise<RecruitingPost>;
  getProjectApplications(projectId: string, signal?: AbortSignal): Promise<RecruitingApplication[]>;
  /** 招募帖缺口与可补缺口的人：只读派生，不评分也不自动邀请。 */
  getPostGaps(projectId: string, signal?: AbortSignal): Promise<GapView>;
  reviewApplication(id: string, input: { expectedRevision: number; decision: "approve" | "reject"; note: string }): Promise<RecruitingApplication>;
}

export class RecruitingClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly latestRevision: number | undefined;
  constructor(message: string, status: number, code: string, latestRevision?: number) {
    super(message); this.name = "RecruitingClientError";
    this.status = status; this.code = code; this.latestRevision = latestRevision;
  }
}

export function createRecruitingClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}): RecruitingClient {
  const base = (options.baseUrl ?? "/api/v1").replace(/\/$/, "");
  const request = async <T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> => {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(`${base}${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RecruitingClientError(method === "GET" ? "读取失败，请检查网络后重试。" : "暂未收到保存结果。输入已保留，请先读取最新记录，避免重复提交。", 0, "RESULT_UNKNOWN");
    }
    let envelope: { data?: T; latestRevision?: number; error?: { message?: string; code?: string; latestRevision?: number; details?: { latestRevision?: number } } };
    try { envelope = await response.json(); }
    catch { throw new RecruitingClientError("服务返回暂时无法读取，请先刷新记录核对结果。", response.status, "INVALID_RESPONSE"); }
    if (!envelope || typeof envelope !== "object") throw new RecruitingClientError("服务返回格式不完整，请读取最新记录后继续。", response.status, "INVALID_RESPONSE");
    if (!response.ok || envelope.error) {
      const code = envelope.error?.code ?? "REQUEST_FAILED";
      const revision = envelope.error?.latestRevision ?? envelope.error?.details?.latestRevision ?? envelope.latestRevision;
      if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("hackathon:unauthenticated"));
      throw new RecruitingClientError(envelope.error?.message ?? (response.status === 401 ? "请登录后继续。" : "操作未完成，输入已保留。"), response.status, code, revision);
    }
    if (!("data" in envelope)) throw new RecruitingClientError("服务返回缺少结果，请读取最新记录后继续。", 502, "INVALID_RESPONSE");
    return envelope.data as T;
  };
  const listPath = (path: string, filter: RecruitingListFilter = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, String(value));
    return `${path}${query.size ? `?${query}` : ""}`;
  };
  const segment = (value: string) => encodeURIComponent(value);
  return {
    getProfile: signal => request("/me/recruiting-profile", "GET", undefined, signal),
    saveProfile: input => request("/me/recruiting-profile", "PATCH", input),
    summarizeProfile: input => request("/me/recruiting-profile/summary", "POST", input),
    uploadAvatar: input => request("/me/recruiting-profile/avatar", "POST", input),
    removeAvatar: input => request("/me/recruiting-profile/avatar", "DELETE", input),
    privateAvatarUrl: () => `${base}/me/recruiting-profile/avatar`,
    publishCard: input => request("/me/recruiting-card/publish", "POST", input),
    withdrawCard: input => request("/me/recruiting-card/withdraw", "POST", input),
    listCards: (filter, signal) => request(listPath("/recruiting/cards", filter), "GET", undefined, signal),
    listPosts: (filter, signal) => request(listPath("/recruiting/posts", filter), "GET", undefined, signal),
    getApplications: signal => request("/me/recruiting-applications", "GET", undefined, signal),
    apply: (id, input) => request(`/recruiting/posts/${segment(id)}/applications`, "POST", input),
    withdrawApplication: (id, input) => request(`/recruiting/applications/${segment(id)}/withdraw`, "POST", input),
    joinApplication: (id, input) => request(`/recruiting/applications/${segment(id)}/join`, "POST", input),
    getPost: (id, signal) => request(`/projects/${segment(id)}/recruiting-post`, "GET", undefined, signal),
    savePost: (id, input) => request(`/projects/${segment(id)}/recruiting-post`, input.expectedRevision === 0 ? "POST" : "PATCH", input),
    getProjectApplications: (id, signal) => request(`/projects/${segment(id)}/recruiting-applications`, "GET", undefined, signal),
    getPostGaps: (id, signal) => request(`/projects/${segment(id)}/recruiting-post/gaps`, "GET", undefined, signal),
    reviewApplication: (id, input) => request(`/recruiting/applications/${segment(id)}/review`, "POST", input),
  };
}

export const defaultRecruitingClient = createRecruitingClient();
export function recruitingErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "操作未完成，输入已保留。";
  return error instanceof RecruitingClientError && error.latestRevision !== undefined
    ? `${text} 当前服务版本为 ${error.latestRevision}；请读取最新记录并核对后再保存。`
    : text;
}
export function recruitingDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + "（北京时间）";
}
export function recruitingSafeLink(value: string): string | undefined {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
