import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import { createOperationsHttpHandler, positiveRevision, readOperationsJsonBody, requiredString } from "./http.ts";
import type { OperationsHttpDependencies } from "./http.ts";
import type { SourceService } from "./source-service.ts";
import type { SourceDraft, SourceStatus, SourceVerification } from "./source-domain.ts";
import type { NetworkPolicy } from "./network-policy.ts";
import type { RunService, WorkerRunService } from "./run-service.ts";
import type { ExecutionStep, FailureCategory } from "./run-domain.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "配置须为 JSON 对象。");
  return value as Record<string, unknown>;
}
function number(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DomainError("INVALID_INPUT", `${key} 须为整数。`);
  return value;
}
function strings(input: Record<string, unknown>, key: string): readonly string[] {
  const values = input[key];
  if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== "string")) throw new DomainError("INVALID_INPUT", `${key} 须为文字列表。`);
  return values as readonly string[];
}
function policy(value: unknown): NetworkPolicy {
  const input = object(value);
  if (!Array.isArray(input.rules) || input.rules.length > 20) throw new DomainError("INVALID_INPUT", "请设置来源网络规则。");
  return { version: positiveRevision(input, "version"), rules: input.rules.map(rule => {
    const row = object(rule); return { hostname: requiredString(row, "hostname", 253), pathPrefix: requiredString(row, "pathPrefix", 2048) };
  }), maxRedirects: number(input, "maxRedirects"), maxBytes: positiveRevision(input, "maxBytes"), timeoutMs: positiveRevision(input, "timeoutMs"), acceptedContentTypes: strings(input, "acceptedContentTypes") };
}
function draft(value: unknown): SourceDraft {
  const input = object(value);
  if (input.type !== "official_event" && input.type !== "official_rules") throw new DomainError("INVALID_INPUT", "来源类型无效。");
  if (input.acquisitionMethod !== "restricted_http" && input.acquisitionMethod !== "isolated_adapter") throw new DomainError("INVALID_INPUT", "获取方式无效。");
  return { name: requiredString(input, "name", 120), ownerUserId: requiredString(input, "ownerUserId", 120), type: input.type, acquisitionMethod: input.acquisitionMethod,
    sampleUrl: requiredString(input, "sampleUrl", 2048), networkPolicy: policy(input.networkPolicy), minimumIntervalSeconds: input.minimumIntervalSeconds === undefined ? undefined : positiveRevision(input, "minimumIntervalSeconds") };
}
function verification(value: unknown): Omit<SourceVerification, "verifiedBy" | "verifiedAt"> {
  const input = object(value);
  return { termsUrl: requiredString(input, "termsUrl", 2048), allowedUses: strings(input, "allowedUses"), minimumRetainedFields: strings(input, "minimumRetainedFields"), notes: requiredString(input, "notes", 1000) };
}
function pageLimit(request: Request): number {
  const value = new URL(request.url).searchParams.get("limit"); return value === null ? 50 : Number(value);
}

