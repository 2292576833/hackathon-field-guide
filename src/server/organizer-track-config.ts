import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { HostedEventAccessPort, OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import type { EventTeamTrackPort, TeamTrackConfiguration } from "../modules/event-registration/index.ts";

export interface OrganizerUsedTracksPort {
  /** Actual forming/locked team selections; empty string is a real unselected track. */
  getUsedTracks(sql: SqlExecutor, eventId: string): Promise<string[]>;
}
export interface OrganizerTrackConfigDependencies {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  getEvents(): HostedEventAccessPort;
  getRegistration(): OrganizerUsedTracksPort;
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  assertMutationAllowed(request: Request): Promise<void>;
}
export interface SaveOrganizerTracksInput {
  readonly expectedRevision: number;
  readonly required: boolean;
  readonly options: readonly { readonly id: string; readonly title: string }[];
}
interface TrackRow { revision: number; required: boolean; options: unknown }
const empty = (): TeamTrackConfiguration => ({ configured: false, required: false, revision: 0, options: [] });
function invalid(message: string): never { throw new DomainError("TRACK_CONFIG_INVALID", message, { status: 422 }); }
function eventIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\/\\\u0000-\u001f\u007f]/.test(value)) invalid("请从正确的比赛入口配置赛道。");
}
function normalize(value: unknown): SaveOrganizerTracksInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["expectedRevision", "required", "options"].includes(key))) invalid("请只填写赛道名称、编号和是否必选。");
  const body = value as Record<string, unknown>;
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) invalid("请重新读取当前赛道版本，再确认修改。");
  if (typeof body.required !== "boolean" || !Array.isArray(body.options) || body.options.length > 20) invalid("每场比赛最多20个赛道，请确认是否要求必选。");
  const ids = new Set<string>();
  const options = body.options.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["id", "title"].includes(key))) invalid("赛道只需填写固定编号和显示名称。");
    const option = value as Record<string, unknown>;
    if (typeof option.id !== "string" || !/^[a-z][a-z0-9_-]{0,49}$/.test(option.id) || ids.has(option.id)) invalid("赛道编号须唯一，由小写字母开头，只含字母、数字、短横线或下划线。");
    if (typeof option.title !== "string" || !option.title.trim() || option.title.length > 100 || /[\u0000-\u001f\u007f]/.test(option.title)) invalid("请填写100字以内的赛道名称。");
    ids.add(option.id); return { id: option.id, title: option.title.trim() };
  });
  if (body.required && !options.length) invalid("设为必选前，请至少添加一个赛道。");
  return { expectedRevision: body.expectedRevision as number, required: body.required, options };
}
function configuration(row: TrackRow | undefined): TeamTrackConfiguration {
  if (!row) return empty();
  const value = typeof row.options === "string" ? JSON.parse(row.options) : row.options;
  const checked = normalize({ expectedRevision: Number(row.revision), required: row.required, options: value });
  if (checked.expectedRevision < 1) throw new Error("Invalid persisted organizer track version.");
  return { configured: true, revision: checked.expectedRevision, required: checked.required, options: [...checked.options] };
}

