"use client";

import type { PlanVersion } from "./types.ts";
import { planDifferenceTimeZoneLabel, presentPlanChanges } from "./diff-presentation.ts";
import styles from "./plan-changes.module.css";

export interface PlanChangesPanelProps {
  plan: PlanVersion;
  /** The immutable base version, if still readable; never substitute a newer current plan. */
  baseline: PlanVersion | null;
  memberNames?: Readonly<Record<string, string>>;
  timeZone?: string;
}

export function PlanChangesPanel({ plan, baseline, memberNames, timeZone }: PlanChangesPanelProps) {
  const groups = presentPlanChanges(plan.changes, { beforeInput: baseline?.inputSnapshot, afterInput: plan.inputSnapshot, beforeTasks: baseline?.tasks, afterTasks: plan.tasks, memberNames, timeZone });
  return <section aria-label="计划逐项差异" className={styles.panel}>
    <h3>逐项核对旧安排与新草案</h3>
    <p>下列差异来自已保存草案。时间：{planDifferenceTimeZoneLabel(timeZone)}，来源时区另列。保存草案尚未采用这些调整。</p>
    {groups.length === 0 ? <p>这份草案没有已保存的安排差异。仍需核对当前校验结果。</p> : groups.map((group, index) => <section className={styles.group} key={`${group.title}:${index}`}>
      <h4>{group.title}{group.major ? " · 需要重点核对" : ""}</h4>
      <p>{group.impact}</p>
      <div className={styles.scroll}><table className={styles.table}><thead><tr><th scope="col">核对项</th><th scope="col">原安排 / 原依据</th><th scope="col">新草案 / 新依据</th></tr></thead><tbody>{group.rows.map((row, rowIndex) => <tr key={`${row.label}:${rowIndex}`}><th scope="row">{row.label}</th><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody></table></div>
    </section>)}
  </section>;
}
