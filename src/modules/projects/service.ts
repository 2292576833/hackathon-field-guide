import type { Actor, Clock, IdGenerator, ProjectMembershipAccess, ProjectRole } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AvailabilityWindowInput, Invitation, InvitationPreview, MemberAvailability, Project, ProjectAggregate, ProjectFactType, ProjectMember, ProjectResourceBookmark, ProjectStage, PublicInvitation, PublicSpaceInvitationPreview, TeamAggregate, TeamMember, TeamRole } from "./model.ts";
import type { AvailabilityValidationPort, InvitationTokenPort, ProjectAdmissionPort, ProjectsRepository, ProjectWorkflowPort, PublicInvitationDetailsPort, ReviewedResourcePort, VerifiedIdentityPort } from "./ports.ts";
import { assertKnownFields, emailField, idField, instantField, invalid, referenceUrl, revisionField, textField, timezoneField } from "./validation.ts";
import { consumeInvitation, invitationUsage } from "./invitation-usage.ts";

export interface CreateProjectInput {
  name: string;
  teamId?: string | null;
  eventId?: string | null;
  goal?: string;
  minimumDeliverable?: string;
  timezone: string;
  deadline?: string | null;
}

export interface EditProjectInput {
  expectedRevision: number;
  name?: string;
  goal?: string;
  minimumDeliverable?: string;
  timezone?: string;
  deadline?: string | null;
}

export interface InvitationInput {
  expectedRevision: number;
  role?: ProjectRole | TeamRole;
  invitedEmail?: string | null;
  expiresAt?: string;
  maxUses?: number;
}

export interface AvailabilityInput {
  expectedRevision: number;
  timezone: string;
  windows: AvailabilityWindowInput[];
}

export interface ManagementTransferInput {
  expectedRevision: number;
  targetUserId: string;
}

export interface BookmarkInput {
  expectedRevision: number;
  resourceId?: string;
  resourceVersion?: number;
  url?: string;
  title?: string;
  purposeNote: string;
}

export interface ProjectsServiceDependencies {
  repository: ProjectsRepository;
  clock: Clock;
  ids: IdGenerator;
  tokens: InvitationTokenPort;
  identity?: VerifiedIdentityPort;
  availabilityValidator?: AvailabilityValidationPort;
  workflow?: ProjectWorkflowPort;
  resources?: ReviewedResourcePort;
  admission?: ProjectAdmissionPort;
  publicInvitationDetails?: PublicInvitationDetailsPort;
}

const transitions: Record<ProjectStage, readonly ProjectStage[]> = {
  draft: ["preparing", "retrospective", "archived"],
  preparing: ["draft", "active", "retrospective", "archived"],
  active: ["finalizing", "retrospective", "archived"],
  finalizing: ["active", "submitted", "retrospective", "archived"],
  submitted: ["retrospective", "archived"],
  retrospective: ["preparing", "archived"],
  archived: ["draft", "preparing"],
};

function requireActor(actor: Actor): void {
  if (!actor || typeof actor.userId !== "string" || actor.userId.trim().length === 0) {
    throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
  }
}

function unavailable(): never {
  throw new DomainError("PROJECT_UNAVAILABLE", "项目不存在或你尚未加入该项目。", { status: 404 });
}

function requireMember(aggregate: ProjectAggregate, actor: Actor, manager = false): ProjectMember {
  requireActor(actor);
  const member = aggregate.members.find((item) => item.userId === actor.userId && item.status === "active");
  if (!member) unavailable();
  if (manager && member.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "请由项目管理员完成此操作。", { status: 403 });
  return member;
}

function requireTeamMember(aggregate: TeamAggregate, actor: Actor, captain = false): TeamMember {
  requireActor(actor);
  const member = aggregate.members.find((item) => item.userId === actor.userId && item.status === "active");
  if (!member) throw new DomainError("TEAM_UNAVAILABLE", "队伍不存在或你尚未加入该队伍。", { status: 404 });
  if (captain && member.role !== "captain") throw new DomainError("TEAM_CAPTAIN_REQUIRED", "请由队伍队长完成此操作。", { status: 403 });
  return member;
}

function expectRevision(current: number, expected: number): void {
  revisionField(expected);
  if (current !== expected) throw new DomainError("VERSION_CONFLICT", "内容已更新，请对照最新版本后重新保存。", { status: 409, recoveryAction: "review_latest_version", latestRevision: current });
}

function editable(aggregate: ProjectAggregate): void {
  if (aggregate.project.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "项目已归档，请先恢复项目。", { status: 409 });
}

function activeTeam(aggregate: TeamAggregate): void {
  if (aggregate.team.status !== "active") throw new DomainError("TEAM_DISSOLVED", "队伍已解散，原项目和成果仍保留。", { status: 409 });
}

function dependency(name: string): never {
  throw new DomainError("DEPENDENCY_UNAVAILABLE", `${name}暂未接入，当前内容仍已保留。`, { status: 503 });
}

function safeInvitation(invitation: Invitation, now: string): PublicInvitation {
  const { tokenHash: _tokenHash, acceptances: _acceptances, ...publicFields } = invitation;
  const { maxUses, usedUses, remainingUses } = invitationUsage(invitation);
  return { ...publicFields, maxUses, usedUses, remainingUses, displayStatus: invitation.status === "pending" && Date.parse(invitation.expiresAt) <= Date.parse(now) ? "expired" : invitation.status };
}

/** All changing decisions run after acquiring the repository's scope lock. */
export class ProjectsService {
  private readonly deps: ProjectsServiceDependencies;

  constructor(dependencies: ProjectsServiceDependencies) { this.deps = dependencies; }

  private now(): string { return this.deps.clock.now().toISOString(); }

  private bump(aggregate: ProjectAggregate, now: string): void {
    aggregate.project.revision += 1;
    aggregate.project.updatedAt = now;
  }

  private record(aggregate: ProjectAggregate, actor: Actor, type: string, objectId: string, before: Record<string, unknown>, after: Record<string, unknown>, now: string, factType?: ProjectFactType): string | null {
    aggregate.activities.push({ id: this.deps.ids.next(), projectId: aggregate.project.id, actorId: actor.userId, type, objectId, beforeSummary: before, afterSummary: after, occurredAt: now, revision: aggregate.project.revision });
    if (!factType) return null;
    const eventId = this.deps.ids.next();
    aggregate.facts.push({ eventId, type: factType, aggregateId: aggregate.project.id, projectId: aggregate.project.id, actorId: actor.userId, version: aggregate.project.revision, occurredAt: now, payload: { objectId, before, after } });
    return eventId;
  }

