"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PersonalArtifact } from "../shared/personal-ai.ts";
import type { PresentationProjectSnapshot } from "../modules/roadshow/index.ts";
import type { PptInput, PptOutline, PptPoint, PptSlide, PptTemplate, PptTemplateId } from "../modules/ppt/domain.ts";
import { outlineMarkdown, outlinePrintHtml } from "../modules/ppt/export.ts";
import { PPT_TEMPLATES, getPptTemplate, templateMarkdown } from "../modules/ppt/templates.ts";
import { PPT_TOOLS } from "../modules/ppt/tools.ts";
import { parseStoredPptOutline } from "../modules/ppt/validation.ts";
import { api, ApiError, dateText, isUnknownAiOutcome, lines, message, useApi } from "./client-api.ts";
import { Field, PageTitle, SiteShell, type Me } from "./site-shell.tsx";
import { PresentationWorkflow, PresentationProjectPicker, PresentationSourceSummary, presentationHref, usePresentationProjectId, type PresentationProjectApi } from "./presentation-workflow.tsx";
import styles from "./ppt.module.css";

type FormContent = { projectName: string; projectIdea: string; targetUsers: string; completed: string; planned: string; evidence: string; artifactId: string };
const emptyForm: FormContent = { projectName: "", projectIdea: "", targetUsers: "", completed: "", planned: "", evidence: "", artifactId: "" };
const pointLabels: Record<PptPoint["kind"], string> = { provided: "用户提供", suggestion: "建议 / 本地修改", needs_evidence: "待补证据" };
const factLabels = { idea: "项目想法", target_users: "目标用户", completed: "用户自报已完成", planned: "待实现", evidence: "用户提供依据 · 需复核" };
function pointLabel(point: PptPoint, outline: PptOutline): string {
  const fact = point.kind === "provided" ? outline.facts.find(item => item.id === point.factId) : null;
  return fact ? factLabels[fact.kind] : pointLabels[point.kind];
}
const demonstrationLabels: Record<PptSlide["demonstration"]["mode"], string> = { live: "现场演示建议", recording: "预录演示建议", walkthrough: "概念流程讲解", none: "无演示" };

function unauthenticated(error: unknown): boolean { return error instanceof ApiError && error.status === 401; }
function downloadText(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileName(title: string): string { return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 70) || "路演大纲"; }
function restoredForm(input: PptInput): FormContent {
  return { projectName: input.projectName ?? "", projectIdea: input.projectIdea, targetUsers: input.targetUsers,
    completed: input.completed.join("\n"), planned: input.planned.join("\n"), evidence: (input.evidence ?? []).join("\n"), artifactId: input.artifactId ?? "" };
}
function inputFromForm(form: FormContent, templateId: PptTemplateId, durationMinutes: number): PptInput {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 15) throw new Error("路演时长请填写 1–15 之间的整数分钟。");
  if (form.artifactId) return { templateId, durationMinutes, artifactId: form.artifactId,
    projectIdea: "", targetUsers: "", completed: [], planned: [], evidence: [] };
  const input: PptInput = { templateId, durationMinutes, projectIdea: form.projectIdea.trim(), targetUsers: form.targetUsers.trim(),
    completed: lines(form.completed), planned: lines(form.planned), evidence: lines(form.evidence),
    ...(form.projectName.trim() ? { projectName: form.projectName.trim() } : {}), ...(form.artifactId ? { artifactId: form.artifactId } : {}) };
  if (!form.artifactId) {
    if (!input.projectIdea || !input.targetUsers) throw new Error("请填写项目想法和目标用户，或选择继承本人已保存的路演。");
    for (const [label, values] of [["已完成", input.completed], ["待实现", input.planned], ["依据", input.evidence ?? []]] as const) {
      if (values.length > 12 || values.some(value => value.length > 600)) throw new Error(`${label}最多 12 项，每项最多 600 字；请逐行填写。`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 32000) throw new Error("项目说明过长，请精简内容后生成。输入已保留。");
  return input;
}
function artifactMetadata(value: unknown, kind: "ppt" | "roadshow"): PersonalArtifact[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || item.kind !== kind || item.provider !== "dsh"
    || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(item.id) || typeof item.title !== "string" || typeof item.createdAt !== "string")) {
    throw new Error("历史列表格式不完整，请重新读取已保存记录。");
  }
  return value as PersonalArtifact[];
}
function readableOutline(artifact: PersonalArtifact, expectedId?: string): PptOutline {
  if (!artifact || artifact.kind !== "ppt" || artifact.provider !== "dsh" || typeof artifact.id !== "string" || (expectedId && artifact.id !== expectedId)) {
    throw new Error("记录类型或来源不匹配，未展示结果。");
  }
  return parseStoredPptOutline(artifact.data);
}

