import { randomUUID } from "node:crypto";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { EventCommunicationService } from "./service.ts";
import type { EventScheduleService, AssignIcebreakerGroupInput, CreateIcebreakerInput, SaveScheduleDraftInput, ScheduleImportInput } from "./schedule-model.ts";
import type { EventLogisticsService } from "./logistics.ts";
import type { AssignAccommodationInput, CreateVoucherTypeInput, IssueVoucherInput, RedeemVoucherInput } from "./logistics-model.ts";
import { buildParticipantSummary } from "./participant-summary.ts";
import type { ParticipantSummary } from "./participant-summary.ts";

export type CommunicationRouteKind = "announcements" | "announcementRead" | "announcementHistory" | "tickets" | "ticket" | "replies" | "faq" | "consent" | "schedule" | "ownServices" | "mySummary" | "participants" | "icebreakers" | "icebreakerResponse" |
  "managedAnnouncements" | "announcementDraft" | "announcementWithdraw" | "managedAnnouncementHistory" | "managedTickets" | "managedTicket" | "managedReplies" | "ticketStatus" | "faqPreview" | "scheduleDraft" | "scheduleImportPreview" | "scheduleImportConfirm" | "schedulePublish" | "accommodation" | "accommodationImportPreview" | "accommodationImportConfirm" | "voucherTypes" | "vouchers" | "voucherRevoke" | "voucherRedeem" | "managedIcebreakers" | "icebreakerGroups";
export interface EventCommunicationHttpRoute { readonly kind: CommunicationRouteKind; readonly eventId: string; readonly id?: string }
export interface EventCommunicationHttpDependencies {
  readonly communication: EventCommunicationService;
  readonly schedule: EventScheduleService;
  readonly logistics: EventLogisticsService;
  /** Root derives this from the exact request session, never request JSON. */
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  /** Root enforces trusted Origin/CSRF before any mutation. */
  authorizeMutation(request: Request): Promise<void>;
  requestId?(): string;
}
const allowed: Record<CommunicationRouteKind, readonly string[]> = {
  announcements: ["GET"], announcementRead: ["POST"], announcementHistory: ["GET"], tickets: ["GET", "POST"], ticket: ["GET"], replies: ["GET", "POST"], faq: ["GET"], consent: ["POST"], schedule: ["GET"], ownServices: ["GET"], mySummary: ["GET"], participants: ["GET"], icebreakers: ["GET"], icebreakerResponse: ["POST"],
  managedAnnouncements: ["GET", "POST"], announcementDraft: ["POST"], announcementWithdraw: ["POST"], managedAnnouncementHistory: ["GET"], managedTickets: ["GET"], managedTicket: ["GET"], managedReplies: ["GET", "POST"], ticketStatus: ["PATCH"], faqPreview: ["POST"], scheduleDraft: ["GET", "PUT"], scheduleImportPreview: ["POST"], scheduleImportConfirm: ["POST"], schedulePublish: ["POST"], accommodation: ["GET", "POST"], accommodationImportPreview: ["POST"], accommodationImportConfirm: ["POST"], voucherTypes: ["GET", "POST"], vouchers: ["GET", "POST"], voucherRevoke: ["POST"], voucherRedeem: ["POST"], managedIcebreakers: ["GET", "POST"], icebreakerGroups: ["POST"],
};
const publicRead = new Set<CommunicationRouteKind>(["announcements", "announcementHistory", "tickets", "ticket", "replies", "faq", "schedule"]);
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("JSON_REQUIRED", "请发送 JSON 请求。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) throw new DomainError("INVALID_JSON", "请求内容不能为空。", { status: 400 });
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > 128 * 1024) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "内容过大，请分批处理。", { status: 413 }); } chunks.push(next.value); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_JSON", "请求必须是对象。", { status: 400 });
    return value as Record<string, unknown>;
  } catch (error) { if (isDomainError(error)) throw error; throw new DomainError("INVALID_JSON", "请求内容不是有效 JSON。", { status: 400 }); }
  finally { reader.releaseLock(); }
}
/**
 * 选手侧资源汇总（规划 33 P08）：把**已有读数**交给纯函数组装，本身不写任何事实。
 *
 * 分工刻意与事实所有权对齐：
 * - `communication.ownFacts` 负责"本人是不是本场参赛者"的判定，并给出本模块拥有的公告/已读/求助；
 * - `schedule.getSchedule` 与 `logistics.ownServices` 是行程与后勤各自的**唯一权威读路径**，
 *   这里直接复用，不另写一份查询，因此不会出现第二份行程或后勤事实。
 */
