import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AvailabilityWindowSnapshot, Invitation, InvitationAcceptance, MemberAvailability, Project, ProjectActivity, ProjectAggregate, ProjectChangeFact, ProjectMember, ProjectResourceBookmark, Team, TeamAggregate, TeamMember } from "./model.ts";
import type { ProjectsRepository } from "./ports.ts";
import { invitationUsage } from "./invitation-usage.ts";

type Row = Record<string, unknown>;
type TransactionContext = { executor: SqlExecutor; lockedScopes: Set<string>; savepoints: { sequence: number }; activeChild: boolean };

function valueString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid PostgreSQL field: ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : valueString(value, field);
}

function valueNumber(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric)) throw new Error(`Invalid PostgreSQL integer: ${field}`);
  return numeric;
}

function minutes(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`Invalid PostgreSQL minutes: ${field}`);
  return numeric;
}

function instant(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(valueString(value, field));
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid PostgreSQL timestamp: ${field}`);
  return date.toISOString();
}

function nullableInstant(value: unknown, field: string): string | null {
  return value === null ? null : instant(value, field);
}

/** Drivers may return decoded jsonb or a JSON string; neither is assumed. */
function jsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid PostgreSQL JSON object: ${field}`);
  return parsed as Record<string, unknown>;
}

function projectFromRow(row: Row): Project {
  return {
    id: valueString(row.id, "id"), name: valueString(row.name, "name"),
    teamId: nullableString(row.team_id, "team_id"), eventId: nullableString(row.event_id, "event_id"),
    createdBy: valueString(row.created_by, "created_by"), goal: valueString(row.goal, "goal"),
    minimumDeliverable: valueString(row.minimum_deliverable, "minimum_deliverable"),
    stage: valueString(row.stage, "stage") as Project["stage"], timezone: valueString(row.timezone, "timezone"),
    deadline: nullableInstant(row.deadline, "deadline"), deadlineSource: valueString(row.deadline_source, "deadline_source") as Project["deadlineSource"],
    revision: valueNumber(row.revision, "revision"), createdAt: instant(row.created_at, "created_at"), updatedAt: instant(row.updated_at, "updated_at"),
  };
}

function teamFromRow(row: Row): Team {
  return {
    id: valueString(row.id, "id"), name: valueString(row.name, "name"), createdBy: valueString(row.created_by, "created_by"),
    status: valueString(row.status, "status") as Team["status"], revision: valueNumber(row.revision, "revision"),
    createdAt: instant(row.created_at, "created_at"), updatedAt: instant(row.updated_at, "updated_at"),
  };
}

function projectMemberFromRow(row: Row): ProjectMember {
  return {
    membershipId: valueString(row.membership_id, "membership_id"), projectId: valueString(row.project_id, "project_id"), userId: valueString(row.user_id, "user_id"),
    role: valueString(row.role, "role") as ProjectMember["role"], status: valueString(row.status, "status") as ProjectMember["status"],
    revision: valueNumber(row.revision, "revision"), joinedAt: instant(row.joined_at, "joined_at"), leftAt: nullableInstant(row.left_at, "left_at"),
  };
}

function teamMemberFromRow(row: Row): TeamMember {
  return {
    membershipId: valueString(row.membership_id, "membership_id"), teamId: valueString(row.team_id, "team_id"), userId: valueString(row.user_id, "user_id"),
    role: valueString(row.role, "role") as TeamMember["role"], status: valueString(row.status, "status") as TeamMember["status"],
    revision: valueNumber(row.revision, "revision"), joinedAt: instant(row.joined_at, "joined_at"), leftAt: nullableInstant(row.left_at, "left_at"),
  };
}

function invitationFromRow(row: Row): Invitation {
  return {
    id: valueString(row.id, "id"), scopeType: valueString(row.scope_type, "scope_type") as Invitation["scopeType"], scopeId: valueString(row.scope_id, "scope_id"),
    tokenHash: valueString(row.token_hash, "token_hash"), role: valueString(row.role, "role") as Invitation["role"], invitedEmail: nullableString(row.invited_email, "invited_email"),
    createdBy: valueString(row.created_by, "created_by"), createdAt: instant(row.created_at, "created_at"), expiresAt: instant(row.expires_at, "expires_at"),
    status: valueString(row.status, "status") as Invitation["status"], acceptedBy: nullableString(row.accepted_by, "accepted_by"),
    acceptedAt: nullableInstant(row.accepted_at, "accepted_at"), revokedAt: nullableInstant(row.revoked_at, "revoked_at"), revision: valueNumber(row.revision, "revision"),
    maxUses: row.max_uses === undefined ? 1 : valueNumber(row.max_uses, "max_uses"),
    usedUses: row.used_uses === undefined ? (row.status === "accepted" ? 1 : 0) : valueNumber(row.used_uses, "used_uses"),
  };
}

