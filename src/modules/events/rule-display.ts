import type { EventRuleVersion, RuleChange } from "./domain.ts";

export interface RuleDisplayTimeZone { readonly timeZone: string; readonly label: string; readonly fallback: boolean }
export type RuleLocalTimeLabel = "账号时间" | "浏览器时间" | "北京时间";
/** A default or invalid zone is explicitly Beijing time, never the viewer's inferred zone. */
export function resolveRuleDisplayTimeZone(value?: string | null, localTimeLabel?: RuleLocalTimeLabel): RuleDisplayTimeZone {
  if (value) {
    try {
      const timeZone = new Intl.DateTimeFormat("zh-CN", { timeZone: value }).resolvedOptions().timeZone;
      const label = localTimeLabel && (localTimeLabel !== "北京时间" || timeZone === "Asia/Shanghai") ? localTimeLabel : timeZone === "Asia/Shanghai" ? "北京时间" : `所选时区 ${timeZone}`;
      return { timeZone, label, fallback: false };
    } catch { /* Use the documented display fallback; rule source timezone is preserved separately. */ }
  }
  return { timeZone: "Asia/Shanghai", label: "北京时间", fallback: true };
}
const fields: Record<string, string> = {
  metadata: "赛事信息", name: "名称", organizer: "主办方", format: "形式", region: "地域", officialUrl: "官方入口",
  facts: "规则事实", eligibility: "参赛资格", fees: "费用", team_size: "团队规模", ai_policy: "AI 使用规则", beginner_eligibility: "新人资格", statement: "说明", status: "状态", evidenceIds: "依据",
  stages: "阶段", stageType: "阶段类型", startsAt: "开始时间", endsAt: "截止时间", rawText: "原文时间", timeZone: "原文时区", utc: "换算时间", dateOnly: "是否仅有日期", submissionUrl: "提交入口",
  requirements: "提交材料", label: "名称", necessity: "是否必交", stageId: "适用阶段",
  officialTracks: "官方赛道", tracks: "赛道", scoringFocus: "评分重点", deliverables: "交付要求", requirementId: "材料编号", text: "说明",
  sources: "来源", url: "链接", kind: "类型", contentHash: "内容版本标识", fetchedAt: "获取时间", trustScope: "依据范围", sourceConfigId: "来源配置编号",
  evidence: "条款依据", sourceId: "来源编号", fieldKey: "对应字段", excerpt: "原文摘录", locator: "原文位置", rawDateText: "日期原文", verifiedBy: "核验人", verifiedAt: "核验时间", conflictsWith: "冲突依据",
  qualityFlags: "待复核提示",
};
const valueLabels: Record<string, string> = {
  required: "必交", optional: "可选", unknown: "未说明，待确认", verified: "已核验", unverified: "待核验", conflicted: "来源冲突", conflict: "来源冲突", confirmed: "已确认", none: "官方已明确未细分赛道",
  online: "线上", offline: "线下", hybrid: "线上与线下", registration: "报名", development: "开发", submission: "提交", pitch: "路演", other: "其他",
  official: "官方来源", user_provided: "用户提供", secondary: "二手报道", available: "可用", failed: "获取失败", removed: "原文已移除", stale: "需重新核验",
  official_rules: "官方规则", user_claim: "用户陈述", secondary_report: "二手报道",
  needs_recheck: "关键字段需要复核", source_stale: "来源核验已过期", source_failed: "来源获取失败", missing_information: "信息尚未确认",
};
const decodePointer = (value: string) => value.replace(/~1/g, "/").replace(/~0/g, "~");
const encodePointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keyedList(value: unknown): value is (Record<string, unknown> & { id: string })[] { return Array.isArray(value) && value.length > 0 && value.every(item => object(item) && typeof item.id === "string"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (object(value)) return JSON.stringify(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return JSON.stringify(value) ?? "null";
}
export interface RuleChangeRow extends RuleChange { readonly label: string; readonly kind: "added" | "removed" | "changed" }
/** Expand inserted/removed records and stable-ID arrays so users can inspect every changed field. */
export function ruleChangeRows(changes: readonly RuleChange[], context: { currentRules?: EventRuleVersion | null; latestRules?: EventRuleVersion | null } = {}): readonly RuleChangeRow[] {
  const rows: RuleChange[] = [];
  function visit(path: string, before: unknown, after: unknown): void {
    if (canonical(before) === canonical(after)) return;
    if ((object(before) || before == null) && (object(after) || after == null) && (object(before) || object(after))) {
      const left = object(before) ? before : {}, right = object(after) ? after : {};
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (["id", "eventId", "version"].includes(key)) continue;
        visit(`${path}/${encodePointer(key)}`, left[key] ?? null, right[key] ?? null);
      }
    } else if ((keyedList(before) || before == null || Array.isArray(before) && before.length === 0) && (keyedList(after) || after == null || Array.isArray(after) && after.length === 0) && (keyedList(before) || keyedList(after))) {
      const left = new Map((Array.isArray(before) ? before : []).map(item => [item.id as string, item]));
      const right = new Map((Array.isArray(after) ? after : []).map(item => [item.id as string, item]));
      for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) visit(`${path}/${encodePointer(id)}`, left.get(id) ?? null, right.get(id) ?? null);
    } else rows.push({ path, before: before ?? null, after: after ?? null });
  }
  for (const change of changes) visit(change.path, change.before, change.after);
  function label(path: string): string {
    const parts = path.split("/").slice(1).map(decodePointer);
    const name = parts[0], id = parts[1];
    const versions = [context.latestRules, context.currentRules].filter((rules): rules is EventRuleVersion => !!rules);
    const child = versions.flatMap(rules => name === "stages" ? rules.stages.map(stage => ({ id: stage.id, label: stage.name })) : name === "requirements" ? rules.requirements.map(item => ({ id: item.id, label: item.label })) : name === "sources" ? rules.sources.map(source => ({ id: source.id, label: source.kind === "official" ? "官方来源" : source.kind === "secondary" ? "二手报道" : "用户提供" })) : []).find(item => item.id === id);
    return parts.map((part, index) => index === 1 && child ? child.label : fields[part] ?? part).join(" · ");
  }
  return rows.map(row => ({ ...row, label: label(row.path), kind: row.before === null ? "added" : row.after === null ? "removed" : "changed" }));
}
export function formatRuleChangeValue(value: unknown, path: string, timeZone?: string): string {
  if (value == null || value === "") return "未填写或不存在";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.length ? value.map(item => formatRuleChangeValue(item, path, timeZone)).join("\n") : "无条目";
  if (object(value)) return Object.entries(value).map(([key, item]) => `${fields[key] ?? key}：${formatRuleChangeValue(item, `${path}/${key}`, timeZone)}`).join("\n");
  if (typeof value === "string") {
    if (/\/(utc|fetchedAt|verifiedAt)$/.test(path) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
      const display = resolveRuleDisplayTimeZone(timeZone);
      return `${new Intl.DateTimeFormat("zh-CN", { timeZone: display.timeZone, dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(new Date(value))}（${display.label}）\n原值：${value}`;
    }
    return /\/(status|necessity|format|stageType|kind|trustScope|qualityFlags)$/.test(path) ? valueLabels[value] ?? value : value;
  }
  return String(value);
}
