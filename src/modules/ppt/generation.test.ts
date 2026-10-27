import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { PersonalAiPort, PersonalArtifact, PersonalGenerationRequest } from "../../shared/personal-ai.ts";
import type { PptInput } from "./domain.ts";
import { composePptOutline, createPptGenerationPlan, pptCopyExample } from "./generation.ts";
import { createPptService } from "./service.ts";
import { parseStoredPptOutline } from "./validation.ts";

const input: PptInput = { templateId: "demo-3", durationMinutes: 3, projectIdea: "帮助队伍整理任务", targetUsers: "首次参赛的队伍", completed: ["本地任务列表"], planned: ["待实现多人同步"], evidence: ["手动检查本地保存"] };

test("copy projection ignores additional page prose metadata while retaining the actual required notes", () => {
  const example = pptCopyExample(createPptGenerationPlan(input));
  const enriched = { ...example, slides: example.slides.map(slide => ({ ...slide, speakerNotesPlaceholder: "不要将这个附加字段显示或保存。" })) };
  const expected = composePptOutline(example, input);
  assert.deepEqual(composePptOutline(enriched, input), expected);
  assert.equal(JSON.stringify(composePptOutline(enriched, input)).includes("speakerNotesPlaceholder"), false);
});

test("model constants, factual snapshots, timing, page numbers and demo state never replace trusted structure", () => {
  for (const templateId of ["demo-3", "product-5", "agent-technical"] as const) {
    const project = { ...input, templateId }, plan = createPptGenerationPlan(project), example = pptCopyExample(plan);
    const enriched = { ...example, schemaVersion: 999, templateId: "attacker-template", durationMinutes: 999,
      inputSnapshot: { projectIdea: "另一个项目", completed: ["已经上线"] }, facts: [{ id: "completed-1", kind: "completed", text: "已服务10000名用户" }],
      demonstrationPage: 999,
      slides: example.slides.map((slide, index) => ({ ...slide, number: 900 - index, durationSeconds: 999,
        keyPoints: [{ text: "已服务10000名用户", kind: "provided", factId: "completed-1" }],
        demonstration: { mode: "live", steps: ["虚构已完成演示"], fallback: "" }, facts: ["伪造事实"], speakerNotesPlaceholder: "附加字段" })),
      demonstration: { ...example.demonstration, mode: "recording", number: 999, durationSeconds: 999 },
    };
    const outline = composePptOutline(enriched, project, plan);
    assert.deepEqual(outline, composePptOutline(example, project, plan));
    assert.equal(outline.templateId, templateId);
    assert.equal(outline.durationMinutes, project.durationMinutes);
    assert.deepEqual(outline.inputSnapshot, project);
    assert.equal(outline.slides.reduce((sum, slide) => sum + slide.durationSeconds, 0), project.durationMinutes * 60);
    assert.ok(outline.slides.every((slide, index) => slide.number === index + 1 && slide.durationSeconds === plan.pages[index]!.durationSeconds));
    assert.ok(outline.slides.flatMap(slide => slide.keyPoints).filter(point => point.kind === "provided").every(point => outline.facts.some(fact => fact.id === point.factId && fact.text === point.text)));
    assert.equal(outline.slides.filter(slide => slide.demonstration.mode === "walkthrough").length, 1);
    assert.equal(JSON.stringify(outline).includes("10000"), false);
  }
});

test("extra metadata does not substitute for a missing required copy field or bypass content validation", () => {
  const example = pptCopyExample(createPptGenerationPlan(input));
  const { speakerNotes: _notes, ...withoutNotes } = example.slides[0]!;
  assert.throws(() => composePptOutline({ ...example, slides: [{ ...withoutNotes, speakerNotesPlaceholder: "补充备注" }, ...example.slides.slice(1)] }, input),
    error => error instanceof DomainError && error.recoveryAction === "PPT_SCHEMA:slides.0.keys");
  for (const speakerNotes of [null, [], "已经通过测试", "已服务10000名用户"]) {
    assert.throws(() => composePptOutline({ ...example, slides: [{ ...example.slides[0]!, speakerNotes, speakerNotesPlaceholder: "无害元数据" }, ...example.slides.slice(1)] }, input),
      error => error instanceof DomainError && error.code === "PPT_OUTPUT_INVALID");
  }
  assert.throws(() => composePptOutline({ ...example, unusedMetadata: "x".repeat(60001) }, input),
    error => error instanceof DomainError && error.recoveryAction === "PPT_SCHEMA:bytes");
});

