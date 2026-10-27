import type { Actor } from "../../shared/contracts.ts";
import type { SqlExecutor, SqlResult } from "../../shared/persistence.ts";
import { DomainError, isDomainError } from "../../shared/errors.ts";
import { documentDraftKey, type DocumentDraft, type DraftPublication, type DraftPublicationOutcome } from "./model.ts";
import type { DocumentDraftDependencies, DocumentDraftService, DocumentDraftSessionGuard } from "./ports.ts";

interface PublicationRow {
  owner_id: string; project_id: string; attempt_id: string; slot_key: string; document_id: string | null;
  target_document_id: string | null; source_draft_revision: number; content_revision: number; body: string;
  base_document_revision: number | null; status: DraftPublication["status"]; result_document_id: string | null;
  result_document_revision: number | null; cleared: boolean | null; error_code: string | null; error_message: string | null;
  started_at: Date | string; updated_at: Date | string; finished_at: Date | string | null;
}
interface DraftRow {
  owner_id: string; project_id: string; document_id: string | null; revision: number; content_revision: number;
  body: string | null; base_document_revision: number | null; published_document_id: string | null;
  publication_id: string | null; publication: PublicationRow | null; deleted_at: Date | string | null; updated_at: Date | string;
}
const iso = (value: Date | string) => new Date(value).toISOString();
const publicationOf = (row: PublicationRow): DraftPublication => ({ attemptId: row.attempt_id, documentId: row.document_id,
  targetDocumentId: row.target_document_id, sourceDraftRevision: Number(row.source_draft_revision), contentRevision: Number(row.content_revision),
  status: row.status, body: row.body, baseDocumentRevision: row.base_document_revision === null ? null : Number(row.base_document_revision),
  result: row.result_document_id === null ? null : { documentId: row.result_document_id, documentRevision: Number(row.result_document_revision) },
  cleared: row.cleared, errorCode: row.error_code, errorMessage: row.error_message,
  startedAt: iso(row.started_at), updatedAt: iso(row.updated_at), finishedAt: row.finished_at === null ? null : iso(row.finished_at) });
const draftOf = (row: DraftRow): DocumentDraft => ({ ownerId: row.owner_id, projectId: row.project_id, documentId: row.document_id,
  revision: Number(row.revision), contentRevision: Number(row.content_revision), body: row.body,
  baseDocumentRevision: row.base_document_revision === null ? null : Number(row.base_document_revision), publishedDocumentId: row.published_document_id,
  publication: row.publication ? publicationOf(row.publication) : null,
  deletedAt: row.deleted_at === null ? null : iso(row.deleted_at), updatedAt: iso(row.updated_at) });
const empty = (actor: Actor, projectId: string, documentId: string | null): DocumentDraft => ({ ownerId: actor.userId, projectId, documentId,
  revision: 0, contentRevision: 0, body: null, baseDocumentRevision: null, publishedDocumentId: null, publication: null, deletedAt: null, updatedAt: null });
const SELECT = "SELECT d.*,to_jsonb(p) AS publication FROM document_drafts d LEFT JOIN document_draft_publications p ON p.owner_id=d.owner_id AND p.project_id=d.project_id AND p.attempt_id=d.publication_id";
function invalid(message = "草稿格式不正确，请只提交当前表单的字段。"): never { throw new DomainError("INVALID_INPUT", message, { status: 422 }); }
function payload(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) invalid("草稿位置不正确。");
  return value;
}
function revision(value: unknown, zero = true): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value >= 2147483647) invalid("草稿版本缺失或不正确，请先重新读取。");
  return value;
}
function body(value: unknown): string {
  if (typeof value !== "string" || value.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid("正文不能超过20000字或包含无效控制字符。");
  return value;
}
function attempt(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{12,160}$/.test(value)) invalid("发布尝试编号不正确。");
  return value;
}
function assertOwner(actor: Actor, value: unknown) {
  if (value !== undefined && value !== actor.userId) throw new DomainError("DRAFT_OWNER_CHANGED", "账号已改变，已停止旧页面的私人草稿写入。请重新打开当前空间。", { status: 403 });
}
function conflict(latestRevision?: number): never {
  throw new DomainError("VERSION_CONFLICT", "另一窗口已更新私人草稿，本页输入仍保留。请读取后选择恢复或明确覆盖私稿。", { status: 409, latestRevision });
}
function one<Row>(result: SqlResult<Row>): Row {
  if (result.rowCount !== 1 || result.rows.length !== 1) conflict();
  return result.rows[0]!;
}
const held = (draft: DocumentDraft) => draft.publication?.status === "pending" || draft.publication?.status === "unknown";

