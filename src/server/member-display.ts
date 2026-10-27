import type { Actor } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError, toErrorEnvelope } from "../shared/errors.ts";
import type { ProjectMember, TeamMember } from "../modules/projects/model.ts";

type Scope = "project" | "team";
type JsonObject = Record<string, unknown>;
type Row = { membership_id: string; user_id: string; role: string; status: string; revision: number; joined_at: string | Date; left_at: string | Date | null };
type NamedMember = (ProjectMember | TeamMember) & { displayName: string | null };
function object(value: unknown): JsonObject | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function instant(value: string | Date): string { return new Date(value).toISOString(); }
function unavailable(scope: Scope): never {
  throw new DomainError(scope === "project" ? "PROJECT_UNAVAILABLE" : "TEAM_UNAVAILABLE", scope === "project" ? "项目不存在或你尚未加入该项目。" : "队伍不存在或你尚未加入该队伍。", { status: 404 });
}
function headersFor(response: Response): Headers {
  const headers = new Headers(response.headers); headers.delete("content-length"); headers.delete("etag");
  headers.set("Cache-Control", "private, no-store"); return headers;
}
function memberFromRow(scope: Scope, scopeId: string, row: Row, displayName: string | null): NamedMember {
  return {
    membershipId: row.membership_id, userId: row.user_id, role: row.role as NamedMember["role"], status: row.status as NamedMember["status"],
    revision: row.revision, joinedAt: instant(row.joined_at), leftAt: row.left_at === null ? null : instant(row.left_at), displayName,
    ...(scope === "project" ? { projectId: scopeId } : { teamId: scopeId }),
  } as NamedMember;
}

/** Filter ONLY already-authorized team project links. A team role grants no project access. */
async function visibleTeamProjects(sql: SqlExecutor, teamId: string, actor: Actor, value: unknown): Promise<unknown[]> {
  if (!Array.isArray(value)) return [];
  const candidates = value.map(object).filter((item): item is JsonObject => Boolean(item && typeof item.id === "string" && item.teamId === teamId));
  const ids = [...new Set(candidates.map(item => item.id as string))].sort();
  if (!ids.length) return [];
  // M02 association mutations lock team first, then project. Keep the same order.
  const projects = await sql.query<{ id: string; team_id: string | null; revision: number }>(
    "SELECT id,team_id,revision FROM projects_project WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE", [ids]);
  const memberships = await sql.query<{ project_id: string }>(
    "SELECT project_id FROM projects_project_membership WHERE project_id=ANY($1::text[]) AND user_id=$2 AND status='active' ORDER BY project_id FOR SHARE", [ids, actor.userId]);
  const accessible = new Set(memberships.rows.map(row => row.project_id));
  const roots = new Map(projects.rows.map(row => [row.id, row]));
  // Avoid displaying outdated association or private goal/name data after a scope change.
  return candidates.filter(item => {
    const root = roots.get(item.id as string);
    return root?.team_id === teamId && root.revision === item.revision && accessible.has(root.id);
  });
}

/**
 * Decorate ONLY the successful authorized M02 GET detail/members handler response.
 * No independent user lookup is exposed. Lists, errors, mutations and unrelated
 * response shapes must not be routed here. Existing historical rows remain, but
 * exited members are never used to look up a current personal display name.
 */
