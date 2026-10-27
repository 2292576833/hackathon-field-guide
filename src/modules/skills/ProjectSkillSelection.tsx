"use client";

import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { AgentId } from "./domain.ts";
import type { ProjectSkillSelectionView, ReviewedSkillOption, TaskSkillReference } from "./project-selection.ts";
import styles from "./ProjectSkillSelection.module.css";

export interface ProjectSkillSelectionProps {
  /** Root should key the component by trusted account ID + project ID to discard old-account drafts. */
  state: ProjectSkillSelectionView;
  catalog: readonly ReviewedSkillOption[];
  onSave(input: { expectedRevision: number; selections: readonly TaskSkillReference[] }): Promise<ProjectSkillSelectionView>;
  onRefresh(): Promise<{ state: ProjectSkillSelectionView; catalog: readonly ReviewedSkillOption[] }>;
}
const agents: readonly { id: AgentId; name: string }[] = [
  { id: "codex", name: "Codex" }, { id: "claude-code", name: "Claude Code" }, { id: "cursor", name: "Cursor" },
  { id: "github-copilot", name: "GitHub Copilot" }, { id: "gemini-cli", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" }, { id: "windsurf", name: "Windsurf" }, { id: "cline", name: "Cline" },
];
function key(option: ReviewedSkillOption): string { return `${option.reference.kind}:${option.reference.versionId}:${option.reference.contentHash}:${option.reference.revision}`; }
function evidence(option: ReviewedSkillOption | undefined, agentId: string, clientVersion: string, os: string): string {
  if (!option || !agentId) return "工具环境尚未确定，兼容状态未知。";
  const records = option.compatibility.filter(item => item.agentId === agentId);
  const matching = records.filter(item => item.clientVersion === clientVersion && item.os === os && clientVersion && os && item.source !== "model");
  if (matching.some(item => item.level === "failed")) return "该环境有失败记录，需阅读限制并重新验证本次用途。";
  const verified = matching.find(item => item.source === "platform_test" && item.level === "task_verified");
  if (verified) return `仅在 ${clientVersion} / ${os} 的记录中完成了示例任务：${verified.task ?? "见审核证据"}。仍需核对本次用途。`;
  if (records.some(item => item.level === "installer_declared" && item.source !== "model")) return "只有格式和目录的安装器声明，客户端加载与示例任务待验证。";
  if (matching.some(item => item.level !== "unknown")) return "该环境有部分验证或用户报告；安装、加载和示例任务分别核对。";
  return "该工具版本与系统的兼容状态未知；选择不会把它标成验证通过。";
}
export function ProjectSkillSelection(props: ProjectSkillSelectionProps) {
  const formId = useId();
  const [state, setState] = useState(props.state); const [catalog, setCatalog] = useState(props.catalog);
  const [selections, setSelections] = useState<readonly TaskSkillReference[]>(props.state.selections);
  const [selected, setSelected] = useState(""); const [purpose, setPurpose] = useState("");
  const [learning, setLearning] = useState("30"); const [agent, setAgent] = useState("");
  const [clientVersion, setClientVersion] = useState(""); const [os, setOs] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const choice = catalog.find(item => key(item) === selected);
  const changed = JSON.stringify(selections) !== JSON.stringify(state.selections);
  async function save() {
    setBusy(true); setMessage("");
    try {
      const next = await props.onSave({ expectedRevision: state.revision, selections });
      if (next.projectId !== state.projectId) throw new Error("空间上下文已变化，请重新进入本空间。");
      setState(next); setSelections(next.selections); setMessage("固定版本与用途已保存；学习工时仍须计入实际任务预计用时。");
    } catch (error) { setMessage(`${error instanceof Error ? error.message : "保存失败。"} 本地选择已保留，可刷新目录后核对。`); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setMessage("");
    try {
      const next = await props.onRefresh();
      if (next.state.projectId !== state.projectId) throw new Error("空间上下文已变化，请重新进入本空间。");
      setState(next.state); setCatalog(next.catalog);
      if (!changed) setSelections(next.state.selections);
      setMessage(changed ? "最新目录与修订号已读取；本地输入保留，请核对后保存。" : "已读取最新选择与已审核目录。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "刷新失败，已保留现有选择。"); }
    finally { setBusy(false); }
  }
  function add(event: FormEvent) {
    event.preventDefault();
    const minutes = Number(learning);
    if (!choice || !purpose.trim() || !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10080) { setMessage("请选择明确版本，填写用途和合理的学习分钟数。"); return; }
    if (selections.length >= 12 || selections.some(item => item.reference.kind === choice.reference.kind && item.reference.id === choice.reference.id)) { setMessage("最多选择 12 项；已有同项时先移除旧版本再明确选择。"); return; }
    setSelections([...selections, { reference: choice.reference, purpose: purpose.trim(), learningMinutes: minutes, environment: { ...(agent ? { agentId: agent as AgentId } : {}), ...(clientVersion.trim() ? { clientVersion: clientVersion.trim() } : {}), ...(os.trim() ? { os: os.trim() } : {}) } }]);
    setPurpose(""); setMessage("已加入本地选择，保存后团队可见。");
  }
  return <section className={styles.panel} aria-label="项目技能选择">
    <p className={styles.intro}>选择用于具体任务的技能或技能包，固定到明确版本。配置、学习、试用和排错时间计入该任务原有的预计用时；环境未知可以暂时留空。</p>
    {state.readOnly && <p className={styles.notice}>空间只读，保留历史选择与版本依据。</p>}
    <ul className={styles.list}>
      {selections.map((item, index) => {
        const availability = state.availability.find(value => value.reference.kind === item.reference.kind && value.reference.versionId === item.reference.versionId);
        const option = catalog.find(value => value.reference.kind === item.reference.kind && value.reference.versionId === item.reference.versionId && value.reference.contentHash === item.reference.contentHash && value.reference.revision === item.reference.revision);
        return <li className={styles.item} key={`${item.reference.kind}:${item.reference.versionId}`}>
          <strong>{option?.title ?? item.reference.id} · {item.reference.kind === "bundle" ? "技能包版本" : "技能版本"} {item.reference.version}</strong>
          <p>{item.purpose} · 学习与配置估算 {item.learningMinutes} 分钟</p>
          <p>{item.environment.agentId ? agents.find(value => value.id === item.environment.agentId)?.name : "工具待确认"} · {item.environment.clientVersion ?? "客户端版本未知"} · {item.environment.os ?? "系统未知"}</p>
          <p className={styles.fixed}>{item.reference.versionId} · 修订 {item.reference.revision}<br />内容哈希 {item.reference.contentHash}</p>
          {(availability?.available === false || !option) && <p className={styles.notice}>{availability?.reason ?? "目录中已找不到相同固定引用；保存前请核对或移除。"} 历史选择保留，未自动升级。</p>}
          {state.canManage && <button type="button" className={`${styles.button} ${styles.secondary}`} disabled={busy} onClick={() => setSelections(selections.filter((_, position) => position !== index))}>移除此选择</button>}
        </li>;
      })}
    </ul>
    {!selections.length && <p className={styles.intro}>暂未选择技能。此项可选，可以继续原有任务计划。</p>}
    {state.canManage && <form className={styles.form} onSubmit={add}>
      <label className={`${styles.field} ${styles.wide}`} htmlFor={`${formId}-choice`}>已审核的固定版本
        <select id={`${formId}-choice`} value={selected} disabled={busy} onChange={event => setSelected(event.target.value)} required><option value="">选择技能或技能包</option>{catalog.map(item => <option value={key(item)} key={key(item)}>{item.title} · {item.reference.kind === "bundle" ? "包" : "技能"} {item.reference.version} · 修订 {item.reference.revision}</option>)}</select>
      </label>
      {choice && <div className={styles.evidence}><span>{choice.summary}</span><span className={styles.fixed}>{choice.reference.versionId}<br />内容哈希 {choice.reference.contentHash}</span><span>前置条件：{choice.prerequisites.join("；") || "见详情"}</span>{choice.limitations.map((item, index) => <span key={index}>{item}</span>)}</div>}
      <label className={`${styles.field} ${styles.wide}`} htmlFor={`${formId}-purpose`}>用在哪项工作、帮助完成什么<textarea id={`${formId}-purpose`} value={purpose} maxLength={500} required disabled={busy} onChange={event => setPurpose(event.target.value)} /></label>
      <label className={styles.field} htmlFor={`${formId}-learning`}>学习、配置和试用估算（分钟）<input id={`${formId}-learning`} type="number" min={0} max={10080} step={1} value={learning} required disabled={busy} onChange={event => setLearning(event.target.value)} /></label>
      <label className={styles.field} htmlFor={`${formId}-agent`}>计划使用的 AI 工具<select id={`${formId}-agent`} value={agent} disabled={busy} onChange={event => setAgent(event.target.value)}><option value="">尚未确定</option>{agents.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label className={styles.field} htmlFor={`${formId}-version`}>客户端版本（选填）<input id={`${formId}-version`} value={clientVersion} maxLength={80} disabled={busy} onChange={event => setClientVersion(event.target.value)} /></label>
      <label className={styles.field} htmlFor={`${formId}-os`}>操作系统（选填）<input id={`${formId}-os`} value={os} maxLength={80} placeholder="如 Windows 11" disabled={busy} onChange={event => setOs(event.target.value)} /></label>
      <p className={styles.evidence}>{evidence(choice, agent, clientVersion, os)} 这里只保存用途与环境，不收集本机路径或密钥。</p>
      <button className={`${styles.button} ${styles.secondary}`} type="submit" disabled={busy || !choice}>加入选择</button>
    </form>}
    <div className={styles.actions}>{state.canManage && <button className={styles.button} type="button" disabled={busy || !changed} onClick={() => void save()}>保存团队技能选择</button>}<button className={`${styles.button} ${styles.secondary}`} type="button" disabled={busy} onClick={() => void refresh()}>刷新已审核目录</button></div>
    <p className={styles.intro}>保存、移除或复制选择只改变项目资料。安装文件、客户端加载和示例任务验证仍需各自的明确操作与记录。</p>
    {message && <p className={styles.notice} role="status">{message}</p>}
  </section>;
}
