import type { ParticipationContext, ParticipationPlan } from "./types.ts";

function plain(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/[<>]/g, char => char === "<" ? "&lt;" : "&gt;").replace(/[\\`*_\[\]#]/g, "\\$&");
}
function cell(value: string): string { return plain(value).replace(/\|/g, "\\|"); }
function bullets(values: readonly string[]): string { return values.map(item => `- ${plain(item)}`).join("\n"); }
function origin(value: ParticipationContext["facts"]["city"]["origin"]): string {
  return value === "event_source" ? "来源快照，待核实" : value === "user_supplement" ? "用户补充，未经来源核验" : "未知";
}

/** Browser-safe pure formatter. Export is a personal draft, never a submission receipt. */
export function participationPlanMarkdown(plan: ParticipationPlan): string {
  const context = plan.context;
  const content = [
    `# ${plain(plan.title)}`,
    "",
    `DSH 建议草案 · provider:dsh · 生成输入时间：${plain(context.currentTime)}`,
    `建议日期显示时区：${plain(context.planningTimeZone)}；日程日期与工时均为建议估算。`,
    `项目想法：${plain(plan.projectIdea || "待确定")}`,
    "",
    "## 赛事依据与待确认信息",
    "",
    `- 赛事：${plain(context.event.title)}`,
    `- 来源原始日期文字：${plain(context.event.eventDate || "未知")}`,
    `- 来源地点文字：${plain(context.event.location || "未知")}`,
    `- 城市：${plain(context.facts.city.value || "未知")}（${origin(context.facts.city.origin)}）`,
    `- 开赛时刻：${plain(context.facts.eventStartAt.value || "未知")}（${origin(context.facts.eventStartAt.origin)}）`,
    `- 参赛方式：${plain(context.facts.mode.value || "未知")}（${origin(context.facts.mode.origin)}）`,
    `- 作品提交截止：${plain(context.facts.submissionDeadline.value || "未知，请核对官方时刻及其时区")}（${origin(context.facts.submissionDeadline.origin)}）`,
    `- 来源：${context.event.sourceUrl}`,
    `- 报名入口：${context.event.registrationUrl ?? "未知；请从来源原文核对"}`,
    "",
    "## 建议阶段与任务",
    "",
    `总估算工时：${plan.estimatedTotalMinutes} 分钟；每日声明可用时间：${context.profile.availableHoursPerDay ?? "未知"} 小时。`,
    "验收条件用于任务完成后检查，不代表这些工作或报名操作已经完成。",
    "",
  ];
  for (const phase of plan.phases) {
    content.push(`### ${plain(phase.title)}（建议 ${phase.startDate} 至 ${phase.endDate}）`, "",
      "| 建议日期 | 任务 | 负责人 | 估算分钟 | 优先级 | 验收成果 | 完成后检查条件 |",
      "| --- | --- | --- | ---: | --- | --- | --- |");
    for (const task of phase.tasks) content.push(`| ${task.plannedDate} | ${cell(task.title)} | 本人 | ${task.durationMinutes} | ${task.priority === "must" ? "必需" : "可选"} | ${cell(task.deliverable)} | ${cell(task.acceptance.join("；"))} |`);
    content.push("");
  }
  content.push("## 出行与天气", "", plain(plan.travel.reason), "");
  if (plan.travel.suggestions.length) content.push(bullets(plan.travel.suggestions), "");
  if (plan.travel.checklist.length) content.push("出行核对：", "", bullets(plan.travel.checklist), "");
  content.push(`天气状态：${context.weather.status}。${plain(context.weather.note)}`, "");
  if (context.weather.status === "available") {
    content.push(`Open-Meteo 预报 · 查询城市：${plain(context.weather.requestedCity || "未知")} · 解析地点：${plain(context.weather.location?.name || "未知")} · 获取于 ${plain(context.weather.fetchedAt || "未知")}`);
    for (const day of context.weather.days) content.push(`- ${day.date}：最低 ${day.temperatureMinC}℃，最高 ${day.temperatureMaxC}℃，WMO 天气代码 ${day.weatherCode}${day.precipitationProbabilityMax === null ? "" : `，最大降水概率 ${day.precipitationProbabilityMax}%`}${day.windSpeedMaxKmh === null ? "" : `，最大风速 ${day.windSpeedMaxKmh} km/h`}。预报可能变化。`);
    content.push(`来源：${context.weather.sourceUrl}`, "");
  }
  if (plan.travel.weatherAdvice.length) content.push("DSH 条件性准备建议：", "", bullets(plan.travel.weatherAdvice), "");
  content.push("## 报名、费用、入场与提交核实", "");
  for (const item of plan.verification) content.push(`- 待确认：${plain(item.action)}；核对入口：${item.sourceUrl}`);
  content.push("", "## 路演与 PPT 准备", "", bullets(plan.roadshow.suggestions), "", "PPT 准备：", "", bullets(plan.roadshow.pptChecklist), "", "排练核对：", "", bullets(plan.roadshow.rehearsalChecklist), "", "## 风险与备选", "");
  for (const risk of plan.risks) content.push(`- 风险：${plain(risk.risk)}；应对：${plain(risk.mitigation)}；备选：${plain(risk.fallback)}`);
  if (plan.assumptions.length) content.push("", "## DSH 建议所用假设", "", bullets(plan.assumptions));
  content.push("", "## 草案限制与下一步", "", bullets(plan.notices), "");
  return content.join("\n");
}