export function createMemberDisplayDecorators({ database }: { database: DatabasePort }) {
  async function decorate(scope: Scope, actor: Actor | null, scopeId: string, response: Response): Promise<Response> {
    if (!response.ok || response.bodyUsed || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response;
    let envelope: JsonObject | null;
    try { envelope = object(await response.clone().json()); } catch { return response; }
    const data = envelope && !Object.hasOwn(envelope, "error") ? object(envelope.data) : null;
    const requester = data ? object(data.membership) : null;
    if (!data || !requester || !Array.isArray(data.members)) return response;
    const scopeField = scope === "project" ? "projectId" : "teamId";
    const entity = object(data[scope]);
    const responseRevision = entity?.revision ?? data[`${scope}Revision`];
    const requestId = typeof envelope!.requestId === "string" ? envelope!.requestId : "member-display";
    try {
      if (!actor || !actor.userId) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
      if (requester.userId !== actor.userId || requester[scopeField] !== scopeId || (entity && entity.id !== scopeId) || !positive(responseRevision)) unavailable(scope);
      const result = await database.transaction(async sql => {
        // Fresh identity precedes M02 roots, as in the application's other read guards.
        const user = await sql.query<{ id: string }>("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
        if (!user.rows.length) throw new DomainError("UNAUTHENTICATED", "登录状态已失效，请重新登录。", { status: 401 });
        const requested = (data.members as unknown[]).map(object).filter((item): item is JsonObject => Boolean(item && item[scopeField] === scopeId && typeof item.userId === "string" && typeof item.membershipId === "string"));
        const userIds = [...new Set(requested.filter(item => item.status === "active").map(item => item.userId as string))].sort();
        // Names are scoped to the active membership AND incoming authorized roster.
        // Lock identities before entity roots; do not request email/profile fields.
        const names = userIds.length ? await sql.query<{ id: string; display_name: string }>(
          `SELECT u.id,u.display_name FROM auth_users u JOIN projects_${scope}_membership m ON m.user_id=u.id
           WHERE m.${scope}_id=$1 AND m.status='active' AND u.id=ANY($2::text[]) AND u.status='active' AND u.email_verified_at IS NOT NULL
           ORDER BY u.id FOR SHARE OF u`, [scopeId, userIds]) : { rows: [] };
        const namesByUser = new Map(names.rows.map(row => [row.id, row.display_name]));
        const root = (await sql.query<{ revision: number }>(`SELECT revision FROM projects_${scope} WHERE id=$1 FOR SHARE`, [scopeId])).rows[0];
        if (!root) unavailable(scope);
        const membershipRows = await sql.query<Row>(`SELECT membership_id,user_id,role,status,revision,joined_at,left_at FROM projects_${scope}_membership WHERE ${scope}_id=$1 ORDER BY membership_id FOR SHARE`, [scopeId]);
        const currentRequester = membershipRows.rows.find(row => row.user_id === actor.userId && row.status === "active");
        if (!currentRequester || currentRequester.membership_id !== requester.membershipId) unavailable(scope);
        if (root.revision !== responseRevision) throw new DomainError("VERSION_CONFLICT", "成员或项目资料已更新，请刷新后再继续。", { status: 409, recoveryAction: "reload_latest_version", latestRevision: root.revision });
        const currentById = new Map(membershipRows.rows.map(row => [row.membership_id, row]));
        const projected: NamedMember[] = [];
        const seen = new Set<string>();
        for (const item of requested) {
          const row = currentById.get(item.membershipId as string);
          if (!row || row.user_id !== item.userId || seen.has(row.membership_id)) continue;
          // Do not turn a formerly active response row into a new historical lookup.
          if (row.status !== item.status || (row.status === "active" && !namesByUser.has(row.user_id))) continue;
          seen.add(row.membership_id);
          projected.push(memberFromRow(scope, scopeId, row, row.status === "active" ? namesByUser.get(row.user_id)! : null));
        }
        const nextData: JsonObject = { ...data, membership: memberFromRow(scope, scopeId, currentRequester, namesByUser.get(actor.userId) ?? null), members: projected };
        if (scope === "team" && Object.hasOwn(data, "projects")) nextData.projects = await visibleTeamProjects(sql, scopeId, actor, data.projects);
        // Serialization happens before releasing fresh authorization/name read locks.
        return Response.json({ ...envelope!, data: nextData }, { status: response.status, statusText: response.statusText, headers: headersFor(response) });
      });
      return result;
    } catch (error) {
      const safe = error instanceof DomainError ? error : new DomainError("MEMBER_DISPLAY_UNAVAILABLE", "暂时无法读取成员，请稍后刷新。", { status: 503, recoveryAction: "retry_later" });
      return Response.json(toErrorEnvelope(safe, requestId), { status: safe.status, headers: headersFor(response) });
    }
  }
  return {
    project: (actor: Actor | null, projectId: string, response: Response) => decorate("project", actor, projectId, response),
    team: (actor: Actor | null, teamId: string, response: Response) => decorate("team", actor, teamId, response),
  };
}
