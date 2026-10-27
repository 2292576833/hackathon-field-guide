import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { EventNotificationPort, EventRegistrationSnapshot, HostedEventAccessPort, HostedEventScope, OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";

export type NoticeAccent = "orange" | "blue" | "green" | "slate";
export type NoticeTheme = "simple" | "letter";
export type OrganizerMailState = "unconfigured" | "queued" | "leased" | "sending" | "accepted" | "unknown_hold" | "failed" | "cancelled";
export interface SelectionNoticeTemplate { eventId: string; revision: number; subject: string; body: string; accent: NoticeAccent; theme: NoticeTheme; }
export interface SelectionNotice {
 id: string; eventId: string; registrationId: string; registrationRevision: number; version: number;
 templateRevision: number; subject: string; body: string; accent: NoticeAccent; theme: NoticeTheme; publishedAt: string;
 mailState: OrganizerMailState;
}
export interface NotificationAnnouncement {
 id: string; eventId: string; organizationId: string; revision: number; title: string; body: string;
 important: boolean; publishedAt: string | null; updatedBy: string;
 publisherCapability?: "event_manage" | "communication_manage";
}
export interface OrganizerNotificationDependencies {
 database: DatabasePort; clock: Clock; ids: IdGenerator;
 getEvents(): HostedEventAccessPort;
 getRegistration(): {
  getRegistration(sql: SqlExecutor, eventId: string, userId: string): Promise<EventRegistrationSnapshot | null>;
  listApprovedUserIds(sql: SqlExecutor, eventId: string): Promise<readonly string[]>;
 };
 /** O03 owns the announcement lookup, including exact current published_revision. */
 getCommunication(): { getNotificationAnnouncement(sql: SqlExecutor, input: { eventId: string; announcementId: string; revision: number }): Promise<NotificationAnnouncement | null> };
 resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
 assertMutationAllowed(request: Request): Promise<void>;
 /** Inject only a real SMTP/provider transport, never a development mailbox. */
 transport?: { send(message: { from: string; to: string; subject: string; text: string; html?: string }, options: { signal: AbortSignal }): Promise<void> };
 /** Current organization configuration; null means explicit website fallback, errors must not fallback. */
 getOrganizationSender?: (sql: SqlExecutor, organizationId: string) => Promise<{from:string;transport:NonNullable<OrganizerNotificationDependencies["transport"]>}|null>;
 countOrganizationSenders?: () => Promise<number>;
 from?: string; origin?: string; timeoutMs?: number; leaseMs?: number;
}
interface Account { id: string; email: string; display_name: string; platform_roles: ("user" | "reviewer" | "admin")[]; }
interface QueueRow {
 id: string; organization_id: string; event_id: string; kind: "announcement" | "selection";
 source_id: string; source_revision: number; recipient_user_id: string; published_by: string;
 registration_id: string | null; registration_revision: number | null; state: Exclude<OrganizerMailState, "unconfigured">;
 lease_token: string | null; lease_until: Date | string | null;
}
const COLORS: Record<NoticeAccent, string> = { orange: "#bd3924", blue: "#2563a5", green: "#237454", slate: "#394451" };
function invalid(message = "请检查通知填写内容。"): never { throw new DomainError("NOTICE_INVALID_INPUT", message); }
function denied(): never { throw new DomainError("FORBIDDEN", "当前账号不能操作这场比赛的通知。", { status: 403 }); }
function missing(): never { throw new DomainError("NOTICE_NOT_FOUND", "当前比赛或通知无法查看。", { status: 404 }); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid("包含不支持的字段，请通过通知表单操作。");
 return value as Record<string, unknown>;
}
function text(value: unknown, max: number, singleLine = false): string {
 if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (singleLine && /[\r\n]/.test(value))) return invalid();
 return value.trim();
}
function revision(value: unknown, zero = true): number {
 if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) return invalid("版本无效，请重新读取当前通知。");
 return Number(value);
}
function matchRevision(expected: number, actual: number) {
 if (expected !== actual) throw new DomainError("NOTICE_REVISION_CONFLICT", "通知或报名已更新，请核对当前版本后重试。", { status: 409, latestRevision: actual });
}
function escape(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }
function render(template: Pick<SelectionNoticeTemplate, "subject" | "body">, values: { name: string; event: string; organizer: string }) {
 const replace = (source: string) => source.replace(/\{(name|event|organizer)\}/g, (_, key: keyof typeof values) => values[key]);
 return { subject: replace(template.subject), body: replace(template.body) };
}
function validatePlaceholders(value: string) {
 if (/\{[^{}]*\}/g.test(value.replace(/\{(name|event|organizer)\}/g, "")) || /[{}]/.test(value.replace(/\{(name|event|organizer)\}/g, ""))) return invalid("仅支持 {name}、{event}、{organizer} 三种占位词。");
}
function htmlMessage(subject: string, body: string, accent: NoticeAccent, theme: NoticeTheme, link: string | null): string {
 const color = COLORS[accent], padding = theme === "letter" ? "28px" : "18px";
 return `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f8f6f0;color:#242424;font-family:Arial,sans-serif"><main style="max-width:640px;margin:24px auto;padding:${padding};background:#fff;border-top:4px solid ${color}"><h1 style="font-size:22px;color:${color}">${escape(subject)}</h1><div style="white-space:pre-wrap;line-height:1.8">${escape(body)}</div>${link ? `<p><a style="color:${color}" href="${escape(link)}">查看这场比赛</a></p>` : ""}<p style="color:#666;font-size:12px">此为主办方发布的通知。邮件服务接受发送请求不代表收件人已收到或已读。</p></main></body></html>`;
}

