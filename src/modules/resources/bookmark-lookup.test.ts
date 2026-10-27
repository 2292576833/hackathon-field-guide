import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceBookmarkView } from "./domain.ts";
import { findResourceBookmarks } from "./bookmark-lookup.ts";

function bookmark(id: string): ResourceBookmarkView {
  return { bookmark: { id: `bookmark-${id}`, userId: "owner", resourceId: id, purposeNote: `private-${id}` }, resource: { id } } as ResourceBookmarkView;
}

test("收藏超过50条时继续分页，找到目标后保留原备注并停止读取", async () => {
  const cursors: (string | undefined)[] = [];
  const found = await findResourceBookmarks(["target"], async cursor => {
    cursors.push(cursor);
    return cursor ? { items: [bookmark("target")], nextCursor: "100" } : { items: Array.from({ length: 50 }, (_, i) => bookmark(String(i))), nextCursor: "50" };
  });
  assert.deepEqual(cursors, [undefined, "50"]);
  assert.equal(found[0]?.bookmark.purposeNote, "private-target");
});

test("只有读到末页才能把未找到的目标判断为未收藏", async () => {
  let calls = 0;
  const found = await findResourceBookmarks(["absent", "present", "present"], async () => ++calls === 1
    ? { items: [bookmark("present")], nextCursor: "50" } : { items: [], nextCursor: null });
  assert.equal(calls, 2);
  assert.deepEqual(found.map(value => value.resource.id), ["present"]);
});

test("第101条收藏仍能被读取，不能混入另一账号的私人备注", async () => {
  let calls = 0;
  const found = await findResourceBookmarks(["target"], async cursor => {
    calls++;
    return cursor === "100" ? { items: [bookmark("target")], nextCursor: null } : { items: [], nextCursor: cursor ? "100" : "50" };
  }, { ownerId: "owner" });
  assert.equal(calls, 3);
  assert.equal(found[0]?.bookmark.resourceId, "target");
  await assert.rejects(findResourceBookmarks(["target"], async () => ({ items: [bookmark("target")], nextCursor: null }), { ownerId: "other-user" }), /身份已变化/);
});

test("读取失败、重复分页或关联错误不会返回把未知当未收藏的结果", async () => {
  await assert.rejects(findResourceBookmarks(["target"], async cursor => {
    if (cursor) throw new Error("网络中断");
    return { items: [], nextCursor: "50" };
  }), /网络中断/);
  await assert.rejects(findResourceBookmarks(["target"], async () => ({ items: [], nextCursor: "50" })), /没有继续前进/);
  const wrong = bookmark("other"); wrong.bookmark.resourceId = "target";
  await assert.rejects(findResourceBookmarks(["target"], async () => ({ items: [wrong], nextCursor: null })), /不一致/);
});

test("身份或页面更换导致中止时不交付旧收藏，空目标不发请求", async () => {
  const controller = new AbortController();
  await assert.rejects(findResourceBookmarks(["target"], async () => {
    controller.abort(); return { items: [bookmark("target")], nextCursor: null };
  }, { signal: controller.signal }), error => error instanceof Error && error.name === "AbortError");
  assert.deepEqual(await findResourceBookmarks([], async () => { throw new Error("不应读取"); }), []);
});
