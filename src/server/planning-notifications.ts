import type { Actor, Clock, IdGenerator, ProjectMembershipAccess } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import {
  PlanningNotificationService, PlanningService, createPlanningNotificationWorker,
  createPostgresPlanningNotificationRepository, createPostgresPlanningRepository,
  derivePlanningNotificationFacts,
  type PlanningInput, type PlanningNotificationDependencies, type PlanningNotificationProject,
  type PlanningNotificationProjectPort, type PlanningNotificationSnapshotPort,
  type PlanningResourcePort,
} from "../modules/planning/index.ts";
import type { ProjectsService } from "../modules/projects/index.ts";

export interface PlanningNotificationsRootDependencies {
  database: DatabasePort;
  planning: Pick<PlanningService, "listProgress">;
  projects: Pick<ProjectsService, "getProject">;
  /** Real current input on this executor. The caller has already protected the
   * existing M04 head and M02 project; an absent head must remain a plain read. */
  readInput(projectId: string, now: string, actor: Actor, sql: SqlExecutor): Promise<PlanningInput>;
  resources?: Pick<PlanningResourcePort, "getReviewedResources">;
  clock: Clock;
  ids: IdGenerator;
}

interface MemberRow {
  membership_id: string; project_id: string; user_id: string;
  role: ProjectMembershipAccess["role"]; status: ProjectMembershipAccess["status"];
}
interface ProtectedProject { project: PlanningNotificationProject; actor: Actor | null }

function count(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new DomainError("INVALID_INPUT", "提醒检查数量需要是 1 到 200 的整数。");
  return value;
}
function projectId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new DomainError("INVALID_INPUT", "项目标识无效。");
}
function changed(): never { throw new DomainError("NOTIFICATION_INPUT_CHANGED", "项目权限刚刚变化，请重新检查提醒。", { status: 409 }); }

/** Root composition only. Reads use the caller's connection, never a separate
 * database, model, plan initializer, or second task-completion ledger. */