export function PptClient({ projectId, projectContextApi }: { projectId?: string; projectContextApi?: PresentationProjectApi } = {}) {
  const linkedProjectId = usePresentationProjectId(projectId);
  const identity = useApi<Me>("/me");
  const [materialProjectId, setMaterialProjectId] = useState<string | null>(null);
  const currentProjectId = materialProjectId ?? linkedProjectId;
  useEffect(() => { setMaterialProjectId(null); }, [identity.data?.profile.id]);
  const [linkedRoadshowId, setLinkedRoadshowId] = useState("");
  const [workPending, setWorkPending] = useState(false);
  useEffect(() => {
    const sourceId = new URLSearchParams(window.location.search).get("roadshowId");
    if (sourceId && /^[A-Za-z0-9_-]{1,200}$/.test(sourceId)) setLinkedRoadshowId(sourceId);
  }, []);
  const loginHref = `/login?returnTo=${encodeURIComponent(presentationHref("ppt", linkedProjectId, linkedRoadshowId))}`;
  const [configuration, setConfiguration] = useState<{ templateId: PptTemplateId; durationMinutes: number }>({ templateId: "demo-3", durationMinutes: 3 });
  const template = getPptTemplate(configuration.templateId);
  const chooseTemplate = (next: PptTemplate) => setConfiguration({ templateId: next.id, durationMinutes: next.durationMinutes });
  const refreshIdentity = useCallback(() => { void identity.reload(); }, [identity.reload]);
  useEffect(() => {
    const helpIds = new Set(["ppt-templates", "ppt-tools"]);
    const revealHelp = () => {
      const id = window.location.hash.slice(1);
      if (!helpIds.has(id)) return;
      const target = document.getElementById(id);
      if (!(target instanceof HTMLDetailsElement)) return;
      target.open = true; target.querySelector("summary")?.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
    };
    const onLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && helpIds.has(url.hash.slice(1))) requestAnimationFrame(revealHelp);
    };
    revealHelp(); window.addEventListener("hashchange", revealHelp); document.addEventListener("click", onLink);
    return () => { window.removeEventListener("hashchange", revealHelp); document.removeEventListener("click", onLink); };
  }, []);
  return <SiteShell>
    <PresentationWorkflow step="ppt" projectId={currentProjectId}/>
    <PageTitle eyebrow="SHOW YOUR WORK" title="把想法讲清楚，再做成 PPT">
      <p>选好结构和时长，填写真实进展，或继续本人已保存的大纲。案例讲解和制作工具在下方按需查看。</p>
    </PageTitle>
    <nav className={styles.actions} aria-label="PPT 页面导航"><a className={styles.button} href="#ppt-workbench">准备或继续我的大纲 →</a><a className={styles.link} href="#ppt-templates">查看模板讲解</a><a className={styles.link} href="#ppt-tools">查看制作工具</a></nav>

    <section id="ppt-workbench" className={styles.section} aria-labelledby="ppt-workbench-title">
      <div className={styles.sectionHeading}><div><h2 id="ppt-workbench-title">我的项目大纲</h2></div><Link className={styles.link} href={presentationHref("roadshow", linkedProjectId)}>需要先整理讲稿？→</Link></div>
      {identity.loading && <p className={styles.status} role="status">正在检查登录状态，原创模板仍可使用。</p>}
      {identity.error && !unauthenticated(identity.error) && <div className={styles.error} role="alert"><p>{identity.error.message}</p><button className={styles.secondary} type="button" disabled={identity.loading} onClick={() => void identity.reload()}>重新检查登录状态</button></div>}
      {!identity.loading && !identity.data && <div className={styles.loginNotice}><strong>登录后生成你的项目大纲</strong><p>DSH 会使用你填写的项目内容或本人已保存的路演，结果保存到当前账号。原创结构模板可直接下载；登录后填写项目或继承自己的路演。</p><Link className={styles.button} href={loginHref}>登录后使用 DSH</Link></div>}
      <PptWorkbench key={identity.data?.profile.id ?? "public"} accountId={identity.data?.profile.id ?? null} templateId={configuration.templateId}
        durationMinutes={configuration.durationMinutes} identityLoading={identity.loading} linkedRoadshowId={linkedRoadshowId} loginHref={loginHref}
        projectId={currentProjectId} projectContextApi={projectContextApi} onProjectChange={setMaterialProjectId}
        onIdentityChange={refreshIdentity} onBusyChange={setWorkPending}
        onConfigurationChange={(templateId, durationMinutes) => setConfiguration({ templateId, durationMinutes })}/>
    </section>

    <details id="ppt-templates" className={styles.section} aria-labelledby="ppt-template-title">
      <summary id="ppt-template-title" className={styles.textButton}>原创模板讲解与下载（需要时展开）</summary>
      <p className={styles.muted}>无需登录，可以直接下载 Markdown 框架。当前生成采用的结构和时长在上方填写区调整。</p>
      <div className={styles.templateGrid}>{PPT_TEMPLATES.map(item => <button type="button" key={item.id}
        className={`${styles.templateCard} ${configuration.templateId === item.id ? styles.selected : ""}`}
        aria-pressed={configuration.templateId === item.id} disabled={workPending} onClick={() => chooseTemplate(item)}>
        <span className={styles.templateMeta}>{item.durationMinutes} 分钟 / {item.slides.length} 页</span><strong>{item.name}</strong><span>{item.description}</span>
        <span className={styles.templateChoice}>{configuration.templateId === item.id ? "已选用这个结构" : "选用这个结构 →"}</span>
      </button>)}</div>
      <div className={styles.templateDetail}>
        <div className={styles.titleRow}><div><h3>{template.name}</h3><p className={styles.muted}>模板提示是写作框架，填写自己的项目事实后再用于路演。</p></div>
          <button type="button" className={styles.secondary} onClick={() => downloadText(templateMarkdown(template.id), `${template.name}-原创框架.md`, "text/markdown;charset=utf-8")}>下载原创 Markdown 框架</button></div>
        <ol className={styles.templateSlides}>{template.slides.map((slide, index) => <li key={`${template.id}-${index}`}>
          <details><summary><span className={styles.slideNumber}>{String(index + 1).padStart(2, "0")}</span><strong>{slide.title}</strong><span className={styles.muted}>{slide.durationSeconds} 秒</span></summary>
            <div className={styles.templateGuidance}><div><h4>这一页写什么</h4><ul>{slide.write.map((text, i) => <li key={i}>{text}</li>)}</ul></div>
              <div><h4>开口怎样讲</h4><p>{slide.say}</p><h4>画面建议</h4><p>{slide.visualSuggestion}</p></div>
              <div className={styles.pitfall}><h4>避开这些坑</h4><ul>{slide.avoid.map((text, i) => <li key={i}>{text}</li>)}</ul></div></div>
          </details>
        </li>)}</ol>
      </div>
    </details>
    <details id="ppt-tools" className={styles.section} aria-labelledby="ppt-tools-title">
      <summary id="ppt-tools-title" className={styles.textButton}>PPT 制作工具（需要时展开）</summary>
      <p className={styles.description}>把大纲放进熟悉的制作工具，补上实际截图或演示。工具功能、费用和使用条件以官网当前页面为准。<Link className={styles.link} href="/resources">也可在工具与资料中继续挑选 →</Link></p>
      <div className={styles.toolGrid}>{PPT_TOOLS.map(tool => <article className={styles.toolCard} key={tool.id}><h3>{tool.name}</h3><p>{tool.description}</p>
        <div className={styles.toolUse}><strong>适合什么时候</strong><p>{tool.useWhen}</p></div><p className={styles.muted}>{tool.note}</p>
        <a className={styles.link} href={tool.url} target="_blank" rel="noopener noreferrer">打开 {tool.name} 官方页面 ↗</a><p className={styles.verification}>官网核验：{tool.verifiedAt}</p></article>)}</div>
    </details>
  </SiteShell>;
}

