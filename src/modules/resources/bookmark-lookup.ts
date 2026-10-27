import type { PageResult } from "../../shared/contracts.ts";
import type { ResourceBookmarkView } from "./domain.ts";

/** A missing bookmark is known only after the relevant pages have been read. */
export async function findResourceBookmarks(
  resourceIds: readonly string[],
  readPage: (cursor?: string) => Promise<PageResult<ResourceBookmarkView>>,
  options: { signal?: AbortSignal; ownerId?: string } = {},
): Promise<ResourceBookmarkView[]> {
  const targets = new Set(resourceIds);
  if (!targets.size) return [];
  const found = new Map<string, ResourceBookmarkView>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    const page = await readPage(cursor);
    options.signal?.throwIfAborted();
    for (const item of page.items) {
      if (options.ownerId && item.bookmark.userId !== options.ownerId) throw new Error("收藏身份已变化，请重新打开当前页面。");
      if (item.bookmark.resourceId !== item.resource.id) throw new Error("收藏结果与资源不一致，请重新读取。");
      if (targets.has(item.resource.id)) found.set(item.resource.id, item);
    }
    if (found.size === targets.size || !page.nextCursor) return [...found.values()];
    if (!/^\d{1,7}$/.test(page.nextCursor) || Number(page.nextCursor) > 1000000 || seen.has(page.nextCursor) || (cursor !== undefined && Number(page.nextCursor) <= Number(cursor))) {
      throw new Error("收藏分页没有继续前进，请重新读取。");
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
