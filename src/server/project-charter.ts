import { DomainError } from "../shared/errors.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import type { Clock } from "../shared/contracts.ts";

/**
 * 项目框架卡：立项时定死目标、交付物、验收、明确不做、时间盒。
 * 只有本人确认后才 locked=true；AI 没有写入口，改框架必须显式升版本。
 */
export interface Charter {
  readonly version: number;
  readonly goal: string;
  readonly deliverables: readonly string[];
  readonly acceptance: string;
  readonly nonGoals: readonly string[];
  readonly timebox: string;
  readonly locked: boolean;
  readonly updatedAt: string;
}

const LIMIT = 400;
const MAX_ITEMS = 12;

function lines(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : null;
  if (list === null) throw new DomainError("CHARTER_INVALID", label + "格式不对。", { status: 422 });
  const items = list.map(item => (typeof item === "string" ? item.trim() : "")).filter(item => item !== "");
  if (items.length > MAX_ITEMS) throw new DomainError("CHARTER_TOO_MANY", label + "最多 " + MAX_ITEMS + " 条。", { status: 422 });
  if (items.some(item => item.length > 200)) throw new DomainError("CHARTER_TOO_LONG", label + "每条不超过 200 字。", { status: 422 });
  return items;
}

export function createProjectCharterService(deps: { database: DatabasePort; clock: Clock; canAccess: (userId: string, projectId: string) => Promise<boolean> }) {
  async function read(userId: string, projectId: string): Promise<Charter | null> {
    if (!await deps.canAccess(userId, projectId)) throw new DomainError("CHARTER_FORBIDDEN", "你不是这个项目的成员。", { status: 403 });
    const rows = await deps.database.query<Record<string, unknown>>("SELECT * FROM project_charters WHERE project_id=$1", [projectId]);
    const row = rows.rows[0];
    if (!row) return null;
    return {
      version: Number(row.version), goal: String(row.goal),
      deliverables: (row.deliverables as string[]) ?? [], acceptance: String(row.acceptance ?? ""),
      nonGoals: (row.non_goals as string[]) ?? [], timebox: String(row.timebox ?? ""),
      locked: row.locked === true, updatedAt: new Date(row.updated_at as Date).toISOString(),
    };
  }

  /** 保存即升版本；已锁定的卡必须显式带 expectedVersion 才能改。 */
  async function save(userId: string, projectId: string, input: unknown): Promise<Charter> {
    if (!await deps.canAccess(userId, projectId)) throw new DomainError("CHARTER_FORBIDDEN", "你不是这个项目的成员。", { status: 403 });
    const body = (input ?? {}) as Record<string, unknown>;
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (goal === "" || goal.length > LIMIT) throw new DomainError("CHARTER_GOAL_REQUIRED", "目标必填，且不超过 " + LIMIT + " 字。", { status: 422 });
    const current = await read(userId, projectId);
    if (current !== null && current.locked && body.expectedVersion !== current.version)
      throw new DomainError("CHARTER_VERSION_CONFLICT", "框架卡已锁定，改动需要带上当前版本号。", { status: 409 });
    const next = (current?.version ?? 0) + 1;
    const locked = body.locked === true;
    await deps.database.query(
      "INSERT INTO project_charters(project_id,version,goal,deliverables,acceptance,non_goals,timebox,locked,updated_by,updated_at) VALUES($1,$2,$3,$4::text[],$5,$6::text[],$7,$8,$9,$10::timestamptz) ON CONFLICT (project_id) DO UPDATE SET version=EXCLUDED.version,goal=EXCLUDED.goal,deliverables=EXCLUDED.deliverables,acceptance=EXCLUDED.acceptance,non_goals=EXCLUDED.non_goals,timebox=EXCLUDED.timebox,locked=EXCLUDED.locked,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at",
      [projectId, next, goal, lines(body.deliverables, "交付物"), typeof body.acceptance === "string" ? body.acceptance.trim().slice(0, 600) : "",
        lines(body.nonGoals, "明确不做"), typeof body.timebox === "string" ? body.timebox.trim().slice(0, 60) : "", locked, userId, deps.clock.now().toISOString()],
    );
    return (await read(userId, projectId))!;
  }

  return { read, save };
}
