"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CurrentPlanningView } from "../modules/planning/index.ts";
import type { ProjectOfficialTracksView } from "../modules/projects/index.ts";
import { buildSpaceLifecycle, buildSubmissionChecklist, initialSpacePhase, publicHttpLink, spacePhaseGuides, submissionRecordLabel,
  type ReadState, type SpaceDeliverySummary, type SpaceLink, type SpacePhase, type SpaceRules, type SubmissionStageView } from "../modules/space-workflow/index.ts";
import type { SubmissionRecord } from "../modules/github/index.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import { dateText, useApi } from "./client-api.ts";
import { SpaceGuideTree } from "./space-guide-tree.tsx";
import styles from "./space-lifecycle.module.css";
import noviceStyles from "./novice-workspace.module.css";

function readState<T>(value: { data: T | null; loading: boolean; error: Error | null }): ReadState<T> {
  if (value.error) return { status: "error", message: value.error.message };
  if (value.loading) return { status: "loading" };
  return value.data === null ? { status: "unread" } : { status: "ready", value: value.data };
}
function ActionLinks({ links }: { links: readonly SpaceLink[] }) {
  return <ul className={styles.links}>{links.map(link => <li key={link.href}><Link className={styles.link} href={link.href}>{link.title} →</Link><p>{link.purpose}</p></li>)}</ul>;
}
export interface SpaceLifecycleProps {
  detail: ProjectDetail;
  current: CurrentPlanningView | null;
  planningLoading?: boolean;
  planningError?: unknown;
}
/** The parent owns current-plan reads. Phase browsing changes only local display. */
export function SpaceLifecycle(props: SpaceLifecycleProps) {
  return <LifecycleContent key={`${props.detail.project.id}:${props.detail.membership.userId}`} {...props}/>;
}
function LifecycleContent({ detail, current, planningLoading, planningError }: SpaceLifecycleProps) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}`;
  const rules = useApi<SpaceRules>(`${base}/rules`, { timeoutMs: 15_000 });
  const tracks = useApi<ProjectOfficialTracksView>(`${base}/official-tracks`, { timeoutMs: 15_000 });
  const input = { detail, current, planningLoading, planningError, rules: readState(rules), tracks: readState(tracks) };
  const model = buildSpaceLifecycle(input);
  const [selected, setSelected] = useState<SpacePhase>(() => initialSpacePhase(detail.project.stage));
  const guides = spacePhaseGuides(detail.project.id);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]), id = useId();
  const lastProjectRevision = useRef(detail.project.revision);
  useEffect(() => { setSelected(initialSpacePhase(detail.project.stage)); }, [detail.project.stage]);
  useEffect(() => {
    if (lastProjectRevision.current === detail.project.revision) return;
    lastProjectRevision.current = detail.project.revision;
    void rules.reload(); void tracks.reload();
  }, [detail.project.revision, rules.reload, tracks.reload]);
  useEffect(() => {
    const refresh = () => { void rules.reload(); void tracks.reload(); };
    window.addEventListener("hackathon:project-input-changed", refresh);
    return () => window.removeEventListener("hackathon:project-input-changed", refresh);
  }, [rules.reload, tracks.reload]);
  function browse(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let target: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = (index + 1) % guides.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = (index + guides.length - 1) % guides.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = guides.length - 1;
    else return;
    event.preventDefault(); setSelected(guides[target]!.id); tabs.current[target]?.focus();
  }
  const activePhaseName = guides.find(item => item.id === model.initialPhase)!.title;
  return <>
    {rules.error && <p className={styles.notice} role="status">比赛要求读取失败，当前规则未知。<button type="button" className={styles.textButton} disabled={rules.loading} onClick={() => void rules.reload()}>重新读取要求</button></p>}
    {tracks.error && <p className={styles.notice} role="status">官方赛道读取失败，不能按未划分赛道处理。<button type="button" className={styles.textButton} disabled={tracks.loading} onClick={() => void tracks.reload()}>重新读取赛道</button></p>}
    {tracks.data && !tracks.error && !tracks.loading && tracks.data.needsReview && <p className={styles.notice}>官方赛道或规则需要复核。<Link className={styles.link} href={`/app/projects/${encodeURIComponent(detail.project.id)}/rules`}>核对最新比赛要求 →</Link></p>}
    <details className={`${styles.workbench} ${noviceStyles.guideDetails}`} aria-label="完整参赛指引与阶段工具">
    <summary>完整参赛指引与阶段工具（需要时展开）</summary>
    <div className={styles.heading}><div><h2>按阶段查行动与工具</h2></div><span className={styles.badge}>{model.readonly ? "归档只读" : `当前安排：${activePhaseName}`}</span></div>
    <p className={styles.muted}>当前行动先看上方“我的下一步”。这里补充整套流程和工具，展开不会修改阶段或任务记录。</p>
    {model.readonly && <p className={styles.notice}>空间已归档，工作记录只读。下方行动和工具可供回顾，不能把浏览当作新的进展。</p>}
    <SpaceGuideTree input={input}/>
    {model.relatedTasks.length > 0 && <div className={styles.taskShortcuts}><h3>与我有关的当前任务</h3><ul>{model.relatedTasks.map(task => <li key={task.id}><Link className={styles.link} href={task.href}>{task.title} →</Link><span className={styles.badge}>{({ todo: "查看开始条件", in_progress: "正在做", blocked: "需要帮助", review: "查看检查依据" } as Record<string, string>)[task.status] ?? "查看任务"}</span></li>)}</ul></div>}
    <details className={styles.compactDetails}><summary>作品目标与最小成果</summary><dl className={styles.facts}><div><dt>作品要解决的问题</dt><dd>{model.goal.trim() || "还未写清，与管理员一起补充。"}</dd></div><div><dt>这次至少做出什么</dt><dd>{model.minimumDeliverable.trim() || "还未写清，先确定能体验的一条完整流程。"}</dd></div></dl></details>
    {model.deadline && <p className={styles.notice}><strong>{model.deadline.label}：</strong>{dateText(model.deadline.instant)}<br/>{model.deadline.basis}{model.deadline.fromSnapshot && <><br/>来自当前计划快照，仍需核对主办方是否有新要求。</>}</p>}
    {tracks.data && !tracks.error && !tracks.loading && !tracks.data.needsReview && <p className={styles.muted}>{tracks.data.rules?.catalog.status === "none" ? "当前已确认规则标明主办方未细分赛道，按统一要求准备。" : tracks.data.selection?.trackName ? `已保存的官方赛道选择：${tracks.data.selection.trackName}。` : "官方赛道选择仍待核对；工具与技能包分类不代替官方赛道。"}</p>}
    <details className={styles.compactDetails}><summary>按阶段查看补充说明</summary>
    <div role="tablist" aria-label="浏览参赛阶段" className={styles.phases}>
      {guides.map((phase, index) => <button key={phase.id} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`${id}-${phase.id}-tab`} aria-controls={`${id}-${phase.id}-panel`} aria-selected={selected === phase.id} tabIndex={selected === phase.id ? 0 : -1} className={styles.phase} onClick={() => setSelected(phase.id)} onKeyDown={event => browse(event, index)}>{phase.title}</button>)}
    </div>
    {guides.map(guide => <div role="tabpanel" hidden={selected !== guide.id} key={guide.id} id={`${id}-${guide.id}-panel`} aria-labelledby={`${id}-${guide.id}-tab`} className={styles.phaseContent}>
      {selected === guide.id && <><h3>{guide.title}</h3><p>{guide.purpose}</p>
        <div className={styles.compactActions}>{guide.actions.map(action => <Link className={styles.link} href={action.href} key={action.href}>{action.title} →</Link>)}</div>
        <details className={styles.compactDetails}><summary>查看这个阶段的行动说明与可选工具</summary><div className={styles.columns}><div><h4>行动说明</h4><ActionLinks links={guide.actions}/></div><div><h4>需要时用这些工具</h4><ActionLinks links={guide.tools}/></div></div><p className={styles.caution}>{guide.caution}</p></details></>}
    </div>)}
    </details>
  </details></>;
}

export function SpaceSubmissionChecklist({ detail }: { detail: ProjectDetail }) {
  return <SubmissionChecklistContent key={`${detail.project.id}:${detail.membership.userId}`} detail={detail}/>;
}
function SubmissionChecklistContent({ detail }: { detail: ProjectDetail }) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}`, pageBase = `/app/projects/${encodeURIComponent(detail.project.id)}`;
  const rules = useApi<SpaceRules>(`${base}/rules`, { timeoutMs: 15_000 });
  const summary = useApi<SpaceDeliverySummary>(`${base}/delivery-summary`, { timeoutMs: 15_000 });
  const view = buildSubmissionChecklist(readState(rules), readState(summary));
  const readonly = detail.project.stage === "archived";
  useEffect(() => {
    const repositoryUpdated = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === detail.project.id) void summary.reload();
    };
    window.addEventListener("hackathon:repository-updated", repositoryUpdated);
    return () => window.removeEventListener("hackathon:repository-updated", repositoryUpdated);
  }, [detail.project.id, summary.reload]);
  return <section className={styles.checklist} aria-label="提交前核对清单">
    <h2>提交前核对清单</h2><p className={styles.muted}>按本场比赛要求逐项核对。清单展示上次读取的事实；保存新的运行或提交记录后，请重新读取。这里不另存勾选或完成进度。</p>
    {readonly && <p className={styles.notice}>空间已归档，提交与运行记录只读。</p>}
    <div className={styles.actions}><Link className={styles.link} href={`${pageBase}/rules`}>查看比赛要求与官方赛道 →</Link><button type="button" className={styles.secondary} disabled={rules.loading || summary.loading} onClick={() => { void rules.reload(); void summary.reload(); }}>重新读取核对清单</button></div>
    <p className={view.rulesStatus === "ready" ? styles.muted : styles.notice} role={view.rulesStatus === "error" ? "status" : undefined}>{view.rulesNotice}</p>
    {view.generalRequirements.length > 0 && <div className={styles.item}><h3>各阶段通用材料</h3><Requirements items={view.generalRequirements}/></div>}
    <div className={styles.columns}>
      <div className={styles.item}><h3>代码与成果保存</h3><p>{view.repositoryNotice}</p>{view.savedCommit && <p className={styles.muted}>最近已保存版本：<code>{view.savedCommit}</code></p>}<Link className={styles.link} href={`${pageBase}/delivery#repository-save`}>查看保存操作与恢复方式 →</Link></div>
      <div className={styles.item}><h3>当前版本能否运行</h3><p>{view.runtimeNotice}</p>{view.deliveryStatus === "ready" && <p className={styles.muted}>已有 {view.historicalRuntimeCount} 条运行历史；只核对当前已保存版本对应的记录。</p>}<Link className={styles.link} href={`${pageBase}/delivery#delivery-verification`}>{readonly ? "查看实际运行依据" : "查看或记录实际运行"} →</Link></div>
    </div>
    <div className={styles.item}><h3>演示与展示材料</h3><p>Demo、PPT、视频或讲稿是否必交，按上方已确认规则核对。空间没有这些材料的完成记录，需要查看实际文件与演示。</p><ActionLinks links={[
      { title: "准备路演讲稿", href: `/roadshow?projectId=${encodeURIComponent(detail.project.id)}`, purpose: "带入当前空间供本人确认；讲稿保存在本人账号，采用和分享仍需本人操作。" },
      { title: "准备 PPT 大纲", href: `/ppt?projectId=${encodeURIComponent(detail.project.id)}`, purpose: "带入当前空间供本人确认；大纲仍保存在本人账号，浏览或生成不会记为已完成材料。" },
    ]}/></div>
    <div className={styles.submissions}><h3>逐个阶段核对正式提交</h3><p className={styles.notice} role={view.deliveryStatus === "error" ? "status" : undefined}>{view.deliveryNotice}</p>
      {view.rulesStatus === "ready" && view.stages.length === 0 && <p>已确认规则里还没有可明确展示的提交阶段。请回比赛要求核对主办方原文，不能据此认定无需提交。</p>}
      {view.stages.map(stage => <article className={styles.item} key={stage.id} aria-label={`提交阶段：${stage.title}`}><h4>{stage.title}</h4>
        <Requirements items={stage.requirements}/><p className={styles.muted}>规则记录的阶段结束时间：{stage.deadline?.utc && !stage.deadline.dateOnly ? dateText(stage.deadline.utc) : stage.deadline?.rawText || "待核对"}{stage.deadline?.timeZone && ` · 原时区 ${stage.deadline.timeZone}`}</p>
        {stage.officialUrl ? <a className={styles.link} href={stage.officialUrl} target="_blank" rel="noopener noreferrer">打开本阶段官方入口（新窗口） →</a> : <p className={styles.notice}>本阶段官方提交入口待核对，请到比赛要求查看原文。</p>}
        {view.deliveryStatus === "ready" && (stage.records.length ? <SubmissionRecords records={stage.records}/> : <p>当前规则版本的这个阶段还没有提交记录。没有记录不能判断是否已在官网提交。</p>)}
      </article>)}
      {view.history.length > 0 && <details className={styles.item}><summary>其它规则或阶段的提交历史（{view.history.length}）</summary><p className={styles.muted}>这些记录不属于上方当前规则的提交阶段，保留作为历史依据。</p><SubmissionRecords records={view.history}/></details>}
      {view.unclassifiedRecords.length > 0 && <details className={styles.item}><summary>已读取、待核对所属阶段的记录（{view.unclassifiedRecords.length}）</summary><p className={styles.muted}>当前规则未读完整，暂不判断这些记录对应哪个当前阶段。</p><SubmissionRecords records={view.unclassifiedRecords}/></details>}
      <p className={styles.muted}>这里展示每条记录的最新版本。更正和完整历史仍在原交付记录中；一条成员报告不会代表所有阶段已经完成。</p>
      <Link className={styles.link} href={`${pageBase}/delivery#official-submission`}>{readonly ? "查看正式提交记录" : detail.membership.role === "manager" ? "在原页面记录正式提交依据" : "查看正式提交依据（由管理员记录）"} →</Link>
    </div>
  </section>;
}
function Requirements({ items }: { items: SubmissionStageView["requirements"] }) {
  return items.length ? <ul className={styles.requirements}>{items.map(item => <li key={item.id}>{item.title} <span className={styles.badge}>{item.necessity === "required" ? "必交" : item.necessity === "optional" ? "可选" : "是否必交待核对"}</span></li>)}</ul> : <p className={styles.muted}>本阶段材料说明待核对；通用材料仍需一起检查。</p>;
}
function SubmissionRecords({ records }: { records: readonly SubmissionRecord[] }) {
  return <ul className={styles.records}>{records.map(record => {
    const evidenceUrl = publicHttpLink(record.platformUrl);
    return <li key={`${record.id}:${record.version}`}><strong>{submissionRecordLabel(record)}</strong><p className={styles.muted}>规则依据：{record.requirementsVersion} · 阶段标识：{record.stageId} · 记录版本 {record.version}<br/>记录时间：{dateText(record.recordedAt)} · 实际提交时间：{dateText(record.submittedAt)}<br/>来源：{record.verificationSource === "user_reported" ? "成员自报，主办方接受结果待核对" : "平台核验记录"}</p>
      {record.repositoryCommitSha && <p className={styles.muted}>记录关联的代码版本：<code>{record.repositoryCommitSha}</code></p>}
      <details><summary>查看本条证据与入口</summary>{record.evidenceRefs.length ? <ul>{record.evidenceRefs.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul> : <p>未提供证据，需回原记录核对。</p>}{evidenceUrl && <a className={styles.link} href={evidenceUrl} target="_blank" rel="noopener noreferrer">打开本条记录的入口（可能属于历史规则） →</a>}</details>
    </li>;
  })}</ul>;
}
