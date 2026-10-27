import { DomainError } from "../../shared/errors.ts";
import type { ParticipationContext, ParticipationModelOutput, ParticipationPhaseKind, ParticipationPlan } from "./types.ts";

const phaseKinds: ParticipationPhaseKind[] = ["prepare", "build", "roadshow", "submit", "review"];
const checkKinds = ["registration", "fees", "entry", "rules", "submission"] as const;

function invalid(message: string): never {
  throw new DomainError("INVALID_PARTICIPATION_OUTPUT", `DSH 返回的计划未通过校验：${message}`, { status: 502, recoveryAction: "review_inputs" });
}
/** Adopt only named suggestion fields; derived facts and extra model metadata never persist. */
function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label}格式不正确。`);
  const result = value as Record<string, unknown>;
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(result, key))) invalid(`${label}缺少必需字段。`);
  return Object.fromEntries(keys.map(key => [key, result[key]]));
}
const weatherState = "晴朗|晴天|下雨|降雨|大雨|有雨|无雨|没(?:有)?雨|阴天|多云|雷暴|暴雨|高温|低温|寒冷|炎热|暖和|大风|雨雪";
const weatherWords = new RegExp(weatherState);
const weatherPrediction = new RegExp(`(?:预计|预测|将(?:会)?|一定|必然|肯定|会|预报(?:为|是|显示|有))[^，,。；;！？!?]{0,12}(?:${weatherState})|(?:${weatherState})[^，,。；;！？!?]{0,12}(?:将|持续|保持|确定|已确认|已核实)`);
const weatherFact = new RegExp(`(?:天气|当日|当天|开赛日|比赛日|目的地|当地)[^，,。；;！？!?]{0,10}(?:${weatherState})`);
const uncertainForecast = new RegExp(`(?:可能|或许|也许)[^，,。；;！？!?]{0,8}(?:${weatherState})`);
/** Check claims within clauses so an equipment suggestion cannot hide a forecast. */
function validateWeatherAdvice(result: string, label: string): void {
  const clauses = result.split(/[，,。；;！？!?\n]|因为|由于/).map(item => item.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (!weatherWords.test(clause)) continue;
    // Conditions and checking questions describe a future decision, not its outcome.
    const conditional = /(?:如果|假如|若|如遇|如有|如临行|一旦|遇到).*(?:晴|雨|阴|云|雷|温|寒冷|炎热|暖和|大风)/.test(clause);
    const checkQuestion = /(?:核对|查看|查阅|关注|检查|确认).*(?:是否|有无|会不会)|(?:是否|有无|会不会).*(?:核对|查看|查阅|关注|检查|确认)/.test(clause);
    if (conditional || checkQuestion) continue;
    const preparationOrCheck = /(?:核对|查看|查阅|关注|检查|确认|防范|预防|应对|防备|防止|避免|准备|携带|备好|带上|穿着|保护|做好)/.test(clause);
    if (weatherPrediction.test(clause) || (weatherFact.test(clause) && !preparationOrCheck)) invalid(`${label}只能给天气准备或核对建议，不能自行预报。`);
    // "应对可能降雨" is useful preparation; "可能有雨" alone is a model forecast.
    if (uncertainForecast.test(clause) && !preparationOrCheck) invalid(`${label}只能给天气准备或核对建议，不能自行预报。`);
  }
}
/** Questions ask users to verify an outcome; adjacent declarative clauses do not. */
function validateEventClaims(result: string, label: string): void {
  const clauses = result.split(/[，,。；;！？!?\n]|因为|由于|而且|并且|同时|但是/).map(item => item.trim()).filter(Boolean);
  for (const clause of clauses) {
    const question = /是否|有无|能否|可否|有没有|何地|哪里|何时|什么|哪些/.test(clause);
    const condition = /^(?:(?:建议|请)?(?:先|届时|出行前|临行前)?)(?:若|如果|假如|如需|如遇|如有|如尚未|一旦)/.test(clause);
    if (question || condition) continue;
    // Preserve explicit uncertainty such as "费用待确定" without exempting
    // another affirmative claim elsewhere in the same clause.
    const claims = clause.replace(/(?:尚未|仍未|未能|无法|有待|待|不|未)(?:确定|保证|确认|核实)/g, "待核对");
    if (/(?:保证|一定|确保)(?:成功|获奖|入场|符合资格|按时完成)|(?:无需|不需要|免)(?:报名费|费用)|(?:报名|参赛|入场)(?:免费|已确认|已成功)|(?:费用|票价)(?:为|是)|(?:已确认|官方确定)(?:日期|开赛|截止)/.test(claims)) invalid(`${label}不能把未经核实的赛事结论写成事实。`);
    if (/(?:参赛者|参赛人|参加者|报名者|选手|团队).{0,20}(?:必须为|须为|仅限|只能是|要求为)|现场(?:提供|免费|允许|必须)|(?:比赛|赛事|活动)(?:在|将于|定于|举办于|仅限|要求|保证|免费|提供|允许)/.test(claims)) invalid(`${label}不能自行规定资格、场地或赛事条款。`);
    if (/(?:报名|参赛|资格|费用|入场|截止|开赛|地点|住宿|场地).{0,12}(?:已(?:经)?(?:确认|核实|成功|完成)|确定|保证|免费)|(?:已(?:经)?(?:确认|核实)|官方(?:规定|要求|确认)).{0,12}(?:资格|费用|截止|开赛|日期|地点|住宿)/.test(claims)) invalid(`${label}不能声称赛事核实或操作已经完成。`);
  }
}
function adviceText(value: unknown, label: string, max = 800): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`${label}需要有效文字。`);
  return value.trim();
}
/** Advice cannot supply factual URLs, exact event dates, money or quantitative weather. */
function validateAdviceFacts(result: string, label: string): void {
  if (/https?:\/\/|www\.|javascript:|data:|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\d{4}年\d{1,2}月|\d{1,2}月\d{1,2}[日号]|\d+(?:\.\d+)?\s*(?:℃|°\s*C|摄氏|%|％)|[￥¥$]\s*\d|\d+(?:\.\d+)?\s*(?:元|美元)/i.test(result)) invalid(`${label}含有需要由事实层提供的日期、链接、金额或天气数值。`);
  if (/明天|后天|本周|下周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|上旬|中旬|下旬|月初|月末/.test(result)) invalid(`${label}不能用模糊日历文字代替服务器规划日期。`);
  if (/(?:[零〇一二三四五六七八九十百两]+|\d{1,2})月(?:[零〇一二三四五六七八九十百两]+|\d{1,2})[日号]/.test(result)) invalid(`${label}不能另行构造中文日历日期。`);
}
/** Advice cannot supply factual URLs, exact event dates, money or quantitative weather. */
function advice(value: unknown, label: string, max = 800): string {
  const result = adviceText(value, label, max);
  validateAdviceFacts(result, label);
  validateEventClaims(result, label);
  validateWeatherAdvice(result, label);
  return result;
}
function suggestion(value: unknown, label: string): string {
  // The surrounding field already labels this as advice. Natural imperative
  // wording and follow-up preparation steps need no fixed sentence prefix.
  return advice(value, label);
}
/** Future completion checks are goals, never evidence of the user's current state. */
function acceptanceGoal(value: unknown): string {
  const label = "验收条件", result = adviceText(value, label);
  validateAdviceFacts(result, label);
  validateWeatherAdvice(result, label);
  const clauses = result.split(/[，,。；;！？!?\n]|因为|由于|而且|并且|同时|但是|并/).map(item => item.trim()).filter(Boolean);
  for (const clause of clauses) {
    const checkingQuestion = /是否|有无|能否|可否|有没有|何地|哪里|何时|什么|哪些/.test(clause);
    if (!checkingQuestion) {
      // A completion goal can check requirements or prepare materials. It must
      // not manufacture a successful external operation or eligibility outcome.
      if (/(?:报名|参赛|入场|支付|付款|订票|预订|购票|提交)(?:已经|已)?(?:确认|成功|完成|获批)|(?:已经|已)(?:成功)?(?:报名|支付|付款|订票|预订|购票|提交)(?!要求|规则|材料|入口|方式|检查|核对)|(?:符合|具备|满足|获得)(?:全部|所有)?(?:参赛|报名|入场)?(?:资格|条件)/.test(clause)) invalid(`${label}不能把资格或报名、支付、订票、提交成功作为未经核实的结论。`);
      // "已确认天气晴朗" is still an invented forecast even in a goal field.
      const weatherConclusion = new RegExp(`(?:天气|当日|当天|开赛日|比赛日|目的地|当地)[^，,。；;！？!?]{0,10}(?:${weatherState})`);
      if (weatherConclusion.test(clause) && !/(?:如果|假如|若|如遇|如有|一旦|遇到)|(?:防范|预防|应对|防备|防止|避免|准备|携带|备好|带上|穿着|保护)/.test(clause)) invalid(`${label}不能把生成天气作为完成标准。`);
    }
    // Normalize only future checks of requirements/info, not bare status claims
    // such as "资格已确认" or "报名已成功". Preserve the original goal text.
    const goal = clause
      .replace(/已(?:经)?(?:确认|核实)(?=(?:[^，,。；;！？!?]{0,20}(?:要求|规则|条款|说明|信息|入口|方式|流程|材料|时长|限制|清单|资料|日期|时间)|是否|有无|能否|可否|哪些|何时|何地))/g, "核对")
      .replace(/((?:核对|查阅|查看|检查|整理|准备|备份|记录|保存|测试|试跑|排练)[^，,。；;！？!?]{0,30})已(?:经)?完成/g, "$1完成标准");
    validateEventClaims(goal, label);
  }
  return result;
}
function acceptanceGoals(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) invalid("验收条件数量不符合要求。");
  return value.map(acceptanceGoal);
}
function suggestions(value: unknown, label: string, min = 1, max = 12): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`${label}数量不符合要求。`);
  return value.map(item => suggestion(item, label));
}
/** Optional weather reminders may be omitted, but malformed provider data may not. */
function weatherAdviceCandidates(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) invalid("天气建议数量不符合要求。");
  return value.map(item => adviceText(item, "天气建议"));
}
function adoptWeatherAdvice(candidates: string[]): { items: string[]; omitted: boolean } {
  const items: string[] = [];
  let omitted = false;
  for (const candidate of candidates) {
    try { items.push(advice(candidate, "天气建议")); }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== "INVALID_PARTICIPATION_OUTPUT") throw error;
      // Persist neither the rejected reminder nor the reason containing its text.
      omitted = true;
    }
  }
  return { items, omitted };
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid(`${label}超出范围。`);
  return value;
}

export function dateInZone(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const part = (kind: string) => parts.find(value => value.type === kind)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Validation is synchronous and returns JSON-only data for PersonalAiPort persistence. */
export function validateParticipationPlan(value: unknown, context: ParticipationContext, projectIdea: string): ParticipationPlan {
  // Bound the whole response before dropping unused metadata. Projection must
  // not make an excessively large or non-JSON provider response acceptable.
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 100_000) invalid("计划内容过长或格式不正确。");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalid("计划格式不正确。");
  }
  const root = object(value, ["phases", "travel", "risks", "verification", "roadshow", "assumptions"], "计划");
  if (!Array.isArray(root.phases) || root.phases.length !== phaseKinds.length) invalid("需要准备、制作、路演、提交与复盘五个阶段。");
  const seen = new Set<string>();
  const daily = new Map<string, number>();
  let total = 0;
  let taskCount = 0;
  let lastPhaseStart = -1;
  const today = dateInZone(context.currentTime, context.planningTimeZone);
  const submissionDate = context.facts.submissionDeadline.value ? dateInZone(context.facts.submissionDeadline.value, context.planningTimeZone) : null;
  const phases = root.phases.map((raw, phaseIndex) => {
    const phase = object(raw, ["kind", "title", "tasks"], "阶段");
    if (typeof phase.kind !== "string" || !phaseKinds.includes(phase.kind as ParticipationPhaseKind) || seen.has(phase.kind) || phase.kind !== phaseKinds[phaseIndex]) invalid("阶段顺序或类型不正确。");
    seen.add(phase.kind);
    const title = advice(phase.title, "阶段标题", 120);
    if (!Array.isArray(phase.tasks) || phase.tasks.length < 1 || phase.tasks.length > 12) invalid("每个阶段应包含一至十二项任务。");
    const tasks = phase.tasks.map((rawTask, taskIndex) => {
      taskCount++;
      const task = object(rawTask, ["title", "durationMinutes", "dayOffset", "deliverable", "acceptance", "priority"], "任务");
      const durationMinutes = integer(task.durationMinutes, 5, 480, "任务估算分钟");
      const dayOffset = integer(task.dayOffset, 0, 90, "规划日期偏移");
      const plannedDate = addDays(today, dayOffset);
      if (task.priority !== "must" && task.priority !== "optional") invalid("任务优先级不正确。");
      if (phase.kind !== "review" && submissionDate && plannedDate > submissionDate) invalid("提交前任务安排晚于来源作品提交截止日期。");
      daily.set(plannedDate, (daily.get(plannedDate) ?? 0) + durationMinutes);
      total += durationMinutes;
      return {
        id: `phase-${phaseIndex + 1}-task-${taskIndex + 1}`,
        title: advice(task.title, "任务标题", 160), owner: "本人" as const, ownerUserId: context.profile.userId,
        durationMinutes, dayOffset, plannedDate, deliverable: advice(task.deliverable, "验收成果", 400),
        acceptance: acceptanceGoals(task.acceptance), priority: task.priority as "must" | "optional",
      };
    });
    const first = Math.min(...tasks.map(task => task.dayOffset));
    if (first < lastPhaseStart) invalid("后续阶段开始日期早于前一阶段。");
    lastPhaseStart = first;
    return { kind: phase.kind as ParticipationPhaseKind, title, startDate: addDays(today, first), endDate: addDays(today, Math.max(...tasks.map(task => task.dayOffset))), tasks };
  });
  if (taskCount > 40) invalid("计划任务超过四十项，请缩减范围。");
  const capacity = context.profile.availableHoursPerDay;
  if (!capacity || [...daily.values()].some(minutes => minutes > capacity * 60)) invalid("某日估算工时超过你声明的每日可用时间，请减少任务或分摊日期。");

  const travel = object(root.travel, ["suggestions", "checklist", "weatherAdvice"], "出行建议");
  const travelSuggestions = suggestions(travel.suggestions, "出行建议", 0);
  const checklist = suggestions(travel.checklist, "出行核对", 0);
  const weatherCandidates = weatherAdviceCandidates(travel.weatherAdvice);
  const mode = context.facts.mode.value;
  // Use the original validated array length; dropping unsafe reminders must not
  // let an online plan sneak in travel fields that should be absent altogether.
  if (mode === "online" && (travelSuggestions.length || checklist.length || weatherCandidates.length)) invalid("在线赛不应安排出行事项。");
  if ((mode === "offline" || mode === "hybrid") && (!travelSuggestions.length || !checklist.length)) invalid("线下或混合赛需要出行建议与核对事项。");
  const adoptedWeather = adoptWeatherAdvice(weatherCandidates);
  if (!Array.isArray(root.risks) || root.risks.length < 1 || root.risks.length > 12) invalid("需要风险和备选方案。");
  const risks = root.risks.map(raw => {
    const risk = object(raw, ["risk", "mitigation", "fallback"], "风险");
    return { risk: advice(risk.risk, "风险"), mitigation: suggestion(risk.mitigation, "应对方案"), fallback: suggestion(risk.fallback, "备选方案") };
  });
  if (!Array.isArray(root.verification) || root.verification.length !== checkKinds.length) invalid("需分别核对报名、费用、入场、规则和作品提交。");
  const verificationSeen = new Set<string>();
  const verification = root.verification.map(raw => {
    const check = object(raw, ["kind", "action"], "核实事项");
    if (typeof check.kind !== "string" || !checkKinds.includes(check.kind as typeof checkKinds[number]) || verificationSeen.has(check.kind)) invalid("核实事项类型重复或不正确。");
    verificationSeen.add(check.kind);
    return { kind: check.kind as typeof checkKinds[number], action: suggestion(check.action, "核实动作"), status: "needs_confirmation" as const,
      sourceUrl: check.kind === "registration" ? context.event.registrationUrl ?? context.event.sourceUrl : context.event.sourceUrl };
  });
  const roadshow = object(root.roadshow, ["suggestions", "pptChecklist", "rehearsalChecklist"], "路演准备");
  const assumptions = suggestions(root.assumptions, "假设", 0);
  return {
    schemaVersion: 1, status: "draft", title: `${context.event.title} · 我的参赛计划`.slice(0, 200), projectIdea,
    context: JSON.parse(JSON.stringify(context)) as ParticipationContext,
    phases,
    travel: {
      required: mode === "offline" || mode === "hybrid",
      reason: mode === "online" ? "赛事方式为线上，无需为参赛强制安排出行。" : mode === null ? "参赛方式待确认；确认线下或混合参赛后再安排交通与住宿。" : "赛事方式涉及线下；交通、住宿、费用和入场均需自行核实。",
      suggestions: travelSuggestions, checklist, weatherAdvice: adoptedWeather.items,
    },
    risks, verification,
    roadshow: { suggestions: suggestions(roadshow.suggestions, "路演建议"), pptChecklist: suggestions(roadshow.pptChecklist, "PPT 准备"), rehearsalChecklist: suggestions(roadshow.rehearsalChecklist, "路演排练") },
    assumptions,
    notices: [...context.notices, ...(adoptedWeather.omitted ? ["部分天气提醒未通过校验，已省略；请核对真实预报，并在出行前再次确认天气。"] : []), "验收条件供任务完成后检查，使用完成语态也不表示本人已经执行或网站已完成核实。", "阶段日期是基于生成当日的规划建议，任务工时为估算；没有自动确认、报名、订票或提交。", "每日工时只与本人声明的可用小时比较，尚未核对具体空闲窗口、休息、任务依赖或其他项目占用。", "阶段日期没有精确到提交时刻；请核对平台时区并预留上传、校验和网络缓冲。"],
    estimatedTotalMinutes: total, scheduleBasis: "suggested_dates",
  };
}

/** Shape example for the provider, never returned as a generated plan. */
export const participationOutputExample: ParticipationModelOutput = {
  phases: [
    { kind: "prepare", title: "赛前准备", tasks: [{ title: "核对规则并确定最小目标", durationMinutes: 30, dayOffset: 0, deliverable: "一页目标与规则核对清单", acceptance: ["待核实条款单独标记"], priority: "must" }] },
    { kind: "build", title: "最小作品", tasks: [{ title: "制作一条可演示的主流程", durationMinutes: 60, dayOffset: 1, deliverable: "可运行的主流程", acceptance: ["本人按步骤完成一遍主流程"], priority: "must" }] },
    { kind: "roadshow", title: "路演准备", tasks: [{ title: "准备 PPT 并排练", durationMinutes: 30, dayOffset: 2, deliverable: "路演提纲与演示备份", acceptance: ["能讲清问题、方案和演示步骤"], priority: "must" }] },
    { kind: "submit", title: "核对与提交", tasks: [{ title: "核对官方提交要求", durationMinutes: 30, dayOffset: 3, deliverable: "待核实截止与材料清单", acceptance: ["按官方入口核对材料和时间"], priority: "must" }] },
    { kind: "review", title: "赛后复盘", tasks: [{ title: "记录经验与下一步", durationMinutes: 20, dayOffset: 4, deliverable: "本人复盘笔记", acceptance: ["区分已完成事实与后续建议"], priority: "optional" }] },
  ],
  travel: { suggestions: [], checklist: [], weatherAdvice: [] },
  risks: [{ risk: "作品范围过大", mitigation: "建议先完成最小主流程", fallback: "建议删除非必需功能，保留可验证演示" }],
  verification: [
    { kind: "registration", action: "请核对报名窗口、资格和官方入口" },
    { kind: "fees", action: "请核对报名、设备、交通和住宿费用" },
    { kind: "entry", action: "请核对线上账号或线下入场材料" },
    { kind: "rules", action: "请核对工具使用、署名和必交材料要求" },
    { kind: "submission", action: "请核对作品截止时刻、时区与提交回执" },
  ],
  roadshow: { suggestions: ["建议先用一句话解释用户问题"], pptChecklist: ["建议准备问题、方案、演示、限制和下一步"], rehearsalChecklist: ["建议用计时排练并保存录屏备份"] },
  assumptions: ["建议把任务工时视为估算，并按实际进展调整"],
};
