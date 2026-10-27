import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { EventsService } from "../modules/events/index.ts";
import type { PostgresProjectsRepository } from "../modules/projects/index.ts";
import type { ConfirmedDeliveryRequirementsPort, DeliveryMaterialsWriteAccessPort } from "../modules/github/index.ts";
import { confirmedRequirementVersionId } from "./facts.ts";

/** Confirmed M03 snapshots are the only source of the M06 checklist. No search/model calls. */
export function createDeliveryRequirementsPorts(deps: { database: DatabasePort; events: EventsService; projects: PostgresProjectsRepository }) {
  const identity = async (actor: Actor, sql: SqlExecutor) => {
    const row = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (!row.rowCount) throw new DomainError("UNAUTHENTICATED", "账号已失效，请重新登录。", { status: 401 });
  };
  const requirements: ConfirmedDeliveryRequirementsPort = {
    async readConfirmed(actor, projectId, supplied) {
      const read = async (sql: SqlExecutor) => {
        await identity(actor, sql);
        const membership = await deps.projects.getMembershipForUpdate(sql, projectId, actor.userId);
        if (membership?.status !== "active") throw new DomainError("PROJECT_ACCESS_DENIED", "你当前没有此空间的访问权限。", { status: 403 });
        await sql.query("SELECT id FROM m03_project_rules WHERE id=$1 FOR SHARE", [projectId]);
        const { confirmation, rules } = await deps.events.getProjectRules(actor, projectId);
        if (!confirmation || !rules) return null;
        const changes = await deps.events.getProjectChanges(actor, projectId);
        const materials = rules.requirements.map(item => ({ id: item.id, label: item.label, necessity: item.necessity, stageId: item.stageId, evidenceRefs: [...item.evidenceIds] }));
        const unknowns: string[] = [];
        if (!materials.length) unknowns.push("已确认规则未列出材料清单，请人工核对主办方原文。");
        if (changes.publicationUnavailable) unknowns.push("当前赛事公开版本不可读取，原确认快照保留，提交前请核对主办方。");
        else if (changes.needsConfirmation) unknowns.push("赛事已发布更新版本，当前仍是团队原确认快照，请先比较并重新确认。");
        // M03 currently has no structured required-branch field. A free-text sentence is not a branch guarantee.
        return {
          projectId, eventId: confirmation.eventId, requirementsVersion: confirmedRequirementVersionId(confirmation), confirmedAt: confirmation.confirmedAt,
          materialsStatus: materials.length ? "specified" as const : "unknown" as const, materials,
          requiredBranch: { status: "unknown" as const, reason: "已确认规则尚未记录结构化提交分支要求，请在主办方页面人工核对；不会默认使用 main。" },
          stages: rules.stages.filter(stage => stage.stageType === "submission" || stage.stageType === "pitch").map(stage => ({
            id: stage.id, name: stage.name, submissionUrl: stage.submissionUrl,
            deadline: stage.endsAt?.dateOnly ? null : stage.endsAt?.utc ?? null, deadlineRawText: stage.endsAt?.rawText ?? null,
          })), unknowns,
        };
      };
      return supplied ? read(supplied) : deps.database.transaction(read);
    },
  };
  const writeAccess: DeliveryMaterialsWriteAccessPort = {
    async assertWritable(actor, projectId, sql) {
      await identity(actor, sql);
      const membership = await deps.projects.getMembershipForUpdate(sql, projectId, actor.userId);
      if (membership?.status !== "active" || membership.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "只有当前空间管理员能保存团队材料核对。", { status: 403 });
      const project = await sql.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1", [projectId]);
      if (project.rows[0]?.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "归档空间只读，不能更新材料清单。", { status: 409 });
    },
  };
  return { requirements, writeAccess };
}