function sourceService(completedCapabilities: string, facts = "手动检查保存结果") {
  const actor = { userId: "owner", platformRoles: ["user" as const] };
  const source: PersonalArtifact = { id: "roadshow-1", kind: "roadshow", title: "本人路演", provider: "dsh", sessionId: "owner-session", createdAt: "2026-10-09T06:00:00.000Z",
    data: { input: { projectIdea: input.projectIdea, targetUsers: input.targetUsers, completedCapabilities, facts,
      pendingValidation: "是否适合真实队伍仍待验证", assumptions: "使用频率仍为假设" } } };
  let calls = 0;
  const ai: PersonalAiPort = {
    async get(current, id) { assert.equal(current.userId, actor.userId); assert.equal(id, source.id); return source; },
    async list() { return []; },
    async generate<T>(current: Actor, request: PersonalGenerationRequest<T>) {
      assert.equal(current.userId, actor.userId); calls++;
      return { ...source, kind: "ppt", data: request.validate(request.outputExample) } as PersonalArtifact<T>;
    },
  };
  return { actor, service: createPptService({ ai }), calls: () => calls };
}

test("thirteen short roadshow lines are inherited intact without changing completion or pending status", async () => {
  const capabilities = Array.from({ length: 13 }, (_, index) => `已完成能力${index + 1}`).join("\n");
  const facts = Array.from({ length: 13 }, (_, index) => `手动记录${index + 1}`).join("\n");
  const context = sourceService(capabilities, facts);
  const result = await context.service.generate(context.actor, { templateId: "demo-3", durationMinutes: 3, artifactId: "roadshow-1" });
  const snapshot = result.data.inputSnapshot;
  assert.equal(snapshot.completed.join("\n"), capabilities);
  assert.equal(snapshot.evidence!.join("\n"), facts);
  assert.deepEqual(snapshot.planned, []);
  assert.ok(snapshot.completed.length <= 12 && snapshot.completed.every(line => line.length <= 600));
  assert.equal(snapshot.completed.some(line => line.includes("待验证")), false);
  assert.equal(context.calls(), 1);
});

test("legal maximum roadshow text is packed within PPT bounds without deleting supplied text", async () => {
  for (const capabilities of ["范围".repeat(1500), Array.from({ length: 500 }, () => "本地流程").join("\n"), ["甲".repeat(601), "乙".repeat(601), "丙".repeat(601), "丁".repeat(601)].join("\n")]) {
    const context = sourceService(capabilities, capabilities);
    const result = await context.service.generate(context.actor, { templateId: "demo-3", durationMinutes: 3, artifactId: "roadshow-1" });
    const snapshot = result.data.inputSnapshot;
    for (const parts of [snapshot.completed, snapshot.evidence!]) {
      assert.ok(parts.length <= 12 && parts.every(part => part.length <= 600));
      assert.equal(parts.join("\n").replace(/\s/gu, ""), capabilities.replace(/\s/gu, ""));
    }
    assert.deepEqual(snapshot.planned, []);
    assert.equal(context.calls(), 1);
  }
});

test("invalid oversized inherited text is rejected before paid generation with a recoverable inheritance error", async () => {
  const context = sourceService("项".repeat(3001));
  await assert.rejects(() => context.service.generate(context.actor, { templateId: "demo-3", durationMinutes: 3, artifactId: "roadshow-1" }),
    error => error instanceof DomainError && error.code === "PPT_ROADSHOW_INPUT_UNAVAILABLE" && error.status === 422);
  assert.equal(context.calls(), 0);
});

