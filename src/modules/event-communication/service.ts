import type { SqlExecutor } from "../../shared/persistence.ts";
import { eventCommunity } from "../../shared/organizer-contracts.ts";
import type { OrganizerPrincipal, HostedEventScope } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Announcement, AnnouncementView, CommunicationDependencies, EventDirectory, HelpTicket, PublicFaq, TicketStatus, TicketView } from "./model.ts";
import type { SummaryEventContext } from "./participant-summary.ts";
import { parseEventInstant } from "./validation.ts";

function invalid(message = "请检查填写内容。"): never { throw new DomainError("COMMUNICATION_INVALID_INPUT", message); }
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid("包含不支持的字段，请刷新页面后重试。");
  return value;
}
function text(value: unknown, max: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (optional && typeof value === "string" && !value.trim()) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) return invalid();
  return value.trim();
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid("版本无效，请重新读取。"); return value as number; }
function sameRevision(expected: number, current: number) { if (expected !== current) throw new DomainError("VERSION_CONFLICT", "内容已更新，请重新读取；本页输入已保留。", { status: 409, latestRevision: current }); }
function missing(): never { throw new DomainError("COMMUNICATION_NOT_FOUND", "此赛事中没有这条记录。", { status: 404 }); }
function denied(): never { throw new DomainError("FORBIDDEN", "当前身份不能操作这条记录。", { status: 403 }); }
function writable(scope: HostedEventScope) { if (scope.status === "archived") throw new DomainError("EVENT_READ_ONLY", "赛事已归档，只能查看历史。", { status: 409 }); }
function isRuleChange(id: string, eventId: string) { return id.startsWith(`rule-change:${eventId}:`); }
function editableAnnouncement(id: string, eventId: string) { if (isRuleChange(id, eventId)) throw new DomainError("OFFICIAL_RULE_NOTICE_READ_ONLY", "正式规则通知保留发布记录；请回到比赛设置发布新规则版本。", { status: 409 }); }
type Mode = "public" | "member" | "staff";

