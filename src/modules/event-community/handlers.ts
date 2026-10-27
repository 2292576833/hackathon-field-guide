import type { IdGenerator } from "../../shared/contracts.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { EventCommunityService } from "./service.ts";
import type {
  ConnectionInput, ConnectionRespondInput, ConnectionRevisionInput, DirectMessageInput,
  DirectMessageWithdrawInput, ReportInput,
} from "./model.ts";

/**
 * 选手社区 HTTP 工厂。与既有模块同形：私有 no-store、JSON 最多 64KB 且不接受压缩、
 * GET 只读、写请求由 root 做 Origin/CSRF 授权。
 *
 * 门禁本身在服务里：连接关闭时**所有**这些入口都返回 403（不是空数组），
 * 只有私信关闭时连接接口照常、发信接口 403。这里不新增公开面。
 */
export interface EventCommunityHttpDependencies {
  service: EventCommunityService;
  /** Root resolves a real account/session and its transaction-aware guard. */
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  authorizeMutation(request: Request, principal: OrganizerPrincipal): Promise<void>;
  requestIds: IdGenerator;
}
export interface EventCommunityRouteParams { eventId: string; connectionId?: string; messageId?: string; peerUserId?: string }

export function createEventCommunityHandlers(deps: EventCommunityHttpDependencies) {
  const handler = (method: string, work: (principal: OrganizerPrincipal, request: Request, params: EventCommunityRouteParams) => Promise<unknown>) =>
    async (request: Request, params: EventCommunityRouteParams): Promise<Response> => {
      const requestId = deps.requestIds.next();
      const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
      try {
        if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
        routeId(params?.eventId, "赛事");
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的选手社区操作。", { status: 401 });
        if (method !== "GET") await deps.authorizeMutation(request, principal);
        return Response.json({ data: await work(principal, request, params), requestId }, { headers });
      } catch (error) {
        return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers });
      }
    };
  return {
    /** 本场能力开关 + 本人相关的请求/连接/屏蔽。连接关闭时 403。 */
    overview: handler("GET", (p, _r, a) => deps.service.overview(p, a.eventId)),
    /** 发起"想认识"。 */
    requestConnection: handler("POST", async (p, r, a) => deps.service.requestConnection(p, a.eventId, await body(r) as unknown as ConnectionInput)),
    /** 接受 / 拒绝。 */
    respondConnection: handler("POST", async (p, r, a) => deps.service.respondConnection(p, a.eventId, routeId(a.connectionId, "连接"), await body(r) as unknown as ConnectionRespondInput)),
    /** 发起人取消请求。 */
    cancelConnection: handler("POST", async (p, r, a) => deps.service.cancelConnection(p, a.eventId, routeId(a.connectionId, "连接"), await body(r) as unknown as ConnectionRevisionInput)),
    /** 一段会话（只读；私信关闭时按保留口径只读）。 */
    conversation: handler("GET", (p, r, a) => deps.service.conversation(p, a.eventId, a.peerUserId ?? queryId(r, "peerUserId", "对方账号"))),
    /** 发消息。私信关闭时 403。 */
    sendDirectMessage: handler("POST", async (p, r, a) => deps.service.sendDirectMessage(p, a.eventId, await body(r) as unknown as DirectMessageInput)),
    /** 本人撤回自己发出的消息。 */
    withdrawDirectMessage: handler("POST", async (p, r, a) => deps.service.withdrawDirectMessage(p, a.eventId, routeId(a.messageId, "消息"), await body(r) as unknown as DirectMessageWithdrawInput)),
    /** 屏蔽对方。 */
    blockUser: handler("POST", async (p, r, a) => deps.service.blockUser(p, a.eventId, await bodyPeer(r))),
    /** 解除自己的屏蔽。 */
    unblockUser: handler("POST", async (p, r, a) => deps.service.unblockUser(p, a.eventId, await bodyPeer(r))),
    /** 举报：只记录事实与最近消息快照。 */
    reportUser: handler("POST", async (p, r, a) => deps.service.reportUser(p, a.eventId, await body(r) as unknown as ReportInput)),
    /** 主办方举报队列（只读；只含被举报快照）。 */
    organizerReports: handler("GET", (p, _r, a) => deps.service.organizerReports(p, a.eventId)),
  };
}

function routeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new DomainError("INVALID_ROUTE", `缺少有效的${label}地址。`, { status: 400 });
  return value;
}
function queryId(request: Request, key: string, label: string): string {
  return routeId(new URL(request.url).searchParams.get(key), label);
}
async function bodyPeer(request: Request): Promise<string> {
  const value = await body(request);
  return routeId(value.peerUserId, "账号");
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || (request.headers.get("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")) throw new DomainError("JSON_REQUIRED", "请提交未压缩的JSON内容。", { status: 415 });
  const max = 65536, length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > max) throw new DomainError("PAYLOAD_TOO_LARGE", "输入超过64KB，请缩短后继续。", { status: 413 });
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new DomainError("PAYLOAD_TOO_LARGE", "输入超过64KB，请缩短后继续。", { status: 413 }); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DomainError("INVALID_JSON", "请提交有效JSON内容。", { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("COMMUNITY_INVALID_INPUT", "输入内容格式不正确。");
  return value as Record<string, unknown>;
}
