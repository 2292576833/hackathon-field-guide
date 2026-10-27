import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { OfficialTrackRulesContext, ProjectOfficialTrackRulesPort } from "../events/index.ts";
import type { ProjectAggregate, ProjectMember } from "./model.ts";
import type { ProjectsRepository } from "./ports.ts";
import { assertKnownFields, idField, invalid, revisionField, textField } from "./validation.ts";

export const PROJECT_DUTIES = ["requirements", "design", "development", "testing", "documentation", "presentation", "coordination", "other"] as const;
export type ProjectDuty = typeof PROJECT_DUTIES[number];
export interface IntentionSharing { duties: boolean; experience: boolean; wantsAiHelp: boolean; helpQuestion: boolean }
export interface MemberIntention {
  projectId: string;
  userId: string;
  membershipRevision: number;
  revision: number;
  duties: ProjectDuty[];
  experience: string;
  wantsAiHelp: boolean;
  helpQuestion: string;
  share: IntentionSharing;
  updatedAt: string;
}
/** Unshared fields are absent, not redacted strings; no raw assessment/profile is included. */
export interface SharedMemberIntention {
  userId: string;
  revision: number;
  membershipRevision: number;
  updatedAt: string;
  duties?: ProjectDuty[];
  experience?: string;
  wantsAiHelp?: boolean;
  helpQuestion?: string;
}
export interface ProjectTrackSelection {
  projectId: string;
  eventId: string;
  rulesVersion: number;
  confirmationRevision: number;
  trackId: string | null;
  trackName: string | null;
  catalogStatus: "none" | "confirmed";
  revision: number;
  selectedBy: string;
  selectedAt: string;
  reason: string;
}
export interface ProjectOfficialTracksView {
  projectId: string;
  projectRevision: number;
  canManage: boolean;
  readonly: boolean;
  rules: OfficialTrackRulesContext | null;
  selection: ProjectTrackSelection | null;
  needsReview: boolean;
  history: ProjectTrackSelection[];
}
export interface MyIntentionView {
  projectId: string;
  projectRevision: number;
  membershipRevision: number;
  readonly: boolean;
  needsConfirmation: boolean;
  intention: MemberIntention | null;
}
export interface SharedIntentionsView { projectId: string; projectRevision: number; intentions: SharedMemberIntention[] }
export interface MemberIntentionInput {
  expectedRevision: number;
  duties: ProjectDuty[];
  experience: string;
  wantsAiHelp: boolean;
  helpQuestion: string;
  share: IntentionSharing;
}
export interface TrackSelectionInput { expectedRevision: number; eventId: string; rulesVersion: number; confirmationRevision: number; trackId: string | null; reason: string }

/** All methods use M02's locked transaction, with atomic CAS + immutable revision history. */
export interface ProjectCollaborationRepository {
  getIntention(executor: SqlExecutor, projectId: string, userId: string): Promise<MemberIntention | null>;
  listIntentions(executor: SqlExecutor, projectId: string): Promise<MemberIntention[]>;
  saveIntention(executor: SqlExecutor, value: MemberIntention, expectedRevision: number): Promise<void>;
  getSelection(executor: SqlExecutor, projectId: string): Promise<ProjectTrackSelection | null>;
  listSelectionHistory(executor: SqlExecutor, projectId: string): Promise<ProjectTrackSelection[]>;
  saveSelection(executor: SqlExecutor, value: ProjectTrackSelection, expectedRevision: number): Promise<void>;
}
export interface ProjectCollaborationDependencies {
  projects: ProjectsRepository;
  repository: ProjectCollaborationRepository;
  officialRules?: ProjectOfficialTrackRulesPort;
  clock: Clock;
  ids: IdGenerator;
}

