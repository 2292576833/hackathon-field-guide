import assert from "node:assert/strict";
import test from "node:test";
import { diffPlans } from "./diff.ts";
import { presentPlanChanges } from "./diff-presentation.ts";
import { inputFixture, taskProposal } from "./testing/fixtures.ts";
import type { PlanningTask } from "./types.ts";
import type { TaskSkillReference } from "../skills/index.ts";

function task(skillRefs?: readonly TaskSkillReference[]): PlanningTask { return { ...taskProposal(), id: "t1", ...(skillRefs === undefined ? {} : { skillRefs: [...skillRefs] }), status: "todo", remainingEstimate: null, blocker: null, cancellationReason: null, acceptance: null, revision: 1, updatedAt: "2026-10-10T08:00:00Z" }; }
function reference(): TaskSkillReference { return { reference: { kind: "skill", id: "demo-guide", version: "1.0.0", versionId: "version-1", contentHash: "a".repeat(64), revision: 2 }, purpose: "准备演示说明", learningMinutes: 20, environment: { agentId: "codex", os: "Windows" } }; }

test("legacy absent/empty skills and JSONB property ordering produce no artificial task definition changes", () => {
  assert.deepEqual(diffPlans([task()], [task([])], [], []), []);
  const before = reference(); const after = { ...before, reference: Object.fromEntries(Object.entries(before.reference).reverse()), environment: Object.fromEntries(Object.entries(before.environment).reverse()) } as TaskSkillReference;
  assert.deepEqual(diffPlans([task([before])], [task([after])], [], []), []);
});
test("fixed skill version, purpose and learning changes are major persisted differences with explicit old/new values", () => {
  const before = reference(); const after = { ...before, reference: { ...before.reference, version: "2.0.0", versionId: "version-2", contentHash: "b".repeat(64), revision: 3 }, purpose: "准备视频演示说明", learningMinutes: 30 };
  const changes = diffPlans([task([before])], [task([after])], [], []);
  assert.deepEqual(changes[0]!.fields, ["skillRefs"]); assert.equal(changes[0]!.major, true);
  const groups = presentPlanChanges(changes, { beforeInput: inputFixture(), afterInput: inputFixture(), beforeTasks: [task([before])], afterTasks: [task([after])] });
  const rows = groups[0]!.rows;
  assert.ok(rows.some(row => row.label.includes("技能版本") && row.before === "1.0.0" && row.after === "2.0.0"));
  assert.ok(rows.some(row => row.label.includes("用途") && row.before === before.purpose && row.after === after.purpose));
  assert.ok(rows.some(row => row.label.includes("学习与接入分钟") && row.before === "20" && row.after === "30"));
});