/** Durable refs-only mail outbox plus immutable, event-scoped selection notices. No model calls or GET side effects. */
export function createOrganizerNotifications(deps: OrganizerNotificationDependencies) {
 const configured = Boolean(deps.transport && deps.from);
 if (deps.from && (!deps.from.trim() || /[\r\n\u0000]/.test(deps.from))) throw new Error("Invalid organizer mail sender.");
 const timeoutMs = deps.timeoutMs ?? 10_000, leaseMs = deps.leaseMs ?? Math.max(60_000, timeoutMs + 30_000);
 if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 || !Number.isSafeInteger(leaseMs) || leaseMs <= timeoutMs || leaseMs > 600_000) throw new Error("Invalid organizer mail timeout or lease.");
 let origin: string | null = null;
 if (deps.origin) { const url = new URL(deps.origin); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid organizer site origin."); origin = url.origin; }
 const now = () => deps.clock.now().toISOString();
 async function sender(sql:SqlExecutor,organizationId:string) {const own=await deps.getOrganizationSender?.(sql,organizationId);return own??(configured?{from:deps.from!,transport:deps.transport!}:null);}
 async function account(sql: SqlExecutor, userId: string): Promise<Account | null> {
  const row = (await sql.query<Account>("SELECT id,email,display_name,platform_roles FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [userId])).rows[0];
  return row && typeof row.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) && !/[\r\n\u0000]/.test(row.email) ? row : null;
 }
 async function scope(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: string, write: boolean) {
  await principal.guard(sql);
  const event = await deps.getEvents().requireStaff(sql, principal.actor, eventId, "registration_manage");
  if (event.eventId !== eventId) return denied();
  if (write && ["ended", "archived"].includes(event.status)) throw new DomainError("NOTICE_READ_ONLY", "比赛已结束或归档，不能发布新的入选通知。", { status: 409 });
  return event;
 }
 async function template(sql: SqlExecutor, event: HostedEventScope): Promise<SelectionNoticeTemplate> {
  return (await sql.query<{ document: SelectionNoticeTemplate }>("SELECT document FROM organizer_selection_templates WHERE event_id=$1 AND organization_id=$2", [event.eventId, event.organizationId])).rows[0]?.document ?? { eventId: event.eventId, revision: 0, subject: "你已入选 {event}", body: "{name}，你好！\n\n恭喜你通过 {event} 的报名审核。请进入比赛查看本场官方通知与后续安排。\n\n{organizer}", accent: "orange", theme: "letter" };
 }
 async function getTemplate(principal: OrganizerPrincipal, eventId: string) {
  return deps.database.transaction(async sql => { const event = await scope(sql, principal, eventId, false), value = await template(sql, event); await principal.guard(sql); return { ...value, preview: render(value, { name: "参赛者", event: event.title, organizer: event.organizationName }) }; });
 }
 async function saveTemplate(principal: OrganizerPrincipal, eventId: string, input: unknown) {
  const value = object(input, ["expectedRevision", "subject", "body", "accent", "theme"]), expected = revision(value.expectedRevision), subject = text(value.subject, 200, true), body = text(value.body, 12000);
  validatePlaceholders(subject); validatePlaceholders(body);
  if (!Object.hasOwn(COLORS, String(value.accent)) || !["simple", "letter"].includes(String(value.theme))) return invalid("请选择页面提供的配色和通知样式。");
  return deps.database.transaction(async sql => {
   const event = await scope(sql, principal, eventId, true), old = await template(sql, event); matchRevision(expected, old.revision);
   const next: SelectionNoticeTemplate = { eventId, revision: expected + 1, subject, body, accent: value.accent as NoticeAccent, theme: value.theme as NoticeTheme };
   await sql.query("INSERT INTO organizer_selection_templates(event_id,organization_id,revision,document) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO UPDATE SET revision=excluded.revision,document=excluded.document", [eventId, event.organizationId, next.revision, JSON.stringify(next)]);
   await sql.query("INSERT INTO organizer_selection_template_versions(event_id,organization_id,revision,document,changed_by,changed_at) VALUES($1,$2,$3,$4,$5,$6)", [eventId, event.organizationId, next.revision, JSON.stringify(next), principal.actor.userId, now()]);
   await scope(sql, principal, eventId, true); return { ...next, preview: render(next, { name: "参赛者", event: event.title, organizer: event.organizationName }) };
  });
 }
 async function transition(sql: SqlExecutor, row: QueueRow, state: QueueRow["state"], reason: string | null, token: string | null = null) {
  const leaseUntil = token ? new Date(deps.clock.now().getTime() + leaseMs).toISOString() : null;
  await sql.query("UPDATE organizer_notification_outbox SET state=$1,reason=$2,lease_token=$3,lease_until=$4,next_attempt_at=NULL,updated_at=$5,sending_at=CASE WHEN $1='sending' THEN $5::timestamptz ELSE sending_at END,accepted_at=CASE WHEN $1='accepted' THEN $5::timestamptz ELSE accepted_at END WHERE id=$6", [state, reason, token, leaseUntil, now(), row.id]);
  await sql.query("INSERT INTO organizer_notification_transitions(outbox_id,state,reason,recorded_at) VALUES($1,$2,$3,$4)", [row.id, state, reason, now()]);
 }
 async function enqueueRows(sql: SqlExecutor, event: HostedEventScope, kind: "announcement" | "selection" | "community", sourceId: string, sourceRevision: number, publisher: string, recipients: readonly string[], registration?: EventRegistrationSnapshot) {
  const prior = (await sql.query<{ id: string }>("SELECT id FROM organizer_notification_batches WHERE event_id=$1 AND organization_id=$2 AND kind=$3 AND source_id=$4 AND source_revision=$5", [event.eventId, event.organizationId, kind, sourceId, sourceRevision])).rows[0];
  if (prior) return prior.id;
  const batchId = deps.ids.next();
  await sql.query("INSERT INTO organizer_notification_batches(id,organization_id,event_id,kind,source_id,source_revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [batchId, event.organizationId, event.eventId, kind, sourceId, sourceRevision, now()]);
  for (const recipient of recipients) {
   const id = deps.ids.next();
   await sql.query("INSERT INTO organizer_notification_outbox(id,batch_id,organization_id,event_id,kind,source_id,source_revision,recipient_user_id,published_by,registration_id,registration_revision,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$12)", [id, batchId, event.organizationId, event.eventId, kind, sourceId, sourceRevision, recipient, publisher, registration?.id ?? null, registration?.revision ?? null, now()]);
   await sql.query("INSERT INTO organizer_notification_transitions(outbox_id,state,recorded_at) VALUES($1,'queued',$2)", [id, now()]);
  }
  return batchId;
 }
 const announcementAudience = { async listRecipientUserIds(sql: SqlExecutor, eventId: string) {
  const ids = await deps.getRegistration().listApprovedUserIds(sql, eventId), result: string[] = [];
  for (const id of new Set(ids)) if (await account(sql, id)) result.push(id);
  return result;
 } };
 const notification: EventNotificationPort = { async enqueue(sql, input) {
  const event = await deps.getEvents().getEvent(sql, text(input.eventId, 200, true), { forUpdate: true }); if (!event || ["draft", "archived"].includes(event.status)) return missing();
  const sourceId = text(input.announcementId, 200, true), sourceRevision = revision(input.revision, false);
  let publisher: string;
  if ((input.kind ?? "announcement") === "community") {
    // 社区（连接/私信）复用同一 outbox：来源就是社区自己的记录 id，不查公告、不新增第二套通知。
    publisher = text(input.actorUserId, 200, true);
  } else {
    const source = await deps.getCommunication().getNotificationAnnouncement(sql, { eventId: input.eventId, announcementId: sourceId, revision: sourceRevision });
    if (!source || source.eventId !== event.eventId || source.organizationId !== event.organizationId || source.revision !== input.revision || source.id !== input.announcementId) return missing();
    publisher = source.updatedBy;
  }
  const approved = new Set(await deps.getRegistration().listApprovedUserIds(sql, event.eventId)), recipients = [...new Set(input.recipientUserIds)];
  if (recipients.length > 5000 || recipients.some(id => !approved.has(id))) return denied();
  for (const id of recipients) if (!await account(sql, id)) return denied();
  if (!await sender(sql,event.organizationId)) return { state: "unconfigured", referenceId: null };
  return { state: "queued", referenceId: await enqueueRows(sql, event, (input.kind ?? "announcement") === "community" ? "community" : "announcement", sourceId, sourceRevision, publisher, recipients) };
 } };
 async function noticeView(sql: SqlExecutor, row: Record<string, unknown>): Promise<SelectionNotice> {
  const mail = (await sql.query<{ state: QueueRow["state"] }>("SELECT state FROM organizer_notification_outbox WHERE kind='selection' AND event_id=$1 AND source_id=$2 AND source_revision=$3 AND recipient_user_id=$4", [row.event_id, row.id, row.version, row.recipient_user_id])).rows[0];
  return { id: String(row.id), eventId: String(row.event_id), registrationId: String(row.registration_id), registrationRevision: Number(row.registration_revision), version: Number(row.version), templateRevision: Number(row.template_revision), subject: String(row.subject), body: String(row.body), accent: row.accent as NoticeAccent, theme: row.theme as NoticeTheme, publishedAt: new Date(row.published_at as Date | string).toISOString(), mailState: mail?.state ?? "unconfigured" };
 }
 async function publishSelection(principal: OrganizerPrincipal, eventId: string, input: unknown) {
  const body = object(input, ["recipientUserId", "expectedRegistrationRevision", "templateRevision", "expectedNoticeVersion", "confirmNewVersion", "newOperationKey"]), userId = text(body.recipientUserId, 200, true), expectedRegistrationRevision = revision(body.expectedRegistrationRevision, false), templateRevision = revision(body.templateRevision, false), expectedNoticeVersion = revision(body.expectedNoticeVersion);
  const newVersion = body.confirmNewVersion === true;
  if (body.confirmNewVersion !== undefined && !newVersion) return invalid("发布新版通知需要明确确认。");
  if ((!newVersion && (body.newOperationKey !== undefined || expectedNoticeVersion !== 0)) || (newVersion && expectedNoticeVersion < 1)) return invalid("先核对已发布通知，再明确确认发布新版。");
  const operationKey = newVersion ? text(body.newOperationKey, 100, true) : "initial";
  if (newVersion && operationKey === "initial") return invalid("新版操作标识无效。");
  return deps.database.transaction(async sql => {
   const event = await scope(sql, principal, eventId, true), registration = await deps.getRegistration().getRegistration(sql, eventId, userId);
   if (!registration || registration.eventId !== eventId || registration.userId !== userId || registration.status !== "approved") throw new DomainError("NOTICE_APPROVAL_REQUIRED", "只能向本场当前已通过审核的选手发布入选通知。", { status: 409 });
   matchRevision(expectedRegistrationRevision, registration.revision);
   const recipient = await account(sql, userId); if (!recipient) throw new DomainError("NOTICE_RECIPIENT_UNAVAILABLE", "该账号当前不可用或邮箱未验证，请先核对报名者账号。", { status: 409 });
   const replay = (await sql.query<Record<string, unknown>>("SELECT * FROM organizer_selection_notices WHERE event_id=$1 AND organization_id=$2 AND registration_id=$3 AND registration_revision=$4 AND operation_key=$5", [eventId, event.organizationId, registration.id, registration.revision, operationKey])).rows[0];
   if (replay) { matchRevision(templateRevision, Number(replay.template_revision)); if (newVersion) matchRevision(expectedNoticeVersion, Number(replay.version) - 1); await scope(sql, principal, eventId, true); return noticeView(sql, replay); }
   const current = (await sql.query<{ version: number }>("SELECT version FROM organizer_selection_notices WHERE event_id=$1 AND organization_id=$2 AND registration_id=$3 AND registration_revision=$4 ORDER BY version DESC LIMIT 1", [eventId, event.organizationId, registration.id, registration.revision])).rows[0]?.version ?? 0;
   matchRevision(expectedNoticeVersion, current);
   if (current > 0 && !newVersion) return invalid("已发布过入选通知，请明确确认后再发布新版。");
   const saved = await template(sql, event); matchRevision(templateRevision, saved.revision);
   if (!saved.revision) return invalid("请先保存本场的入选通知模板。");
   const rendered = render(saved, { name: recipient.display_name || "参赛者", event: event.title, organizer: event.organizationName });
   // Display names and event titles are literal values, not mail-header instructions.
   if (/[\r\n\u0000]/.test(rendered.subject) || rendered.subject.length > 998 || rendered.body.length > 32000) return invalid("通知替换后过长或标题无效，请缩短模板并核对参赛者称呼。");
   const id = deps.ids.next(), version = current + 1,mailConfigured=Boolean(await sender(sql,event.organizationId));
   const row = (await sql.query<Record<string, unknown>>("INSERT INTO organizer_selection_notices(id,organization_id,event_id,registration_id,registration_revision,recipient_user_id,version,operation_key,template_revision,subject,body,accent,theme,published_by,published_at,mail_configured) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *", [id, event.organizationId, eventId, registration.id, registration.revision, userId, version, operationKey, saved.revision, rendered.subject, rendered.body, saved.accent, saved.theme, principal.actor.userId, now(), mailConfigured])).rows[0];
   if (mailConfigured) await enqueueRows(sql, event, "selection", id, version, principal.actor.userId, [userId], registration);
   const after = await deps.getRegistration().getRegistration(sql, eventId, userId); if (!after || after.id !== registration.id || after.status !== "approved" || after.revision !== registration.revision || !await account(sql, userId)) return denied();
   await scope(sql, principal, eventId, true); return noticeView(sql, row);
  });
 }
 async function listSelection(principal: OrganizerPrincipal, eventId: string) {
  return deps.database.transaction(async sql => {
   await principal.guard(sql); const event = await deps.getEvents().getEvent(sql, eventId); if (!event || event.status === "draft") return missing();
   const registration = await deps.getRegistration().getRegistration(sql, eventId, principal.actor.userId); if (!registration || registration.userId !== principal.actor.userId || registration.eventId !== eventId) return missing();
   const rows = (await sql.query<Record<string, unknown>>("SELECT * FROM organizer_selection_notices WHERE organization_id=$1 AND event_id=$2 AND recipient_user_id=$3 ORDER BY sequence DESC LIMIT 100", [event.organizationId, eventId, principal.actor.userId])).rows;
   const items = await Promise.all(rows.map(row => noticeView(sql, row))); await principal.guard(sql);
   const after = await deps.getEvents().getEvent(sql, eventId); if (!after || after.organizationId !== event.organizationId || after.status === "draft") return missing();
   return { items, registrationStatus: registration.status, registrationRevision: registration.revision };
  });
 }
 async function listManagedSelection(principal: OrganizerPrincipal, eventId: string, userId: string) {
  text(userId, 200, true);
  return deps.database.transaction(async sql => {
   const event = await scope(sql, principal, eventId, false), registration = await deps.getRegistration().getRegistration(sql, eventId, userId), recipient = await account(sql, userId);
   if (!registration || registration.eventId !== eventId || registration.userId !== userId || registration.status !== "approved" || !recipient) return missing();
   const rows = (await sql.query<Record<string, unknown>>("SELECT * FROM organizer_selection_notices WHERE organization_id=$1 AND event_id=$2 AND registration_id=$3 AND registration_revision=$4 AND recipient_user_id=$5 ORDER BY version DESC LIMIT 5", [event.organizationId, eventId, registration.id, registration.revision, userId])).rows;
   const items = await Promise.all(rows.map(row => noticeView(sql, row)));
   const saved=await template(sql,event),preview={...render(saved,{name:recipient.display_name||"参赛者",event:event.title,organizer:event.organizationName}),templateRevision:saved.revision,accent:saved.accent,theme:saved.theme};
   await scope(sql, principal, eventId, false);
   const after=await deps.getRegistration().getRegistration(sql,eventId,userId);
   if(!after||after.id!==registration.id||after.revision!==registration.revision||after.status!=="approved"||!await account(sql,userId))return missing();
   return { items, recipient: { userId, label: recipient.display_name || "参赛者" }, registrationId:registration.id,registrationRevision: registration.revision,preview,event:{title:event.title,organizationName:event.organizationName} };
  });
 }
 async function prepared(sql: SqlExecutor, event: HostedEventScope | null, row: QueueRow) {
  if (!event || event.eventId !== row.event_id || event.organizationId !== row.organization_id || ["draft", "archived"].includes(event.status)) return null;
  const publisher = await account(sql, row.published_by); if (!publisher) return null;
  const registration = await deps.getRegistration().getRegistration(sql, row.event_id, row.recipient_user_id), recipient = await account(sql, row.recipient_user_id);
  if (!registration || registration.eventId !== row.event_id || registration.userId !== row.recipient_user_id || registration.status !== "approved" || !recipient) return null;
  let subject: string, body: string, accent: NoticeAccent = "orange", theme: NoticeTheme = "simple", capability: "registration_manage" | "communication_manage" | "event_manage" = row.kind === "selection" ? "registration_manage" : "communication_manage";
  if (row.kind === "announcement") {
   const source = await deps.getCommunication().getNotificationAnnouncement(sql, { eventId: row.event_id, announcementId: row.source_id, revision: row.source_revision });
   if (!source || source.organizationId !== row.organization_id || source.eventId !== row.event_id || source.id !== row.source_id || source.revision !== row.source_revision || source.updatedBy !== row.published_by) return null;
   subject = source.title; body = source.body; capability = source.publisherCapability ?? "communication_manage";
  } else {
   if (registration.id !== row.registration_id || registration.revision !== row.registration_revision) return null;
   const source = (await sql.query<{ subject: string; body: string; accent: NoticeAccent; theme: NoticeTheme; published_by: string }>("SELECT subject,body,accent,theme,published_by FROM organizer_selection_notices WHERE id=$1 AND event_id=$2 AND organization_id=$3 AND version=$4 AND recipient_user_id=$5 AND registration_id=$6 AND registration_revision=$7", [row.source_id, row.event_id, row.organization_id, row.source_revision, row.recipient_user_id, registration.id, registration.revision])).rows[0];
   if (!source || source.published_by !== row.published_by) return null;
   ({ subject, body, accent, theme } = source);
  }
  try { await deps.getEvents().requireStaff(sql, { userId: publisher.id, platformRoles: publisher.platform_roles }, row.event_id, capability); }
  catch (error) { if (isDomainError(error) && [401, 403, 404, 409].includes(error.status)) return null; throw error; }
  if (!subject || /[\r\n\u0000]/.test(subject) || subject.length > 998 || typeof body !== "string" || body.length > 32000) return { invalid: true as const };
  const link = origin ? `${origin}/competitions/${encodeURIComponent(row.event_id)}` : null;
  const selected=await sender(sql,event.organizationId);if(!selected)return {unconfigured:true as const};
  return { invalid: false as const, transport:selected.transport,message: { from: selected.from, to: recipient.email, subject, text: body + (link ? `\n\n查看这场比赛：${link}` : ""), html: htmlMessage(subject, body, accent, theme, link) } };
 }
 async function deferUnconfigured(sql:SqlExecutor,row:QueueRow) {
  const next=new Date(deps.clock.now().getTime()+60_000).toISOString();
  await sql.query("UPDATE organizer_notification_outbox SET state='queued',reason='sender_unconfigured',lease_token=NULL,lease_until=NULL,next_attempt_at=$1,updated_at=$2 WHERE id=$3",[next,now(),row.id]);
  await sql.query("INSERT INTO organizer_notification_transitions(outbox_id,state,reason,recorded_at) VALUES($1,'queued','sender_unconfigured',$2)",[row.id,now()]);
 }
 async function drain(options: { batchSize?: number } = {}) {
  const batchSize = options.batchSize ?? 10; if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10) return invalid("通知批次必须为1至10条。");
  // Discover candidates without locking an outbox row before the organization/event locks.
  const candidates = (await deps.database.query<{ id: string; event_id: string }>(`SELECT id,event_id FROM organizer_notification_outbox WHERE ${configured || deps.getOrganizationSender ? "(state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=$1)) OR (state IN ('leased','sending') AND lease_until<=$1)" : "state='sending' AND lease_until<=$1"} ORDER BY next_attempt_at NULLS FIRST,sequence LIMIT $2`, [now(), batchSize])).rows;
  const result = { configured, claimed: 0, accepted: 0, held: 0, cancelled: 0, failed: 0 };
  for (const candidate of candidates) {
   const claimed = await deps.database.transaction(async sql => {
    const event = await deps.getEvents().getEvent(sql, candidate.event_id, { forUpdate: true });
    const row = (await sql.query<QueueRow>("SELECT * FROM organizer_notification_outbox WHERE id=$1 FOR UPDATE SKIP LOCKED", [candidate.id])).rows[0];
    if (!row || row.state !== "queued" && !(row.lease_until && new Date(row.lease_until).getTime() <= deps.clock.now().getTime() && ["leased", "sending"].includes(row.state))) return null;
    if (row.state === "sending") { await transition(sql, row, "unknown_hold", "sending_lease_expired"); result.held++; return null; }
    const message = await prepared(sql, event, row);
    if (!message) { await transition(sql, row, "cancelled", "current_eligibility_revoked"); result.cancelled++; return null; }
    if("unconfigured" in message){await deferUnconfigured(sql,row);return null;}
    if (message.invalid) { await transition(sql, row, "failed", "invalid_mail_content"); result.failed++; return null; }
    const token = deps.ids.next(); await transition(sql, row, "leased", null, token); return { ...row, lease_token: token };
   });
   if (!claimed) continue; result.claimed++;
   // Recheck eligibility in a separate transaction and commit 'sending' before any network call.
   const mail = await deps.database.transaction(async sql => {
    const event = await deps.getEvents().getEvent(sql, claimed.event_id, { forUpdate: true });
    const row = (await sql.query<QueueRow>("SELECT * FROM organizer_notification_outbox WHERE id=$1 FOR UPDATE", [claimed.id])).rows[0];
    if (!row || row.state !== "leased" || row.lease_token !== claimed.lease_token || !row.lease_until || new Date(row.lease_until).getTime() <= deps.clock.now().getTime()) return null;
    const message = await prepared(sql, event, row);
    if (!message) { await transition(sql, row, "cancelled", "current_eligibility_revoked"); result.cancelled++; return null; }
    if("unconfigured" in message){await deferUnconfigured(sql,row);return null;}
    if (message.invalid) { await transition(sql, row, "failed", "invalid_mail_content"); result.failed++; return null; }
    await transition(sql, row, "sending", null, claimed.lease_token); return message;
   });
   if (!mail) continue; result.configured = true;
   const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, accepted = false;
   try {
    await Promise.race([mail.transport.send(mail.message, { signal: controller.signal }), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Organizer mail request timed out.")); }, timeoutMs); })]); accepted = true;
   } catch { /* Every ambiguous provider failure is held; no automatic retry or provider detail is persisted. */ }
   finally { if (timer !== undefined) clearTimeout(timer); }
   await deps.database.transaction(async sql => {
    const row = (await sql.query<QueueRow>("SELECT * FROM organizer_notification_outbox WHERE id=$1 FOR UPDATE", [claimed.id])).rows[0];
    if (!row || row.state !== "sending" || row.lease_token !== claimed.lease_token) return;
    await transition(sql, row, accepted ? "accepted" : "unknown_hold", accepted ? null : "transport_result_unknown"); if (accepted) result.accepted++; else result.held++;
   });
  }
  return result;
 }
 async function counts() {
  const rows = (await deps.database.query<{ state: QueueRow["state"]; n: number }>("SELECT state,count(*)::int AS n FROM organizer_notification_outbox GROUP BY state")).rows;
  const organizationSenders=await deps.countOrganizationSenders?.()??0;
  const value = { configured:configured||organizationSenders>0,websiteConfigured:configured,organizationSenders, queued: 0, accepted: 0, held: 0, failed: 0, cancelled: 0, sending: 0 };
  for (const row of rows) { if (row.state === "unknown_hold") value.held += row.n; else if (row.state === "leased") value.queued += row.n; else value[row.state] += row.n; } return value;
 }
 async function principal(request: Request) { const value = await deps.resolvePrincipal(request); if (!value) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 }); return value; }
 async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DomainError("INVALID_CONTENT_TYPE", "请通过本站表单提交。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) return invalid(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 65536) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "通知内容过长，请缩短后重试。", { status: 413 }); } chunks.push(next.value); } } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { return invalid("提交格式无效，请重试。"); }
 }
 return { notification, announcementAudience, getTemplate, saveTemplate, publishSelection, listSelection, listManagedSelection, drain, counts, configured,
  async handle(request: Request, segments: readonly string[]): Promise<Response | null> {
   const route = segments.join("/").match(/^(organizer\/events|competitions)\/([^/]+)\/(selection-notice-template|selection-notices)$/);
   if (!route || route[1] === "competitions" && route[3] !== "selection-notices") return null;
   const methods = route[1] === "competitions" ? ["GET"] : route[3] === "selection-notice-template" ? ["GET", "PUT"] : ["GET", "POST"], requestId = deps.ids.next();
   const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
   try {
    if (!methods.includes(request.method)) throw new DomainError("METHOD_NOT_ALLOWED", "请通过通知页面操作。", { status: 405 });
    if (request.method !== "GET") await deps.assertMutationAllowed(request);
    const person = await principal(request), eventId = text(route[2], 200, true);
    const query = new URL(request.url).searchParams;
    if (request.method === "GET" && route[1] !== "competitions" && route[3] === "selection-notices" && (query.getAll("recipientUserId").length !== 1 || [...query.keys()].some(key => key !== "recipientUserId"))) return invalid("请先在本场已通过报名列表中选择选手。");
    const data = route[1] === "competitions" ? await listSelection(person, eventId) : request.method === "GET" ? route[3] === "selection-notices" ? await listManagedSelection(person, eventId, text(query.get("recipientUserId"), 200, true)) : await getTemplate(person, eventId) : request.method === "PUT" ? await saveTemplate(person, eventId, await body(request)) : await publishSelection(person, eventId, await body(request));
    return Response.json({ data, requestId }, { headers });
   } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { ...headers, ...(isDomainError(error) && error.status === 405 ? { Allow: methods.join(", ") } : {}) } }); }
  },
 };
}
export type OrganizerNotifications = ReturnType<typeof createOrganizerNotifications>;
