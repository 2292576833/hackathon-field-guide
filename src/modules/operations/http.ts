import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { EventReviewService } from "./event-review-service.ts";
import type { CriticalFieldKey, EventReviewStatus } from "./event-review-types.ts";
import { criticalFieldKeys } from "./event-review-types.ts";

export interface OperationsHttpDependencies {
  /** Resolve a verified website session; never read userId/platformRoles from JSON. */
  readonly resolveActor: (request: Request) => Promise<Actor | null>;
  readonly requestId: (request: Request) => string;
  /** Required composition point for the site's CSRF/session mutation checks. */
  readonly assertMutationAllowed: (request: Request, actor: Actor) => Promise<void>;
  readonly maxBodyBytes?: number;
}
function response(data: unknown, requestId: string, status = 200): Response {
  return Response.json({ data, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}
export async function readOperationsJsonBody(request: Request, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("INVALID_INPUT", "请使用 JSON 提交。", { status: 415 });
  if (!request.body) throw new DomainError("INVALID_INPUT", "请求内容不能为空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "提交内容过大，请缩短文本。", { status: 413 }); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DomainError("INVALID_INPUT", "请求 JSON 格式无效。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DomainError("INVALID_INPUT", "请求须为 JSON 对象。");
  return parsed as Record<string, unknown>;
}
export function requiredString(input: Record<string, unknown>, key: string, maxLength = 1000): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new DomainError("INVALID_INPUT", `${key} 无效。`);
  return value.trim();
}
export function positiveRevision(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new DomainError("INVALID_INPUT", `${key} 须为正整数。`);
  return value;
}
function keys(input: Record<string, unknown>, key: string): readonly CriticalFieldKey[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !criticalFieldKeys.includes(item as CriticalFieldKey))) throw new DomainError("INVALID_INPUT", `${key} 关键字段清单无效。`);
  return value as readonly CriticalFieldKey[];
}

/** Reuse this authenticated envelope for source/resource/correction routes when composing services. */
export function createOperationsHttpHandler(dependencies: OperationsHttpDependencies, options: {
  readonly method: "GET" | "POST" | "PATCH";
  readonly successStatus?: number;
  readonly execute: (actor: Actor, input: Record<string, unknown>, requestId: string, request: Request) => Promise<unknown>;
}): (request: Request) => Promise<Response> {
  const maxBytes = dependencies.maxBodyBytes ?? 128 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("Invalid operations body limit");
  return async request => {
    const requestId = dependencies.requestId(request);
    try {
      if (request.method !== options.method) throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
      const actor = await dependencies.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      if (options.method !== "GET") await dependencies.assertMutationAllowed(request, actor);
      const input = options.method === "GET" ? {} : await readOperationsJsonBody(request, maxBytes);
      return response(await options.execute(actor, input, requestId, request), requestId, options.successStatus ?? 200);
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export function createEventReviewHandlers(dependencies: OperationsHttpDependencies & { readonly service: EventReviewService }) {
  const handler = (method: "GET" | "POST" | "PATCH", execute: (actor: Actor, input: Record<string, unknown>, requestId: string, request: Request) => Promise<unknown>, successStatus?: number) => createOperationsHttpHandler(dependencies, { method, execute, successStatus });
  return {
    list: handler("GET", async (actor, _input, _requestId, request) => {
      const url = new URL(request.url);
      const status = url.searchParams.get("status") ?? undefined;
      const limit = url.searchParams.get("limit");
      return dependencies.service.list(actor, status as EventReviewStatus | undefined, limit === null ? 50 : Number(limit));
    }),
    detail: (reviewId: string) => handler("GET", actor => dependencies.service.getDetail(actor, reviewId)),
    submitManual: handler("POST", (actor, input, requestId) => {
      if (!("content" in input)) throw new DomainError("INVALID_INPUT", "请填写赛事候选内容。");
      const eventId = input.eventId === undefined ? undefined : requiredString(input, "eventId", 256);
      return dependencies.service.submitManual(actor, { eventId, content: input.content }, requestId);
    }, 201),
    registerCandidate: handler("POST", (actor, input, requestId) => dependencies.service.registerCandidate(actor, requiredString(input, "candidateId", 256), requestId), 201),
    revise: (reviewId: string) => handler("PATCH", (actor, input, requestId) => {
      if (!("content" in input)) throw new DomainError("INVALID_INPUT", "请填写修正内容。");
      return dependencies.service.reviseManual(actor, reviewId, { expectedRevision: positiveRevision(input, "expectedRevision"), expectedCandidateRevision: positiveRevision(input, "expectedCandidateRevision"), content: input.content, reason: requiredString(input, "reason") }, requestId);
    }),
    refresh: (reviewId: string) => handler("POST", (actor, input, requestId) => dependencies.service.refreshCandidate(actor, reviewId, {
      expectedRevision: positiveRevision(input, "expectedRevision"), expectedCandidateRevision: positiveRevision(input, "expectedCandidateRevision"), reason: requiredString(input, "reason"),
    }, requestId)),
    approve: (reviewId: string) => handler("POST", (actor, input, requestId) => dependencies.service.approve(actor, reviewId, {
      expectedRevision: positiveRevision(input, "expectedRevision"), expectedCandidateRevision: positiveRevision(input, "expectedCandidateRevision"), checkedKeys: keys(input, "checkedKeys"), acknowledgedUnknownKeys: keys(input, "acknowledgedUnknownKeys"), reason: requiredString(input, "reason"),
    }, requestId)),
    decide: (reviewId: string) => handler("POST", (actor, input, requestId) => {
      if (input.decision !== "changes_requested" && input.decision !== "rejected") throw new DomainError("INVALID_INPUT", "审核决定无效。");
      return dependencies.service.decide(actor, reviewId, { expectedRevision: positiveRevision(input, "expectedRevision"), expectedCandidateRevision: positiveRevision(input, "expectedCandidateRevision"), decision: input.decision, reason: requiredString(input, "reason") }, requestId);
    }),
    publish: (reviewId: string) => handler("POST", (actor, input, requestId) => dependencies.service.publish(actor, reviewId, {
      expectedRevision: positiveRevision(input, "expectedRevision"), expectedCandidateRevision: positiveRevision(input, "expectedCandidateRevision"), expectedPublishedVersion: input.expectedPublishedVersion === null ? null : positiveRevision(input, "expectedPublishedVersion"), reason: requiredString(input, "reason"),
    }, requestId)),
    withdraw: (eventId: string) => handler("POST", (actor, input, requestId) => dependencies.service.withdraw(actor, { eventId, expectedPublishedVersion: positiveRevision(input, "expectedPublishedVersion"), reason: requiredString(input, "reason") }, requestId)),
  };
}
