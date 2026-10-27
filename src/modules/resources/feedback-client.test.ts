import test from "node:test";
import assert from "node:assert/strict";
import { createResourceFeedbackClient, resourceCorrectionInput, resourceCorrectionStatusLabels, type ResourceCorrectionInput, type ResourceCorrectionView, type ResourceFeedbackTransport } from "./feedback-client.ts";

const input = resourceCorrectionInput({ id: "resource-1", version: 2 }, "链接失效", "打开官网返回 404", "https://example.com/help");
function correction(overrides: Partial<ResourceCorrectionView> = {}): ResourceCorrectionView {
  return { id: "correction-1", submittedBy: "alice", original: { ...input, submittedAt: "2026-10-10T01:00:00Z" },
    status: "received", revision: 1, updatedAt: "2026-10-10T01:00:00Z", response: null, relatedVersion: null, ...overrides };
}
function transport(overrides: Partial<ResourceFeedbackTransport> = {}): ResourceFeedbackTransport {
  return { list: async () => [correction()], detail: async () => correction(), submit: async () => correction(), ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("visitors cannot send or read private corrections", async () => {
  let calls = 0;
  const client = createResourceFeedbackClient(null, transport({ list: async () => { calls++; return []; }, submit: async () => { calls++; return correction(); } }));
  await client.load(); await client.select("correction-1"); assert.equal(await client.submit(input), null);
  assert.equal(calls, 0); assert.deepEqual(client.getSnapshot().items, []);
});

test("lists only resource feedback and preserves honest processing status and station response", async () => {
  const selected = correction({ status: "confirmed", revision: 3, response: "已复现，将更新链接。" });
  const event = correction({ id: "event-correction", original: { ...correction().original, target: { kind: "event", entityId: "event-1", version: 1 } } });
  const client = createResourceFeedbackClient("alice", transport({ list: async () => [selected, event], detail: async () => selected }));
  await client.load(); await client.select(selected.id);
  assert.deepEqual(client.getSnapshot().items.map(item => item.id), [selected.id]);
  assert.equal(client.getSnapshot().selected?.response, "已复现，将更新链接。");
  assert.equal(resourceCorrectionStatusLabels[client.getSnapshot().selected!.status], "已采纳 · 待修正");
  assert.notEqual(resourceCorrectionStatusLabels.confirmed, resourceCorrectionStatusLabels.resolved);
});

test("ignores late private list results when identity changes even if cancellation is ignored", async () => {
  const pending = deferred<unknown>(); let signal: AbortSignal | null = null;
  const client = createResourceFeedbackClient("alice", transport({ list: async captured => { signal = captured; return pending.promise; } }));
  const request = client.load(); client.setIdentity("bob"); pending.resolve([correction()]); await request;
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  assert.equal(client.getSnapshot().ownerId, "bob"); assert.deepEqual(client.getSnapshot().items, []); assert.equal(client.getSnapshot().selected, null);
});

test("logout during submission clears the private result and rejects late success", async () => {
  const pending = deferred<unknown>();
  const client = createResourceFeedbackClient("alice", transport({ submit: async () => pending.promise }));
  const request = client.submit(input); client.clearPrivate(); pending.resolve(correction());
  assert.equal(await request, null); assert.deepEqual(client.getSnapshot().items, []); assert.equal(client.getSnapshot().selected, null);
  assert.equal(client.getSnapshot().accessLost, true); assert.equal(client.getSnapshot().notice, "");
});

test("mixed or forged other-account list results clear existing private data", async () => {
  let response: unknown = [correction()];
  const client = createResourceFeedbackClient("alice", transport({ list: async () => response }));
  await client.load(); await client.select("correction-1");
  response = [correction(), correction({ id: "foreign", submittedBy: "bob", response: "私人回复" })]; await client.load();
  assert.deepEqual(client.getSnapshot().items, []); assert.equal(client.getSnapshot().selected, null); assert.equal(client.getSnapshot().accessLost, true);
  assert.doesNotMatch(client.getSnapshot().error, /私人回复/);
});

for (const status of [401, 403, 404]) test(`permission/status ${status} clears cached details instead of showing stale private success`, async () => {
  let deny = false;
  const client = createResourceFeedbackClient("alice", transport({ detail: async () => { if (deny) throw Object.assign(new Error("访问不可用"), { status }); return correction(); } }));
  await client.load(); await client.select("correction-1"); assert.ok(client.getSnapshot().selected);
  deny = true; await client.select("correction-1");
  assert.equal(client.getSnapshot().selected, null); assert.deepEqual(client.getSnapshot().items, []); assert.equal(client.getSnapshot().notice, "");
});

test("submit uses the exact public resource version and checks its successful receipt", async () => {
  let received: ResourceCorrectionInput | null = null;
  const client = createResourceFeedbackClient("alice", transport({ submit: async sent => { received = sent; return correction(); } }));
  assert.equal((await client.submit(input))?.id, "correction-1"); assert.deepEqual(received, input);
  assert.equal(client.getSnapshot().items[0].original.target.version, 2);
  assert.match(client.getSnapshot().notice, /反馈已保存/);
  assert.match(client.getSnapshot().notice, /不会.*立即改变/);
});

test("a mismatched submit receipt cannot claim the selected resource was reported", async () => {
  const unrelated = correction({ original: { ...correction().original, target: { kind: "resource", entityId: "resource-other", version: 2 } } });
  const client = createResourceFeedbackClient("alice", transport({ submit: async () => unrelated }));
  assert.equal(await client.submit(input), null); assert.deepEqual(client.getSnapshot().items, []);
  assert.equal(client.getSnapshot().accessLost, true); assert.equal(client.getSnapshot().notice, "");
});

test("unknown submit outcome cannot automatically repeat; a matching own saved record recovers it", async () => {
  let submits = 0;
  const client = createResourceFeedbackClient("alice", transport({ submit: async () => { submits++; throw new Error("connection reset"); } }));
  await client.submit(input); await client.submit(input);
  assert.equal(submits, 1); assert.ok(client.getSnapshot().uncertainInput); assert.equal(client.getSnapshot().notice, "");
  client.allowUnconfirmedRetry(); assert.ok(client.getSnapshot().uncertainInput);
  await client.load(); assert.equal(client.getSnapshot().uncertainInput, null); assert.equal(client.getSnapshot().selected?.id, "correction-1");
  assert.match(client.getSnapshot().notice, /真实反馈/); assert.equal(submits, 1);
});

test("a successful list without a match requires explicit choice before an uncertain resubmission", async () => {
  let submits = 0;
  const client = createResourceFeedbackClient("alice", transport({ list: async () => [], submit: async () => { submits++; throw Object.assign(new Error("502"), { status: 502 }); } }));
  await client.submit(input); await client.load(); await client.submit(input);
  assert.equal(submits, 1); assert.equal(client.getSnapshot().reviewedUncertain, true); assert.ok(client.getSnapshot().uncertainInput);
  client.allowUnconfirmedRetry(); assert.equal(client.getSnapshot().uncertainInput, null); assert.match(client.getSnapshot().notice, /仍可能已保存/);
  await client.submit(input); assert.equal(submits, 2);
});

test("known validation failure never produces a success receipt or an unknown-result hold", async () => {
  const client = createResourceFeedbackClient("alice", transport({ submit: async () => { throw Object.assign(new Error("版本不存在"), { status: 400 }); } }));
  assert.equal(await client.submit(input), null); assert.equal(client.getSnapshot().uncertainInput, null);
  assert.equal(client.getSnapshot().selected, null); assert.equal(client.getSnapshot().notice, ""); assert.match(client.getSnapshot().error, /版本不存在/);
});

test("input requires a public version and safe bounded evidence without credentials", () => {
  assert.deepEqual(input.target, { kind: "resource", entityId: "resource-1", version: 2 });
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "https://user:pass@example.com", "not-a-url"]) {
    assert.throws(() => resourceCorrectionInput({ id: "resource-1", version: 2 }, "链接", "有问题", url), /HTTP\(S\)/);
  }
  assert.throws(() => resourceCorrectionInput({ id: "resource-1", version: 0 }, "链接", "有问题", ""), /版本无效/);
  assert.throws(() => resourceCorrectionInput({ id: "resource-1", version: 2 }, "链接", " ", ""), /说明/);
  assert.throws(() => resourceCorrectionInput({ id: "resource-1", version: 2 }, "链接", "有问题", Array(6).fill("https://example.com").join("\n")), /最多.*5/);
});
