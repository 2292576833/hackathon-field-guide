import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { PersonalAiPort } from "../shared/personal-ai.ts";
import { DomainError } from "../shared/errors.ts";
import type { ProjectsService, PostgresProjectsRepository, ProjectCollaborationService } from "../modules/projects/index.ts";
import type { PlanningService } from "../modules/planning/index.ts";
import type { PlanningFactsPort } from "../modules/planning/ports.ts";
import type { ParticipantService } from "../modules/participant/index.ts";
import { createRecruitingService } from "../modules/recruiting/service.ts";
import { TeamCollaborationService } from "../modules/team-collaboration/service.ts";
import { PostgresTeamCollaborationRepository } from "../modules/team-collaboration/postgres.ts";
import { createTeamAssistantService } from "../modules/team-assistant/service.ts";
import type { TeamAssistantDshRunnerPort } from "../modules/team-assistant/ports.ts";
import type { TeamCollaborationAccessPort, TeamShareSourcePort } from "../modules/team-collaboration/ports.ts";
import { createTeamAssistantContextPorts } from "./team-assistant-context.ts";

interface Dependencies {
  database: DatabasePort; clock: Clock; ids: IdGenerator; configured: boolean;
  projects: ProjectsService; projectRepository: PostgresProjectsRepository;
  collaboration: ProjectCollaborationService; planning: PlanningService;
  planningFacts: Pick<PlanningFactsPort, "lockVersions">;
  participantProfiles: ParticipantService; personalAi: PersonalAiPort;
  officialRules: Parameters<typeof createTeamAssistantContextPorts>[0]["officialRules"];
}
/** Root composition supplies current identity/space facts and the existing budgeted DSH runtime. */
export function createTeamMissionServices(deps: Dependencies) {
  const { database, clock, ids, projects, projectRepository, personalAi } = deps;
  async function requireActive(sql: SqlExecutor, actor: Actor) {
    const account = await sql.query<{ display_name: string; email: string }>(
      "SELECT display_name,email FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (!account.rows[0]) throw new DomainError("UNAUTHENTICATED", "账号当前无法使用，请重新登录。", { status: 401 });
    return account.rows[0];
  }
  const recruiting = createRecruitingService({ database, clock, ids, ai: personalAi,
    identity: {
      async requireActive(sql, actor) { const account = await requireActive(sql, actor); return { displayName: account.display_name }; },
      async isActive(sql, userId) { return !!(await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [userId])).rowCount; },
    },
    participant: { readOwn: (_sql, actor) => deps.participantProfiles.get(actor) },
    projects: {
      async inspect(sql, projectId, userId) {
        const p = await sql.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1 FOR UPDATE", [projectId]);
        if (!p.rows[0]) return null;
        const membership = await projectRepository.getMembership(projectId, userId);
        return { projectId, archived: p.rows[0].stage === "archived", membership };
      },
      async joinApproved(sql, input) {
        const account = await requireActive(sql, input.actor);
        await requireActive(sql, { userId: input.approvedBy, platformRoles: ["user"] });
        const approver = { userId: input.approvedBy, platformRoles: ["user"] } satisfies Actor;
        const detail = await projects.getProject(approver, input.projectId);
        if (detail.membership.role !== "manager" || detail.project.stage === "archived")
          throw new DomainError("RECRUITING_APPROVAL_UNAVAILABLE", "原审批人已无管理权限，或空间已归档，请联系当前管理员重新处理。", { status: 409 });
        // This port is invoked only for a locked, approved application belonging to the applicant.
        // Reuse M02's one-use, verified-email admission so it remains the sole membership owner.
        const issued = await projects.createProjectInvitation(approver, input.projectId, {
          expectedRevision: detail.project.revision, role: "member", invitedEmail: account.email, maxUses: 1,
          expiresAt: new Date(clock.now().getTime() + 5 * 60_000).toISOString(),
        });
        const joined = await projects.acceptInvitation(input.actor, issued.token);
        if (joined.scopeType !== "project" || joined.scopeId !== input.projectId || joined.membership.role !== "member")
          throw new DomainError("RECRUITING_JOIN_CHANGED", "加入状态已变化，请重新读取申请。", { status: 409 });
        return { membershipId: joined.membership.membershipId, role: "member", status: "active" };
      },
    },
  });
  // Resolved lazily only by a new publication, after all services are composed.
  // The metadata resolver below stays independent of full AI context reads.
  let teamAssistant: ReturnType<typeof createTeamAssistantService>;
  const sources: TeamShareSourcePort = {
    async validateNewPublication({ actor, projectId, source }) {
      if (source.sourceKind === "feasibility" && source.sourceId) {
        await teamAssistant.getShareSource(actor, projectId, "feasibility", source.sourceId);
      }
    },
    async verifySource(input, sql) {
      const { source, ownerUserId, projectId } = input;
      if (!(await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [ownerUserId])).rowCount) return null;
      if (source.sourceKind === "manual") return source.sourceId === null ? { ...source, label: "成员备注", revision: 1 } : null;
      if (typeof source.sourceId !== "string" || !source.sourceId) return null;
      if (source.sourceKind === "navigator") {
        if (!/^\d{1,20}$/.test(source.sourceId)) return null;
        const row = (await sql.query<{ project_id: string | null }>(
          "SELECT m.project_id FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE m.id=$1 AND s.user_id=$2 AND m.role='assistant' FOR SHARE OF m,s", [source.sourceId, ownerUserId])).rows[0];
        if (!row) return null;
        if (row.project_id) {
          const original = await projectRepository.getMembershipForShare(sql, row.project_id, ownerUserId);
          if (original?.status !== "active") return null;
        }
        return { ...source, label: "本人导航员回答", revision: 1 };
      }
      if (source.sourceKind === "space_assistant") {
        const row = await sql.query(
          "SELECT m.id FROM team_assistant_messages m JOIN team_assistant_requests r ON r.user_id=m.user_id AND r.project_id=m.project_id AND r.request_id=m.request_id WHERE m.user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.role='assistant' AND m.provider='dsh' AND r.status='succeeded' FOR SHARE OF m,r", [ownerUserId, projectId, source.sourceId]);
        return row.rowCount ? { ...source, label: "本人空间 AI 回答", revision: 1 } : null;
      }
      if (source.sourceKind === "feasibility") {
        const row = await sql.query<{ created_at: string | Date }>(
          "SELECT a.created_at FROM personal_ai_artifacts a JOIN ai_execution_jobs j ON j.id=a.id JOIN personal_dsh_sessions s ON s.id=a.session_id AND s.user_id=a.user_id WHERE a.user_id=$1 AND a.id=$2 AND a.kind='project_feasibility' AND a.data->>'projectId'=$3 AND j.actor_id=a.user_id AND j.kind='personal_artifact' AND j.module_job_id=a.id AND j.project_id=$4 AND j.status='succeeded' FOR SHARE OF a,j,s", [ownerUserId, source.sourceId, projectId, `navigator-user:${ownerUserId}`]);
        return row.rows[0] ? { ...source, label: `本人选题检查报告（${new Date(row.rows[0].created_at).toISOString()} 生成时资料快照）`, revision: 1 } : null;
      }
      return null;
    },
  };
  const access: TeamCollaborationAccessPort = {
    async withMutationScope(projectId, actor, work) {
      return database.transaction(async sql => {
        // Use the same executor/savepoints, always planning/M04 → M02 → feed.
        await access.lockAccess(projectId, actor, sql);
        return work();
      });
    },
    async lockAccess(projectId, actor, sql) {
      await requireActive(sql, actor);
      if ((await projectRepository.getMembership(projectId, actor.userId))?.status !== "active")
        throw new DomainError("PROJECT_ACCESS_DENIED", "你当前不是此空间的成员。", { status: 403 });
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`planning:${projectId}`]);
      await deps.planningFacts.lockVersions(projectId, sql, actor);
      const membership = await projectRepository.getMembershipForUpdate(sql, projectId, actor.userId);
      if (membership?.status !== "active") throw new DomainError("PROJECT_ACCESS_DENIED", "你当前不是此空间的成员。", { status: 403 });
      const state = await sql.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1", [projectId]);
      return { membership, readOnly: state.rows[0]?.stage === "archived" };
    },
  };
  const teamCollaboration = new TeamCollaborationService({ repository: new PostgresTeamCollaborationRepository(database), clock, ids, sources,
    access,
    activities: { async readActivities(projectId, actor, _sql, limit) {
      const current = await deps.planning.getCurrent(actor, projectId), progress = await deps.planning.listProgress(actor, projectId);
      return [...progress].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(item => ({
        kind: "task" as const, id: item.id, taskId: item.taskId,
        title: current.tasks.find(task => task.id === item.taskId)?.title ?? "历史任务",
        actorUserId: item.actorId, occurredAt: item.createdAt, status: item.status, note: item.note,
        evidenceRefs: item.evidenceRefs, checked: item.status === "done" && !!item.acceptance,
      }));
    } },
  });
  const contextPorts = createTeamAssistantContextPorts({ database, clock,
    projects: { getProject: (actor, projectId) => projects.getProject(actor, projectId),
      listProjects: actor => projects.listProjects(actor),
      getMembership: (projectId, userId, sql) => sql ? projectRepository.getMembershipForShare(sql, projectId, userId) : projects.getMembership(projectId, userId) },
    planning: deps.planning, planningFacts: deps.planningFacts,
    collaboration: deps.collaboration, officialRules: deps.officialRules, participantProfiles: deps.participantProfiles,
    recruiting: { getPrivateProfile: (actor, guard) => recruiting.readPrivateProfile(actor, guard) },
    teamCollaboration: { async readShared(actor, projectId) {
      return (await teamCollaboration.listSharedContext(actor, projectId)).map(item => ({
        id: item.id, projectId, authorUserId: item.authorUserId, revision: item.revision,
        title: item.title, body: `来源：${item.source.label}。${item.source.sourceKind === "feasibility" ? "这是生成时资料的检查建议，须结合当前项目与实际验证复核。" : "这是成员主动分享并可编辑的摘录，不等于团队已经采纳。"}\n${item.body}`, status: item.status,
        updatedAt: item.updatedAt, sourceKind: item.source.sourceKind, sourceId: item.source.sourceId, sourceRevision: item.source.revision,
      }));
    } },
  });
  const runner: TeamAssistantDshRunnerPort = {
    configured: deps.configured,
    async run(actor, request, guard) {
      const artifact = await personalAi.generate(actor, {
        kind: "space_assistant_reply", title: "个人空间 AI 回答", input: request.input,
        requestIdentity: request.requestIdentity, systemPrompt: request.systemPrompt,
        promptVersion: request.promptVersion, outputExample: request.outputExample,
        maxOutputTokens: request.maxOutputTokens,
        validate: value => ({ projectId: request.projectId, answer: request.validate(value) }),
      }, async sql => { await guard?.(sql); await request.finalGuard(sql); });
      return { executionId: artifact.id, provider: "dsh", data: artifact.data.answer };
    },
  };
  teamAssistant = createTeamAssistantService({ database, clock, ids, ...contextPorts, runner, personalAi });
  return { recruiting, teamCollaboration, teamAssistant };
}
