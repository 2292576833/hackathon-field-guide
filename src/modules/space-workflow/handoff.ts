/** A readable projection into the existing progress note/evidence fields.
 * These limits mirror PlanningService.updateProgress; no task state is stored. */
export const HANDOFF_LIMITS = { note: 4000, references: 50, reference: 2000 } as const;
export interface HandoffDraft { location: string; version: string; openMethod: string; checkMethod: string }
export const HANDOFF_FIELDS = [
  { key: "location", label: "成果在哪里", example: "共享资料里的 路演.pptx，或可访问的作品链接" },
  { key: "version", label: "哪个版本", example: "PPT 第3版，或代码提交 a1b2c3" },
  { key: "openMethod", label: "怎么打开", example: "用 PowerPoint 打开；代码可写安装和启动步骤" },
  { key: "checkMethod", label: "怎么检查", example: "播放第2–5页，核对图文、链接与任务检查条件" },
] as const;
const heading = "成果交接";
const noteLabel = "补充说明";
export function emptyHandoffDraft(): HandoffDraft { return { location: "", version: "", openMethod: "", checkMethod: "" }; }
export function hasHandoffInput(draft: HandoffDraft): boolean { return HANDOFF_FIELDS.some(field => draft[field.key].length > 0); }

function block(label: string, value: string): string {
  // Indented values cannot impersonate a following heading, even if the user
  // pastes a multiline instruction containing the exact same Chinese label.
  return `${label}：\n${value.replace(/\r\n/g, "\n").split("\n").map(line => `  ${line}`).join("\n")}`;
}
function validateProgress(note: string, refs: readonly string[]): void {
  if (note.length > HANDOFF_LIMITS.note) throw new Error(`交接说明合计超过${HANDOFF_LIMITS.note}字，请缩短说明；输入已保留。`);
  if (refs.length > HANDOFF_LIMITS.references) throw new Error(`成果位置和额外依据合计最多${HANDOFF_LIMITS.references}项；输入已保留。`);
  if (refs.some(ref => !ref.trim() || ref.length > HANDOFF_LIMITS.reference)) throw new Error(`每项成果依据须有内容，且不超过${HANDOFF_LIMITS.reference}字；输入已保留。`);
}

/** Old review entries can remain unchanged. New handoffs need all four facts;
 * partial new input is never silently ignored, shortened or marked complete. */
export function buildHandoffProgress(input: { handoff: HandoffDraft; note: string; evidenceRefs: readonly string[]; allowLegacy?: boolean }): { note: string; evidenceRefs: string[] } {
  const { handoff } = input;
  if (input.allowLegacy && !hasHandoffInput(handoff)) {
    validateProgress(input.note, input.evidenceRefs);
    if (!input.note.trim() && !input.evidenceRefs.length) throw new Error("请补充成果说明或位置，方便队友检查。");
    return { note: input.note, evidenceRefs: [...input.evidenceRefs] };
  }
  for (const field of HANDOFF_FIELDS) if (!handoff[field.key].trim()) throw new Error(`请填写“${field.label}”；文件、文档、设计稿和代码都可以交接。`);
  const location = handoff.location.trim();
  if (location.length > HANDOFF_LIMITS.reference) throw new Error(`成果位置不能超过${HANDOFF_LIMITS.reference}字；输入已保留。`);
  const evidenceRefs = input.evidenceRefs.includes(location) ? [...input.evidenceRefs] : [location, ...input.evidenceRefs];
  const note = [heading, ...HANDOFF_FIELDS.map(field => block(field.label, handoff[field.key])), block(noteLabel, input.note)].join("\n");
  validateProgress(note, evidenceRefs);
  return { note, evidenceRefs };
}

/**
 * 交接四项的**候选值**（规划31 第1.4项）。
 *
 * 问题：四项必填且全靠自由文本，新人第一次交成果要把"在哪、第几版、怎么打开、怎么检查"手打一遍；
 * 而其中「怎么检查」的答案其实就在同一张任务卡上（`acceptanceCriteria`），最容易糊弄成「做完了」。
 *
 * 约束（宪法：不得替成员编造事实）：
 *  - 这里**只产生候选**，由本人点一下才带出，绝不自动填入；
 *  - 每一项都注明来源，让本人知道这句话是从哪来的、需要自己核对；
 *  - 没有依据的字段（例如没有承诺交付物、没有保存版本）**不产生候选**，宁缺勿造。
 */
export function handoffSuggestions(task: {
  readonly title: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly deliverable?: string;
}): readonly { readonly key: keyof HandoffDraft; readonly value: string; readonly source: string }[] {
  const suggestions: { key: keyof HandoffDraft; value: string; source: string }[] = [];
  const criteria = (task.acceptanceCriteria ?? []).map(value => value.trim()).filter(Boolean);
  const deliverable = task.deliverable?.trim() ?? "";
  if (deliverable) suggestions.push({ key: "location", value: deliverable, source: "来自本任务承诺的交付物" });
  if (criteria.length) suggestions.push({ key: "checkMethod", value: criteria.join("；"), source: "来自本任务的检查条件" });
  return suggestions;
}

/** Recognize only our complete, unambiguous readable format. Any legacy or
 * malformed entry remains intact instead of losing or reinterpreting text. */export function readHandoffProgress(note: string): { kind: "structured" | "legacy"; handoff: HandoffDraft; note: string } {
  const legacy = () => ({ kind: "legacy" as const, handoff: emptyHandoffDraft(), note });
  const lines = note.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== heading) return legacy();
  const handoff = emptyHandoffDraft();
  let cursor = 1, extra = "";
  const fields: readonly { key: keyof HandoffDraft | "note"; label: string }[] = [...HANDOFF_FIELDS, { key: "note", label: noteLabel }];
  for (const field of fields) {
    if (lines[cursor++] !== `${field.label}：`) return legacy();
    const value: string[] = [];
    while (cursor < lines.length && lines[cursor]!.startsWith("  ")) value.push(lines[cursor++]!.slice(2));
    if (!value.length) return legacy();
    if (field.key === "note") extra = value.join("\n");
    else handoff[field.key] = value.join("\n");
  }
  if (cursor !== lines.length || HANDOFF_FIELDS.some(field => !handoff[field.key].trim())) return legacy();
  return { kind: "structured", handoff, note: extra };
}