/** Official track settings are staff-confirmed persistent facts, never generated defaults. */
export function createOrganizerTrackConfig(deps: OrganizerTrackConfigDependencies) {
  async function read(sql: SqlExecutor, eventId: string, organizationId: string, lock = false) {
    const rows = await sql.query<TrackRow>(`SELECT revision,required,options FROM organizer_track_configurations WHERE event_id=$1 AND organization_id=$2${lock ? " FOR UPDATE" : ""}`, [eventId, organizationId]);
    return configuration(rows.rows[0]);
  }
  const tracks: EventTeamTrackPort = {
    async getConfiguration(sql, eventId) {
      eventIdentifier(eventId);
      const event = await deps.getEvents().getEvent(sql, eventId);
      if (!event || event.eventId !== eventId) throw new DomainError("TRACK_EVENT_NOT_FOUND", "这场比赛暂时无法查看赛道。", { status: 404 });
      return read(sql, eventId, event.organizationId);
    },
  };
  async function get(principal: OrganizerPrincipal, eventId: string): Promise<TeamTrackConfiguration> {
    eventIdentifier(eventId);
    return deps.database.transaction(async sql => {
      await principal.guard(sql);
      const event = await deps.getEvents().requireStaff(sql, principal.actor, eventId, "event_manage");
      const value = await read(sql, eventId, event.organizationId);
      await principal.guard(sql);
      await deps.getEvents().requireStaff(sql, principal.actor, eventId, "event_manage");
      return value;
    });
  }
  async function save(principal: OrganizerPrincipal, eventId: string, raw: unknown): Promise<TeamTrackConfiguration> {
    eventIdentifier(eventId); const input = normalize(raw);
    return deps.database.transaction(async sql => {
      await principal.guard(sql);
      const event = await deps.getEvents().requireStaff(sql, principal.actor, eventId, "event_manage");
      if (!["draft", "published"].includes(event.status)) throw new DomainError("TRACK_CONFIG_READ_ONLY", "比赛已结束，保留赛道历史，不能再修改选手规则。", { status: 409 });
      const before = await read(sql, eventId, event.organizationId, true);
      if (before.revision !== input.expectedRevision) throw new DomainError("TRACK_CONFIG_REVISION_CONFLICT", "赛道已被其他工作人员更新，请重新读取；本页输入可以保留。", { status: 409, latestRevision: before.revision, recoveryAction: "reload" });
      const used = await deps.getRegistration().getUsedTracks(sql, eventId);
      if (!Array.isArray(used) || used.some(value => typeof value !== "string")) throw new Error("Invalid current team track facts.");
      const available = new Set(input.options.map(option => option.id));
      const missing = [...new Set(used.filter(id => id && !available.has(id)))];
      if (missing.length) {
        const labels = missing.map(id => before.options.find(option => option.id === id)?.title ?? id).slice(0, 5).join("、");
        throw new DomainError("TRACK_CONFIG_IN_USE", `已有队伍选择了“${labels}”。请保留这些赛道；你可以添加其它选项。`, { status: 409, recoveryAction: "preserve_used_tracks" });
      }
      if (input.required && used.includes("")) throw new DomainError("TRACK_CONFIG_UNSELECTED_TEAMS", "当前有尚未选择赛道的队伍。请先保持选填，避免已有队伍突然失去参赛资格。", { status: 409, recoveryAction: "keep_optional" });
      const next: TeamTrackConfiguration = { configured: true, required: input.required, revision: before.revision + 1, options: [...input.options] };
      if (before.configured) {
        const updated = await sql.query("UPDATE organizer_track_configurations SET revision=$1,required=$2,options=$3::jsonb WHERE event_id=$4 AND organization_id=$5 AND revision=$6", [next.revision, next.required, JSON.stringify(next.options), eventId, event.organizationId, before.revision]);
        if (updated.rowCount !== 1) throw new DomainError("TRACK_CONFIG_REVISION_CONFLICT", "赛道已更新，请重新读取后核对。", { status: 409 });
      } else await sql.query("INSERT INTO organizer_track_configurations(event_id,organization_id,revision,required,options) VALUES($1,$2,$3,$4,$5::jsonb)", [eventId, event.organizationId, next.revision, next.required, JSON.stringify(next.options)]);
      await sql.query("INSERT INTO organizer_track_versions(id,event_id,organization_id,revision,changed_by,changed_at,before_configuration,configuration) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)", [deps.ids.next(), eventId, event.organizationId, next.revision, principal.actor.userId, deps.clock.now().toISOString(), JSON.stringify(before), JSON.stringify(next)]);
      await principal.guard(sql);
      await deps.getEvents().requireStaff(sql, principal.actor, eventId, "event_manage");
      return next;
    });
  }
  async function readBody(request: Request): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || (request.headers.get("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")) throw new DomainError("JSON_REQUIRED", "请通过本站赛道表单提交。", { status: 415 });
    const reader = request.body?.getReader(); if (!reader) throw new DomainError("INVALID_JSON", "请填写赛道设置。", { status: 400 });
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16 * 1024) { void reader.cancel().catch(() => {}); throw new DomainError("BODY_TOO_LARGE", "赛道设置过长，请精简后保存。", { status: 413 }); } parts.push(chunk.value); }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); }
    catch { throw new DomainError("INVALID_JSON", "赛道表单无法读取，请重新填写。", { status: 400 }); }
  }
  return { tracks, get, save, async handle(request: Request, segments: readonly string[]): Promise<Response | null> {
    if (segments.length !== 4 || segments[0] !== "organizer" || segments[1] !== "events" || segments[3] !== "tracks") return null;
    const requestId = deps.ids.next(), headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
    try {
      eventIdentifier(segments[2]);
      if (!["GET", "PUT"].includes(request.method)) throw new DomainError("METHOD_NOT_ALLOWED", "请通过赛道设置页面查看或保存。", { status: 405 });
      if (request.method === "PUT") await deps.assertMutationAllowed(request);
      const principal = await deps.resolvePrincipal(request);
      if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续配置当前比赛。", { status: 401 });
      const value = request.method === "GET" ? await get(principal, segments[2]) : await save(principal, segments[2], await readBody(request));
      return Response.json({ data: value, requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { ...headers, ...(isDomainError(error) && error.status === 405 ? { Allow: "GET, PUT" } : {}) } }); }
  } };
}
export type OrganizerTrackConfig = ReturnType<typeof createOrganizerTrackConfig>;
