import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubMaintenance, GITHUB_MAINTENANCE_INTERVAL_MS } from "../maintenance.ts";

const now = "2026-10-10T00:00:00.000Z";

test("trusted maintenance uses one server timestamp and shares overlapping runs", async () => {
  let draftCalls = 0, stateCalls = 0;
  let finishDraft!: (count: number) => void;
  const draftResult = new Promise<number>(resolve => { finishDraft = resolve; });
  const maintenance = createGitHubMaintenance({
    clock: { now: () => new Date(now) },
    drafts: { async purgeExpired(value) { assert.equal(value, now); draftCalls++; return draftResult; } },
    authorization: { async purgeExpiredStates(value) { assert.equal(value, now); stateCalls++; return 2; } },
  });
  const first = maintenance.run(), second = maintenance.run();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(draftCalls, 1); assert.equal(stateCalls, 1);
  finishDraft(3);
  assert.deepEqual(await first, { checkedAt: now, expiredDraftsRemoved: 3, expiredStatesRemoved: 2 });
  await maintenance.run();
  assert.equal(draftCalls, 2); assert.equal(stateCalls, 2);
  assert.equal(GITHUB_MAINTENANCE_INTERVAL_MS, 300_000);
});

test("both independent purges run on failure; errors disclose no private data and retry is allowed", async () => {
  let fail = true, stateCalls = 0;
  const maintenance = createGitHubMaintenance({
    clock: { now: () => new Date(now) },
    drafts: { purgeExpired() { if (fail) throw new Error("SQL private-upload fake-token"); return Promise.resolve(0); } },
    authorization: { async purgeExpiredStates() { stateCalls++; return 1; } },
  });
  await assert.rejects(maintenance.run(), error => {
    assert.equal((error as { code: string }).code, "GITHUB_MAINTENANCE_FAILED");
    assert.equal((error as { cause?: unknown }).cause, undefined);
    assert.doesNotMatch(String(error), /SQL|private-upload|fake-token/u);
    return true;
  });
  assert.equal(stateCalls, 1);
  fail = false;
  assert.deepEqual(await maintenance.run(), { checkedAt: now, expiredDraftsRemoved: 0, expiredStatesRemoved: 1 });
});

test("an invalid server clock fails before any purge", async () => {
  let calls = 0;
  const maintenance = createGitHubMaintenance({
    clock: { now: () => new Date(NaN) },
    drafts: { async purgeExpired() { calls++; return 0; } },
    authorization: { async purgeExpiredStates() { calls++; return 0; } },
  });
  await assert.rejects(maintenance.run(), { code: "GITHUB_MAINTENANCE_TIME_INVALID" });
  assert.equal(calls, 0);
});