function windowFromRow(row: Row): AvailabilityWindowSnapshot {
  return {
    id: valueString(row.id, "id"), startsAt: instant(row.starts_at, "starts_at"), endsAt: instant(row.ends_at, "ends_at"),
    effectiveMinutes: minutes(row.effective_minutes, "effective_minutes"), revision: valueNumber(row.revision, "revision"),
  };
}

function availabilityFromRow(row: Row, windows: AvailabilityWindowSnapshot[]): MemberAvailability {
  return {
    id: valueString(row.id, "id"), projectId: valueString(row.project_id, "project_id"), userId: valueString(row.user_id, "user_id"),
    timezone: valueString(row.timezone, "timezone"), windows, effectiveMinutes: minutes(row.effective_minutes, "effective_minutes"),
    confirmedAt: instant(row.confirmed_at, "confirmed_at"), revision: valueNumber(row.revision, "revision"),
    membershipRevision: valueNumber(row.membership_revision, "membership_revision"),
  };
}

function bookmarkFromRow(row: Row): ProjectResourceBookmark {
  return {
    id: valueString(row.id, "id"), projectId: valueString(row.project_id, "project_id"), resourceId: nullableString(row.resource_id, "resource_id"),
    resourceVersion: row.resource_version === null ? null : valueNumber(row.resource_version, "resource_version"),
    url: nullableString(row.url, "url"), title: valueString(row.title, "title"), purposeNote: valueString(row.purpose_note, "purpose_note"),
    savedBy: valueString(row.saved_by, "saved_by"), savedAt: instant(row.saved_at, "saved_at"), status: valueString(row.status, "status") as ProjectResourceBookmark["status"],
    sourceStatus: valueString(row.source_status, "source_status") as ProjectResourceBookmark["sourceStatus"], revision: valueNumber(row.revision, "revision"),
  };
}

function activityFromRow(row: Row): ProjectActivity {
  return {
    id: valueString(row.id, "id"), projectId: valueString(row.project_id, "project_id"), actorId: valueString(row.actor_id, "actor_id"),
    type: valueString(row.type, "type"), objectId: valueString(row.object_id, "object_id"),
    beforeSummary: jsonObject(row.before_summary, "before_summary"), afterSummary: jsonObject(row.after_summary, "after_summary"),
    occurredAt: instant(row.occurred_at, "occurred_at"), revision: valueNumber(row.revision, "revision"),
  };
}

function factFromRow(row: Row): ProjectChangeFact {
  return {
    eventId: valueString(row.event_id, "event_id"), type: valueString(row.type, "type") as ProjectChangeFact["type"], aggregateId: valueString(row.aggregate_id, "aggregate_id"),
    projectId: valueString(row.project_id, "project_id"), actorId: valueString(row.actor_id, "actor_id"), version: valueNumber(row.version, "version"),
    occurredAt: instant(row.occurred_at, "occurred_at"), payload: jsonObject(row.payload, "payload"),
  };
}

function invalidAggregate(message: string): never {
  throw new DomainError("INVALID_AGGREGATE", message, { status: 422 });
}

function assertUnchangedIdentity(before: Row, after: Row, fields: readonly string[]): void {
  for (const field of fields) if (before[field] !== after[field]) invalidAggregate("已有记录的归属与标识不能修改。");
}

function assertRevision(before: number | undefined, after: number): void {
  if (!Number.isSafeInteger(after) || after < 1 || (before !== undefined && after <= before)) invalidAggregate("修改记录必须使用递增的正整数版本。");
}

function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new DomainError("INVALID_LIMIT", "读取数量必须为 1 至 1000 的整数。");
}

function translateDatabaseError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return error;
  const failure = error as { code?: unknown; constraint?: unknown };
  if (failure.constraint === "projects_active_manager_required") return new DomainError("LAST_PROJECT_MANAGER", "项目至少需要一位活跃管理员，请先转交管理。", { status: 409, recoveryAction: "transfer_project_management" });
  if (failure.constraint === "projects_active_captain_required") return new DomainError("LAST_TEAM_CAPTAIN", "队伍至少需要一位活跃队长，请先转交或解散。", { status: 409 });
  if (failure.code === "23505") return new DomainError("DUPLICATE_RECORD", "记录已存在，请刷新后重试。", { status: 409 });
  if (failure.code === "23503") return new DomainError("INVALID_REFERENCE", "关联记录不存在或仍被其他记录引用。", { status: 422 });
  if (failure.code === "23514" || failure.code === "23502") return new DomainError("INVALID_AGGREGATE", "记录不符合保存约束，请核对后重试。", { status: 422 });
  return error;
}

