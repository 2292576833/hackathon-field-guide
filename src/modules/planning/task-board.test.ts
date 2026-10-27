import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskBoard, dependentTaskIds, unmetDependencies } from "./task-board.ts";
import type { PlanningTask } from "./types.ts";
import { taskProposal } from "./testing/fixtures.ts";

function task(id: string, changes: Partial<PlanningTask> = {}): PlanningTask {
  return { ...taskProposal(id), status: "todo", remainingEstimate: null, blocker: null, cancellationReason: null, acceptance: null, revision: 0, updatedAt: "2026-10-09T01:00:00Z", ...changes };
}
const acceptance = { acceptedByUserId: "manager", acceptedAt: "2026-10-09T01:00:00Z", mode: "manager" as const, note: "按条件通过", evidenceRefs: ["artifact"] };
test("completion reports stay pending while independent preparation can proceed", () => {
  const tasks = [task("demo", { status: "review" }), task("video", { dependencyTaskIds: ["demo"] }), task("colours"), task("script")];
  const board = buildTaskBoard(tasks, { planReady: true, activeMembershipIds: ["pm2"] });
  assert.equal(board.find(value => value.task.id === "demo")?.group, "review");
  assert.deepEqual(board.filter(value => value.group === "ready").map(value => value.task.id), ["colours", "script"]);
  assert.equal(board.find(value => value.task.id === "video")?.waitingFor[0]?.title, "demo");
  tasks[0]!.status = "done"; tasks[0]!.acceptance = acceptance;
  assert.equal(buildTaskBoard(tasks, { planReady: true, activeMembershipIds: ["pm2"] }).find(value => value.task.id === "video")?.group, "ready");
});
test("missing predecessor, missing acceptance, stale plan and departed owner are explicit", () => {
  const tasks = [task("demo", { status: "done" }), task("video", { dependencyTaskIds: ["demo", "gone"] })];
  assert.equal(unmetDependencies(tasks[1]!, tasks).length, 2);
  assert.equal(unmetDependencies(tasks[1]!, tasks)[1]?.missing, true);
  const board = buildTaskBoard(tasks, { planReady: false, activeMembershipIds: [] });
  assert.equal(board.every(value => value.group === "waiting"), true);
  assert.equal(board[1]?.needs.length, 2);
});
test("correction impact includes transitive live dependents with stable IDs", () => {
  const tasks = [task("demo"), task("video", { dependencyTaskIds: ["demo"] }), task("submit", { dependencyTaskIds: ["video", "demo"] }), task("colours"), task("discarded", { dependencyTaskIds: ["demo"], status: "cancelled" })];
  assert.deepEqual(dependentTaskIds("demo", tasks), ["submit", "video"]);
});
test("a task with no available capacity does not hide independent preparation", () => {
  const board = buildTaskBoard([task("video"), task("script"), task("api", { status: "blocked", blocker: "等接口" })], { planReady: true, activeMembershipIds: ["pm2"], taskNeeds: { video: ["录制缺少连续工作时间"] } });
  assert.equal(board[0]?.group, "waiting"); assert.equal(board[1]?.group, "ready"); assert.equal(board[2]?.group, "waiting");
});
