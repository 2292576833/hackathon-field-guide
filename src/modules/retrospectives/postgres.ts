import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AuditEvent, Document, DocumentTransaction, RetrospectiveRepository } from "./domain.ts";

const kinds: readonly Document["kind"][] = ["retrospective", "experience_card", "reuse_draft", "generation_job"];
const auditTypes: readonly AuditEvent["type"][] = ["RetrospectiveConfirmed", "ExperienceCardConfirmed", "ExperienceCardVisibilityChanged", "ExperienceReused", "DocumentEdited", "PersonalDocumentDeleted", "GenerationUpdated"];
type BodyRow = { body: Document | string };

function invalid(message: string): never { throw new DomainError("INVALID_INPUT", message); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) invalid("请提供有效的记录标识。");
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("请提供有效的记录版本。");
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid("记录时间需要有效日期与时区。");
}
function validateDocument(document: Document): void {
  identifier(document.id); identifier(document.projectId); identifier(document.ownerId);
  revision(document.revision); timestamp(document.createdAt); timestamp(document.updatedAt);
  if (!kinds.includes(document.kind) || !["personal", "project"].includes(document.scope)) invalid("记录类型或可见范围无效。");
  if (document.kind === "reuse_draft" && document.scope !== "personal") invalid("复用草稿必须仅本人可见。");
  if (Date.parse(document.updatedAt) < Date.parse(document.createdAt)) invalid("记录更新时间不能早于创建时间。");
}
function validateEvent(event: AuditEvent, document: Pick<Document, "id" | "projectId" | "revision">): void {
  identifier(event.id); identifier(event.actorId); timestamp(event.occurredAt); revision(event.revision);
  if (!auditTypes.includes(event.type) || event.aggregateId !== document.id || event.projectId !== document.projectId || event.revision !== document.revision) invalid("审计事件必须对应本次记录和版本。");
}
function notFound(): never { throw new DomainError("NOT_FOUND", "记录不存在或当前不可操作。", { status: 404 }); }
function conflict(latestRevision?: number): never {
  throw new DomainError("VERSION_CONFLICT", "记录已更新，请对照最新版本后再保存。", { status: 409, recoveryAction: "review_latest_version", ...(latestRevision !== undefined ? { latestRevision } : {}) });
}
function decode(row: BodyRow | undefined): Document | null {
  if (!row) return null;
  // pg normally decodes JSONB. Other DatabasePort implementations may return JSON text.
  return typeof row.body === "string" ? JSON.parse(row.body) as Document : structuredClone(row.body);
}

/** A transaction-scoped adapter. The database must roll back every thrown error. */
class PostgresDocumentTransaction implements DocumentTransaction {
  readonly sql: SqlExecutor;
  private readonly executor: SqlExecutor;
  private readonly locking: boolean;
  constructor(executor: SqlExecutor, locking: boolean) { this.executor = executor; this.sql = executor; this.locking = locking; }

  async get(id: string): Promise<Document | null> {
    identifier(id);
    const result = await this.executor.query<BodyRow>(`SELECT body FROM m07_documents WHERE id = $1${this.locking ? " FOR UPDATE" : ""}`, [id]);
    return decode(result.rows[0]);
  }

  async getVersion(id: string, version: number): Promise<Document | null> {
    identifier(id); revision(version);
    const result = await this.executor.query<BodyRow>("SELECT body FROM m07_document_versions WHERE document_id = $1 AND revision = $2", [id, version]);
    return decode(result.rows[0]);
  }

