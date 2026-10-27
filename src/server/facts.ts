import type { Actor, ProjectMembershipAccess } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { planningProjectFactsVersion } from "./planning-project-facts.ts";
import type { AssignmentContextPort, AssignmentContextSnapshot, AssignmentVersion, PostgresAssessmentRepository, AssessmentService } from "../modules/assessments/index.ts";
import { contextFingerprint } from "../modules/assessments/index.ts";
import type { EventRuleVersion, EventsService, PostgresEventsRepository, ProjectRuleConfirmation } from "../modules/events/index.ts";
import { isVerifiedRuleEvidence, PostgresOfficialTrackRulesPort, type ProjectOfficialTrackRulesPort } from "../modules/events/index.ts";
import type { ConfirmedRequirementsPort, DeliveryService, GitService } from "../modules/github/index.ts";
import type { InputVersions, PlanningFactsPort, PlanningInput, PlanningRepository, PlanningDeadline, PlanningRequirement, PlanningState } from "../modules/planning/index.ts";
import { availabilityFromProjectCollection } from "../modules/planning/index.ts";
import { PostgresProjectCollaborationRepository, sharedIntention, type ProjectCollaborationRepository, type PostgresProjectsRepository, type ProjectsService } from "../modules/projects/index.ts";
import type { ResourceService, Resource } from "../modules/resources/index.ts";
import { isReviewedResource } from "../modules/resources/index.ts";
import type { EvidenceAccessPort, EvidenceRef, EvidenceState, FinalFactsLockPort, FinalFactsSnapshot } from "../modules/retrospectives/index.ts";

export interface FactAdapterDependencies {
  database: DatabasePort;
  projectRepository: PostgresProjectsRepository;
  projects: ProjectsService;
  eventsRepository: PostgresEventsRepository;
  events: EventsService;
  assessmentRepository: PostgresAssessmentRepository;
  assessments: AssessmentService;
  resources: ResourceService;
  planningRepository: PlanningRepository;
  git: GitService;
  delivery: DeliveryService;
  collaborationRepository?: ProjectCollaborationRepository;
  officialTrackRules?: ProjectOfficialTrackRulesPort;
}

/** Includes the project confirmation revision: re-confirming a snapshot invalidates old inputs. */
export function confirmedRequirementVersionId(confirmation: ProjectRuleConfirmation): string {
  return `${confirmation.eventId}:${confirmation.rulesVersion}:${confirmation.revision}`;
}

type ProjectContext = Awaited<ReturnType<PostgresProjectsRepository["getPlanningContextForUpdate"]>>;
type ConfirmedRules = { confirmation: ProjectRuleConfirmation | null; rules: EventRuleVersion | null };

function notFound(): never { throw new DomainError("PROJECT_NOT_FOUND", "项目不存在或不可访问。", { status: 404 }); }
function checkProjectId(projectId: string): void {
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 200) notFound();
}
function requireActor(actor: Actor): void {
  if (!actor?.userId) throw new DomainError("AUTHENTICATION_REQUIRED", "请先登录。", { status: 401 });
}
function unavailable(ref: EvidenceRef, projectId: string): EvidenceState { return { ref, projectId, state: "unavailable", projectShareable: false }; }
function evidenceState(ref: EvidenceRef, projectId: string, revision: number, title: string, withdrawn = false, outdated = false): EvidenceState {
  return { ref, projectId, state: withdrawn ? "withdrawn" : revision !== ref.revision || outdated ? "outdated" : "available", projectShareable: true, title };
}

/** All repositories must receive this same DatabasePort. Ambient queries and nested repository
 * transactions then reuse the caller's SQL connection, retaining locks until the outer commit.
 * These adapters are server-only composition ports, never public unscoped query endpoints.
 */
