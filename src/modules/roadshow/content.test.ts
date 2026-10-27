import test from "node:test";
import assert from "node:assert/strict";
import { readRoadshowIdea, roadshowAllocation, roadshowPptHref } from "./content.ts";

test("bounded text-only idea may be carried in an incoming URL", () => {
  assert.equal(readRoadshowIdea("?idea=%E5%81%9A%E4%B8%80%E4%B8%AA%E8%B7%AF%E6%BC%94%E5%B7%A5%E5%85%B7"), "做一个路演工具");
  assert.equal(readRoadshowIdea("?idea=a&idea=b"), null);
  assert.equal(readRoadshowIdea("?idea=%00secret"), null);
  assert.equal(readRoadshowIdea(`?idea=${"a".repeat(1201)}`), null);
  assert.equal(readRoadshowIdea("?idea="), null);
});

test("rehearsal diagram preserves the complete time budget and leaves buffer", () => {
  for (const duration of [60, 180, 305, 900]) {
    const allocation = roadshowAllocation(duration);
    assert.equal(allocation.reduce((sum, item) => sum + item.seconds, 0), duration);
    assert.ok(allocation.every(item => item.seconds > 0));
    assert.ok(allocation.at(-1)!.seconds >= duration * .1);
  }
  assert.throws(() => roadshowAllocation(59));
  assert.throws(() => roadshowAllocation(180.5));
});

test("PPT handoff contains only the artifact reference", () => {
  assert.equal(roadshowPptHref("record_123"), "/ppt?roadshowId=record_123");
  assert.throws(() => roadshowPptHref("私有项目想法 / key"));
  assert.throws(() => roadshowPptHref("https://example.com"));
});
