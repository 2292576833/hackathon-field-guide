"use client";

import { useCallback, useEffect, useState } from "react";
import type { Actor } from "../shared/contracts.ts";
import type { Project } from "../modules/projects/model.ts";
import type { ProjectSkillSelectionState, ProjectSkillSelectionView, ReviewedSkillOption, TaskSkillReference } from "../modules/skills/project-selection.ts";
import { ProjectSkillSelection } from "../modules/skills/ui.ts";
import { ApiError, api, message, useApi } from "./client-api.ts";
import { Feedback, Field, Loading, type Me } from "./site-shell.tsx";
import styles from "./site.module.css";

export interface ProjectSkillSelectionClientProps { projectId: string; actor?: Actor; }

/** The trusted actor is only an account consistency check; the API owns project permissions. */
export function ProjectSkillSelectionClient({ projectId, actor }: ProjectSkillSelectionClientProps) {
  const identity = useApi<Me>("/me");
  const accountId = identity.data?.profile.id ?? "";
  const [blocked, setBlocked] = useState("");
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void identity.reload(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [identity.reload]);
  useEffect(() => { setBlocked(""); }, [accountId, projectId]);
  const assertCurrent = useCallback(async () => {
    const current = await api<Me>("/me");
    if (!accountId || current.profile.id !== accountId || (actor && current.profile.id !== actor.userId)) {
      identity.setData(current);
      throw new Error("账号已变化，旧空间技能表单已清空。请在当前账号下重新打开空间。");
    }
  }, [accountId, actor?.userId, identity.setData]);
  const forbid = useCallback((problem: unknown) => {
    if (problem instanceof ApiError && [401, 403, 404].includes(problem.status)) setBlocked(problem.message);
  }, []);
  if (!identity.data) return <><Feedback error={identity.error}/>{identity.loading && <Loading/>}</>;
  if (actor && actor.userId !== accountId) return <Feedback error="账号已变化，请重新打开当前账号的参赛空间。"/>;
  if (blocked) return <Feedback error={blocked}/>;
  return <><Feedback error={identity.error}/><ProjectSkillSelectionForAccount key={`${accountId}:${projectId}`} projectId={projectId} accountId={accountId} assertCurrent={assertCurrent} forbid={forbid}/></>;
}

function ProjectSkillSelectionForAccount({ projectId, accountId, assertCurrent, forbid }: {
  projectId: string; accountId: string; assertCurrent: () => Promise<void>; forbid: (problem: unknown) => void;
}) {
  const path = `/projects/${encodeURIComponent(projectId)}/skills`;
  const [view, setView] = useState<ProjectSkillSelectionView | null>(null);
  const [catalog, setCatalog] = useState<readonly ReviewedSkillOption[]>([]);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [loadError, setLoadError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [copyEpoch, setCopyEpoch] = useState(0);

  const request = useCallback(async <T,>(endpoint: string, options: Parameters<typeof api<T>>[1] = {}): Promise<T> => {
    try { await assertCurrent(); const result = await api<T>(endpoint, options); await assertCurrent(); return result; }
    catch (problem) { if ((problem instanceof ApiError && problem.status === 401) || endpoint === path || endpoint === `${path}/catalog`) forbid(problem); throw problem; }
  }, [assertCurrent, forbid, path]);
  const read = useCallback(async () => {
    const [state, options] = await Promise.all([request<ProjectSkillSelectionView>(path), request<{ items: readonly ReviewedSkillOption[] }>(`${path}/catalog`)]);
    if (state.projectId !== projectId) throw new Error("服务器返回了不同空间的记录，请重新进入本空间。");
    return { state, catalog: options.items };
  }, [path, projectId, request]);
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError("");
    read().then(result => { if (active) { setView(result.state); setCatalog(result.catalog); } }).catch(problem => { if (active) setLoadError(message(problem)); }).finally(() => { if (active) setLoading(false); });
    request<readonly Project[]>("/projects").then(result => { if (active) setProjects(result.filter(project => project.id !== projectId)); }).catch(problem => { if (active) setCopyError(`暂时无法读取可复用的空间：${message(problem)}`); });
    return () => { active = false; };
  }, [projectId, read, request]);

  async function save(input: { expectedRevision: number; selections: readonly TaskSkillReference[] }): Promise<ProjectSkillSelectionView> {
    await request<ProjectSkillSelectionState>(path, { method: "PUT", body: input });
    const result = await read(); setView(result.state); setCatalog(result.catalog); return result.state;
  }
  async function refresh() {
    const result = await read(); setView(result.state); setCatalog(result.catalog); return result;
  }
  async function copy() {
    if (!view || !sourceProjectId || copying) return;
    setCopying(true); setCopyError(""); setNotice("");
    let saved = false;
    try {
      await request<ProjectSkillSelectionState>(`${path}/copy`, { method: "POST", body: { sourceProjectId, expectedRevision: view.revision } });
      saved = true;
      const result = await read(); setView(result.state); setCatalog(result.catalog); setCopyEpoch(value => value + 1);
      setNotice("固定版本与用途已复制到本空间。学习估算仍须计入实际任务；没有安装任何技能。");
    } catch (problem) {
      if (problem instanceof ApiError && [403, 404].includes(problem.status)) {
        // A missing source must not discard the target's local draft; only target access loss clears it.
        try { await request<ProjectSkillSelectionView>(path); } catch { /* The target guard clears inaccessible data. */ }
      }
      setCopyError(`${saved ? "复制已保存，但未能读取最新结果。请刷新核对。" : "复制未完成；现有选择与本地草稿保留。"} ${message(problem)}`);
    }
    finally { setCopying(false); }
  }
  return <section aria-label="空间技能与技能包">
    <Feedback error={loadError} notice={notice}/>{loading && !view && <Loading/>}
    {!loading && !view && <button type="button" className={styles.secondary} onClick={() => { setLoadError(""); setLoading(true); void read().then(result => { setView(result.state); setCatalog(result.catalog); }).catch(problem => setLoadError(message(problem))).finally(() => setLoading(false)); }}>重新读取空间技能</button>}
    {view && <>
      <ProjectSkillSelection key={`${accountId}:${projectId}:${copyEpoch}`} state={view} catalog={catalog} onSave={save} onRefresh={refresh}/>
      {view.canManage && <details className={styles.panel}><summary className={styles.summary}>从其他参赛空间复用技能选择</summary>
        <p>复制固定版本、用途、学习估算和环境说明，替换本空间已保存的技能选择。本页未保存的选择会清空；项目任务与安装记录保持各自的记录。</p>
        <Feedback error={copyError}/><Field label="选择你可访问的来源空间"><select value={sourceProjectId} disabled={copying} onChange={event => setSourceProjectId(event.target.value)}><option value="">请选择来源空间</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
        {!projects.length && !copyError && <p className={styles.muted}>暂无其他可访问空间可供复用。</p>}
        <button type="button" className={styles.secondary} disabled={copying || !sourceProjectId} onClick={() => void copy()}>{copying ? "正在复制…" : "复制并替换本空间技能选择"}</button>
        <p className={styles.muted}>服务端同时复核两个空间权限与目标修订号，过期或撤回的固定引用不会自动换成新版本。复制选择不执行安装。</p>
      </details>}
    </>}
  </section>;
}