function requireMember(aggregate: ProjectAggregate, actor: Actor): ProjectMember {
  const member = aggregate.members.find(item => item.userId === actor.userId && item.projectId === aggregate.project.id && item.status === "active");
  if (!member) throw new DomainError("PROJECT_UNAVAILABLE", "项目不存在或你已不在此项目中。", { status: 404 });
  return member;
}
function expectRevision(expected: number, actual: number): void {
  revisionField(expected, true);
  if (expected !== actual) throw new DomainError("VERSION_CONFLICT", "队伍资料已更新，请查看最新版本并保留你的输入后重试。", { status: 409, latestRevision: actual, recoveryAction: "review_latest_version" });
}
function editable(aggregate: ProjectAggregate): void {
  if (aggregate.project.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "项目已归档，只能查看已保存资料。", { status: 409 });
}
/** No default sharing is inferred from role or a previous assessment. */
function parseIntention(input: MemberIntentionInput): Omit<MemberIntentionInput, "expectedRevision"> {
  assertKnownFields(input, ["expectedRevision", "duties", "experience", "wantsAiHelp", "helpQuestion", "share"]);
  revisionField(input.expectedRevision, true);
  if (!Array.isArray(input.duties) || input.duties.length > PROJECT_DUTIES.length || input.duties.some(item => !PROJECT_DUTIES.includes(item)) || new Set(input.duties).size !== input.duties.length) invalid("请选择有效且不重复的职责；可以多选或暂不选择。");
  if (typeof input.wantsAiHelp !== "boolean") invalid("请明确是否希望 AI 帮助判断职责。");
  assertKnownFields(input.share, ["duties", "experience", "wantsAiHelp", "helpQuestion"]);
  for (const key of ["duties", "experience", "wantsAiHelp", "helpQuestion"] as const) if (typeof input.share[key] !== "boolean") invalid("请明确选择每一项资料是否分享给队友。");
  return {
    duties: [...input.duties], experience: textField(input.experience, "本次相关经验", 2000, true),
    wantsAiHelp: input.wantsAiHelp, helpQuestion: textField(input.helpQuestion, "希望获得的帮助", 2000, true), share: { ...input.share },
  };
}
export function sharedIntention(value: MemberIntention): SharedMemberIntention {
  return {
    userId: value.userId, revision: value.revision, membershipRevision: value.membershipRevision, updatedAt: value.updatedAt,
    ...(value.share.duties ? { duties: [...value.duties] } : {}),
    ...(value.share.experience ? { experience: value.experience } : {}),
    ...(value.share.wantsAiHelp ? { wantsAiHelp: value.wantsAiHelp } : {}),
    ...(value.share.helpQuestion ? { helpQuestion: value.helpQuestion } : {}),
  };
}
function selectionNeedsReview(selection: ProjectTrackSelection | null, rules: OfficialTrackRulesContext | null): boolean {
  if (!selection || !rules || !["confirmed", "none"].includes(rules.catalog.status)) return true;
  return selection.eventId !== rules.eventId || selection.rulesVersion !== rules.rulesVersion || selection.confirmationRevision !== rules.confirmationRevision ||
    (rules.latestPublishedRulesVersion !== null && rules.latestPublishedRulesVersion !== rules.rulesVersion) ||
    selection.catalogStatus !== rules.catalog.status || (selection.trackId !== null && !rules.catalog.tracks.some(item => item.id === selection.trackId));
}

