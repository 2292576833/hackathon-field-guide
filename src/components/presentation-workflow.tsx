"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { validatePresentationProjectSnapshot, type PresentationProjectSnapshot } from "../modules/roadshow/index.ts";
import { api, dateText, message, useApi } from "./client-api.ts";
import type { Me } from "./site-shell.tsx";
import styles from "./roadshow.module.css";

export function presentationProjectId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

/** This reference preserves navigation only. It never authorizes reading project facts. */
export function usePresentationProjectId(supplied?: string): string | null {
  const [linked, setLinked] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setLinked(params.getAll("projectId").length === 1 ? presentationProjectId(params.get("projectId")) : null);
  }, []);
  return presentationProjectId(supplied) ?? linked;
}

export function presentationHref(step: "roadshow" | "ppt" | "delivery", projectId?: string | null, roadshowId?: string): string {
  const id = presentationProjectId(projectId);
  if (step === "delivery") return id ? `/app/projects/${encodeURIComponent(id)}/delivery` : "/app";
  const params = new URLSearchParams();
  if (id) params.set("projectId", id);
  if (step === "ppt" && roadshowId && /^[A-Za-z0-9_-]{1,128}$/.test(roadshowId)) params.set("roadshowId", roadshowId);
  return `/${step}${params.size ? `?${params}` : ""}`;
}

export function PresentationWorkflow({ step, projectId }: { step: "roadshow" | "ppt" | "delivery"; projectId?: string | null }) {
  const id = presentationProjectId(projectId);
  return <nav className={styles.workflow} aria-label="准备展示材料">
    <div className={styles.workflowHeading}><strong>准备展示材料</strong><Link className={styles.textLink} href={presentationHref("delivery", id)}>{id ? "返回团队空间，查看代码与提交 →" : "选择团队空间 →"}</Link></div>
    <ol className={styles.workflowSteps}>
      <li><Link href={presentationHref("roadshow", id)} aria-current={step === "roadshow" ? "step" : undefined}><span>1</span><strong>准备讲稿</strong><small>说清真实进展</small></Link></li>
      <li><Link href={presentationHref("ppt", id)} aria-current={step === "ppt" ? "step" : undefined}><span>2</span><strong>整理 PPT 大纲</strong><small>继承讲稿，再选制作工具</small></Link></li>
      <li><Link href={presentationHref("delivery", id)} aria-current={step === "delivery" ? "step" : undefined}><span>3</span><strong>检查代码与提交</strong><small>保存、运行、正式提交分别核对</small></Link></li>
    </ol>
    <p className={styles.hint}>讲稿与大纲保存在本人账号。团队空间链接只保留返回位置；使用空间中的项目资料前仍需由你选择和确认。</p>
  </nav>;
}

/** Root can compose this entry in a project without reading or publishing private drafts. */
export function PresentationProjectEntry({ projectId }: { projectId: string }) {
  const id = presentationProjectId(projectId);
  if (!id) return null;
  return <section className={styles.projectEntry} aria-label="准备展示材料入口"><h3>准备展示材料</h3><p className={styles.hint}>先把作品讲清楚，再带入 PPT 大纲。可选用当前团队空间的项目资料，生成结果仅保存在你的账号。</p><div className={styles.actions}><Link className={styles.primary} href={presentationHref("roadshow", id)}>从讲稿开始 →</Link><Link className={styles.textLink} href={presentationHref("ppt", id)}>直接整理 PPT 大纲</Link></div></section>;
}

/** Root injects the registered read-only endpoint; absent configuration never fakes project inheritance. */
export interface PresentationProjectApi { basePath: string }

export function PresentationSourceSummary({ snapshot }: { snapshot: PresentationProjectSnapshot }) {
  return <p className={styles.sourceSummary}>来源：{snapshot.projectName} 团队空间 · 资料版本 {snapshot.revision} · 快照时间 {dateText(snapshot.capturedAt)}。这是当时读取的资料，私人输入可另行补充；更新空间资料不会改写已保存旧稿。</p>;
}

