import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";

/**
 * 空间文档（规划27 第1期追加）：在团队空间里直接写文档。
 *
 * 边界：
 *  - 团队共享：本空间活跃成员都能读；作者明确共享编辑后队友可改，只有作者可共享或删除；
 *  - 纯人工写作，不接 AI 生成，不参与也不改变任何任务、检查、交付或阶段事实；
 *  - revision 乐观并发：版本不符即拒绝，避免两人同时编辑互相覆盖。
 */
export interface SpaceDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly authorId: string;
  /** 作者是否已共享给队友编辑（用户确认的方案 B）；默认否。 */
  readonly teamEditable: boolean;
  readonly sharedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface Row { id: string; project_id: string; author_id: string; title: string; body: string;
  team_editable: boolean; shared_at: Date | string | null;
  revision: number | string; created_at: Date | string; updated_at: Date | string }

const iso = (value: Date | string) => new Date(value).toISOString();
const toDocument = (row: Row): SpaceDocument => ({ id: row.id, title: row.title, body: row.body, authorId: row.author_id,
  teamEditable: row.team_editable, sharedAt: row.shared_at === null ? null : iso(row.shared_at),
  revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", `请填写${label}。`, { status: 422 });
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    throw new DomainError("INVALID_INPUT", `${label}${required ? "必填" : ""}且不超过 ${max} 字。`, { status: 422 });
  }
  return result;
}
/** 正文允许换行与空行，只禁控制字符并限长；不做 trim 以保留作者排版。 */
function bodyText(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("INVALID_INPUT", "请填写文档正文。", { status: 422 });
  if (value.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DomainError("INVALID_INPUT", "文档正文不超过 20000 字。", { status: 422 });
  return value;
}
function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_INPUT", "页面版本缺失，请重新读取后再保存。", { status: 422 });
  return value;
}
function payloadOf(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) {
    throw new DomainError("INVALID_INPUT", "文档内容格式不正确，请只提交当前表单中的字段。", { status: 422 });
  }
  return value as Record<string, unknown>;
}
function savedDocument(rows: readonly Row[]): SpaceDocument {
  if (rows.length !== 1) throw new DomainError("VERSION_CONFLICT", "文档没有保存，请重新读取后再试。", { status: 409 });
  return toDocument(rows[0]!);
}

