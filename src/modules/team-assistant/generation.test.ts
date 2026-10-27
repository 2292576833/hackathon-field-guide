import assert from "node:assert/strict";
import test from "node:test";
import { FEASIBILITY_OUTPUT_EXAMPLE, safeAssistantHref, validateAssistantAnswer, validateFeasibilityReport } from "./generation.ts";

test("assistant accepts only selected server-owned link IDs and bounded text", () => {
  assert.deepEqual(validateAssistantAnswer({ reply: "先交可运行示例。", linkIds: ["tool"] }, [{ id: "tool", label: "工具", href: "/resources" }]), { reply: "先交可运行示例。", linkIds: ["tool"] });
  for (const output of [{ reply: "", linkIds: [] }, { reply: "回答", linkIds: ["invented"] }, { reply: "回答", linkIds: ["tool", "tool"] }, { reply: "中".repeat(5400), linkIds: [] }]) assert.throws(() => validateAssistantAnswer(output, [{ id: "tool", label: "工具", href: "/resources" }]));
});
test("assistant links stay in the current space and permitted site destinations", () => {
  for (const href of ["/resources", "/library/first", "/projects/p-one/planning", "/app/projects/p-one/plan", "/github", "/github?projectId=p-one", "/roadshow?projectId=p-one", "/ppt?projectId=p-one", "/skills?tool=codex#install"]) assert.equal(safeAssistantHref(href, "p-one"), true, href);
  for (const href of ["https://example.com", "//evil.test", "/admin", "/projects/p-two", "/app/projects/p-two/plan", "/projects/p-one/../../admin", "/resources\\evil", "/api/secret", "/resources%00", "/github?projectId=p-two", "/roadshow?projectId=p-one&projectId=p-two", "/ppt?projectId=p-one&redirect=https://evil.test", "/ppt?userId=victim", "/app/projects/p-one?userId=victim", "/resources?redirect=//evil.test", "/app/projects/p-one/%2f../p-two"]) assert.equal(safeAssistantHref(href, "p-one"), false, href);
});
test("feasibility separates unknowns and suggested tasks without adoption fields", () => {
  const report = validateFeasibilityReport({ ...FEASIBILITY_OUTPUT_EXAMPLE, adoptGoal: true }, []);
  assert.equal(report.ruleFit[0]!.knowledge, "unknown");
  assert.equal(report.technicalChecks[0]!.knowledge, "needs_verification");
  assert.equal("adoptGoal" in report, false);
  assert.equal(report.validationTasks[0]!.check, "演示结果与预期一致");
});
test("feasibility rejects invented evidence, uncited known facts, and cyclic dependencies", () => {
  for (const finding of [
    { title: "真实接口", detail: "已可用", knowledge: "known", evidenceSourceIds: [] },
    { title: "规则", detail: "已确认", knowledge: "known", evidenceSourceIds: ["invented"] },
    { title: "规则", detail: "有说法", knowledge: "guess", evidenceSourceIds: [] },
  ]) assert.throws(() => validateFeasibilityReport({ ...FEASIBILITY_OUTPUT_EXAMPLE, ruleFit: [finding] }, ["official"]));
  assert.throws(() => validateFeasibilityReport({ ...FEASIBILITY_OUTPUT_EXAMPLE, validationTasks: [{ ...FEASIBILITY_OUTPUT_EXAMPLE.validationTasks[0], title: "A", dependsOn: ["A"] }] }, []));
  assert.throws(() => validateFeasibilityReport({ ...FEASIBILITY_OUTPUT_EXAMPLE, validationTasks: [{ ...FEASIBILITY_OUTPUT_EXAMPLE.validationTasks[0], dependsOn: ["missing"] }] }, []));
  assert.equal(validateFeasibilityReport({ ...FEASIBILITY_OUTPUT_EXAMPLE, ruleFit: [{ title: "赛道", detail: "当前已确认的赛道", knowledge: "known", evidenceSourceIds: ["official"] }] }, ["official"]).ruleFit[0]!.knowledge, "known");
});
