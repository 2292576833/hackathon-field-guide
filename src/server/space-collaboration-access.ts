import type { Actor } from "../shared/contracts.ts";
import type { SqlExecutor } from "../shared/persistence.ts";
import type { FreshSessionGuard } from "../shared/personal-ai.ts";
import { DomainError } from "../shared/errors.ts";

/** Root-owned admission port for private drafts, change receipts and AI watch.
 * A project membership remains the only source of access; names, mail and
 * organizer roles never authorize a team-space read or write. */
export async function authorizeSpaceCollaboration(sql: SqlExecutor, actor: Actor, projectId: string, write = false, guard?: FreshSessionGuard) {
  if (!actor?.userId || typeof projectId !== "string" || !projectId || projectId.length > 250 || /[\s\u0000-\u001f]/.test(projectId))
    throw new DomainError("INVALID_INPUT", "请重新打开正确的团队空间。", { status: 422 });
  await guard?.(sql);
  const account = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
  if (!account.rowCount) throw new DomainError("UNAUTHENTICATED", "账号已失效，请重新登录。", { status: 401 });
  const project = await sql.query<{ stage: string; revision: number }>(`SELECT stage,revision FROM projects_project WHERE id=$1 FOR ${write ? "UPDATE" : "SHARE"}`, [projectId]);
  const member = await sql.query<{ membership_id: string; role: "manager" | "member"; revision: number }>("SELECT membership_id,role,revision FROM projects_project_membership WHERE project_id=$1 AND user_id=$2 AND status='active' FOR SHARE", [projectId, actor.userId]);
  if (!project.rowCount || !member.rowCount) throw new DomainError("FORBIDDEN", "你已不在这个团队空间中，请返回我的参赛。", { status: 403 });
  return { projectId, userId: actor.userId, membershipId: member.rows[0]!.membership_id,
    membershipRevision: Number(member.rows[0]!.revision), role: member.rows[0]!.role,
    archived: project.rows[0]!.stage === "archived", stage: project.rows[0]!.stage, projectRevision: Number(project.rows[0]!.revision) };
}
