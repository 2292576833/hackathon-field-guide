import { DomainError } from "../../shared/errors.ts";
import type { PptFact, PptInput, PptOutline, PptPoint, PptSlide, PptTemplateId } from "./domain.ts";
import { assertProjectPlansStayPlanned, validatePresentationProjectSnapshot } from "../roadshow/index.ts";

const templateIds: PptTemplateId[] = ["demo-3", "product-5", "agent-technical"];
const encoder = new TextEncoder();
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function invalid(output = false): never {
  throw new DomainError(output ? "PPT_OUTPUT_INVALID" : "PPT_INPUT_INVALID", output
    ? "DSH 返回的大纲不符合内容或时长要求，未作为可用 PPT 保存。"
    : "请检查项目说明、逐行内容、模板与路演时长。", { status: output ? 502 : 422 });
}
export function pptRecord(value: unknown, output = false): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(output);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], output = false) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(output);
}
export function pptText(value: unknown, max: number, output = false, empty = false): string {
  if (typeof value !== "string" || value.length > max || control.test(value)) invalid(output);
  const text = value.trim();
  if (!text && !empty) invalid(output);
  return text;
}
function texts(value: unknown, maxItems: number, maxLength: number, output = false, minItems = 0): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.length < minItems) invalid(output);
  return value.map(item => pptText(item, maxLength, output));
}
function bytes(value: unknown, max: number, output = false) {
  try { if (encoder.encode(JSON.stringify(value)).byteLength > max) invalid(output); }
  catch { invalid(output); }
}
/** Allows blank idea only before the optional account-scoped profile/source lookup. */
export function validatePptInput(value: unknown, allowBlankIdea = false): PptInput {
  bytes(value, 32000);
  const data = pptRecord(value);
  keys(data, ["templateId", "durationMinutes", "projectName", "projectIdea", "targetUsers", "completed", "planned", "evidence", "artifactId"]);
  if (!templateIds.includes(data.templateId as PptTemplateId)) invalid();
  if (typeof data.durationMinutes !== "number" || !Number.isInteger(data.durationMinutes) || data.durationMinutes < 1 || data.durationMinutes > 15) invalid();
  const result: PptInput = {
    templateId: data.templateId as PptTemplateId, durationMinutes: data.durationMinutes,
    projectIdea: pptText(data.projectIdea, 2000, false, allowBlankIdea),
    targetUsers: pptText(data.targetUsers, 1000), completed: texts(data.completed, 12, 600), planned: texts(data.planned, 12, 600),
  };
  if (data.projectName !== undefined) result.projectName = pptText(data.projectName, 120, false, true);
  if (data.evidence !== undefined) result.evidence = texts(data.evidence, 12, 600);
  if (data.artifactId !== undefined) {
    result.artifactId = pptText(data.artifactId, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(result.artifactId)) invalid();
  }
  return result;
}
export function pptFacts(input: PptInput): PptFact[] {
  return [{ id: "idea", kind: "idea", text: input.projectIdea }, { id: "target-users", kind: "target_users", text: input.targetUsers },
    ...input.completed.map((text, index) => ({ id: `completed-${index + 1}`, kind: "completed" as const, text })),
    ...input.planned.map((text, index) => ({ id: `planned-${index + 1}`, kind: "planned" as const, text })),
    ...(input.evidence ?? []).map((text, index) => ({ id: `evidence-${index + 1}`, kind: "evidence" as const, text }))];
}
function validatePoint(value: unknown, facts: PptFact[]): PptPoint {
  const point = pptRecord(value, true);
  keys(point, ["text", "kind", "factId"], true);
  const text = pptText(point.text, 600, true);
  if (!["provided", "suggestion", "needs_evidence"].includes(point.kind as string)) invalid(true);
  if (point.kind === "provided") {
    const fact = facts.find(item => item.id === point.factId);
    // A factual bullet must quote supplied material exactly, so a model cannot attach an unrelated claim to a valid ID.
    if (!fact || text !== fact.text) invalid(true);
  } else if (point.factId !== null) invalid(true);
  return { text, kind: point.kind as PptPoint["kind"], factId: point.factId as string | null };
}
function validateSlide(value: unknown, index: number, input: PptInput, facts: PptFact[]): PptSlide {
  const slide = pptRecord(value, true);
  keys(slide, ["number", "title", "keyPoints", "visualSuggestion", "speakerNotes", "durationSeconds", "demonstration"], true);
  if (slide.number !== index + 1 || typeof slide.durationSeconds !== "number" || !Number.isInteger(slide.durationSeconds) || slide.durationSeconds < 5 || slide.durationSeconds > input.durationMinutes * 60) invalid(true);
  if (!Array.isArray(slide.keyPoints) || slide.keyPoints.length < 1 || slide.keyPoints.length > 5) invalid(true);
  const demonstration = pptRecord(slide.demonstration, true);
  keys(demonstration, ["mode", "steps", "fallback"], true);
  if (!["live", "recording", "walkthrough", "none"].includes(demonstration.mode as string)) invalid(true);
  const steps = texts(demonstration.steps, 6, 300, true);
  if (demonstration.mode === "none" && steps.length) invalid(true);
  if (demonstration.mode !== "none" && !steps.length) invalid(true);
  if (["live", "recording"].includes(demonstration.mode as string) && !input.completed.length) invalid(true);
  return {
    number: index + 1, title: pptText(slide.title, 100, true), keyPoints: slide.keyPoints.map(point => validatePoint(point, facts)),
    visualSuggestion: pptText(slide.visualSuggestion, 800, true), speakerNotes: pptText(slide.speakerNotes, 2200, true), durationSeconds: slide.durationSeconds,
    demonstration: { mode: demonstration.mode as PptSlide["demonstration"]["mode"], steps, fallback: pptText(demonstration.fallback, 600, true, demonstration.mode === "none") },
  };
}
function checkUnsupportedClaims(slides: PptSlide[], title: string, input: PptInput) {
  const normalize = (value: string) => value.replace(/[\s“”"‘’'：:、，,。.!！?？；;（）()]/gu, "").toLowerCase();
  const support = normalize([...input.completed, ...(input.evidence ?? [])].filter(value => !/^(?:假设|待验证|待核实|目标|计划|预期)[：:\s]/u.test(value)).join("\n"));
  const claimPatterns = [
    /(?:已有|已经有|拥有|已服务|已覆盖|服务了|覆盖了)\s*(?:超过|约)?\s*[0-9一二三四五六七八九十百千万亿]+[^。！？；，,\n]{0,12}(?:用户|客户|企业|学校)/gu,
    /(?:准确率|成功率|效率|市场规模|营收|收入|市占率)[^。！？；，,\n]{0,16}\d+(?:\.\d+)?(?:[%％]|万元|亿元|元|倍|万|亿)?/gu,
    /(?:荣获|获得|拿下|赢得)[^。！？；，,\n]{0,24}(?:奖项?|冠军|一等奖|二等奖|三等奖)/gu,
    /(?:已经|已|刚才|刚刚)[^。！？；，,\n]{0,10}(?:成功运行|演示成功|运行成功|通过测试|完成测试|上线)/gu,
    /(?:行业领先|市场第一|全球首创|全球第一|百分之百准确|零错误|零风险)/gu,
  ];
  const generated = [title, ...slides.flatMap(slide => [slide.title, slide.visualSuggestion, slide.speakerNotes,
    ...slide.keyPoints.map(point => point.text), ...slide.demonstration.steps, slide.demonstration.fallback])];
  for (const text of generated) for (const clause of text.split(/[。！？；\n，,]/u)) for (const pattern of claimPatterns) {
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      const before = clause.slice(0, match.index);
      if (/(?:尚未|还未|没有|未能|不能|不保证|不承诺|不应|不要|待验证|待核实|假设|如果|目标|计划|预期|建议|需要验证)/u.test(before)) continue;
      if (!support.includes(normalize(match[0]))) invalid(true);
    }
  }
}
/** Validates model fields; snapshot and facts are added only from trusted input. */
export function validatePptOutline(value: unknown, inputValue: PptInput): PptOutline {
  bytes(value, 75000, true);
  const input = validatePptInput(inputValue), facts = pptFacts(input), data = pptRecord(value, true);
  keys(data, ["schemaVersion", "title", "templateId", "durationMinutes", "slides", "rehearsalChecklist", "warnings"], true);
  if (data.schemaVersion !== 1 || data.templateId !== input.templateId || data.durationMinutes !== input.durationMinutes) invalid(true);
  if (!Array.isArray(data.slides) || data.slides.length < 3 || data.slides.length > 12) invalid(true);
  const slides = data.slides.map((slide, index) => validateSlide(slide, index, input, facts));
  if (slides.reduce((sum, slide) => sum + slide.durationSeconds, 0) !== input.durationMinutes * 60) invalid(true);
  const title = pptText(data.title, 120, true);
  checkUnsupportedClaims(slides, title, input);
  const warnings = texts(data.warnings, 8, 500, true);
  const result: PptOutline = {
    schemaVersion: 1, title, templateId: input.templateId, durationMinutes: input.durationMinutes, slides,
    rehearsalChecklist: texts(data.rehearsalChecklist, 10, 400, true, 1),
    warnings: [...warnings, "AI 草案：讲者备注和建议需要人工复核；待实现内容不代表已经完成。"], inputSnapshot: input, facts,
  };
  checkUnsupportedClaims([], [...result.rehearsalChecklist, ...result.warnings].join("\n"), input);
  bytes(result, 98000, true);
  return result;
}
/** History uses the same bounds, but preserves the persisted warning once. */
export function parseStoredPptOutline(value: unknown): PptOutline {
  const data = pptRecord(value, true);
  keys(data, ["schemaVersion", "title", "templateId", "durationMinutes", "slides", "rehearsalChecklist", "warnings", "inputSnapshot", "facts", "sourceProject"], true);
  const input = validatePptInput(data.inputSnapshot);
  const { inputSnapshot: _snapshot, facts: savedFacts, sourceProject: savedSource, ...model } = data;
  if (JSON.stringify(savedFacts) !== JSON.stringify(pptFacts(input))) invalid(true);
  if (!Array.isArray(model.warnings) || model.warnings.length > 9) invalid(true);
  const disclosure = "AI 草案：讲者备注和建议需要人工复核；待实现内容不代表已经完成。";
  const warnings = (model.warnings as unknown[]).filter(item => item !== disclosure);
  try {
    const sourceProject = savedSource === undefined ? undefined : validatePresentationProjectSnapshot(savedSource);
    if (sourceProject) assertProjectPlansStayPlanned(input.completed, sourceProject);
    return { ...validatePptOutline({ ...model, warnings }, input), ...(sourceProject ? { sourceProject } : {}) };
  } catch { return invalid(true); }
}
