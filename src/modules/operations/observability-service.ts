import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ExecutionKind, ExecutionStatus, FailureCategory } from "./run-domain.ts";
import { OBSERVABILITY_FAILURE_CATEGORIES, OBSERVABILITY_MAX_PAGE_SIZE, OBSERVABILITY_MAX_WINDOW_MS } from "./observability-types.ts";
import type { ObservabilityFailureCategory, ObservabilityRun, ObservabilityRunRecord, OperationsObservabilityDependencies, SourceObservabilityInput, SourceObservabilityQuery, SourceObservabilityReport, SourceRuntimeObservation } from "./observability-types.ts";

const statuses = ["queued", "running", "review_ready", "succeeded", "failed", "cancelled"] as const;
const steps = ["queued", "fetching", "normalizing", "extracting", "validating", "complete"] as const;
const sourceStatuses = ["proposed", "verifying", "enabled", "rejected", "paused", "degraded"] as const;
const invalid = (): never => { throw new DomainError("INVALID_OBSERVABILITY_QUERY", "查询范围、筛选或游标无效；每页最多 100 条，窗口最多 31 天。"); };
const invalidRecord = (): never => { throw new DomainError("OBSERVABILITY_DATA_INVALID", "运行摘要暂时不可用，请稍后重试。", { status: 503 }); };
function id(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : invalid();
}
function time(value: unknown, fail = invalid): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return fail();
  const result = new Date(value).toISOString();
  // Reject normalized invalid calendar dates such as 2026-02-31.
  if (result.slice(0, 19) !== value.slice(0, 19)) return fail();
  const fraction = value.includes(".") ? value.slice(20, -1) : "";
  return `${value.slice(0, 19)}.${fraction.padEnd(6, "0")}Z`;
}
// PostgreSQL timestamps retain microseconds; Date is used only for millisecond
// duration displays, never for pagination/window ordering.
const microseconds = (value: string): bigint => BigInt(Date.parse(value)) * 1000n + BigInt(value.slice(23, 26));
const nullableTime = (value: string | null): string | null => value === null ? null : time(value, invalidRecord);
const nonnegative = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalidRecord();
const count = (value: unknown): string => typeof value === "string" && /^(?:0|[1-9]\d{0,39})$/.test(value) ? value : invalidRecord();
function category(value: string): ObservabilityFailureCategory { return OBSERVABILITY_FAILURE_CATEGORIES.includes(value as FailureCategory) ? value as FailureCategory : "unknown"; }
export function observabilityFailureCode(value: string): string { const safe = category(value); return safe === "unknown" ? "SOURCE_FAILURE_UNKNOWN" : `SOURCE_${safe.toUpperCase()}`; }
const elapsed = (start: string | null, end: string | null): number | null => start === null || end === null || Date.parse(end) < Date.parse(start) ? null : Date.parse(end) - Date.parse(start);

