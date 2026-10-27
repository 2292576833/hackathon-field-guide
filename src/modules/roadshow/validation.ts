import { DomainError } from "../../shared/errors.ts";
import type { RoadshowDocument, RoadshowInput, RoadshowScript, RoadshowSpeech } from "./types.ts";
import { assertProjectPlansStayPlanned, validatePresentationProjectSnapshot } from "./project-context.ts";

export const ROADSHOW_INPUT_LIMITS = {
  projectIdea: 2000, targetUsers: 1000, problem: 2000, completedCapabilities: 3000, plannedCapabilities: 3000,
  technicalApproach: 3000, differentiation: 1500, facts: 3000, assumptions: 2000,
  pendingValidation: 2000,
} as const;
export const ROADSHOW_MIN_SECONDS = 60;
export const ROADSHOW_MAX_SECONDS = 900;
const required = new Set<string>(["projectIdea", "targetUsers", "problem", "completedCapabilities"]);
const inputKeys = [...Object.keys(ROADSHOW_INPUT_LIMITS), "durationSeconds"];
type Failure = (message: string) => never;
const invalidInput: Failure = message => { throw new DomainError("INVALID_INPUT", message, { status: 422 }); };
const invalidOutput: Failure = () => { throw new DomainError("ROADSHOW_OUTPUT_INVALID", "模型返回的讲稿不符合结构、时长或事实约束，本次结果未保存。请调整输入后重新生成。", { status: 502 }); };
function object(value: unknown, allowed: readonly string[], label: string, fail: Failure): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}应为对象。`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) fail(`${label}包含不支持的字段。`);
  return result;
}
function text(value: unknown, label: string, maximum: number, fail: Failure, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label}须为不含控制字符、长度不超过 ${maximum} 字的文本。`);
  const result = (value as string).trim();
  if (!allowEmpty && !result) fail(`${label}不能为空。`);
  return result;
}
function chinese(value: unknown, label: string, maximum: number): string {
  const result = text(value, label, maximum, invalidOutput);
  if (!/[\u3400-\u9fff]/u.test(result)) invalidOutput(`${label}应包含中文表达。`);
  return result;
}
function seconds(value: unknown, minimum: number, maximum: number, fail: Failure): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`时长须为 ${minimum} 至 ${maximum} 之间的整数秒。`);
  return value as number;
}
function entries(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalidOutput("内容数量不符合要求。");
  return value as unknown[];
}
export function validateRoadshowInput(value: unknown): RoadshowInput {
  const raw = object(value, inputKeys, "路演输入", invalidInput);
  const result = {} as RoadshowInput;
  for (const key of Object.keys(ROADSHOW_INPUT_LIMITS) as (keyof typeof ROADSHOW_INPUT_LIMITS)[]) {
    result[key] = text(raw[key] === undefined && !required.has(key) ? "" : raw[key], key, ROADSHOW_INPUT_LIMITS[key], invalidInput, !required.has(key));
  }
  result.durationSeconds = seconds(raw.durationSeconds, ROADSHOW_MIN_SECONDS, ROADSHOW_MAX_SECONDS, invalidInput);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 60_000) invalidInput("路演输入内容过多，请精简后重试。");
  return result;
}
function speech(value: unknown, total: number, segment = false): RoadshowSpeech & { title?: string } {
  const raw = object(value, segment ? ["title", "text", "durationSeconds"] : ["text", "durationSeconds"], "讲稿段落", invalidOutput);
  const durationSeconds = seconds(raw.durationSeconds, 5, total, invalidOutput);
  const body = chinese(raw.text, "讲稿", 4000);
  // Up to six characters per second is a ceiling, not a promise about the speaker's pace.
  if (Array.from(body.replace(/\s/gu, "")).length > durationSeconds * 6 + 20) invalidOutput("讲稿无法在标注时长内合理讲完。");
  return { text: body, durationSeconds, ...(segment ? { title: chinese(raw.title, "段落标题", 80) } : {}) };
}
function normalized(value: string): string { return value.replace(/[\s“”"‘’'：:、，,。.!！?？；;（）()]/gu, "").toLowerCase(); }
function claimClauses(value: string): string[] {
  // A qualifier or piece of supporting evidence cannot flow through punctuation or a turn.
  return value.split(/[。！？；;\n，,]|(?:但是|然而|不过|可是|但|却|而|否则)/u).map(value => value.trim()).filter(Boolean);
}
function isQualifiedClaim(before: string): boolean {
  // Only nearby negation/uncertainty with a small grammatical connector is relevant to this claim.
  // In particular, "需要验证成本…已有用户" does not make that user result hypothetical.
  return /(?:尚未|还未|从未|未曾|未能|没有|不曾|未|没|不宣称|不能|不保证|不承诺|不应|不要|待验证|待核实|假设|如果|目标是|计划|准备|预期|建议|需要验证|拟)(?:\s|[：:“”"‘’'「」]|我们|本项目|项目|本方案|方案|团队|是否|能够|能否|可以|将来|未来|进一步|实际|最终|尝试|验证|实现|达到|宣称|声称|保证|承诺|假装|进行|开展|完成|先|再|将|会|能|可|的){0,10}$/u.test(before.slice(-48));
}
function affirmativeSupport(input: RoadshowInput): string[] {
  return [input.facts, input.completedCapabilities].flatMap(claimClauses)
    // Refuse to turn negative/uncertain source text into positive evidence by substring matching.
    // This is deliberately conservative; ambiguous source clauses need clearer user wording.
    .filter(clause => !/(?:不|未|没|待|假设|如果|计划|拟|预期|目标(?:是|为|达到)|准备|未知|是否|建议|需.{0,4}(?:核实|验证|确认))/u.test(clause))
    .map(normalized);
}

/** Conservative support checks complement the prompt; they do not verify user-supplied evidence. */
function checkFactualClaims(script: RoadshowScript, input: RoadshowInput): void {
  const support = affirmativeSupport(input);
  const hasSupport = (claim: string) => support.some(clause => clause.includes(normalized(claim)));
  const strings = [script.opening.text, ...script.segments.flatMap(segment => [segment.title, segment.text]), script.closing.text,
    ...script.demoSteps.flatMap(step => [step.action, step.expectedResult, step.fallback]),
    ...script.qa.flatMap(qa => [qa.question, qa.answer]), ...script.verificationItems];
  const patterns = [
    /(?:荣获|获得|拿下|赢得)[^。！？；，,\n]{0,24}(?:奖项?|冠军|一等奖|二等奖|三等奖)/gu,
    /(?:已有|已经有|拥有|已服务|已覆盖|服务了|覆盖了|我们有|现有|目前有|累计)\s*(?:超过|约)?\s*[0-9一二三四五六七八九十百千万亿]+[^。！？；，,\n]{0,12}(?:用户|客户|企业|学校)/gu,
    /(?:准确率|成功率|效率|市场规模|营收|收入|市占率)[^。！？；，,\n]{0,16}\d+(?:\.\d+)?(?:[%％]|万元|亿元|元|倍|万|亿)?/gu,
    /(?:提升|提高|降低|减少|节省|缩短|节约)[^。！？；，,\n]{0,10}\d+(?:\.\d+)?(?:[%％]|倍|小时|分钟|秒)/gu,
    /(?:用户反馈|客户反馈|测试结果|访谈结果|调研结果|实验结果)[^。！？；，,\n]{0,12}(?:显示|证明|表明|验证|确认)/gu,
    /(?:已经|已|完成了|开展了)[^。！？；，,\n]{0,8}(?:用户测试|真实测试|测试验证|用户访谈|市场调研|用户调研)/gu,
    /(?:访谈|采访|访问|调研|调查|测试)(?:了|过|到)?\s*[0-9零〇一二两三四五六七八九十百千万亿]+(?:\.\d+)?\s*(?:位|名|个|家)?\s*(?:目标|潜在|真实)?(?:用户|客户|受访者|参与者|企业|团队|人)/gu,
    /(?:访谈|采访|调研|调查)(?:了|过|到)[^。！？；，,\n]{0,12}(?:用户|客户|受访者|企业|参与者)/gu,
    /[0-9零〇一二两三四五六七八九十百千万亿]+(?:\.\d+)?(?:次|场)(?:用户)?(?:访谈|调研|测试)/gu,
    /[0-9零〇一二两三四五六七八九十百千万亿]+(?:\.\d+)?(?:[%％]|位|名|个|家|人|成)[^。！？；，,\n]{0,8}(?:愿意|表示愿意|决定|已经|已|选择|开始|完成)[^。！？；，,\n]{0,6}(?:付费|支付|购买|订阅|试用|使用)/gu,
    /(?:真实用户|真实客户|受访者)(?:都|普遍|一致)?(?:反馈|表示|认为|评价|确认|认可)/gu,
    /(?:已有|拥有|服务了|已服务|已经有)[^。！？；，,\n]{0,8}(?:真实用户|真实客户|大量用户|大量客户)/gu,
    /(?:已经|已)[^。！？；，,\n]{0,10}(?:通过测试|完成测试)/gu,
    /(?:行业领先|市场第一|全球首创|全球第一|百分之百准确|零错误|零风险)/gu,
  ];
  const demoAssertions = [
    /(?:已经|已|刚才|刚刚)[^。！？；，,\n]{0,10}(?:成功运行|演示成功|运行成功|执行了演示|执行了\s*demo)/giu,
    /(?:现场|刚才|刚刚)[^。！？；，,\n]{0,8}(?:成功|顺利)(?:完成|运行|演示)/gu,
    /现场[^。！？；，,\n]{0,8}(?:运行成功|演示成功|执行成功|操作成功|完成了演示)/gu,
    /(?:已|已经)(?:完成|执行|运行)(?:了)?(?:本次|这次|现场)?(?:演示|demo)/giu,
  ];
  for (const value of strings) {
    for (const clause of claimClauses(value)) {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const match of clause.matchAll(pattern)) {
          const before = clause.slice(0, match.index);
          // A future target or an explicit unverified/negative statement is not a reported result.
          if (isQualifiedClaim(before)) continue;
          if (!hasSupport(match[0])) invalidOutput("讲稿含输入未支持的实际结果或数字。");
        }
      }
      for (const pattern of demoAssertions) {
        pattern.lastIndex = 0;
        for (const match of clause.matchAll(pattern)) {
          const before = clause.slice(0, match.index);
          if (isQualifiedClaim(before)) continue;
          // Even supplied demo history must be attributed; the generator has never performed it.
          if (!/(?:用户自述|据用户|据你提供|你提供的信息|用户提供的信息)/u.test(before)
            || !hasSupport(match[0])) invalidOutput("不能宣称生成器已经执行演示。");
        }
      }
    }
  }
}
export function validateRoadshowScript(value: unknown, inputValue: RoadshowInput): RoadshowScript {
  const input = validateRoadshowInput(inputValue);
  const raw = object(value, ["opening", "segments", "demoSteps", "closing", "qa", "verificationItems", "totalDurationSeconds"], "路演讲稿", invalidOutput);
  const opening = speech(raw.opening, input.durationSeconds);
  const closing = speech(raw.closing, input.durationSeconds);
  if (opening.durationSeconds > input.durationSeconds * .25 || closing.durationSeconds > input.durationSeconds * .25) invalidOutput("开场与结尾时间过长。");
  const segments = entries(raw.segments, 2, 8).map(value => {
    const parsed = speech(value, input.durationSeconds, true);
    return { title: parsed.title!, text: parsed.text, durationSeconds: parsed.durationSeconds };
  });
  if (!segments.some(segment => /演示|展示|原型|流程/iu.test(segment.title))) invalidOutput("缺少演示或原型流程段落。");
  const demoSteps = entries(raw.demoSteps, 1, 6).map(value => {
    const item = object(value, ["action", "expectedResult", "fallback"], "演示步骤", invalidOutput);
    return { action: chinese(item.action, "演示操作", 1200), expectedResult: chinese(item.expectedResult, "预期结果", 1200), fallback: chinese(item.fallback, "失败备选", 1200) };
  });
  const qa = entries(raw.qa, 3, 10).map(value => {
    const item = object(value, ["question", "answer"], "评委问答", invalidOutput);
    return { question: chinese(item.question, "评委问题", 500), answer: chinese(item.answer, "回答建议", 1500) };
  });
  const verificationItems = entries(raw.verificationItems, 1, 12).map(value => chinese(value, "待核实事项", 800));
  const totalDurationSeconds = seconds(raw.totalDurationSeconds, ROADSHOW_MIN_SECONDS, ROADSHOW_MAX_SECONDS, invalidOutput);
  const sum = opening.durationSeconds + closing.durationSeconds + segments.reduce((result, segment) => result + segment.durationSeconds, 0);
  if (sum !== totalDurationSeconds || totalDurationSeconds !== input.durationSeconds) invalidOutput("各段时间之和与输入路演时长不一致。");
  const totalText = [opening.text, ...segments.map(segment => segment.text), closing.text].join("").replace(/\s/gu, "");
  if (Array.from(totalText).length > totalDurationSeconds * 6) invalidOutput("讲稿总字数过多。");
  const result: RoadshowScript = { opening, segments, demoSteps, closing, qa, verificationItems, totalDurationSeconds };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 70_000) invalidOutput("讲稿内容过多。");
  checkFactualClaims(result, input);
  return result;
}
export function validateRoadshowDocument(value: unknown): RoadshowDocument {
  const raw = object(value, ["input", "script", "sourceProject"], "路演文档", invalidOutput);
  let input: RoadshowInput;
  try { input = validateRoadshowInput(raw.input); } catch { return invalidOutput("保存的路演输入无效。"); }
  try {
    const sourceProject = raw.sourceProject === undefined ? undefined : validatePresentationProjectSnapshot(raw.sourceProject);
    if (sourceProject) assertProjectPlansStayPlanned(input.completedCapabilities, sourceProject);
    return { input, script: validateRoadshowScript(raw.script, input), ...(sourceProject ? { sourceProject } : {}) };
  } catch { return invalidOutput("保存的路演资料来源无效。"); }
}
function markdownText(value: string): string {
  // Keep copied text as prose rather than allowing HTML/Markdown instructions in the export.
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}\[\]#|])/g, "\\$1").replace(/^([ \t]*)([-+]|\d+[.)]) /gm, "$1\\$2 ");
}
export function roadshowToMarkdown(value: RoadshowDocument): string {
  const { input, script, sourceProject } = validateRoadshowDocument(value);
  const paragraph = (text: string) => markdownText(text);
  const sourceInfo = sourceProject ? `来源项目：${paragraph(sourceProject.projectName)}（${paragraph(sourceProject.projectId)}，版本 ${sourceProject.revision}）；读取于 ${paragraph(sourceProject.capturedAt)}。这是当时的有限资料快照，后续项目编辑不会改写此稿。\n\n` : "";
  const section = (title: string, text: string, duration: number) => `## ${title}（${duration} 秒）\n\n${paragraph(text)}\n`;
  const supplied = Object.entries(ROADSHOW_INPUT_LIMITS).map(([key]) => {
    const labels: Record<string, string> = { projectIdea: "项目想法", targetUsers: "目标用户", problem: "问题", completedCapabilities: "用户自述已完成能力", plannedCapabilities: "计划中的能力", technicalApproach: "技术方案", differentiation: "差异", facts: "用户提供的事实", assumptions: "假设", pendingValidation: "待验证" };
    return `- ${labels[key]}：${paragraph(input[key as keyof typeof ROADSHOW_INPUT_LIMITS] || "未填写")}`;
  }).join("\n");
  return `# 路演讲稿\n\n由 DSH 根据私人输入生成的草稿。用户输入未经独立核验；演示步骤是彩排建议，不代表已经执行。\n\n${sourceInfo}计划路演时长：${script.totalDurationSeconds} 秒（问答另计，请核对比赛规则）。\n\n## 项目输入\n\n${supplied}\n\n${section("开场", script.opening.text, script.opening.durationSeconds)}\n${script.segments.map(segment => section(markdownText(segment.title), segment.text, segment.durationSeconds)).join("\n")}\n${section("结尾", script.closing.text, script.closing.durationSeconds)}\n## 演示步骤与失败备选\n\n${script.demoSteps.map((step, index) => `${index + 1}. 操作：${paragraph(step.action)}\n   预期：${paragraph(step.expectedResult)}\n   备选：${paragraph(step.fallback)}`).join("\n\n")}\n\n## 评委问答（路演时长外）\n\n${script.qa.map(qa => `### ${paragraph(qa.question)}\n\n${paragraph(qa.answer)}`).join("\n\n")}\n\n## 待核实事项\n\n${script.verificationItems.map(item => `- ${paragraph(item)}`).join("\n")}\n`;
}
