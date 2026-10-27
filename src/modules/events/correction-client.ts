import type { PublicEvent } from "./model.ts";

/** Wire DTO for the public M08 correction API; this module owns no correction queue. */
export type EventCorrectionStatus = "received" | "triaging" | "confirmed" | "needs_more_info" | "dismissed" | "resolved";
export interface EventCorrectionTargetDto { readonly kind: "event" | "resource"; readonly entityId: string; readonly version: number }
export interface EventCorrectionDto {
  readonly id: string;
  readonly submittedBy: string;
  readonly original: { readonly target: EventCorrectionTargetDto; readonly field: string; readonly message: string; readonly evidenceUrls: readonly string[]; readonly submittedAt: string };
  readonly revision: number;
  readonly status: EventCorrectionStatus;
  readonly updatedAt: string;
  readonly response: string | null;
  readonly relatedVersion: EventCorrectionTargetDto | null;
}
export interface SubmitEventCorrectionDto { readonly target: EventCorrectionTargetDto; readonly field: string; readonly message: string; readonly evidenceUrls: readonly string[] }
export const eventCorrectionStatuses: Record<EventCorrectionStatus, { label: string; description: string }> = {
  received: { label: "已收到", description: "等待审核员核对你提供的说明与来源。" },
  triaging: { label: "正在核对", description: "审核员正在检查来源与正式赛事内容。" },
  confirmed: { label: "已确认，等待修正", description: "问题已确认，正式规则更新仍需审核与发布。" },
  needs_more_info: { label: "需要补充资料", description: "请阅读处理说明；可补充依据后提交新的纠错记录。" },
  dismissed: { label: "未采纳", description: "请查看审核员说明；当前正式规则保留。" },
  resolved: { label: "处理完成", description: "请查看处理说明与关联版本；结案本身不代表规则必然更新。" },
};
export const eventCorrectionReasons = { incorrect: "信息有误", official_update: "官方信息已更新", missing: "信息遗漏", source_mismatch: "内容与来源不一致", other: "其他问题" } as const;
export type EventCorrectionReason = keyof typeof eventCorrectionReasons;

function validTarget(value: unknown): value is EventCorrectionTargetDto {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<EventCorrectionTargetDto>;
  return (target.kind === "event" || target.kind === "resource") && typeof target.entityId === "string" && !!target.entityId.trim() && Number.isSafeInteger(target.version) && target.version! > 0;
}
/** A discovery card has no published M03 snapshot and cannot supply this reference. Server rechecks it. */
export function getFormalEventCorrectionTarget(eventId: string, currentEvent: PublicEvent): EventCorrectionTargetDto {
  const event = currentEvent?.event, rules = currentEvent?.rules;
  if (!event || !rules || event.id !== eventId || rules.eventId !== eventId || event.publicationStatus === "archived" || event.publishedVersion !== rules.version || !Number.isSafeInteger(rules.version) || rules.version < 1) {
    throw new Error("请从已正式发布的赛事详情提交纠错。DSH 发现线索还不是正式赛事规则。");
  }
  return { kind: "event", entityId: eventId, version: rules.version };
}
export function safeCorrectionEvidenceUrl(value: string): string | null {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function makeEventCorrectionInput(eventId: string, currentEvent: PublicEvent, input: { field: string; reason: EventCorrectionReason; message: string; evidenceText: string }): SubmitEventCorrectionDto {
  const target = getFormalEventCorrectionTarget(eventId, currentEvent);
  const field = input.field.trim();
  if (!field || field.length > 120) throw new Error("请填写要纠正的字段，最多 120 字。");
  if (!Object.hasOwn(eventCorrectionReasons, input.reason)) throw new Error("请选择纠错原因。");
  if (!input.message.trim()) throw new Error("请说明哪里有误、你希望核对什么。");
  const message = `原因：${eventCorrectionReasons[input.reason]}\n${input.message.trim()}`;
  if (message.length > 4000) throw new Error("纠错原因与说明合计不能超过 4000 字。");
  const rawUrls = input.evidenceText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (rawUrls.length > 5) throw new Error("最多提供 5 个来源链接，每行一个。");
  const evidenceUrls = rawUrls.map(value => {
    const url = safeCorrectionEvidenceUrl(value);
    if (value.length > 2000 || !url) throw new Error("来源须为不含账号密码的 HTTP(S) 链接。");
    return url;
  });
  return { target, field, message, evidenceUrls: [...new Set(evidenceUrls)] };
}
function parseCorrection(value: unknown): EventCorrectionDto {
  if (!value || typeof value !== "object") throw new Error("纠错结果格式不完整，请刷新后查看。");
  const record = value as EventCorrectionDto;
  if (typeof record.id !== "string" || typeof record.submittedBy !== "string" || !record.original || !validTarget(record.original.target) || typeof record.original.field !== "string" || typeof record.original.message !== "string" || !Array.isArray(record.original.evidenceUrls) || record.original.evidenceUrls.some(url => typeof url !== "string") || typeof record.original.submittedAt !== "string" || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Object.hasOwn(eventCorrectionStatuses, record.status) || typeof record.updatedAt !== "string" || !(record.response === null || typeof record.response === "string") || !(record.relatedVersion === null || validTarget(record.relatedVersion))) {
    throw new Error("纠错结果格式不完整，请刷新后查看。");
  }
  return record;
}
export function ownEventCorrections(records: readonly EventCorrectionDto[], eventId: string, viewerId: string | null): readonly EventCorrectionDto[] {
  if (!viewerId) return [];
  return records.filter(record => record.submittedBy === viewerId && record.original.target.kind === "event" && record.original.target.entityId === eventId);
}
export class EventCorrectionApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) { super(message); this.name = "EventCorrectionApiError"; this.status = status; this.code = code; }
}
/** All GETs read saved M08 state. This adapter never requests a model or changes formal rules. */
export function createEventCorrectionClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const response = await fetcher(`/api/v1${path}`, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
      ...(options.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }) });
    let envelope: { data?: unknown; error?: { message?: string; code?: string } };
    try { envelope = await response.json(); } catch { throw new EventCorrectionApiError("服务没有返回可读取的结果，请刷新后查看。", response.status, "INVALID_RESPONSE"); }
    if (!response.ok || envelope.error) throw new EventCorrectionApiError(envelope.error?.message ?? "读取或提交纠错失败。", response.status, envelope.error?.code ?? "REQUEST_FAILED");
    if (!Object.hasOwn(envelope, "data")) throw new EventCorrectionApiError("服务返回缺少纠错结果。", response.status, "INVALID_RESPONSE");
    return envelope.data;
  }
  return {
    async submit(input: SubmitEventCorrectionDto, signal?: AbortSignal): Promise<EventCorrectionDto> { return parseCorrection(await request("/corrections", { method: "POST", body: input, signal })); },
    async listOwn(signal?: AbortSignal): Promise<readonly EventCorrectionDto[]> {
      const data = await request("/me/corrections?limit=100", { signal });
      if (!Array.isArray(data)) throw new Error("纠错列表格式不完整，请刷新后查看。");
      return data.map(parseCorrection);
    },
    async getOwn(id: string, signal?: AbortSignal): Promise<EventCorrectionDto> { return parseCorrection(await request(`/me/corrections/${encodeURIComponent(id)}`, { signal })); },
  };
}