  async createProject(actor: Actor, input: CreateProjectInput): Promise<Project> {
    requireActor(actor);
    assertKnownFields(input, ["name", "teamId", "eventId", "goal", "minimumDeliverable", "timezone", "deadline"]);
    const now = this.now();
    const project: Project = {
      id: this.deps.ids.next(), name: textField(input.name, "项目名称", 120),
      teamId: input.teamId == null ? null : idField(input.teamId), eventId: input.eventId == null ? null : idField(input.eventId),
      createdBy: actor.userId, goal: textField(input.goal ?? "", "作品目标", 4000, true),
      minimumDeliverable: textField(input.minimumDeliverable ?? "", "最小交付物", 4000, true),
      stage: "draft", timezone: timezoneField(input.timezone), deadline: input.deadline == null ? null : instantField(input.deadline, "截止时间"),
      deadlineSource: input.deadline == null ? "unknown" : "member_entered", revision: 1, createdAt: now, updatedAt: now,
    };
    const aggregate: ProjectAggregate = { project, members: [{ membershipId: this.deps.ids.next(), projectId: project.id, userId: actor.userId, role: "manager", status: "active", revision: 1, joinedAt: now, leftAt: null }], invitations: [], availability: [], bookmarks: [], activities: [], facts: [] };
    this.record(aggregate, actor, "project_created", project.id, {}, { stage: "draft", teamId: project.teamId }, now, "ProjectCreated");
    if (project.teamId === null) await this.deps.repository.createProject(aggregate);
    else await this.deps.repository.withTeam(project.teamId, async (teamAggregate) => {
      requireTeamMember(teamAggregate, actor); activeTeam(teamAggregate);
      await this.deps.repository.createProject(aggregate);
    });
    return structuredClone(project);
  }

  async listProjects(actor: Actor): Promise<Project[]> {
    requireActor(actor);
    return this.deps.repository.listProjects(actor.userId);
  }