export function PresentationProjectPicker({ accountId, suggestedProjectId, busy, config, source, onUse, onClear }: {
  accountId: string | null; suggestedProjectId?: string | null; busy?: boolean; config?: PresentationProjectApi;
  source: PresentationProjectSnapshot | null; onUse: (snapshot: PresentationProjectSnapshot) => void | boolean; onClear: () => void;
}) {
  const enabled = Boolean(config && /^\/(?!\/)[A-Za-z0-9/_-]+$/.test(config.basePath));
  const projects = useApi<{ id: string; name: string; stage: string }[]>(accountId && enabled ? "/projects" : null, { timeoutMs: 15000 });
  const [selected, setSelected] = useState(presentationProjectId(suggestedProjectId) ?? "");
  const [preview, setPreview] = useState<PresentationProjectSnapshot | null>(null);
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const epoch = useRef(0), active = useRef(true), lock = useRef(false);
  useEffect(() => {
    if (suggestedProjectId) setSelected(current => current || presentationProjectId(suggestedProjectId) || "");
  }, [suggestedProjectId]);
  useEffect(() => {
    active.current = true;
    const expired = () => { epoch.current++; setPreview(null); setReading(false); lock.current = false; };
    window.addEventListener("hackathon:unauthenticated", expired);
    return () => { active.current = false; epoch.current++; window.removeEventListener("hackathon:unauthenticated", expired); };
  }, []);
  useEffect(() => { epoch.current++; setPreview(null); setError(""); lock.current = false; setReading(false); }, [accountId, config?.basePath]);
  const read = async () => {
    if (!enabled || !config || !accountId || !selected || lock.current || busy) return;
    lock.current = true; setReading(true); setError(""); setPreview(null);
    const generation = ++epoch.current;
    try {
      const before = await api<Me>("/me", { signal: AbortSignal.timeout(15000) });
      if (before.profile.id !== accountId) throw new Error("登录账号已变化，请重新打开页面后选择项目。");
      const snapshot = validatePresentationProjectSnapshot(await api<unknown>(`${config.basePath}/${encodeURIComponent(selected)}`, { signal: AbortSignal.timeout(15000) }));
      if (snapshot.projectId !== selected) throw new Error("返回资料与所选项目不一致，请重新读取。");
      const after = await api<Me>("/me", { signal: AbortSignal.timeout(15000) });
      if (after.profile.id !== accountId) throw new Error("登录账号已变化，未带入项目资料。");
      if (active.current && epoch.current === generation) setPreview(snapshot);
    } catch (reason) { if (active.current && epoch.current === generation) setError(message(reason)); }
    finally { if (active.current && epoch.current === generation) { lock.current = false; setReading(false); } }
  };
  return <section className={styles.sourcePicker} aria-labelledby="presentation-source-title">
    <h3 id="presentation-source-title">可选：使用团队空间的项目资料</h3>
    <p className={styles.hint}>先选空间并查看内容，再确认带入。这里只读取目标、范围、成果和计划，不读取队友的私人画像、回答或稿件。</p>
    {!accountId ? <p className={styles.hint}>登录后可选择自己加入的团队空间。也可以先查看模板与示例。</p> : !enabled ? <p className={styles.callout}>空间资料复用接口尚未接入。当前仍可自行填写，或在 PPT 中继承本人已保存的讲稿。</p> : <>
      <label className={styles.sourceLabel} htmlFor="presentation-project">选择团队空间</label>
      <select id="presentation-project" value={selected} disabled={Boolean(busy) || reading || projects.loading} onChange={event => { epoch.current++; setSelected(event.target.value); setPreview(null); setError(""); }}>
        <option value="">请选择，不会自动带入</option>
        {selected && !projects.data?.some(project => project.id === selected) && <option value={selected}>链接中的团队空间（服务器仍需复核权限）</option>}
        {projects.data?.map(project => <option key={project.id} value={project.id} disabled={project.stage === "archived"}>{project.name}{project.stage === "archived" ? "（已归档）" : ""}</option>)}
      </select>
      <div className={styles.actions}><button type="button" className={styles.secondary} disabled={Boolean(busy) || reading || !selected || projects.loading} onClick={() => void read()}>{reading ? "正在复核权限并读取…" : "查看将带入的资料"}</button>
        <button type="button" className={styles.secondary} disabled={Boolean(busy) || reading || projects.loading} onClick={() => void projects.reload()}>刷新空间列表</button></div>
      {projects.error && <p className={styles.sourceError} role="alert">{projects.error.message}</p>}
      {!projects.loading && !projects.error && projects.data?.length === 0 && <p className={styles.hint}>还没有可选空间。可以先自行填写，或去“我的参赛”创建团队空间。</p>}
      {error && <p className={styles.sourceError} role="alert">{error}</p>}
      {preview && <div className={styles.sourcePreview}><h4>{preview.projectName} · 版本 {preview.revision}</h4>
        <dl><dt>项目目标</dt><dd>{preview.projectIdea || "未填写，需要你补充"}</dd><dt>目标用户</dt><dd>{preview.targetUsers || "未填写，需要你补充"}</dd><dt>要解决的问题</dt><dd>{preview.problem || "未填写，需要你补充"}</dd></dl>
        <div className={styles.sourceColumns}><div><h4>已记录的成果</h4>{preview.completed.length ? <ul>{preview.completed.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className={styles.hint}>尚无明确成果，不推断已有功能。</p>}</div><div><h4>计划中的内容</h4>{preview.planned.length ? <ul>{preview.planned.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className={styles.hint}>暂无计划内容。</p>}</div></div>
        {preview.evidence.length > 0 && <details><summary>查看已有依据</summary><ul>{preview.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        <p className={styles.hint}>确认后会替换下方对应的项目输入，请先保留正在编辑的内容。计划会单独带入；生成前服务器会再次复核空间权限和版本。生成材料只保存到本人账号。</p>
        <button type="button" className={styles.primary} disabled={Boolean(busy) || reading} onClick={() => { if (onUse(structuredClone(preview)) !== false) setPreview(null); }}>使用这些资料，继续补充</button>
      </div>}
    </>}
    {source && <div className={styles.sourcePreview}><PresentationSourceSummary snapshot={source}/><button className={styles.secondary} type="button" disabled={Boolean(busy) || reading} onClick={onClear}>解除空间资料引用，改为自行填写</button><p className={styles.hint}>已带入的文字会保留，之后按你的自述生成；已保存旧稿的来源不会改变。</p></div>}
  </section>;
}