export function createSpaceDocuments(deps: { database: DatabasePort; clock: Clock; ids: IdGenerator }) {
  async function assertMember(sql: SqlExecutor, actor: Actor, projectId: string, writing = false) {
    // 固定账号 → 空间 → 成员的锁顺序；状态、归档和成员撤销不能穿过本次读写事务。
    const account = await sql.query<{ id: string }>("SELECT id FROM auth_users WHERE id=$1 AND status='active' FOR SHARE", [actor.userId]);
    if (!account.rows.length) throw new DomainError("FORBIDDEN", "当前账号无法使用空间文档，请重新登录后核对。", { status: 403 });
    const project = await sql.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1 FOR SHARE", [projectId]);
    const member = await sql.query<{ membership_id: string }>(
      "SELECT membership_id FROM projects_project_membership WHERE project_id=$1 AND user_id=$2 AND status='active' FOR SHARE", [projectId, actor.userId]);
    if (!project.rows.length || !member.rows.length) throw new DomainError("FORBIDDEN", "你不是这个空间的活跃成员，无法查看空间文档。", { status: 403 });
    if (writing && project.rows[0]!.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "归档空间只读，不能新增、修改、共享或删除文档。", { status: 409 });
  }
  return {
    /** 只返回仍可读的空间文档；归档空间仍可读。 */
    async list(actor: Actor, projectId: string): Promise<SpaceDocument[]> {
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId);
        const rows = await sql.query<Row>("SELECT * FROM space_documents WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT 200", [projectId]);
        return rows.rows.map(toDocument);
      });
    },
    async create(actor: Actor, projectId: string, input: unknown): Promise<SpaceDocument> {
      const payload = payloadOf(input, ["title", "body"]);
      const title = text(payload.title, "文档标题", 200);
      const body = payload.body === undefined ? "" : bodyText(payload.body);
      const now = deps.clock.now().toISOString(), id = deps.ids.next();
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const saved = await sql.query<Row>("INSERT INTO space_documents(id,project_id,author_id,title,body,team_editable,shared_at,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,false,NULL,1,$6::timestamptz,$6::timestamptz) RETURNING *",
          [id, projectId, actor.userId, title, body, now]);
        return savedDocument(saved.rows);
      });
    },
    /**
     * 只有作者本人可改；队友在作者**已共享**（teamEditable）时也可改。
     * 版本不符一律拒绝，避免两人同时编辑互相覆盖。
     */
    async update(actor: Actor, projectId: string, documentId: string, input: unknown): Promise<SpaceDocument> {
      const payload = payloadOf(input, ["expectedRevision", "title", "body"]);
      const expected = revisionOf(payload.expectedRevision);
      if (payload.title === undefined && payload.body === undefined) throw new DomainError("INVALID_INPUT", "请填写要修改的标题或正文。", { status: 422 });
      const title = payload.title === undefined ? undefined : text(payload.title, "文档标题", 200);
      const body = payload.body === undefined ? undefined : bodyText(payload.body);
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const current = await sql.query<Row>("SELECT * FROM space_documents WHERE id=$1 AND project_id=$2 FOR UPDATE", [documentId, projectId]);
        const row = current.rows[0];
        if (!row) throw new DomainError("NOT_FOUND", "未找到这份文档，可能已被作者删除。", { status: 404 });
        const author = row.author_id === actor.userId;
        if (!author && !row.team_editable) throw new DomainError("FORBIDDEN", "这份文档还没有共享给队友编辑。可以请作者在文档上点“共享给队友编辑”。", { status: 403 });
        if (Number(row.revision) !== expected) throw new DomainError("VERSION_CONFLICT", "这份文档已被修改，请重新读取后再编辑。", { status: 409 });
        const now = deps.clock.now().toISOString();
        const nextTitle = title ?? row.title, nextBody = body ?? row.body;
        const saved = await sql.query<Row>("UPDATE space_documents SET title=$4,body=$5,revision=revision+1,updated_at=$6::timestamptz WHERE id=$1 AND project_id=$2 AND (author_id=$3 OR team_editable=true) AND revision=$7 RETURNING *",
          [documentId, projectId, actor.userId, nextTitle, nextBody, now, expected]);
        return savedDocument(saved.rows);
      });
    },
    /** 共享给队友编辑 / 收回。只有作者本人可以切换。 */
    async share(actor: Actor, projectId: string, documentId: string, input: unknown): Promise<SpaceDocument> {
      const payload = payloadOf(input, ["expectedRevision", "teamEditable"]);
      const expected = revisionOf(payload.expectedRevision);
      if (typeof payload.teamEditable !== "boolean") throw new DomainError("INVALID_INPUT", "请说明是共享还是收回。", { status: 422 });
      const shared = payload.teamEditable;
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const current = await sql.query<Row>("SELECT * FROM space_documents WHERE id=$1 AND project_id=$2 FOR UPDATE", [documentId, projectId]);
        const row = current.rows[0];
        if (!row) throw new DomainError("NOT_FOUND", "未找到这份文档，可能已被作者删除。", { status: 404 });
        if (row.author_id !== actor.userId) throw new DomainError("FORBIDDEN", "只有作者本人可以共享或收回这份文档。", { status: 403 });
        if (Number(row.revision) !== expected) throw new DomainError("VERSION_CONFLICT", "这份文档已被修改，请重新读取后再操作。", { status: 409 });
        const now = deps.clock.now().toISOString();
        const sharedAt = shared ? (row.shared_at === null ? now : iso(row.shared_at)) : null;
        const saved = await sql.query<Row>("UPDATE space_documents SET team_editable=$4,shared_at=$5::timestamptz,revision=revision+1,updated_at=$6::timestamptz WHERE id=$1 AND project_id=$2 AND author_id=$3 AND revision=$7 RETURNING *",
          [documentId, projectId, actor.userId, shared, sharedAt, now, expected]);
        return savedDocument(saved.rows);
      });
    },
    async remove(actor: Actor, projectId: string, documentId: string): Promise<{ id: string }> {
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const current = await sql.query<Row>("SELECT * FROM space_documents WHERE id=$1 AND project_id=$2 FOR UPDATE", [documentId, projectId]);
        const row = current.rows[0];
        if (!row) throw new DomainError("NOT_FOUND", "未找到这份文档，可能已被删除。", { status: 404 });
        if (row.author_id !== actor.userId) throw new DomainError("FORBIDDEN", "只有作者本人可以删除这份文档。", { status: 403 });
        const removed = await sql.query<{ id: string }>("DELETE FROM space_documents WHERE id=$1 AND project_id=$2 AND author_id=$3 RETURNING id", [documentId, projectId, actor.userId]);
        if (removed.rows.length !== 1) throw new DomainError("NOT_FOUND", "文档没有删除，请重新读取后核对。", { status: 404 });
        return { id: removed.rows[0]!.id };
      });
    },
  };
}