test("a concept-only input can produce a clearly incomplete outline without inventing work or successful demos", async () => {
  const context = sourceService(""), concept: PptInput = { ...input, completed: [], planned: [], evidence: [] };
  const result = await context.service.generate(context.actor, concept);
  const outline = result.data;
  assert.deepEqual(outline.inputSnapshot.completed, []);
  assert.deepEqual(outline.inputSnapshot.planned, []);
  assert.equal(outline.facts.some(fact => fact.kind === "completed" || fact.kind === "planned"), false);
  assert.ok(outline.slides.some(slide => slide.keyPoints.some(point => point.kind === "needs_evidence" && /缺少|尚未提供/u.test(point.text))));
  assert.ok(outline.slides.every(slide => slide.demonstration.mode === "none" || slide.demonstration.mode === "walkthrough"));
  for (const mode of ["live", "recording"] as const) {
    const forged = structuredClone(outline), demo = forged.slides.find(slide => slide.demonstration.mode === "walkthrough")!;
    demo.demonstration.mode = mode;
    assert.throws(() => parseStoredPptOutline(forged), DomainError);
  }
  const unsupported = pptCopyExample(createPptGenerationPlan(concept));
  unsupported.slides[0]!.speakerNotes = "已经演示成功";
  assert.throws(() => composePptOutline(unsupported, concept), DomainError);
  assert.equal(context.calls(), 1);
});

test("explicit unimplemented roadshow scope remains status evidence rather than completed or planned work", async () => {
  for (const scope of ["尚未实现，仅有想法", "未实现原型", "尚无代码", "只有一个想法", "目前暂未开发", "还没有任何成果", "还没完成原型"]) {
    const context = sourceService(scope);
    const result = await context.service.generate(context.actor, { templateId: "demo-3", durationMinutes: 3, artifactId: "roadshow-1" });
    const snapshot = result.data.inputSnapshot;
    assert.deepEqual(snapshot.completed, []);
    assert.deepEqual(snapshot.planned, []);
    assert.ok(snapshot.evidence!.some(item => item.includes(scope)));
    assert.equal(result.data.facts.some(fact => fact.kind === "completed" || fact.kind === "planned"), false);
    assert.equal(result.data.slides.some(slide => slide.demonstration.mode === "live" || slide.demonstration.mode === "recording"), false);
  }
});

test("mixed roadshow scope retains known work and all negative status text without creating future commitments", async () => {
  const scope = "已经实现本地列表\n尚未实现多人同步\n只有导出方案想法";
  const context = sourceService(scope);
  const result = await context.service.generate(context.actor, { templateId: "demo-3", durationMinutes: 3, artifactId: "roadshow-1" });
  assert.deepEqual(result.data.inputSnapshot.completed, ["已经实现本地列表"]);
  assert.deepEqual(result.data.inputSnapshot.planned, []);
  assert.ok(result.data.inputSnapshot.evidence!.some(item => item.includes("尚未实现多人同步")));
  assert.ok(result.data.inputSnapshot.evidence!.some(item => item.includes("只有导出方案想法")));
});

test("maximum combined negative scope and evidence are preserved within the twelve-item evidence bound", async () => {
  const scope = Array.from({ length: 4 }, (_, index) => `尚未实现${index}：${"项".repeat(595)}`).join("\n");
  const facts = Array.from({ length: 4 }, (_, index) => `原始记录${index}：${"据".repeat(595)}`).join("\n");
  assert.ok(scope.length <= 3000 && facts.length <= 3000);
  const context = sourceService(scope, facts);
  const result = await context.service.generate(context.actor, { templateId: "demo-3", durationMinutes: 3, artifactId: "roadshow-1" });
  assert.deepEqual(result.data.inputSnapshot.completed, []);
  assert.deepEqual(result.data.inputSnapshot.planned, []);
  const evidence = result.data.inputSnapshot.evidence!;
  assert.ok(evidence.length <= 12 && evidence.every(part => part.length <= 600));
  assert.equal(evidence.join("\n").replace(/\s/gu, ""), [facts, scope].join("\n").replace(/\s/gu, ""));
});
