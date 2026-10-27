import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpaceGuideFactStatus, SpaceGuideStep } from "./guide-tree.ts";
import { deriveSpaceStepState, findSpaceStepForNode } from "./step-state.ts";

function step(statuses: SpaceGuideFactStatus[], id: SpaceGuideStep["id"] = "planning"): SpaceGuideStep {
  return { id, title: "步骤", summary: "说明", next: "下一步", nodes: statuses.map((status, index) => ({
    id: `action-${index}`, title: "行动", when: "需要时", actions: [], condition: "真实记录", links: [], tools: [], next: "继续",
    fact: { status, label: "事实状态", explanation: "依据" },
  })) };
}

test("only a nonempty step whose every fact is recorded can claim recorded evidence", () => {
  const result = deriveSpaceStepState(step(["recorded", "recorded"]), "planning");
  assert.equal(result.allRecorded, true);
  assert.equal(result.status, "recorded");
  assert.equal(result.label, "已有记录");
  assert.equal(result.current, true);
  assert.equal(deriveSpaceStepState(step([]), "planning").allRecorded, false);
});

test("unread, loading and failed facts never appear as completed or recorded", () => {
  for (const status of ["unknown", "loading", "error"] as const) {
    const result = deriveSpaceStepState(step(["recorded", status]), "planning");
    assert.equal(result.allRecorded, false);
    assert.equal(result.status, status);
    assert.doesNotMatch(result.label, /完成|已有记录|有人等你/);
  }
});

test("a rules review is a neutral recheck, not a teammate waiting or task blockage", () => {
  const result = deriveSpaceStepState(step(["recorded", "review"], "rules"), "execution");
  assert.equal(result.status, "review");
  assert.equal(result.label, "需要复核");
  assert.equal(result.allRecorded, false);
  assert.equal(result.current, false);
  assert.doesNotMatch(result.label, /有人等你|阻塞/);
});

test("a suggested stage does not lock other stages or manufacture completion", () => {
  assert.equal(deriveSpaceStepState(step(["prepare", "check"]), "planning").status, "current");
  assert.equal(deriveSpaceStepState(step(["recorded", "check"]), "rules").status, "pending");
  assert.equal(deriveSpaceStepState(step(["check"]), "planning").allRecorded, false);
});

test("failed reads take priority over stale recorded evidence or pending review", () => {
  assert.equal(deriveSpaceStepState(step(["recorded", "review", "error"]), "planning").status, "error");
  assert.equal(deriveSpaceStepState(step(["recorded", "review", "loading"]), "planning").status, "loading");
});

test("todo actions resolve to their exact stage and unknown actions resolve to nothing", () => {
  const stages = [step(["prepare"], "enter"), step(["check"], "planning")];
  stages[0]!.nodes[0]!.id = "goal";
  stages[1]!.nodes[0]!.id = "duties-time";
  assert.equal(findSpaceStepForNode(stages, "goal")?.id, "enter");
  assert.equal(findSpaceStepForNode(stages, "duties-time")?.id, "planning");
  assert.equal(findSpaceStepForNode(stages, "planning")?.id, "planning");
  assert.equal(findSpaceStepForNode(stages, "not-a-guide-node"), undefined);
});
