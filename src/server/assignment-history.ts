import type { Actor } from "../shared/contracts.ts";
import type { SqlExecutor } from "../shared/persistence.ts";
import type { AssignmentVersionView } from "../modules/assessments/types.ts";
import { DomainError } from "../shared/errors.ts";
import type { Application } from "./application.ts";

type HistoryApplication = Pick<Application, "database" | "projects" | "assessments" | "facts">;
async function currentAccount(sql: SqlExecutor, actor: Actor) {
  if (!actor?.userId?.trim()) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
  const result = await sql.query<{ status: string; email_verified_at: string | null }>("SELECT status,email_verified_at FROM auth_users WHERE id=$1 FOR SHARE", [actor.userId]);
  if (result.rows[0]?.status !== "active" || !result.rows[0].email_verified_at) throw new DomainError("UNAUTHENTICATED", "登录身份已失效，请重新登录。", { status: 401 });
}

/** Safe project directory; every row uses the module's live freshness and disclosure rules. */
export async function listAssignmentHistory(application: HistoryApplication, actor: Actor, projectId: string): Promise<AssignmentVersionView[]> {
  // Do not query the assignment directory until ordinary project authorization succeeds.
  await application.projects.getProject(actor, projectId);
  return application.database.transaction(async sql => {
    const authorize = async () => {
      await currentAccount(sql, actor);
      const snapshot = await application.facts.finalFactsLock.lock({ actor, operation: "retrospective.create", projectIds: [projectId], evidence: [], resourceIds: [] }, sql);
      const membership = snapshot.projects.find(project => project.projectId === projectId)?.membership;
      if (!membership || membership.status !== "active" || membership.userId !== actor.userId) throw new DomainError("NOT_FOUND", "项目不存在或你无权查看。", { status: 404 });
    };
    // Existing root order: account -> planning coordination -> M04 head -> M02 -> M03.
    await authorize();
    const directory = await sql.query<{ id: string }>("SELECT id FROM assessments_assignment_versions WHERE project_id=$1 ORDER BY updated_at DESC,id ASC LIMIT 30", [projectId]);
    const views: AssignmentVersionView[] = [];
    // Nested module transactions share the outer executor. Never read attempt answers here.
    for (const row of directory.rows) {
      const view = await application.assessments.getAssignment(actor, row.id);
      if (view.projectId !== projectId) throw new DomainError("PERSISTENCE_INVALID_DATA", "分工目录暂时无法读取。", { status: 500 });
      views.push(view);
    }
    await authorize();
    return views;
  });
}