async function participantSummary(c: EventCommunicationService, s: EventScheduleService, l: EventLogisticsService, principal: OrganizerPrincipal, eventId: string): Promise<ParticipantSummary> {
  const own = await c.ownFacts(principal, eventId);
  const schedule = own.event.modules.schedule ? await s.getSchedule(principal, eventId) : null;
  const services = await l.ownServices(principal, eventId);
  // 根未接线本人报名/队伍 Port 时保持 `undefined`，纯函数据此输出 `unread` 而不是"没有队伍"。
  const facts = await c.ownRegistrationAndTeam(principal, eventId);
  return buildParticipantSummary({
    ...own.event,
    registration: facts.registration,
    team: facts.team,
    announcements: own.announcements,
    tickets: own.tickets,
    scheduleItems: schedule?.items ?? [],
    accommodation: services.accommodation
      ? { location: services.accommodation.location, room: services.accommodation.room, checkIn: services.accommodation.checkIn, checkOut: services.accommodation.checkOut, note: services.accommodation.note }
      : null,
    vouchers: services.vouchers.map(voucher => ({ name: voucher.name, remainingUses: voucher.remainingUses, totalUses: voucher.totalUses, expiresAt: voucher.expiresAt, state: voucher.state })),
  });
}

/** Fixed method boundary; root owns physical routes and supplies its real request guard. */
export function createEventCommunicationHttpHandlers(deps: EventCommunicationHttpDependencies) {
  return { async handle(request: Request, route: EventCommunicationHttpRoute): Promise<Response> {
    const requestId = deps.requestId?.() ?? randomUUID();
    const headers: Record<string, string> = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    try {
      if (!allowed[route.kind]?.includes(request.method)) { headers.Allow = allowed[route.kind]?.join(", ") ?? ""; throw new DomainError("METHOD_NOT_ALLOWED", "此操作不支持该方法。", { status: 405 }); }
      const principal = await deps.resolvePrincipal(request);
      if (!principal && !(request.method === "GET" && publicRead.has(route.kind))) throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
      if (request.method !== "GET") await deps.authorizeMutation(request);
      const body = request.method === "GET" ? {} : await readJson(request);
      const eventId = route.eventId, id = route.id ?? "", c = deps.communication, s = deps.schedule, l = deps.logistics;
      let data: unknown;
      switch (route.kind) {
        case "announcements": data = await c.listAnnouncements(principal, eventId); break;
        case "announcementRead": data = await c.markAnnouncementRead(principal!, eventId, id, body); break;
        case "announcementHistory": data = await c.announcementHistory(principal, eventId, id); break;
        case "tickets": data = request.method === "GET" ? await c.listTickets(principal, eventId) : await c.createTicket(principal!, eventId, body); break;
        case "ticket": data = await c.getTicket(principal, eventId, id); break;
        case "replies": data = request.method === "GET" ? (await c.getTicket(principal, eventId, id)).replies : await c.addReply(principal!, eventId, id, body); break;
        case "faq": data = await c.listPublicFaqs(principal, eventId); break;
        case "consent": data = await c.consentFaqPublication(principal!, eventId, id, body); break;
        case "schedule": data = await s.getSchedule(principal, eventId); break;
        case "ownServices": data = await l.ownServices(principal!, eventId); break;
        case "mySummary": data = await participantSummary(c, s, l, principal!, eventId); break;
        case "participants": data = await c.directory(principal!, eventId); break;
        case "icebreakers": data = await s.listIcebreakers(principal!, eventId); break;
        case "icebreakerResponse": data = await s.respondIcebreaker(principal!, eventId, { ...body, activityId: id } as Parameters<EventScheduleService["respondIcebreaker"]>[2]); break;
        case "managedAnnouncements": data = request.method === "GET" ? await c.listManagedAnnouncements(principal!, eventId) : await c.publishAnnouncement(principal!, eventId, body); break;
        case "announcementDraft": data = await c.saveAnnouncementDraft(principal!, eventId, body); break;
        case "announcementWithdraw": data = await c.withdrawAnnouncement(principal!, eventId, id, body); break;
        case "managedAnnouncementHistory": data = await c.announcementHistory(principal, eventId, id, true); break;
        case "managedTickets": data = await c.listManagedTickets(principal!, eventId); break;
        case "managedTicket": data = await c.getTicket(principal, eventId, id, true); break;
        case "managedReplies": data = request.method === "GET" ? (await c.getTicket(principal, eventId, id, true)).replies : await c.addReply(principal!, eventId, id, body, true); break;
        case "ticketStatus": data = await c.changeTicketStatus(principal!, eventId, id, body); break;
        case "faqPreview": data = await c.proposeFaqPreview(principal!, eventId, id, body); break;
        case "scheduleDraft": data = request.method === "GET" ? await s.getScheduleDraft(principal!, eventId) : await s.saveScheduleDraft(principal!, eventId, body as unknown as SaveScheduleDraftInput); break;
        case "scheduleImportPreview": data = await s.previewScheduleImport(principal!, eventId, body as unknown as ScheduleImportInput); break;
        case "scheduleImportConfirm": data = await s.confirmScheduleImport(principal!, eventId, body as unknown as Parameters<EventScheduleService["confirmScheduleImport"]>[2]); break;
        case "schedulePublish": data = await s.publishSchedule(principal!, eventId, body as unknown as Parameters<EventScheduleService["publishSchedule"]>[2]); break;
        case "accommodation": data = request.method === "GET" ? await l.listAccommodation(principal!, eventId) : await l.assignAccommodation(principal!, eventId, body as unknown as AssignAccommodationInput); break;
        case "accommodationImportPreview": data = await l.previewAccommodationImport(principal!, eventId, body as unknown as { csv: string }); break;
        case "accommodationImportConfirm": data = await l.confirmAccommodationImport(principal!, eventId, body as unknown as { previewId: string }); break;
        case "voucherTypes": data = request.method === "GET" ? await l.listVoucherTypes(principal!, eventId) : await l.createVoucherType(principal!, eventId, body as unknown as CreateVoucherTypeInput); break;
        case "vouchers": data = request.method === "GET" ? await l.listVouchers(principal!, eventId) : await l.issueVoucher(principal!, eventId, body as unknown as IssueVoucherInput); break;
        case "voucherRevoke": data = await l.revokeVoucher(principal!, eventId, { ...body, voucherId: id } as unknown as Parameters<EventLogisticsService["revokeVoucher"]>[2]); break;
        case "voucherRedeem": data = await l.redeemVoucher(principal!, eventId, body as unknown as RedeemVoucherInput); break;
        case "managedIcebreakers": data = request.method === "GET" ? await s.listManagedIcebreakers(principal!, eventId) : await s.createIcebreaker(principal!, eventId, body as unknown as CreateIcebreakerInput); break;
        case "icebreakerGroups": data = await s.assignIcebreakerGroup(principal!, eventId, { ...body, activityId: id } as unknown as AssignIcebreakerGroupInput); break;
      }
      return Response.json({ data, requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  } };
}

/** Accept root's decoded path segments after /api/v1; exact matching prevents action smuggling. */
export function eventCommunicationHttpRoute(path: readonly string[]): EventCommunicationHttpRoute | null {
  const publicScope = path[0] === "competitions", managedScope = path[0] === "organizer" && path[1] === "events";
  if (!publicScope && !managedScope) return null;
  const eventId = path[publicScope ? 1 : 2], rest = path.slice(publicScope ? 2 : 3);
  if (!eventId || eventId.length > 200 || rest.some(part => !part || part.length > 200)) return null;
  const fixed: Record<string, CommunicationRouteKind> = publicScope ? { announcements: "announcements", "help-tickets": "tickets", faq: "faq", schedule: "schedule", "my-services": "ownServices", "my-summary": "mySummary", participants: "participants", icebreakers: "icebreakers" } : {
    announcements: "managedAnnouncements", "announcements/draft": "announcementDraft", "help-tickets": "managedTickets", "schedule/draft": "scheduleDraft", "schedule/import/preview": "scheduleImportPreview", "schedule/import/confirm": "scheduleImportConfirm", "schedule/publish": "schedulePublish", "accommodation-assignments": "accommodation", "accommodation-import/preview": "accommodationImportPreview", "accommodation-import/confirm": "accommodationImportConfirm", "meal-voucher-types": "voucherTypes", "meal-vouchers": "vouchers", "meal-vouchers/redeem": "voucherRedeem", icebreakers: "managedIcebreakers",
  };
  const joined = rest.join("/"); if (Object.hasOwn(fixed, joined)) return { eventId, kind: fixed[joined] };
  if (rest[0] === "help-tickets" && rest.length === 2) return { eventId, id: rest[1], kind: publicScope ? "ticket" : "managedTicket" };
  if (rest.length !== 3) return null;
  const [group, id, action] = rest;
  if (group === "announcements") {
    if (action === "versions") return { eventId, id, kind: publicScope ? "announcementHistory" : "managedAnnouncementHistory" };
    if (publicScope && action === "read") return { eventId, id, kind: "announcementRead" };
    if (managedScope && action === "withdraw") return { eventId, id, kind: "announcementWithdraw" };
  }
  if (group === "help-tickets") {
    if (action === "replies") return { eventId, id, kind: publicScope ? "replies" : "managedReplies" };
    if (publicScope && action === "publish-consent") return { eventId, id, kind: "consent" };
    if (managedScope && action === "status") return { eventId, id, kind: "ticketStatus" };
    if (managedScope && action === "faq-preview") return { eventId, id, kind: "faqPreview" };
  }
  if (group === "icebreakers" && publicScope && action === "respond") return { eventId, id, kind: "icebreakerResponse" };
  if (group === "icebreakers" && managedScope && action === "groups") return { eventId, id, kind: "icebreakerGroups" };
  if (group === "meal-vouchers" && managedScope && action === "revoke") return { eventId, id, kind: "voucherRevoke" };
  return null;
}
