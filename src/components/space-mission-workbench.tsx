"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { MemberAvailability, MyIntentionView, ProjectOfficialTracksView } from "../modules/projects/index.ts";
import type { ReadState, SpaceDetail, SpaceRules } from "../modules/space-workflow/model.ts";
import { buildMissionWorkbench, type MissionAction, type MissionPreparation } from "../modules/space-workflow/mission-workbench.ts";
import { dateText, useApi } from "./client-api.ts";
import styles from "./space-mission-workbench.module.css";

export interface SpaceMissionWorkbenchProps {
  detail: SpaceDetail;
  current: CurrentPlanningView | null;
  planningLoading?: boolean;
  planningError?: unknown;
  preparation?: MissionPreparation;
  taskBoard?: ReactNode;
  teamFeed?: ReactNode;
  assistant?: ReactNode;
}
type WorkbenchTab = "mine" | "tasks" | "feed";
const tabs: readonly { id: WorkbenchTab; title: string }[] = [{ id: "mine", title: "我的下一步" }, { id: "tasks", title: "团队任务" }, { id: "feed", title: "团队动态" }];
function readState<T>(state: { data: T | null; loading: boolean; error: Error | null }): ReadState<T> {
  return state.error ? { status: "error", message: "读取失败" } : state.loading ? { status: "loading" } : state.data === null ? { status: "unread" } : { status: "ready", value: state.data };
}
/** The parent supplies the three business panels; this component only reads
 * preparation facts and changes local tabs/dialogs, never writes progress. */
