import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventNotificationPort, EventParticipationPort, HostedEventAccessPort } from "../../shared/organizer-contracts.ts";

export interface CommunicationDependencies {
  database: DatabasePort; clock: Clock; ids: IdGenerator;
  eventAccess: HostedEventAccessPort; participation: EventParticipationPort;
  notification?: EventNotificationPort;
  /** Root supplies a current, event-scoped approved roster, never request JSON. */
  announcementAudience?: { listRecipientUserIds(sql: SqlExecutor, eventId: string): Promise<readonly string[]> };
  /**
   * 选手侧汇总（规划 33 P08）所需的**本人报名与队伍**只读投影。
   *
   * 本模块不查 `event-registration` 的表；根用既有服务方法实现本 Port 后注入。
   * 不注入时汇总仍可用，但对应区块返回 `unread`（"还没读到"），
   * 绝不退化成 `absent`（"确实没有"）——两者必须区分。
   */
  ownFacts?: EventOwnFactsPort;
  /** 规划34 D1：本场参赛名录的只读组合来源；不注入时不返回任何记录（不补占位）。 */
  directory?: EventDirectoryPort;
}

/** 规划34 D1：本场参赛名录的只读投影（复用已发布参赛名片与本场公开队伍，不新建资料）。 */
export interface EventDirectoryEntry {
  readonly userId: string; readonly displayName: string; readonly headline: string;
  readonly introduction: string; readonly skills: readonly string[]; readonly city: string;
}
export interface EventDirectoryTeam { readonly id: string; readonly name: string; readonly track: string }
export interface EventDirectory {
  readonly enabled: boolean;
  readonly entries: readonly EventDirectoryEntry[];
  readonly teams: readonly EventDirectoryTeam[];
  readonly notice: string;
  readonly limitations: readonly string[];
}
export interface EventDirectoryPort {
  /** 本场报名已通过、名单有效的账号标识（只读）。 */
  approvedParticipantIds(sql: SqlExecutor, eventId: string): Promise<readonly string[]>;
  /** 按账号批量取**已发布**的公开名片投影；只含公开字段。 */
  publishedCards(sql: SqlExecutor, userIds: readonly string[]): Promise<readonly EventDirectoryEntry[]>;
  /** 本场公开队伍投影。 */
publicTeams(sql: SqlExecutor, eventId: string): Promise<readonly EventDirectoryTeam[]>;
}

/** 本人在这场比赛的报名与队伍快照；只读，不产生任何写入。 */
export interface EventOwnFactsPort {
  /** 与 `EventParticipationPort.getRegistration` 同源，额外带上审核说明。 */
  registration(sql: SqlExecutor, eventId: string, userId: string): Promise<{
    readonly status: "draft" | "pending" | "approved" | "rejected" | "withdrawn";
    readonly reviewNote: string;
  } | null>;
  /** 本人当前活跃队伍；没有队伍返回 `null`，读取不到返回 `null` 并由调用方按 `unread` 处理。 */
  team(sql: SqlExecutor, eventId: string, userId: string): Promise<{
    readonly id: string; readonly name: string; readonly track: string;
    readonly status: "forming" | "locked" | "withdrawn";
    readonly captainUserId: string; readonly memberCount: number;
  } | null>;
}

export type TicketStatus = "open" | "in_progress" | "answered" | "closed";
export interface Announcement {
  id: string; eventId: string; revision: number; title: string; body: string; important: boolean;
  impact: string; dueAt: string | null; status: "draft" | "published" | "withdrawn";
  publishedAt: string | null; updatedAt: string; updatedBy: string;
  notification: { state: "queued" | "unconfigured"; referenceId: string | null };
}
export type AnnouncementView = Omit<Announcement, "updatedBy" | "notification"> & { read: boolean; notificationState: "queued" | "unconfigured" };
export interface AnnouncementInput { announcementId?: string; expectedRevision?: number; title: string; body: string; important: boolean; impact: string; dueAt?: string | null }
export interface TicketReply { id: string; body: string; role: "author" | "staff"; createdAt: string }
export interface FaqPreview { revision: number; title: string; question: string; answer: string; proposedAt: string; consentedAt: string | null }
export interface HelpTicket {
  id: string; eventId: string; userId: string; visibility: "public" | "private"; question: string;
  status: TicketStatus; revision: number; createdAt: string; updatedAt: string; updatedBy: string;
  replies: TicketReply[]; faqPreview: FaqPreview | null;
}
export interface TicketView extends Omit<HelpTicket, "userId" | "updatedBy"> { own: boolean }
export interface PublicFaq { id: string; eventId: string; revision: number; title: string; question: string; answer: string; publishedAt: string }
