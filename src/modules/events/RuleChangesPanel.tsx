import type { EventRuleVersion } from "./domain.ts";
import type { ProjectRuleChanges } from "./model.ts";
import { formatRuleChangeValue, resolveRuleDisplayTimeZone, ruleChangeRows } from "./rule-display.ts";
import styles from "./event-completion.module.css";

export interface RuleChangesPanelProps {
  comparison: ProjectRuleChanges;
  currentRules?: EventRuleVersion | null;
  latestRules?: EventRuleVersion | null;
  timeZone?: string;
}
/** Read-only projection of GET projects/:id/rules/changes; no confirming or plan mutations. */
export function RuleChangesPanel({ comparison, currentRules, latestRules, timeZone }: RuleChangesPanelProps) {
  const display = resolveRuleDisplayTimeZone(timeZone);
  const rows = ruleChangeRows(comparison.changes, { currentRules, latestRules });
  return <section className={styles.panel} aria-label="规则逐字段变化">
    <h2>规则哪里变了</h2>
    {!comparison.confirmation ? <p>队伍尚未确认正式规则版本，暂时没有可比较的版本。</p> : comparison.publicationUnavailable ? <p className={styles.warning}>目前没有可读取的新公开版本。队伍已确认的规则版本 {comparison.confirmation.rulesVersion} 仍保留，请核对官网或联系审核员。</p> : <>
      <p>队伍已确认版本 {comparison.confirmation.rulesVersion} → 最新公开版本 {comparison.latestVersion ?? "尚未确认"}</p>
      {comparison.needsConfirmation && <p className={styles.notice}>有新公开版本，请逐项核对后由项目管理员确认。现有计划的任务与截止时间仍需另行核对。</p>}
      <p className={styles.muted}>时间换算使用{display.label}。{display.fallback && "未提供有效的个人时区，默认使用北京时间。"}原文时区与日期精度按来源保留。</p>
      {rows.length === 0 ? <p>{comparison.needsConfirmation ? "新版本没有可展示的字段内容变化，仍需核对版本来源。" : "当前已确认版本与最新公开版本没有字段差异。"}</p> : <ul className={styles.list}>{rows.map(row => <li key={row.path} className={styles.record}>
        <div className={styles.heading}><h3>{row.label}</h3><span className={styles.status}>{{ added: "新增", removed: "移除", changed: "变更" }[row.kind]}</span></div>
        <dl className={styles.diff}><div><dt>队伍已确认的内容</dt><dd>{formatRuleChangeValue(row.before, row.path, display.timeZone)}</dd></div><div><dt>最新公开内容</dt><dd>{formatRuleChangeValue(row.after, row.path, display.timeZone)}</dd></div></dl>
      </li>)}</ul>}
    </>}
  </section>;
}
