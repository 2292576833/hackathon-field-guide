import { createHash } from "node:crypto";
import type { Actor, Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { FreshSessionGuard } from "../shared/personal-ai.ts";
import { DomainError } from "../shared/errors.ts";
import type { ProjectsService } from "../modules/projects/index.ts";
import type { PlanningFactsPort, PlanningService, PlanningTask } from "../modules/planning/index.ts";
import type { DeliveryService, DeliveryVerification, SubmissionRecord } from "../modules/github/index.ts";
import { validatePresentationProjectSelection, validatePresentationProjectSnapshot,
  type PresentationProjectContextPort, type PresentationProjectSelection,
  type PresentationProjectSnapshot } from "../modules/roadshow/project-context.ts";

export interface PresentationProjectContextDependencies {
  database: DatabasePort;
  projects: Pick<ProjectsService, "getProject">;
  planning: Pick<PlanningService, "getCurrent" | "listProgress">;
  planningFacts: Pick<PlanningFactsPort, "lockVersions">;
  delivery: Pick<DeliveryService, "listVerifications" | "listSubmissions">;
  clock: Clock;
}
type Summary = Omit<PresentationProjectSnapshot, "revision" | "capturedAt">;
type RevisionRow = { revision: number | string; facts_identity: unknown };
type Sample = { summary: Summary; canonical: string; fingerprint: string };

function unavailable(): never {
  throw new DomainError("PROJECT_CONTEXT_INVALID", "空间资料暂时无法安全带入，请重新读取或改为自行填写。", { status: 502 });
}
function overLimit(): never {
  throw new DomainError("PROJECT_SOURCE_INVALID", "空间资料超过展示材料的带入范围，请解除空间引用，选择需要的内容后自行填写；原资料仍保留。", {
    status: 422, recoveryAction: "choose_materials_manually",
  });
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function order<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) unavailable();
  const result = value.trim();
  if (!empty && !result) unavailable();
  if (result.length > limit) overLimit();
  return result;
}
function instant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) unavailable();
  return parsed.toISOString();
}
function list(items: string[]): string[] {
  if (items.length > 12) overLimit();
  return items.map(item => text(item, 600));
}
function integer(value: unknown): number {
  const result = typeof value === "string" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1) unavailable();
  return result;
}
function actorId(actor: Actor): void {
  if (!actor || typeof actor.userId !== "string" || !actor.userId.trim())
    throw new DomainError("UNAUTHENTICATED", "请登录后读取团队空间资料。", { status: 401 });
}
function taskSummary(task: PlanningTask): string {
  const title = text(task.title, 600);
  const deliverable = text(task.deliverable, 600, true);
  return deliverable ? `${title}；交付物：${deliverable}` : title;
}
function currentSubmissions(records: readonly SubmissionRecord[]): SubmissionRecord[] {
  const current = new Map<string, SubmissionRecord>();
  for (const record of records) if (!current.has(record.id) || current.get(record.id)!.version < record.version)
    current.set(record.id, record);
  return order([...current.values()]);
}
function currentVerifications(records: readonly DeliveryVerification[]): DeliveryVerification[] {
  const current = new Map<string, DeliveryVerification>();
  for (const record of [...records].sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt) || a.id.localeCompare(b.id)))
    current.set(record.repositoryCommitSha ?? `unversioned:${record.id}`, record);
  return order([...current.values()]);
}

/**
 * Public M02/M05/M06 services provide the facts. The DatabasePort must reuse its
 * ambient executor for all nested service transactions (the root adapter does).
 * No model, private profile, raw answers, full rules, code or evidence URLs enter
 * this summary. The integer revision is an immutable persisted mapping of the
 * complete fact identity, never a truncated numeric hash.
 */
