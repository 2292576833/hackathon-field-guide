"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AssistantShareSelection, AssistantSource, FeasibilityFinding, FeasibilityReportRecord, TeamAssistantContextSnapshot } from "./model.ts";
import { AssistantContextDetails, AssistantShareEditor, AssistantSources, assistantAccessWasLost, assistantByteLength, assistantDate, assistantErrorText, assistantHttpRequest, assistantResultIsUncertain } from "./TeamAssistantPanel.tsx";
import type { AssistantHttpRequest } from "./TeamAssistantPanel.tsx";
import styles from "./assistant.module.css";

export interface FeasibilityPanelProps {
  projectId: string;
  accountKey?: string;
  apiBase?: string;
  request?: AssistantHttpRequest;
  initialContext?: TeamAssistantContextSnapshot;
  initialReports?: readonly FeasibilityReportRecord[];
  onShare?: (selection: AssistantShareSelection) => void | Promise<void>;
  readOnly?: boolean;
  /** Root owns actual provider configuration; omitted state is checked by the request endpoint. */
  configured?: boolean;
}
const knowledgeLabels = { known: "当前资料有依据", needs_verification: "需要实际验证", unknown: "资料不足 · 未知" };
function FindingList({ title, findings, sources, share }: { title: string; findings: readonly FeasibilityFinding[]; sources: readonly AssistantSource[]; share?: (fragment: string) => void }) {
  return <section className={styles.reportSection}>
    <h4>{title}</h4>
    {findings.length === 0 ? <p className={styles.muted}>报告未提供这一项，请补充核对。</p> : findings.map((finding, index) => <div className={styles.finding} key={index}>
      <div className={styles.findingHeading}><strong>{finding.title}</strong><span className={`${styles.badge} ${finding.knowledge === "known" ? styles.known : styles.unknown}`}>{knowledgeLabels[finding.knowledge]}</span></div>
      <p className={styles.reportSummary}>{finding.detail}</p>
      {finding.evidenceSourceIds.length > 0 && <details><summary>查看本项依据</summary><AssistantSources sources={finding.evidenceSourceIds.map(id => sources.find(source => source.id === id) ?? { id, label: "此项依据暂不可用，请重新核对" })} /></details>}
      {share && <div><button className={styles.textButton} type="button" onClick={() => share(finding.detail)}>选择这段建议分享</button></div>}
    </div>)}
  </section>;
}
function ReportView({ record, onSelect }: { record: FeasibilityReportRecord; onSelect?: (fragment: string) => void }) {
  const report = record.data.report;
  return <article className={styles.report}>
    <header className={styles.reportHeader}><h3>{record.title}</h3><p className={styles.muted}>本人报告 · DSH · {assistantDate(record.createdAt)}</p><p className={styles.reportSummary}>{report.summary}</p>
      {record.stale && <p className={styles.notice}>空间目标、规则、计划或共享资料已变化。这份历史报告需重新检查，不能作为当前事实分享。</p>}
      {onSelect && <div><button className={styles.textButton} type="button" onClick={() => onSelect(report.summary)}>选择报告摘要分享</button></div>}
    </header>
    <details open><summary>查看检查报告</summary>
      <section className={styles.reportSection}><h4>这次检查的想法</h4><p className={styles.reportSummary}>{record.data.idea}</p></section>
      <FindingList title="规则适配" findings={report.ruleFit} sources={record.data.sources} share={onSelect} />
      <section className={styles.reportSection}><h4>最小可演示流程 · AI 建议</h4><ol>{report.minimumDemo.flow.map((step, index) => <li key={index}>{step}</li>)}</ol><p><strong>怎样检查：</strong>{report.minimumDemo.successCheck}</p>{report.minimumDemo.excluded.length > 0 && <div><strong>本次先不做：</strong><ul>{report.minimumDemo.excluded.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</section>
      <FindingList title="技术待验证点" findings={report.technicalChecks} sources={record.data.sources} share={onSelect} />
      <FindingList title="团队能力与时间" findings={report.teamAndTime} sources={record.data.sources} share={onSelect} />
      <FindingList title="风险与应对" findings={report.risks} sources={record.data.sources} share={onSelect} />
      <section className={styles.reportSection}><h4>下一步验证任务 · 尚未创建到计划</h4><p className={styles.muted}>先完成真实验证，再由团队确认目标、职责与计划。</p>{report.validationTasks.map((task, index) => <div className={styles.task} key={index}><strong>{index + 1}. {task.title}</strong><p>交付物：{task.deliverable}</p><p>检查条件：{task.check}</p><p>建议职责：{task.suggestedRole}</p><p className={styles.muted}>先要完成：{task.dependsOn.length ? task.dependsOn.join("、") : "无报告内前置验证，可先开始"}</p></div>)}</section>
      <section className={styles.reportSection}><h4>仍需确认</h4>{report.unknowns.length ? <ul>{report.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className={styles.muted}>报告未列出额外未知项，仍须核对真实资格、接口、费用和运行结果。</p>}{record.data.missing.length > 0 && <div><strong>生成时未提供的空间资料：</strong><ul>{record.data.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</section>
      <details><summary>查看报告来源</summary><AssistantSources sources={record.data.sources} /></details>
    </details>
  </article>;
}
/** Reports stay private until the user previews and confirms an excerpt for team publication. */
export function FeasibilityPanel(props: FeasibilityPanelProps) { return <FeasibilitySession key={`${props.accountKey ?? "session"}:${props.projectId}`} {...props} />; }
function FeasibilitySession({ projectId, apiBase = `/api/projects/${encodeURIComponent(projectId)}`, request = assistantHttpRequest, initialContext, initialReports = [], onShare, readOnly = false, configured }: FeasibilityPanelProps) {
  const headingId = useId(), ideaId = useId(), helpId = useId();
  const [context, setContext] = useState<TeamAssistantContextSnapshot | null>(initialContext?.projectId === projectId ? initialContext : null);
  const [reports, setReports] = useState<readonly FeasibilityReportRecord[]>(initialReports.filter(record => record.data.projectId === projectId));
  const [idea, setIdea] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [contextError, setContextError] = useState("");
  const [status, setStatus] = useState("");
  const [selection, setSelection] = useState<AssistantShareSelection | null>(null);
  const [uncertainIdea, setUncertainIdea] = useState<string | null>(null);
  const mounted = useRef(true), activeRead = useRef(false), activeGeneration = useRef(false);
  const refresh = useCallback(async (preserveError = false) => {
    if (activeRead.current) return;
    activeRead.current = true; if (mounted.current) setRefreshing(true);
    const results = await Promise.allSettled([
      request<TeamAssistantContextSnapshot>(`${apiBase}/assistant/context`),
      request<readonly FeasibilityReportRecord[]>(`${apiBase}/feasibility-reports`),
    ]);
    if (mounted.current) {
      if (results.some(result => result.status === "rejected" && assistantAccessWasLost(result.reason))) {
        setContext(null); setReports([]); setSelection(null); setContextError("");
        setError("登录状态或空间权限已变化，旧私人报告已收起。请重新登录或确认空间访问权限。");
      } else {
      if (results[0].status === "fulfilled" && results[0].value.projectId === projectId) { setContext(results[0].value); setContextError(""); }
      else { setContextError("当前资料未能核对，请保留想法并重新读取后再请求。"); setContext(null); }
      if (results[1].status === "fulfilled") { setReports(results[1].value.filter(record => record.data.projectId === projectId)); if (!preserveError) setError(""); }
      else setError(`${assistantErrorText(results[1].reason)} 已显示的报告来自上次读取，可能较旧。`);
      }
      setRefreshing(false); setLoading(false);
    }
    activeRead.current = false;
  }, [apiBase, projectId, request]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  const bytes = assistantByteLength(idea.trim());
  const repeatsUnknown = uncertainIdea !== null && uncertainIdea.trim() === idea.trim();
  const canGenerate = Boolean(context) && !readOnly && configured !== false && !generating && !refreshing && bytes > 0 && bytes <= 12000 && !repeatsUnknown;
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context || !canGenerate || activeGeneration.current) return;
    const requestedIdea = idea.trim(), expectedContextFingerprint = context.fingerprint;
    activeGeneration.current = true; setGenerating(true); setError(""); setStatus("DSH 正在检查当前想法、规则与最小演示范围…");
    try {
      const record = await request<FeasibilityReportRecord>(`${apiBase}/feasibility-reports`, { method: "POST", body: { idea: requestedIdea, expectedContextFingerprint } });
      if (!mounted.current) return;
      setReports(previous => [record, ...previous.filter(item => item.id !== record.id)]);
      setUncertainIdea(null); setStatus("选题检查已保存为本人报告，可以先核对，再选择摘录分享。");
    } catch (cause) {
      if (!mounted.current) return;
      if (assistantAccessWasLost(cause)) { setContext(null); setReports([]); setSelection(null); }
      if (assistantResultIsUncertain(cause)) setUncertainIdea(requestedIdea);
      setError(assistantErrorText(cause)); setStatus("想法已保留，请先读取保存报告。页面不会自动重发请求。");
    } finally {
      activeGeneration.current = false;
      if (mounted.current) { setGenerating(false); await refresh(true); }
    }
  }
  const selectedReport = selection ? reports.find(record => record.id === selection.sourceId) : undefined;
  return <section className={styles.panel} aria-labelledby={headingId}>
    <header className={styles.header}><div className={styles.intro}><p className={styles.eyebrow}>本人报告 · DSH</p><h2 id={headingId}>选题检查</h2><p className={styles.muted}>把想法拆成最小演示、待验证技术与团队下一步，供你核对后讨论。</p></div><button className={styles.button} type="button" onClick={() => void refresh()} disabled={refreshing || generating}>{refreshing ? "正在读取…" : "核对资料与报告"}</button></header>
    {loading && <p className={styles.empty} role="status">正在读取本人的报告与当前空间资料…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {contextError && <p className={styles.notice}>{contextError}</p>}
    {configured === false && <p className={styles.notice}>选题检查尚未连接 DSH，可以查看已保存报告；当前无法生成新报告。</p>}
    {readOnly && <p className={styles.notice}>当前空间只可查看，暂时不能请求新报告或分享。</p>}
    {uncertainIdea && <p className={styles.notice}>上一次报告请求结果尚未核清。请先核对保存报告，需要时请管理员核查；同一想法不能直接重发，可以明确提出不同的新想法。</p>}
    <AssistantContextDetails context={context} purpose="feasibility" />
    <form className={styles.form} onSubmit={event => void generate(event)}><label className={styles.label} htmlFor={ideaId}>你想做什么作品？</label><textarea className={styles.textarea} id={ideaId} value={idea} onChange={event => setIdea(event.target.value)} disabled={readOnly} aria-describedby={helpId} placeholder="写下服务谁、解决什么问题、准备如何演示。还没确定的部分也可以说明。" /><div className={styles.formFooter}><p id={helpId} className={styles.muted}>{bytes > 12000 ? "想法过长，请缩短到 12000 字节以内。" : repeatsUnknown ? "这与尚未核清的想法相同，请先核对已保存报告。" : "点击后明确请求 DSH 并保存私人报告；不会自动修改目标、分工或计划。"}</p><button className={styles.primary} type="submit" disabled={!canGenerate}>{generating ? "正在请求检查…" : "请求并保存选题检查"}</button></div></form>
    <p className={styles.status} role="status" aria-live="polite">{status}</p>
    {!loading && reports.length === 0 && <div className={styles.empty}><p>还没有本人选题报告。</p><p className={styles.muted}>先核对当前资料，写下一个可演示的想法，再明确请求检查。</p></div>}
    <div className={styles.reports}>{reports.map(record => <div key={record.id}><ReportView record={record} onSelect={onShare && !readOnly && !record.stale ? fragment => setSelection({ sourceKind: "feasibility", sourceId: record.id, fragment }) : undefined} />{selection?.sourceId === record.id && onShare && !readOnly && !record.stale && <AssistantShareEditor key={`${record.id}-${selection.fragment}`} selection={selection} onShare={onShare} onClose={() => setSelection(null)} />}</div>)}</div>
    {selection && (!selectedReport || selectedReport.stale) && <p className={styles.notice}>这份报告的上下文已变化，请重新核对后再选择分享。</p>}
    <p className={styles.muted}>报告依据本次提供的资料；资格、API、费用与真实运行结果仍需实际核对，不能保证获奖或提交成功。</p>
  </section>;
}
