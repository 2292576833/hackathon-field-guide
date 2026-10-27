import { createHash } from "node:crypto";
import type { Project, ProjectMember } from "../modules/projects/model.ts";

/** Protected M02 facts that affect a plan. Stage/updatedAt are navigation
 * records; archived/readonly remain separate final-write guards in M05. */
export function planningProjectFactsVersion(project: Project, members: readonly ProjectMember[]): string {
  const basis = {
    schemaVersion: 1, projectId: project.id, name: project.name, teamId: project.teamId, eventId: project.eventId,
    goal: project.goal, minimumDeliverable: project.minimumDeliverable, timezone: project.timezone,
    deadline: project.deadline, deadlineSource: project.deadlineSource,
    members: members.filter(member => member.status === "active").map(member => ({
      membershipId: member.membershipId, userId: member.userId, role: member.role, status: member.status, revision: member.revision,
    })).sort((left, right) => left.membershipId.localeCompare(right.membershipId)),
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}
