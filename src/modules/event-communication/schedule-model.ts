import type { Clock, EntityId, IdGenerator, Instant } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventParticipationPort, HostedEventAccessPort, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";

export type ScheduleAudience = "all" | "participants" | "users";
export interface ScheduleItem {
  readonly id: EntityId;
  readonly title: string;
  /** ISO 8601 with explicit offset; service normalizes to UTC. */
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly location: string;
  readonly audience: ScheduleAudience;
  readonly userIds: readonly EntityId[];
}
export type ScheduleItemInput = Omit<ScheduleItem, "id"> & { readonly id?: EntityId };
export interface ScheduleDraft {
  readonly eventId: EntityId;
  readonly organizationId: EntityId;
  readonly revision: number;
  readonly publishedRevision: number | null;
  readonly timezone: string;
  readonly items: readonly ScheduleItem[];
  readonly impact: string;
  readonly updatedAt: Instant | null;
}
/** Published projection never exposes other recipients' IDs or editor identity. */
export interface PublishedSchedule {
  readonly eventId: EntityId;
  readonly enabled: boolean;
  readonly revision: number | null;
  readonly timezone: string;
  readonly items: readonly Omit<ScheduleItem, "userIds">[];
  readonly impact: string;
  readonly publishedAt: Instant | null;
}
export interface SaveScheduleDraftInput {
  readonly expectedRevision: number;
  readonly timezone: string;
  readonly items: readonly ScheduleItemInput[];
  readonly impact: string;
}
export interface ScheduleImportInput {
  readonly csv: string;
  readonly expectedRevision: number;
  readonly timezone?: string;
  readonly impact?: string;
}
export interface ScheduleImportPreview {
  readonly previewId: EntityId;
  readonly expectedRevision: number;
  readonly timezone: string;
  readonly items: readonly ScheduleItem[];
  readonly impact: string;
  readonly errors: readonly { readonly row: number; readonly message: string }[];
  readonly expiresAt: Instant;
}
export interface IcebreakerGroup {
  readonly id: EntityId;
  readonly title: string;
  readonly revision: number;
  readonly memberUserIds: readonly EntityId[];
}
export type IcebreakerChoice = "join" | "decline";
export interface IcebreakerActivity {
  readonly id: EntityId;
  readonly title: string;
  readonly description: string;
  readonly startsAt: Instant;
  readonly location: string;
  readonly revision: number;
  readonly ownChoice: IcebreakerChoice | null;
  readonly ownGroup: IcebreakerGroup | null;
  /** Present only for current logistics staff; never in a participant projection. */
  readonly responses?: readonly { readonly userId: EntityId; readonly choice: IcebreakerChoice; readonly updatedAt: Instant }[];
  readonly groups?: readonly IcebreakerGroup[];
}
export interface IcebreakerList {
  readonly eventId: EntityId;
  readonly enabled: boolean;
  readonly activities: readonly IcebreakerActivity[];
}
export interface CreateIcebreakerInput {
  readonly title: string;
  readonly description: string;
  readonly startsAt: Instant;
  readonly location: string;
}
export interface AssignIcebreakerGroupInput {
  readonly activityId: EntityId;
  readonly title: string;
  readonly userIds: readonly EntityId[];
  readonly expectedRevision: number;
}
export interface EventScheduleDependencies {
  readonly database: DatabasePort;
  readonly eventAccess: HostedEventAccessPort;
  readonly participation: EventParticipationPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
export interface EventScheduleService {
  getSchedule(principal: OrganizerPrincipal | null, eventId: EntityId): Promise<PublishedSchedule>;
  /**
   * 规划35：专属页时间线用的**同事务**公开投影（无 principal）。
   * 只返回 `audience=all` 的已发布条目；未发布/未开日程/草稿态一律空数组，不编造时间。
   */
  publicScheduleNodes(sql: SqlExecutor, eventId: EntityId): Promise<readonly { readonly id: EntityId; readonly title: string; readonly at: Instant | null; readonly kind: string }[]>;
  getScheduleDraft(principal: OrganizerPrincipal, eventId: EntityId): Promise<ScheduleDraft>;
  saveScheduleDraft(principal: OrganizerPrincipal, eventId: EntityId, input: SaveScheduleDraftInput): Promise<ScheduleDraft>;
  previewScheduleImport(principal: OrganizerPrincipal, eventId: EntityId, input: ScheduleImportInput): Promise<ScheduleImportPreview>;
  confirmScheduleImport(principal: OrganizerPrincipal, eventId: EntityId, input: { readonly previewId: EntityId; readonly expectedRevision: number }): Promise<ScheduleDraft>;
  publishSchedule(principal: OrganizerPrincipal, eventId: EntityId, input: { readonly expectedRevision: number }): Promise<PublishedSchedule>;
  listIcebreakers(principal: OrganizerPrincipal, eventId: EntityId): Promise<IcebreakerList>;
  listManagedIcebreakers(principal: OrganizerPrincipal, eventId: EntityId): Promise<IcebreakerList>;
  createIcebreaker(principal: OrganizerPrincipal, eventId: EntityId, input: CreateIcebreakerInput): Promise<IcebreakerActivity>;
  respondIcebreaker(principal: OrganizerPrincipal, eventId: EntityId, input: { readonly activityId: EntityId; readonly choice: IcebreakerChoice }): Promise<{ readonly activityId: EntityId; readonly choice: IcebreakerChoice; readonly revision: number }>;
  assignIcebreakerGroup(principal: OrganizerPrincipal, eventId: EntityId, input: AssignIcebreakerGroupInput): Promise<{ readonly activityId: EntityId; readonly revision: number; readonly group: IcebreakerGroup }>;
}
