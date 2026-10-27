import type { EntityId } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope, OrganizerPrincipal, EventStaffCapability, EventModuleKey } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type {
  EventScheduleDependencies, EventScheduleService, ScheduleDraft, ScheduleItem,
  ScheduleItemInput, SaveScheduleDraftInput, PublishedSchedule, ScheduleImportPreview,
  IcebreakerActivity, IcebreakerGroup, IcebreakerChoice,
} from "./schedule-model.ts";

type ScheduleDocument = { timezone: string; items: ScheduleItem[]; impact: string };
type ScheduleRow = { revision: number; published_revision: number | null; document: ScheduleDocument; updated_at: Date | string };
type ActivityDocument = { title: string; description: string; startsAt: string; location: string };
type ActivityRow = { id: string; revision: number; document: ActivityDocument };
type GroupRow = { id: string; title: string; revision: number };
type ResponseRow = { user_id: string; choice: IcebreakerChoice; updated_at: Date | string };
type PreviewRow = { document: ScheduleImportPreview; actor_user_id: string; expires_at: Date | string; confirmed_revision: number | null };

const invalid = (message: string): never => { throw new DomainError("SCHEDULE_INVALID", message, { status: 422 }); };
const missing = (): never => { throw new DomainError("EVENT_SERVICE_NOT_FOUND", "当前比赛中没有这条记录。", { status: 404 }); };
const conflict = (latestRevision: number): never => { throw new DomainError("EVENT_SERVICE_REVISION_CONFLICT", "安排已更新，请重新读取后核对；你填写的内容仍可保留。", { status: 409, latestRevision }); };
function text(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum) invalid(`${name}格式不正确或过长。`);
  const normalized = (value as string).trim();
  if (!allowEmpty && !normalized) invalid(`请填写${name}。`);
  return normalized;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid("请提供当前版本。");
  return value as number;
}
function assertObject(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请求内容需为一组明确字段。");
}
function instant(value: unknown, label: string): string {
  const source = text(value, label, 64);
  // Explicit offset is essential: a server's local timezone cannot interpret a CSV time.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(source);
  if (!match) invalid(`${label}需包含时区，例如 2026-10-11T09:00:00+08:00。`);
  const year = Number(match![1]), month = Number(match![2]), day = Number(match![3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(match![4]) > 23 || Number(match![5]) > 59 || Number(match![6] ?? 0) > 59) invalid(`${label}不是有效时间。`);
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) invalid(`${label}不是有效时间。`);
  return parsed.toISOString();
}
function timezone(value: unknown): string {
  const zone = text(value, "时区", 100);
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: zone }).format(new Date(0)); }
  catch { invalid("请选择有效的时区，例如 Asia/Shanghai。"); }
  return zone;
}
function users(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 300) invalid("适用人员最多 300 人。");
  const result = (value as unknown[]).map(item => text(item, "用户标识", 128));
  if (new Set(result).size !== result.length) invalid("用户标识不可重复。");
  return result;
}
function iso(value: Date | string): string { return new Date(value).toISOString(); }
function assertSameScope(previous: HostedEventScope, next: HostedEventScope): void {
  if (previous.eventId !== next.eventId || previous.organizationId !== next.organizationId) missing();
}
function publiclyVisible(event: HostedEventScope): boolean { return event.status !== "draft" && event.publishedRevision !== null; }
function assertWrite(event: HostedEventScope, flag: EventModuleKey): void {
  if (event.status === "archived") throw new DomainError("EVENT_ARCHIVED", "比赛已归档，只能查看已有记录。", { status: 409 });
  if (!event.modules[flag]) throw new DomainError("EVENT_MODULE_DISABLED", "该比赛已关闭此功能，已有记录仍可查看。", { status: 409 });
}

