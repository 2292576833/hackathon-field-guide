import type { Actor } from "../shared/contracts.ts";
import type { Application } from "./application.ts";
import type { EvidenceRef } from "../modules/retrospectives/index.ts";
import { DomainError } from "../shared/errors.ts";

/** Only references and safe titles. Raw answers, source documents and private URLs stay private. */
export async function listEvidenceOptions(application: Application, actor: Actor, projectId: string) {
  await application.projects.getProject(actor, projectId);
  const refs: EvidenceRef[] = [];
  const rules = await application.events.getProjectRules(actor, projectId);
  if (rules.rules && rules.confirmation) refs.push({ kind: "rule", id: rules.rules.eventId, revision: rules.rules.version });
  const planning = await application.planningRepository.read(projectId);
  for (const plan of planning?.plans.slice(-20) ?? []) refs.push({ kind: "plan", id: plan.id, revision: plan.revision });
  for (const task of planning?.tasks.slice(0, 40) ?? []) refs.push({ kind: "task", id: task.id, revision: task.revision });
  const assignments = await application.database.query<{ id: string; revision: number }>("SELECT id,revision FROM assessments_assignment_versions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20", [projectId]);
  for (const assignment of assignments.rows) refs.push({ kind: "assignment", ...assignment });
  for (const operation of (await application.git.listOperations(actor, projectId)).slice(0, 20)) refs.push({ kind: "git_save", id: operation.id, revision: operation.revision });
  for (const verification of (await application.delivery.listVerifications(actor, projectId)).slice(0, 20)) refs.push({ kind: "delivery_verification", id: verification.id, revision: verification.version });
  const latest = new Map<string, Awaited<ReturnType<typeof application.delivery.listSubmissions>>[number]>();
  for (const submission of await application.delivery.listSubmissions(actor, projectId)) if (!latest.has(submission.id) || latest.get(submission.id)!.version < submission.version) latest.set(submission.id, submission);
  for (const submission of [...latest.values()].slice(0, 20)) refs.push({ kind: "submission", id: submission.id, revision: submission.version });
  for (const resource of (await application.projects.listResources(actor, projectId)).slice(0, 30)) refs.push({ kind: "project_resource", id: resource.id, revision: resource.revision });
  return application.database.transaction(async transaction => {
    const facts = await application.facts.finalFactsLock.lock({ actor, operation: "retrospective.create", projectIds: [projectId], evidence: [{ projectId, audience: "project", refs }], resourceIds: [] }, transaction);
    if (!facts.projects[0]?.membership || facts.projects[0].membership.status !== "active") throw new DomainError("FORBIDDEN", "项目访问权限已变化。", { status: 403 });
    return { items: (facts.evidence[0]?.states ?? []).filter(state => state.state === "available" && state.projectShareable).map(state => ({ ...state.ref, title: state.title ?? "项目记录", projectShareable: state.projectShareable })) };
  });
}
