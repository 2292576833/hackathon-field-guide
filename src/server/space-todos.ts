import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { SpaceManualTodo } from "../modules/space-workflow/todos.ts";

/**
 * 本人手动添加的空间待办（规划27 第1期）。
 *
 * 边界（宪法 v1.16.0 原则 X 第3、4条）：
 *  - 只有本人可读写，队友不可见；不参与任何派生事实、任务状态、检查记录或项目阶段；
 *  - 每条必须有非空标题；"完成"只表示本人把这条私人备忘标记完成；
 *  - 待办清单的其余三类（要我填/要我确认/要我做）是派生视图，**不落库**。
 */
interface Row { id: string; project_id: string; user_id: string; title: string; note: string; status: "open" | "done";
  completed_at: Date | string | null; created_at: Date | string; updated_at: Date | string; revision: number | string }

const iso = (value: Date | string) => new Date(value).toISOString();
const toTodo = (row: Row): SpaceManualTodo => ({ id: row.id, title: row.title, note: row.note, status: row.status,
  completedAt: row.completed_at === null ? null : iso(row.completed_at), revision: Number(row.revision) });

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `请填写${label}。`, { status: 422 });
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    throw new DomainError("INVALID_INPUT", `${label}${required ? "必填" : ""}且不超过 ${max} 字。`, { status: 422 });
  }
  return result;
}
function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_INPUT", "页面版本缺失，请重新读取后再保存。", { status: 422 });
  return value;
}
function payload(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new DomainError("INVALID_INPUT", "待办内容包含无效字段。", { status: 422 });
  return value as Record<string, unknown>;
}

export function createSpaceTodos(deps: { database: DatabasePort; clock: Clock; ids: IdGenerator }) {
  /** 复核当前账号是该项目活跃成员；手动待办只属于本人，不要求管理员。 */
  async function assertMember(sql: SqlExecutor, actor: Actor, projectId: string, write = false) {
    const user = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' FOR SHARE", [actor.userId]);
    if (!user.rowCount) throw new DomainError("UNAUTHENTICATED", "账号状态已变化，请重新登录。", { status: 401 });
    const project = await sql.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1 FOR SHARE", [projectId]);
    const member = await sql.query<{ membership_id: string }>(
      "SELECT membership_id FROM projects_project_membership WHERE project_id=$1 AND user_id=$2 AND status='active' LIMIT 1 FOR SHARE", [projectId, actor.userId]);
    if (!member.rowCount || !project.rowCount) throw new DomainError("FORBIDDEN", "你不是这个空间的活跃成员，无法使用待办清单。", { status: 403 });
    if (write && project.rows[0]!.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "空间已归档，待办记录只读。", { status: 409 });
  }
  return {
    /** 只返回本人条目；未完成优先。 */
    async list(actor: Actor, projectId: string): Promise<SpaceManualTodo[]> {
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId);
        const rows = await sql.query<Row>(
          "SELECT * FROM space_manual_todos WHERE project_id=$1 AND user_id=$2 ORDER BY (status='open') DESC, created_at DESC LIMIT 200", [projectId, actor.userId]);
        return rows.rows.map(toTodo);
      });
    },
    async create(actor: Actor, projectId: string, input: unknown): Promise<SpaceManualTodo> {
      const body = payload(input, ["title", "note"]);
      const title = text(body.title, "待办内容", 200), note = body.note === undefined ? "" : text(body.note, "备注", 2000, false);
      const now = deps.clock.now().toISOString(), id = deps.ids.next();
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const saved = await sql.query<Row>("INSERT INTO space_manual_todos(id,project_id,user_id,title,note,status,completed_at,created_at,updated_at,revision) VALUES($1,$2,$3,$4,$5,'open',NULL,$6::timestamptz,$6::timestamptz,1) RETURNING *",
          [id, projectId, actor.userId, title, note, now]);
        if (saved.rowCount !== 1 || !saved.rows[0]) throw new DomainError("VERSION_CONFLICT", "待办未保存，请重新读取后继续。", { status: 409 });
        return toTodo(saved.rows[0]);
      });
    },
    /** 标记完成／恢复未完成／改标题与备注；版本不符则拒绝，避免覆盖别处的修改。 */
    async update(actor: Actor, projectId: string, todoId: string, input: unknown): Promise<SpaceManualTodo> {
      const body = payload(input, ["expectedRevision", "status", "title", "note"]);
      const expected = revisionOf(body.expectedRevision);
      const status = body.status === undefined ? undefined : body.status;
      if (status !== undefined && status !== "open" && status !== "done") throw new DomainError("INVALID_INPUT", "状态只能是完成或未完成。", { status: 422 });
      const title = body.title === undefined ? undefined : text(body.title, "待办内容", 200);
      const note = body.note === undefined ? undefined : text(body.note, "备注", 2000, false);
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const current = await sql.query<Row>("SELECT * FROM space_manual_todos WHERE id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE", [todoId, projectId, actor.userId]);
        const row = current.rows[0];
        if (!row) throw new DomainError("NOT_FOUND", "未找到这条待办，可能已被删除。", { status: 404 });
        if (Number(row.revision) !== expected) throw new DomainError("VERSION_CONFLICT", "这条待办已被修改，请重新读取后再试。", { status: 409 });
        const now = deps.clock.now().toISOString();
        const nextStatus = status ?? row.status;
        const completedAt = nextStatus === "done" ? (row.completed_at === null ? now : iso(row.completed_at)) : null;
        const nextTitle = title ?? row.title, nextNote = note ?? row.note, nextRevision = Number(row.revision) + 1;
        const changed = await sql.query("UPDATE space_manual_todos SET title=$4,note=$5,status=$6,completed_at=$7::timestamptz,updated_at=$8::timestamptz,revision=$9 WHERE id=$1 AND project_id=$2 AND user_id=$3",
          [todoId, projectId, actor.userId, nextTitle, nextNote, nextStatus, completedAt, now, nextRevision]);
        if (changed.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "待办未保存，请重新读取后继续。", { status: 409 });
        return { id: todoId, title: nextTitle, note: nextNote, status: nextStatus, completedAt, revision: nextRevision };
      });
    },
    async remove(actor: Actor, projectId: string, todoId: string): Promise<{ id: string }> {
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const result = await sql.query("DELETE FROM space_manual_todos WHERE id=$1 AND project_id=$2 AND user_id=$3", [todoId, projectId, actor.userId]);
        if (!result.rowCount) throw new DomainError("NOT_FOUND", "未找到这条待办，可能已被删除。", { status: 404 });
        return { id: todoId };
      });
    },
  };
}
