import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EditDraftFilter, EditDraftKey, EditDraftMutationReceipt, EditDraftRepository, EditDraftTransaction, RetrospectiveEditDraft } from "./edit-drafts.ts";
import { editDraftConflict, editDraftDocumentId, editDraftRevision, validateEditDraftContent } from "./edit-drafts.ts";
import * as v from "./validation.ts";

type BodyRow = { body: RetrospectiveEditDraft | string };
type ReceiptRow = { payload_hash: string; draft_id: string | null; accepted_revision: string | number | null };
function keyParts(key: EditDraftKey): [string, string, string] { return [v.identifier(key.ownerId), v.identifier(key.projectId), editDraftDocumentId(key.documentId) ?? ""]; }
function validateDraft(value: unknown): RetrospectiveEditDraft {
  const data = v.object(value, ["kind", "id", "ownerId", "projectId", "documentId", "baseDocumentRevision", "visibility", "requestedScope", "draftContent", "revision", "createdAt", "updatedAt"]);
  if (data.kind !== "retrospective_edit_draft" || data.visibility !== "personal") v.invalid("编辑草稿必须为本人私有。");
  const documentId = editDraftDocumentId(data.documentId), baseDocumentRevision = editDraftRevision(data.baseDocumentRevision, true);
  if ((documentId === null) !== (baseDocumentRevision === 0)) v.invalid("编辑草稿的正式复盘基线无效。");
  const createdAt = v.instant(data.createdAt), updatedAt = v.instant(data.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) v.invalid("草稿更新时间不能早于创建时间。");
  return { kind: "retrospective_edit_draft", id: v.identifier(data.id), ownerId: v.identifier(data.ownerId), projectId: v.identifier(data.projectId), documentId, baseDocumentRevision, visibility: "personal", requestedScope: v.scope(data.requestedScope), draftContent: validateEditDraftContent(data.draftContent), revision: editDraftRevision(data.revision), createdAt, updatedAt };
}
function decode(row: BodyRow | undefined): RetrospectiveEditDraft | null { return row ? validateDraft(typeof row.body === "string" ? JSON.parse(row.body) : row.body) : null; }
function notFound(): never { throw new DomainError("NOT_FOUND", "草稿不存在或不属于当前账号。", { status: 404 }); }
function unavailable(): never { throw new DomainError("EDIT_DRAFT_STORAGE_INVALID", "草稿存储暂时不可用，当前输入仍保留。", { status: 503 }); }