  async getProject(actor: Actor, projectId: string) {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      const membership = requireMember(aggregate, actor);
      return structuredClone({ project: aggregate.project, membership, members: aggregate.members.filter((item) => item.status === "active") });
    });
  }

  async getProjectMembers(actor: Actor, projectId: string, includeHistory = false) {
    requireActor(actor);
    if (typeof includeHistory !== "boolean") invalid("历史成员筛选必须是布尔值。");
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      const membership = requireMember(aggregate, actor);
      return structuredClone({ membership, projectRevision: aggregate.project.revision, members: aggregate.members.filter((member) => includeHistory || member.status === "active") });
    });
  }

  async editProject(actor: Actor, projectId: string, input: EditProjectInput): Promise<Project> {
    requireActor(actor);
    assertKnownFields(input, ["expectedRevision", "name", "goal", "minimumDeliverable", "timezone", "deadline"]);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true); editable(aggregate); expectRevision(aggregate.project.revision, input.expectedRevision);
      const before = structuredClone(aggregate.project);
      const project = aggregate.project;
      if (input.name !== undefined) project.name = textField(input.name, "项目名称", 120);
      if (input.goal !== undefined) project.goal = textField(input.goal, "作品目标", 4000, true);
      if (input.minimumDeliverable !== undefined) project.minimumDeliverable = textField(input.minimumDeliverable, "最小交付物", 4000, true);
      if (input.timezone !== undefined) project.timezone = timezoneField(input.timezone);
      if (input.deadline !== undefined) {
        project.deadline = input.deadline === null ? null : instantField(input.deadline, "截止时间");
        project.deadlineSource = input.deadline === null ? "unknown" : "member_entered";
      }
      if (project.stage !== "draft" && !project.goal) invalid("开始备赛后必须保留作品目标；如需重新整理，请先回到草稿阶段。");
      if (JSON.stringify(before) === JSON.stringify(project)) return structuredClone(project);
      const now = this.now(); this.bump(aggregate, now);
      this.record(aggregate, actor, "project_scope_changed", project.id, { name: before.name, goal: before.goal, minimumDeliverable: before.minimumDeliverable, eventId: before.eventId, deadline: before.deadline, timezone: before.timezone }, { name: project.name, goal: project.goal, minimumDeliverable: project.minimumDeliverable, eventId: project.eventId, deadline: project.deadline, timezone: project.timezone }, now, "ProjectScopeChanged");
      return structuredClone(project);
    });
  }

  async transitionStage(actor: Actor, projectId: string, input: { expectedRevision: number; stage: ProjectStage; reason: string }): Promise<Project> {
    requireActor(actor);
    assertKnownFields(input, ["expectedRevision", "stage", "reason"]);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true); expectRevision(aggregate.project.revision, input.expectedRevision);
      const reason = textField(input.reason, "阶段变更说明", 1000);
      const before = aggregate.project.stage;
      if (!Object.hasOwn(transitions, input.stage)) invalid("项目阶段无效。");
      if (before === input.stage) return structuredClone(aggregate.project);
      if (!transitions[before].includes(input.stage)) throw new DomainError("INVALID_STAGE_TRANSITION", "当前阶段不能直接进入所选阶段，请检查准备条件。", { status: 422 });
      if (input.stage === "preparing" && !aggregate.project.goal) invalid("请先填写作品目标，再开始备赛。");
      if (input.stage === "active") {
        if (!this.deps.workflow) dependency("计划依据");
        if (!await this.deps.workflow.hasConfirmedPlanOrManualTasks(projectId)) throw new DomainError("PROJECT_WORK_NOT_READY", "请先确认一份计划或建立手动任务。", { status: 422 });
      }
      if (input.stage === "submitted") {
        if (!this.deps.workflow) dependency("提交记录查询");
        if (!await this.deps.workflow.hasSubmissionRecord(projectId)) throw new DomainError("SUBMISSION_RECORD_REQUIRED", "请先记录赛事正式提交，并标明记录来源。", { status: 422 });
      }
      const now = this.now(); aggregate.project.stage = input.stage; this.bump(aggregate, now);
      this.record(aggregate, actor, "project_stage_changed", projectId, { stage: before }, { stage: input.stage, reason, recheckDeadlineAndAuthorization: before === "archived" }, now, "ProjectStageChanged");
      return structuredClone(aggregate.project);
    });
  }

  async associateTeam(actor: Actor, projectId: string, input: { expectedRevision: number; teamId: string | null; confirmNoAutomaticMembers: true }): Promise<Project> {
    requireActor(actor); assertKnownFields(input, ["expectedRevision", "teamId", "confirmNoAutomaticMembers"]);
    if (input.confirmNoAutomaticMembers !== true) invalid("请确认关联队伍不会自动邀请或公开项目给队伍其他成员。");
    const change = () => this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true); editable(aggregate); expectRevision(aggregate.project.revision, input.expectedRevision);
      const teamId = input.teamId === null ? null : idField(input.teamId);
      if (aggregate.project.teamId === teamId) return structuredClone(aggregate.project);
      const before = aggregate.project.teamId; aggregate.project.teamId = teamId;
      const now = this.now(); this.bump(aggregate, now);
      this.record(aggregate, actor, "project_team_associated", projectId, { teamId: before }, { teamId, automaticMembersAdded: false }, now, "ProjectScopeChanged");
      return structuredClone(aggregate.project);
    });
    if (input.teamId === null) return change();
    return this.deps.repository.withTeam(idField(input.teamId), async (teamAggregate) => {
      requireTeamMember(teamAggregate, actor); activeTeam(teamAggregate);
      return change();
    });
  }

  async cloneProject(actor: Actor, projectId: string, input: { name: string; copyGoal?: boolean; copyMinimumDeliverable?: boolean }): Promise<Project> {
    requireActor(actor);
    assertKnownFields(input, ["name", "copyGoal", "copyMinimumDeliverable"]);
    if (input.copyGoal !== undefined && typeof input.copyGoal !== "boolean" || input.copyMinimumDeliverable !== undefined && typeof input.copyMinimumDeliverable !== "boolean") invalid("复制选项必须是布尔值。");
    const source = await this.getProject(actor, projectId);
    return this.createProject(actor, { name: input.name, timezone: source.project.timezone, goal: input.copyGoal ? source.project.goal : "", minimumDeliverable: input.copyMinimumDeliverable ? source.project.minimumDeliverable : "" });
  }

  private makeInvitation(actor: Actor, scopeType: "project" | "team", scopeId: string, input: InvitationInput, now: string) {
    assertKnownFields(input, ["expectedRevision", "role", "invitedEmail", "expiresAt", "maxUses"]);
    const roles = scopeType === "project" ? ["manager", "member"] : ["captain", "member"];
    const role = input.role ?? "member";
    if (!roles.includes(role)) invalid("邀请角色不属于这个范围。");
    const maxUses = input.maxUses ?? 1;
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 50) invalid("邀请名额必须是 1 至 50 的整数。");
    const expiresAt = input.expiresAt === undefined ? new Date(Date.parse(now) + 72 * 60 * 60 * 1000).toISOString() : instantField(input.expiresAt, "邀请到期时间");
    if (Date.parse(expiresAt) <= Date.parse(now) || Date.parse(expiresAt) > Date.parse(now) + 30 * 24 * 60 * 60 * 1000) invalid("邀请有效期应在未来 30 天内。");
    const issued = this.deps.tokens.issue();
    const invitation: Invitation = { id: this.deps.ids.next(), scopeType, scopeId, tokenHash: issued.tokenHash, role, invitedEmail: input.invitedEmail == null ? null : emailField(input.invitedEmail), createdBy: actor.userId, createdAt: now, expiresAt, status: "pending", acceptedBy: null, acceptedAt: null, revokedAt: null, revision: 1, maxUses, usedUses: 0, acceptances: [] };
    return { invitation, token: issued.token };
  }

  async createProjectInvitation(actor: Actor, projectId: string, input: InvitationInput) {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true); editable(aggregate); expectRevision(aggregate.project.revision, input.expectedRevision);
      const now = this.now(); const issued = this.makeInvitation(actor, "project", projectId, input, now);
      aggregate.invitations.push(issued.invitation); this.bump(aggregate, now);
      this.record(aggregate, actor, "invitation_created", issued.invitation.id, {}, { role: issued.invitation.role, expiresAt: issued.invitation.expiresAt, maxUses: issued.invitation.maxUses }, now);
      return { invitation: safeInvitation(issued.invitation, now), token: issued.token, projectRevision: aggregate.project.revision };
    });
  }

  async listProjectInvitations(actor: Actor, projectId: string): Promise<PublicInvitation[]> {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true);
      return aggregate.invitations.map((item) => safeInvitation(item, this.now()));
    });
  }

  async revokeProjectInvitation(actor: Actor, projectId: string, invitationId: string, expectedRevision: number) {
    requireActor(actor); idField(invitationId);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true); editable(aggregate); expectRevision(aggregate.project.revision, expectedRevision);
      const invitation = aggregate.invitations.find((item) => item.id === invitationId);
      if (!invitation) throw new DomainError("INVITATION_UNAVAILABLE", "此项目没有该邀请。", { status: 404 });
      if (invitation.status === "accepted") throw new DomainError("INVITATION_ALREADY_USED", "邀请已接受；如需移除成员，请使用成员管理。", { status: 409 });
      if (invitation.status === "pending") {
        const now = this.now(); invitation.status = "revoked"; invitation.revokedAt = now; invitation.revision += 1; this.bump(aggregate, now);
        this.record(aggregate, actor, "invitation_revoked", invitation.id, { status: "pending" }, { status: "revoked" }, now);
      }
      return { invitation: safeInvitation(invitation, this.now()), projectRevision: aggregate.project.revision };
    });
  }

  private async checkInvitationIdentity(actor: Actor, invitation: Invitation): Promise<void> {
    if (invitation.invitedEmail === null) return;
    if (!this.deps.identity) dependency("已验证邮箱查询");
    const email = await this.deps.identity.getVerifiedEmail(actor.userId);
    if (email === null || email.toLowerCase() !== invitation.invitedEmail) throw new DomainError("INVITATION_IDENTITY_MISMATCH", "请用收到邀请的已验证邮箱登录。", { status: 403 });
  }

  private invitationForAcceptance(invitations: Invitation[], hash: string, actor: Actor, now: string, alreadyMember = false): Invitation {
    const invitation = invitations.find((item) => item.tokenHash === hash);
    if (!invitation) throw new DomainError("INVITATION_UNAVAILABLE", "邀请不存在或已撤销，请索取新链接。", { status: 404 });
    const usage = invitationUsage(invitation);
    // Current membership grants entry to one's own space, independent of the old invitation's
    // admission state. Returning this snapshot never restores or consumes an invitation.
    // Historical consumers are passed to callers only so a departure cannot be mistaken for a new join.
    if (alreadyMember || usage.acceptances.some(item => item.userId === actor.userId)) return invitation;
    if (invitation.status === "revoked") throw new DomainError("INVITATION_UNAVAILABLE", "邀请不存在或已撤销，请索取新链接。", { status: 404 });
    if (usage.remainingUses === 0 && !alreadyMember) throw new DomainError("INVITATION_ALREADY_USED", "邀请名额已用完，请索取新的邀请。", { status: 409 });
    if (Date.parse(invitation.expiresAt) <= Date.parse(now)) throw new DomainError("INVITATION_EXPIRED", "邀请已过期，请索取新的邀请。", { status: 409 });
    return invitation;
  }

  /** Anonymous, read-only landing preview. It grants no project access or invitation consumption. */
  async previewPublicSpaceInvitation(token: string): Promise<PublicSpaceInvitationPreview> {
    const hash = this.deps.tokens.hash(token);
    const scope = await this.deps.repository.findInvitationByHash(hash);
    const unavailable = (status: PublicSpaceInvitationPreview["status"]): PublicSpaceInvitationPreview => ({ status, scopeType: null, scopeName: null, eventName: null, inviterDisplayName: null, requestedRole: null, expiresAt: null, maxUses: null, usedUses: null, remainingUses: null });
    if (!scope) return unavailable("unavailable");
    const preview = async (invitation: Invitation | undefined, scopeName: string, active: boolean, executor?: SqlExecutor, project?: Project): Promise<PublicSpaceInvitationPreview> => {
      if (!invitation) return unavailable("unavailable");
      const { maxUses, usedUses, remainingUses } = invitationUsage(invitation);
      if (invitation.status === "revoked") return unavailable("revoked");
      if (remainingUses === 0) return { ...unavailable("used"), maxUses, usedUses, remainingUses };
      if (Date.parse(invitation.expiresAt) <= Date.parse(this.now())) return unavailable("expired");
      if (!active) return unavailable("unavailable");
      const details = this.deps.publicInvitationDetails;
      const eventName = details && project ? await details.getPublicEventName({ projectId: project.id, initialEventId: project.eventId }, executor) : null;
      const inviterDisplayName = details ? await details.getPublicDisplayName(invitation.createdBy, executor) : null;
      return {
        status: "pending", scopeType: scope.scopeType, scopeName,
        eventName: eventName === null ? null : textField(eventName, "公开比赛名称", 300),
        inviterDisplayName: inviterDisplayName === null ? null : textField(inviterDisplayName, "公开邀请者名称", 120),
        requestedRole: invitation.role, expiresAt: invitation.expiresAt, maxUses, usedUses, remainingUses,
      };
    };
    if (scope.scopeType === "team") return this.deps.repository.withTeam(scope.scopeId, aggregate => preview(aggregate.invitations.find(item => item.tokenHash === hash), aggregate.team.name, aggregate.team.status === "active"));
    return this.deps.repository.withProject(scope.scopeId, async (aggregate, executor) => {
      const invitation = aggregate.invitations.find(item => item.tokenHash === hash);
      return preview(invitation, aggregate.project.name, aggregate.project.stage !== "archived", executor, aggregate.project);
    });
  }

  async previewInvitation(actor: Actor, token: string): Promise<InvitationPreview> {
    requireActor(actor);
    const hash = this.deps.tokens.hash(token);
    const scope = await this.deps.repository.findInvitationByHash(hash);
    if (!scope) throw new DomainError("INVITATION_UNAVAILABLE", "邀请不存在或已失效，请索取新链接。", { status: 404 });
    const preview = async (invitations: Invitation[], members: readonly (ProjectMember | TeamMember)[], scopeName: string): Promise<InvitationPreview> => {
      const member = members.find((item) => item.userId === actor.userId && item.status === "active");
      const invitation = this.invitationForAcceptance(invitations, hash, actor, this.now(), member !== undefined);
      const consumed = invitationUsage(invitation).acceptances.some(item => item.userId === actor.userId);
      if (consumed && !member) throw new DomainError("INVITATION_ALREADY_USED", "你已离开，原邀请不能再次加入；请索取新的邀请。", { status: 409 });
      if (!member) await this.checkInvitationIdentity(actor, invitation);
      const { maxUses, usedUses, remainingUses } = invitationUsage(invitation);
      return { scopeType: scope.scopeType, scopeId: scope.scopeId, scopeName, requestedRole: invitation.role, currentRole: member?.role ?? null, expiresAt: invitation.expiresAt, alreadyMember: member !== undefined, alreadyAccepted: consumed, maxUses, usedUses, remainingUses };
    };
    if (scope.scopeType === "team") return this.deps.repository.withTeam(scope.scopeId, async (aggregate) => {
      const result = await preview(aggregate.invitations, aggregate.members, aggregate.team.name);
      if (!result.alreadyMember) activeTeam(aggregate);
      return result;
    });
    return this.deps.repository.withProject(scope.scopeId, async (aggregate) => {
      const result = await preview(aggregate.invitations, aggregate.members, aggregate.project.name);
      if (!result.alreadyMember) editable(aggregate);
      return result;
    });
  }

  async acceptInvitation(actor: Actor, token: string) {
    requireActor(actor);
    const hash = this.deps.tokens.hash(token);
    const scope = await this.deps.repository.findInvitationByHash(hash);
    if (!scope) throw new DomainError("INVITATION_UNAVAILABLE", "邀请不存在或已失效，请索取新链接。", { status: 404 });
    if (scope.scopeType === "team") return this.acceptTeamInvitation(actor, scope.scopeId, hash);
    return this.deps.repository.withProject(scope.scopeId, async (aggregate) => {
      const existing = aggregate.members.find((item) => item.userId === actor.userId);
      const alreadyActive = existing?.status === "active";
      const now = this.now(); const invitation = this.invitationForAcceptance(aggregate.invitations, hash, actor, now, alreadyActive);
      const consumed = invitationUsage(invitation).acceptances.some(item => item.userId === actor.userId);
      if (alreadyActive) return { scopeType: "project" as const, scopeId: scope.scopeId, membership: structuredClone(existing!), revision: aggregate.project.revision, alreadyAccepted: true };
      if (consumed) {
        throw new DomainError("INVITATION_ALREADY_USED", "你已离开该项目，原邀请不能再次加入；请索取新的邀请。", { status: 409 });
      }
      editable(aggregate); await this.checkInvitationIdentity(actor, invitation);
      if (this.deps.admission && existing?.status !== "active") await this.deps.admission.check({ actor, project: aggregate.project, activeUserIds: aggregate.members.filter((item) => item.status === "active").map((item) => item.userId), invitation });
      let member: ProjectMember;
      if (existing?.status === "active") {
        // An invitation is not a hidden role-change endpoint for existing members.
        member = existing;
      } else {
        member = existing ?? { membershipId: this.deps.ids.next(), projectId: scope.scopeId, userId: actor.userId, role: invitation.role as ProjectRole, status: "active", revision: 0, joinedAt: now, leftAt: null };
        member.role = invitation.role as ProjectRole; member.status = "active"; member.joinedAt = now; member.leftAt = null; member.revision += 1;
        if (!existing) aggregate.members.push(member);
      }
      consumeInvitation(invitation, actor.userId, member.membershipId, now);
      this.bump(aggregate, now);
      this.record(aggregate, actor, "invitation_accepted", invitation.id, {}, { userId: actor.userId, membershipId: member.membershipId, role: member.role, alreadyMember: alreadyActive }, now, alreadyActive ? undefined : "ProjectMemberJoined");
      return { scopeType: "project" as const, scopeId: scope.scopeId, membership: structuredClone(member), revision: aggregate.project.revision, alreadyAccepted: false };
    });
  }

  async changeProjectRole(actor: Actor, projectId: string, userId: string, input: { expectedRevision: number; role: ProjectRole }) {
    requireActor(actor); idField(userId); assertKnownFields(input, ["expectedRevision", "role"]);
    if (!["manager", "member"].includes(input.role)) invalid("项目角色无效。");
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, true); editable(aggregate); expectRevision(aggregate.project.revision, input.expectedRevision);
      const member = aggregate.members.find((item) => item.userId === userId && item.status === "active");
      if (!member) throw new DomainError("MEMBER_UNAVAILABLE", "该成员已离开或不存在。", { status: 404 });
      if (member.role === input.role) return { membership: structuredClone(member), projectRevision: aggregate.project.revision };
      this.protectLastManager(aggregate, member);
      const now = this.now(); this.bump(aggregate, now);
      this.setProjectRole(aggregate, actor, member, input.role, now);
      return { membership: structuredClone(member), projectRevision: aggregate.project.revision, availabilityConfirmationRequired: true };
    });
  }

  private setProjectRole(aggregate: ProjectAggregate, actor: Actor, member: ProjectMember, role: ProjectRole, now: string): void {
    if (member.role === role) return;
    const before = member.role; member.role = role; member.revision += 1;
    this.record(aggregate, actor, "project_member_role_changed", member.membershipId, { userId: member.userId, role: before }, { userId: member.userId, role, availabilityConfirmationRequired: true }, now, "ProjectMemberRoleChanged");
    const availability = aggregate.availability.find((item) => item.userId === member.userId);
    if (availability) this.record(aggregate, actor, "availability_confirmation_invalidated", availability.id, { userId: member.userId, availabilityRevision: availability.revision, membershipRevision: availability.membershipRevision }, { userId: member.userId, availabilityRevision: availability.revision, membershipRevision: member.revision, confirmationRequired: true, reason: "membership_revision_changed" }, now, "MemberAvailabilityChanged");
  }

  async transferProjectManagement(actor: Actor, projectId: string, input: ManagementTransferInput) {
    requireActor(actor); assertKnownFields(input, ["expectedRevision", "targetUserId"]);
    const targetUserId = idField(input.targetUserId);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      const previousManager = requireMember(aggregate, actor, true);
      expectRevision(aggregate.project.revision, input.expectedRevision);
      if (targetUserId === actor.userId) invalid("请选择另一位活跃项目成员接管管理权。");
      const targetManager = aggregate.members.find((member) => member.userId === targetUserId && member.status === "active");
      if (!targetManager) throw new DomainError("MEMBER_UNAVAILABLE", "接管人须是该项目的活跃成员。", { status: 404 });
      const targetWasManager = targetManager.role === "manager";
      const now = this.now(); this.bump(aggregate, now);
      // Promotion and demotion share one project lock and commit. Archived history is preserved.
      this.setProjectRole(aggregate, actor, targetManager, "manager", now);
      this.protectLastManager(aggregate, previousManager);
      this.setProjectRole(aggregate, actor, previousManager, "member", now);
      this.record(aggregate, actor, "project_management_transferred", projectId, { fromUserId: actor.userId, targetUserId, targetWasManager }, { fromUserId: actor.userId, targetUserId, actorRemainsMember: true, otherManagersUnchanged: true }, now);
      return structuredClone({ projectRevision: aggregate.project.revision, previousManager, targetManager, availabilityConfirmationRequiredUserIds: targetWasManager ? [actor.userId] : [actor.userId, targetUserId], otherManagersUnchanged: true });
    });
  }

  private protectLastManager(aggregate: ProjectAggregate, member: ProjectMember): void {
    if (member.role === "manager" && aggregate.members.filter((item) => item.status === "active" && item.role === "manager").length <= 1) {
      throw new DomainError("LAST_PROJECT_MANAGER", "请先将另一位活跃成员设为管理员，再退出、移除或降级。", { status: 409, recoveryAction: "transfer_project_management" });
    }
  }

  async leaveProject(actor: Actor, projectId: string, expectedRevision: number) {
    requireActor(actor);
    return this.departProject(actor, projectId, actor.userId, expectedRevision, "left");
  }

  async removeProjectMember(actor: Actor, projectId: string, userId: string, expectedRevision: number) {
    return this.departProject(actor, projectId, userId, expectedRevision, "removed");
  }

  private async departProject(actor: Actor, projectId: string, userId: string, expectedRevision: number, status: "left" | "removed") {
    requireActor(actor); idField(userId);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor, status === "removed"); expectRevision(aggregate.project.revision, expectedRevision);
      const member = aggregate.members.find((item) => item.userId === userId && item.status === "active");
      if (!member) throw new DomainError("MEMBER_UNAVAILABLE", "该成员已离开或不存在。", { status: 404 });
      this.protectLastManager(aggregate, member);
      const now = this.now(); member.status = status; member.leftAt = now; member.revision += 1; this.bump(aggregate, now);
      const changeFactId = this.record(aggregate, actor, "project_member_left", member.membershipId, { userId, status: "active" }, { userId, status, unfinishedTasksNeedReassignment: true, preserveCompletedWork: true, invalidateAvailability: true }, now, "ProjectMemberLeft");
      return { membership: structuredClone(member), projectRevision: aggregate.project.revision, changeFactId, taskReassignmentPending: true, planReviewRequired: true };
    });
  }

  async getAvailability(actor: Actor, projectId: string): Promise<MemberAvailability[]> {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor);
      return structuredClone(aggregate.availability.filter((item) => aggregate.members.some((member) => member.status === "active" && member.userId === item.userId && member.revision === item.membershipRevision)));
    });
  }

  async getMyAvailability(actor: Actor, projectId: string) {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      const membership = requireMember(aggregate, actor);
      const availability = aggregate.availability.find((item) => item.userId === actor.userId) ?? null;
      // The owner can load the previous revision to edit/reconfirm it, even after rejoining.
      return structuredClone({ availability, confirmationRequired: availability === null || availability.membershipRevision !== membership.revision });
    });
  }

  async updateMyAvailability(actor: Actor, projectId: string, input: AvailabilityInput) {
    requireActor(actor); assertKnownFields(input, ["expectedRevision", "timezone", "windows"]);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      const membership = requireMember(aggregate, actor); editable(aggregate);
      const previous = aggregate.availability.find((item) => item.userId === actor.userId) ?? null;
      const expectedRevision = revisionField(input.expectedRevision, true);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "可用时间已更新，请查看最新版本后保存。", { status: 409, recoveryAction: "review_latest_version", latestRevision: previous?.revision ?? 0 });
      const timezone = timezoneField(input.timezone);
      if (!Array.isArray(input.windows) || input.windows.length > 100) invalid("可用时间窗口必须是最多 100 项的列表。");
      const ids = new Set<string>();
      const windows = input.windows.map((item) => {
        assertKnownFields(item, ["id", "startsAt", "endsAt", "effectiveMinutes"]);
        const id = idField(item.id, "窗口 ID"); if (ids.has(id)) invalid("可用时间窗口 ID 不能重复。"); ids.add(id);
        if (typeof item.effectiveMinutes !== "number" || !Number.isFinite(item.effectiveMinutes) || item.effectiveMinutes < 0) invalid("有效时间必须是非负分钟数。");
        instantField(item.startsAt, "窗口开始时间"); instantField(item.endsAt, "窗口结束时间");
        // Preserve the offset-bearing local input until M05 checks it against the IANA zone.
        return { id, startsAt: item.startsAt, endsAt: item.endsAt, effectiveMinutes: item.effectiveMinutes };
      });
      if (!this.deps.availabilityValidator) dependency("可用时间校验");
      const nextRevision = (previous?.revision ?? 0) + 1;
      const validated = await this.deps.availabilityValidator.validate({ projectId, userId: actor.userId, timezone, windows, nextRevision, previous: previous ? structuredClone(previous) : null });
      if (!Number.isFinite(validated.effectiveMinutes) || validated.effectiveMinutes < 0 || validated.windows.some((item) => item.revision !== nextRevision)) throw new DomainError("INVALID_AVAILABILITY_RESULT", "可用时间校验结果无效，请稍后重试。", { status: 503 });
      const now = this.now();
      const canonicalWindows = validated.windows.map(item => ({ ...item, startsAt: instantField(item.startsAt, "窗口开始时间"), endsAt: instantField(item.endsAt, "窗口结束时间") }));
      const availability: MemberAvailability = { id: previous?.id ?? this.deps.ids.next(), projectId, userId: actor.userId, timezone, windows: canonicalWindows, effectiveMinutes: validated.effectiveMinutes, confirmedAt: now, revision: nextRevision, membershipRevision: membership.revision };
      if (previous) aggregate.availability[aggregate.availability.indexOf(previous)] = availability; else aggregate.availability.push(availability);
      this.bump(aggregate, now);
      const changeFactId = this.record(aggregate, actor, "member_availability_changed", availability.id, { userId: actor.userId, availabilityRevision: previous?.revision ?? 0 }, { userId: actor.userId, availabilityRevision: nextRevision }, now, "MemberAvailabilityChanged");
      return { availability: structuredClone(availability), projectRevision: aggregate.project.revision, changeFactId, planReviewRequired: true };
    });
  }

  async listResources(actor: Actor, projectId: string): Promise<ProjectResourceBookmark[]> {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor); return structuredClone(aggregate.bookmarks.filter((item) => item.status === "active"));
    });
  }

  async addResource(actor: Actor, projectId: string, input: BookmarkInput) {
    requireActor(actor); assertKnownFields(input, ["expectedRevision", "resourceId", "resourceVersion", "url", "title", "purposeNote"]);
    return this.deps.repository.withProject(idField(projectId), async (aggregate, transaction) => {
      requireMember(aggregate, actor); editable(aggregate); expectRevision(aggregate.project.revision, input.expectedRevision);
      return this.saveResource(actor, aggregate, input, transaction);
    });
  }

  /** M09's explicit share command. Scope lock precedes the publication lock; caller-supplied
   * title/URL are never treated as reviewed facts. Repeated project+resource+version is idempotent.
   */
  async addReviewedResource(actor: Actor, input: { projectId: string; resourceId: string; resourceVersion: number; title: string; url: string; purposeNote: string }): Promise<{ id: string; projectId: string }> {
    requireActor(actor); idField(input.resourceId); revisionField(input.resourceVersion);
    return this.deps.repository.withProject(idField(input.projectId), async (aggregate, transaction) => {
      requireMember(aggregate, actor); editable(aggregate);
      const saved = await this.saveResource(actor, aggregate, { resourceId: input.resourceId, resourceVersion: input.resourceVersion, purposeNote: input.purposeNote }, transaction);
      return { id: saved.bookmark.id, projectId: aggregate.project.id };
    });
  }

  private async saveResource(actor: Actor, aggregate: ProjectAggregate, input: Omit<BookmarkInput, "expectedRevision">, transaction?: SqlExecutor) {
      const projectId = aggregate.project.id;
      if ((input.resourceId === undefined) === (input.url === undefined)) invalid("请选择一个审核资源，或填写一个成员参考链接。");
      const resourceId = input.resourceId === undefined ? null : idField(input.resourceId);
      const url = input.url === undefined ? null : referenceUrl(input.url);
      const purposeNote = textField(input.purposeNote, "用途备注", 2000, true);
      let title: string;
      let resourceVersion: number | null = null;
      if (resourceId) {
        if (!this.deps.resources) dependency("审核资源查询");
        const expectedVersion = input.resourceVersion === undefined ? undefined : revisionField(input.resourceVersion);
        const resource = await this.deps.resources.getReviewedResource(resourceId, transaction, expectedVersion);
        if (!resource || resource.id !== resourceId) throw new DomainError("RESOURCE_NOT_REVIEWED", "资源尚未审核发布或已下架，请重新选择。", { status: 422 });
        resourceVersion = revisionField(resource.version);
        if (expectedVersion !== undefined && resourceVersion !== expectedVersion) throw new DomainError("RESOURCE_REFS_UNAVAILABLE", "资源版本已更新，请查看最新内容后重新共享。", { status: 409, recoveryAction: "refresh_resource_refs" });
        title = textField(resource.title, "资源名称", 200);
      } else {
        if (input.resourceVersion !== undefined) invalid("成员参考链接不能声明审核资源版本。");
        title = textField(input.title, "资料标题", 200);
      }
      const existing = aggregate.bookmarks.find((item) => resourceId !== null ? item.resourceId === resourceId : item.url === url);
      if (existing?.status === "active" && existing.resourceVersion === resourceVersion) return { bookmark: structuredClone(existing), projectRevision: aggregate.project.revision, alreadySaved: true };
      const now = this.now();
      const bookmark: ProjectResourceBookmark = existing ?? { id: this.deps.ids.next(), projectId, resourceId, resourceVersion, url, title, purposeNote, savedBy: actor.userId, savedAt: now, status: "active", sourceStatus: resourceId ? "reviewed_resource" : "member_reference_unverified", revision: 0 };
      bookmark.resourceVersion = resourceVersion;
      bookmark.title = title; bookmark.purposeNote = purposeNote; bookmark.savedBy = actor.userId; bookmark.savedAt = now; bookmark.status = "active"; bookmark.revision += 1;
      if (!existing) aggregate.bookmarks.push(bookmark);
      this.bump(aggregate, now); this.record(aggregate, actor, "project_resource_bookmarked", bookmark.id, {}, { resourceId, resourceVersion, sourceStatus: bookmark.sourceStatus }, now, "ProjectResourceBookmarked");
      return { bookmark: structuredClone(bookmark), projectRevision: aggregate.project.revision, alreadySaved: false };
  }

  async removeResource(actor: Actor, projectId: string, bookmarkId: string, expectedRevision: number) {
    requireActor(actor); idField(bookmarkId);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      const membership = requireMember(aggregate, actor); editable(aggregate); expectRevision(aggregate.project.revision, expectedRevision);
      const bookmark = aggregate.bookmarks.find((item) => item.id === bookmarkId);
      if (!bookmark) throw new DomainError("BOOKMARK_UNAVAILABLE", "项目资料不存在。", { status: 404 });
      if (membership.role !== "manager" && bookmark.savedBy !== actor.userId) throw new DomainError("BOOKMARK_OWNER_REQUIRED", "只有收藏者或项目管理员可以移除此条项目资料。", { status: 403 });
      if (bookmark.status === "active") {
        const now = this.now(); bookmark.status = "removed"; bookmark.revision += 1; this.bump(aggregate, now);
        this.record(aggregate, actor, "project_resource_removed", bookmark.id, { status: "active" }, { status: "removed", resourceId: bookmark.resourceId }, now);
      }
      return { projectRevision: aggregate.project.revision };
    });
  }

  async getActivity(actor: Actor, projectId: string, limit = 50) {
    requireActor(actor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid("活动条数必须为 1 至 100。");
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor); return this.deps.repository.listActivities(projectId, limit);
    });
  }

  /** Useful for M04/M05 input snapshots; includes no private assessments or identity emails. */
  async getPlanningContext(actor: Actor, projectId: string) {
    requireActor(actor);
    return this.deps.repository.withProject(idField(projectId), async (aggregate) => {
      requireMember(aggregate, actor);
      const members = aggregate.members.filter((item) => item.status === "active");
      return structuredClone({ project: aggregate.project, members, availability: aggregate.availability.filter((item) => members.some((member) => member.userId === item.userId && member.revision === item.membershipRevision)) });
    });
  }

  async createTeam(actor: Actor, input: { name: string }) {
    requireActor(actor); assertKnownFields(input, ["name"]); const now = this.now();
    const team = { id: this.deps.ids.next(), name: textField(input.name, "队伍名称", 120), createdBy: actor.userId, status: "active" as const, revision: 1, createdAt: now, updatedAt: now };
    await this.deps.repository.createTeam({ team, members: [{ membershipId: this.deps.ids.next(), teamId: team.id, userId: actor.userId, role: "captain", status: "active", revision: 1, joinedAt: now, leftAt: null }], invitations: [] });
    return team;
  }

  async listTeams(actor: Actor) { requireActor(actor); return this.deps.repository.listTeams(actor.userId); }

  async getTeam(actor: Actor, teamId: string) {
    requireActor(actor);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      const membership = requireTeamMember(aggregate, actor);
      // This list is filtered by the actor's ProjectMembership even for a captain.
      const projects = (await this.deps.repository.listProjects(actor.userId)).filter((item) => item.teamId === teamId);
      return structuredClone({ team: aggregate.team, membership, members: aggregate.members.filter((item) => item.status === "active"), projects });
    });
  }

  async getTeamMembers(actor: Actor, teamId: string, includeHistory = false) {
    requireActor(actor);
    if (typeof includeHistory !== "boolean") invalid("历史成员筛选必须是布尔值。");
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      const membership = requireTeamMember(aggregate, actor);
      return structuredClone({ membership, teamRevision: aggregate.team.revision, members: aggregate.members.filter((member) => includeHistory || member.status === "active") });
    });
  }

  async editTeam(actor: Actor, teamId: string, input: { expectedRevision: number; name: string }) {
    requireActor(actor); assertKnownFields(input, ["expectedRevision", "name"]);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, true); activeTeam(aggregate); expectRevision(aggregate.team.revision, input.expectedRevision);
      const name = textField(input.name, "队伍名称", 120);
      if (aggregate.team.name !== name) { aggregate.team.name = name; aggregate.team.revision += 1; aggregate.team.updatedAt = this.now(); }
      return structuredClone(aggregate.team);
    });
  }

  async createTeamInvitation(actor: Actor, teamId: string, input: InvitationInput) {
    requireActor(actor);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, true); activeTeam(aggregate); expectRevision(aggregate.team.revision, input.expectedRevision);
      const now = this.now(); const issued = this.makeInvitation(actor, "team", teamId, input, now);
      aggregate.invitations.push(issued.invitation); aggregate.team.revision += 1; aggregate.team.updatedAt = now;
      return { invitation: safeInvitation(issued.invitation, now), token: issued.token, teamRevision: aggregate.team.revision };
    });
  }

  async listTeamInvitations(actor: Actor, teamId: string) {
    requireActor(actor);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, true); return aggregate.invitations.map((item) => safeInvitation(item, this.now()));
    });
  }

  async revokeTeamInvitation(actor: Actor, teamId: string, invitationId: string, expectedRevision: number) {
    requireActor(actor); idField(invitationId);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, true); expectRevision(aggregate.team.revision, expectedRevision);
      const invitation = aggregate.invitations.find((item) => item.id === invitationId);
      if (!invitation) throw new DomainError("INVITATION_UNAVAILABLE", "此队伍没有该邀请。", { status: 404 });
      if (invitation.status === "accepted") throw new DomainError("INVITATION_ALREADY_USED", "邀请已接受；如需移除成员，请使用成员管理。", { status: 409 });
      if (invitation.status === "pending") { const now = this.now(); invitation.status = "revoked"; invitation.revokedAt = now; invitation.revision += 1; aggregate.team.revision += 1; aggregate.team.updatedAt = now; }
      return { invitation: safeInvitation(invitation, this.now()), teamRevision: aggregate.team.revision };
    });
  }

  private async acceptTeamInvitation(actor: Actor, teamId: string, hash: string) {
    return this.deps.repository.withTeam(teamId, async (aggregate) => {
      const existing = aggregate.members.find((item) => item.userId === actor.userId);
      const now = this.now(); const invitation = this.invitationForAcceptance(aggregate.invitations, hash, actor, now, existing?.status === "active");
      if (existing?.status === "active") return { scopeType: "team" as const, scopeId: teamId, membership: structuredClone(existing), revision: aggregate.team.revision, alreadyAccepted: true };
      if (invitationUsage(invitation).acceptances.some(item => item.userId === actor.userId)) {
        throw new DomainError("INVITATION_ALREADY_USED", "你已离开队伍，原邀请不能再次加入。", { status: 409 });
      }
      activeTeam(aggregate); await this.checkInvitationIdentity(actor, invitation);
      const member = existing ?? { membershipId: this.deps.ids.next(), teamId, userId: actor.userId, role: invitation.role as TeamRole, status: "active" as const, revision: 0, joinedAt: now, leftAt: null };
      member.role = invitation.role as TeamRole; member.status = "active"; member.joinedAt = now; member.leftAt = null; member.revision += 1;
      if (!existing) aggregate.members.push(member);
      consumeInvitation(invitation, actor.userId, member.membershipId, now); aggregate.team.revision += 1; aggregate.team.updatedAt = now;
      return { scopeType: "team" as const, scopeId: teamId, membership: structuredClone(member), revision: aggregate.team.revision, alreadyAccepted: false };
    });
  }

  async changeTeamRole(actor: Actor, teamId: string, userId: string, input: { expectedRevision: number; role: TeamRole }) {
    requireActor(actor); idField(userId); assertKnownFields(input, ["expectedRevision", "role"]);
    if (!["captain", "member"].includes(input.role)) invalid("队伍角色无效。");
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, true); activeTeam(aggregate); expectRevision(aggregate.team.revision, input.expectedRevision);
      const member = aggregate.members.find((item) => item.userId === userId && item.status === "active");
      if (!member) throw new DomainError("MEMBER_UNAVAILABLE", "该队伍成员不存在或已离开。", { status: 404 });
      if (member.role === input.role) return { membership: structuredClone(member), teamRevision: aggregate.team.revision };
      this.protectLastCaptain(aggregate, member); member.role = input.role; member.revision += 1; aggregate.team.revision += 1; aggregate.team.updatedAt = this.now();
      return { membership: structuredClone(member), teamRevision: aggregate.team.revision };
    });
  }

  async transferTeamCaptain(actor: Actor, teamId: string, input: ManagementTransferInput) {
    requireActor(actor); assertKnownFields(input, ["expectedRevision", "targetUserId"]);
    const targetUserId = idField(input.targetUserId);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      const previousCaptain = requireTeamMember(aggregate, actor, true);
      activeTeam(aggregate); expectRevision(aggregate.team.revision, input.expectedRevision);
      if (targetUserId === actor.userId) invalid("请选择另一位活跃队伍成员接管队长职责。");
      const targetCaptain = aggregate.members.find((member) => member.userId === targetUserId && member.status === "active");
      if (!targetCaptain) throw new DomainError("MEMBER_UNAVAILABLE", "接管人须是该队伍的活跃成员。", { status: 404 });
      if (targetCaptain.role !== "captain") { targetCaptain.role = "captain"; targetCaptain.revision += 1; }
      this.protectLastCaptain(aggregate, previousCaptain);
      previousCaptain.role = "member"; previousCaptain.revision += 1;
      aggregate.team.revision += 1; aggregate.team.updatedAt = this.now();
      return structuredClone({ teamRevision: aggregate.team.revision, previousCaptain, targetCaptain, projectMembershipsUnchanged: true });
    });
  }

  private protectLastCaptain(aggregate: TeamAggregate, member: TeamMember) {
    if (aggregate.team.status === "active" && member.role === "captain" && aggregate.members.filter((item) => item.role === "captain" && item.status === "active").length <= 1) throw new DomainError("LAST_TEAM_CAPTAIN", "请先转交队长或解散队伍，再退出或降级。", { status: 409 });
  }

  async leaveTeam(actor: Actor, teamId: string, expectedRevision: number) { requireActor(actor); return this.departTeam(actor, teamId, actor.userId, expectedRevision, "left"); }
  async removeTeamMember(actor: Actor, teamId: string, userId: string, expectedRevision: number) { return this.departTeam(actor, teamId, userId, expectedRevision, "removed"); }

  private async departTeam(actor: Actor, teamId: string, userId: string, expectedRevision: number, status: "left" | "removed") {
    requireActor(actor); idField(userId);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, status === "removed"); expectRevision(aggregate.team.revision, expectedRevision);
      const member = aggregate.members.find((item) => item.userId === userId && item.status === "active");
      if (!member) throw new DomainError("MEMBER_UNAVAILABLE", "该成员已离开队伍。", { status: 404 });
      this.protectLastCaptain(aggregate, member);
      const now = this.now(); member.status = status; member.leftAt = now; member.revision += 1; aggregate.team.revision += 1; aggregate.team.updatedAt = now;
      return { membership: structuredClone(member), teamRevision: aggregate.team.revision, projectMembershipsUnchanged: true };
    });
  }

  async dissolveTeam(actor: Actor, teamId: string, expectedRevision: number) {
    requireActor(actor);
    return this.deps.repository.withTeam(idField(teamId), async (aggregate) => {
      requireTeamMember(aggregate, actor, true); expectRevision(aggregate.team.revision, expectedRevision);
      if (aggregate.team.status === "active") {
        const now = this.now(); aggregate.team.status = "dissolved"; aggregate.team.revision += 1; aggregate.team.updatedAt = now;
        for (const invitation of aggregate.invitations) if (invitation.status === "pending") { invitation.status = "revoked"; invitation.revokedAt = now; invitation.revision += 1; }
      }
      return { team: structuredClone(aggregate.team), projectMembershipsUnchanged: true, projectsPreserved: true };
    });
  }

  /** Exposes the same current-membership authority used by other modules. */
  async getMembership(projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    return this.deps.repository.getMembership(idField(projectId), idField(userId));
  }
}