  async insert(document: Document, event: AuditEvent): Promise<void> {
    validateDocument(document); validateEvent(event, document);
    if (document.revision !== 1) invalid("新记录必须从第 1 版开始。");
    const result = await this.executor.query(
      `INSERT INTO m07_documents (id, kind, project_id, owner_id, scope, revision, created_at, updated_at, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [document.id, document.kind, document.projectId, document.ownerId, document.scope, document.revision, document.createdAt, document.updatedAt, JSON.stringify(document)],
    );
    if (result.rowCount !== 1) {
      const current = await this.get(document.id);
      conflict(current?.revision);
    }
    await this.snapshot(document);
    await this.audit(event);
  }

  async replace(document: Document, expectedRevision: number, event: AuditEvent): Promise<void> {
    validateDocument(document); revision(expectedRevision); validateEvent(event, document);
    if (document.revision !== expectedRevision + 1) invalid("更新记录必须只递增一个版本。");
    const current = await this.get(document.id);
    if (!current) notFound();
    if (current.revision !== expectedRevision) conflict(current.revision);
    if (current.kind !== document.kind || current.projectId !== document.projectId || current.ownerId !== document.ownerId || current.createdAt !== document.createdAt) invalid("记录类型、归属项目、创建人和创建时间不能修改。");
    const result = await this.executor.query(
      `UPDATE m07_documents SET scope = $3, revision = $4, updated_at = $5::timestamptz, body = $6::jsonb
       WHERE id = $1 AND revision = $2 RETURNING id`,
      [document.id, expectedRevision, document.scope, document.revision, document.updatedAt, JSON.stringify(document)],
    );
    if (result.rowCount !== 1) {
      const latest = await this.get(document.id);
      if (!latest) notFound();
      conflict(latest.revision);
    }
    await this.snapshot(document);
    await this.audit(event);
  }

  async deletePersonal(id: string, ownerId: string, expectedRevision: number, event: AuditEvent): Promise<void> {
    identifier(id); identifier(ownerId); revision(expectedRevision);
    // Filter before reading a version so foreign/shared records disclose no metadata.
    const rows = await this.executor.query<BodyRow>(
      `SELECT body FROM m07_documents WHERE id = $1 AND owner_id = $2 AND scope = 'personal'
       AND kind IN ('retrospective', 'experience_card', 'reuse_draft') FOR UPDATE`, [id, ownerId],
    );
    const current = decode(rows.rows[0]);
    if (!current) notFound();
    if (current.revision !== expectedRevision) conflict(current.revision);
    validateEvent(event, current);
    if (event.type !== "PersonalDocumentDeleted" || event.actorId !== ownerId) invalid("个人删除事件必须由记录所有者发起。");
    // ON DELETE CASCADE removes every body snapshot; the metadata-only audit stays.
    const result = await this.executor.query(
      `DELETE FROM m07_documents WHERE id = $1 AND owner_id = $2 AND scope = 'personal'
       AND kind IN ('retrospective', 'experience_card', 'reuse_draft') AND revision = $3 RETURNING id`,
      [id, ownerId, expectedRevision],
    );
    if (result.rowCount !== 1) conflict();
    await this.audit(event);
  }

  private async snapshot(document: Document): Promise<void> {
    // Never upsert: an existing (id, revision) snapshot must not be overwritten.
    await this.executor.query(
      "INSERT INTO m07_document_versions (document_id, revision, body, recorded_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz)",
      [document.id, document.revision, JSON.stringify(document), document.updatedAt],
    );
  }

  private async audit(event: AuditEvent): Promise<void> {
    await this.executor.query(
      `INSERT INTO m07_audit_events (id, type, aggregate_id, project_id, actor_id, revision, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [event.id, event.type, event.aggregateId, event.projectId, event.actorId, event.revision, event.occurredAt],
    );
  }
}

/** Membership and personal visibility are checked by the service on every read. */
export class PostgresRetrospectiveRepository implements RetrospectiveRepository {
  private readonly database: DatabasePort;
  private readonly reader: PostgresDocumentTransaction;
  constructor(database: DatabasePort) { this.database = database; this.reader = new PostgresDocumentTransaction(database, false); }

  get(id: string): Promise<Document | null> { return this.reader.get(id); }
  getVersion(id: string, version: number): Promise<Document | null> { return this.reader.getVersion(id, version); }
  insert(document: Document, event: AuditEvent): Promise<void> { return this.transaction(transaction => transaction.insert(document, event)); }
  replace(document: Document, expectedRevision: number, event: AuditEvent): Promise<void> { return this.transaction(transaction => transaction.replace(document, expectedRevision, event)); }
  deletePersonal(id: string, ownerId: string, expectedRevision: number, event: AuditEvent): Promise<void> { return this.transaction(transaction => transaction.deletePersonal(id, ownerId, expectedRevision, event)); }
  transaction<T>(work: (transaction: DocumentTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(executor => work(new PostgresDocumentTransaction(executor, true)));
  }

  async list(input: Parameters<RetrospectiveRepository["list"]>[0]): Promise<Document[]> {
    identifier(input.ownerId);
    if (input.projectId !== undefined) identifier(input.projectId);
    if (input.afterId !== undefined) identifier(input.afterId);
    if (input.personalOnly !== undefined && typeof input.personalOnly !== "boolean") invalid("私人列表筛选无效。");
    // The service admits at most 100 visible items and asks for one extra cursor row.
    if (!kinds.includes(input.kind) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) invalid("列表类型无效，或内部查询数量不在 1 至 101 之间。");
    const result = await this.database.query<BodyRow>(
      `SELECT body FROM m07_documents WHERE kind = $3
       AND ${input.personalOnly ? "(scope = 'personal' AND owner_id = $1)" : "((scope = 'personal' AND owner_id = $1) OR ($2::text IS NOT NULL AND scope = 'project' AND project_id = $2))"}
       AND ($2::text IS NULL OR project_id = $2)
       AND ($4::text IS NULL OR id COLLATE "C" > $4 COLLATE "C")
       ORDER BY id COLLATE "C" ASC LIMIT $5`,
      [input.ownerId, input.projectId ?? null, input.kind, input.afterId ?? null, input.limit],
    );
    return result.rows.map(row => decode(row)!);
  }
}
