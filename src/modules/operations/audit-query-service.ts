import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { auditActions, auditObjectKinds, auditStreams } from "./audit-query-types.ts";
import type { AdminAuditEntry, AuditQueryBoundary, AuditQueryDependencies, AuditQueryFilters, AuditQueryInput, AuditQueryPage } from "./audit-query-types.ts";

const day = 86_400_000;
const invalid = () => new DomainError("INVALID_AUDIT_QUERY", "筛选或游标无效，请重新查询。", { status: 400 });
const token = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
function identifier(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !token.test(value)) throw invalid();
  return value;
}
// M03 public entity IDs may contain Unicode and spaces. Match that business
// contract; SQL remains parameterized and the UI renders IDs as plain text.
function validObjectId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function objectIdentifier(value: unknown): string | null {
  if (value === undefined) return null;
  if (!validObjectId(value)) throw invalid();
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalid();
  return value as T;
}
/** Preserve microseconds for keyset pagination when PostgreSQL returns precision beyond Date. */
export function normalizeAuditInstant(value: string): string {
  if (typeof value !== "string" || !instant.test(value)) throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid();
  const fraction = value.match(/\.(\d+)Z$/)?.[1] ?? "";
  return `${date.toISOString().slice(0, 19)}.${fraction.padEnd(6, "0")}Z`;
}
function micros(value: string): bigint {
  return BigInt(Date.parse(value)) * 1000n + BigInt(value.slice(23, 26));
}
function keyCompare(a: AuditQueryBoundary, b: AuditQueryBoundary): number {
  const time = a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0;
  return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function safeEntry(row: AdminAuditEntry): AdminAuditEntry {
  if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.actorId !== "string" || typeof row.objectId !== "string"
    || !auditStreams.includes(row.stream) || !auditObjectKinds.includes(row.objectKind) || !["user", "worker"].includes(row.actorKind)
    || !token.test(row.id) || !token.test(row.actorId) || !validObjectId(row.objectId) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || (row.contentVersion !== null && (!Number.isSafeInteger(row.contentVersion) || row.contentVersion < 1))) throw new DomainError("AUDIT_PROJECTION_INVALID", "审计记录格式异常，请联系管理员。", { status: 500 });
  return { id: row.id, stream: row.stream, actorKind: row.actorKind, actorId: row.actorId,
    action: auditActions.includes(row.action) ? row.action : "unrecognized", objectKind: row.objectKind, objectId: row.objectId,
    revision: row.revision, contentVersion: row.contentVersion, occurredAt: normalizeAuditInstant(row.occurredAt) };
}
interface Cursor { readonly v: 1; readonly scope: string; readonly filters: AuditQueryFilters; readonly boundary: AuditQueryBoundary; readonly expiresAt: number; }

export function createAuditQueryService(deps: AuditQueryDependencies) {
  if (!(deps.cursorSecret instanceof Uint8Array) || deps.cursorSecret.byteLength < 32) throw new Error("Audit cursor key must contain at least 32 bytes");
  const secret = Buffer.from(deps.cursorSecret);
  const scope = (actor: Actor) => createHash("sha256").update(actor.userId).digest("hex");
  const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  const encode = (cursor: Cursor) => {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${payload}.${mac(payload).toString("base64url")}`;
  };
  function decode(value: string, actor: Actor, now: number): Cursor {
    if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
    const [payload, signature] = value.split(".");
    const signed = Buffer.from(signature, "base64url");
    if (signed.length !== 32 || !timingSafeEqual(signed, mac(payload))) throw invalid();
    let parsed: Cursor;
    try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Cursor; } catch { throw invalid(); }
    if (!parsed || parsed.v !== 1 || parsed.scope !== scope(actor) || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= now
      || !parsed.filters || !parsed.boundary || !token.test(parsed.boundary.id)) throw invalid();
    return parsed;
  }
  return {
    async list(actor: Actor, input: AuditQueryInput = {}): Promise<AuditQueryPage> {
      if (!actor.platformRoles.includes("admin")) throw new DomainError("AUDIT_ADMIN_REQUIRED", "审计查询需要管理员权限。", { status: 403 });
      const now = deps.clock.now().getTime();
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
      const cursor = input.cursor === undefined ? null : decode(input.cursor, actor, now);
      const to = normalizeAuditInstant(input.to ?? cursor?.filters.to ?? new Date(now).toISOString());
      const from = normalizeAuditInstant(input.from ?? cursor?.filters.from ?? new Date(Date.parse(to) - 7 * day).toISOString());
      if (from > to || to > normalizeAuditInstant(new Date(now).toISOString()) || micros(to) - micros(from) > BigInt(31 * day) * 1000n) throw invalid();
      if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw invalid();
      const filters: AuditQueryFilters = { actorId: identifier(input.actorId), action: choice(input.action, auditActions), objectKind: choice(input.objectKind, auditObjectKinds),
        objectId: objectIdentifier(input.objectId), revision: input.revision ?? null, stream: choice(input.stream, auditStreams), from, to };
      if (cursor && JSON.stringify(cursor.filters) !== JSON.stringify(filters)) throw invalid();
      const boundary = cursor ? { id: cursor.boundary.id, occurredAt: normalizeAuditInstant(cursor.boundary.occurredAt) } : null;
      return deps.database.transaction(async tx => {
        await deps.authorization.assertCurrentAdmin(tx, actor);
        const raw = await deps.query.readPage(tx, filters, boundary, limit + 1);
        if (raw.length > limit + 1) throw new DomainError("AUDIT_QUERY_UNBOUNDED", "审计查询超过分页限制。", { status: 500 });
        const rows = raw.map(safeEntry);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row.occurredAt < from || row.occurredAt > to || (boundary && keyCompare(row, boundary) >= 0) || (i > 0 && keyCompare(rows[i - 1], row) <= 0)
            || (filters.actorId !== null && row.actorId !== filters.actorId) || (filters.action !== null && row.action !== filters.action)
            || (filters.objectKind !== null && row.objectKind !== filters.objectKind) || (filters.objectId !== null && row.objectId !== filters.objectId)
            || (filters.revision !== null && row.revision !== filters.revision) || (filters.stream !== null && row.stream !== filters.stream)) {
            throw new DomainError("AUDIT_PROJECTION_INVALID", "审计分页或筛选结果异常。", { status: 500 });
          }
        }
        await deps.authorization.assertCurrentAdmin(tx, actor);
        const items = rows.slice(0, limit);
        const last = items.at(-1);
        const nextCursor = rows.length > limit && last ? encode({ v: 1, scope: scope(actor), filters, boundary: { occurredAt: last.occurredAt, id: last.id }, expiresAt: cursor?.expiresAt ?? now + 15 * 60_000 }) : null;
        return { items, nextCursor, window: { from, to } };
      });
    },
  };
}
export type AuditQueryService = ReturnType<typeof createAuditQueryService>;