/** Persistent service: no in-memory fallback, no AI or email transport side effects. */
export function createEventCommunicationService(deps: CommunicationDependencies) {
  const now = () => deps.clock.now().toISOString();
  async function scope(sql: SqlExecutor, principal: OrganizerPrincipal | null, eventId: string, mode: Mode, write: boolean) {
    text(eventId, 200);
    if (principal) await principal.guard(sql);
    const event = await deps.eventAccess.getEvent(sql, eventId, { forUpdate: write });
    if (!event) return missing();
    if (event.eventId !== eventId) return denied();
    if (mode === "staff") {
      if (!principal) return denied();
      const staff = await deps.eventAccess.requireStaff(sql, principal.actor, eventId, "communication_manage");
      if (staff.eventId !== eventId || staff.organizationId !== event.organizationId) return denied();
    } else if (!["published", "ended", "archived"].includes(event.status) || event.publishedRevision === null) return missing();
    if (mode === "member") {
      if (!principal) return denied();
      const registration = await deps.participation.getRegistration(sql, eventId, principal.actor.userId);
      if (!registration || registration.eventId !== eventId || registration.userId !== principal.actor.userId || registration.status !== "approved") return denied();
    }
    if (write) writable(event);
    return event;
  }
  async function run<T>(principal: OrganizerPrincipal | null, eventId: string, mode: Mode, write: boolean, work: (sql: SqlExecutor, event: HostedEventScope) => Promise<T>): Promise<T> {
    return deps.database.transaction(async sql => {
      const event = await scope(sql, principal, eventId, mode, write);
      const value = await work(sql, event);
      const current = await scope(sql, principal, eventId, mode, write);
      if (current.organizationId !== event.organizationId) return denied();
      return value;
    });
  }
  async function eligibleAuthor(sql: SqlExecutor, principal: OrganizerPrincipal | null, eventId: string): Promise<string | null> {
    if (!principal) return null;
    const registration = await deps.participation.getRegistration(sql, eventId, principal.actor.userId);
    return registration?.eventId === eventId && registration.userId === principal.actor.userId && registration.status === "approved" ? principal.actor.userId : null;
  }
  /** 本人可见的**已发布**公告及其已读状态。汇总与 `listAnnouncements` 必须读到同一批事实。 */
  async function ownAnnouncementViews(sql: SqlExecutor, event: HostedEventScope, userId: string): Promise<AnnouncementView[]> {
    const result = await sql.query<{ document: Announcement; read: boolean }>(`SELECT v.document,EXISTS(SELECT 1 FROM ec_announcement_reads r WHERE r.announcement_id=a.id AND r.revision=a.published_revision AND r.user_id=$3 AND r.organization_id=$1 AND r.event_id=$2) AS read FROM ec_announcements a JOIN ec_announcement_versions v ON v.announcement_id=a.id AND v.revision=a.published_revision AND v.organization_id=$1 AND v.event_id=$2 WHERE a.organization_id=$1 AND a.event_id=$2 ORDER BY a.id LIMIT 200`, [event.organizationId, event.eventId, userId]);
    // 选手视图只含已发布版本；草稿与已撤回即使留在表里也不进入汇总。
    return result.rows.filter(row => row.document.status === "published").map(row => announcementView(row.document, row.read));
  }
  /** 公开问题 + 本人求助，无工作人员提权；与 `listTickets` 同口径。 */
  async function ownTicketViews(sql: SqlExecutor, event: HostedEventScope, owner: string | null): Promise<TicketView[]> {
    const result = await sql.query<{ document: HelpTicket }>("SELECT document FROM ec_help_tickets WHERE organization_id=$1 AND event_id=$2 AND (visibility='public' OR user_id=$3) ORDER BY id LIMIT 200", [event.organizationId, event.eventId, owner]);
    return result.rows.filter(row => row.document.visibility === "public" || row.document.userId === owner).map(row => ticketView(row.document, owner, false));
  }
  /** 已发布赛事事实 → 汇总所需的最小上下文；不含任何私人字段。 */
  function summaryContext(event: HostedEventScope): SummaryEventContext {
    return {
      eventId: event.eventId, eventTitle: event.title, organizationName: event.organizationName, timezone: event.timezone,
      publishedRevision: event.publishedRevision,
      modules: { schedule: event.modules.schedule, accommodation: event.modules.accommodation, mealVouchers: event.modules.mealVouchers },
      deadlines: {
        registrationOpensAt: event.registrationOpensAt, registrationClosesAt: event.registrationClosesAt,
        submissionClosesAt: event.submissionClosesAt, startsAt: event.startsAt, endsAt: event.endsAt,
      },
    };
  }
  async function announcement(sql: SqlExecutor, event: HostedEventScope, id: string) {
    const result = await sql.query<{ document: Announcement; published_revision: number | null }>("SELECT document,published_revision FROM ec_announcements WHERE id=$1 AND organization_id=$2 AND event_id=$3 FOR UPDATE", [text(id, 200), event.organizationId, event.eventId]);
    if (!result.rows[0]) return missing(); return result.rows[0];
  }
  async function saveAnnouncement(principal: OrganizerPrincipal, eventId: string, input: unknown, publish: boolean): Promise<Announcement> {
    const body = object(input, ["announcementId", "expectedRevision", "title", "body", "important", "impact", "dueAt"]);
    const title = text(body.title, 200), content = text(body.body, 12000), impact = text(body.impact, 1000, !publish);
    if (typeof body.important !== "boolean") return invalid("请选择是否为重要通知。");
    let dueAt: string | null = null;
    if (body.dueAt !== undefined && body.dueAt !== null && body.dueAt !== "") {
      dueAt = parseEventInstant(body.dueAt);
    }
    const id = body.announcementId === undefined ? deps.ids.next() : text(body.announcementId, 200);
    editableAnnouncement(id, eventId);
    const expected = revision(body.expectedRevision ?? 0);
    return run(principal, eventId, "staff", true, async (sql, event) => {
      const old = body.announcementId === undefined ? null : await announcement(sql, event, id);
      sameRevision(expected, old?.document.revision ?? 0);
      const next: Announcement = { id, eventId, revision: expected + 1, title, body: content, important: body.important as boolean, impact, dueAt,
        status: publish ? "published" : "draft", publishedAt: publish ? now() : null, updatedAt: now(), updatedBy: principal.actor.userId,
        notification: { state: "unconfigured", referenceId: null } };
      let recipients: string[] | null = null;
      if (publish && deps.notification && deps.announcementAudience) {
        recipients = [...new Set(await deps.announcementAudience.listRecipientUserIds(sql, eventId))];
        if (recipients.length > 5000) return invalid("收件人过多，请分批发布。");
        for (const userId of recipients) {
          const registration = await deps.participation.getRegistration(sql, eventId, userId);
          if (!registration || registration.eventId !== eventId || registration.userId !== userId || registration.status !== "approved") return denied();
        }
      }
      const publishedRevision = publish ? next.revision : old?.published_revision ?? null;
      if (old) await sql.query("UPDATE ec_announcements SET revision=$1,published_revision=$2,status=$3,document=$4,updated_by=$5 WHERE id=$6 AND organization_id=$7 AND event_id=$8", [next.revision, publishedRevision, next.status, JSON.stringify(next), principal.actor.userId, id, event.organizationId, eventId]);
      else await sql.query("INSERT INTO ec_announcements(id,organization_id,event_id,revision,published_revision,status,document,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, event.organizationId, eventId, next.revision, publishedRevision, next.status, JSON.stringify(next), principal.actor.userId]);
      // Persist the aggregate before the root outbox references it, using the same transaction.
      if (recipients !== null && deps.notification) {
        next.notification = await deps.notification.enqueue(sql, { eventId, announcementId: id, revision: next.revision, recipientUserIds: recipients });
        await sql.query("UPDATE ec_announcements SET document=$1 WHERE id=$2 AND organization_id=$3 AND event_id=$4 AND revision=$5", [JSON.stringify(next), id, event.organizationId, eventId, next.revision]);
      }
      await sql.query("INSERT INTO ec_announcement_versions(announcement_id,organization_id,event_id,revision,document) VALUES($1,$2,$3,$4,$5)", [id, event.organizationId, eventId, next.revision, JSON.stringify(next)]);
      return next;
    });
  }
  function announcementView(value: Announcement, read: boolean): AnnouncementView {
    const { updatedBy: _updatedBy, notification, ...publicFields } = value; return { ...publicFields, read, notificationState: notification.state };
  }
  function ticketView(value: HelpTicket, userId: string | null, staff: boolean): TicketView {
    const { userId: owner, updatedBy: _updatedBy, ...safe } = value;
    return { ...safe, faqPreview: staff || owner === userId ? safe.faqPreview : null, own: owner === userId };
  }
  async function ticket(sql: SqlExecutor, event: HostedEventScope, id: string): Promise<HelpTicket> {
    const result = await sql.query<{ document: HelpTicket }>("SELECT document FROM ec_help_tickets WHERE id=$1 AND organization_id=$2 AND event_id=$3 FOR UPDATE", [text(id, 200), event.organizationId, event.eventId]);
    if (!result.rows[0]) return missing(); return result.rows[0].document;
  }
  async function storeTicket(sql: SqlExecutor, event: HostedEventScope, value: HelpTicket) {
    await sql.query("UPDATE ec_help_tickets SET status=$1,revision=$2,document=$3,updated_by=$4 WHERE id=$5 AND organization_id=$6 AND event_id=$7", [value.status, value.revision, JSON.stringify(value), value.updatedBy, value.id, event.organizationId, event.eventId]);
    await sql.query("INSERT INTO ec_help_ticket_versions(ticket_id,organization_id,event_id,revision,document) VALUES($1,$2,$3,$4,$5)", [value.id, event.organizationId, event.eventId, value.revision, JSON.stringify(value)]);
  }
  function edited(value: HelpTicket, principal: OrganizerPrincipal): HelpTicket { return { ...value, revision: value.revision + 1, updatedAt: now(), updatedBy: principal.actor.userId }; }
  return {
    /** Trusted root outbox reader; no delivery side effects and no public HTTP route. */
    async getNotificationAnnouncement(sql: SqlExecutor, input: { eventId: string; announcementId: string; revision: number }) {
      const event = await deps.eventAccess.getEvent(sql, input.eventId);
      if (!event) return null;
      if (isRuleChange(input.announcementId, event.eventId) && input.announcementId !== `rule-change:${event.eventId}:${event.publishedRevision}`) return null;
      const row = (await sql.query<{ document: Announcement; published_revision: number | null }>("SELECT document,published_revision FROM ec_announcements WHERE id=$1 AND organization_id=$2 AND event_id=$3", [input.announcementId, event.organizationId, input.eventId])).rows[0];
      if (!row || row.published_revision !== input.revision) return null;
      const value = row.document.revision === input.revision && row.document.status === "published" ? row.document : (await sql.query<{ document: Announcement }>("SELECT document FROM ec_announcement_versions WHERE announcement_id=$1 AND organization_id=$2 AND event_id=$3 AND revision=$4", [input.announcementId, event.organizationId, input.eventId, input.revision])).rows[0]?.document;
      if (!value || value.status !== "published" || value.revision !== input.revision || value.eventId !== input.eventId) return null;
      return { id: value.id, eventId: value.eventId, organizationId: event.organizationId, revision: value.revision, title: value.title, body: value.body, important: value.important, publishedAt: value.publishedAt, updatedBy: value.updatedBy,
        publisherCapability: (isRuleChange(value.id, event.eventId) ? "event_manage" : "communication_manage") as "event_manage" | "communication_manage" };
    },
    /** A current event publisher may transcribe the exact official change, without broader communication rights. */
    async publishRuleChange(sql: SqlExecutor, principal: OrganizerPrincipal, input: { eventId: string; organizationId: string; publishedRevision: number; title: string; changeSummary: string; rulesUrl: string }) {
      await principal.guard(sql);
      const event = await deps.eventAccess.requireStaff(sql, principal.actor, input.eventId, "event_manage");
      if (event.organizationId !== input.organizationId || event.publishedRevision !== input.publishedRevision || event.status !== "published") throw new DomainError("OFFICIAL_RULE_CHANGE_STALE", "正式比赛版本已变化，请重新核对。", { status: 409 });
      const id = `rule-change:${event.eventId}:${event.publishedRevision}`;
      const previous = (await sql.query<{ document: Announcement }>("SELECT document FROM ec_announcements WHERE id=$1 AND organization_id=$2 AND event_id=$3 FOR UPDATE", [id, event.organizationId, event.eventId])).rows[0];
      if (previous) { await principal.guard(sql); return previous.document; }
      const changeSummary = text(input.changeSummary, 2000), title = text(input.title, 160), rulesUrl = text(input.rulesUrl, 2048);
      const next: Announcement = { id, eventId: event.eventId, revision: 1, title: `${title} · 正式规则 v${event.publishedRevision}`, body: `主办方已正式发布规则 v${event.publishedRevision}。\n\n本次变化及参赛影响：\n${changeSummary}\n\n查看完整规则：${rulesUrl}`, important: true, impact: changeSummary.slice(0, 1000), dueAt: null, status: "published", publishedAt: now(), updatedAt: now(), updatedBy: principal.actor.userId, notification: { state: "unconfigured", referenceId: null } };
      await sql.query("INSERT INTO ec_announcements(id,organization_id,event_id,revision,published_revision,status,document,updated_by) VALUES($1,$2,$3,1,1,'published',$4,$5)", [id, event.organizationId, event.eventId, JSON.stringify(next), principal.actor.userId]);
      if (deps.notification && deps.announcementAudience) {
        const recipients = [...new Set(await deps.announcementAudience.listRecipientUserIds(sql, event.eventId))];
        if (recipients.length > 5000) invalid("收件人过多，请分批发布。");
        for (const userId of recipients) { const registration = await deps.participation.getRegistration(sql, event.eventId, userId); if (!registration || registration.userId !== userId || registration.eventId !== event.eventId || registration.status !== "approved") denied(); }
        next.notification = await deps.notification.enqueue(sql, { eventId: event.eventId, announcementId: id, revision: 1, recipientUserIds: recipients });
        await sql.query("UPDATE ec_announcements SET document=$1 WHERE id=$2 AND organization_id=$3 AND event_id=$4", [JSON.stringify(next), id, event.organizationId, event.eventId]);
      }
      await sql.query("INSERT INTO ec_announcement_versions(announcement_id,organization_id,event_id,revision,document) VALUES($1,$2,$3,1,$4)", [id, event.organizationId, event.eventId, JSON.stringify(next)]);
      await principal.guard(sql);
      return next;
    },
    saveAnnouncementDraft: (principal: OrganizerPrincipal, eventId: string, input: unknown) => saveAnnouncement(principal, eventId, input, false),
    publishAnnouncement: (principal: OrganizerPrincipal, eventId: string, input: unknown) => saveAnnouncement(principal, eventId, input, true),
    async listAnnouncements(principal: OrganizerPrincipal | null, eventId: string): Promise<AnnouncementView[]> {
      return run(principal, eventId, "public", false, async (sql, event) => {
        const result = await sql.query<{ document: Announcement; read: boolean }>(`SELECT v.document,EXISTS(SELECT 1 FROM ec_announcement_reads r WHERE r.announcement_id=a.id AND r.revision=a.published_revision AND r.user_id=$3 AND r.organization_id=$1 AND r.event_id=$2) AS read FROM ec_announcements a JOIN ec_announcement_versions v ON v.announcement_id=a.id AND v.revision=a.published_revision AND v.organization_id=$1 AND v.event_id=$2 WHERE a.organization_id=$1 AND a.event_id=$2 ORDER BY a.id LIMIT 200`, [event.organizationId, eventId, principal?.actor.userId ?? null]);
        return result.rows.map(row => announcementView(row.document, row.read));
      });
    },
    async listManagedAnnouncements(principal: OrganizerPrincipal, eventId: string): Promise<Announcement[]> {
      return run(principal, eventId, "staff", false, async (sql, event) => (await sql.query<{ document: Announcement }>("SELECT document FROM ec_announcements WHERE organization_id=$1 AND event_id=$2 ORDER BY id LIMIT 200", [event.organizationId, eventId])).rows.map(row => row.document));
    },
    async announcementHistory(principal: OrganizerPrincipal | null, eventId: string, id: string, staff = false): Promise<AnnouncementView[]> {
      return run(principal, eventId, staff ? "staff" : "public", false, async (sql, event) => {
        const head = await announcement(sql, event, id);
        if (!staff && head.published_revision === null) return missing();
        const result = await sql.query<{ document: Announcement }>("SELECT document FROM ec_announcement_versions WHERE announcement_id=$1 AND organization_id=$2 AND event_id=$3 ORDER BY revision DESC LIMIT 200", [id, event.organizationId, eventId]);
        return result.rows.filter(row => staff || row.document.status === "published").map(row => announcementView(row.document, false));
      });
    },
    async withdrawAnnouncement(principal: OrganizerPrincipal, eventId: string, id: string, input: unknown): Promise<Announcement> {
      editableAnnouncement(id, eventId);
      const body = object(input, ["expectedRevision"]), expected = revision(body.expectedRevision);
      return run(principal, eventId, "staff", true, async (sql, event) => {
        const current = (await announcement(sql, event, id)).document; sameRevision(expected, current.revision);
        const next: Announcement = { ...current, revision: current.revision + 1, status: "withdrawn", updatedAt: now(), updatedBy: principal.actor.userId };
        await sql.query("UPDATE ec_announcements SET revision=$1,published_revision=NULL,status='withdrawn',document=$2,updated_by=$3 WHERE id=$4 AND organization_id=$5 AND event_id=$6", [next.revision, JSON.stringify(next), principal.actor.userId, id, event.organizationId, eventId]);
        await sql.query("INSERT INTO ec_announcement_versions(announcement_id,organization_id,event_id,revision,document) VALUES($1,$2,$3,$4,$5)", [id, event.organizationId, eventId, next.revision, JSON.stringify(next)]); return next;
      });
    },
    async markAnnouncementRead(principal: OrganizerPrincipal, eventId: string, id: string, input: unknown) {
      const body = object(input, ["revision"]), expected = revision(body.revision);
      return run(principal, eventId, "public", true, async (sql, event) => {
        const current = await announcement(sql, event, id); if (current.published_revision === null) return missing(); sameRevision(expected, current.published_revision);
        await sql.query("INSERT INTO ec_announcement_reads(organization_id,event_id,announcement_id,revision,user_id,read_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(announcement_id,revision,user_id) DO NOTHING", [event.organizationId, eventId, id, expected, principal.actor.userId, now()]);
        return { announcementId: id, revision: expected, read: true as const };
      });
    },
    async listTickets(principal: OrganizerPrincipal | null, eventId: string): Promise<TicketView[]> {
      return run(principal, eventId, "public", false, async (sql, event) => {
        // Only public tickets plus the current author's tickets; no staff escalation.
        const owner = await eligibleAuthor(sql, principal, eventId);
        const result = await sql.query<{ document: HelpTicket }>("SELECT document FROM ec_help_tickets WHERE organization_id=$1 AND event_id=$2 AND (visibility='public' OR user_id=$3) ORDER BY id LIMIT 200", [event.organizationId, eventId, owner]);
        const currentOwner = await eligibleAuthor(sql, principal, eventId);
        return result.rows.filter(row => row.document.visibility === "public" || row.document.userId === currentOwner).map(row => ticketView(row.document, currentOwner, false));
      });
    },
    async listManagedTickets(principal: OrganizerPrincipal, eventId: string): Promise<TicketView[]> {
      return run(principal, eventId, "staff", false, async (sql, event) => (await sql.query<{ document: HelpTicket }>("SELECT document FROM ec_help_tickets WHERE organization_id=$1 AND event_id=$2 ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,id LIMIT 200", [event.organizationId, eventId])).rows.map(row => ticketView(row.document, principal.actor.userId, true)));
    },
    async getTicket(principal: OrganizerPrincipal | null, eventId: string, id: string, staff = false): Promise<TicketView> {
      return run(principal, eventId, staff ? "staff" : "public", false, async (sql, event) => {
        const owner = staff ? principal?.actor.userId ?? null : await eligibleAuthor(sql, principal, eventId);
        const value = await ticket(sql, event, id); if (!staff && value.visibility !== "public" && value.userId !== owner) return missing();
        const currentOwner = staff ? principal?.actor.userId ?? null : await eligibleAuthor(sql, principal, eventId);
        if (!staff && value.visibility !== "public" && value.userId !== currentOwner) return missing();
        return ticketView(value, currentOwner, staff);
      });
    },
    async createTicket(principal: OrganizerPrincipal, eventId: string, input: unknown): Promise<TicketView> {
      const body = object(input, ["visibility", "question"]); if (!["private", "public"].includes(body.visibility as string)) return invalid("请选择公开问题或私人求助。");
      const question = text(body.question, 6000);
      return run(principal, eventId, "member", true, async (sql, event) => {
        const value: HelpTicket = { id: deps.ids.next(), eventId, userId: principal.actor.userId, visibility: body.visibility as HelpTicket["visibility"], question, status: "open", revision: 1, createdAt: now(), updatedAt: now(), updatedBy: principal.actor.userId, replies: [], faqPreview: null };
        await sql.query("INSERT INTO ec_help_tickets(id,organization_id,event_id,user_id,visibility,status,revision,document,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [value.id, event.organizationId, eventId, value.userId, value.visibility, value.status, value.revision, JSON.stringify(value), value.updatedBy]);
        await sql.query("INSERT INTO ec_help_ticket_versions(ticket_id,organization_id,event_id,revision,document) VALUES($1,$2,$3,$4,$5)", [value.id, event.organizationId, eventId, value.revision, JSON.stringify(value)]); return ticketView(value, principal.actor.userId, false);
      });
    },
    async addReply(principal: OrganizerPrincipal, eventId: string, id: string, input: unknown, staff = false): Promise<TicketView> {
      const body = object(input, ["body", "expectedRevision"]), content = text(body.body, 6000), expected = revision(body.expectedRevision);
      return run(principal, eventId, staff ? "staff" : "member", true, async (sql, event) => {
        const current = await ticket(sql, event, id); if (!staff && current.userId !== principal.actor.userId) return missing(); sameRevision(expected, current.revision);
        if (current.status === "closed") throw new DomainError("TICKET_CLOSED", "问题已关闭，请新建问题或由工作人员重新打开。", { status: 409 });
        if (current.replies.length >= 100) return invalid("回复已达上限，请新建后续问题。");
        const next = edited(current, principal); next.replies = [...current.replies, { id: deps.ids.next(), body: content, role: staff ? "staff" : "author", createdAt: now() }];
        next.status = staff ? "answered" : "open"; await storeTicket(sql, event, next); return ticketView(next, principal.actor.userId, staff);
      });
    },
    async changeTicketStatus(principal: OrganizerPrincipal, eventId: string, id: string, input: unknown): Promise<TicketView> {
      const body = object(input, ["status", "expectedRevision"]), expected = revision(body.expectedRevision);
      if (!["open", "in_progress", "answered", "closed"].includes(body.status as string)) return invalid();
      return run(principal, eventId, "staff", true, async (sql, event) => {
        const current = await ticket(sql, event, id); sameRevision(expected, current.revision);
        if (body.status === "answered" && !current.replies.some(reply => reply.role === "staff")) return invalid("先回复问题，再标记已答复。");
        const next = edited(current, principal); next.status = body.status as TicketStatus; await storeTicket(sql, event, next); return ticketView(next, principal.actor.userId, true);
      });
    },
    async proposeFaqPreview(principal: OrganizerPrincipal, eventId: string, id: string, input: unknown): Promise<TicketView> {
      const body = object(input, ["title", "question", "answer", "expectedRevision"]), expected = revision(body.expectedRevision);
      const title = text(body.title, 200), question = text(body.question, 6000), answer = text(body.answer, 6000);
      return run(principal, eventId, "staff", true, async (sql, event) => {
        const current = await ticket(sql, event, id); sameRevision(expected, current.revision);
        const next = edited(current, principal); next.faqPreview = { revision: (current.faqPreview?.revision ?? 0) + 1, title, question, answer, proposedAt: now(), consentedAt: null };
        await storeTicket(sql, event, next); return ticketView(next, principal.actor.userId, true);
      });
    },
    async consentFaqPublication(principal: OrganizerPrincipal, eventId: string, id: string, input: unknown): Promise<TicketView> {
      const body = object(input, ["previewRevision", "expectedRevision", "consent"]), expected = revision(body.expectedRevision), previewRevision = revision(body.previewRevision);
      if (body.consent !== true) return invalid("请本人确认公开预览；内容本身仍可能识别身份。");
      return run(principal, eventId, "member", true, async (sql, event) => {
        const current = await ticket(sql, event, id); if (current.userId !== principal.actor.userId) return denied(); sameRevision(expected, current.revision);
        if (!current.faqPreview) return invalid("工作人员还没有提供公开预览。"); sameRevision(previewRevision, current.faqPreview.revision);
        const next = edited(current, principal); next.faqPreview = { ...current.faqPreview, consentedAt: now() };
        const existing = await sql.query<{ id: string }>("SELECT id FROM ec_public_faqs WHERE source_ticket_id=$1 AND organization_id=$2 AND event_id=$3 FOR UPDATE", [id, event.organizationId, eventId]);
        const value: PublicFaq = { id: existing.rows[0]?.id ?? deps.ids.next(), eventId, revision: previewRevision, title: next.faqPreview.title, question: next.faqPreview.question, answer: next.faqPreview.answer, publishedAt: now() };
        await sql.query("INSERT INTO ec_public_faqs(id,organization_id,event_id,source_ticket_id,revision,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_ticket_id) DO UPDATE SET revision=excluded.revision,document=excluded.document", [value.id, event.organizationId, eventId, id, previewRevision, JSON.stringify(value)]);
        await storeTicket(sql, event, next); return ticketView(next, principal.actor.userId, false);
      });
    },
    async listPublicFaqs(principal: OrganizerPrincipal | null, eventId: string): Promise<PublicFaq[]> {
      return run(principal, eventId, "public", false, async (sql, event) => (await sql.query<{ document: PublicFaq }>("SELECT document FROM ec_public_faqs WHERE organization_id=$1 AND event_id=$2 ORDER BY id LIMIT 200", [event.organizationId, eventId])).rows.map(row => row.document));
    },
    /**
     * 本人报名与队伍（选手侧汇总 P08 需要）。**只通过注入的只读 Port 读取**，
     * 不查 `event-registration` 的表，也不缓存第二份成员事实。
     *
     * Port 未接线时返回 `undefined`（"还没读到"），`MUST NOT` 退化成 `null`（"确实没有"）——
     * 否则汇总会说"你还没有队伍"而实际只是没读到（宪法 X）。
     */
    async ownRegistrationAndTeam(principal: OrganizerPrincipal, eventId: string): Promise<{
      registration: { status: "draft" | "pending" | "approved" | "rejected" | "withdrawn" } | null | undefined;
      team: { id: string; name: string; role: "captain" | "member"; memberCount: number; status: "forming" | "locked" | "withdrawn"; track: string } | null | undefined;
    }> {
      if (!deps.ownFacts) return { registration: undefined, team: undefined };
      const facts = deps.ownFacts;
      return run(principal, eventId, "member", false, async (sql, event) => {
        const registration = await facts.registration(sql, event.eventId, principal.actor.userId);
        const team = await facts.team(sql, event.eventId, principal.actor.userId);
        return {
          registration: registration ? { status: registration.status } : null,
          team: team ? { id: team.id, name: team.name, role: team.captainUserId === principal.actor.userId ? "captain" as const : "member" as const, memberCount: team.memberCount, status: team.status, track: team.track } : null,
        };
      });
    },
    /**
     * 选手侧资源汇总（规划 33 P08）的**只读**读取段。
     *
     * 只做三件事：确认本人是本场已通过报名的参赛者、导出已发布赛事事实的最小上下文、
     * 读取本模块自己拥有的公告/已读/求助。行程与后勤由根调用同一模块的
     * `schedule.getSchedule` 与 `logistics.ownServices` 后一并交给纯函数组装——
     * 那是这两项事实各自的**唯一权威读路径**，不在这里另写一份查询。
     *
     * 不写库、不发送通知、不调用模型；`run` 会在事务首尾各复核一次身份与权限。
     */
    /**
     * 规划34 D1：本场参赛名录（只读派生）。
     * 需要赛事开启 `community.participantDirectory`，且 `run(..., "member", ...)` 已确认调用者是本场报名已通过的参赛者。
     * 只组合**既有**已发布名片与本场公开队伍；未接入来源端口时返回空并写明「未接入」，不用空名单冒充已完成。
     */
    async directory(principal: OrganizerPrincipal, eventId: string): Promise<EventDirectory> {
      return run(principal, eventId, "member", false, async (sql, event) => {
        if (!eventCommunity(event).participantDirectory) throw new DomainError("EVENT_COMMUNITY_DISABLED", "本场没有开启参赛名录；如需查看，请联系主办方。", { status: 403 });
        if (!deps.directory) return { enabled: true, entries: [], teams: [], notice: "参赛名录来源尚未接入；这里不返回任何记录。", limitations: ["未接入时既没有名片也没有队伍，不会被当成『本场无人』。"] };
        const participants = await deps.directory.approvedParticipantIds(sql, eventId);
        const cards = await deps.directory.publishedCards(sql, participants);
        const teams = await deps.directory.publicTeams(sql, eventId);
        const entries = [...cards].sort((left, right) => left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0);
        return { enabled: true, entries, teams, notice: "只显示本人已发布的参赛名片与本场公开队伍；名片为本人自述、未经平台核验，且不含邮箱。", limitations: ["未发布或已撤回名片的参赛者不会出现。", "联系方式由本人决定，平台不撮合、不暴露邮箱。"] };
      });
    },
    async ownFacts(principal: OrganizerPrincipal, eventId: string): Promise<{
      event: SummaryEventContext;
      registration: { status: "draft" | "pending" | "approved" | "rejected" | "withdrawn" } | null;
      announcements: AnnouncementView[];
      tickets: TicketView[];
    }> {
      return run(principal, eventId, "member", false, async (sql, event) => {
        // `scope(..., "member", ...)` 已确认本人是本场报名已通过的参赛者，因此这里必然读得到报名。
        const registration = await deps.participation.getRegistration(sql, eventId, principal.actor.userId);
        const owner = await eligibleAuthor(sql, principal, eventId);
        return {
          event: summaryContext(event),
          registration: registration ? { status: registration.status } : null,
          announcements: await ownAnnouncementViews(sql, event, principal.actor.userId),
          tickets: await ownTicketViews(sql, event, owner),
        };
      });
    },
  };
}
export type EventCommunicationService = ReturnType<typeof createEventCommunicationService>;