export function SpaceMissionWorkbench(props: SpaceMissionWorkbenchProps) {
  return <WorkbenchContent key={`${props.detail.project.id}:${props.detail.membership.userId}:${props.detail.membership.revision}`} {...props}/>;
}
function WorkbenchContent({ detail, current, planningLoading, planningError, preparation, taskBoard, teamFeed, assistant }: SpaceMissionWorkbenchProps) {
  const apiBase = `/projects/${encodeURIComponent(detail.project.id)}`;
  const apiPath = (suffix: string) => preparation === undefined ? `${apiBase}/${suffix}` : null;
  const rules = useApi<SpaceRules>(apiPath("rules"), { timeoutMs: 15_000 });
  const tracks = useApi<ProjectOfficialTracksView>(apiPath("official-tracks"), { timeoutMs: 15_000 });
  const intention = useApi<MyIntentionView>(apiPath("my-intention"), { timeoutMs: 15_000 });
  const availability = useApi<{ availability: MemberAvailability | null; confirmationRequired: boolean }>(apiPath("my-availability"), { timeoutMs: 15_000 });
  const model = buildMissionWorkbench({ detail, current, planningLoading, planningError, preparation: preparation ?? { rules: readState(rules), tracks: readState(tracks), intention: readState(intention), availability: readState(availability) } });
  const [selected, setSelected] = useState<WorkbenchTab>("mine");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), assistantButton = useRef<HTMLButtonElement>(null);
  const [assistantOpened, setAssistantOpened] = useState(false);
  const [assistantMounted, setAssistantMounted] = useState(false);
  useEffect(() => {
    if (preparation !== undefined) return;
    const refresh = () => { void rules.reload(); void tracks.reload(); void intention.reload(); void availability.reload(); };
    const onInputChanged = (event: Event) => {
      const changedProject = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (changedProject && changedProject !== detail.project.id) return;
      refresh();
    };
    window.addEventListener("hackathon:project-input-changed", onInputChanged);
    return () => window.removeEventListener("hackathon:project-input-changed", onInputChanged);
  }, [preparation, detail.project.id, rules.reload, tracks.reload, intention.reload, availability.reload]);
  const lastProjectRevision = useRef(detail.project.revision);
  useEffect(() => {
    if (lastProjectRevision.current === detail.project.revision) return;
    lastProjectRevision.current = detail.project.revision;
    if (preparation === undefined) { void rules.reload(); void tracks.reload(); void intention.reload(); void availability.reload(); }
  }, [preparation, detail.project.revision, rules.reload, tracks.reload, intention.reload, availability.reload]);
  useEffect(() => {
    if (!dialog.current) return;
    if (assistantOpened && !dialog.current.open) dialog.current.showModal();
    else if (!assistantOpened && dialog.current.open) dialog.current.close();
  }, [assistantOpened]);
  function browse(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (target === null) return;
    event.preventDefault(); setSelected(tabs[target]!.id); buttons.current[target]?.focus();
  }
  const progress = model.progress;
  const otherActions = model.actions.filter(action => action.id !== model.primary.id);
  const prepIssues = model.preparation.filter(action => action.id !== model.primary.id);
  function openTasks() { setSelected("tasks"); buttons.current[1]?.focus(); }
  if (model.state === "unavailable") return <section className={styles.workbench} aria-label="团队协作身份待核对"><p className={styles.notice}>{model.notice}</p><MissionCard action={model.primary} primary/></section>;
  return <section className={styles.workbench} aria-labelledby={`${id}-heading`}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>现在做什么，交什么，下一位是谁</p><h2 id={`${id}-heading`}>团队协作工作台</h2></div>
      {assistant && <button type="button" ref={assistantButton} className={styles.assistantButton} onClick={() => { setAssistantMounted(true); setAssistantOpened(true); }}>打开我的空间 AI 助手</button>}
    </div>
    <p className={styles.notice} role="status">{model.notice}</p>
    <div className={styles.context}>
      <p>{model.solo ? "目前只有你，一人也可按任务继续。" : "队友共享任务和成果；个人 AI 对话保留在本人账号。"}{model.lastProgressAt && <span>最近任务进度：{dateText(model.lastProgressAt)}</span>}</p>
      {model.deadline ? <p><strong>{model.deadline.label}：</strong>{dateText(model.deadline.instant)}<span>{model.deadline.basis}{model.deadline.fromSnapshot && "（计划快照，仍需核对最新官方要求）"}</span></p> : <p>截止尚未记录，先在比赛与资料核对。</p>}
    </div>
    <div className={styles.tabs} role="tablist" aria-label="团队协作主要工作区">
      {tabs.map((tab, index) => <button key={tab.id} type="button" ref={element => { buttons.current[index] = element; }} role="tab" id={`${id}-${tab.id}-tab`} aria-controls={`${id}-${tab.id}-panel`} aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1} onClick={() => setSelected(tab.id)} onKeyDown={event => browse(event, index)}>{tab.title}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-mine-panel`} aria-labelledby={`${id}-mine-tab`} hidden={selected !== "mine"} className={styles.tabPanel}>
      <MissionCard action={model.primary} primary/>
      {model.state === "current" && otherActions.length > 0 && <div className={styles.additional}><h3>{model.waiting.length ? "等待时还能并行做" : "接下来可做或需检查"}</h3><ul className={styles.actionList}>{otherActions.slice(0, 3).map(action => <li key={action.id}><Link href={action.href}>{action.title} →</Link><p>{action.purpose}</p><p><strong>交出：</strong>{action.deliverable}</p></li>)}</ul>{otherActions.length > 3 && <button className={styles.secondary} type="button" onClick={openTasks}>查看其余 {otherActions.length - 3} 项任务</button>}</div>}
      {model.waiting.length > 0 && <section className={styles.waiting} aria-label="我遇到的问题和前置等待"><h3>我在等什么，找谁核对</h3><ul>{model.waiting.slice(0, 3).map(item => <li key={item.taskId}><Link href={item.href}>{item.title} →</Link><p>{item.problem}</p>{item.waitingFor.length > 0 && <ul>{item.waitingFor.map((prior, index) => <li key={index}><strong>{prior.title}</strong><span>{prior.owner} · {prior.status}</span></li>)}</ul>}</li>)}</ul>{model.waiting.length > 3 && <button className={styles.secondary} type="button" onClick={openTasks}>查看全部等待任务</button>}{model.actions.length === 0 && !model.readonly && <p>当前没有可确认的并行任务。向管理员说明你可投入的时间，请一起拆分独立任务；不用一直等着。</p>}</section>}
      {!["current", "archived", "unavailable"].includes(model.state) && prepIssues.length > 0 && <section className={styles.additional} aria-label="计划确认前的准备"><h3>可以一起准备，不必等满员</h3><ul className={styles.preparation}>{prepIssues.map(action => <li key={action.id}><Link href={action.href}>{action.title} →</Link><p>{action.purpose}</p></li>)}</ul></section>}
      {model.state === "current" && model.actions.length === 0 && !model.waiting.length && !progress?.allMustChecked && <p className={styles.muted}>先在全队安排中找可接手的工作，或和管理员核对职责。本人没有待办不表示全队已完成。</p>}
      <div className={styles.footerLinks}><button type="button" className={styles.secondary} onClick={openTasks}>查看团队任务与负责人</button><button type="button" className={styles.textButton} onClick={() => { setSelected("feed"); buttons.current[2]?.focus(); }}>查看成果与共享建议 →</button></div>
    </div>
    <div role="tabpanel" id={`${id}-tasks-panel`} aria-labelledby={`${id}-tasks-tab`} hidden={selected !== "tasks"} className={styles.tabPanel}>
      {progress && <div className={styles.progress} data-complete={progress.allMustChecked ? "true" : "false"}><div><strong>{progress.allMustChecked ? "本计划必做成果已齐" : "按检查记录点亮任务"}</strong><p>必做检查通过 {progress.checkedMust} / {progress.must} · 可选检查通过 {progress.checkedOptional} / {progress.optional} · 已删减 {progress.cancelled}</p></div><p>{progress.notice}</p></div>}
      {model.members.length > 0 && <details className={styles.memberDetails}><summary>队友现在正在做什么</summary><ul className={styles.members}>{model.members.map(member => <li key={member.membershipId}><h3>{member.name}</h3>{member.doing.length ? <ul>{member.doing.map(task => <li key={task.id}><span className={styles.doingLabel}>正在做</span><Link href={task.href}>{task.title}</Link></li>)}</ul> : <p>暂无正在做的任务记录，可能在准备、等待或尚未更新。</p>}{member.reviewing.length > 0 && <p>可检查交接：{member.reviewing.length} 项，去任务板查看依据。</p>}<p>本人负责的成果检查通过：{member.checkedCount} 项</p></li>)}</ul></details>}
      {taskBoard ?? <div className={styles.empty}><h3>{model.state === "draft" ? "查看和领取任务草案" : "到任务页核对安排"}</h3><p>{model.notice}</p><Link className={styles.secondary} href={model.tasksHref}>打开完整任务页 →</Link></div>}
      <p className={styles.muted}>任务只在原任务板记录。领取、开始、交成果和检查通过分别操作；工作区切换会保留已打开面板中的输入。</p>
    </div>
    <div role="tabpanel" id={`${id}-feed-panel`} aria-labelledby={`${id}-feed-tab`} hidden={selected !== "feed"} className={styles.tabPanel}>
      <p className={styles.muted}>看成果交接、遇到的问题、主动分享的 AI 建议与已采纳决定。日常聊天可继续使用微信。</p>
      {teamFeed ?? <div className={styles.empty}><h3>共享成果先在原任务中提交</h3><p>团队动态面板尚未接入，不把空面板当作没有成果。任务中的提交与检查记录仍可查看。</p><Link className={styles.secondary} href={model.tasksHref}>查看任务中的成果记录 →</Link></div>}
    </div>
    {assistant && <dialog ref={dialog} className={styles.assistantDialog} aria-labelledby={`${id}-assistant-title`} onCancel={() => setAssistantOpened(false)} onClose={() => { setAssistantOpened(false); assistantButton.current?.focus(); }}>
      <div className={styles.dialogHeading}><div><h2 id={`${id}-assistant-title`}>我的空间 AI 助手</h2><p>围绕本场项目执行；与站内导航员的入口和对话分开。</p></div><button type="button" className={styles.secondary} onClick={() => setAssistantOpened(false)} autoFocus>关闭助手</button></div>
      <div className={styles.dialogContent}>{assistantMounted && assistant}</div>
    </dialog>}
  </section>;
}
function MissionCard({ action, primary = false }: { action: MissionAction; primary?: boolean }) {
  return <article className={primary ? styles.primaryCard : styles.card} data-kind={action.kind}>
    <p className={styles.actionLabel}>{action.kind === "check" ? "有人等你检查" : action.kind === "wait" ? "先解决这个问题" : "我的下一步"}</p><h3>{action.title}</h3><p>{action.purpose}</p>
    <dl className={styles.actionFacts}><div><dt>交出什么</dt><dd>{action.deliverable}</dd></div><div><dt>怎样算做好</dt><dd>{action.check}</dd></div></dl>
    <Link className={primary ? styles.primary : styles.secondary} href={action.href}>{action.kind === "check" ? "查看成果与检查条件" : action.kind === "start" || action.kind === "continue" ? "打开这项任务" : "去完成这一步"} →</Link>
    {action.tools.length > 0 && <details className={styles.tools}><summary>需要时用这些工具</summary><ul>{action.tools.map(tool => <li key={tool.href}><Link href={tool.href}>{tool.title} →</Link><p>{tool.purpose}</p></li>)}</ul></details>}
  </article>;
}