export function createFactAdapters(dependencies: FactAdapterDependencies): {
  assignmentContext: AssignmentContextPort;
  planningFacts: PlanningFactsPort;
  requirements: ConfirmedRequirementsPort;
  evidence: EvidenceAccessPort;
  finalFactsLock: FinalFactsLockPort;
  readInputForNotifications(projectId: string, now: string, actor: Actor, sql: SqlExecutor): Promise<PlanningInput>;
} {
  const d = dependencies;
  const collaboration = d.collaborationRepository ?? new PostgresProjectCollaborationRepository();
  const officialTrackRules = d.officialTrackRules ?? new PostgresOfficialTrackRulesPort();

  async function projectContext(sql: SqlExecutor, projectId: string, userId?: string): Promise<ProjectContext> {
    checkProjectId(projectId);
    if (userId === undefined) {
      // AssignmentContextPort is an internal fact port without an Actor. M04 checks the real
      // caller against the returned current context before reading or mutating any private data.
      await sql.query("SELECT id FROM projects_project WHERE id=$1 FOR UPDATE", [projectId]);
      const active = await sql.query<{ user_id: string }>("SELECT user_id FROM projects_project_membership WHERE project_id=$1 AND status='active' ORDER BY membership_id LIMIT 1", [projectId]);
      userId = active.rows[0]?.user_id;
      if (!userId) notFound();
    }
    return d.projectRepository.getPlanningContextForUpdate(sql, projectId, userId);
  }

  async function confirmedRules(sql: SqlExecutor, projectId: string): Promise<ConfirmedRules> {
    // Project is already locked. M03 confirms using that same project-first lock order, so
    // an absent confirmation is protected against concurrent insertion as well.
    await sql.query("SELECT id FROM m03_project_rules WHERE id=$1 FOR UPDATE", [projectId]);
    const confirmation = await d.eventsRepository.getConfirmation(projectId);
    if (!confirmation) return { confirmation: null, rules: null };
    const rules = await d.eventsRepository.getRules(confirmation.eventId, confirmation.rulesVersion);
    if (!rules || rules.eventId !== confirmation.eventId || rules.version !== confirmation.rulesVersion) {
      throw new DomainError("CONFIRMED_RULES_UNAVAILABLE", "已确认规则暂时无法读取，请核对赛事规则。", { status: 503 });
    }
    return { confirmation, rules };
  }

  async function assignmentSnapshot(context: ProjectContext, confirmed: ConfirmedRules, sql: SqlExecutor): Promise<AssignmentContextSnapshot> {
    const availability = new Map(context.availability.map(item => [item.userId, item]));
    const intentions = new Map((await collaboration.listIntentions(sql, context.project.id)).map(item=>[item.userId,item]));
    const selection = await collaboration.getSelection(sql, context.project.id);
    const rules = await officialTrackRules.getProjectTrackRules(context.project.id, sql);
    const needsReview = !selection || !rules || !["confirmed","none"].includes(rules.catalog.status)
      || selection.eventId !== rules.eventId || selection.rulesVersion !== rules.rulesVersion || selection.confirmationRevision !== rules.confirmationRevision
      || (rules.latestPublishedRulesVersion !== null && rules.latestPublishedRulesVersion !== rules.rulesVersion)
      || selection.catalogStatus !== rules.catalog.status || (selection.trackId !== null && !rules.catalog.tracks.some(item=>item.id===selection.trackId));
    return {
      projectId: context.project.id, projectRevision: context.project.revision,
      // M02 increments Project.revision for every membership/role/time change.
      membershipRevision: context.project.revision,
      requirementVersionId: confirmed.confirmation ? confirmedRequirementVersionId(confirmed.confirmation) : null,
      readOnly: context.project.stage === "archived",
      stage: context.project.stage,
      officialTracks: rules ? {eventId:rules.eventId,rulesVersion:rules.rulesVersion,confirmationRevision:rules.confirmationRevision,
        catalogStatus:rules.catalog.status,selectedTrackId:selection?.trackId??null,needsReview,tracks:structuredClone(rules.catalog.tracks),evidenceIds:[...rules.catalog.evidenceIds]} : null,
      trackSelectionRevision: selection?.revision ?? null,
      memberIntentionRefs: context.members.filter(member=>member.status==="active").flatMap(member=>{
        const intention=intentions.get(member.userId);return intention ? [{membershipId:member.membershipId,revision:intention.revision}] : [];
      }),
      confirmedRequirements: confirmed.rules?.requirements.map(item=>({id:item.id,text:item.label,evidenceIds:[...item.evidenceIds]}))??[],
      members: context.members.filter(member=>member.status==="active").map(member => {
        const collection = availability.get(member.userId);
        const current = member.status === "active" && collection?.membershipRevision === member.revision;
        const intention = intentions.get(member.userId);
        const shared = intention?.membershipRevision===member.revision ? sharedIntention(intention) : undefined;
        return { membershipId: member.membershipId, userId: member.userId, role: member.role, status: member.status,
          memberAvailabilityVersionId: current && collection ? `${collection.id}:${collection.revision}:${collection.membershipRevision}` : null,
          availableMinutes: current && collection ? collection.effectiveMinutes : null,
          ...(shared ? {sharedIntention:{revision:shared.revision,membershipRevision:shared.membershipRevision,
            ...(shared.duties===undefined?{}:{duties:shared.duties}),...(shared.experience===undefined?{}:{experience:shared.experience}),
            ...(shared.wantsAiHelp===undefined?{}:{wantsAiHelp:shared.wantsAiHelp}),...(shared.helpQuestion===undefined?{}:{helpQuestion:shared.helpQuestion})}} : {}) };
      }),
    };
  }

  const assignmentContext: AssignmentContextPort = {
    async getSnapshot(projectId, transaction) {
      const read = async (sql: SqlExecutor) => {
        const context = await projectContext(sql, projectId);
        return assignmentSnapshot(context, await confirmedRules(sql, projectId), sql);
      };
      return transaction ? read(transaction) : d.database.transaction(read);
    },
  };

  async function protectedVersions(projectId: string, sql: SqlExecutor, actor: Actor, protectAssignmentHead = true): Promise<{ context: ProjectContext; confirmed: ConfirmedRules; versions: InputVersions }> {
    requireActor(actor); checkProjectId(projectId);
    // Shared lock order with M04: assignment head -> M02 project/context -> M03 pointer.
    // The root DatabasePort's nested transaction is a savepoint on this same connection.
    const head = protectAssignmentHead
      ? await d.assessmentRepository.transaction(transaction => transaction.getHead(projectId, false))
      : { versionId: (await sql.query<{version_id:string|null}>("SELECT version_id FROM assessments_assignment_heads WHERE project_id=$1", [projectId])).rows[0]?.version_id ?? null };
    const context = await projectContext(sql, projectId, actor.userId);
    const confirmed = await confirmedRules(sql, projectId);
    const collaborationSnapshot = await assignmentSnapshot(context, confirmed, sql);
    const versions: InputVersions = {
      projectRevision: context.project.revision,
      projectFactsVersion: planningProjectFactsVersion(context.project, context.members),
      requirementVersionId: confirmed.confirmation ? confirmedRequirementVersionId(confirmed.confirmation) : null,
      assignmentVersionId: head.versionId,
      trackSelectionRevision: collaborationSnapshot.trackSelectionRevision,
      memberIntentionRefs: collaborationSnapshot.memberIntentionRefs?.map(item=>({...item})),
      projectArchived: context.project.stage === "archived",
      projectReadOnly: context.project.stage === "archived",
      availabilityVersions: Object.fromEntries(context.members.filter(member => member.status === "active").flatMap(member => {
        const collection = context.availability.find(item => item.userId === member.userId);
        return collection?.membershipRevision===member.revision ? [[member.membershipId, collection.revision]] : [];
      })),
    };
    return { context, confirmed, versions };
  }

  function planningRules(context: ProjectContext, confirmed: ConfirmedRules): Pick<PlanningInput, "deadlines" | "requirements" | "assumptions" | "requiredTaskKinds"> {
    const deadlines: PlanningDeadline[] = []; const requirements: PlanningRequirement[] = []; const assumptions: string[] = [];
    const rules = confirmed.rules;
    if (!rules) assumptions.push("赛事规则尚未确认；资格、必交材料、官方截止与提交入口仍无法确认。");
    if (rules) {
      for (const stage of rules.stages) {
        const moment = stage.endsAt;
        const verified = !!moment?.utc && !!moment.timeZone && !moment.dateOnly && moment.evidenceIds.length > 0 && moment.evidenceIds.every(id => isVerifiedRuleEvidence(rules, id));
        deadlines.push({ id: stage.id, kind: stage.stageType === "registration" ? "registration" : stage.stageType === "submission" ? "submission" : stage.stageType === "pitch" ? "demo" : "other",
          instantUtc: moment?.utc ?? "", sourceTimeZone: moment?.timeZone ?? "", sourceText: moment?.rawText ?? "", verified });
        if (!verified) assumptions.push(`阶段「${stage.name}」的精确截止尚未核验。`);
      }
      for (const requirement of rules.requirements) {
        const deadlineRef = requirement.stageId ?? "unassigned-requirements";
        if (!deadlines.some(item => item.id === deadlineRef)) deadlines.push({ id: deadlineRef, kind: "other", instantUtc: "", sourceTimeZone: "", sourceText: "", verified: false });
        // Unknown necessity is retained conservatively; never silently treated as optional.
        requirements.push({ id: requirement.id, deadlineRef, description: requirement.label, mandatory: requirement.necessity !== "optional" });
        if (requirement.necessity === "unknown") assumptions.push(`材料「${requirement.label}」是否必交无法确认，暂按必须准备保留。`);
        if (!requirement.stageId) assumptions.push(`材料「${requirement.label}」的对应提交阶段无法确认。`);
      }
      for (const fact of rules.facts) if (fact.status !== "verified") assumptions.push(`规则「${fact.key}」仍为${fact.status}，需核对官方证据。`);
      if (rules.qualityFlags.length) assumptions.push(`赛事资料仍有质量提示：${rules.qualityFlags.join("、")}。`);
    }
    // A user's local target is useful even without an event; it remains explicitly unverified.
    if (context.project.deadline) {
      deadlines.push({ id: "project-manual-target", kind: "other", instantUtc: context.project.deadline, sourceTimeZone: context.project.timezone,
        sourceText: "项目成员手填目标截止", verified: false });
      assumptions.push("项目成员手填截止仅为内部目标，不能替代官方核验截止。");
    }
    // Website's explicit minimum workflow policy; zero buffers must still be confirmed by the plan.
    return { deadlines, requirements, assumptions, requiredTaskKinds: ["integration", "testing", "material", "submission"] };
  }

  async function readPlanningInput(projectId: string, now: string, actor: Actor, sql: SqlExecutor, protectAssignmentHead = true): Promise<PlanningInput> {
      if (!Number.isFinite(Date.parse(now))) throw new DomainError("INVALID_TIME", "规划读取时间无效。");
        const { context, confirmed, versions } = await protectedVersions(projectId, sql, actor, protectAssignmentHead);
        const members = context.members.filter(member => member.status === "active");
        const availability = members.flatMap(member => {
          const collection = context.availability.find(item => item.userId === member.userId);
          return collection ? [availabilityFromProjectCollection(collection, member)] : [];
        });
        const bookmarked = await sql.query<{ resource_id: string }>("SELECT resource_id FROM projects_resource_bookmark WHERE project_id=$1 AND status='active' AND resource_id IS NOT NULL ORDER BY resource_id", [projectId]);
        const ids = [...new Set(bookmarked.rows.map(item => item.resource_id))]; const approvedResourceIds: string[] = [];
        // The public M09 port caps one request at 50; acquire publication locks in stable order.
        for (let offset = 0; offset < ids.length; offset += 50) approvedResourceIds.push(...await d.resources.getDisplayableApprovedIds(ids.slice(offset, offset + 50), sql));
        return { ...versions, projectId, capturedAt: new Date(now).toISOString(), members, availability, approvedResourceIds, ...planningRules(context, confirmed) };
  }
  const planningFacts: PlanningFactsPort = {
    async lockVersions(projectId, transaction, actor) { return (await protectedVersions(projectId, transaction, actor)).versions; },
    async readInput(projectId, now, actor) { return d.database.transaction(sql => readPlanningInput(projectId, now, actor, sql)); },
  };

  const requirements: ConfirmedRequirementsPort = {
    async assertConfirmed(input) {
      await d.database.transaction(async sql => {
        await projectContext(sql, input.projectId);
        const { confirmation, rules } = await confirmedRules(sql, input.projectId);
        if (!confirmation || !rules || confirmation.eventId !== input.eventId || confirmedRequirementVersionId(confirmation) !== input.requirementsVersion) {
          throw new DomainError("REQUIREMENTS_NOT_CONFIRMED", "赛事与要求版本不匹配当前项目确认，请先核对规则。", { status: 409, recoveryAction: "confirm_project_rules" });
        }
        const stage = rules.stages.find(item => item.id === input.stageId);
        if (!stage?.submissionUrl) throw new DomainError("SUBMISSION_STAGE_UNCONFIRMED", "该赛事阶段的正式提交入口尚未确认。", { status: 422 });
        let matches = false;
        try { matches = new URL(stage.submissionUrl).toString() === new URL(input.platformUrl).toString(); } catch { /* Untrusted values cannot bypass the exact official target. */ }
        if (!matches) throw new DomainError("SUBMISSION_PLATFORM_MISMATCH", "提交地址与已确认阶段入口不匹配，请核对后记录。", { status: 422 });
      });
    },
  };

  const evidence: EvidenceAccessPort = {
    async resolve(actor, projectId, refs, _audience) {
      checkProjectId(projectId);
      const membership = actor?.userId ? await d.projectRepository.getMembership(projectId, actor.userId) : null;
      if (!membership || membership.status !== "active") return refs.map(ref => unavailable(ref, projectId));
      const states: EvidenceState[] = [];
      // Metadata only. No answers, score bodies, code previews, repository tokens, private URLs,
      // task notes or resource bodies cross this port, for either personal or project audiences.
      for (const ref of refs) {
        if (!ref || !Number.isSafeInteger(ref.revision) || ref.revision < 1 || typeof ref.id !== "string" || !ref.id || ref.id.length > 512) { states.push(unavailable(ref, projectId)); continue; }
        try {
          switch (ref.kind) {
            case "rule": {
              const current = await d.events.getProjectRules(actor, projectId);
              if (!current.confirmation || !current.rules || ![current.rules.eventId, confirmedRequirementVersionId(current.confirmation)].includes(ref.id)) { states.push(unavailable(ref, projectId)); break; }
              states.push(evidenceState(ref, projectId, current.rules.version, "项目已确认赛事规则")); break;
            }
            case "plan": {
              const state = await d.planningRepository.read(projectId); const plan = state?.plans.find(item => item.id === ref.id);
              states.push(plan && plan.projectId === projectId ? evidenceState(ref, projectId, plan.revision, "任务计划版本", false, ["stale", "superseded"].includes(plan.status)) : unavailable(ref, projectId)); break;
            }
            case "task": {
              const state = await d.planningRepository.read(projectId); const task = state?.tasks.find(item => item.id === ref.id);
              states.push(task && task.projectId === projectId ? evidenceState(ref, projectId, task.revision, "项目任务记录", task.status === "cancelled") : unavailable(ref, projectId)); break;
            }
            case "assignment": {
              const assignment = await d.assessments.getAssignment(actor, ref.id);
              states.push(assignment.projectId === projectId ? evidenceState(ref, projectId, assignment.revision, "团队分工版本", false, assignment.status === "superseded" || assignment.inputFreshness === "changed") : unavailable(ref, projectId)); break;
            }
            case "git_save": {
              const operation = await d.git.getOperation(actor, projectId, ref.id);
              states.push(operation.projectId === projectId ? evidenceState(ref, projectId, operation.revision, operation.status === "saved" ? "仓库保存记录" : "仓库保存操作记录（尚未确认保存）") : unavailable(ref, projectId)); break;
            }
            case "delivery_verification": {
              const record = (await d.delivery.listVerifications(actor, projectId)).find(item => item.id === ref.id && item.projectId === projectId);
              states.push(record ? evidenceState(ref, projectId, record.version, "队员记录的运行核验") : unavailable(ref, projectId)); break;
            }
            case "submission": {
              const records = (await d.delivery.listSubmissions(actor, projectId)).filter(item => item.id === ref.id && item.projectId === projectId);
              const record = records.reduce<(typeof records)[number] | null>((latest, item) => !latest || item.version > latest.version ? item : latest, null);
              states.push(record ? evidenceState(ref, projectId, record.version, record.verificationSource === "platform_verified" ? "平台核验提交记录" : "队员记录的赛事提交", record.status === "rejected_or_withdrawn") : unavailable(ref, projectId)); break;
            }
            case "project_resource": {
              const result = await d.database.query<{ revision: number; status: string; resource_id: string | null; resource_version: number | null }>("SELECT revision,status,resource_id,resource_version FROM projects_resource_bookmark WHERE id=$1 AND project_id=$2", [ref.id, projectId]);
              const bookmark = result.rows[0];
              if (!bookmark) { states.push(unavailable(ref, projectId)); break; }
              const resource = bookmark.resource_id ? (await d.resources.getReviewedResources([bookmark.resource_id]))[0] : null;
              states.push(evidenceState(ref, projectId, bookmark.revision, bookmark.resource_id ? "项目共享审核资源引用" : "成员提供的未核验参考链接", bookmark.status === "removed" || (!!bookmark.resource_id && !resource), !!resource && resource.version !== bookmark.resource_version)); break;
            }
            default: states.push(unavailable(ref, projectId));
          }
        } catch (error) {
          // Revoked/nonexistent source visibility is a safe unavailable reference. Infrastructure
          // failures must propagate so callers never confirm an outage as permanent missing data.
          if (error instanceof DomainError && [401, 403, 404].includes(error.status)) states.push(unavailable(ref, projectId));
          else throw error;
        }
      }
      const fresh = await d.projectRepository.getMembership(projectId, actor.userId);
      return fresh?.status === "active" ? states : refs.map(ref => unavailable(ref, projectId));
    },
  };

  const finalFactsLock: FinalFactsLockPort = {
    async lock(request, sql) {
      requireActor(request.actor);
      const projectIds = [...new Set(request.projectIds)].sort();
      if (projectIds.length > 50 || request.resourceIds.length > 500 || request.evidence.some(group => !projectIds.includes(group.projectId) || group.refs.length > 500)) throw new DomainError("FINAL_FACTS_INVALID", "最终事实锁的范围不完整或超过限制。", { status: 422 });
      for (const id of projectIds) checkProjectId(id);
      const identity = await sql.query<{ status: string }>("SELECT status FROM auth_users WHERE id=$1 FOR SHARE", [request.actor.userId]);
      if (identity.rows[0]?.status !== "active") throw new DomainError("AUTHENTICATION_REQUIRED", "登录身份已失效，请重新登录。", { status: 401 });
      // M05 takes this advisory lock before its planning state row and M04 head. Taking the
      // same sorted coordination locks before the formal root order prevents a head/state
      // lock cycle with progress/plan writers; no nested transaction or document write occurs.
      for (const id of projectIds) await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`planning:${id}`]);
      const heads = new Map<string, string | null>();
      for (const id of projectIds) {
        const head = await sql.query<{ version_id: string | null }>("SELECT version_id FROM assessments_assignment_heads WHERE project_id=$1 FOR UPDATE", [id]);
        heads.set(id, head.rows[0]?.version_id ?? null);
      }
      const projects: FinalFactsSnapshot["projects"][number][] = [];
      const contexts = new Map<string, ProjectContext>();
      for (const id of projectIds) {
        const root = await sql.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1 FOR UPDATE", [id]);
        const row = await sql.query<{ membership_id: string; role: ProjectMembershipAccess["role"]; status: ProjectMembershipAccess["status"] }>("SELECT membership_id,role,status FROM projects_project_membership WHERE project_id=$1 AND user_id=$2", [id, request.actor.userId]);
        const value = row.rows[0];
        const membership: ProjectMembershipAccess | null = root.rows[0] && value ? { membershipId: value.membership_id, projectId: id, userId: request.actor.userId, role: value.role, status: value.status } : null;
        projects.push({ projectId: id, membership, archived: !root.rows[0] || root.rows[0].stage === "archived" });
        if (membership?.status === "active") contexts.set(id, await d.projectRepository.getPlanningContextForUpdate(sql, id, request.actor.userId));
      }
      const confirmations = new Map<string, ConfirmedRules>();
      for (const id of projectIds) {
        const pointer = await sql.query<{ body: ProjectRuleConfirmation }>("SELECT body FROM m03_project_rules WHERE id=$1 FOR UPDATE", [id]);
        confirmations.set(id, { confirmation: pointer.rows[0]?.body ?? null, rules: null });
      }
      // All mutable roots are held before source rows. Rules are immutable historical bodies.
      for (const id of projectIds) {
        const current = confirmations.get(id)!;
        if (current.confirmation) {
          const row = await sql.query<{ body: EventRuleVersion }>("SELECT body FROM m03_rule_versions WHERE event_id=$1 AND version=$2 FOR SHARE", [current.confirmation.eventId, current.confirmation.rulesVersion]);
          current.rules = row.rows[0]?.body ?? null;
        }
      }
      const planning = new Map<string, PlanningState>();
      const summaryRefs = new Map<string, { attemptId: string; revision: number }[]>();
      for (const id of projectIds) {
        const state = await sql.query<{ state_json: PlanningState }>("SELECT state_json FROM planning_states WHERE project_id=$1 FOR UPDATE", [id]);
        if (state.rows[0]?.state_json?.projectId === id) planning.set(id, state.rows[0].state_json);
        // Project lock prevents consent/attempt creation races. Shared row locks additionally
        // protect the exact revisions consumed by an existing assignment's shared-summary refs.
        const attempts = await sql.query<{ id: string; membership_id: string; user_id: string; revision: number; sharing: { confirmedTasks: unknown[]; criterionIds: unknown[] } }>("SELECT id,membership_id,user_id,revision,data->'sharing' AS sharing FROM assessments_attempts WHERE project_id=$1 ORDER BY id FOR SHARE", [id]);
        const context = contexts.get(id);
        summaryRefs.set(id, attempts.rows.filter(attempt => context?.members.some(member => member.status === "active" && member.membershipId === attempt.membership_id && member.userId === attempt.user_id) && (attempt.sharing?.confirmedTasks?.length || attempt.sharing?.criterionIds?.length)).map(attempt => ({ attemptId: attempt.id, revision: attempt.revision })).sort((a, b) => a.attemptId.localeCompare(b.attemptId)));
      }
      type Candidate = { state: EvidenceState; resourceVersion?: { id: string; version: number | null }; resourceRefs?: { resourceId: string; version: number }[] };
      const candidates = new Map<string, Candidate>();
      const resourceIds = new Set(request.resourceIds);
      const groups = [...request.evidence].sort((a, b) => JSON.stringify([a.projectId, a.audience]).localeCompare(JSON.stringify([b.projectId, b.audience])));
      const unique = new Map<string, { projectId: string; ref: EvidenceRef }>();
      const key = (projectId: string, ref: EvidenceRef) => JSON.stringify([projectId, ref.kind, ref.id, ref.revision]);
      for (const group of groups) for (const ref of group.refs) unique.set(key(group.projectId, ref), { projectId: group.projectId, ref });
      for (const [candidateKey, { projectId, ref }] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
        const absent = () => candidates.set(candidateKey, { state: unavailable(ref, projectId) });
        const context = contexts.get(projectId); const confirmed = confirmations.get(projectId)!;
        if (!context || !ref || typeof ref.id !== "string" || !ref.id || ref.id.length > 512 || !Number.isSafeInteger(ref.revision) || ref.revision < 1) { absent(); continue; }
        switch (ref.kind) {
          case "rule": {
            if (!confirmed.rules || !confirmed.confirmation || ![confirmed.rules.eventId, confirmedRequirementVersionId(confirmed.confirmation)].includes(ref.id)) { absent(); break; }
            candidates.set(candidateKey, { state: evidenceState(ref, projectId, confirmed.rules.version, "项目已确认赛事规则") }); break;
          }
          case "plan": {
            const plan = planning.get(projectId)?.plans.find(item => item.id === ref.id && item.projectId === projectId);
            if (!plan) { absent(); break; }
            const requirementVersion = confirmed.confirmation ? confirmedRequirementVersionId(confirmed.confirmation) : null;
            const availability = Object.fromEntries(context.members.filter(member => member.status === "active").flatMap(member => {
              const collection = context.availability.find(item => item.userId === member.userId); return collection?.membershipRevision===member.revision ? [[member.membershipId, collection.revision]] : [];
            }));
            const snapshot = plan.inputSnapshot;
            const currentCollaboration = await assignmentSnapshot(context, confirmed, sql);
            const intentionRefs=(refs: readonly {membershipId:string;revision:number}[]|undefined)=>JSON.stringify((refs??[]).map(ref=>({...ref})).sort((a,b)=>a.membershipId<b.membershipId?-1:a.membershipId>b.membershipId?1:0));
            const stale = ["stale", "superseded"].includes(plan.status) || snapshot.projectRevision !== context.project.revision || snapshot.requirementVersionId !== requirementVersion || snapshot.assignmentVersionId !== heads.get(projectId)
              || (snapshot.trackSelectionRevision??null)!==(currentCollaboration.trackSelectionRevision??null) || intentionRefs(snapshot.memberIntentionRefs)!==intentionRefs(currentCollaboration.memberIntentionRefs)
              || JSON.stringify(Object.entries(snapshot.availabilityVersions).sort()) !== JSON.stringify(Object.entries(availability).sort());
            const refs = plan.tasks.flatMap(task => task.resourceContentRefs ?? []); refs.forEach(item => resourceIds.add(item.resourceId));
            candidates.set(candidateKey, { state: evidenceState(ref, projectId, plan.revision, "任务计划版本", false, stale), resourceRefs: refs }); break;
          }
          case "task": {
            const task = planning.get(projectId)?.tasks.find(item => item.id === ref.id && item.projectId === projectId);
            candidates.set(candidateKey, { state: task ? evidenceState(ref, projectId, task.revision, "项目任务记录", task.status === "cancelled") : unavailable(ref, projectId) }); break;
          }
          case "assignment": {
            const row = await sql.query<{ data: AssignmentVersion }>("SELECT data FROM assessments_assignment_versions WHERE id=$1 AND project_id=$2 FOR UPDATE", [ref.id, projectId]);
            const assignment = row.rows[0]?.data;
            if (!assignment || assignment.projectId !== projectId) { absent(); break; }
            const current = await assignmentSnapshot(context, confirmed, sql);
            const shared = [...assignment.inputSnapshot.sharedSummaryRefs].sort((a, b) => a.attemptId.localeCompare(b.attemptId)).map(item => ({ attemptId: item.attemptId, revision: item.revision }));
            const stale = assignment.status === "superseded" || contextFingerprint(assignment.inputSnapshot) !== contextFingerprint(current) || JSON.stringify(shared) !== JSON.stringify(summaryRefs.get(projectId));
            candidates.set(candidateKey, { state: evidenceState(ref, projectId, assignment.revision, "团队分工版本", false, stale) }); break;
          }
          case "git_save": {
            const row = await sql.query<{ revision: number; status: string }>("SELECT revision,payload->>'status' AS status FROM github_operations WHERE id=$1 AND project_id=$2 FOR UPDATE", [ref.id, projectId]);
            const operation = row.rows[0]; candidates.set(candidateKey, { state: operation ? evidenceState(ref, projectId, operation.revision, operation.status === "saved" ? "仓库保存记录" : "仓库保存操作记录（尚未确认保存）") : unavailable(ref, projectId) }); break;
          }
          case "delivery_verification": {
            const row = await sql.query<{ version: number }>("SELECT version FROM m06_delivery_verifications WHERE id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1 FOR SHARE", [ref.id, projectId]);
            candidates.set(candidateKey, { state: row.rows[0] ? evidenceState(ref, projectId, row.rows[0].version, "队员记录的运行核验") : unavailable(ref, projectId) }); break;
          }
          case "submission": {
            const head = await sql.query<{ version: number }>("SELECT version FROM m06_submission_heads WHERE id=$1 AND project_id=$2 FOR UPDATE", [ref.id, projectId]);
            if (!head.rows[0]) { absent(); break; }
            const row = await sql.query<{ version: number; status: string; verification_source: string }>("SELECT version,status,verification_source FROM m06_submission_versions WHERE id=$1 AND project_id=$2 AND version=$3 FOR SHARE", [ref.id, projectId, head.rows[0].version]);
            const record = row.rows[0]; candidates.set(candidateKey, { state: record ? evidenceState(ref, projectId, record.version, record.verification_source === "platform_verified" ? "平台核验提交记录" : "队员记录的赛事提交", record.status === "rejected_or_withdrawn") : unavailable(ref, projectId) }); break;
          }
          case "project_resource": {
            const row = await sql.query<{ revision: number; status: string; resource_id: string | null; resource_version: number | null }>("SELECT revision,status,resource_id,resource_version FROM projects_resource_bookmark WHERE id=$1 AND project_id=$2 FOR UPDATE", [ref.id, projectId]);
            const bookmark = row.rows[0];
            if (!bookmark) { absent(); break; }
            if (bookmark.resource_id) resourceIds.add(bookmark.resource_id);
            candidates.set(candidateKey, { state: evidenceState(ref, projectId, bookmark.revision, bookmark.resource_id ? "项目共享审核资源引用" : "成员提供的未核验参考链接", bookmark.status === "removed"), ...(bookmark.resource_id ? { resourceVersion: { id: bookmark.resource_id, version: bookmark.resource_version } } : {}) }); break;
          }
          default: absent();
        }
      }
      const published = new Map<string, Resource>();
      for (const id of [...resourceIds].sort()) {
        if (typeof id !== "string" || !id.trim() || id.length > 200) throw new DomainError("FINAL_FACTS_INVALID", "资源事实范围包含无效 ID。", { status: 422 });
        const row = await sql.query<{ public_document: Resource | null }>("SELECT public_document FROM resource_records WHERE id=$1 FOR UPDATE", [id]);
        const resource = row.rows[0]?.public_document;
        if (resource && resource.id === id && isReviewedResource(resource)) published.set(id, resource);
      }
      for (const candidate of candidates.values()) {
        if (candidate.resourceVersion) {
          const current = published.get(candidate.resourceVersion.id);
          if (!current) candidate.state.state = "withdrawn";
          else if (candidate.state.state === "available" && current.version !== candidate.resourceVersion.version) candidate.state.state = "outdated";
        }
        if (candidate.state.state === "available" && candidate.resourceRefs?.some(ref => published.get(ref.resourceId)?.version !== ref.version)) candidate.state.state = "outdated";
      }
      return { projects, evidence: groups.map(group => ({ projectId: group.projectId, audience: group.audience, states: group.refs.map(ref => candidates.get(key(group.projectId, ref))?.state ?? unavailable(ref, group.projectId)) })), reviewedResourceIds: [...published.keys()].sort() };
    },
  };

  return { assignmentContext, planningFacts, requirements, evidence, finalFactsLock,
    // Notification reconciliation already owns planning/project membership roots.
    // Read a missing assignment head without creating or waiting for a newly inserted row.
    readInputForNotifications: (projectId: string, now: string, actor: Actor, sql: SqlExecutor) => readPlanningInput(projectId, now, actor, sql, false),
  };
}
