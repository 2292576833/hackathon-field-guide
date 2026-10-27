import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type {
  AcknowledgeSpaceChange, SpaceChange, SpaceChangeAcknowledgement, SpaceChangeAssignee,
  SpaceChangeField, SpaceChangeItem, SpaceChangeSource, SpaceChangeValue, SpaceChangesAccess,
  SpaceChangesDependencies, SpaceChangesFacts, SpaceChangesList, SpaceChangesListOptions, SpaceChangesReconciled,
} from "./types.ts";

interface SavedTask { id: string; title: string; owner: SpaceChangeAssignee | null; reviewer: SpaceChangeAssignee | null }
interface Snapshot {
  projectRevision: number; goal: string; minimumDeliverable: string; deadline: string | null;
  /** Historical last observed effective assignments, never a claim of current execution. */
  lastEffectivePlan: null | { id: string; revision: number; tasks: SavedTask[] };
}
interface Head { revision: number; snapshot: Snapshot }
interface Difference { field: SpaceChangeField; taskId: string | null; title: string; before: SpaceChangeValue; after: SpaceChangeValue; relatedUserIds: string[] }
const conflict = () => new DomainError("VERSION_CONFLICT", "变更记录正在更新，请重新读取后再试。", { status: 409 });
const invalidFacts = () => new DomainError("INVALID_CHANGE_FACTS", "当前团队记录待核对，请稍后重试。", { status: 409 });
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new DomainError("INVALID_INPUT", "缺少有效记录标识。", { status: 400 });
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function one(rowCount: number) { if (rowCount !== 1) throw conflict(); }
function factsSnapshot(facts: SpaceChangesFacts, access: SpaceChangesAccess, prior?: Snapshot): Snapshot {
  if (facts.projectId !== access.projectId || !positive(facts.projectRevision)
    || typeof facts.goal !== "string" || facts.goal.length > 20000
    || typeof facts.minimumDeliverable !== "string" || facts.minimumDeliverable.length > 20000
    || !Array.isArray(facts.members)) throw invalidFacts();
  const memberships = new Set<string>(), users = new Set<string>();
  for (const member of facts.members) {
    id(member.membershipId); id(member.userId);
    if (memberships.has(member.membershipId) || users.has(member.userId)
      || !["manager", "member"].includes(member.role) || typeof member.displayName !== "string" || member.displayName.length > 200) throw invalidFacts();
    memberships.add(member.membershipId); users.add(member.userId);
  }
  if (!facts.members.some(member => member.membershipId === access.membershipId && member.userId === access.userId && member.role === access.role)) throw invalidFacts();
  let deadline: string | null = null;
  if (facts.deadline !== null) {
    if (typeof facts.deadline !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(facts.deadline) || !Number.isFinite(Date.parse(facts.deadline))) throw invalidFacts();
    deadline = new Date(facts.deadline).toISOString();
  }
  let lastEffectivePlan = prior?.lastEffectivePlan ?? null;
  if (facts.currentPlan !== null) {
    const plan = facts.currentPlan; id(plan.id);
    if (!positive(plan.revision) || !Array.isArray(plan.tasks) || plan.tasks.length > 2000) throw invalidFacts();
    const taskIds = new Set<string>();
    const person = (userId: string | null): SpaceChangeAssignee | null => {
      if (userId === null) return null;
      id(userId);
      return { userId, displayName: facts.members.find(member => member.userId === userId)?.displayName || "已离队成员" };
    };
    const tasks = plan.tasks.map(task => {
      id(task.id);
      if (taskIds.has(task.id) || typeof task.title !== "string" || task.title.length > 2000) throw invalidFacts();
      taskIds.add(task.id);
      return { id: task.id, title: task.title, owner: person(task.ownerUserId), reviewer: person(task.reviewerUserId) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    lastEffectivePlan = { id: plan.id, revision: plan.revision, tasks };
  }
  return { projectRevision: facts.projectRevision, goal: facts.goal, minimumDeliverable: facts.minimumDeliverable, deadline, lastEffectivePlan };
}
function differences(before: Snapshot, after: Snapshot): Difference[] {
  const result: Difference[] = [];
  for (const [field, title] of [["goal", "作品目标"], ["minimumDeliverable", "最小交付范围"], ["deadline", "截止时间"]] as const) {
    if (before[field] !== after[field]) result.push({ field, taskId: null, title, before: before[field], after: after[field], relatedUserIds: [] });
  }
  const previous = new Map(before.lastEffectivePlan?.tasks.map(task => [task.id, task]) ?? []);
  const current = new Map(after.lastEffectivePlan?.tasks.map(task => [task.id, task]) ?? []);
  for (const taskId of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const prior = previous.get(taskId), next = current.get(taskId);
    const relatedUserIds = [prior?.owner, prior?.reviewer, next?.owner, next?.reviewer].flatMap(person => person ? [person.userId] : []);
    for (const [key, field, label] of [["owner", "task_owner", "负责人"], ["reviewer", "task_reviewer", "检查人"]] as const) {
      const beforePerson = prior?.[key] ?? null, afterPerson = next?.[key] ?? null;
      if (beforePerson?.userId !== afterPerson?.userId) result.push({ field, taskId, title: `${next?.title || prior?.title || "任务"} · ${label}`, before: beforePerson, after: afterPerson, relatedUserIds });
    }
  }
  return result;
}
function summary(value: SpaceChangeValue, task: boolean): string {
  const text = value === null ? task ? "未安排" : "未设置" : typeof value === "string" ? value || "未填写" : value.displayName;
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
function source(snapshot: Snapshot): SpaceChangeSource {
  return { projectRevision: snapshot.projectRevision, planId: snapshot.lastEffectivePlan?.id ?? null, planRevision: snapshot.lastEffectivePlan?.revision ?? null };
}
function instant(value: string | Date) { return new Date(value).toISOString(); }

export function createSpaceChangesService(deps: SpaceChangesDependencies) {
  async function authorize(sql: SqlExecutor, actor: Actor, projectId: string, write: boolean, initial?: SpaceChangesAccess) {
    id(projectId); id(actor.userId);
    const access = await deps.authorize(sql, actor, projectId, write);
    if (access.projectId !== projectId || access.userId !== actor.userId || !access.membershipId || !positive(access.membershipRevision)
      || !["manager", "member"].includes(access.role)
      || (initial && access.membershipId !== initial.membershipId)) throw new DomainError("FORBIDDEN", "你已无法查看此空间的变更。", { status: 403 });
    if (write && access.archived) throw new DomainError("PROJECT_READ_ONLY", "空间已归档，只能查看已保存的变更。", { status: 409 });
    return access;
  }
  return {
    async reconcile(actor: Actor, projectId: string): Promise<SpaceChangesReconciled> {
      return deps.database.transaction(async sql => {
        const access = await authorize(sql, actor, projectId, true);
        const read = await sql.query<Head>("SELECT revision,snapshot FROM space_change_heads WHERE project_id=$1 FOR UPDATE", [projectId]);
        const prior = read.rows[0];
        const facts = await deps.readFacts(sql, access);
        const snapshot = factsSnapshot(facts, access, prior?.snapshot);
        const changes = prior ? differences(prior.snapshot, snapshot) : [];
        if (prior && changes.length === 0) {
          await authorize(sql, actor, projectId, true, access);
          return { projectId, baselineCreated: false, version: prior.revision, changeCount: 0 };
        }
        const version = (prior?.revision ?? 0) + 1, now = deps.clock.now().toISOString();
        if (!prior) {
          one((await sql.query("INSERT INTO space_change_heads(project_id,revision,snapshot,recorded_at) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(project_id) DO NOTHING", [projectId, version, JSON.stringify(snapshot), now])).rowCount);
        } else {
          one((await sql.query("UPDATE space_change_heads SET revision=$2,snapshot=$3::jsonb,recorded_at=$4 WHERE project_id=$1 AND revision=$5", [projectId, version, JSON.stringify(snapshot), now, prior.revision])).rowCount);
        }
        one((await sql.query("INSERT INTO space_change_versions(project_id,version,snapshot,recorded_at) VALUES($1,$2,$3::jsonb,$4)", [projectId, version, JSON.stringify(snapshot), now])).rowCount);
        for (const difference of changes) {
          const { relatedUserIds, ...values } = difference;
          const change: SpaceChange = { id: deps.ids.next(), projectId, version, ...values,
            beforeSummary: summary(difference.before, difference.taskId !== null), afterSummary: summary(difference.after, difference.taskId !== null),
            beforeSource: source(prior!.snapshot), afterSource: source(snapshot), recordedAt: now };
          one((await sql.query("INSERT INTO space_changes(id,project_id,version,change_key,body) VALUES($1,$2,$3,$4,$5::jsonb)", [change.id, projectId, version, JSON.stringify([change.field, change.taskId]), JSON.stringify(change)])).rowCount);
          const involved = new Set(relatedUserIds);
          const recipients = facts.members.filter(member => difference.taskId === null || member.role === "manager" || involved.has(member.userId));
          for (const member of recipients) {
            one((await sql.query("INSERT INTO space_change_recipients(change_id,project_id,membership_id,user_id,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [change.id, projectId, member.membershipId, member.userId, JSON.stringify(member)])).rowCount);
          }
        }
        await authorize(sql, actor, projectId, true, access);
        return { projectId, baselineCreated: !prior, version, changeCount: changes.length };
      });
    },
    async list(actor: Actor, projectId: string, options: SpaceChangesListOptions = {}): Promise<SpaceChangesList> {
      const limit = options.limit ?? 20, before = options.beforeVersion ?? null;
      if (!positive(limit) || limit > 50 || (before !== null && !positive(before))) throw new DomainError("INVALID_INPUT", "分页参数无效。", { status: 400 });
      return deps.database.transaction(async sql => {
        const access = await authorize(sql, actor, projectId, false);
        const parameters = [projectId, access.membershipId, actor.userId];
        const pending = await sql.query<{ count: string }>(`SELECT count(*)::text AS count FROM space_change_recipients r
          LEFT JOIN space_change_acknowledgements a ON a.change_id=r.change_id AND a.membership_id=r.membership_id AND a.user_id=r.user_id
          WHERE r.project_id=$1 AND r.membership_id=$2 AND r.user_id=$3 AND a.change_id IS NULL`, parameters);
        const versions = await sql.query<{ version: number }>(`SELECT DISTINCT c.version FROM space_changes c
          JOIN space_change_recipients r ON r.change_id=c.id AND r.project_id=c.project_id
          WHERE c.project_id=$1 AND r.membership_id=$2 AND r.user_id=$3 AND ($4::integer IS NULL OR c.version<$4)
          ORDER BY c.version DESC LIMIT $5`, [...parameters, before, limit + 1]);
        const chosen = versions.rows.slice(0, limit).map(row => row.version);
        const rows = chosen.length ? await sql.query<{ body: SpaceChange; acknowledged_at: string | Date | null }>(`SELECT c.body,a.acknowledged_at FROM space_changes c
          JOIN space_change_recipients r ON r.change_id=c.id AND r.project_id=c.project_id
          LEFT JOIN space_change_acknowledgements a ON a.change_id=r.change_id AND a.membership_id=r.membership_id AND a.user_id=r.user_id
          WHERE c.project_id=$1 AND r.membership_id=$2 AND r.user_id=$3 AND c.version=ANY($4::integer[])
          ORDER BY c.version DESC,c.change_key,c.id`, [...parameters, chosen]) : { rows: [] };
        const items: SpaceChangeItem[] = rows.rows.map(row => ({ ...row.body, acknowledgedAt: row.acknowledged_at ? instant(row.acknowledged_at) : null }));
        const final = await authorize(sql, actor, projectId, false, access);
        return { projectId, userId: actor.userId, membershipId: access.membershipId, readOnly: final.archived, checkedAt: deps.clock.now().toISOString(),
          pendingCount: Number(pending.rows[0]?.count ?? 0), items, nextBeforeVersion: versions.rows.length > limit ? chosen.at(-1)! : null };
      });
    },
    async acknowledge(actor: Actor, projectId: string, input: AcknowledgeSpaceChange): Promise<SpaceChangeAcknowledgement> {
      id(input.changeId);
      if (!positive(input.version) || input.understood !== true) throw new DomainError("INVALID_INPUT", "请明确选择“我已了解”并核对变更版本。", { status: 400 });
      return deps.database.transaction(async sql => {
        const access = await authorize(sql, actor, projectId, true);
        const parameters = [projectId, input.changeId, access.membershipId, actor.userId];
        const event = await sql.query<{ version: number }>(`SELECT c.version FROM space_changes c
          JOIN space_change_recipients r ON r.change_id=c.id AND r.project_id=c.project_id
          WHERE c.project_id=$1 AND c.id=$2 AND r.membership_id=$3 AND r.user_id=$4`, parameters);
        if (!event.rows[0]) throw new DomainError("NOT_FOUND", "未找到属于你当前成员身份的变更。", { status: 404 });
        if (event.rows[0].version !== input.version) throw conflict();
        const saved = await sql.query<{ acknowledged_at: string | Date }>(`INSERT INTO space_change_acknowledgements(change_id,membership_id,user_id,acknowledged_at)
          SELECT c.id,r.membership_id,r.user_id,$5 FROM space_changes c
          JOIN space_change_recipients r ON r.change_id=c.id AND r.project_id=c.project_id
          WHERE c.project_id=$1 AND c.id=$2 AND r.membership_id=$3 AND r.user_id=$4 AND c.version=$6
          ON CONFLICT(change_id,membership_id) DO NOTHING RETURNING acknowledged_at`, [...parameters, deps.clock.now().toISOString(), input.version]);
        if ((saved.rowCount !== 0 && saved.rowCount !== 1) || saved.rows.length !== saved.rowCount) throw conflict();
        const replay = saved.rowCount === 0;
        const row = saved.rows[0] ?? (await sql.query<{ acknowledged_at: string | Date }>("SELECT acknowledged_at FROM space_change_acknowledgements WHERE change_id=$1 AND membership_id=$2 AND user_id=$3", [input.changeId, access.membershipId, actor.userId])).rows[0];
        if (!row) throw conflict();
        await authorize(sql, actor, projectId, true, access);
        return { projectId, changeId: input.changeId, version: input.version, acknowledgedAt: instant(row.acknowledged_at), replayed: replay };
      });
    },
  };
}
export type SpaceChangesService = ReturnType<typeof createSpaceChangesService>;