export function createPresentationProjectContextPort(deps: PresentationProjectContextDependencies): PresentationProjectContextPort {
  async function lock(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard) {
    actorId(actor);
    const identity = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (!identity.rowCount) throw new DomainError("UNAUTHENTICATED", "登录身份已失效，请重新登录。", { status: 401 });
    await guard?.(sql);
    // M05 writers take this before their state/head/project locks. lockVersions
    // takes M04 head before M02 project and protects the absent-head case too.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`planning:${projectId}`]);
    const versions = await deps.planningFacts.lockVersions(projectId, sql, actor);
    const detail = await deps.projects.getProject(actor, projectId);
    if (detail.project.id !== projectId || detail.membership.projectId !== projectId
      || detail.membership.userId !== actor.userId || detail.membership.status !== "active")
      throw new DomainError("PROJECT_UNAVAILABLE", "团队空间不存在或你尚未加入。", { status: 404 });
    if (detail.project.stage === "archived" || versions.projectArchived || versions.projectReadOnly)
      throw new DomainError("PROJECT_ARCHIVED", "团队空间已归档，请先恢复空间，或解除引用后自行填写。", { status: 409 });
    if (versions.projectRevision !== detail.project.revision) unavailable();
    return { detail, versions };
  }
  async function sample(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<Sample> {
    const { detail, versions } = await lock(sql, actor, projectId, guard);
    // M06's current store has no project coordination lock. A short SHARE lock
    // prevents new fact/head inserts and head updates (not just existing rows).
    // It is held only in this database transaction, never across a model call.
    // It serializes M06 writes globally; a future per-project public lock port
    // can replace it after every M06 writer has adopted the same lock order.
    await sql.query("LOCK TABLE m06_delivery_verifications, m06_submission_heads, m06_submission_versions IN SHARE MODE");
    const current = await deps.planning.getCurrent(actor, projectId);
    const progress = await deps.planning.listProgress(actor, projectId);
    const verifications = await deps.delivery.listVerifications(actor, projectId);
    const submissions = await deps.delivery.listSubmissions(actor, projectId);
    const tasks = order(current.tasks);
    const completed: string[] = [], planned: string[] = [], evidence: string[] = [];
    const minimum = text(detail.project.minimumDeliverable, 2000, true);
    if (minimum) planned.push(`最小交付目标（尚未据此确认完成）：${minimum}`);
    for (const task of tasks) {
      if (task.projectId !== projectId) unavailable();
      if (task.status === "cancelled") continue;
      if (task.status === "done") {
        if (!task.acceptance || !task.acceptance.evidenceRefs.length) unavailable();
        const kind = task.acceptance.mode === "self_check" ? "成员自检完成" : "团队检查通过";
        completed.push(`${kind}：${taskSummary(task)}`);
        evidence.push(`任务「${text(task.title, 600)}」第 ${task.revision} 版，${kind}；检查时间 ${instant(task.acceptance.acceptedAt)}；有 ${task.acceptance.evidenceRefs.length} 项空间内检查依据。`);
      } else {
        const label = task.status === "review" ? "待检查" : task.status === "blocked" ? "遇到阻碍" : task.status === "in_progress" ? "进行中" : "待完成";
        planned.push(`${label}：${taskSummary(task)}`);
      }
    }
    for (const record of currentVerifications(verifications)) {
      if (record.projectId !== projectId) unavailable();
      const result = record.outcome === "passed" ? "通过" : record.outcome === "failed" ? "未通过" : "尚无结论";
      const version = record.repositoryCommitSha ? `代码版本 ${record.repositoryCommitSha}` : "未关联代码版本";
      evidence.push(`队员自报运行核验 ${result}：${version}；时间 ${instant(record.verifiedAt)}。这是该次记录，不证明当前代码已运行。`);
    }
    for (const record of currentSubmissions(submissions)) {
      if (record.projectId !== projectId) unavailable();
      const state = record.status === "reported" ? "队员自报已提交（未获平台确认）" : record.status === "verified" && record.verificationSource === "platform_verified" ? "平台已核验提交" : record.status === "rejected_or_withdrawn" ? "提交被拒绝或撤回" : "未确认提交";
      evidence.push(`${state}；记录第 ${record.version} 版；记录时间 ${instant(record.recordedAt)}。提交记录不能证明作品功能已完成。`);
    }
    const summary: Summary = { schemaVersion: 1, projectId,
      projectName: text(detail.project.name, 120), projectIdea: text(detail.project.goal, 2000, true),
      targetUsers: "", problem: "", completed: list(completed), planned: list(planned), evidence: list(evidence) };
    // Versions include all inputs and every progress/fact ID even if the
    // visible wording is unchanged. Read-time evaluations/timestamps and
    // personal/member profile fields are deliberately excluded.
    const identity = { summary, projectRevision: detail.project.revision, versions,
      tasksRevision: current.tasksRevision,
      plan: current.plan ? { id: current.plan.id, revision: current.plan.revision, status: current.plan.status } : null,
      tasks: tasks.map(task => ({ id: task.id, revision: task.revision, status: task.status })),
      progress: order(progress).map(item => ({ id: item.id, taskId: item.taskId, status: item.status, createdAt: item.createdAt })),
      verifications: order(verifications).map(item => ({ id: item.id, version: item.version, outcome: item.outcome, repositoryCommitSha: item.repositoryCommitSha, verifiedAt: item.verifiedAt })),
      submissions: order(submissions).sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
        .map(item => ({ id: item.id, version: item.version, status: item.status, verificationSource: item.verificationSource, recordedAt: item.recordedAt })) };
    const json = canonical(identity);
    if (Buffer.byteLength(json, "utf8") > 200_000) overLimit();
    await guard?.(sql);
    return { summary, canonical: json, fingerprint: createHash("sha256").update(json).digest("hex") };
  }
  async function registered(sql: SqlExecutor, projectId: string, value: Sample): Promise<number | null> {
    const record = (await sql.query<RevisionRow>("SELECT revision,facts_identity FROM presentation_project_context_versions WHERE project_id=$1 AND facts_fingerprint=$2", [projectId, value.fingerprint])).rows[0];
    if (!record) return null;
    // Even a SHA collision or corrupt registry must fail closed, not return
    // another facts revision. JSONB key order is normalized before comparison.
    if (canonical(record.facts_identity) !== value.canonical) unavailable();
    return integer(record.revision);
  }
  async function register(sql: SqlExecutor, projectId: string, value: Sample): Promise<number> {
    const existing = await registered(sql, projectId, value);
    if (existing !== null) return existing;
    const row = (await sql.query<{ revision: number | string }>("SELECT coalesce(max(revision),0)+1 AS revision FROM presentation_project_context_versions WHERE project_id=$1", [projectId])).rows[0];
    const revision = integer(row?.revision);
    await sql.query("INSERT INTO presentation_project_context_versions(project_id,revision,facts_fingerprint,facts_identity,created_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)",
      [projectId, revision, value.fingerprint, value.canonical, deps.clock.now().toISOString()]);
    return revision;
  }
  return {
    async readSnapshot(actor, projectId, guard) {
      validatePresentationProjectSelection({ projectId, revision: 1 });
      return deps.database.transaction(async sql => {
        const value = await sample(sql, actor, projectId, guard);
        const revision = await register(sql, projectId, value);
        return validatePresentationProjectSnapshot({ ...value.summary, revision, capturedAt: deps.clock.now().toISOString() });
      });
    },
    async assertCurrent(actor, selection: PresentationProjectSelection, sql) {
      const chosen = validatePresentationProjectSelection(selection);
      const value = await sample(sql, actor, chosen.projectId);
      const revision = await registered(sql, chosen.projectId, value);
      if (revision !== chosen.revision) throw new DomainError("PROJECT_CONTEXT_CHANGED", "空间资料已有更新，请重新读取并确认本次使用的内容。", {
        status: 409, recoveryAction: "reload_project_context", ...(revision === null ? {} : { latestRevision: revision }),
      });
    },
    async assertCanGenerate(actor, projectId, sql) {
      validatePresentationProjectSelection({ projectId, revision: 1 });
      // Explicitly inherited historical artifacts keep their original source;
      // only fresh account/membership/archive permission is needed here.
      await lock(sql, actor, projectId);
    },
  };
}
