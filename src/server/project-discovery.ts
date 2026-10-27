import type { Actor, Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { ProjectsService } from "../modules/projects/index.ts";
import { DomainError } from "../shared/errors.ts";
import type { DiscoveryCard, DiscoveryInput } from "./discovery.ts";

export interface ProjectDiscoveryDraft {
  projectId: string; discoveryId: string; discoveryRevision: number; revision: number;
  snapshot: DiscoveryCard; notes: string; status: "draft"; savedBy: string; savedAt: string;
}
export interface ProjectDiscoveryView {
  revision: number; draft: ProjectDiscoveryDraft | null;
  sourceState: "current" | "changed" | "unavailable" | null;
}
type SessionGuard = (sql: SqlExecutor) => Promise<void>;
function invalid(): never { throw new DomainError("INVALID_DISCOVERY_DRAFT", "赛事线索草案内容无效，请重新选择比赛并检查备注。", { status: 400 }); }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function revision(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_646) invalid();
  return value;
}
function conflict(): never { throw new DomainError("DISCOVERY_DRAFT_CHANGED", "队友已经修改了赛事线索草案，请重新读取后再保存。", { status: 409 }); }

export function createProjectDiscoveryService(deps: { database: DatabasePort; projects: Pick<ProjectsService, "getProject">; clock: Clock }) {
  async function authorize(sql: SqlExecutor, actor: Actor, projectId: string, writing: boolean, session?: SessionGuard) {
    // Root identity/session -> M02 project lock -> draft -> discovery. Keep
    // these locks until the outer transaction commits, including M02 savepoints.
    const user = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (!user.rowCount) throw new DomainError("UNAUTHENTICATED", "请重新登录。", { status: 401 });
    await session?.(sql);
    const detail = await deps.projects.getProject(actor, projectId);
    if (writing && detail.membership.role !== "manager") throw new DomainError("PROJECT_MANAGER_REQUIRED", "只有项目管理员可以修改赛事线索草案。", { status: 403 });
    if (writing && detail.project.stage === "archived") throw new DomainError("PROJECT_ARCHIVED", "归档项目不能修改赛事线索草案。", { status: 409 });
  }
  async function current(sql: SqlExecutor, projectId: string) {
    return (await sql.query<{ revision: number; body: ProjectDiscoveryDraft | null }>("SELECT revision,body FROM project_discovery_drafts WHERE project_id=$1 FOR UPDATE", [projectId])).rows[0];
  }
  async function persist(sql: SqlExecutor, projectId: string, nextRevision: number, body: ProjectDiscoveryDraft | null, actor: Actor, at: string) {
    await sql.query("INSERT INTO project_discovery_drafts(project_id,revision,body,updated_at) VALUES($1,$2,$3::jsonb,$4::timestamptz) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at", [projectId, nextRevision, body === null ? null : JSON.stringify(body), at]);
    await sql.query("INSERT INTO project_discovery_draft_versions(project_id,revision,body,saved_by,saved_at) VALUES($1,$2,$3::jsonb,$4,$5::timestamptz)", [projectId, nextRevision, body === null ? null : JSON.stringify(body), actor.userId, at]);
  }
  return {
    async get(actor: Actor, projectId: string, session?: SessionGuard): Promise<ProjectDiscoveryView> {
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, false, session);
        const stored = await current(sql, projectId), draft = stored?.body ?? null;
        let sourceState: ProjectDiscoveryView["sourceState"] = null;
        if (draft) {
          const card = (await sql.query<{ revision: number; status: string }>("SELECT revision,status FROM event_discovery_cards WHERE id=$1", [draft.discoveryId])).rows[0];
          sourceState = !card || card.status !== "active" ? "unavailable" : card.revision !== draft.discoveryRevision ? "changed" : "current";
        }
        return { revision: stored?.revision ?? 0, draft, sourceState };
      });
    },
    async save(actor: Actor, projectId: string, value: unknown, session?: SessionGuard): Promise<ProjectDiscoveryView> {
      const input = fields(value, ["discoveryId", "discoveryRevision", "expectedRevision", "notes"]);
      const expectedRevision = revision(input.expectedRevision), discoveryRevision = revision(input.discoveryRevision, 1);
      if (typeof input.discoveryId !== "string" || !/^[a-f0-9]{64}$/.test(input.discoveryId)) invalid();
      if (typeof input.notes !== "string" || input.notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.notes)) invalid();
      const discoveryId = input.discoveryId, notes = input.notes.trim();
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, true, session);
        const stored = await current(sql, projectId);
        if ((stored?.revision ?? 0) !== expectedRevision) conflict();
        const card = (await sql.query<{ revision: number; status: string; content: DiscoveryInput }>("SELECT revision,status,content FROM event_discovery_cards WHERE id=$1 FOR SHARE", [discoveryId])).rows[0];
        if (!card || card.status !== "active") throw new DomainError("DISCOVERY_UNAVAILABLE", "这条赛事线索已不可用，请选择其他比赛。", { status: 404 });
        if (card.revision !== discoveryRevision) throw new DomainError("DISCOVERY_CHANGED", "比赛分析已有更新，请重新选择并核对最新内容。", { status: 409 });
        const at = deps.clock.now().toISOString(), nextRevision = expectedRevision + 1;
        const snapshot: DiscoveryCard = { ...card.content, id: discoveryId, revision: card.revision, verificationStatus: "unverified" };
        const draft: ProjectDiscoveryDraft = { projectId, discoveryId, discoveryRevision, revision: nextRevision, snapshot, notes, status: "draft", savedBy: actor.userId, savedAt: at };
        await persist(sql, projectId, nextRevision, draft, actor, at);
        return { revision: nextRevision, draft, sourceState: "current" };
      });
    },
    async clear(actor: Actor, projectId: string, value: unknown, session?: SessionGuard): Promise<ProjectDiscoveryView> {
      const input = fields(value, ["expectedRevision"]), expectedRevision = revision(input.expectedRevision);
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, true, session);
        const stored = await current(sql, projectId);
        if ((stored?.revision ?? 0) !== expectedRevision) conflict();
        if (!stored?.body) return { revision: stored?.revision ?? 0, draft: null, sourceState: null };
        const nextRevision = expectedRevision + 1;
        await persist(sql, projectId, nextRevision, null, actor, deps.clock.now().toISOString());
        return { revision: nextRevision, draft: null, sourceState: null };
      });
    },
  };
}