function PptWorkbench({ accountId, templateId, durationMinutes, identityLoading, linkedRoadshowId, loginHref, projectId, projectContextApi, onProjectChange, onIdentityChange, onBusyChange, onConfigurationChange }: {
  accountId: string | null; templateId: PptTemplateId; durationMinutes: number; identityLoading: boolean;
  linkedRoadshowId: string; loginHref: string; onBusyChange: (busy: boolean) => void;
  projectId: string | null;
  projectContextApi?: PresentationProjectApi; onProjectChange: (projectId: string | null) => void;
  onIdentityChange: () => void; onConfigurationChange: (id: PptTemplateId, duration: number) => void;
}) {
  const [form, setForm] = useState<FormContent>({ ...emptyForm });
  const [sourceProject, setSourceProject] = useState<PresentationProjectSnapshot | null>(null);
  const [history, setHistory] = useState<PersonalArtifact[]>([]), [roadshows, setRoadshows] = useState<PersonalArtifact[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false), [historyLoaded, setHistoryLoaded] = useState(false), [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState("");
  const [unknownResult, setUnknownResult] = useState(false), [checkedUnknownHistory, setCheckedUnknownHistory] = useState(false);
  const [outline, setOutline] = useState<PptOutline | null>(null), [savedArtifact, setSavedArtifact] = useState<PersonalArtifact | null>(null);
  const [localEdits, setLocalEdits] = useState(false), [previewOpen, setPreviewOpen] = useState(false);
  const alive = useRef(true), requestGeneration = useRef(0), historyGeneration = useRef(0), actionLock = useRef(false);
  const inheritedLinkApplied = useRef(false);
  const previewHtml = useMemo(() => outline && previewOpen ? outlinePrintHtml(outline) : "", [outline, previewOpen]);

  const clearPrivate = useCallback(() => {
    requestGeneration.current++; historyGeneration.current++; actionLock.current = false;
    setHistory([]); setRoadshows([]); setOutline(null); setSavedArtifact(null); setHistoryLoaded(false); setHistoryLoading(false);
    setBusy(null); setLocalEdits(false); setPreviewOpen(false); setUnknownResult(false); setCheckedUnknownHistory(false); setForm({ ...emptyForm });
    setSourceProject(null); onProjectChange(null);
  }, [onProjectChange]);
  const checkAccount = useCallback(async () => {
    if (!accountId) throw new ApiError("请先登录，再使用本人项目与历史。", 401, "UNAUTHENTICATED");
    const current = await api<Me>("/me");
    if (current.profile.id !== accountId) {
      clearPrivate(); onIdentityChange(); throw new Error("登录账号已变化，请在当前账号下重新打开 PPT 页面。");
    }
  }, [accountId, clearPrivate, onIdentityChange]);
  const loadHistory = useCallback(async () => {
    if (!accountId || !alive.current) return;
    const generation = ++historyGeneration.current;
    setHistoryLoading(true); setHistoryError(null);
    try {
      await checkAccount();
      const [ppt, roadshow] = await Promise.all([api<unknown>("/me/artifacts?kind=ppt"), api<unknown>("/me/artifacts?kind=roadshow")]);
      if (!alive.current || generation !== historyGeneration.current) return;
      const pptItems = artifactMetadata(ppt, "ppt"), roadshowItems = artifactMetadata(roadshow, "roadshow");
      await checkAccount();
      if (!alive.current || generation !== historyGeneration.current) return;
      setHistory(pptItems); setRoadshows(roadshowItems); setHistoryLoaded(true); setCheckedUnknownHistory(true);
    } catch (reason) {
      if (!alive.current || generation !== historyGeneration.current) return;
      setHistoryError(message(reason));
      if (unauthenticated(reason)) { clearPrivate(); onIdentityChange(); }
    } finally { if (alive.current && generation === historyGeneration.current) setHistoryLoading(false); }
  }, [accountId, checkAccount, clearPrivate, onIdentityChange]);
  useEffect(() => { alive.current = true; void loadHistory(); return () => { alive.current = false; requestGeneration.current++; historyGeneration.current++; }; }, [loadHistory]);
  useEffect(() => {
    if (!accountId || !linkedRoadshowId || inheritedLinkApplied.current) return;
    inheritedLinkApplied.current = true;
    setForm(previous => ({ ...previous, artifactId: linkedRoadshowId }));
    setNotice("已选择链接中的路演记录。服务器会核对本人归属并继承保存的输入；待验证项保留为上下文，待实现内容不会补造。");
  }, [accountId, linkedRoadshowId]);
  useEffect(() => { onBusyChange(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    const expired = () => { if (!accountId) return; clearPrivate(); setError("登录已失效，本页的历史和结果已清除。请重新登录。"); onIdentityChange(); };
    window.addEventListener("hackathon:unauthenticated", expired); return () => window.removeEventListener("hackathon:unauthenticated", expired);
  }, [accountId, clearPrivate, onIdentityChange]);

  const updateForm = (field: keyof FormContent, value: string) => setForm(previous => ({ ...previous, [field]: value }));
  const acceptOutline = (artifact: PersonalArtifact, result: PptOutline) => {
    setOutline(result); setSavedArtifact(artifact); setForm(restoredForm(result.inputSnapshot)); setLocalEdits(false);
    setSourceProject(result.inputSnapshot.artifactId ? null : result.sourceProject ?? null); onProjectChange(result.sourceProject?.projectId ?? null);
    onConfigurationChange(result.inputSnapshot.templateId, result.inputSnapshot.durationMinutes);
    setUnknownResult(false); setPreviewOpen(false);
  };
  const generate = async () => {
    if (actionLock.current || !accountId || unknownResult) return;
    actionLock.current = true;
    const generation = ++requestGeneration.current;
    setBusy("generate"); setError(null); setNotice("");
    let submitted = false;
    try {
      const input = inputFromForm(form, templateId, durationMinutes);
      await checkAccount();
      if (!alive.current || generation !== requestGeneration.current) return;
      submitted = true;
      const artifact = await api<PersonalArtifact>("/me/ppt/outlines", { method: "POST", body: { ...input, ...(!input.artifactId && sourceProject ? { projectSource: { projectId: sourceProject.projectId, revision: sourceProject.revision } } : {}) } });
      if (!alive.current || generation !== requestGeneration.current) return;
      const result = readableOutline(artifact);
      await checkAccount();
      if (!alive.current || generation !== requestGeneration.current) return;
      acceptOutline(artifact, result);
      setHistory(previous => [artifact, ...previous.filter(item => item.id !== artifact.id)]);
      setNotice("DSH 大纲已保存到当前账号。请核对真实进展，逐页修改后再排练。");
    } catch (reason) {
      if (!alive.current || generation !== requestGeneration.current) return;
      if (unauthenticated(reason)) { clearPrivate(); onIdentityChange(); return; }
      const uncertain = submitted && !(reason instanceof ApiError && reason.code === "PROJECT_CONTEXT_UNAVAILABLE") && isUnknownAiOutcome(reason);
      setError(message(reason));
      if (uncertain) { setUnknownResult(true); setCheckedUnknownHistory(false); }
    } finally {
      if (alive.current && generation === requestGeneration.current) { actionLock.current = false; setBusy(null); }
    }
  };
  const restore = async (id: string) => {
    if (actionLock.current || !accountId) return;
    actionLock.current = true;
    const generation = ++requestGeneration.current;
    setBusy(id); setError(null); setNotice("");
    try {
      await checkAccount();
      if (!alive.current || generation !== requestGeneration.current) return;
      const artifact = await api<PersonalArtifact>(`/me/artifacts/${encodeURIComponent(id)}`);
      if (!alive.current || generation !== requestGeneration.current) return;
      const result = readableOutline(artifact, id);
      await checkAccount();
      if (!alive.current || generation !== requestGeneration.current) return;
      acceptOutline(artifact, result); setNotice("已恢复服务器保存的大纲和当时的项目输入。当前页的本地修改没有写回历史。");
    } catch (reason) {
      if (!alive.current || generation !== requestGeneration.current) return;
      setError(message(reason));
      if (unauthenticated(reason)) { clearPrivate(); onIdentityChange(); }
    } finally { if (alive.current && generation === requestGeneration.current) { actionLock.current = false; setBusy(null); } }
  };
  const editSlide = (index: number, field: "title" | "visualSuggestion" | "speakerNotes", value: string) => {
    setOutline(previous => previous ? { ...previous, slides: previous.slides.map((slide, i) => i === index ? { ...slide, [field]: value } : slide) } : null); setLocalEdits(true);
  };
  const editPoint = (slideIndex: number, pointIndex: number, value: string) => {
    setOutline(previous => previous ? { ...previous, slides: previous.slides.map((slide, i) => i === slideIndex ? { ...slide, keyPoints: slide.keyPoints.map((point, j) => {
      if (j !== pointIndex) return point;
      const fact = previous.facts.find(item => item.id === point.factId);
      return { ...point, text: value, ...(point.kind === "provided" && value !== fact?.text ? { kind: "suggestion" as const, factId: null } : {}) };
    }) } : slide) } : null); setLocalEdits(true);
  };
  const inherited = Boolean(form.artifactId), fieldsDisabled = Boolean(busy) || inherited || !accountId || identityLoading;
  const exportReady = Boolean(outline?.title.trim() && outline.slides.every(slide => slide.title.trim() && slide.keyPoints.every(point => point.text.trim()) && slide.visualSuggestion.trim() && slide.speakerNotes.trim()));

  return <>
    <div className={styles.workbenchGrid}>
      <form className={styles.formPanel} onSubmit={event => { event.preventDefault(); void generate(); }}>
        <div className={styles.titleRow}><h3>先把项目说明白</h3><span className={styles.badge}>{getPptTemplate(templateId).name}</span></div>
        <Field label="大纲结构" hint="选择适合本次展示的结构，再按主办方要求调整时长。详细模板和下载在下方按需查看。">
          <select value={templateId} disabled={Boolean(busy)} onChange={event => { const selected = getPptTemplate(event.target.value as PptTemplateId); onConfigurationChange(selected.id, selected.durationMinutes); }}>
            {PPT_TEMPLATES.map(item => <option key={item.id} value={item.id}>{item.name} · 默认 {item.durationMinutes} 分钟</option>)}
          </select>
        </Field>
        <Field label="路演时长（分钟）" hint="1–15 分钟整数；页内时间会包含演示。模板提供默认时长，可按比赛要求调整。">
          <input type="number" min={1} max={15} step={1} required value={Number.isNaN(durationMinutes) ? "" : durationMinutes} disabled={Boolean(busy)} onChange={event => onConfigurationChange(templateId, event.target.value === "" ? NaN : Number(event.target.value))}/>
        </Field>
        <PresentationProjectPicker accountId={accountId} suggestedProjectId={projectId} config={projectContextApi} busy={Boolean(busy)} source={sourceProject}
          onUse={snapshot => { setForm({ projectName: snapshot.projectName, projectIdea: snapshot.projectIdea, targetUsers: snapshot.targetUsers, completed: snapshot.completed.join("\n"), planned: snapshot.planned.join("\n"), evidence: snapshot.evidence.join("\n"), artifactId: "" }); setSourceProject(snapshot); onProjectChange(snapshot.projectId); setNotice("已带入你确认的项目资料，仍可按本次展示补充。生成时保存新的私人输入与来源快照。"); }}
          onClear={() => { setSourceProject(null); setNotice("已解除项目引用，输入文字保留。之后按本人填写的资料生成。"); }}/>
        {accountId && <Field label="继承本人已保存的路演" hint="服务器核对归属后读取该记录；只继承项目内容，模板和时长按本页选择。">
          <select value={form.artifactId} disabled={Boolean(busy) || historyLoading} onChange={event => { updateForm("artifactId", event.target.value); setSourceProject(null); }}>
            <option value="">自己填写或修改项目内容</option>{form.artifactId && !roadshows.some(item => item.id === form.artifactId) && <option value={form.artifactId}>引用的路演记录（服务器复核本人归属）</option>}
            {roadshows.map(item => <option key={item.id} value={item.id}>{item.title} · {dateText(item.createdAt)}</option>)}
          </select>
        </Field>}
        {accountId && historyLoaded && roadshows.length === 0 && !inherited && <p className={styles.muted}>还没有可继承的路演记录。可直接填写下面的项目内容。</p>}
        {inherited && <p className={styles.inheritanceNotice}>项目内容由服务器从本人路演记录继承，无需重复填写。待验证项保留为上下文，计划仍单独标注。若要自行填写项目内容，请取消继承。</p>}
        {!inherited && <>
        <Field label="项目名称（选填）"><input maxLength={120} value={form.projectName} disabled={fieldsDisabled} onChange={event => updateForm("projectName", event.target.value)} placeholder="让评委记住你的作品"/></Field>
        <Field label="项目想法" hint="写要解决的问题、使用场景与做法，最多 2000 字。"><textarea required={!inherited} maxLength={2000} rows={4} value={form.projectIdea} disabled={fieldsDisabled} onChange={event => updateForm("projectIdea", event.target.value)} placeholder="我们想帮助谁，在什么情景下，解决什么问题？"/></Field>
        <Field label="目标用户" hint="最多 1000 字；尽量具体到人和场景。"><textarea required={!inherited} maxLength={1000} rows={2} value={form.targetUsers} disabled={fieldsDisabled} onChange={event => updateForm("targetUsers", event.target.value)} placeholder="谁会实际使用？他们现在怎样处理这个问题？"/></Field>
        <div className={styles.scopeGrid}>
          <Field label="已完成的内容（选填）" hint="只有想法时留空。已完成的部分一行一项，最多 12 项，每项 600 字。"><textarea maxLength={7300} rows={4} value={form.completed} disabled={fieldsDisabled} onChange={event => updateForm("completed", event.target.value)} placeholder="能打开的页面、已经跑通的流程、已保存的成果"/></Field>
          <Field label="待实现的内容" hint="一行一项，最多 12 项，每项 600 字；会明确保留为计划。"><textarea maxLength={7300} rows={4} value={form.planned} disabled={fieldsDisabled} onChange={event => updateForm("planned", event.target.value)} placeholder="尚未接通的功能、下一步要实现的能力"/></Field>
        </div>
        <Field label="可以说明的依据（选填）" hint="一行一项，最多 12 项，每项 600 字。写已有记录或实际观察；没有数据就留空。"><textarea maxLength={7300} rows={3} value={form.evidence} disabled={fieldsDisabled} onChange={event => updateForm("evidence", event.target.value)} placeholder="实际测试结果、访谈观察、截图或记录说明"/></Field>
        </>}
        <p className={styles.muted}>生成内容包含逐页标题、要点、画面建议、讲者备注和演示安排。AI 建议仍需核对，不会把待实现写成已完成。</p>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {unknownResult && <div className={styles.warning} role="alert"><strong>本次结果尚不能确认</strong><p>不要立即重复付费生成。先刷新下方历史，检查是否已经保存；如果没有，仍需确认服务状态后再明确发起新尝试。</p>
          <div className={styles.actions}><button type="button" className={styles.secondary} disabled={historyLoading || Boolean(busy)} onClick={() => void loadHistory()}>{historyLoading ? "正在核对历史…" : "先核对已保存历史"}</button>
            {checkedUnknownHistory && <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => { setUnknownResult(false); setNotice("已解除本页防重复提示。只有确认上次请求状态后，才应手动发起新尝试；服务端仍会检查未知请求。 "); }}>我已核对，允许手动新尝试</button>}</div></div>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        <div className={styles.actions}>{accountId ? <button className={styles.button} disabled={Boolean(busy) || unknownResult || identityLoading}>{busy === "generate" ? "DSH 正在生成并保存…" : "用 DSH 生成逐页大纲"}</button>
          : <Link className={styles.button} href={loginHref}>登录后用 DSH 生成</Link>}</div>
        {busy === "generate" && <p className={styles.status} role="status">请求已发送，正在等待真实结果。请保留页面，重复点击已禁用；当前没有自动重试。</p>}
      </form>

      <aside className={styles.historyPanel} aria-labelledby="ppt-history-title"><div className={styles.titleRow}><h3 id="ppt-history-title">我的已保存大纲</h3>{accountId && <button type="button" className={styles.textButton} disabled={historyLoading || Boolean(busy)} onClick={() => void loadHistory()}>{historyLoading ? "读取中…" : "刷新历史"}</button>}</div>
        {!accountId ? <div className={styles.empty}><p>登录后查看当前账号的 DSH 大纲，并恢复当时的项目输入。</p><Link className={styles.link} href={loginHref}>登录查看历史</Link></div>
          : <>{historyLoading && <p className={styles.status} role="status">正在读取本人记录…</p>}{historyError && <div className={styles.error} role="alert">{historyError}</div>}
            {historyLoaded && !historyLoading && history.length === 0 && <div className={styles.empty}><strong>还没有保存的大纲</strong><p>第一次 DSH 生成成功后，记录会保存在这里。</p></div>}
            <ul className={styles.historyList}>{history.map(item => <li key={item.id} className={savedArtifact?.id === item.id ? styles.currentHistory : ""}><strong>{item.title}</strong><span>{dateText(item.createdAt)}</span>
              <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => void restore(item.id)}>{busy === item.id ? "正在恢复…" : savedArtifact?.id === item.id ? "重新读取保存版本" : "恢复这份大纲"}</button></li>)}</ul></>}
        {localEdits && <p className={styles.warning}>恢复历史或重新生成会替换当前页的本地修改。需要保留时，请先下载 Markdown。</p>}
        <div className={styles.historyTip}><strong>讲之前，再过一遍</strong><p>先核对每页事实，再计时排练。演示失败时，用截图或概念流程说明实际进展。</p></div>
      </aside>
    </div>

    {outline ? <div className={styles.outputPanel} aria-labelledby="ppt-output-title">
      <div className={styles.titleRow}><div><p className={styles.eyebrow}>逐页编辑</p><h3 id="ppt-output-title">你的路演大纲</h3><p className={styles.muted}>{outline.slides.length} 页 · {outline.durationMinutes} 分钟 · provider:dsh{savedArtifact && <> · 保存于 {dateText(savedArtifact.createdAt)}</>}</p></div>
        <span className={`${styles.badge} ${localEdits ? styles.localBadge : ""}`}>{localEdits ? "本地修改 · 未保存到账号" : "服务器保存版本"}</span></div>
      <p className={styles.description}>可修改标题、要点、视觉建议和讲者备注。修改保留在当前页面；下面的下载和预览使用当前编辑内容。</p>
      {outline.sourceProject && <PresentationSourceSummary snapshot={outline.sourceProject}/>}
      <Field label="整份大纲标题"><input required maxLength={120} value={outline.title} disabled={Boolean(busy)} onChange={event => { setOutline(previous => previous ? { ...previous, title: event.target.value } : null); setLocalEdits(true); }}/></Field>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={!exportReady || Boolean(busy)} onClick={() => downloadText(outlineMarkdown(outline), `${fileName(outline.title)}.md`, "text/markdown;charset=utf-8")}>下载当前 Markdown</button>
        <button type="button" className={styles.secondary} disabled={!exportReady || Boolean(busy)} aria-expanded={previewOpen} aria-controls="ppt-print-preview" onClick={() => setPreviewOpen(value => !value)}>{previewOpen ? "收起幻灯片预览" : "查看幻灯片预览"}</button>
        <button type="button" className={styles.secondary} disabled={!exportReady || Boolean(busy)} onClick={() => downloadText(outlinePrintHtml(outline), `${fileName(outline.title)}-打印预览.html`, "text/html;charset=utf-8")}>下载可打印 HTML</button></div>
      <p className={styles.muted}>Markdown 是文字大纲，HTML 是浏览器幻灯片预览。打开下载的 HTML 后，可使用浏览器“打印”或另存 PDF。这里没有生成 .pptx 文件。</p>
      <div className={styles.nextStep}><strong>大纲核对好后</strong><p>先去下方选择制作工具，补上真实截图并排练，再回到团队空间分别检查代码保存、能否运行和主办方提交。</p><div className={styles.actions}><a className={styles.secondary} href="#ppt-tools">挑选 PPT 制作工具</a><Link className={styles.link} href={presentationHref("delivery", outline.sourceProject?.projectId ?? projectId)}>{projectId ? "在当前空间查看代码与提交 →" : "选择团队空间，查看代码与提交 →"}</Link></div></div>
      {!exportReady && <p className={styles.warning}>请补齐空白的标题、要点、视觉建议或讲者备注，再下载与预览。</p>}
      {previewOpen && <div id="ppt-print-preview" className={styles.printPreview}><p className={styles.muted}>预览包含讲者备注；HTML 打印样式只打印幻灯片。文字过长时请先精简。</p><iframe title="当前编辑大纲的幻灯片预览" srcDoc={previewHtml} sandbox="" loading="lazy"/></div>}
      <ol className={styles.outlineSlides}>{outline.slides.map((slide, slideIndex) => <li className={styles.outlineSlide} key={slide.number}>
        <div className={styles.slideHeader}><span className={styles.slideNumber}>{String(slide.number).padStart(2, "0")}</span><strong>第 {slide.number} 页</strong><span>{slide.durationSeconds} 秒（含演示）</span></div>
        <Field label={`第 ${slide.number} 页标题`}><input required maxLength={100} value={slide.title} disabled={Boolean(busy)} onChange={event => editSlide(slideIndex, "title", event.target.value)}/></Field>
        <div className={styles.points}><h4>页内要点</h4>{slide.keyPoints.map((point, pointIndex) => <div key={pointIndex} className={styles.point}><span className={`${styles.pointLabel} ${point.kind === "needs_evidence" ? styles.needsEvidence : ""}`}>{pointLabel(point, outline)}</span>
          <Field label={`第 ${slide.number} 页要点 ${pointIndex + 1}`}><textarea required maxLength={600} rows={2} value={point.text} disabled={Boolean(busy)} onChange={event => editPoint(slideIndex, pointIndex, event.target.value)}/></Field></div>)}</div>
        <div className={styles.slideFields}><Field label="画面怎样呈现"><textarea required maxLength={800} rows={3} value={slide.visualSuggestion} disabled={Boolean(busy)} onChange={event => editSlide(slideIndex, "visualSuggestion", event.target.value)}/></Field>
          <Field label="讲者备注"><textarea required maxLength={2200} rows={5} value={slide.speakerNotes} disabled={Boolean(busy)} onChange={event => editSlide(slideIndex, "speakerNotes", event.target.value)}/></Field></div>
        <div className={styles.demonstration}><h4>{demonstrationLabels[slide.demonstration.mode]}</h4>{slide.demonstration.steps.length > 0 && <ol>{slide.demonstration.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
          {slide.demonstration.fallback && <p><strong>备用安排：</strong>{slide.demonstration.fallback}</p>}</div>
      </li>)}</ol>
      <div className={styles.reviewGrid}><section><h4>排练核对</h4><ul>{outline.rehearsalChecklist.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
        <section className={styles.reviewWarnings}><h4>仍需复核</h4><ul>{outline.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></section></div>
    </div> : <div className={styles.resultEmpty}><span className={styles.emptyMarker} aria-hidden="true">PPT</span><div><h3>逐页大纲会出现在这里</h3><p>模板可以直接下载。DSH 生成成功后，可编辑、恢复历史并下载当前版本。</p></div></div>}
  </>;
}
