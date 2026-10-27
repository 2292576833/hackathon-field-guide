import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { NormalizedResourceQuery, Resource, ResourceBookmark, ResourceBookmarkView, ResourceRecord } from "./domain.ts";
import type { ResourceRepository, ResourceUnitOfWork } from "./ports.ts";

type RecordRow = {working_document: Resource; public_document: Resource | null};
type BookmarkRow = {id: string; user_id: string; resource_id: string; purpose_note: string; created_at: Date | string; updated_at: Date | string; revision: number};
function bookmark(row: BookmarkRow): ResourceBookmark {
  return {id: row.id, userId: row.user_id, resourceId: row.resource_id, purposeNote: row.purpose_note,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), revision: Number(row.revision)};
}
function unit(executor: SqlExecutor): ResourceUnitOfWork {
  return {
    async getRecord(id, lock = false) {
      const result = await executor.query<RecordRow>(`SELECT working_document, public_document FROM resource_records WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
      const row = result.rows[0];
      return row ? {resource: row.working_document, publicResource: row.public_document} : null;
    },
    async insertRecord(record) {
      await executor.query("INSERT INTO resource_records (id, revision, working_document, public_document) VALUES ($1, $2, $3::jsonb, $4::jsonb)",
        [record.resource.id, record.resource.revision, JSON.stringify(record.resource), record.publicResource === null ? null : JSON.stringify(record.publicResource)]);
      await executor.query("INSERT INTO resource_revisions (resource_id, revision, working_document, public_document, changed_at) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)",
        [record.resource.id, record.resource.revision, JSON.stringify(record.resource), record.publicResource === null ? null : JSON.stringify(record.publicResource), record.resource.updatedAt]);
    },
    async saveRecord(record, expectedRevision) {
      const result = await executor.query("UPDATE resource_records SET revision = $2, working_document = $3::jsonb, public_document = $4::jsonb WHERE id = $1 AND revision = $5 RETURNING id",
        [record.resource.id, record.resource.revision, JSON.stringify(record.resource), record.publicResource === null ? null : JSON.stringify(record.publicResource), expectedRevision]);
      if (result.rowCount === 0) return false;
      await executor.query("INSERT INTO resource_revisions (resource_id, revision, working_document, public_document, changed_at) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)",
        [record.resource.id, record.resource.revision, JSON.stringify(record.resource), record.publicResource === null ? null : JSON.stringify(record.publicResource), record.resource.updatedAt]);
      return true;
    },
    async putBookmark(value) {
      // Locking the resource row in the service serializes this against withdrawal.
      // Conflict does not modify another request's original note or revision.
      await executor.query("INSERT INTO resource_bookmarks (id, user_id, resource_id, purpose_note, created_at, updated_at, revision) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, resource_id) DO NOTHING",
        [value.id, value.userId, value.resourceId, value.purposeNote, value.createdAt, value.updatedAt, value.revision]);
      const result = await executor.query<BookmarkRow>("SELECT * FROM resource_bookmarks WHERE user_id = $1 AND resource_id = $2", [value.userId, value.resourceId]);
      if (!result.rows[0]) throw new Error("Bookmark insert did not return a persisted row");
      return bookmark(result.rows[0]);
    },
    async getBookmark(id, userId, lock = false) {
      const result = await executor.query<BookmarkRow>(`SELECT * FROM resource_bookmarks WHERE id = $1 AND user_id = $2${lock ? " FOR UPDATE" : ""}`, [id, userId]);
      return result.rows[0] ? bookmark(result.rows[0]) : null;
    },
    async updateBookmark(value, expectedRevision) {
      const result = await executor.query("UPDATE resource_bookmarks SET purpose_note = $3, updated_at = $4, revision = $5 WHERE id = $1 AND user_id = $2 AND revision = $6 RETURNING id",
        [value.id, value.userId, value.purposeNote, value.updatedAt, value.revision, expectedRevision]);
      return result.rowCount === 1;
    },
    async removeBookmark(id, userId) {
      await executor.query("DELETE FROM resource_bookmarks WHERE id = $1 AND user_id = $2", [id, userId]);
    },
  };
}

/** No pool or environment access: the coordinating session injects DatabasePort. */
export function createPostgresResourceRepository(database: DatabasePort): ResourceRepository {
  const reads = unit(database);
  return {
    getRecord: reads.getRecord,
    getBookmark: reads.getBookmark,
    insertRecord: record => database.transaction(tx => unit(tx).insertRecord(record)),
    saveRecord: (record, expected) => database.transaction(tx => unit(tx).saveRecord(record, expected)),
    putBookmark: value => database.transaction(tx => unit(tx).putBookmark(value)),
    updateBookmark: (value, expected) => database.transaction(tx => unit(tx).updateBookmark(value, expected)),
    removeBookmark: (id, userId) => database.transaction(tx => unit(tx).removeBookmark(id, userId)),
    transaction: work => database.transaction(tx => work(unit(tx))),
    async getPublic(id) {
      const result = await database.query<{public_document: Resource}>("SELECT public_document FROM resource_records WHERE id = $1 AND public_document->>'publicationStatus' IN ('published', 'withdrawn')", [id]);
      return result.rows[0]?.public_document ?? null;
    },
    async listPublished(query: NormalizedResourceQuery) {
      const parameters: unknown[] = [];
      const conditions = ["public_document->>'publicationStatus' = 'published'"];
      function bind(value: unknown): string { parameters.push(value); return `$${parameters.length}`; }
      if (query.search) {
        const escaped = query.search.replace(/[\\%_]/g, value => `\\${value}`);
        conditions.push(`concat_ws(' ', public_document->>'name', public_document->>'summary', public_document->'stageTags', public_document->'useTags', public_document->'stackTags') ILIKE ${bind(`%${escaped}%`)} ESCAPE E'\\\\'`);
      }
      if (query.type) conditions.push(`public_document->>'type' = ${bind(query.type)}`);
      if (query.costType) conditions.push(`public_document->>'costType' = ${bind(query.costType)}`);
      for (const [key, value] of [["stageTags", query.stage], ["stackTags", query.stack], ["prerequisites", query.prerequisite], ["useTags", query.use]] as const) {
        if (value) conditions.push(`public_document->'${key}' @> ${bind(JSON.stringify([value]))}::jsonb`);
      }
      const order = query.sort === "name" ? "public_document->>'name' COLLATE \"C\", id"
        : query.sort === "verified" ? "(public_document->>'verifiedAt')::timestamptz DESC NULLS LAST, id"
        : "(public_document->>'displayOrder')::integer, id";
      const limit = bind(query.limit + 1);
      const offset = bind(query.offset);
      const result = await database.query<{public_document: Resource}>(`SELECT public_document FROM resource_records WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, parameters);
      return result.rows.map(row => row.public_document);
    },
    async listBookmarks(userId, offset, limit) {
      const result = await database.query<BookmarkRow & {public_document: Resource}>("SELECT b.*, r.public_document FROM resource_bookmarks b JOIN resource_records r ON r.id = b.resource_id WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.id LIMIT $2 OFFSET $3", [userId, limit + 1, offset]);
      return result.rows.map(row => ({bookmark: bookmark(row), resource: row.public_document} satisfies ResourceBookmarkView));
    },
  };
}

/** Participation in the caller's existing transaction; never starts another commit. */
export function createResourceRepositoryInTransaction(transaction: SqlExecutor): ResourceRepository {
  return createPostgresResourceRepository({query: (sql, parameters) => transaction.query(sql, parameters), transaction: work => work(transaction)});
}
