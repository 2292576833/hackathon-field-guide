import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { FreshSessionGuard } from "../shared/personal-ai.ts";
import { DomainError, isDomainError } from "../shared/errors.ts";
import { createDocumentDrafts } from "../modules/document-drafts/index.ts";
import { createSpaceChangesService } from "../modules/space-changes/index.ts";
import { createTeamSupervisionService } from "../modules/team-supervision/index.ts";
import type { SupervisionFacts } from "../modules/team-supervision/model.ts";
import { missionTaskChecked } from "../modules/space-workflow/mission-workbench.ts";
import { authorizeSpaceCollaboration } from "./space-collaboration-access.ts";
import type { createSpaceDocuments } from "./space-documents.ts";
import type { createTeamMissionServices } from "./team-mission.ts";
import type { ProjectsService } from "../modules/projects/service.ts";
import type { PlanningService } from "../modules/planning/service.ts";
import type { ProjectCollaborationService } from "../modules/projects/collaboration.ts";

type TeamAssistant = ReturnType<typeof createTeamMissionServices>["teamAssistant"];
/** The original assistant persists its outcome before rejecting. Preserve a
 * proven rollback/received response when a teammate changes facts mid-answer,
 * while running/unknown or unavailable receipts remain conservative holds. */
export function createSupervisionAssistantBridge(database: DatabasePort, assistant: TeamAssistant) {
  return { conversation: (actor: Actor, projectId: string, guard?: FreshSessionGuard) => assistant.conversation(actor, projectId, guard),
    async send(actor: Actor, projectId: string, input: Parameters<TeamAssistant["send"]>[2], guard?: FreshSessionGuard) {
      try { return await assistant.send(actor, projectId, input, guard); }
      catch (reason) {
        let outcome: "not_sent" | "response_received" | null = null;
        try {
          const row = (await database.query<{status:string}>("SELECT status FROM team_assistant_requests WHERE user_id=$1 AND project_id=$2 AND request_id=$3",[actor.userId,projectId,input.requestId])).rows[0];
          if (!row) outcome = "not_sent"; else if (row.status === "failed") outcome = "response_received";
        } catch { /* An unavailable receipt never proves the paid outcome. */ }
        if (!outcome) throw reason;
        const cause = isDomainError(reason) ? reason : new DomainError("ASSISTANT_REQUEST_FAILED","这次没有得到当前版本的可用建议，请核对空间记录。",{status:503});
        const classified = new DomainError(cause.code,cause.message,{status:cause.status});
        Object.assign(classified,{externalState:outcome}); throw classified;
      }
    } };
}
export function createSpaceCollaboration(deps: { database: DatabasePort; clock: Clock; ids: IdGenerator;
  projects: Pick<ProjectsService, "getProject">; planning: Pick<PlanningService, "getCurrent">;
  collaboration: Pick<ProjectCollaborationService, "getMyIntention">; teamAssistant: TeamAssistant; spaceDocuments: ReturnType<typeof createSpaceDocuments> }) {
  const { database, clock, ids, projects, planning, collaboration, teamAssistant } = deps;
  async function authorize(sql: SqlExecutor, actor: Actor, projectId: string, write: boolean, guard?: FreshSessionGuard) {
    const access = await authorizeSpaceCollaboration(sql, actor, projectId, write, guard);
    if (write && access.archived) throw new DomainError("PROJECT_ARCHIVED", "空间已归档，记录只读。", { status: 409 });
    return access;
  }
  const drafts = createDocumentDrafts({ database, clock, async authorize(sql, actor, projectId, write, guard) { await authorize(sql, actor, projectId, write, guard); }, writer: {
    async write(sql, actor, projectId, input, guard) {
      await authorize(sql, actor, projectId, true, guard);
      const document = input.documentId === null
        ? await deps.spaceDocuments.create(actor, projectId, { title: input.title, body: input.body })
        : await deps.spaceDocuments.update(actor, projectId, input.documentId, { body: input.body, expectedRevision: input.expectedRevision });
      await authorize(sql, actor, projectId, true, guard);
      return { id: document.id, revision: document.revision };
    } } });
  async function sharedFacts(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard) {
    await authorize(sql, actor, projectId, false, guard);
    const detail = await projects.getProject(actor, projectId);
    const current = await planning.getCurrent(actor, projectId);
    const active = detail.members.filter(member => member.projectId === projectId && member.status === "active");
    // Only public display names of the authorized active roster; no email,
    // profile, assessment or other-space identity lookup.
    const names = await sql.query<{ id: string; display_name: string }>(
      "SELECT u.id,u.display_name FROM auth_users u JOIN projects_project_membership m ON m.user_id=u.id WHERE m.project_id=$1 AND m.status='active' AND u.status='active' AND u.email_verified_at IS NOT NULL ORDER BY u.id", [projectId]);
    const byUser = new Map(names.rows.map(row => [row.id, row.display_name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60)]));
    const members = active.map((member, index) => ({ ...member, displayName: byUser.get(member.userId) || `队友 ${index + 1}` }));
    const effective = current.plan?.projectId === projectId && current.plan.inputSnapshot.projectId === projectId
      && current.plan.status === "applied" && !current.inputVersionsChanged && Boolean(current.evaluation?.structuralValid);
    return { detail, current, members, effective };
  }
  const supervision = createTeamSupervisionService({ database, clock, assistant: createSupervisionAssistantBridge(database,teamAssistant),
    facts: { async authorize(sql, actor, projectId, write, guard) { await authorize(sql, actor, projectId, write, guard); },
      async readFacts(sql, actor, projectId, guard): Promise<SupervisionFacts> {
        const { detail, current, effective } = await sharedFacts(sql, actor, projectId, guard);
        const own = await collaboration.getMyIntention(actor, projectId);
        const context = await teamAssistant.getContext(actor, projectId, guard);
        const confirmed = Boolean(own.intention && !own.needsConfirmation && own.intention.userId === actor.userId
          && own.intention.membershipRevision === detail.membership.revision && own.intention.duties.length);
        const snapshot = current.plan?.inputSnapshot;
        return { projectId, projectName: detail.project.name, archived: detail.project.stage === "archived",
          membershipId: detail.membership.membershipId, userId: actor.userId, membershipStatus: detail.membership.status,
          responsibility: { confirmed, version: String(own.intention?.revision ?? 0), summary: confirmed ? own.intention!.duties.join("、") : "本人职责尚未确认" },
          plan: { id: current.plan?.id ?? null, version: String(current.plan?.revision ?? 0), status: !current.plan ? "missing" : current.plan.status !== "applied" ? "draft" : effective ? "active" : "stale" },
          version: context.fingerprint,
          // Schedule times come from the saved confirmed validation, never a
          // clock-dependent recalculation that would trigger a new paid run.
          tasks: (effective ? current.tasks : []).filter(task => task.projectId === projectId).map(task => ({
            id: task.id, title: task.title, status: task.status, ownerMembershipId: task.ownerMembershipId,
            reviewerMembershipId: task.reviewerMembershipId, dependencyTaskIds: task.dependencyTaskIds,
            accepted: missionTaskChecked(task), blocker: task.blocker,
            deadlineAt: snapshot?.deadlines.find(deadline => deadline.id === task.deadlineRef)?.instantUtc ?? null,
            scheduledFinishAt: current.plan?.validation?.likely.scheduled.find(item => item.taskId === task.id)?.finishesAt ?? null,
          })) };
      } } });
  function changes(guard: FreshSessionGuard) {
    return createSpaceChangesService({ database, clock, ids,
      authorize: (sql, actor, projectId, write) => authorize(sql, actor, projectId, write, guard),
      async readFacts(sql, access) {
        const actor: Actor = { userId: access.userId, platformRoles: ["user"] };
        const { detail, current, members, effective } = await sharedFacts(sql, actor, access.projectId, guard);
        const users = new Map(members.map(member => [member.membershipId, member.userId]));
        return { projectId: access.projectId, projectRevision: detail.project.revision, goal: detail.project.goal,
          minimumDeliverable: detail.project.minimumDeliverable, deadline: detail.project.deadline, members,
          currentPlan: effective ? { id: current.plan!.id, revision: current.plan!.revision,
            tasks: current.tasks.filter(task => task.projectId === access.projectId && task.status !== "cancelled").map(task => ({
              id: task.id, title: task.title, ownerUserId: task.ownerMembershipId ? users.get(task.ownerMembershipId) ?? null : null,
              reviewerUserId: task.reviewerMembershipId ? users.get(task.reviewerMembershipId) ?? null : null,
            })) } : null };
      } });
  }
  return { drafts, supervision, changes };
}