export function createDocumentDrafts(deps: DocumentDraftDependencies): DocumentDraftService {
  async function authorize(sql: SqlExecutor, actor: Actor, projectId: string, write: boolean, guard: DocumentDraftSessionGuard) {
    if (typeof guard !== "function") throw new DomainError("AUTH_SESSION_REQUIRED", "请重新登录后使用私人草稿。", { status: 401 });
    await deps.authorize(sql, actor, projectId, write, guard);
  }
  function location(projectId: string, documentId: string | null) {
    id(projectId); if (documentId !== null) { id(documentId); if (documentId === "new") invalid("new保留给新文档草稿。"); }
    return documentDraftKey(documentId);
  }
  async function read(sql: SqlExecutor, actor: Actor, projectId: string, documentId: string | null, lock = false) {
    const result = await sql.query<DraftRow>(`${SELECT} WHERE d.owner_id=$1 AND d.project_id=$2 AND d.slot_key=$3${lock ? " FOR UPDATE OF d" : ""}`, [actor.userId, projectId, documentDraftKey(documentId)]);
    return result.rows[0] ? draftOf(result.rows[0]) : empty(actor, projectId, documentId);
  }
  async function receipt(sql: SqlExecutor, actor: Actor, projectId: string, attemptId: string, lock = false) {
    const result = await sql.query<PublicationRow>(`SELECT * FROM document_draft_publications WHERE owner_id=$1 AND project_id=$2 AND attempt_id=$3${lock ? " FOR UPDATE" : ""}`, [actor.userId, projectId, attemptId]);
    return result.rows[0] ? publicationOf(result.rows[0]) : null;
  }
  const now = () => deps.clock.now().toISOString();
  return {
    async list(actor, projectId, guard) {
      id(projectId);
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, false, guard);
        const rows = await sql.query<DraftRow>(`${SELECT} WHERE d.owner_id=$1 AND d.project_id=$2 ORDER BY d.updated_at DESC,d.slot_key`, [actor.userId, projectId]);
        await authorize(sql, actor, projectId, false, guard);
        return { ownerId: actor.userId, projectId, items: rows.rows.map(draftOf) };
      });
    },
    async get(actor, projectId, documentId, guard) {
      location(projectId, documentId);
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, false, guard); const draft = await read(sql, actor, projectId, documentId);
        await authorize(sql, actor, projectId, false, guard); return draft;
      });
    },
    async save(actor, projectId, documentId, input, guard) {
      const slot = location(projectId, documentId), value = payload(input, ["expectedRevision", "body", "baseDocumentRevision", "continuePublicationAttemptId", "expectedOwnerId"]);
      assertOwner(actor, value.expectedOwnerId);
      const expected = revision(value.expectedRevision), content = body(value.body);
      const base = value.baseDocumentRevision === null ? null : revision(value.baseDocumentRevision, false);
      const continuation = value.continuePublicationAttemptId === undefined ? null : attempt(value.continuePublicationAttemptId);
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, true, guard);
        const current = await read(sql, actor, projectId, documentId, true);
        if (current.revision !== expected) conflict(current.revision);
        if (continuation !== null && (documentId !== null || current.body !== null || current.publication?.attemptId !== continuation
          || current.publication.status !== "succeeded" || !current.publication.result)) invalid("只能继续本人的原新文档发布回执，不能指定另一份正文。");
        const target = documentId ?? current.publishedDocumentId ?? (continuation ? current.publication!.result!.documentId : null);
        if ((target === null) !== (base === null)) invalid("请保留原正文版本，新文档的原版本应为空。");
        if (expected === 0) {
          one(await sql.query("INSERT INTO document_drafts(owner_id,project_id,slot_key,document_id,revision,content_revision,body,base_document_revision,deleted_at,updated_at) VALUES($1,$2,$3,$4,1,1,$5,$6,NULL,$7::timestamptz) ON CONFLICT DO NOTHING RETURNING revision",
            [actor.userId, projectId, slot, documentId, content, base, now()]));
        } else {
          one(await sql.query("UPDATE document_drafts SET revision=revision+1,content_revision=content_revision+1,body=$4,base_document_revision=$5,deleted_at=NULL,publication_id=$6,updated_at=$7::timestamptz,published_document_id=$9 WHERE owner_id=$1 AND project_id=$2 AND slot_key=$3 AND revision=$8 RETURNING revision",
            [actor.userId, projectId, slot, content, base, current.body === null && !continuation ? null : current.publication?.attemptId ?? null, now(), expected, continuation ? target : current.publishedDocumentId]));
        }
        await authorize(sql, actor, projectId, true, guard); return read(sql, actor, projectId, documentId);
      });
    },
    async remove(actor, projectId, documentId, input, guard) {
      const slot = location(projectId, documentId), value = payload(input, ["expectedRevision", "expectedOwnerId"]), expected = revision(value.expectedRevision);
      assertOwner(actor, value.expectedOwnerId);
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, true, guard); const current = await read(sql, actor, projectId, documentId, true);
        if (current.revision !== expected) conflict(current.revision);
        if (held(current)) throw new DomainError("DRAFT_PUBLICATION_PENDING", "发布结果尚未确认，不能删除私稿或重复发布。请查询原回执。", { status: 409 });
        if (expected === 0) {
          one(await sql.query("INSERT INTO document_drafts(owner_id,project_id,slot_key,document_id,revision,content_revision,body,deleted_at,updated_at) VALUES($1,$2,$3,$4,1,1,NULL,$5::timestamptz,$5::timestamptz) ON CONFLICT DO NOTHING RETURNING revision", [actor.userId, projectId, slot, documentId, now()]));
        } else {
          one(await sql.query("UPDATE document_drafts SET revision=revision+1,content_revision=content_revision+1,body=NULL,base_document_revision=NULL,published_document_id=NULL,publication_id=NULL,deleted_at=$4::timestamptz,updated_at=$4::timestamptz WHERE owner_id=$1 AND project_id=$2 AND slot_key=$3 AND revision=$5 RETURNING revision", [actor.userId, projectId, slot, now(), expected]));
        }
        await authorize(sql, actor, projectId, true, guard); return read(sql, actor, projectId, documentId);
      });
    },
    async getPublication(actor, projectId, attemptId, guard) {
      id(projectId); attempt(attemptId);
      return deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, false, guard); const saved = await receipt(sql, actor, projectId, attemptId);
        await authorize(sql, actor, projectId, false, guard); return saved;
      });
    },
    async publish(actor, projectId, documentId, input, guard): Promise<DraftPublicationOutcome> {
      const slot = location(projectId, documentId), value = payload(input, ["expectedRevision", "attemptId", "retryFailed", "expectedOwnerId"]);
      assertOwner(actor, value.expectedOwnerId);
      const expected = revision(value.expectedRevision, false), attemptId = attempt(value.attemptId);
      if (value.retryFailed !== undefined && typeof value.retryFailed !== "boolean") invalid();
      // Persist the frozen attempt before the writer. A crash here leaves a hold,
      // and replaying the same key never initiates another unknown document write.
      const prepared = await deps.database.transaction(async sql => {
        await authorize(sql, actor, projectId, true, guard);
        const draft = await read(sql, actor, projectId, documentId, true), previous = await receipt(sql, actor, projectId, attemptId, true);
        if (previous) {
          if (previous.documentId !== documentId || previous.sourceDraftRevision !== expected) invalid("发布编号已用于另一份草稿或版本。");
          if (previous.status !== "failed" || value.retryFailed !== true) return { run: false, receipt: previous, draft };
          if (draft.body === null || draft.publication?.attemptId !== attemptId) conflict(draft.revision);
          if (held(draft)) throw new DomainError("DRAFT_PUBLICATION_PENDING", "已有发布待核查，请使用原回执。", { status: 409 });
          one(await sql.query("UPDATE document_draft_publications SET status='pending',error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=$4::timestamptz WHERE owner_id=$1 AND project_id=$2 AND attempt_id=$3 AND status='failed' RETURNING attempt_id", [actor.userId, projectId, attemptId, now()]));
        } else {
          if (draft.revision !== expected) conflict(draft.revision);
          if (draft.body === null) invalid("请先保护私人草稿，再保存到团队正文。");
          if (held(draft)) throw new DomainError("DRAFT_PUBLICATION_PENDING", "发布结果尚未确认，不会重复新建。请查询原回执。", { status: 409 });
          const target = documentId ?? draft.publishedDocumentId;
          if (target === null && !draft.body.trim()) invalid("新文档至少需要一行正文。");
          one(await sql.query("INSERT INTO document_draft_publications(owner_id,project_id,attempt_id,slot_key,document_id,target_document_id,source_draft_revision,content_revision,body,base_document_revision,status,started_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11::timestamptz,$11::timestamptz) ON CONFLICT DO NOTHING RETURNING attempt_id",
            [actor.userId, projectId, attemptId, slot, documentId, target, expected, draft.contentRevision, draft.body, draft.baseDocumentRevision, now()]));
        }
        one(await sql.query("UPDATE document_drafts SET revision=revision+1,publication_id=$4,updated_at=$5::timestamptz WHERE owner_id=$1 AND project_id=$2 AND slot_key=$3 AND revision=$6 RETURNING revision", [actor.userId, projectId, slot, attemptId, now(), draft.revision]));
        await authorize(sql, actor, projectId, true, guard);
        return { run: true, receipt: (await receipt(sql, actor, projectId, attemptId))!, draft: await read(sql, actor, projectId, documentId) };
      });
      if (!prepared.run) return { receipt: prepared.receipt, draft: prepared.draft };
      try {
        return await deps.database.transaction(async sql => {
          await authorize(sql, actor, projectId, true, guard);
          const draft = await read(sql, actor, projectId, documentId, true), pending = await receipt(sql, actor, projectId, attemptId, true);
          if (!pending || pending.status !== "pending" || draft.publication?.attemptId !== attemptId) throw new DomainError("DRAFT_PUBLICATION_PENDING", "发布状态需核对，不能重复写入。", { status: 409 });
          const title = pending.body.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 200) ?? "文档";
          const saved = await deps.writer.write(sql, actor, projectId, { documentId: pending.targetDocumentId, title,
            body: pending.body, expectedRevision: pending.baseDocumentRevision }, guard);
          if (!saved || typeof saved.id !== "string" || !saved.id || !Number.isSafeInteger(saved.revision) || saved.revision < 1
            || (pending.targetDocumentId !== null && saved.id !== pending.targetDocumentId)) {
            throw new DomainError("INVALID_PUBLICATION_RECEIPT", "文档写入器没有返回可信回执，事务已回滚。", { status: 502 });
          }
          const fresh = draft.contentRevision === pending.contentRevision && draft.body === pending.body;
          one(await sql.query("UPDATE document_drafts SET revision=revision+1,content_revision=content_revision+$4,body=$5,base_document_revision=$6,published_document_id=$7,deleted_at=$8::timestamptz,updated_at=$9::timestamptz WHERE owner_id=$1 AND project_id=$2 AND slot_key=$3 AND revision=$10 AND publication_id=$11 RETURNING revision",
            [actor.userId, projectId, slot, fresh ? 1 : 0, fresh ? null : draft.body, fresh ? null : saved.revision,
              fresh ? null : (documentId === null ? saved.id : draft.publishedDocumentId), fresh ? now() : null, now(), draft.revision, attemptId]));
          one(await sql.query("UPDATE document_draft_publications SET status='succeeded',result_document_id=$4,result_document_revision=$5,cleared=$6,finished_at=$7::timestamptz,updated_at=$7::timestamptz WHERE owner_id=$1 AND project_id=$2 AND attempt_id=$3 AND status='pending' RETURNING attempt_id",
            [actor.userId, projectId, attemptId, saved.id, saved.revision, fresh, now()]));
          await authorize(sql, actor, projectId, true, guard);
          return { receipt: (await receipt(sql, actor, projectId, attemptId))!, draft: await read(sql, actor, projectId, documentId) };
        });
      } catch (reason) {
        const known = (deps.classifyFailure?.(reason) ?? (isDomainError(reason) ? "known_failed" : "unknown")) === "known_failed";
        // Outcome bookkeeping uses current read authorization: an already accepted
        // operation may record its rollback/hold after archive, never publish anew.
        return deps.database.transaction(async sql => {
          await authorize(sql, actor, projectId, false, guard);
          await read(sql, actor, projectId, documentId, true);
          const current = await receipt(sql, actor, projectId, attemptId, true);
          if (!current) throw new DomainError("DRAFT_PUBLICATION_UNKNOWN", "发布结果尚未确认，请保留草稿并查询原回执。", { status: 503 });
          if (current.status === "pending") {
            one(await sql.query("UPDATE document_draft_publications SET status=$4,error_code=$5,error_message=$6,finished_at=$7::timestamptz,updated_at=$8::timestamptz WHERE owner_id=$1 AND project_id=$2 AND attempt_id=$3 AND status='pending' RETURNING attempt_id",
              [actor.userId, projectId, attemptId, known ? "failed" : "unknown",
                known && isDomainError(reason) ? reason.code : known ? "PUBLICATION_ROLLED_BACK" : "PUBLICATION_UNKNOWN",
                known && isDomainError(reason) ? reason.message : known ? "发布事务已回滚，私稿仍保留。可以明确重试。" : "发布结果尚未确认，不会重复新建。请查询原回执，私稿仍保留。",
                known ? now() : null, now()]));
          }
          await authorize(sql, actor, projectId, false, guard);
          return { receipt: (await receipt(sql, actor, projectId, attemptId))!, draft: await read(sql, actor, projectId, documentId) };
        });
      }
    },
  };
}