class PostgresEditDraftTransaction implements EditDraftTransaction {
  readonly sql: SqlExecutor;
  constructor(sql: SqlExecutor) { this.sql = sql; }
  async get(key: EditDraftKey): Promise<RetrospectiveEditDraft | null> {
    const rows = await this.sql.query<BodyRow>("SELECT body FROM m07_edit_drafts WHERE owner_id = $1 AND project_id = $2 AND document_key = $3", keyParts(key));
    return decode(rows.rows[0]);
  }
  async getById(id: string, ownerId: string): Promise<RetrospectiveEditDraft | null> {
    const rows = await this.sql.query<BodyRow>("SELECT body FROM m07_edit_drafts WHERE id = $1 AND owner_id = $2", [v.identifier(id), v.identifier(ownerId)]);
    return decode(rows.rows[0]);
  }
  async claimMutation(ownerId: string, mutationId: string, payloadHash: string): Promise<EditDraftMutationReceipt> {
    const keys = [v.identifier(ownerId), v.identifier(mutationId)];
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) v.invalid("草稿保存指纹无效。");
    // A reserved key and its completed receipt share the same transaction.
    // The unique key also serializes identical mutation IDs across draft roots.
    await this.sql.query("INSERT INTO m07_edit_draft_mutations (owner_id, mutation_id, payload_hash) VALUES ($1, $2, $3) ON CONFLICT (owner_id, mutation_id) DO NOTHING", [...keys, payloadHash]);
    const result = await this.sql.query<ReceiptRow>("SELECT payload_hash, draft_id, accepted_revision FROM m07_edit_draft_mutations WHERE owner_id = $1 AND mutation_id = $2 FOR UPDATE", keys);
    const receipt = result.rows[0];
    if (!receipt) unavailable();
    return { payloadHash: receipt.payload_hash, draftId: receipt.draft_id, acceptedRevision: receipt.accepted_revision === null ? null : editDraftRevision(Number(receipt.accepted_revision)) };
  }
  async recordMutation(ownerId: string, mutationId: string, draftId: string, acceptedRevision: number): Promise<void> {
    const result = await this.sql.query("UPDATE m07_edit_draft_mutations SET draft_id = $3, accepted_revision = $4 WHERE owner_id = $1 AND mutation_id = $2 AND draft_id IS NULL RETURNING mutation_id", [v.identifier(ownerId), v.identifier(mutationId), v.identifier(draftId), editDraftRevision(acceptedRevision)]);
    if (result.rowCount !== 1) unavailable();
  }
  async lockKey(key: EditDraftKey): Promise<void> {
    const values = keyParts(key);
    await this.sql.query("INSERT INTO m07_edit_draft_roots (owner_id, project_id, document_key) VALUES ($1, $2, $3) ON CONFLICT (owner_id, project_id, document_key) DO NOTHING", values);
    const lock = await this.sql.query("SELECT owner_id FROM m07_edit_draft_roots WHERE owner_id = $1 AND project_id = $2 AND document_key = $3 FOR UPDATE", values);
    if (lock.rows.length !== 1) unavailable();
  }
  async put(value: RetrospectiveEditDraft, expectedRevision: number): Promise<void> {
    const draft = validateDraft(value), expected = editDraftRevision(expectedRevision, true), keys = keyParts(draft);
    if (draft.revision !== expected + 1) v.invalid("草稿版本必须只递增一次。");
    const parameters = [draft.id, ...keys, draft.documentId, draft.baseDocumentRevision, draft.requestedScope, draft.revision, draft.createdAt, draft.updatedAt, JSON.stringify(draft)];
    const result = expected === 0 ? await this.sql.query(
      `INSERT INTO m07_edit_drafts (id, owner_id, project_id, document_key, document_id, base_document_revision, requested_scope, revision, created_at, updated_at, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`, parameters,
    ) : await this.sql.query(
      `UPDATE m07_edit_drafts SET base_document_revision = $6, requested_scope = $7, revision = $8, updated_at = $10::timestamptz, body = $11::jsonb
       WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND document_key = $4 AND document_id IS NOT DISTINCT FROM $5 AND created_at = $9::timestamptz AND revision = $12 RETURNING id`, [...parameters, expected],
    );
    if (result.rowCount !== 1) { const latest = await this.get(draft); editDraftConflict(latest?.revision ?? 0); }
  }
  async delete(id: string, ownerId: string, expectedRevision: number): Promise<void> {
    const result = await this.sql.query("DELETE FROM m07_edit_drafts WHERE id = $1 AND owner_id = $2 AND revision = $3 RETURNING id", [v.identifier(id), v.identifier(ownerId), editDraftRevision(expectedRevision)]);
    if (result.rowCount !== 1) {
      const latest = await this.getById(id, ownerId);
      if (!latest) notFound();
      editDraftConflict(latest.revision);
    }
    // Mutation receipts contain hashes/identifiers only and intentionally survive.
    // An old unknown-response retry must never recreate a deleted draft body.
  }
}

/** Uses the injected persistent PostgreSQL/PGlite database; no process cache. */
export class PostgresRetrospectiveEditDraftRepository implements EditDraftRepository {
  private readonly database: DatabasePort;
  private readonly reader: PostgresEditDraftTransaction;
  constructor(database: DatabasePort) { this.database = database; this.reader = new PostgresEditDraftTransaction(database); }
  get(key: EditDraftKey): Promise<RetrospectiveEditDraft | null> { return this.reader.get(key); }
  getById(id: string, ownerId: string): Promise<RetrospectiveEditDraft | null> { return this.reader.getById(id, ownerId); }
  async list(ownerId: string, filter: Required<Pick<EditDraftFilter, "limit">> & Omit<EditDraftFilter, "limit">): Promise<RetrospectiveEditDraft[]> {
    const input = v.object(filter, ["projectId", "limit", "afterId"]);
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 101) v.invalid("草稿列表数量无效。");
    const parameters: unknown[] = [v.identifier(ownerId)], clauses = ["owner_id = $1"];
    if (input.projectId !== undefined) { parameters.push(v.identifier(input.projectId)); clauses.push(`project_id = $${parameters.length}`); }
    if (input.afterId !== undefined) { parameters.push(v.identifier(input.afterId)); clauses.push(`id COLLATE "C" > $${parameters.length} COLLATE "C"`); }
    parameters.push(input.limit);
    const rows = await this.database.query<BodyRow>(`SELECT body FROM m07_edit_drafts WHERE ${clauses.join(" AND ")} ORDER BY id COLLATE "C" LIMIT $${parameters.length}`, parameters);
    return rows.rows.map(row => decode(row)!);
  }
  transaction<T>(work: (transaction: EditDraftTransaction) => Promise<T>): Promise<T> { return this.database.transaction(sql => work(new PostgresEditDraftTransaction(sql))); }
}
