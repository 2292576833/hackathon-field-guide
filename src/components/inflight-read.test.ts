import { test } from "node:test";
import assert from "node:assert/strict";
import { createInflightReadGroup, isSharedRead, waitForRead } from "./inflight-read.ts";

test("only exact safe reads are grouped; different spaces remain separate", () => {
  for (const path of ["/me", "/system/status", "/projects/p1/rules", "/projects/p1/plans/current"]) assert.equal(isSharedRead(path), true);
  for (const path of ["/projects/p1/rules/confirm", "/auth/guancha/status", "/navigator/messages", "/me?other=1"]) assert.equal(isSharedRead(path), false);
  const group = createInflightReadGroup();
  assert.notEqual(group.read("/projects/p1/rules", async () => 1), group.read("/projects/p2/rules", async () => 2));
});

test("simultaneous components share a read but settled reads never become an account cache", async () => {
  const group = createInflightReadGroup(); let calls = 0;
  const load = async () => ({ id: ++calls });
  const first = group.read("/me", load), second = group.read("/me", load);
  assert.equal(first, second); assert.deepEqual(await first, { id: 1 });
  assert.deepEqual(await group.read("/me", load), { id: 2 });
});
test("a write/session invalidation isolates the next read from the old pending account", async () => {
  const group = createInflightReadGroup(); let finish!: (value: string) => void;
  const old = group.read("/me", () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve(); group.clear();
  let finishNew!: (value: string) => void;
  const current = group.read("/me", () => new Promise<string>(resolve => { finishNew = resolve; }));
  await Promise.resolve(); finish("old"); await old;
  assert.equal(group.read("/me", async () => "unexpected"), current);
  finishNew("new"); assert.equal(await current, "new");
});
test("aborting one subscriber does not cancel another; failures can be retried", async () => {
  const group = createInflightReadGroup(); let finish!: (value: string) => void;
  const read = group.read("/me", () => new Promise<string>(resolve => { finish = resolve; }));
  const controller = new AbortController(); const own = waitForRead(read, controller.signal);
  controller.abort(new Error("own timeout")); await assert.rejects(own, /own timeout/);
  finish("ok"); assert.equal(await waitForRead(read), "ok");
  await assert.rejects(group.read("/me", async () => { throw new Error("network"); }), /network/);
  assert.equal(await group.read("/me", async () => "recovered"), "recovered");
});
