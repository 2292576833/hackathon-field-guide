import test from "node:test";
import assert from "node:assert/strict";
import { diffPlanInputs, diffPlans, diffSchedules } from "./diff.ts";
import { planDifferenceTimeZoneLabel, presentPlanChanges } from "./diff-presentation.ts";
import { manager, setup } from "./testing/fixtures.ts";

test("persisted task differences show actual owner, priority, deadline, dependency and acceptance values", async () => {
  const c = setup(), original = await c.service.createDraft(manager, "p1", c.draft());
  const tasks = structuredClone(original.tasks), input = structuredClone(original.inputSnapshot);
  const task = tasks[0]!;
  task.ownerMembershipId = "pm1"; task.priority = "optional"; task.dependencyTaskIds = ["testing"];
  task.acceptanceCriteria = ["完成新的演示"];
  task.deadlineRef = "new-deadline";
  input.deadlines.push({ ...input.deadlines[0]!, id: "new-deadline", instantUtc: "2026-10-09T10:00:00Z", sourceText: "10月9日18:00北京时间" });
  const groups = presentPlanChanges(diffPlans(original.tasks, tasks, original.buffers, original.buffers), { beforeInput: original.inputSnapshot, afterInput: input, beforeTasks: original.tasks, afterTasks: tasks, memberNames: { pm1: "小王", pm2: "小李" } });
  const rows = groups.flatMap(group => group.rows);
  assert.deepEqual(rows.find(row => row.label === "负责人"), { label: "负责人", before: "小李", after: "小王" });
  assert.deepEqual(rows.find(row => row.label === "必做或可删减"), { label: "必做或可删减", before: "必须完成", after: "可删减" });
  assert.equal(rows.find(row => row.label === "前置任务")!.after, "testing");
  assert.equal(rows.find(row => row.label === "验收条件")!.before, "完成核心演示");
  assert.match(rows.find(row => row.label === "截止点")!.before, /10\/08.*18:00/);
  assert.match(rows.find(row => row.label === "截止点")!.after, /10\/09.*18:00/);
});

test("input differences expand each changed mandatory requirement, window and deadline field", async () => {
  const c = setup(), original = await c.service.createDraft(manager, "p1", c.draft());
  const input = structuredClone(original.inputSnapshot);
  input.requirements[0]!.mandatory = false;
  input.availability[0]!.windows[0]!.startsAt = "2026-10-08T10:00:00+08:00";
  input.deadlines[0]!.instantUtc = "2026-10-09T10:00:00Z";
  const groups = presentPlanChanges(diffPlanInputs(original.inputSnapshot, input, original.tasks), { beforeInput: original.inputSnapshot, afterInput: input, beforeTasks: original.tasks, afterTasks: original.tasks, memberNames: { pm1: "小王" } });
  const rows = groups.flatMap(group => group.rows);
  assert.equal(rows.find(row => row.label.endsWith("是否必交"))!.before, "是");
  assert.equal(rows.find(row => row.label.endsWith("是否必交"))!.after, "否");
  const window = rows.find(row => row.label.includes("小王") && row.label.endsWith("开始时间"))!;
  assert.match(window.before, /09:00/); assert.match(window.after, /10:00/);
  assert.equal(rows.filter(row => row.label.endsWith("截止时间")).length, 1);
  assert.equal(rows.filter(row => row.label.endsWith("来源时区")).length, 0);
});

test("calculated schedule diffs use the full persisted schedule, and expand buffer minutes", async () => {
  const c = setup(), original = await c.service.createDraft(manager, "p1", c.draft());
  const validation = structuredClone(original.validation!);
  validation.likely.scheduled[0]!.startsAt = "2026-10-08T03:00:00Z";
  validation.likely.scheduled[0]!.finishesAt = "2026-10-08T04:00:00Z";
  const buffers = [{ ...original.buffers[0]!, reservedMinutes: 90 }];
  const changes = [...diffSchedules(original.validation, validation), ...diffPlans(original.tasks, original.tasks, original.buffers, buffers)];
  const rows = presentPlanChanges(changes, { beforeInput: original.inputSnapshot, afterInput: original.inputSnapshot, beforeTasks: original.tasks, afterTasks: original.tasks }).flatMap(group => group.rows);
  assert.match(rows.find(row => row.label === "计算的工作安排 · 开始时间")!.after, /11:00/);
  assert.deepEqual(rows.find(row => row.label.endsWith("预留分钟")), { label: "提交缓冲 · submit · 预留分钟", before: "60", after: "90" });
});

test("timezone fallback explicitly says Beijing and reordered object keys invent no field difference", async () => {
  assert.equal(planDifferenceTimeZoneLabel(), "北京时间（Asia/Shanghai）");
  assert.equal(planDifferenceTimeZoneLabel("invalid-timezone"), "北京时间（Asia/Shanghai）");
  assert.equal(planDifferenceTimeZoneLabel("UTC"), "展示时区：UTC");
  const c = setup(), original = await c.service.createDraft(manager, "p1", c.draft());
  const groups = presentPlanChanges([{ taskId: null, action: "input_changed", fields: ["availabilityVersions"], before: { pm1: 1, pm2: 1 }, after: { pm2: 1, pm1: 1 }, major: true, impact: "版本核对" }], { afterInput: original.inputSnapshot, afterTasks: original.tasks });
  assert.deepEqual(groups, []);
  const freeText = presentPlanChanges([{ taskId: "t1", action: "changed", fields: ["title", "acceptanceCriteria"], before: { title: "todo", acceptanceCriteria: ["work"] }, after: { title: "review", acceptanceCriteria: ["done"] }, major: true, impact: "人工文字核对" }], { afterInput: original.inputSnapshot, afterTasks: original.tasks }).flatMap(group => group.rows);
  assert.equal(freeText.find(row => row.label === "任务名称")!.before, "todo");
  assert.equal(freeText.find(row => row.label === "验收条件")!.after, "done");
});