export class ProjectCollaborationService {
  private readonly deps: ProjectCollaborationDependencies;
  constructor(dependencies: ProjectCollaborationDependencies) { this.deps = dependencies; }
  private async scope<T>(actor: Actor, projectId: string, work: (aggregate: ProjectAggregate, member: ProjectMember, executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (!actor?.userId) throw new DomainError("AUTH_REQUIRED", "请登录后继续。", { status: 401 });
    return this.deps.projects.withProject(idField(projectId), async (aggregate, executor) => {
      const member = requireMember(aggregate, actor);
      if (!executor) throw new DomainError("COLLABORATION_TRANSACTION_UNAVAILABLE", "项目事务适配尚未接入。", { status: 503 });
      return work(aggregate, member, executor);
    });
  }
  private async tracksView(aggregate: ProjectAggregate, member: ProjectMember, executor: SqlExecutor): Promise<ProjectOfficialTracksView> {
    if (!this.deps.officialRules) throw new DomainError("OFFICIAL_TRACK_RULES_UNAVAILABLE", "官方赛道规则接口尚未接入。", { status: 503 });
    const projectId = aggregate.project.id;
    const rules = await this.deps.officialRules.getProjectTrackRules(projectId, executor);
    const selection = await this.deps.repository.getSelection(executor, projectId);
    const history = await this.deps.repository.listSelectionHistory(executor, projectId);
    return { projectId, projectRevision: aggregate.project.revision, canManage: member.role === "manager", readonly: aggregate.project.stage === "archived", rules, selection, needsReview: selectionNeedsReview(selection, rules), history };
  }
  async getOfficialTracks(actor: Actor, projectId: string): Promise<ProjectOfficialTracksView> {
    return this.scope(actor, projectId, (aggregate, member, executor) => this.tracksView(aggregate, member, executor));
  }
  async selectTrack(actor: Actor, projectId: string, input: TrackSelectionInput): Promise<ProjectOfficialTracksView> {
    assertKnownFields(input, ["expectedRevision", "eventId", "rulesVersion", "confirmationRevision", "trackId", "reason"]);
    revisionField(input.expectedRevision, true); revisionField(input.rulesVersion); revisionField(input.confirmationRevision); idField(input.eventId, "赛事 ID");
    if (input.trackId !== null) idField(input.trackId, "官方赛道 ID");
    const reason = textField(input.reason, "选择说明", 1000, true);
    return this.scope(actor, projectId, async (aggregate, member, executor) => {
      editable(aggregate);
      if (member.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "只有活跃项目管理员可以确认本队赛道。", { status: 403 });
      const view = await this.tracksView(aggregate, member, executor);
      expectRevision(input.expectedRevision, view.selection?.revision ?? 0);
      const rules = view.rules;
      if (!rules) throw new DomainError("PROJECT_RULES_REQUIRED", "请先确认本项目的比赛要求，再选择主办方赛道。", { status: 409 });
      if (input.eventId !== rules.eventId || input.confirmationRevision !== rules.confirmationRevision || input.rulesVersion !== rules.rulesVersion || (rules.latestPublishedRulesVersion !== null && rules.latestPublishedRulesVersion !== rules.rulesVersion)) throw new DomainError("TRACK_RULES_CHANGED", "比赛规则有新版本，请核对并确认规则后再保存赛道。", { status: 409, recoveryAction: "confirm_latest_rules" });
      if (rules.catalog.status === "unknown" || rules.catalog.status === "conflict") throw new DomainError("TRACK_RULES_UNRESOLVED", "官方赛道仍待核对或存在冲突；可以先准备通用任务。", { status: 409 });
      const track = rules.catalog.tracks.find(item => item.id === input.trackId);
      if ((rules.catalog.status === "none" && input.trackId !== null) || (rules.catalog.status === "confirmed" && !track)) invalid("请选择当前规则中的官方赛道；主办方未细分时使用统一要求。");
      const now = this.deps.clock.now().toISOString();
      const next: ProjectTrackSelection = {
        projectId, eventId: rules.eventId, rulesVersion: rules.rulesVersion, confirmationRevision: rules.confirmationRevision,
        trackId: track?.id ?? null, trackName: track?.name ?? null, catalogStatus: rules.catalog.status, revision: input.expectedRevision + 1,
        selectedBy: actor.userId, selectedAt: now, reason,
      };
      await this.deps.repository.saveSelection(executor, next, input.expectedRevision);
      this.record(aggregate, actor, "ProjectTrackSelectionChanged", projectId, { selectionRevision: view.selection?.revision ?? 0 }, { selectionRevision: next.revision, eventId: next.eventId, rulesVersion: next.rulesVersion, trackId: next.trackId, planReviewRequired: true }, now);
      return { ...view, projectRevision: aggregate.project.revision, selection: next, needsReview: false, history: [next, ...view.history] };
    });
  }
  private async intentionView(aggregate: ProjectAggregate, member: ProjectMember, executor: SqlExecutor): Promise<MyIntentionView> {
    const intention = await this.deps.repository.getIntention(executor, aggregate.project.id, member.userId);
    return { projectId: aggregate.project.id, projectRevision: aggregate.project.revision, membershipRevision: member.revision, readonly: aggregate.project.stage === "archived", needsConfirmation: !!intention && intention.membershipRevision !== member.revision, intention };
  }
  async getMyIntention(actor: Actor, projectId: string): Promise<MyIntentionView> {
    return this.scope(actor, projectId, (aggregate, member, executor) => this.intentionView(aggregate, member, executor));
  }
  async updateMyIntention(actor: Actor, projectId: string, input: MemberIntentionInput): Promise<MyIntentionView> {
    const data = parseIntention(input);
    return this.scope(actor, projectId, async (aggregate, member, executor) => {
      editable(aggregate);
      const previous = await this.deps.repository.getIntention(executor, projectId, actor.userId);
      expectRevision(input.expectedRevision, previous?.revision ?? 0);
      const now = this.deps.clock.now().toISOString();
      const intention: MemberIntention = { ...data, projectId, userId: actor.userId, membershipRevision: member.revision, revision: input.expectedRevision + 1, updatedAt: now };
      await this.deps.repository.saveIntention(executor, intention, input.expectedRevision);
      // Activity/outbox contain revisions only; private answers are never copied to a shared feed.
      this.record(aggregate, actor, "MemberIntentionChanged", actor.userId, { intentionRevision: previous?.revision ?? 0 }, { intentionRevision: intention.revision, membershipRevision: member.revision, planReviewRequired: true }, now);
      return { projectId, projectRevision: aggregate.project.revision, membershipRevision: member.revision, readonly: false, needsConfirmation: false, intention };
    });
  }
  async getSharedIntentions(actor: Actor, projectId: string): Promise<SharedIntentionsView> {
    return this.scope(actor, projectId, async (aggregate, _member, executor) => {
      const intentions = await this.deps.repository.listIntentions(executor, projectId);
      // Departed/rejoined members' old consent is not reused. An all-private revision still invalidates AI snapshots.
      const shared = intentions.filter(value => aggregate.members.some(member => member.status === "active" && member.userId === value.userId && member.revision === value.membershipRevision)).map(sharedIntention);
      return { projectId, projectRevision: aggregate.project.revision, intentions: shared };
    });
  }
  /** Root M04/M05 adapters can read both inputs in one current project transaction. */
  async getCollaborationContext(actor: Actor, projectId: string) {
    return this.scope(actor, projectId, async (aggregate, member, executor) => {
      const officialTracks = await this.tracksView(aggregate, member, executor);
      const values = await this.deps.repository.listIntentions(executor, projectId);
      const members = aggregate.members.filter(item => item.status === "active");
      const intentions = values.filter(value => members.some(member => member.userId === value.userId && member.revision === value.membershipRevision)).map(sharedIntention);
      const availability = aggregate.availability.filter(value => members.some(member => member.userId === value.userId && member.revision === value.membershipRevision));
      return structuredClone({ project: aggregate.project, members, officialTracks, intentions, availability });
    });
  }
  private record(aggregate: ProjectAggregate, actor: Actor, type: "MemberIntentionChanged" | "ProjectTrackSelectionChanged", objectId: string, before: Record<string, unknown>, after: Record<string, unknown>, now: string): void {
    aggregate.project.revision += 1; aggregate.project.updatedAt = now;
    const revision = aggregate.project.revision;
    aggregate.activities.push({ id: this.deps.ids.next(), projectId: aggregate.project.id, actorId: actor.userId, type, objectId, beforeSummary: before, afterSummary: after, occurredAt: now, revision });
    aggregate.facts.push({ eventId: this.deps.ids.next(), type, aggregateId: aggregate.project.id, projectId: aggregate.project.id, actorId: actor.userId, version: revision, occurredAt: now, payload: after });
  }
}