/** Bounded CSV parser; quoted commas/newlines/doubled quotes are supported. */
function parseCsv(csv: unknown): string[][] {
  if (typeof csv !== "string" || Buffer.byteLength(csv, "utf8") > 262144) invalid("CSV 需为文字且不超过 256 KB。");
  const source = (csv as string).replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, afterQuote = false;
  const finishCell = () => { row.push(cell); cell = ""; afterQuote = false; };
  const finishRow = () => { finishCell(); if (row.some(value => value !== "")) rows.push(row); row = []; if (rows.length > 301) invalid("CSV 最多 300 条行程。"); };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (char === '"') {
      if (cell !== "" || afterQuote) invalid("CSV 引号位置不正确。");
      quoted = true;
    } else if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && source[index + 1] === "\n") index++; finishRow(); }
    else if (afterQuote) { if (char !== " " && char !== "\t") invalid("CSV 引号后只能是分隔符。"); }
    else cell += char;
  }
  if (quoted) invalid("CSV 有未闭合的引号。");
  if (cell !== "" || row.length || afterQuote) finishRow();
  return rows;
}

/** SQL persistence is provided by the injected database; no production memory fallback. */
export function createEventScheduleService(dependencies: EventScheduleDependencies): EventScheduleService {
  const { database, eventAccess, participation, clock, ids } = dependencies;
  const now = () => clock.now().toISOString();

  async function event(sql: SqlExecutor, eventId: string, write = false): Promise<HostedEventScope> {
    const scope = await eventAccess.getEvent(sql, text(eventId, "比赛标识", 128), { forUpdate: write });
    if (!scope || scope.eventId !== eventId) missing();
    return scope!;
  }
  async function staff(sql: SqlExecutor, principal: OrganizerPrincipal, current: HostedEventScope, capability: EventStaffCapability): Promise<void> {
    const authorized = await eventAccess.requireStaff(sql, principal.actor, current.eventId, capability);
    assertSameScope(current, authorized);
  }
  async function approved(sql: SqlExecutor, current: HostedEventScope, userId: string): Promise<void> {
    const registration = await participation.getRegistration(sql, current.eventId, userId);
    if (!registration || registration.eventId !== current.eventId || registration.userId !== userId || registration.status !== "approved") {
      throw new DomainError("EVENT_PARTICIPATION_REQUIRED", "请先完成本场比赛报名并通过审核。", { status: 403 });
    }
  }
  async function refresh(sql: SqlExecutor, principal: OrganizerPrincipal | null, current: HostedEventScope,
    capability?: EventStaffCapability, writeFlag?: EventModuleKey): Promise<HostedEventScope> {
    const latest = await event(sql, current.eventId);
    assertSameScope(current, latest);
    if (capability && principal) await staff(sql, principal, latest, capability);
    if (writeFlag) assertWrite(latest, writeFlag);
    return latest;
  }
  async function transaction<T>(principal: OrganizerPrincipal | null, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return database.transaction(async sql => {
      if (principal) await principal.guard(sql);
      const result = await work(sql);
      if (principal) await principal.guard(sql);
      return result;
    });
  }
  async function getState(sql: SqlExecutor, current: HostedEventScope, lock = false): Promise<ScheduleRow | null> {
    const result = await sql.query<ScheduleRow>(`SELECT revision,published_revision,document,updated_at FROM ec_schedule_state
      WHERE organization_id=$1 AND event_id=$2${lock ? " FOR UPDATE" : ""}`, [current.organizationId, current.eventId]);
    return result.rows[0] ?? null;
  }
  function draft(current: HostedEventScope, row: ScheduleRow | null): ScheduleDraft {
    return { eventId: current.eventId, organizationId: current.organizationId, revision: row?.revision ?? 0,
      publishedRevision: row?.published_revision ?? null, timezone: row?.document.timezone ?? current.timezone,
      items: row?.document.items ?? [], impact: row?.document.impact ?? "", updatedAt: row ? iso(row.updated_at) : null };
  }
  function normalizeItem(input: ScheduleItemInput): ScheduleItem {
    if (!input || typeof input !== "object") invalid("行程格式不正确。");
    const startsAt = instant(input.startsAt, "开始时间"), endsAt = instant(input.endsAt, "结束时间");
    if (endsAt <= startsAt) invalid("结束时间需晚于开始时间。");
    if (!["all", "participants", "users"].includes(input.audience)) invalid("请选择适用范围。");
    const userIds = users(input.userIds ?? []);
    if (input.audience === "users" && userIds.length === 0) invalid("指定人员行程至少选择一人。");
    if (input.audience !== "users" && userIds.length !== 0) invalid("只有指定人员行程可以包含用户标识。");
    return { id: input.id ? text(input.id, "条目标识", 128) : ids.next(), title: text(input.title, "行程名称", 200),
      startsAt, endsAt, location: text(input.location, "地点", 500), audience: input.audience, userIds };
  }
  function normalizeDocument(input: SaveScheduleDraftInput, hasPublished: boolean): ScheduleDocument {
    if (!input || typeof input !== "object") invalid("请填写行程。");
    if (!Array.isArray(input.items) || input.items.length > 300) invalid("行程最多 300 条。");
    const items = input.items.map(normalizeItem);
    if (new Set(items.map(item => item.id)).size !== items.length) invalid("行程条目标识不可重复。");
    const impact = text(input.impact ?? "", "更新影响说明", 2000, !hasPublished);
    return { timezone: timezone(input.timezone), items, impact };
  }
  async function ensureRecipients(sql: SqlExecutor, current: HostedEventScope, items: readonly ScheduleItem[]): Promise<void> {
    for (const userId of [...new Set(items.flatMap(item => item.userIds))].sort()) await approved(sql, current, userId);
  }
  async function writeDraft(sql: SqlExecutor, principal: OrganizerPrincipal, current: HostedEventScope, input: SaveScheduleDraftInput): Promise<ScheduleDraft> {
    assertObject(input);
    const expected = revision(input.expectedRevision), existing = await getState(sql, current, true);
    if ((existing?.revision ?? 0) !== expected) conflict(existing?.revision ?? 0);
    const document = normalizeDocument(input, existing?.published_revision !== null && existing !== null);
    await ensureRecipients(sql, current, document.items);
    const at = now();
    if (existing) {
      const updated = await sql.query(`UPDATE ec_schedule_state SET revision=$3,document=$4::jsonb,updated_by=$5,updated_at=$6
        WHERE organization_id=$1 AND event_id=$2 AND revision=$7`, [current.organizationId, current.eventId, expected + 1, JSON.stringify(document), principal.actor.userId, at, expected]);
      if (updated.rowCount !== 1) conflict(expected);
    } else {
      const inserted = await sql.query(`INSERT INTO ec_schedule_state(organization_id,event_id,revision,document,updated_by,updated_at)
        VALUES($1,$2,1,$3::jsonb,$4,$5) ON CONFLICT(organization_id,event_id) DO NOTHING`, [current.organizationId, current.eventId, JSON.stringify(document), principal.actor.userId, at]);
      if (inserted.rowCount !== 1) conflict((await getState(sql, current))?.revision ?? 0);
    }
    await refresh(sql, principal, current, "schedule_manage", "schedule");
    await ensureRecipients(sql, current, document.items);
    return draft(current, { revision: expected + 1, published_revision: existing?.published_revision ?? null, document, updated_at: at });
  }
  function projection(current: HostedEventScope, document: ScheduleDocument | null, publishedRevision: number | null,
    publishedAt: Date | string | null, approvedUserId: string | null, includeAll = false): PublishedSchedule {
    return { eventId: current.eventId, enabled: current.modules.schedule, revision: publishedRevision,
      timezone: document?.timezone ?? current.timezone, impact: document?.impact ?? "", publishedAt: publishedAt ? iso(publishedAt) : null,
      items: (document?.items ?? []).filter(item => includeAll || item.audience === "all"
        || (approvedUserId && (item.audience === "participants" || item.userIds.includes(approvedUserId))))
        .map(({ userIds: _recipients, ...item }) => item) };
  }
  async function activity(sql: SqlExecutor, current: HostedEventScope, activityId: string, lock = false): Promise<ActivityRow> {
    const result = await sql.query<ActivityRow>(`SELECT id,revision,document FROM ec_icebreaker_activities
      WHERE organization_id=$1 AND event_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`, [current.organizationId, current.eventId, text(activityId, "活动标识", 128)]);
    if (!result.rows[0]) missing();
    return result.rows[0]!;
  }
  async function groups(sql: SqlExecutor, current: HostedEventScope, activityId: string, ownUserId?: string): Promise<IcebreakerGroup[]> {
    const result = await sql.query<GroupRow>(`SELECT g.id,g.title,g.revision FROM ec_icebreaker_groups g
      WHERE g.organization_id=$1 AND g.event_id=$2 AND g.activity_id=$3${ownUserId ? ` AND EXISTS(SELECT 1 FROM ec_icebreaker_group_members m
        WHERE m.organization_id=g.organization_id AND m.event_id=g.event_id AND m.activity_id=g.activity_id AND m.group_id=g.id AND m.user_id=$4)` : ""} ORDER BY g.title,g.id`, ownUserId
      ? [current.organizationId, current.eventId, activityId, ownUserId] : [current.organizationId, current.eventId, activityId]);
    const members = await sql.query<{ group_id: string; user_id: string }>(`SELECT group_id,user_id FROM ec_icebreaker_group_members
      WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3${ownUserId ? ` AND group_id IN(SELECT group_id FROM ec_icebreaker_group_members
        WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND user_id=$4)` : ""} ORDER BY user_id`, ownUserId
      ? [current.organizationId, current.eventId, activityId, ownUserId] : [current.organizationId, current.eventId, activityId]);
    return result.rows.map(row => ({ id: row.id, title: row.title, revision: row.revision,
      memberUserIds: members.rows.filter(member => member.group_id === row.id).map(member => member.user_id) }));
  }
  async function recordGroup(sql: SqlExecutor, principal: OrganizerPrincipal, current: HostedEventScope, activityId: string, group: IcebreakerGroup): Promise<void> {
    await sql.query(`INSERT INTO ec_icebreaker_group_versions(organization_id,event_id,activity_id,group_id,revision,document,recorded_by,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [current.organizationId, current.eventId, activityId, group.id, group.revision, JSON.stringify(group), principal.actor.userId, now()]);
  }
  async function requireJoined(sql: SqlExecutor, current: HostedEventScope, activityId: string, userIds: readonly string[]): Promise<void> {
    for (const userId of [...userIds].sort()) {
      await approved(sql, current, userId);
      const response = await sql.query<{ choice: IcebreakerChoice }>(`SELECT choice FROM ec_icebreaker_responses
        WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND user_id=$4`, [current.organizationId, current.eventId, activityId, userId]);
      if (response.rows[0]?.choice !== "join") throw new DomainError("ICEBREAKER_OPT_IN_REQUIRED", "只能安排已自愿参加此活动的选手。", { status: 409 });
    }
  }

  const service: EventScheduleService = {
    getSchedule(principal, eventId) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId);
        if (!publiclyVisible(current)) missing();
        let registration = principal ? await participation.getRegistration(sql, eventId, principal.actor.userId) : null;
        const result = await sql.query<{ revision: number; document: ScheduleDocument; published_at: Date | string }>(`SELECT revision,document,published_at
          FROM ec_schedule_publications WHERE organization_id=$1 AND event_id=$2 ORDER BY revision DESC LIMIT 1`, [current.organizationId, eventId]);
        const latest = await refresh(sql, principal, current);
        if (!publiclyVisible(latest)) missing();
        if (principal) registration = await participation.getRegistration(sql, eventId, principal.actor.userId);
        const eligible = principal && registration?.status === "approved" && registration.eventId === eventId && registration.userId === principal.actor.userId;
        const published = result.rows[0];
        return projection(latest, published?.document ?? null, published?.revision ?? null, published?.published_at ?? null, eligible ? principal.actor.userId : null);
      });
    },
    async publicScheduleNodes(sql, eventId) {
      const current = await event(sql, text(eventId, "赛事", 200));
      if (!publiclyVisible(current) || !current.modules.schedule) return [];
      const result = await sql.query<{ document: ScheduleDocument }>(
        `SELECT document FROM ec_schedule_publications WHERE organization_id=$1 AND event_id=$2 ORDER BY revision DESC LIMIT 1`,
        [current.organizationId, current.eventId]);
      const document = result.rows[0]?.document ?? null;
      if (document === null) return [];
      return document.items
        .filter(item => item.audience === "all")
        .map(item => ({ id: item.id, title: item.title, at: item.startsAt, kind: "session" }));
    },
    getScheduleDraft(principal, eventId) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId);
        await staff(sql, principal, current, "schedule_manage");
        const row = await getState(sql, current);
        await refresh(sql, principal, current, "schedule_manage");
        return draft(current, row);
      });
    },
    saveScheduleDraft(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true);
        await staff(sql, principal, current, "schedule_manage"); assertWrite(current, "schedule");
        return writeDraft(sql, principal, current, input);
      });
    },
    previewScheduleImport(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true);
        await staff(sql, principal, current, "schedule_manage"); assertWrite(current, "schedule");
        assertObject(input);
        const existing = await getState(sql, current, true), expectedRevision = revision(input.expectedRevision);
        if ((existing?.revision ?? 0) !== expectedRevision) conflict(existing?.revision ?? 0);
        const previewId = ids.next(), items: ScheduleItem[] = [], errors: { row: number; message: string }[] = [];
        const zone = timezone(input.timezone ?? existing?.document.timezone ?? current.timezone);
        const impact = text(input.impact ?? "", "更新影响说明", 2000, true);
        try {
          const parsed = parseCsv(input.csv), header = parsed[0]?.map(value => value.trim()) ?? [];
          const columns = ["title", "startsAt", "endsAt", "location", "audience", "userIds"];
          if (header.length !== columns.length || new Set(header).size !== header.length || columns.some(column => !header.includes(column))) invalid("CSV 表头需为 title,startsAt,endsAt,location,audience,userIds。");
          parsed.slice(1).forEach((values, index) => {
            try {
              if (values.length !== columns.length) invalid("列数与表头不一致。");
              const value = (column: string) => values[header.indexOf(column)]!.trim();
              items.push(normalizeItem({ title: value("title"), startsAt: value("startsAt"), endsAt: value("endsAt"), location: value("location"),
                audience: (value("audience") || "all") as ScheduleItem["audience"], userIds: value("userIds") ? value("userIds").split(";").map(id => id.trim()) : [] }));
            } catch (error) { if (!(error instanceof DomainError)) throw error; errors.push({ row: index + 2, message: error.message }); }
          });
          if (items.length === 0 && errors.length === 0) errors.push({ row: 1, message: "CSV 至少包含一条行程；清空行程请在草稿里明确操作。" });
        } catch (error) { if (!(error instanceof DomainError)) throw error; errors.push({ row: 1, message: error.message }); }
        if (existing?.published_revision && !impact) errors.push({ row: 1, message: "已有发布行程，请填写更新对选手的影响。" });
        for (const item of items) for (const userId of item.userIds) {
          try { await approved(sql, current, userId); }
          catch (error) { if (!(error instanceof DomainError)) throw error; errors.push({ row: items.indexOf(item) + 2, message: "指定人员需已通过本场比赛报名审核。" }); }
        }
        const preview: ScheduleImportPreview = { previewId, expectedRevision, timezone: zone, items, impact, errors,
          expiresAt: new Date(clock.now().getTime() + 30 * 60 * 1000).toISOString() };
        await sql.query(`INSERT INTO ec_schedule_import_previews(id,organization_id,event_id,actor_user_id,expected_revision,document,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [previewId, current.organizationId, eventId, principal.actor.userId, expectedRevision, JSON.stringify(preview), now(), preview.expiresAt]);
        await refresh(sql, principal, current, "schedule_manage", "schedule");
        return preview;
      });
    },
    confirmScheduleImport(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true);
        await staff(sql, principal, current, "schedule_manage"); assertWrite(current, "schedule");
        assertObject(input);
        const result = await sql.query<PreviewRow>(`SELECT document,actor_user_id,expires_at,confirmed_revision FROM ec_schedule_import_previews
          WHERE id=$1 AND organization_id=$2 AND event_id=$3 AND actor_user_id=$4 FOR UPDATE`, [text(input.previewId, "预览标识", 128), current.organizationId, eventId, principal.actor.userId]);
        const row = result.rows[0]; if (!row) missing();
        if (row!.confirmed_revision !== null) throw new DomainError("SCHEDULE_PREVIEW_USED", "这份预览已确认，请查看当前草稿。", { status: 409 });
        if (new Date(row!.expires_at).getTime() <= clock.now().getTime()) throw new DomainError("SCHEDULE_PREVIEW_EXPIRED", "预览已过期，请重新预览。", { status: 409 });
        const preview = row!.document;
        if (preview.errors.length) throw new DomainError("SCHEDULE_IMPORT_INVALID", "请先修正预览中的问题，不能确认有错误的 CSV。", { status: 422 });
        const expected = revision(input.expectedRevision);
        if (preview.expectedRevision !== expected) conflict((await getState(sql, current))?.revision ?? 0);
        const saved = await writeDraft(sql, principal, current, { expectedRevision: expected, timezone: preview.timezone, items: preview.items, impact: preview.impact });
        await sql.query(`UPDATE ec_schedule_import_previews SET confirmed_at=$5,confirmed_revision=$6
          WHERE id=$1 AND organization_id=$2 AND event_id=$3 AND actor_user_id=$4 AND confirmed_at IS NULL`, [preview.previewId, current.organizationId, eventId, principal.actor.userId, now(), saved.revision]);
        return saved;
      });
    },
    publishSchedule(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true);
        await staff(sql, principal, current, "schedule_manage"); assertWrite(current, "schedule");
        assertObject(input);
        const row = await getState(sql, current, true), expected = revision(input.expectedRevision);
        if (!row) throw new DomainError("SCHEDULE_DRAFT_REQUIRED", "请先保存行程草稿，再检查发布。", { status: 409 });
        if (row.revision !== expected) conflict(row.revision);
        await ensureRecipients(sql, current, row.document.items);
        if (row.published_revision !== null && row.published_revision !== row.revision && !row.document.impact.trim()) invalid("请说明更新对选手的影响。");
        const at = now();
        await sql.query(`INSERT INTO ec_schedule_publications(organization_id,event_id,revision,document,published_by,published_at)
          VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(organization_id,event_id,revision) DO NOTHING`, [current.organizationId, eventId, expected, JSON.stringify(row.document), principal.actor.userId, at]);
        await sql.query(`UPDATE ec_schedule_state SET published_revision=$3 WHERE organization_id=$1 AND event_id=$2 AND revision=$3`, [current.organizationId, eventId, expected]);
        const published = await sql.query<{ published_at: Date | string }>(`SELECT published_at FROM ec_schedule_publications WHERE organization_id=$1 AND event_id=$2 AND revision=$3`, [current.organizationId, eventId, expected]);
        const latest = await refresh(sql, principal, current, "schedule_manage", "schedule");
        await ensureRecipients(sql, current, row.document.items);
        return projection(latest, row.document, expected, published.rows[0]!.published_at, null, true);
      });
    },
    listIcebreakers(principal, eventId) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId);
        if (!publiclyVisible(current)) missing(); await approved(sql, current, principal.actor.userId);
        const records = await sql.query<ActivityRow>(`SELECT id,revision,document FROM ec_icebreaker_activities WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id`, [current.organizationId, eventId]);
        const activities: IcebreakerActivity[] = [];
        for (const record of records.rows) {
          const responses = await sql.query<ResponseRow>(`SELECT user_id,choice,updated_at FROM ec_icebreaker_responses
            WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND user_id=$4`, [current.organizationId, eventId, record.id, principal.actor.userId]);
          const allGroups = await groups(sql, current, record.id, principal.actor.userId);
          // Never expose another activity group's list to a participant. Within their group,
          // current approval/opt-in is checked so withdrawn participants are not displayed.
          const own = allGroups.find(group => group.memberUserIds.includes(principal.actor.userId));
          const applicableGroup = own ? { ...own, memberUserIds: [] as string[] } : null;
          if (applicableGroup) for (const userId of own!.memberUserIds) {
            const registration = await participation.getRegistration(sql, eventId, userId);
            const optIn = await sql.query<{ choice: IcebreakerChoice }>(`SELECT choice FROM ec_icebreaker_responses WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND user_id=$4`, [current.organizationId, eventId, record.id, userId]);
            if (registration?.status === "approved" && registration.eventId === eventId && registration.userId === userId && optIn.rows[0]?.choice === "join") applicableGroup.memberUserIds.push(userId);
          }
          activities.push({ id: record.id, ...record.document, revision: record.revision,
            ownChoice: responses.rows.find(response => response.user_id === principal.actor.userId)?.choice ?? null, ownGroup: applicableGroup });
        }
        const latest = await refresh(sql, principal, current);
        if (!publiclyVisible(latest)) missing(); await approved(sql, latest, principal.actor.userId);
        return { eventId, enabled: latest.modules.icebreaking, activities };
      });
    },
    listManagedIcebreakers(principal, eventId) {
      // Both role checks surround the complete SQL read, using the same executor.
      // This endpoint deliberately does not fall back to participant permissions.
      return transaction(principal, async sql => {
        const current = await event(sql, eventId);
        await staff(sql, principal, current, "logistics_manage");
        const records = await sql.query<ActivityRow>(`SELECT id,revision,document FROM ec_icebreaker_activities WHERE organization_id=$1 AND event_id=$2 ORDER BY created_at,id`, [current.organizationId, eventId]);
        const activities: IcebreakerActivity[] = [];
        for (const record of records.rows) {
          const responses = await sql.query<ResponseRow>(`SELECT user_id,choice,updated_at FROM ec_icebreaker_responses WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 ORDER BY user_id`, [current.organizationId, eventId, record.id]);
          const allGroups = await groups(sql, current, record.id);
          activities.push({ id: record.id, ...record.document, revision: record.revision,
            ownChoice: responses.rows.find(response => response.user_id === principal.actor.userId)?.choice ?? null,
            ownGroup: allGroups.find(group => group.memberUserIds.includes(principal.actor.userId)) ?? null,
            responses: responses.rows.map(response => ({ userId: response.user_id, choice: response.choice, updatedAt: iso(response.updated_at) })), groups: allGroups });
        }
        const latest = await refresh(sql, principal, current, "logistics_manage");
        return { eventId, enabled: latest.modules.icebreaking, activities };
      });
    },
    createIcebreaker(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true);
        await staff(sql, principal, current, "logistics_manage"); assertWrite(current, "icebreaking");
        assertObject(input);
        const document: ActivityDocument = { title: text(input.title, "活动名称", 200), description: text(input.description ?? "", "活动说明", 2000, true),
          startsAt: instant(input.startsAt, "活动开始时间"), location: text(input.location, "活动地点", 500) };
        const id = ids.next();
        await sql.query(`INSERT INTO ec_icebreaker_activities(id,organization_id,event_id,revision,document,created_by,created_at) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)`, [id, current.organizationId, eventId, JSON.stringify(document), principal.actor.userId, now()]);
        await refresh(sql, principal, current, "logistics_manage", "icebreaking");
        return { id, ...document, revision: 1, ownChoice: null, ownGroup: null, responses: [], groups: [] };
      });
    },
    respondIcebreaker(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true); assertWrite(current, "icebreaking");
        if (!publiclyVisible(current)) missing();
        await approved(sql, current, principal.actor.userId);
        assertObject(input);
        if (input.choice !== "join" && input.choice !== "decline") invalid("请选择自愿参加或暂不参加。");
        const record = await activity(sql, current, input.activityId, true);
        const previous = await sql.query<{ choice: IcebreakerChoice }>(`SELECT choice FROM ec_icebreaker_responses WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND user_id=$4`, [current.organizationId, eventId, record.id, principal.actor.userId]);
        let nextRevision = record.revision;
        if (previous.rows[0]?.choice !== input.choice) {
          await sql.query(`INSERT INTO ec_icebreaker_responses(organization_id,event_id,activity_id,user_id,choice,updated_at) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(organization_id,event_id,activity_id,user_id) DO UPDATE SET choice=EXCLUDED.choice,updated_at=EXCLUDED.updated_at`, [current.organizationId, eventId, record.id, principal.actor.userId, input.choice, now()]);
          if (input.choice === "decline") {
            const previousGroup = (await groups(sql, current, record.id)).find(group => group.memberUserIds.includes(principal.actor.userId));
            if (previousGroup) {
              await sql.query(`DELETE FROM ec_icebreaker_group_members WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND user_id=$4`, [current.organizationId, eventId, record.id, principal.actor.userId]);
              const updatedGroup = { ...previousGroup, revision: previousGroup.revision + 1, memberUserIds: previousGroup.memberUserIds.filter(userId => userId !== principal.actor.userId) };
              await sql.query(`UPDATE ec_icebreaker_groups SET revision=$5,updated_by=$6,updated_at=$7 WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND id=$4`, [current.organizationId, eventId, record.id, previousGroup.id, updatedGroup.revision, principal.actor.userId, now()]);
              await recordGroup(sql, principal, current, record.id, updatedGroup);
            }
          }
          nextRevision++;
          await sql.query(`UPDATE ec_icebreaker_activities SET revision=$4 WHERE organization_id=$1 AND event_id=$2 AND id=$3`, [current.organizationId, eventId, record.id, nextRevision]);
        }
        const latest = await refresh(sql, principal, current, undefined, "icebreaking");
        if (!publiclyVisible(latest)) missing(); await approved(sql, latest, principal.actor.userId);
        return { activityId: record.id, choice: input.choice, revision: nextRevision };
      });
    },
    assignIcebreakerGroup(principal, eventId, input) {
      return transaction(principal, async sql => {
        const current = await event(sql, eventId, true);
        await staff(sql, principal, current, "logistics_manage"); assertWrite(current, "icebreaking");
        assertObject(input);
        const record = await activity(sql, current, input.activityId, true);
        const expected = revision(input.expectedRevision); if (record.revision !== expected) conflict(record.revision);
        const title = text(input.title, "小组名称", 200), memberUserIds = users(input.userIds);
        await requireJoined(sql, current, record.id, memberUserIds);
        const existingGroups = await groups(sql, current, record.id), existing = existingGroups.find(group => group.title === title);
        if (existingGroups.some(group => group.id !== existing?.id && group.memberUserIds.some(userId => memberUserIds.includes(userId)))) {
          throw new DomainError("ICEBREAKER_GROUP_CONFLICT", "有人已在另一小组，请先明确调整原小组成员。", { status: 409 });
        }
        const group: IcebreakerGroup = { id: existing?.id ?? ids.next(), title, revision: (existing?.revision ?? 0) + 1, memberUserIds: [...memberUserIds].sort() };
        if (existing) {
          await sql.query(`UPDATE ec_icebreaker_groups SET revision=$5,updated_by=$6,updated_at=$7 WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND id=$4`, [current.organizationId, eventId, record.id, group.id, group.revision, principal.actor.userId, now()]);
          await sql.query(`DELETE FROM ec_icebreaker_group_members WHERE organization_id=$1 AND event_id=$2 AND activity_id=$3 AND group_id=$4`, [current.organizationId, eventId, record.id, group.id]);
        } else await sql.query(`INSERT INTO ec_icebreaker_groups(id,organization_id,event_id,activity_id,title,revision,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [group.id, current.organizationId, eventId, record.id, title, group.revision, principal.actor.userId, now()]);
        for (const userId of group.memberUserIds) await sql.query(`INSERT INTO ec_icebreaker_group_members(organization_id,event_id,activity_id,group_id,user_id) VALUES($1,$2,$3,$4,$5)`, [current.organizationId, eventId, record.id, group.id, userId]);
        await recordGroup(sql, principal, current, record.id, group);
        await sql.query(`UPDATE ec_icebreaker_activities SET revision=$4 WHERE organization_id=$1 AND event_id=$2 AND id=$3`, [current.organizationId, eventId, record.id, expected + 1]);
        await refresh(sql, principal, current, "logistics_manage", "icebreaking");
        await requireJoined(sql, current, record.id, memberUserIds);
        return { activityId: record.id, revision: expected + 1, group };
      });
    },
  };
  return service;
}
