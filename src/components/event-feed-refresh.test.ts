import { test } from "node:test";
import assert from "node:assert/strict";
import { coveredFeedRevision, shouldRefreshEventFeed, type FeedRefreshState } from "./event-feed-refresh.ts";

const ready = (patch: Partial<FeedRefreshState> = {}): FeedRefreshState => ({ cursor: "", loading: false, failed: false,
  snapshotVersion: "saved", observedVersion: "saved", observedRevision: 1, handledRevision: 0, ...patch });

test("the initial matching snapshot needs no second inventory read, including an empty inventory", () => {
  assert.equal(shouldRefreshEventFeed(ready()), false);
  assert.equal(shouldRefreshEventFeed(ready({ snapshotVersion: "empty-hash", observedVersion: "empty-hash" })), false);
  assert.equal(coveredFeedRevision(0, 1, "saved", "saved"), 1);
});

test("an unmatched observation during a read needs catch-up after that read completes", () => {
  assert.equal(shouldRefreshEventFeed(ready({ loading: true, observedVersion: "changed" })), false);
  const covered = coveredFeedRevision(0, 1, "saved", "changed");
  assert.equal(covered, 0);
  assert.equal(shouldRefreshEventFeed(ready({ observedVersion: "changed", handledRevision: covered })), true);
  assert.equal(coveredFeedRevision(1, 2, "changed-again", "changed-again"), 2);
});

test("a cached live hash causes at most one catch-up per observation, without guessing hash order", () => {
  const covered = coveredFeedRevision(1, 1, "new-snapshot", "cached-snapshot");
  assert.equal(shouldRefreshEventFeed(ready({ snapshotVersion: "new-snapshot", observedVersion: "cached-snapshot", handledRevision: covered })), false);
  assert.equal(shouldRefreshEventFeed(ready({ snapshotVersion: "new-snapshot", observedVersion: "newer-snapshot", observedRevision: 2, handledRevision: covered })), true);
});

test("a failed list retries the same version on a subsequent metadata tick without overlapping reads", () => {
  assert.equal(shouldRefreshEventFeed(ready({ failed: true, handledRevision: 1 })), true);
  assert.equal(shouldRefreshEventFeed(ready({ failed: true, loading: true })), false);
  assert.equal(shouldRefreshEventFeed(ready({ failed: true, observedVersion: null })), false);
});

test("historical pages never auto-reload, even when their read failed", () => {
  assert.equal(shouldRefreshEventFeed(ready({ cursor: "older", observedVersion: "changed" })), false);
  assert.equal(shouldRefreshEventFeed(ready({ cursor: "older", failed: true })), false);
});

test("legacy responses without a snapshot version get one conservative catch-up", () => {
  assert.equal(shouldRefreshEventFeed(ready({ snapshotVersion: null })), true);
  const covered = coveredFeedRevision(1, 1, null, "saved");
  assert.equal(shouldRefreshEventFeed(ready({ snapshotVersion: null, handledRevision: covered })), false);
});
