import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact, PersonalGenerationRequest } from "../../shared/personal-ai.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { PptInput, PptOutline } from "./domain.ts";
import { outlineMarkdown, outlinePrintHtml } from "./export.ts";
import { composePptOutline, createPptGenerationPlan, pptCopyExample } from "./generation.ts";
import { createPptService } from "./service.ts";
import { getPptTemplate } from "./templates.ts";
import { parseStoredPptOutline, validatePptInput, validatePptOutline } from "./validation.ts";

const actor: Actor = { userId: "owner", platformRoles: ["user"] };
const input: PptInput = { templateId: "demo-3", durationMinutes: 3, projectIdea: "帮助新人安排参赛任务", targetUsers: "第一次参赛的队伍", completed: ["已完成本地任务列表"], planned: ["待实现多人同步"], evidence: ["本机手动验证增删任务"] };
function modelResult(project: PptInput = input) {
  return { schemaVersion: 1, title: "任务列表项目", templateId: project.templateId, durationMinutes: project.durationMinutes,
    slides: [1, 2, 3].map(number => ({ number, title: ["使用场景", "当前原型", "下一步"][number - 1], keyPoints: [{ text: project.projectIdea, kind: "provided", factId: "idea" }], visualSuggestion: "使用文字说明或实际界面截图。", speakerNotes: "说明当前范围和待实现内容，不宣称未验证的效果。", durationSeconds: project.durationMinutes * 20,
      demonstration: { mode: number === 2 ? "walkthrough" : "none", steps: number === 2 ? ["建议展示任务输入与列表。"] : [], fallback: number === 2 ? "建议使用截图说明流程。" : "" } })),
    rehearsalChecklist: ["按计时器排练，核对演示是否可用。"], warnings: ["用户输入未经独立核验。"] };
}
function modelCopy(project: PptInput = input) {
  return { title: "任务列表项目", slides: getPptTemplate(project.templateId).slides.map(slide => ({ title: slide.title,
    suggestions: ["建议按真实范围补充本页表达。"], visualSuggestion: "使用文字说明或实际界面截图。", speakerNotes: "说明当前范围和待实现内容，不宣称未验证的效果。" })),
    demonstration: { steps: ["建议讲解任务输入与列表流程。"], fallback: "建议使用已有截图说明；没有材料则讲解概念。" },
    rehearsalChecklist: ["按计时器排练，核对演示是否可用。"], warnings: ["用户输入未经独立核验。"] };
}
function artifact(data: unknown, kind: "ppt" | "roadshow" = "ppt"): PersonalArtifact {
  return { id: "artifact-1", kind, title: "我的项目", data, createdAt: "2026-10-09T06:00:00.000Z", provider: "dsh", sessionId: "owner-session" };
}
function fakeAi(source?: PersonalArtifact) {
  const calls: { request: PersonalGenerationRequest<unknown>; actor: Actor; guard?: FreshSessionGuard }[] = [];
  const reads: { actor: Actor; id: string; guard?: FreshSessionGuard }[] = [];
  const ai: PersonalAiPort = {
    async generate<T>(current: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard) {
      calls.push({ actor: current, request, guard });
      const project = (request.input as { project: PptInput }).project;
      return { ...artifact(request.validate(modelCopy(project))), data: request.validate(modelCopy(project)) } as PersonalArtifact<T>;
    },
    async list(current, kind, guard) { assert.equal(current, actor); assert.equal(kind, "ppt"); return [artifact(validatePptOutline(modelResult(), input))]; },
    async get(current, id, guard) { reads.push({ actor: current, id, guard }); if (current.userId !== "owner" || !source || id !== source.id) throw new DomainError("ARTIFACT_NOT_FOUND", "记录不存在。", { status: 404 }); return source; },
  };
  return { ai, calls, reads };
}
test("input enforces scopes, integer duration, field/byte/content bounds before model use", () => {
  assert.deepEqual(validatePptInput(input), input);
  for (const change of [{ durationMinutes: 0 }, { durationMinutes: 16 }, { durationMinutes: 3.5 }, { projectIdea: "x".repeat(2001) }, { completed: Array(13).fill("范围") }, { projectIdea: "bad\u0000" }, { artifactId: "../other" }, { userId: "other" }, { projectIdea: "中".repeat(2000), targetUsers: "中".repeat(1000), completed: Array(12).fill("中".repeat(600)), planned: Array(12).fill("中".repeat(600)) }]) {
    assert.throws(() => validatePptInput({ ...input, ...change }), DomainError);
  }
});
test("structured slides bind input, exact factual quotes, sequential pages and total demo-inclusive time", () => {
  const result = validatePptOutline(modelResult(), input);
  assert.equal(result.slides.reduce((sum, slide) => sum + slide.durationSeconds, 0), 180);
  assert.deepEqual(result.inputSnapshot, input);
  assert.equal(result.facts.find(fact => fact.id === "completed-1")?.text, input.completed[0]);
  assert.deepEqual(parseStoredPptOutline(result), result);
  assert.equal(result.warnings.length, 2);
});
test("invalid facts, fields, lengths, counts and duration are rejected without silent repair", () => {
  const variants = [
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.number = 3; },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.durationSeconds = 59; },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.keyPoints[0]!.text = "伪造了一万用户"; },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.keyPoints[0]!.factId = "unknown"; },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.speakerNotes = "x".repeat(2201); },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.title = "x".repeat(101); },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.keyPoints = []; },
    (value: ReturnType<typeof modelResult>) => { value.slides[0]!.demonstration.steps = ["none不能含演示步骤"]; },
  ];
  for (const mutate of variants) { const value = modelResult(); mutate(value); assert.throws(() => validatePptOutline(value, input), error => error instanceof DomainError && error.code === "PPT_OUTPUT_INVALID"); }
  assert.throws(() => validatePptOutline({ ...modelResult(), inputSnapshot: { userId: "other" } }, input), DomainError);
  assert.throws(() => parseStoredPptOutline({ ...validatePptOutline(modelResult(), input), facts: [] }), DomainError);
});
test("unprovided metrics and successful outcomes in notes are rejected; explicit validation targets remain conditional", () => {
  for (const text of ["已有10000名用户", "准确率99%", "已经通过测试", "我们获得一等奖", "我们全球首创"]) {
    const value = modelResult(); value.slides[0]!.speakerNotes = text;
    assert.throws(() => validatePptOutline(value, input), DomainError);
  }
  const conditional = modelResult(); conditional.slides[0]!.speakerNotes = "目标：准确率99%，需要验证。";
  assert.doesNotThrow(() => validatePptOutline(conditional, input));
  const changed = modelResult(); changed.slides[0]!.speakerNotes = "准确率99%";
  assert.throws(() => validatePptOutline(changed, { ...input, evidence: ["假设：准确率99%"] }), DomainError);
});
test("a project with only planned work cannot become a live/recorded demo", () => {
  const concept = { ...input, completed: [] }, value = modelResult(concept);
  value.slides[1]!.demonstration.mode = "live";
  assert.throws(() => validatePptOutline(value, concept), DomainError);
  value.slides[1]!.demonstration.mode = "walkthrough";
  assert.doesNotThrow(() => validatePptOutline(value, concept));
});
test("generation calls only injected personal DSH port and forwards current session guard", async () => {
  const { ai, calls } = fakeAi(), guard: FreshSessionGuard = async () => {};
  const service = createPptService({ ai }), saved = await service.generate(actor, input, guard);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.actor, actor); assert.equal(calls[0]!.guard, guard);
  assert.equal(calls[0]!.request.kind, "ppt"); assert.equal(saved.provider, "dsh"); assert.equal(saved.data.inputSnapshot.projectIdea, input.projectIdea);
  await assert.rejects(() => service.generate({ userId: "", platformRoles: [] }, input), error => error instanceof DomainError && error.status === 401);
  await assert.rejects(() => service.generate(actor, { ...input, durationMinutes: 30 }), DomainError);
  assert.equal(calls.length, 1);
});
test("the model JSON example satisfies the validator for all templates at duration limits", async () => {
  const { ai, calls } = fakeAi();
  const service = createPptService({ ai });
  for (const templateId of ["demo-3", "product-5", "agent-technical"] as const) for (const durationMinutes of [1, 15]) {
    await service.generate(actor, { ...input, templateId, durationMinutes });
    const request = calls.at(-1)!.request;
    assert.doesNotThrow(() => request.validate(request.outputExample));
  }
});
test("v2 composes all 45 template/duration combinations with exact trusted timing and preserves old history", () => {
  for (const templateId of ["demo-3", "product-5", "agent-technical"] as const) for (let durationMinutes = 1; durationMinutes <= 15; durationMinutes++) {
    const project: PptInput = { ...input, templateId, durationMinutes }, outline = composePptOutline(modelCopy(project), project);
    assert.equal(outline.slides.length, getPptTemplate(templateId).slides.length);
    assert.equal(outline.slides.reduce((sum, slide) => sum + slide.durationSeconds, 0), durationMinutes * 60);
    assert.ok(outline.slides.every(slide => slide.durationSeconds >= 5 && slide.keyPoints.length <= 5));
    assert.deepEqual(parseStoredPptOutline(outline), outline);
  }
  const existing = validatePptOutline(modelResult(), input);
  assert.deepEqual(parseStoredPptOutline(existing), existing);
});
test("long legal idea/user inputs no longer create an invalid model example or require altered factual quotes", async () => {
  for (const length of [601, 2000]) {
    const project = { ...input, projectIdea: "项".repeat(length), targetUsers: "人".repeat(1000) }, { ai, calls } = fakeAi();
    const saved = await createPptService({ ai }).generate(actor, project);
    assert.equal(saved.data.inputSnapshot.projectIdea.length, length);
    assert.equal(saved.data.facts.find(fact => fact.id === "idea")!.text.length, length);
    assert.equal(saved.data.facts.find(fact => fact.id === "target-users")!.text.length, 1000);
    assert.ok(saved.data.slides.flatMap(slide => slide.keyPoints).every(point => point.text.length <= 600));
    const request = calls[0]!.request;
    assert.equal(request.promptVersion, "personal-ppt-copy-v3");
    assert.doesNotThrow(() => request.validate(request.outputExample));
    assert.ok(saved.data.slides.some(slide => slide.keyPoints.some(point => point.kind === "needs_evidence")));
  }
});
test("copy projection still rejects missing required fields, count/type/length errors with safe diagnostics", () => {
  const variants = [
    { value: { ...modelCopy(), title: undefined }, path: "title" },
    { value: { ...modelCopy(), warnings: undefined }, path: "warnings" },
    { value: { ...modelCopy(), slides: modelCopy().slides.slice(1) }, path: "slides.count" },
    { value: { ...modelCopy(), slides: [null, ...modelCopy().slides.slice(1)] }, path: "slides.0.type" },
    { value: { ...modelCopy(), demonstration: { steps: [], fallback: "备用" } }, path: "demonstration.steps" },
    { value: { ...modelCopy(), demonstration: { mode: "live", steps: ["操作"] } }, path: "demonstration.keys" },
  ];
  for (const { value, path } of variants) assert.throws(() => composePptOutline(value, input), error => error instanceof DomainError && error.code === "PPT_OUTPUT_INVALID" && error.recoveryAction === `PPT_SCHEMA:${path}`);
  for (const change of [{ speakerNotes: undefined }, { speakerNotes: "私密".repeat(1101) }, { title: "t".repeat(101) }, { suggestions: ["一", "二", "三"] }, { suggestions: ["x".repeat(251)] }, { visualSuggestion: "x".repeat(801) }]) {
    const value = modelCopy(); value.slides[0] = { ...value.slides[0]!, ...change } as typeof value.slides[number];
    assert.throws(() => composePptOutline(value, input), error => error instanceof DomainError && error.code === "PPT_OUTPUT_INVALID" && !error.recoveryAction?.includes("私密"));
  }
});
test("v2 retains original factual and outcome constraints across every model text field", () => {
  for (const claim of ["已有10000名用户", "准确率99%", "已经通过测试", "我们获得一等奖", "我们全球首创"]) {
    const value = modelCopy(); value.slides[0]!.speakerNotes = claim;
    assert.throws(() => composePptOutline(value, input), error => error instanceof DomainError && error.code === "PPT_OUTPUT_INVALID" && error.recoveryAction === "PPT_SCHEMA:final.content_or_bounds");
    const suggestion = modelCopy(); suggestion.slides[0]!.suggestions = [claim];
    assert.throws(() => composePptOutline(suggestion, input), DomainError);
  }
  const concept = { ...input, completed: [] }, saved = composePptOutline(modelCopy(concept), concept);
  assert.equal(saved.slides.filter(slide => slide.demonstration.mode !== "none").length, 1);
  assert.equal(saved.slides.find(slide => slide.demonstration.mode !== "none")!.demonstration.mode, "walkthrough");
  const fixed = createPptGenerationPlan(input), example = pptCopyExample(fixed), savedExample = composePptOutline(example, input, fixed);
  assert.ok(savedExample.slides.flatMap(slide => slide.keyPoints).filter(point => point.kind === "provided").every(point => savedExample.facts.some(fact => fact.id === point.factId && fact.text === point.text)));
});
test("the complete copy example is preflighted before sending a paid request", async () => {
  const { ai, calls } = fakeAi();
  await assert.rejects(() => createPptService({ ai }).generate(actor, { ...input, projectIdea: "我们全球首创" }), error => error instanceof DomainError && error.code === "PPT_INPUT_NEEDS_REVIEW" && error.status === 422);
  assert.equal(calls.length, 0);
});
test("roadshow inheritance reads owner-scoped stored input and overwrites untrusted browser project fields", async () => {
  const source = artifact({ inputSnapshot: input }, "roadshow"), { ai, calls, reads } = fakeAi(source), guard: FreshSessionGuard = async () => {};
  const result = await createPptService({ ai }).generate(actor, { ...input, artifactId: source.id, projectIdea: "浏览器注入另一项目", completed: ["伪造完成"] }, guard);
  assert.equal(reads[0]!.actor, actor); assert.equal(reads[0]!.guard, guard);
  assert.equal(result.data.inputSnapshot.projectIdea, input.projectIdea);
  assert.deepEqual(result.data.inputSnapshot.completed, input.completed);
  assert.equal(calls.length, 1);
  await assert.rejects(() => createPptService({ ai }).generate({ ...actor, userId: "other" }, { ...input, artifactId: source.id }, guard), error => error instanceof DomainError && error.status === 404);
  assert.equal(calls.length, 1);
});
test("real RoadshowDocument inherits string capabilities/facts while pending validation remains context", async () => {
  const source = artifact({ input: { projectIdea: input.projectIdea, targetUsers: input.targetUsers, problem: "新人容易漏掉任务", completedCapabilities: input.completed[0], pendingValidation: "多人同步尚未验证", facts: "本机测试记录", assumptions: "用户可能愿意共用列表", technicalApproach: "使用本地持久化", differentiation: "目前聚焦任务列表", durationSeconds: 180 },
    script: { opening: { text: "介绍新人任务列表", durationSeconds: 20 }, segments: [{ title: "问题", text: "解释用户任务", durationSeconds: 40 }, { title: "原型流程", text: "说明任务输入流程", durationSeconds: 100 }], closing: { text: "邀请核验反馈", durationSeconds: 20 }, demoSteps: [{ action: "打开任务列表", expectedResult: "显示已保存任务", fallback: "用截图说明" }], qa: [], verificationItems: ["多人同步待验证"], totalDurationSeconds: 180 } }, "roadshow");
  const { ai, calls } = fakeAi(source);
  const result = await createPptService({ ai }).generate(actor, { templateId: "demo-3", durationMinutes: 3, artifactId: source.id });
  assert.deepEqual(result.data.inputSnapshot.completed, input.completed);
  assert.deepEqual(result.data.inputSnapshot.planned, []);
  assert.deepEqual(result.data.inputSnapshot.evidence, ["本机测试记录"]);
  assert.equal((calls[0]!.request.input as { sourceRoadshow: { input: { technicalApproach: string } } }).sourceRoadshow.input.technicalApproach, "使用本地持久化");
  assert.equal((calls[0]!.request.input as { sourceRoadshow: { input: { pendingValidation: string } } }).sourceRoadshow.input.pendingValidation, "多人同步尚未验证");
});
test("wrong artifact kind prevents generation and unknown provider result is never retried or replaced", async () => {
  const { ai, calls } = fakeAi(artifact({ inputSnapshot: input }, "ppt"));
  await assert.rejects(() => createPptService({ ai }).generate(actor, { ...input, artifactId: "artifact-1" }), DomainError);
  assert.equal(calls.length, 0);
  let attempts = 0;
  ai.generate = async () => { attempts++; throw new DomainError("AI_PREVIOUS_REQUEST_UNKNOWN", "结果未知。", { status: 409 }); };
  await assert.rejects(() => createPptService({ ai }).generate(actor, input), error => error instanceof DomainError && error.code === "AI_PREVIOUS_REQUEST_UNKNOWN");
  assert.equal(attempts, 1);
});
test("profile lookup is account scoped; only idea/presentation experience are used", async () => {
  const profile: ParticipantProfile = { userId: "owner", revision: 1, firstHackathon: true, developmentExperience: "none", city: "", skills: [], interests: [], projectIdea: input.projectIdea, availableHoursPerDay: 2, travelPreference: "local", presentationExperience: "none", updatedAt: null };
  const { ai, calls } = fakeAi(), guard: FreshSessionGuard = async () => {};
  await createPptService({ ai, profiles: { async get(current, currentGuard) { assert.equal(current, actor); assert.equal(currentGuard, guard); return profile; } } }).generate(actor, { ...input, projectIdea: "" }, guard);
  assert.equal((calls[0]!.request.input as { presentationExperience: string }).presentationExperience, "none");
  assert.equal(JSON.stringify(calls[0]!.request.input).includes('"availableHoursPerDay"'), false);
  await assert.rejects(() => createPptService({ ai, profiles: { async get() { return { ...profile, userId: "other" }; } } }).generate(actor, input), error => error instanceof DomainError && error.status === 403);
});
test("history uses the same injected private port and rejects non-PPT artifacts", async () => {
  const stored = artifact(validatePptOutline(modelResult(), input)), { ai, reads } = fakeAi(stored), guard: FreshSessionGuard = async () => {};
  assert.equal((await createPptService({ ai }).get(actor, stored.id, guard)).data.slides.length, 3);
  assert.equal(reads[0]!.guard, guard);
  assert.equal((await createPptService({ ai }).list(actor, guard)).length, 1);
  const wrong = fakeAi(artifact({ inputSnapshot: input }, "roadshow"));
  await assert.rejects(() => createPptService({ ai: wrong.ai }).get(actor, "artifact-1"), DomainError);
});
test("Markdown/HTML exports preserve notes, labels, timings and escape untrusted markup without scripts", () => {
  const unsafe = { ...input, projectIdea: '<script>alert("test")</script>' }, outline = validatePptOutline(modelResult(unsafe), unsafe);
  const markdown = outlineMarkdown(outline), printable = outlinePrintHtml(outline);
  assert.match(markdown, /不是 \.pptx/); assert.match(markdown, /讲者备注/); assert.match(markdown, /60 秒/);
  assert.equal(markdown.includes("<script>"), false); assert.equal(printable.includes("<script>"), false);
  assert.match(printable, /&lt;script&gt;/); assert.match(printable, /Content-Security-Policy/); assert.match(printable, /@media print/);
  assert.equal(printable.includes("https://"), false);
});
