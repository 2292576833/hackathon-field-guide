import { DomainError } from "../../shared/errors.ts";
import type { PptFact, PptInput, PptOutline, PptPoint, PptSlide, PptTemplateId } from "./domain.ts";
import { getPptTemplate } from "./templates.ts";
import { pptFacts, pptText, validatePptInput, validatePptOutline } from "./validation.ts";

export interface PptGenerationPage {
  purpose: string;
  durationSeconds: number;
  keyPoints: PptPoint[];
}
export interface PptGenerationPlan {
  pages: PptGenerationPage[];
  demonstrationPage: number;
}
const priorities: Record<PptTemplateId, PptFact["kind"][][]> = {
  "demo-3": [["idea", "target_users"], ["target_users", "evidence"], ["completed"], ["completed", "planned", "evidence"], ["planned"]],
  "product-5": [["idea", "target_users"], ["target_users", "evidence"], ["completed", "planned", "idea"], ["completed"], ["evidence", "completed"], ["completed", "planned"], ["planned"]],
  "agent-technical": [["idea", "target_users"], ["completed", "planned"], ["completed", "planned"], ["completed"], ["evidence", "completed"], ["evidence", "planned"], ["planned"]],
};
function fail(reason: string): never {
  // The reason contains only a fixed schema path, never provider prose or private input.
  throw new DomainError("PPT_OUTPUT_INVALID", "DSH 返回的文案不符合内容要求，未作为可用 PPT 保存。", { status: 502, recoveryAction: `PPT_SCHEMA:${reason}` });
}
/** Only copy the fields this boundary adopts; model metadata cannot replace server-owned structure. */
function copyFields(value: Record<string, unknown>, required: string[], path: string): Record<string, unknown> {
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail(path);
  return Object.fromEntries(required.map(key => [key, value[key]]));
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, path: string): string {
  try { return pptText(value, max, true); } catch { return fail(path); }
}
function list(value: unknown, min: number, max: number, length: number, path: string) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path);
  return value.map(item => text(item, length, `${path}.items`));
}
/** Timing, page count and factual bullets are deterministic application data. */
export function createPptGenerationPlan(inputValue: PptInput): PptGenerationPlan {
  const input = validatePptInput(inputValue), template = getPptTemplate(input.templateId), facts = pptFacts(input);
  const exactTimes = template.slides.map(slide => slide.durationSeconds * input.durationMinutes / template.durationMinutes);
  const seconds = exactTimes.map(time => Math.floor(time));
  let remaining = input.durationMinutes * 60 - seconds.reduce((sum, time) => sum + time, 0);
  const order = exactTimes.map((time, index) => ({ fraction: time - Math.floor(time), index })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remaining > 0; index++, remaining--) seconds[order[index % order.length]!.index]!++;
  const pages = template.slides.map((slide, index) => {
    const preferred = priorities[input.templateId][index]!;
    const selected = preferred.flatMap(kind => facts.filter(fact => fact.kind === kind && fact.text.length <= 600).slice(0, 1)).slice(0, 3);
    const keyPoints: PptPoint[] = selected.map(fact => ({ text: fact.text, kind: "provided", factId: fact.id }));
    if (!keyPoints.length) keyPoints.push({ text: index === template.slides.length - 1 ? "下一步范围尚未提供；请补充要验证或实现的具体能力。" : "本页缺少可直接展示的短事实；请结合完整输入补充材料。", kind: "needs_evidence", factId: null });
    return { purpose: slide.title, durationSeconds: seconds[index]!, keyPoints };
  });
  const demonstrationPage = template.slides.findIndex(slide => slide.title.includes("演示")) + 1;
  if (demonstrationPage < 1 || seconds.some(value => value < 5)) throw new Error("PPT template has invalid deterministic timing.");
  return { pages, demonstrationPage };
}
/** Model example includes every required copy field and no model-owned constants/enums/arithmetic. */
export function pptCopyExample(plan: PptGenerationPlan) {
  return {
    title: "项目路演大纲",
    slides: plan.pages.map(page => ({
      title: page.purpose, suggestions: ["建议只补充与本页真实范围相关的说明。"],
      visualSuggestion: "使用真实界面截图或简洁文字；缺少截图时保留材料待补说明。",
      speakerNotes: "根据本页提供的事实说明当前范围，区分目标、已完成与待实现，不增添数字或成功状态。",
    })),
    demonstration: { steps: ["建议按已有范围讲解一条输入到输出的流程。"], fallback: "建议在无法操作时改用已有截图；没有材料则说明概念流程。" },
    rehearsalChecklist: ["按服务器给出的每页秒数计时排练。"], warnings: ["用户提供资料未经独立核验。"],
  };
}
/** Compose model copy with trusted structure, then retain the full existing factual validator. */
export function composePptOutline(value: unknown, input: PptInput, plan: PptGenerationPlan = createPptGenerationPlan(input)): PptOutline {
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return fail("json"); }
  if (size > 60000) fail("bytes");
  const copy = copyFields(record(value, "root.type"), ["title", "slides", "demonstration", "rehearsalChecklist", "warnings"], "root.keys");
  if (!Array.isArray(copy.slides) || copy.slides.length !== plan.pages.length) fail("slides.count");
  const demo = copyFields(record(copy.demonstration, "demonstration.type"), ["steps", "fallback"], "demonstration.keys");
  const steps = list(demo.steps, 1, 3, 300, "demonstration.steps"), fallback = text(demo.fallback, 600, "demonstration.fallback");
  const slides: PptSlide[] = copy.slides.map((value, index) => {
    const page = copyFields(record(value, `slides.${index}.type`), ["title", "suggestions", "visualSuggestion", "speakerNotes"], `slides.${index}.keys`);
    const suggestions = list(page.suggestions, 0, 2, 250, `slides.${index}.suggestions`);
    const fixed = plan.pages[index]!;
    return {
      number: index + 1, title: text(page.title, 100, `slides.${index}.title`),
      keyPoints: [...fixed.keyPoints.map(point => ({ ...point })), ...suggestions.map(text => ({ text, kind: "suggestion" as const, factId: null }))],
      visualSuggestion: text(page.visualSuggestion, 800, `slides.${index}.visualSuggestion`), speakerNotes: text(page.speakerNotes, 2200, `slides.${index}.speakerNotes`), durationSeconds: fixed.durationSeconds,
      demonstration: index + 1 === plan.demonstrationPage ? { mode: "walkthrough", steps, fallback } : { mode: "none", steps: [], fallback: "" },
    };
  });
  try {
    return validatePptOutline({ schemaVersion: 1, title: text(copy.title, 120, "title"), templateId: input.templateId, durationMinutes: input.durationMinutes,
      slides, rehearsalChecklist: list(copy.rehearsalChecklist, 1, 10, 400, "rehearsalChecklist"), warnings: list(copy.warnings, 0, 8, 500, "warnings") }, input);
  } catch (error) {
    if (error instanceof DomainError && error.recoveryAction?.startsWith("PPT_SCHEMA:")) throw error;
    return fail("final.content_or_bounds");
  }
}