export function createPlanningNotifications(d: PlanningNotificationsRootDependencies) {
  const protectedProjects = new WeakMap<SqlExecutor, Map<string, ProtectedProject>>();
  const protectedHeads = new WeakMap<SqlExecutor, Set<string>>();
  const planningRepository = createPostgresPlanningRepository(d.database);
  const repository = createPostgresPlanningNotificationRepository(d.database);

  const projects: PlanningNotificationProjectPort = {
    async lockProject(id, sql) {
      projectId(id);
      // Same order as M05/M04 mutations. Repeating an already-held advisory lock
      // is harmless; GET own receipts also uses this order without initializing.
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`planning:${id}`]);
      // An absent row cannot be locked. Never lock it again after holding M02:
      // a concurrent M04 writer may have inserted its uncommitted head and be
      // waiting for that project. Final permission checks repeat M02/M01 only.
      if (!protectedHeads.get(sql)?.has(id)) {
        await sql.query("SELECT project_id FROM assessments_assignment_heads WHERE project_id=$1 FOR UPDATE", [id]);
        const heads = protectedHeads.get(sql) ?? new Set<string>(); heads.add(id); protectedHeads.set(sql, heads);
      }
      const row = await sql.query<{ id: string; stage: string }>("SELECT id,stage FROM projects_project WHERE id=$1 FOR UPDATE", [id]);
      if (!row.rows[0]) { protectedProjects.get(sql)?.delete(id); return null; }
      const members = await sql.query<MemberRow>(`SELECT m.membership_id,m.project_id,m.user_id,m.role,m.status
        FROM projects_project_membership m JOIN auth_users u ON u.id=m.user_id
        WHERE m.project_id=$1 AND m.status='active' AND u.status='active' AND u.email_verified_at IS NOT NULL
        ORDER BY m.user_id,m.membership_id FOR SHARE OF m,u`, [id]);
      const eligible: ProjectMembershipAccess[] = members.rows.map(member => {
        if (member.project_id !== id || member.status !== "active" || !["manager", "member"].includes(member.role)) changed();
        return { membershipId: member.membership_id, projectId: member.project_id, userId: member.user_id, role: member.role, status: member.status };
      });
      const project: PlanningNotificationProject = { projectId: id, archived: row.rows[0].stage === "archived", members: eligible };
      const selected = eligible.find(member => member.role === "manager") ?? eligible[0];
      const actor: Actor | null = selected ? { userId: selected.userId, platformRoles: ["user"] } : null;
      const scope = protectedProjects.get(sql) ?? new Map<string, ProtectedProject>();
      scope.set(id, { project, actor }); protectedProjects.set(sql, scope);
      return project;
    },
  };

  const snapshots: PlanningNotificationSnapshotPort = {
    async readSnapshot(id, sql, now) {
      projectId(id);
      if (!Number.isFinite(Date.parse(now))) throw new DomainError("INVALID_TIME", "提醒检查时间无效。");
      if (!protectedProjects.get(sql)?.has(id)) await projects.lockProject(id, sql);
      const scope = protectedProjects.get(sql)?.get(id);
      if (!scope || scope.project.archived || !scope.actor) return { facts: [] };
      const actor = scope.actor;
      const detail = await d.projects.getProject(actor, id);
      const membership = scope.project.members.find(member => member.userId === actor.userId);
      if (!membership || detail.project.id !== id || detail.membership.membershipId !== membership.membershipId
        || detail.membership.role !== membership.role || detail.project.stage === "archived") changed();
      const state = await planningRepository.read(id);
      if (!state?.currentPlanVersionId) return { facts: [] };
      const input = structuredClone(await d.readInput(id, now, actor, sql));
      if (input.projectId !== id || input.projectArchived || !input.members.some(member => member.status === "active" && member.userId === actor.userId && member.membershipId === membership.membershipId)) changed();
      // M02 preserves an active membership when M01 suspends an account. Such
      // a person cannot act on work, so the notification's read-only planning
      // projection excludes their capacity and flags now-unavailable owners.
      // The cause revision uses this stable eligible identity set and actual
      // task revisions; capturedAt never creates another notification.
      const eligibleIds = new Set(scope.project.members.map(member => member.membershipId));
      input.members = input.members.filter(member => member.status === "active" && eligibleIds.has(member.membershipId));
      input.availability = input.availability.filter(collection => eligibleIds.has(collection.membershipId));
      input.availabilityVersions = Object.fromEntries(Object.entries(input.availabilityVersions).filter(([member]) => eligibleIds.has(member)));
      // M05's public service owns current evaluation. Prefetch actual task resource
      // heads into this input so both its evaluation and notification revision
      // use the same snapshot, without a later reverse M04 head lock.
      const resourceIds = [...new Set(state.tasks.flatMap(task => task.resourceRefs))].sort();
      if (resourceIds.length && d.resources?.getReviewedResources) {
        const found = new Map<string, number>();
        for (let offset = 0; offset < resourceIds.length; offset += 50) {
          const batch = resourceIds.slice(offset, offset + 50);
          for (const resource of await d.resources.getReviewedResources(batch, sql)) {
            if (!batch.includes(resource.id) || !Number.isSafeInteger(resource.version) || resource.version < 1 || found.has(resource.id)) throw new DomainError("INVALID_RESOURCE_VERSION_FACT", "资料公开版本无法确认。");
            found.set(resource.id, resource.version);
          }
        }
        input.resourceContentVersions = { ...input.resourceContentVersions, ...Object.fromEntries(resourceIds.map(resourceId => [resourceId, found.get(resourceId) ?? null])) };
        input.approvedResourceIds = [...new Set([...input.approvedResourceIds.filter(resourceId => !resourceIds.includes(resourceId)), ...found.keys()])];
      }
      const currentReader = new PlanningService({
        repository: planningRepository,
        access: { async getMembership(project, user) { return project === id ? scope.project.members.find(member => member.userId === user) ?? null : null; } },
        facts: { async readInput() { return input; }, async lockVersions() { throw new DomainError("NOTIFICATION_READ_ONLY", "提醒读取不能修改计划。"); } },
        clock: { now: () => new Date(now) }, ids: d.ids,
      });
      const current = await currentReader.getCurrent(actor, id);
      const progress = await d.planning.listProgress(actor, id);
      return derivePlanningNotificationFacts({ current, input, progress });
    },
  };

  const dependencies: PlanningNotificationDependencies = { repository, projects, snapshots, clock: d.clock, ids: d.ids };
  const service = new PlanningNotificationService(dependencies);
  const baseWorker = createPlanningNotificationWorker(service);

  async function selectProjectIds(options: { limit?: number; afterProjectId?: string } = {}): Promise<string[]> {
    const size = count(options.limit);
    if (options.afterProjectId !== undefined) projectId(options.afterProjectId);
    // Clock changes have no outbox event. Include current plans plus existing
    // recipients so leaving, disabling, and archiving can be reconciled too.
    const result = await d.database.query<{ project_id: string }>(`SELECT candidate.project_id FROM (
      SELECT s.project_id FROM planning_states s JOIN projects_project p ON p.id=s.project_id
        WHERE s.state_json->>'currentPlanVersionId' IS NOT NULL
      UNION
      SELECT n.project_id FROM planning_notifications n JOIN planning_notification_recipients r ON r.notification_id=n.id
        WHERE r.revoked_at IS NULL
    ) candidate WHERE ($2::text IS NULL OR candidate.project_id>$2) ORDER BY candidate.project_id LIMIT $1`, [size, options.afterProjectId ?? null]);
    return result.rows.map(row => row.project_id);
  }

  type WorkerReport = Awaited<ReturnType<typeof baseWorker.runOnce>>;
  let cursor: string | undefined;
  let queued: string[] = [];
  let running: Promise<WorkerReport> | null = null;
  const worker = {
    /** Sequential bounded polling, coalescing simultaneous scheduler ticks.
     * A fetched page is drained before advancing, including failed checks, so
     * a busy outbox cannot starve later periodic projects. */
    async runOnce(options: { limit?: number; projectIds?: readonly string[]; signal?: AbortSignal } = {}): Promise<WorkerReport> {
      const size = count(options.limit);
      if (options.projectIds) { if (options.projectIds.length > 200) throw new DomainError("INVALID_INPUT", "一次最多检查 200 个项目。"); for (const id of options.projectIds) projectId(id); }
      if (options.signal?.aborted) return { projects: [], errors: [], modelRequests: 0 };
      if (running) return running;
      const run = async () => {
        if (options.projectIds) return baseWorker.runOnce({ projectIds: options.projectIds, limit: size });
        if (!queued.length) {
          queued = await selectProjectIds({ limit: size, afterProjectId: cursor });
          if (!queued.length && cursor !== undefined) { cursor = undefined; queued = await selectProjectIds({ limit: size }); }
          if (queued.length) cursor = queued.at(-1);
        }
        if (options.signal?.aborted) return { projects: [], errors: [], modelRequests: 0 as const };
        const report = await baseWorker.runOnce({ projectIds: queued.slice(0, size), limit: size });
        const processed = new Set([...report.projects, ...report.errors].map(item => item.projectId));
        queued = queued.filter(id => !processed.has(id));
        return report;
      };
      running = run();
      try { return await running; } finally { running = null; }
    },
  };
  return { dependencies, repository, projects, snapshots, service, worker, selectProjectIds };
}