export function createExecutionAdminHandlers(dependencies: OperationsHttpDependencies & { readonly sources: SourceService; readonly runs: RunService }) {
  const handler = (method: "GET" | "POST" | "PATCH", execute: (actor: Actor, input: Record<string, unknown>, requestId: string, request: Request) => Promise<unknown>, successStatus?: number) => createOperationsHttpHandler(dependencies, { method, execute, successStatus });
  return {
    listSources: handler("GET", (actor, _input, _id, request) => dependencies.sources.list(actor, pageLimit(request))),
    source: (id: string) => handler("GET", actor => dependencies.sources.get(actor, id)),
    createSource: handler("POST", (actor, input) => dependencies.sources.create(actor, draft(input)), 201),
    reviseSource: (id: string) => handler("PATCH", (actor, input) => dependencies.sources.revise(actor, id, { expectedRevision: positiveRevision(input, "expectedRevision"), reason: requiredString(input, "reason"), config: draft(input.config) })),
    transitionSource: (id: string) => handler("POST", (actor, input) => {
      if (typeof input.status !== "string" || !["proposed", "verifying", "enabled", "rejected", "paused", "degraded"].includes(input.status)) throw new DomainError("INVALID_INPUT", "来源状态无效。");
      return dependencies.sources.transition(actor, id, { expectedRevision: positiveRevision(input, "expectedRevision"), status: input.status as SourceStatus, reason: requiredString(input, "reason"), verification: input.verification === undefined ? undefined : verification(input.verification) });
    }),
    enqueueCrawl: (sourceConfigId: string) => handler("POST", (actor, input, requestId) => dependencies.runs.enqueueCrawl(actor, {
      sourceConfigId, expectedSourceRevision: positiveRevision(input, "expectedSourceRevision"), targetUrl: requiredString(input, "targetUrl", 2048), adapterVersion: requiredString(input, "adapterVersion", 120),
      idempotencyKey: requiredString(input, "idempotencyKey", 120), retryOf: input.retryOf === undefined ? undefined : requiredString(input, "retryOf", 200), trigger: "manual",
      maxAttempts: input.maxAttempts === undefined ? undefined : positiveRevision(input, "maxAttempts"), timeoutMs: input.timeoutMs === undefined ? undefined : positiveRevision(input, "timeoutMs"), requestId,
    }), 202),
    enqueueAnalysis: handler("POST", (actor, input, requestId) => dependencies.runs.enqueueAnalysis(actor, {
      crawlRunId: requiredString(input, "crawlRunId", 200), inputHash: requiredString(input, "inputHash", 200), schemaVersion: requiredString(input, "schemaVersion", 120), modelVersion: requiredString(input, "modelVersion", 120), promptVersion: requiredString(input, "promptVersion", 120),
      idempotencyKey: requiredString(input, "idempotencyKey", 120), retryOf: input.retryOf === undefined ? undefined : requiredString(input, "retryOf", 200),
      maxAttempts: input.maxAttempts === undefined ? undefined : positiveRevision(input, "maxAttempts"), timeoutMs: input.timeoutMs === undefined ? undefined : positiveRevision(input, "timeoutMs"), requestId,
    }), 202),
    listRuns: handler("GET", (actor, _input, _id, request) => dependencies.runs.list(actor, pageLimit(request))),
    run: (id: string) => handler("GET", actor => dependencies.runs.get(actor, id)),
    cancel: (id: string) => handler("POST", (actor, input) => dependencies.runs.cancel(actor, id, { expectedRevision: positiveRevision(input, "expectedRevision"), reason: requiredString(input, "reason") })),
    reclaimExpired: handler("POST", (actor, input) => dependencies.runs.reclaimExpired(actor, input.limit === undefined ? 50 : positiveRevision(input, "limit"))),
  };
}

export interface WorkerExecutionHttpDependencies {
  readonly service: WorkerRunService;
  /** Separate bearer/service identity, never a website Actor or JSON credential. */
  readonly resolveServiceCredential: (request: Request) => Promise<string | null>;
  readonly requestId: (request: Request) => string;
}
/** No publish/withdraw/configuration methods exist on the worker factory. */
export function createWorkerExecutionHandlers(dependencies: WorkerExecutionHttpDependencies) {
  const handler = (execute: (credential: string, input: Record<string, unknown>) => Promise<unknown>) => async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestId(request);
    try {
      if (request.method !== "POST") throw new DomainError("METHOD_NOT_ALLOWED", "请求方法不支持。", { status: 405 });
      const credential = await dependencies.resolveServiceCredential(request);
      if (!credential) throw new DomainError("WORKER_UNAUTHENTICATED", "采集服务身份无效。", { status: 401 });
      const input = await readOperationsJsonBody(request);
      return Response.json({ data: await execute(credential, input), requestId }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
  const lease = (runId: string, input: Record<string, unknown>) => ({ runId, expectedRevision: positiveRevision(input, "expectedRevision"), leaseToken: requiredString(input, "leaseToken", 200) });
  return {
    claim: (runId: string) => handler(credential => dependencies.service.claim(credential, runId)),
    advance: (runId: string) => handler(async (credential, input) => {
      if (typeof input.step !== "string" || !["fetching", "normalizing", "extracting", "validating"].includes(input.step)) throw new DomainError("INVALID_INPUT", "执行步骤无效。");
      return dependencies.service.advance(credential, { ...lease(runId, input), step: input.step as ExecutionStep });
    }),
    fail: (runId: string) => handler((credential, input) => dependencies.service.fail(credential, {
      ...lease(runId, input), category: requiredString(input, "category", 50) as FailureCategory, retryAfterSeconds: input.retryAfterSeconds === undefined ? undefined : number(input, "retryAfterSeconds"),
    })),
    complete: (runId: string) => handler((credential, input) => dependencies.service.complete(credential, { ...lease(runId, input), resultRef: requiredString(input, "resultRef", 200) })),
  };
}
