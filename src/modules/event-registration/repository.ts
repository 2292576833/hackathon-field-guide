import type { SqlExecutor, DatabasePort } from "../../shared/persistence.ts";
import type { RegistrationForm, Registration, RosterTeam, JoinRequest, ProjectLinkRequest, Page, TeamSuggestion } from "./model.ts";

export interface ListOptions { status?: string; cursor?: string; limit: number }
export interface RegistrationStore {
  readonly sql: SqlExecutor;
  lockEvent(eventId: string, organizationId: string): Promise<void>;
  getForm(eventId: string): Promise<RegistrationForm | null>;
  appendForm(form: RegistrationForm): Promise<void>;
  getRegistration(eventId: string, userId: string): Promise<Registration | null>;
  getRegistrationById(eventId: string, id: string): Promise<Registration | null>;
  saveRegistration(value: Registration, previousRevision: number, actorUserId: string): Promise<void>;
  countReservations(eventId: string): Promise<number>;
  /** 按状态精确计数（只统计已提交的报名；草稿属于本人，不计入主办方视图）。 */
  countRegistrations(eventId: string): Promise<Record<Registration["status"], number>>;
  listRegistrations(eventId: string, options: ListOptions): Promise<Page<Registration>>;
  listOwnRegistrations(userId: string, options: ListOptions): Promise<Page<Registration>>;
  getTeam(eventId: string, id: string): Promise<RosterTeam | null>;
  saveTeam(value: RosterTeam, previousRevision: number, actorUserId: string): Promise<void>;
  listTeams(eventId: string, options: ListOptions): Promise<Page<RosterTeam>>;
  activeTeamId(eventId: string, userId: string): Promise<string | null>;
  memberIds(eventId: string, teamId: string): Promise<string[]>;
  acceptMember(eventId: string, teamId: string, userId: string, acceptedAt: string): Promise<void>;
  leaveMember(eventId: string, teamId: string, userId: string, leftAt: string): Promise<void>;
  getJoin(eventId: string, teamId: string, id: string): Promise<JoinRequest | null>;
  getUserJoin(eventId: string, teamId: string, userId: string): Promise<JoinRequest | null>;
  ownRequests(eventId: string, userId: string): Promise<JoinRequest[]>;
  pendingRequests(eventId: string, teamId: string): Promise<JoinRequest[]>;
  saveJoin(value: JoinRequest, previousRevision: number, actorUserId: string): Promise<void>;
  getLink(eventId: string, teamId: string, id?: string): Promise<ProjectLinkRequest | null>;
  saveLink(value: ProjectLinkRequest, previousRevision: number, actorUserId: string): Promise<void>;
  getSuggestion(eventId: string, id: string): Promise<TeamSuggestion | null>;
  listSuggestions(eventId: string, userId?: string): Promise<TeamSuggestion[]>;
  isSuggestedForTeam(eventId: string, teamId: string, userId: string): Promise<boolean>;
  saveSuggestion(value: TeamSuggestion): Promise<void>;
  getReceipt<T>(eventId: string, userId: string, operation: string, key: string, fingerprint: string): Promise<T | null>;
  putReceipt(eventId: string, userId: string, operation: string, key: string, fingerprint: string, result: unknown): Promise<void>;
}
export interface RegistrationRepository {
  readonly database: DatabasePort;
  store(sql: SqlExecutor): RegistrationStore;
}