interface CursorPayload {
  readonly v: 1;
  readonly actor: string;
  readonly issuedAt: string;
  readonly query: Omit<SourceObservabilityQuery, "limit">;
}
export function createOperationsObservabilityService(deps: OperationsObservabilityDependencies) {
  if (typeof deps.cursorSecret !== "string" || Buffer.byteLength(deps.cursorSecret) < 32 || Buffer.byteLength(deps.cursorSecret) > 4096) throw new DomainError("OBSERVABILITY_CONFIG_INVALID", "管理员查询游标签名未配置。", { status: 503 });
  const signature = (value: string) => createHmac("sha256", deps.cursorSecret).update(value).digest();
  const actorHash = (actor: Actor) => createHash("sha256").update(actor.userId).digest("hex");
  function decode(value: string, actor: Actor, now: Date): CursorPayload {
    if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return invalid();
    const [body, supplied] = value.split(".");
    const actual = Buffer.from(supplied!, "base64url");
    const expected = signature(body!);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid();
    let payload: CursorPayload;
    try { payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as CursorPayload; } catch { return invalid(); }
    if (!payload || payload.v !== 1 || payload.actor !== actorHash(actor) || !payload.query || !payload.query.before) return invalid();
    const issuedAt = time(payload.issuedAt);
    const age = now.getTime() - Date.parse(issuedAt);
    if (age < 0 || age > 30 * 60_000) return invalid();
    return { ...payload, query: { ...payload.query, before: { createdAt: time(payload.query.before.createdAt), id: id(payload.query.before.id) } } };
  }
  function query(input: SourceObservabilityInput, actor: Actor, now: Date): { query: SourceObservabilityQuery; issuedAt: string } {
    const cursor = input.cursor === undefined ? null : decode(input.cursor, actor, now);
    const base = cursor?.query;
    const sourceId = id(input.sourceId);
    const until = time(input.until ?? base?.until ?? now.toISOString());
    const defaultSince = time(new Date(Date.parse(until) - 7 * 86_400_000).toISOString()).slice(0, 23) + until.slice(23);
    const since = time(input.since ?? base?.since ?? defaultSince);
    const kind = input.kind ?? base?.kind ?? null;
    const status = input.status ?? base?.status ?? null;
    const failureCategory = input.failureCategory ?? base?.failureCategory ?? null;
    const limit = input.limit ?? 50;
    if (until > time(now.toISOString()) || until <= since || microseconds(until) - microseconds(since) > BigInt(OBSERVABILITY_MAX_WINDOW_MS) * 1000n ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > OBSERVABILITY_MAX_PAGE_SIZE ||
        (kind !== null && !["crawl", "analysis"].includes(kind)) ||
        (status !== null && !statuses.includes(status)) ||
        (failureCategory !== null && !OBSERVABILITY_FAILURE_CATEGORIES.includes(failureCategory))) return invalid();
    if (base && (base.sourceId !== sourceId || base.since !== since || base.until !== until || base.kind !== kind || base.status !== status || base.failureCategory !== failureCategory)) return invalid();
    return { query: { sourceId, since, until, kind: kind as ExecutionKind | null, status: status as ExecutionStatus | null, failureCategory, limit, before: base?.before ?? null }, issuedAt: cursor?.issuedAt ?? now.toISOString() };
  }
  function run(record: ObservabilityRunRecord, observedAt: string): ObservabilityRun {
    if (!record || !statuses.includes(record.status) || !["crawl", "analysis"].includes(record.kind) || !steps.includes(record.step) || !Number.isSafeInteger(record.revision) || record.revision < 1) return invalidRecord();
    const createdAt = time(record.createdAt, invalidRecord);
    const availableAt = time(record.availableAt, invalidRecord);
    const firstStartedAt = nullableTime(record.firstStartedAt);
    const lastAttemptAt = nullableTime(record.lastAttemptAt);
    const finishedAt = nullableTime(record.finishedAt);
    const attempt = nonnegative(record.attempt);
    const latestFailure = record.latestFailure === null ? null : {
      category: category(record.latestFailure.category), code: observabilityFailureCode(record.latestFailure.category),
      occurredAt: time(record.latestFailure.occurredAt, invalidRecord), attempt: nonnegative(record.latestFailure.attempt),
    };
    const end = finishedAt ?? (record.status === "running" ? observedAt : latestFailure?.attempt === attempt ? latestFailure.occurredAt : null);
    const latestAttemptDurationMs = elapsed(lastAttemptAt, end);
    return { id: id(record.id), revision: record.revision, kind: record.kind, status: record.status, step: record.step, attempt, createdAt, availableAt, firstStartedAt, lastAttemptAt, finishedAt, latestFailure,
      initialQueueWaitMs: elapsed(createdAt, firstStartedAt), queuedAgeMs: record.status === "queued" ? elapsed(createdAt, observedAt) : null,
      eligibleQueueWaitMs: record.status === "queued" ? Math.max(0, Date.parse(observedAt) - Date.parse(availableAt)) : null,
      latestAttemptDurationMs, durationBasis: latestAttemptDurationMs === null ? "unavailable" : finishedAt !== null ? "finished" : record.status === "running" ? "running_elapsed" : "latest_failure" };
  }
  function runtime(value: SourceRuntimeObservation | null, observedAt: string): SourceRuntimeObservation | null {
    if (value === null) return null;
    const measuredAt = time(value.measuredAt, invalidRecord);
    if (Date.parse(measuredAt) > Date.parse(observedAt)) return invalidRecord();
    let worker: SourceRuntimeObservation["worker"] = null;
    if (value.worker !== null) {
      if (!["all_sources", "source"].includes(value.worker.scope) || !["not_started", "idle", "running", "failed", "stopped", "stale"].includes(value.worker.status)) return invalidRecord();
      worker = { scope: value.worker.scope, status: value.worker.status, lastSeenAt: nullableTime(value.worker.lastSeenAt) };
    }
    let model: SourceRuntimeObservation["model"] = null;
    if (value.model !== null) {
      if (!/^\d{4}-\d\d-\d\d$/.test(value.model.quotaDay) || value.model.quotaTimezone !== "UTC" || !["allowed", "limited", "unknown_request", "not_configured"].includes(value.model.admission)) return invalidRecord();
      model = { quotaDay: value.model.quotaDay, quotaTimezone: "UTC", calls: nonnegative(value.model.calls), pendingReservations: nonnegative(value.model.pendingReservations), unknownRequests: nonnegative(value.model.unknownRequests),
        completeCostMicroUsd: value.model.completeCostMicroUsd === null ? null : count(value.model.completeCostMicroUsd), reservedMicroUsd: value.model.reservedMicroUsd === null ? null : count(value.model.reservedMicroUsd), admission: value.model.admission };
    }
    return { measuredAt, worker, model };
  }
  return {
    async source(actor: Actor, input: SourceObservabilityInput): Promise<SourceObservabilityReport> {
      // Early role denial avoids touching even source existence for ordinary users.
      if (!actor.platformRoles.includes("admin")) throw new DomainError("OPERATIONS_OBSERVABILITY_FORBIDDEN", "运行故障查询需要管理员权限。", { status: 403 });
      const started = deps.clock.now();
      const normalized = query(input, actor, started);
      return deps.repository.database.transaction(async sql => {
        await deps.authorization.assertCurrentAdmin(actor, sql);
        const record = await deps.repository.read(sql, normalized.query);
        const observedAt = time(deps.clock.now().toISOString());
        if (!record) throw new DomainError("SOURCE_NOT_FOUND", "未找到来源配置。", { status: 404 });
        if (record.source.id !== normalized.query.sourceId || !sourceStatuses.includes(record.source.status) || !Number.isSafeInteger(record.source.revision) || record.source.revision < 1 || record.runs.length > normalized.query.limit + 1) return invalidRecord();
        const runs = record.runs.map(item => run(item, observedAt));
        for (let i = 0; i < runs.length; i++) {
          const row = runs[i]!;
          const prior = runs[i - 1] ?? normalized.query.before;
          if (row.createdAt < normalized.query.since || row.createdAt >= normalized.query.until ||
              (prior && (row.createdAt > prior.createdAt || (row.createdAt === prior.createdAt && row.id >= prior.id))) ||
              (normalized.query.kind && row.kind !== normalized.query.kind) || (normalized.query.status && row.status !== normalized.query.status) ||
              (normalized.query.failureCategory && row.latestFailure?.category !== normalized.query.failureCategory)) return invalidRecord();
        }
        const page = runs.slice(0, normalized.query.limit);
        const last = page.at(-1);
        let nextCursor: string | null = null;
        if (runs.length > page.length && last) {
          const { limit: _limit, ...scope } = normalized.query;
          const payload: CursorPayload = { v: 1, actor: actorHash(actor), issuedAt: normalized.issuedAt, query: { ...scope, before: { createdAt: last.createdAt, id: last.id } } };
          const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
          nextCursor = `${body}.${signature(body).toString("base64url")}`;
        }
        const counts = record.counts.map(item => { if (!statuses.includes(item.status)) return invalidRecord(); return { status: item.status, count: count(item.count) }; });
        const failureCounts = new Map<ObservabilityFailureCategory, bigint>();
        for (const item of record.failures) { const safe = category(item.category); failureCounts.set(safe, (failureCounts.get(safe) ?? 0n) + BigInt(count(item.count))); }
        const failures = [...failureCounts].map(([safe, total]) => ({ category: safe, code: observabilityFailureCode(safe), count: total.toString() }));
        const runtimeData = deps.runtime ? await deps.runtime.readSourceRuntime({ sourceId: normalized.query.sourceId, observedAt }, sql) : null;
        const safeRuntime = runtime(runtimeData, deps.clock.now().toISOString());
        await deps.authorization.assertCurrentAdmin(actor, sql);
        return { observedAt, window: { since: normalized.query.since, until: normalized.query.until, basis: "run_created_at" }, source: {
          id: normalized.query.sourceId, revision: record.source.revision, status: record.source.status, nextEligibleAt: nullableTime(record.source.nextEligibleAt), lastSuccessAt: nullableTime(record.source.lastSuccessAt), lastFailureAt: nullableTime(record.source.lastFailureAt), consecutiveCrawlFailures: nonnegative(record.source.consecutiveCrawlFailures),
        }, counts, failures, runs: page, nextCursor, runtime: safeRuntime };
      });
    },
  };
}

export type OperationsObservabilityService = ReturnType<typeof createOperationsObservabilityService>;
