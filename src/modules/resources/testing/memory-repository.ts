import { Buffer } from "node:buffer";
import type { NormalizedResourceQuery, Resource, ResourceBookmark, ResourceBookmarkView, ResourceRecord } from "../domain.ts";
import type { ResourceRepository, ResourceUnitOfWork } from "../ports.ts";

interface MemoryState {
  records: Map<string, ResourceRecord>;
  bookmarks: Map<string, ResourceBookmark>;
}

function copy<T>(value: T): T { return structuredClone(value); }
// PostgreSQL COLLATE "C" compares UTF-8 bytes, including supplementary characters.
function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function unit(state: MemoryState): ResourceUnitOfWork {
  return {
    async getRecord(id) { return copy(state.records.get(id) ?? null); },
    async insertRecord(record) {
      if (state.records.has(record.resource.id)) throw new Error("Duplicate resource ID in test fixture");
      state.records.set(record.resource.id, copy(record));
    },
    async saveRecord(record, expectedRevision) {
      if (state.records.get(record.resource.id)?.resource.revision !== expectedRevision) return false;
      state.records.set(record.resource.id, copy(record));
      return true;
    },
    async putBookmark(bookmark) {
      const existing = [...state.bookmarks.values()].find(value => value.userId === bookmark.userId && value.resourceId === bookmark.resourceId);
      if (existing) return copy(existing);
      if (!state.records.has(bookmark.resourceId)) throw new Error("Missing resource foreign key in test fixture");
      if (state.bookmarks.has(bookmark.id)) throw new Error("Duplicate bookmark ID in test fixture");
      state.bookmarks.set(bookmark.id, copy(bookmark));
      return copy(bookmark);
    },
    async getBookmark(id, userId) {
      const bookmark = state.bookmarks.get(id);
      return bookmark?.userId === userId ? copy(bookmark) : null;
    },
    async updateBookmark(bookmark, expectedRevision) {
      const current = state.bookmarks.get(bookmark.id);
      if (!current || current.userId !== bookmark.userId || current.revision !== expectedRevision) return false;
      // Match SQL UPDATE: identity, owner, resource and creation time cannot change.
      state.bookmarks.set(bookmark.id, {...current, purposeNote: bookmark.purposeNote, updatedAt: bookmark.updatedAt, revision: bookmark.revision});
      return true;
    },
    async removeBookmark(id, userId) {
      if (state.bookmarks.get(id)?.userId === userId) state.bookmarks.delete(id);
    },
  };
}

/** Test fixture only. Never bind this repository to trial or production routes. */
export class MemoryResourceRepository implements ResourceRepository {
  private state: MemoryState;
  private tail: Promise<void> = Promise.resolve();

  constructor(records: readonly ResourceRecord[] = []) {
    this.state = {records: new Map(records.map(record => [record.resource.id, copy(record)])), bookmarks: new Map()};
  }

  async transaction<T>(work: (value: ResourceUnitOfWork) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const pending = copy(this.state);
    try {
      const result = await work(unit(pending));
      this.state = pending;
      return result;
    } finally {
      // Failure discards all pending writes and never poisons the next transaction.
      release();
    }
  }

  getRecord(id: string, lock = false) { return unit(this.state).getRecord(id, lock); }
  getBookmark(id: string, userId: string, lock = false) { return unit(this.state).getBookmark(id, userId, lock); }
  insertRecord(record: ResourceRecord) { return this.transaction(value => value.insertRecord(record)); }
  saveRecord(record: ResourceRecord, expectedRevision: number) { return this.transaction(value => value.saveRecord(record, expectedRevision)); }
  putBookmark(bookmark: ResourceBookmark) { return this.transaction(value => value.putBookmark(bookmark)); }
  updateBookmark(bookmark: ResourceBookmark, expectedRevision: number) { return this.transaction(value => value.updateBookmark(bookmark, expectedRevision)); }
  removeBookmark(id: string, userId: string) { return this.transaction(value => value.removeBookmark(id, userId)); }

  async getPublic(id: string): Promise<Resource | null> {
    const resource = this.state.records.get(id)?.publicResource;
    return resource && ["published", "withdrawn"].includes(resource.publicationStatus) ? copy(resource) : null;
  }

  async listPublished(query: NormalizedResourceQuery): Promise<readonly Resource[]> {
    const search = query.search.toLowerCase();
    const rows = [...this.state.records.values()].flatMap(record => record.publicResource?.publicationStatus === "published" ? [record.publicResource] : []).filter(resource => {
      const text = [resource.name, resource.summary, JSON.stringify(resource.stageTags), JSON.stringify(resource.useTags), JSON.stringify(resource.stackTags)].join(" ").toLowerCase();
      return (!search || text.includes(search)) && (!query.type || resource.type === query.type) && (!query.costType || resource.costType === query.costType)
        && (!query.stage || resource.stageTags.includes(query.stage)) && (!query.stack || resource.stackTags.includes(query.stack))
        && (!query.prerequisite || resource.prerequisites.includes(query.prerequisite)) && (!query.use || resource.useTags.includes(query.use));
    });
    rows.sort((left, right) => {
      const order = query.sort === "name" ? compareText(left.name, right.name)
        : query.sort === "verified" ? (right.verifiedAt === null ? -Infinity : Date.parse(right.verifiedAt)) - (left.verifiedAt === null ? -Infinity : Date.parse(left.verifiedAt))
        : left.displayOrder - right.displayOrder;
      return (Number.isNaN(order) ? 0 : order) || compareText(left.id, right.id);
    });
    return copy(rows.slice(query.offset, query.offset + query.limit + 1));
  }

  async listBookmarks(userId: string, offset: number, limit: number): Promise<readonly ResourceBookmarkView[]> {
    const bookmarks = [...this.state.bookmarks.values()].filter(bookmark => bookmark.userId === userId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || compareText(left.id, right.id));
    return copy(bookmarks.slice(offset, offset + limit + 1).flatMap(bookmark => {
      const resource = this.state.records.get(bookmark.resourceId)?.publicResource;
      return resource ? [{bookmark, resource}] : [];
    }));
  }
}
