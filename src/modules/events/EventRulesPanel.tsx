import type { EventRuleVersion, RuleMoment } from "./domain.ts";
import { formatRuleMoment, isVerifiedRuleEvidence } from "./domain.ts";
import type { EventAnalysis } from "./model.ts";
import { resolveRuleDisplayTimeZone } from "./rule-display.ts";
import type { RuleDisplayTimeZone, RuleLocalTimeLabel } from "./rule-display.ts";

const factLabels: Record<string, string> = {
  eligibility: "参赛资格", fees: "费用", team_size: "团队规模", ai_policy: "AI 使用规则", beginner_eligibility: "新人资格",
};
const factStatus = { verified: "已核验", unverified: "待核验", unknown: "未说明 · 待确认", conflicted: "来源冲突 · 需复核" };
const qualityLabels = { needs_recheck: "关键字段需要复核", source_stale: "来源核验已过期", source_failed: "来源获取失败，保留已保存版本", missing_information: "有条款或时间尚未确认" };
const sourceLabels = { official: "官方来源", user_provided: "用户提供", secondary: "二手报道" };
const sourceStatus = { available: "可用", failed: "获取失败", removed: "原文已移除", stale: "需要重新核验" };
function EvidenceList({ ids, rules }: { ids: string[]; rules: EventRuleVersion }) {
  return <>{ids.map(id => {
    const evidence = rules.evidence.find(item => item.id === id);
    if (!evidence) return <p key={id}>证据暂不可用，需要复核。</p>;
    const source = rules.sources.find(item => item.id === evidence.sourceId);
    return <details key={id} style={{ marginTop: 8 }}>
      <summary>查看条款依据 {evidence.verifiedAt ? `· 核验于 ${evidence.verifiedAt}` : "· 尚未核验"}</summary>
      <blockquote style={{ margin: "8px 0" }}>{evidence.excerpt}</blockquote>
      <p>{evidence.locator}</p>
      {source && <p><a href={source.url} target="_blank" rel="noopener noreferrer">{sourceLabels[source.kind]}</a> · {sourceStatus[source.status]} · 快照时间 {source.fetchedAt}</p>}
    </details>;
  })}</>;
}
function Moment({ value, displayTimeZone, rules }: { value: RuleMoment | null; displayTimeZone: RuleDisplayTimeZone; rules: EventRuleVersion }) {
  if (!value) return <span>尚未确认</span>;
  const display = formatRuleMoment(value, displayTimeZone.timeZone);
  const verified = value.evidenceIds.length > 0 && value.evidenceIds.every(id => isVerifiedRuleEvidence(rules, id));
  return <span>{display.original}{display.local && <><br />{displayTimeZone.label}：{display.local}</>}{!verified && <><br />时间依据尚未核验。</>}{!display.precise && <><br />具体时刻或时区待确认，不能据此使用精确倒计时。</>}</span>;
}
/** Read-only server component. Routes supply persisted rules; it contains no demo data. */
export interface EventRulesPanelProps {
  rules: EventRuleVersion;
  timeZone?: string;
  localTimeLabel?: RuleLocalTimeLabel;
  /** Compatibility alias for existing callers. Missing/invalid values explicitly fall back to Beijing. */
  userTimeZone?: string;
  analysis?: (EventAnalysis & { backgroundFreshness?: "current" | "outdated" | "unknown" }) | null;
}
export function EventRulesPanel({ rules, timeZone, userTimeZone, localTimeLabel, analysis }: EventRulesPanelProps) {
  const displayTimeZone = resolveRuleDisplayTimeZone(timeZone ?? userTimeZone, localTimeLabel);
  return <article style={{ color: "var(--ink, #21201C)", lineHeight: 1.65 }}>
    <header>
      <p>赛事要求 · 规则版本 {rules.version}</p>
      <h1>{rules.metadata.name}</h1>
      <p>{rules.metadata.organizer} · {rules.metadata.region || "地域未说明"}</p>
      {rules.metadata.officialUrl ? <a href={rules.metadata.officialUrl} target="_blank" rel="noopener noreferrer">打开赛事入口</a> : <p>官方入口尚未确认。</p>}
    </header>
    {rules.qualityFlags.length > 0 && <aside aria-label="待复核状态" style={{ background: "var(--warning-bg, #FFF1D6)", color: "var(--warning, #845311)", padding: 16, marginTop: 24 }}>
      <ul>{rules.qualityFlags.map(flag => <li key={flag}>{qualityLabels[flag]}</li>)}</ul>
    </aside>}
    <section aria-labelledby="events-facts-heading">
      <h2 id="events-facts-heading">来源事实</h2>
      <dl>{rules.facts.map(fact => <div key={fact.key} style={{ borderBottom: "1px solid var(--line, #D9D4C8)", padding: "12px 0" }}>
        <dt>{factLabels[fact.key] ?? fact.key} · {factStatus[fact.status]}</dt>
        <dd style={{ marginLeft: 0 }}>{fact.statement}</dd>
        <EvidenceList ids={fact.evidenceIds} rules={rules} />
      </div>)}</dl>
    </section>
    <section aria-labelledby="events-stages-heading">
      <h2 id="events-stages-heading">各阶段时间</h2>
      <p>时间换算使用{displayTimeZone.label}。{displayTimeZone.fallback && "未提供有效的个人时区，默认使用北京时间。"}</p>
      {rules.stages.length === 0 && <p>阶段时间尚未确认。</p>}
      {rules.stages.map(stage => <section key={stage.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--line, #D9D4C8)" }}>
        <h3>{stage.name}</h3>
        <p>开始：<Moment value={stage.startsAt} displayTimeZone={displayTimeZone} rules={rules} /></p>
        <p>截止：<Moment value={stage.endsAt} displayTimeZone={displayTimeZone} rules={rules} /></p>
        <EvidenceList ids={[...new Set([...(stage.startsAt?.evidenceIds ?? []), ...(stage.endsAt?.evidenceIds ?? [])])]} rules={rules} />
        {stage.submissionUrl && <a href={stage.submissionUrl} target="_blank" rel="noopener noreferrer">打开本阶段提交入口</a>}
      </section>)}
    </section>
    <section aria-labelledby="events-requirements-heading">
      <h2 id="events-requirements-heading">提交材料</h2>
      {rules.requirements.length === 0 ? <p>必交材料尚未确认。</p> : <ul>{rules.requirements.map(item => <li key={item.id}>{item.label} · {{ required: "必交", optional: "可选", unknown: "是否必交待确认" }[item.necessity]}<EvidenceList ids={item.evidenceIds} rules={rules} /></li>)}</ul>}
    </section>
    {analysis?.content && <>
      <section aria-labelledby="events-analysis-heading" style={{ background: "var(--tint, #FBE9E2)", padding: 16 }}>
        <h2 id="events-analysis-heading">{analysis.origin === "model" ? "AI 建议" : "人工整理的建议"}</h2>
        <p>{analysis.status === "confirmed" ? "队伍已确认" : analysis.status === "superseded" ? "历史版本，已被替代" : "草案，等待项目管理员确认"} · 基于规则版本 {analysis.rulesVersion}、背景版本 {analysis.backgroundVersion}</p>
        {analysis.backgroundFreshness === "outdated" && <p>队伍背景已更新，这份建议基于旧背景，请重新核对。</p>}
        {analysis.backgroundFreshness === "unknown" && <p>尚未核对当前队伍背景版本。</p>}
        <ul>{analysis.content.suggestions.map((item, index) => <li key={index}>{item.text}<br />依据：{item.evidenceIds.join("、") || "无规则证据"}；团队输入：{item.backgroundKeys.join("、") || "未使用"}</li>)}</ul>
      </section>
      <section aria-labelledby="events-unknown-heading">
        <h2 id="events-unknown-heading">尚未确认</h2>
        <ul>{analysis.content.unknowns.map((item, index) => <li key={index}>{item.question}</li>)}</ul>
      </section>
    </>}
  </article>;
}