/** The supplied DatabasePort must provide real commit/rollback on one PostgreSQL connection. */
export class PostgresProjectsRepository implements ProjectsRepository {
  private readonly database: DatabasePort;
  private readonly transactions = new AsyncLocalStorage<TransactionContext>();

  constructor(database: DatabasePort) { this.database = database; }

  private executor(): SqlExecutor { return this.transactions.getStore()?.executor ?? this.database; }

  private async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const context = this.transactions.getStore();
    try {
      if (!context) return await this.database.transaction((executor) => this.transactions.run({ executor, lockedScopes: new Set(), savepoints: { sequence: 0 }, activeChild: false }, () => work(executor)));
      if (context.activeChild) invalidAggregate("同一事务中的嵌套写入必须依次执行。");
      // The identifier is internal and monotonic, never derived from user input.
      const savepoint = `projects_m02_${++context.savepoints.sequence}`;
      context.activeChild = true;
      try {
        await context.executor.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await this.transactions.run({ ...context, activeChild: false }, () => work(context.executor));
          await context.executor.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          await context.executor.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await context.executor.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      } finally { context.activeChild = false; }
    } catch (error) { throw translateDatabaseError(error); }
  }

  async createProject(aggregate: ProjectAggregate): Promise<void> {
    await this.transaction(async (executor) => {
      const project = aggregate.project;
      assertRevision(undefined, project.revision);
      if (project.teamId !== null) {
        // Team mutation takes the same lock, so departure/dissolution cannot race this check.
        const team = await executor.query<Row>("SELECT status FROM projects_team WHERE id = $1 FOR UPDATE", [project.teamId]);
        const membership = await executor.query<Row>("SELECT status FROM projects_team_membership WHERE team_id = $1 AND user_id = $2", [project.teamId, project.createdBy]);
        if (team.rows[0]?.status !== "active" || membership.rows[0]?.status !== "active") throw new DomainError("TEAM_MEMBERSHIP_REQUIRED", "只有该活跃队伍的成员可以创建关联项目。", { status: 403 });
      }
      await executor.query("INSERT INTO projects_project (id, name, team_id, event_id, created_by, goal, minimum_deliverable, stage, timezone, deadline, deadline_source, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [project.id, project.name, project.teamId, project.eventId, project.createdBy, project.goal, project.minimumDeliverable, project.stage, project.timezone, project.deadline, project.deadlineSource, project.revision, project.createdAt, project.updatedAt]);
      await this.persistProjectChildren(executor, null, aggregate);
    });
  }

  async createTeam(aggregate: TeamAggregate): Promise<void> {
    await this.transaction(async (executor) => {
      const team = aggregate.team;
      assertRevision(undefined, team.revision);
      await executor.query("INSERT INTO projects_team (id, name, created_by, status, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [team.id, team.name, team.createdBy, team.status, team.revision, team.createdAt, team.updatedAt]);
      await this.persistMembers(executor, [], aggregate.members, "team", team.id);
      await this.persistInvitations(executor, [], aggregate.invitations, "team", team.id);
    });
  }

  async withProject<T>(projectId: string, work: (aggregate: ProjectAggregate, transaction?: SqlExecutor) => Promise<T>): Promise<T> {
    return this.transaction(async (executor) => {
      const scope = `project:${projectId}`;
      const context = this.transactions.getStore()!;
      if (context.lockedScopes.has(scope)) invalidAggregate("同一项目不能在当前操作中重复嵌套修改。");
      context.lockedScopes.add(scope);
      try {
        const projectRows = await executor.query<Row>("SELECT * FROM projects_project WHERE id = $1 FOR UPDATE", [projectId]);
        if (!projectRows.rows[0]) throw new DomainError("PROJECT_NOT_FOUND", "项目不存在或不可访问。", { status: 404 });
        const aggregate = await this.loadProject(executor, projectFromRow(projectRows.rows[0]));
        const before = structuredClone(aggregate);
        const result = await work(aggregate, executor);
        assertUnchangedIdentity(before.project as unknown as Row, aggregate.project as unknown as Row, ["id", "createdBy", "createdAt"]);
        if (!isDeepStrictEqual(before.project, aggregate.project)) {
          const project = aggregate.project;
          assertRevision(before.project.revision, project.revision);
          await this.update(executor, "UPDATE projects_project SET name=$2, team_id=$3, event_id=$4, goal=$5, minimum_deliverable=$6, stage=$7, timezone=$8, deadline=$9, deadline_source=$10, revision=$11, updated_at=$12 WHERE id=$1 AND revision=$13", [project.id, project.name, project.teamId, project.eventId, project.goal, project.minimumDeliverable, project.stage, project.timezone, project.deadline, project.deadlineSource, project.revision, project.updatedAt, before.project.revision]);
        }
        await this.persistProjectChildren(executor, before, aggregate);
        return result;
      } finally { context.lockedScopes.delete(scope); }
    });
  }

  async withTeam<T>(teamId: string, work: (aggregate: TeamAggregate) => Promise<T>): Promise<T> {
    return this.transaction(async (executor) => {
      const scope = `team:${teamId}`;
      const context = this.transactions.getStore()!;
      if (context.lockedScopes.has(scope)) invalidAggregate("同一队伍不能在当前操作中重复嵌套修改。");
      context.lockedScopes.add(scope);
      try {
        const teamRows = await executor.query<Row>("SELECT * FROM projects_team WHERE id = $1 FOR UPDATE", [teamId]);
        if (!teamRows.rows[0]) throw new DomainError("TEAM_NOT_FOUND", "队伍不存在或不可访问。", { status: 404 });
        const memberRows = await executor.query<Row>("SELECT * FROM projects_team_membership WHERE team_id = $1 ORDER BY membership_id", [teamId]);
        const invitationRows = await executor.query<Row>("SELECT * FROM projects_invitation WHERE scope_type = 'team' AND scope_id = $1 ORDER BY id", [teamId]);
        const aggregate: TeamAggregate = { team: teamFromRow(teamRows.rows[0]), members: memberRows.rows.map(teamMemberFromRow), invitations: await this.loadInvitations(executor, invitationRows.rows) };
        const before = structuredClone(aggregate);
        const result = await work(aggregate);
        assertUnchangedIdentity(before.team as unknown as Row, aggregate.team as unknown as Row, ["id", "createdBy", "createdAt"]);
        if (!isDeepStrictEqual(before.team, aggregate.team)) {
          const team = aggregate.team;
          assertRevision(before.team.revision, team.revision);
          await this.update(executor, "UPDATE projects_team SET name=$2, status=$3, revision=$4, updated_at=$5 WHERE id=$1 AND revision=$6", [team.id, team.name, team.status, team.revision, team.updatedAt, before.team.revision]);
        }
        await this.persistMembers(executor, before.members, aggregate.members, "team", teamId);
        await this.persistInvitations(executor, before.invitations, aggregate.invitations, "team", teamId);
        return result;
      } finally { context.lockedScopes.delete(scope); }
    });
  }

  async getMembership(projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    const result = await this.executor().query<Row>("SELECT membership_id, project_id, user_id, role, status FROM projects_project_membership WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
    const row = result.rows[0];
    return row ? { membershipId: valueString(row.membership_id, "membership_id"), projectId: valueString(row.project_id, "project_id"), userId: valueString(row.user_id, "user_id"), role: valueString(row.role, "role") as ProjectMembershipAccess["role"], status: valueString(row.status, "status") as ProjectMembershipAccess["status"] } : null;
  }

  /** Source permission stays stable until commit; avoids taking a second project's write lock. */
  async getMembershipForShare(executor: SqlExecutor, projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    const result = await executor.query<Row>("SELECT membership_id, project_id, user_id, role, status FROM projects_project_membership WHERE project_id=$1 AND user_id=$2 FOR SHARE", [projectId, userId]);
    const row = result.rows[0];
    return row ? { membershipId: valueString(row.membership_id, "membership_id"), projectId: valueString(row.project_id, "project_id"), userId: valueString(row.user_id, "user_id"), role: valueString(row.role, "role") as ProjectMembershipAccess["role"], status: valueString(row.status, "status") as ProjectMembershipAccess["status"] } : null;
  }

  /** The caller owns this executor's transaction. Locking project first serializes with M02 mutations. */
  async getMembershipForUpdate(executor: SqlExecutor, projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    const project = await executor.query<Row>("SELECT id FROM projects_project WHERE id = $1 FOR UPDATE", [projectId]);
    if (!project.rows[0]) return null;
    const result = await executor.query<Row>("SELECT membership_id, project_id, user_id, role, status FROM projects_project_membership WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
    const row = result.rows[0];
    return row ? { membershipId: valueString(row.membership_id, "membership_id"), projectId: valueString(row.project_id, "project_id"), userId: valueString(row.user_id, "user_id"), role: valueString(row.role, "role") as ProjectMembershipAccess["role"], status: valueString(row.status, "status") as ProjectMembershipAccess["status"] } : null;
  }

  /** M05 reads current input versions under the same project lock as its plan transaction. */
  async getPlanningContextForUpdate(executor: SqlExecutor, projectId: string, userId: string): Promise<{ project: Project; members: ProjectMember[]; availability: MemberAvailability[] }> {
    const project = await executor.query<Row>("SELECT * FROM projects_project WHERE id = $1 FOR UPDATE", [projectId]);
    if (!project.rows[0]) throw new DomainError("PROJECT_NOT_FOUND", "项目不存在或不可访问。", { status: 404 });
    const aggregate = await this.loadProject(executor, projectFromRow(project.rows[0]));
    if (!aggregate.members.some((member) => member.userId === userId && member.status === "active")) throw new DomainError("PROJECT_NOT_FOUND", "项目不存在或不可访问。", { status: 404 });
    // Preserve historical statuses/revisions: consumers must invalidate availability that no longer
    // matches active membership rather than silently treat an old collection as current capacity.
    return { project: aggregate.project, members: aggregate.members, availability: aggregate.availability };
  }

  async findInvitationByHash(tokenHash: string): Promise<Pick<Invitation, "scopeType" | "scopeId"> | null> {
    const result = await this.executor().query<Row>("SELECT scope_type, scope_id FROM projects_invitation WHERE token_hash = $1", [tokenHash]);
    const row = result.rows[0];
    return row ? { scopeType: valueString(row.scope_type, "scope_type") as Invitation["scopeType"], scopeId: valueString(row.scope_id, "scope_id") } : null;
  }

  async listProjects(userId: string): Promise<Project[]> {
    const result = await this.executor().query<Row>("SELECT p.* FROM projects_project p JOIN projects_project_membership m ON m.project_id = p.id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY p.updated_at DESC, p.id", [userId]);
    return result.rows.map(projectFromRow);
  }

  async listTeams(userId: string): Promise<Team[]> {
    const result = await this.executor().query<Row>("SELECT t.* FROM projects_team t JOIN projects_team_membership m ON m.team_id = t.id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY t.updated_at DESC, t.id", [userId]);
    return result.rows.map(teamFromRow);
  }

  /** Caller must authorize current membership; lock callbacks reuse the authorizing transaction. */
  async listActivities(projectId: string, limit: number): Promise<ProjectActivity[]> {
    checkLimit(limit);
    const result = await this.executor().query<Row>("SELECT * FROM projects_activity WHERE project_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2", [projectId, limit]);
    return result.rows.map(activityFromRow);
  }

  /** Worker-only integration surface; delivery is at-least-once and consumers deduplicate eventId. */
  async listPendingFacts(limit: number): Promise<ProjectChangeFact[]> {
    checkLimit(limit);
    const result = await this.executor().query<Row>("SELECT * FROM projects_change_fact WHERE acknowledged_at IS NULL ORDER BY occurred_at, event_id LIMIT $1", [limit]);
    return result.rows.map(factFromRow);
  }

  async acknowledgeFact(eventId: string): Promise<void> {
    await this.executor().query("UPDATE projects_change_fact SET acknowledged_at = CURRENT_TIMESTAMP WHERE event_id = $1 AND acknowledged_at IS NULL", [eventId]);
  }

  private async update(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<void> {
    const result = await executor.query(sql, values);
    if (result.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "记录已被更新，请刷新后重试。", { status: 409, recoveryAction: "review_latest_version" });
  }

  private async loadProject(executor: SqlExecutor, project: Project): Promise<ProjectAggregate> {
    const members = await executor.query<Row>("SELECT * FROM projects_project_membership WHERE project_id = $1 ORDER BY membership_id", [project.id]);
    const invitations = await executor.query<Row>("SELECT * FROM projects_invitation WHERE scope_type = 'project' AND scope_id = $1 ORDER BY id", [project.id]);
    const availability = await executor.query<Row>("SELECT * FROM projects_member_availability WHERE project_id = $1 ORDER BY id", [project.id]);
    const windows = await executor.query<Row>("SELECT w.* FROM projects_availability_window w JOIN projects_member_availability a ON a.id = w.availability_id WHERE a.project_id = $1 ORDER BY w.availability_id, w.starts_at, w.id", [project.id]);
    const bookmarks = await executor.query<Row>("SELECT * FROM projects_resource_bookmark WHERE project_id = $1 ORDER BY id", [project.id]);
    const groupedWindows = new Map<string, AvailabilityWindowSnapshot[]>();
    for (const row of windows.rows) {
      const availabilityId = valueString(row.availability_id, "availability_id");
      const group = groupedWindows.get(availabilityId) ?? [];
      group.push(windowFromRow(row)); groupedWindows.set(availabilityId, group);
    }
    return {
      project, members: members.rows.map(projectMemberFromRow), invitations: await this.loadInvitations(executor, invitations.rows),
      availability: availability.rows.map((row) => availabilityFromRow(row, groupedWindows.get(valueString(row.id, "id")) ?? [])),
      bookmarks: bookmarks.rows.map(bookmarkFromRow), activities: [], facts: [],
    };
  }

  private async loadInvitations(executor: SqlExecutor, rows: readonly Row[]): Promise<Invitation[]> {
    const invitations: Invitation[] = [];
    for (const row of rows) {
      const invitation = invitationFromRow(row);
      if (row.max_uses !== undefined) {
        const consumers = await executor.query<Row>("SELECT * FROM projects_invitation_acceptance WHERE invitation_id = $1 ORDER BY user_id", [invitation.id]);
        invitation.acceptances = consumers.rows.map(item => ({ invitationId: valueString(item.invitation_id, "invitation_id"), userId: valueString(item.user_id, "user_id"), membershipId: nullableString(item.membership_id ?? null, "membership_id"), acceptedAt: instant(item.accepted_at, "accepted_at") }));
      }
      invitationUsage(invitation);
      invitations.push(invitation);
    }
    return invitations;
  }

  private retainedRows<T>(before: readonly T[], after: readonly T[], key: (value: T) => string): Map<string, T> {
    const previous = new Map(before.map((value) => [key(value), value]));
    const currentIds = new Set<string>();
    for (const value of after) {
      const id = key(value);
      if (currentIds.has(id)) invalidAggregate("同一记录不能重复出现在集合中。");
      currentIds.add(id);
    }
    for (const id of previous.keys()) if (!currentIds.has(id)) invalidAggregate("历史记录须保留并更新状态，不能从集合中删除。");
    return previous;
  }

  private async persistMembers(executor: SqlExecutor, before: readonly (ProjectMember | TeamMember)[], after: readonly (ProjectMember | TeamMember)[], scopeType: "project" | "team", scopeId: string): Promise<void> {
    const previous = this.retainedRows(before, after, (member) => member.membershipId);
    const table = scopeType === "project" ? "projects_project_membership" : "projects_team_membership";
    const column = scopeType === "project" ? "project_id" : "team_id";
    for (const member of after) {
      const memberScopeId = "projectId" in member ? member.projectId : member.teamId;
      if (memberScopeId !== scopeId) invalidAggregate("成员记录必须属于当前操作的项目或队伍。");
      const old = previous.get(member.membershipId);
      if (old) {
        assertUnchangedIdentity(old as unknown as Row, member as unknown as Row, ["membershipId", "userId", scopeType === "project" ? "projectId" : "teamId"]);
        if (isDeepStrictEqual(old, member)) continue;
        assertRevision(old.revision, member.revision);
        await this.update(executor, `UPDATE ${table} SET role=$2, status=$3, revision=$4, joined_at=$5, left_at=$6 WHERE membership_id=$1 AND ${column}=$7 AND revision=$8`, [member.membershipId, member.role, member.status, member.revision, member.joinedAt, member.leftAt, scopeId, old.revision]);
      } else {
        assertRevision(undefined, member.revision);
        await executor.query(`INSERT INTO ${table} (membership_id, ${column}, user_id, role, status, revision, joined_at, left_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [member.membershipId, scopeId, member.userId, member.role, member.status, member.revision, member.joinedAt, member.leftAt]);
      }
    }
  }

  private async persistInvitations(executor: SqlExecutor, before: readonly Invitation[], after: readonly Invitation[], scopeType: "project" | "team", scopeId: string): Promise<void> {
    const previous = this.retainedRows(before, after, (invitation) => invitation.id);
    for (const invitation of after) {
      if (invitation.scopeType !== scopeType || invitation.scopeId !== scopeId) invalidAggregate("邀请必须属于当前操作的项目或队伍。");
      const old = previous.get(invitation.id);
      const usage = invitationUsage(invitation);
      const oldUsage = old ? invitationUsage(old) : null;
      const consumers = this.retainedRows(oldUsage?.acceptances ?? [], usage.acceptances, item => item.userId);
      if (old) {
        assertUnchangedIdentity(old as unknown as Row, invitation as unknown as Row, ["id", "scopeType", "scopeId", "tokenHash", "createdBy", "createdAt"]);
        if (isDeepStrictEqual(old, invitation)) continue;
        if (oldUsage!.maxUses !== usage.maxUses || usage.usedUses < oldUsage!.usedUses) invalidAggregate("已发出的邀请不能更改名额上限或退还已用名额。");
        assertRevision(old.revision, invitation.revision);
        await this.update(executor, "UPDATE projects_invitation SET role=$2, invited_email=$3, expires_at=$4, status=$5, accepted_by=$6, accepted_at=$7, revoked_at=$8, revision=$9, max_uses=$13, used_uses=$14 WHERE id=$1 AND scope_type=$10 AND scope_id=$11 AND revision=$12", [invitation.id, invitation.role, invitation.invitedEmail, invitation.expiresAt, invitation.status, invitation.acceptedBy, invitation.acceptedAt, invitation.revokedAt, invitation.revision, scopeType, scopeId, old.revision, usage.maxUses, usage.usedUses]);
      } else {
        assertRevision(undefined, invitation.revision);
        await executor.query("INSERT INTO projects_invitation (id, scope_type, scope_id, project_id, team_id, token_hash, role, invited_email, created_by, created_at, expires_at, status, accepted_by, accepted_at, revoked_at, revision, max_uses, used_uses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)", [invitation.id, scopeType, scopeId, scopeType === "project" ? scopeId : null, scopeType === "team" ? scopeId : null, invitation.tokenHash, invitation.role, invitation.invitedEmail, invitation.createdBy, invitation.createdAt, invitation.expiresAt, invitation.status, invitation.acceptedBy, invitation.acceptedAt, invitation.revokedAt, invitation.revision, usage.maxUses, usage.usedUses]);
      }
      for (const consumer of usage.acceptances) {
        const previousConsumer = consumers.get(consumer.userId);
        if (previousConsumer) {
          if (!isDeepStrictEqual(previousConsumer, consumer)) invalidAggregate("已消费的邀请记录不能修改。");
        } else {
          if (consumer.membershipId === null) invalidAggregate("新的邀请接受记录必须关联本次加入的成员。旧历史不能补造。");
          await executor.query("INSERT INTO projects_invitation_acceptance (invitation_id, user_id, membership_id, accepted_at) VALUES ($1,$2,$3,$4)", [invitation.id, consumer.userId, consumer.membershipId, consumer.acceptedAt]);
        }
      }
    }
  }

  private async persistProjectChildren(executor: SqlExecutor, before: ProjectAggregate | null, after: ProjectAggregate): Promise<void> {
    const projectId = after.project.id;
    await this.persistMembers(executor, before?.members ?? [], after.members, "project", projectId);
    await this.persistInvitations(executor, before?.invitations ?? [], after.invitations, "project", projectId);
    const previousAvailability = this.retainedRows(before?.availability ?? [], after.availability, (value) => value.id);
    for (const availability of after.availability) {
      if (availability.projectId !== projectId) invalidAggregate("可用时间必须属于当前项目。");
      const old = previousAvailability.get(availability.id);
      if (old) {
        assertUnchangedIdentity(old as unknown as Row, availability as unknown as Row, ["id", "projectId", "userId"]);
        if (isDeepStrictEqual(old, availability)) continue;
        assertRevision(old.revision, availability.revision);
        await this.update(executor, "UPDATE projects_member_availability SET timezone=$2, effective_minutes=$3, confirmed_at=$4, revision=$5, membership_revision=$6 WHERE id=$1 AND project_id=$7 AND revision=$8", [availability.id, availability.timezone, availability.effectiveMinutes, availability.confirmedAt, availability.revision, availability.membershipRevision, projectId, old.revision]);
      } else {
        assertRevision(undefined, availability.revision);
        await executor.query("INSERT INTO projects_member_availability (id, project_id, user_id, timezone, effective_minutes, confirmed_at, revision, membership_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [availability.id, projectId, availability.userId, availability.timezone, availability.effectiveMinutes, availability.confirmedAt, availability.revision, availability.membershipRevision]);
      }
      await this.persistWindows(executor, availability.id, old?.windows ?? [], availability.windows);
    }
    const previousBookmarks = this.retainedRows(before?.bookmarks ?? [], after.bookmarks, (value) => value.id);
    for (const bookmark of after.bookmarks) {
      if (bookmark.projectId !== projectId) invalidAggregate("共享资料必须属于当前项目。");
      const old = previousBookmarks.get(bookmark.id);
      if (old) {
        assertUnchangedIdentity(old as unknown as Row, bookmark as unknown as Row, ["id", "projectId", "resourceId", "url"]);
        if (isDeepStrictEqual(old, bookmark)) continue;
        assertRevision(old.revision, bookmark.revision);
        await this.update(executor, "UPDATE projects_resource_bookmark SET title=$2, purpose_note=$3, saved_by=$4, saved_at=$5, status=$6, source_status=$7, revision=$8, resource_version=$11 WHERE id=$1 AND project_id=$9 AND revision=$10", [bookmark.id, bookmark.title, bookmark.purposeNote, bookmark.savedBy, bookmark.savedAt, bookmark.status, bookmark.sourceStatus, bookmark.revision, projectId, old.revision, bookmark.resourceVersion]);
      } else {
        assertRevision(undefined, bookmark.revision);
        await executor.query("INSERT INTO projects_resource_bookmark (id, project_id, resource_id, url, title, purpose_note, saved_by, saved_at, status, source_status, revision, resource_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [bookmark.id, projectId, bookmark.resourceId, bookmark.url, bookmark.title, bookmark.purposeNote, bookmark.savedBy, bookmark.savedAt, bookmark.status, bookmark.sourceStatus, bookmark.revision, bookmark.resourceVersion]);
      }
    }
    for (const activity of after.activities) {
      if (activity.projectId !== projectId) invalidAggregate("活动记录必须属于当前项目。");
      assertRevision(undefined, activity.revision);
      await executor.query("INSERT INTO projects_activity (id, project_id, actor_id, type, object_id, before_summary, after_summary, occurred_at, revision) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)", [activity.id, projectId, activity.actorId, activity.type, activity.objectId, JSON.stringify(activity.beforeSummary), JSON.stringify(activity.afterSummary), activity.occurredAt, activity.revision]);
    }
    for (const fact of after.facts) {
      if (fact.projectId !== projectId) invalidAggregate("变更事实必须属于当前项目。");
      assertRevision(undefined, fact.version);
      await executor.query("INSERT INTO projects_change_fact (event_id, type, aggregate_id, project_id, actor_id, version, occurred_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [fact.eventId, fact.type, fact.aggregateId, projectId, fact.actorId, fact.version, fact.occurredAt, JSON.stringify(fact.payload)]);
    }
  }

  private async persistWindows(executor: SqlExecutor, availabilityId: string, before: readonly AvailabilityWindowSnapshot[], after: readonly AvailabilityWindowSnapshot[]): Promise<void> {
    const previous = new Map(before.map((window) => [window.id, window]));
    const current = new Set<string>();
    for (const window of after) {
      if (current.has(window.id)) invalidAggregate("可用时间窗口标识不能重复。");
      current.add(window.id);
      const old = previous.get(window.id);
      if (old && isDeepStrictEqual(old, window)) continue;
      assertRevision(old?.revision, window.revision);
      if (old) {
        await this.update(executor, "UPDATE projects_availability_window SET starts_at=$3, ends_at=$4, effective_minutes=$5, revision=$6 WHERE availability_id=$1 AND id=$2 AND revision=$7", [availabilityId, window.id, window.startsAt, window.endsAt, window.effectiveMinutes, window.revision, old.revision]);
      } else {
        await executor.query("INSERT INTO projects_availability_window (availability_id, id, starts_at, ends_at, effective_minutes, revision) VALUES ($1,$2,$3,$4,$5,$6)", [availabilityId, window.id, window.startsAt, window.endsAt, window.effectiveMinutes, window.revision]);
      }
    }
    // These are current snapshot children. Membership and collection history is retained.
    for (const window of before) if (!current.has(window.id)) await this.update(executor, "DELETE FROM projects_availability_window WHERE availability_id=$1 AND id=$2 AND revision=$3", [availabilityId, window.id, window.revision]);
  }
}
