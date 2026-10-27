import type { Actor, Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { CARD, SCALE_MAX, SCALE_MIN, isSpaceComponentKind, normalizeCanvasLayout, type CanvasPlacement } from "../modules/space-workflow/canvas-board.ts";

/**
 * 空间画布摆放（规划27 追加 · "组件箱 + 自由画布"）。
 *
 * 边界：
 *  - 只存**摆放偏好**（哪些组件、在哪、是否折叠），不存业务数据；
 *  - "删除"只是从画布移除，可随时加回；业务内容不受影响；
 *  - 严格按 (项目, 本人) 隔离，画布是私人偏好，队友互不影响；
 *  - revision 乐观并发，避免两个标签页互相覆盖。
 */
export interface CanvasLayoutRecord { readonly revision: number; readonly items: readonly CanvasPlacement[] }
interface LayoutRow { revision: number | string; items: unknown }

function payloadOf(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new DomainError("INVALID_INPUT", "画布摆放格式不正确，请只提交当前表单中的字段。", { status: 422 });
  }
  return value as Record<string, unknown>;
}

function savedLayout(row: LayoutRow): CanvasLayoutRecord {
  return { revision: Number(row.revision), items: normalizeCanvasLayout(row.items).items };
}

/** 客户端提交的摆放项必须是已知组件与合法坐标；未知内容一律拒绝，不静默吞掉。 */
function validatePlacements(value: unknown): CanvasPlacement[] {
  if (!Array.isArray(value) || value.length > 100) throw new DomainError("INVALID_INPUT", "画布摆放应为最多100个组件的列表。", { status: 422 });
  for (const raw of value) {
    const item = payloadOf(raw, ["instanceId", "kind", "x", "y", "collapsed", "width", "height", "scale"]);
    const validNumber = (field: string, min: number, max = Number.MAX_SAFE_INTEGER) => typeof item[field] === "number"
      && Number.isFinite(item[field]) && (item[field] as number) >= min && (item[field] as number) <= max;
    if (typeof item.instanceId !== "string" || !item.instanceId.trim() || item.instanceId.length > 200
      || /[\u0000-\u001f\u007f]/.test(item.instanceId) || !isSpaceComponentKind(item.kind)
      || !validNumber("x", 0) || !validNumber("y", 0) || typeof item.collapsed !== "boolean"
      || Object.hasOwn(item, "width") && !validNumber("width", CARD.minWidth, CARD.maxWidth)
      || Object.hasOwn(item, "height") && !validNumber("height", CARD.minHeight, CARD.maxHeight)
      || Object.hasOwn(item, "scale") && !validNumber("scale", SCALE_MIN, SCALE_MAX)) {
      throw new DomainError("INVALID_INPUT", "画布组件、坐标或尺寸不正确，请重新读取后再调整。", { status: 422 });
    }
  }
  const normalized = normalizeCanvasLayout(value);
  if (normalized.items.length !== value.length) throw new DomainError("INVALID_INPUT", "画布里有无法识别的组件或重复实例。", { status: 422 });
  return [...normalized.items];
}

export function createSpaceCanvasLayouts(deps: { database: DatabasePort; clock: Clock }) {
  async function assertMember(sql: SqlExecutor, actor: Actor, projectId: string, writing = false) {
    const account = await sql.query<{ id: string }>("SELECT id FROM auth_users WHERE id=$1 AND status='active' FOR SHARE", [actor.userId]);
    if (!account.rows.length) throw new DomainError("FORBIDDEN", "当前账号无法使用空间画布，请重新登录后核对。", { status: 403 });
    const project = await sql.query<{ id: string }>("SELECT id FROM projects_project WHERE id=$1 FOR SHARE", [projectId]);
    // A membership always exists before any private layout row. Locking it also
    // serializes two first saves, when no layout row yet exists to lock.
    const member = await sql.query<{ membership_id: string }>(
      `SELECT membership_id FROM projects_project_membership WHERE project_id=$1 AND user_id=$2 AND status='active' FOR ${writing ? "UPDATE" : "SHARE"}`, [projectId, actor.userId]);
    if (!project.rows.length || !member.rows.length) throw new DomainError("FORBIDDEN", "你不是这个空间的活跃成员，无法查看或保存画布摆放。", { status: 403 });
  }
  return {
    /** 读取本人画布；没有记录时返回空画布（revision 0），GET 不初始化状态。 */
    async get(actor: Actor, projectId: string): Promise<CanvasLayoutRecord> {
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId);
        const row = await sql.query<LayoutRow>(
          "SELECT revision, items FROM space_canvas_items WHERE project_id=$1 AND user_id=$2", [projectId, actor.userId]);
        const found = row.rows[0];
        if (!found) return { revision: 0, items: [] };
        return savedLayout(found);
      });
    },
    /** 整体保存画布；expectedRevision 为 0 表示首次保存。 */
    async save(actor: Actor, projectId: string, input: unknown): Promise<CanvasLayoutRecord> {
      const body = payloadOf(input, ["expectedRevision", "items"]);
      const expected = body.expectedRevision;
      if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 || expected >= 2147483647) throw new DomainError("INVALID_INPUT", "页面版本缺失或无效，请重新读取后再保存。", { status: 422 });
      const items = validatePlacements(body.items);
      const now = deps.clock.now().toISOString();
      return deps.database.transaction(async sql => {
        await assertMember(sql, actor, projectId, true);
        const current = await sql.query<{ revision: number | string }>(
          "SELECT revision FROM space_canvas_items WHERE project_id=$1 AND user_id=$2 FOR UPDATE", [projectId, actor.userId]);
        const found = current.rows[0];
        const actual = found ? Number(found.revision) : 0;
        if (actual !== expected) throw new DomainError("VERSION_CONFLICT", "画布已在别处修改，请重新读取后再调整。", { status: 409 });
        const nextRevision = actual + 1;
        const saved = found
          ? await sql.query<LayoutRow>("UPDATE space_canvas_items SET revision=$3, items=$4::jsonb, updated_at=$5::timestamptz WHERE project_id=$1 AND user_id=$2 AND revision=$6 RETURNING revision,items",
            [projectId, actor.userId, nextRevision, JSON.stringify(items), now, actual])
          : await sql.query<LayoutRow>("INSERT INTO space_canvas_items(project_id,user_id,revision,items,updated_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz) RETURNING revision,items",
            [projectId, actor.userId, nextRevision, JSON.stringify(items), now]);
        if (saved.rowCount !== 1 || saved.rows.length !== 1) throw new DomainError("VERSION_CONFLICT", "画布没有保存，请重新读取后再试。", { status: 409 });
        return savedLayout(saved.rows[0]!);
      });
    },
  };
}
