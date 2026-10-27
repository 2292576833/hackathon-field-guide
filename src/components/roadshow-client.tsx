"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PersonalArtifact } from "../shared/personal-ai.ts";
import type { RoadshowDocument, RoadshowInput } from "../modules/roadshow/types.ts";
import type { PresentationProjectSnapshot } from "../modules/roadshow/index.ts";
import { validateRoadshowDocument, roadshowToMarkdown } from "../modules/roadshow/validation.ts";
import { DEMO_FALLBACKS, JUDGE_QUESTIONS, ROADSHOW_EXAMPLES, ROADSHOW_REMINDERS, readRoadshowIdea, roadshowAllocation, roadshowPptHref } from "../modules/roadshow/content.ts";
import { api, ApiError, dateText, isUnknownAiOutcome, useApi } from "./client-api.ts";
import { Feedback, SiteShell, type Me } from "./site-shell.tsx";
import { PresentationWorkflow, PresentationProjectPicker, PresentationSourceSummary, presentationHref, usePresentationProjectId, type PresentationProjectApi } from "./presentation-workflow.tsx";
import styles from "./roadshow.module.css";

const EMPTY_INPUT: RoadshowInput = {
  projectIdea: "", targetUsers: "", problem: "", completedCapabilities: "", technicalApproach: "",
  differentiation: "", facts: "", assumptions: "", pendingValidation: "", plannedCapabilities: "", durationSeconds: 180,
};
type TextField = Exclude<keyof RoadshowInput, "durationSeconds">;
const FIELDS: { name: TextField; title: string; hint: string; placeholder: string; max: number; required?: boolean }[] = [
  { name: "projectIdea", title: "项目想法", hint: "一句话说明为谁解决什么问题。", placeholder: "你的项目准备做什么？", max: 2000, required: true },
  { name: "targetUsers", title: "目标用户", hint: "描述具体人群和使用场景。", placeholder: "谁会在什么场景使用？", max: 1000, required: true },
  { name: "problem", title: "要解决的问题", hint: "说明现有困难；没有访谈证据时，写明是你的观察或假设。", placeholder: "他们现在怎么做？哪里不方便？", max: 2000, required: true },
  { name: "completedCapabilities", title: "已经完成的能力", hint: "只填实际完成的部分。还没做出来可以写“尚未实现，仅有想法”。", placeholder: "能实际演示什么？哪些只是原型或演示数据？", max: 3000, required: true },
  { name: "plannedCapabilities", title: "计划中的能力", hint: "还没实现的功能单独写在这里，不会当作已完成成果。", placeholder: "接下来准备做什么？哪些功能仍在计划中？", max: 3000 },
  { name: "technicalApproach", title: "技术方案", hint: "写已采用或打算采用的方案，并区分二者。", placeholder: "主要工具、数据来源、人工步骤和技术取舍。", max: 3000 },
  { name: "differentiation", title: "与现有办法的差异", hint: "比较具体体验或流程；没有调查时可以留空。", placeholder: "你的方案有什么不同？依据是什么？", max: 1500 },
  { name: "facts", title: "已知事实与依据", hint: "只写有依据的信息，注明自测、访谈或来源；没有就留空。", placeholder: "例如实际完成的测试及其条件，不填未经核实的数据。", max: 3000 },
  { name: "assumptions", title: "想法与假设", hint: "希望发生、尚未确认的事情放在这里。", placeholder: "你推测的需求、收益或下一步方案。", max: 2000 },
  { name: "pendingValidation", title: "待验证的问题", hint: "列出你还不知道、需要进一步核实的部分。", placeholder: "用户是否需要？效果如何？成本和限制是什么？", max: 2000 },
];

function secondsText(seconds: number) {
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : ""}` : `${rest} 秒`;
}
function readArtifact(value: unknown): PersonalArtifact<RoadshowDocument> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("记录格式无效，无法恢复这份路演讲稿。");
  const record = value as Partial<PersonalArtifact>;
  if (record.kind !== "roadshow" || record.provider !== "dsh" || typeof record.id !== "string" || typeof record.sessionId !== "string" || typeof record.title !== "string" || record.title.length > 200 || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("记录格式无效，无法恢复这份路演讲稿。");
  // Also bounds the record reference before it can become a navigation target.
  roadshowPptHref(record.id);
  return { ...record as PersonalArtifact, data: validateRoadshowDocument(record.data) };
}

function TimeDiagram({ seconds }: { seconds: number }) {
  const parts = roadshowAllocation(seconds);
  return <figure className={styles.timeFigure}>
    <figcaption>一份 {secondsText(seconds)} 路演的练习分配</figcaption>
    <div className={styles.timeBar} aria-hidden="true">{parts.map(part => <span key={part.tone} className={styles[part.tone]} style={{ flex: part.seconds }} />)}</div>
    <ul className={styles.timeLegend}>{parts.map(part => <li key={part.tone}><span className={`${styles.swatch} ${styles[part.tone]}`} aria-hidden="true"/><span>{part.label}</span><strong>{part.seconds} 秒</strong></li>)}</ul>
    <p className={styles.hint}>这是本站练习建议，可按比赛规则调整。问答另计；生成稿的分段时间以真实结果为准，仍需用自己的语速彩排。</p>
  </figure>;
}

export function RoadshowClient({ projectId, projectContextApi }: { projectId?: string; projectContextApi?: PresentationProjectApi } = {}) {
  const linkedProjectId = usePresentationProjectId(projectId);
  const identity = useApi<Me>("/me", { timeoutMs: 15000 });
  const history = useApi<PersonalArtifact[]>(identity.data ? "/me/artifacts?kind=roadshow" : null, { timeoutMs: 15000 });
  const [input, setInput] = useState<RoadshowInput>({ ...EMPTY_INPUT });
  const [sourceProject, setSourceProject] = useState<PresentationProjectSnapshot | null>(null);
  const [minutes, setMinutes] = useState("3");
  const [artifact, setArtifact] = useState<PersonalArtifact<RoadshowDocument> | null>(null);
  const [artifactOwner, setArtifactOwner] = useState<string | null>(null);
  const [historyOwner, setHistoryOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [elapsed, setElapsed] = useState(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");
  const [urlIdea, setUrlIdea] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const owner = identity.data?.profile.id ?? null;
  const ownerRef = useRef<string | null>(owner), epoch = useRef(0), inFlight = useRef(false);
  const previousOwner = useRef<string | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  ownerRef.current = owner;
  const duration = Number(minutes) * 60;
  const validDuration = Number.isInteger(duration) && duration >= 60 && duration <= 900;
  const loggedOut = identity.error instanceof ApiError && identity.error.status === 401;

  useEffect(() => {
    const idea = readRoadshowIdea(window.location.search);
    if (idea) { setInput(current => ({ ...current, projectIdea: idea })); setUrlIdea(true); }
  }, []);
  useEffect(() => {
    const clear = () => {
      if (ownerRef.current || previousOwner.current) { setInput({ ...EMPTY_INPUT }); setMinutes("3"); setUrlIdea(false); }
      epoch.current++; ownerRef.current = null; setArtifact(null); setArtifactOwner(null); setHistoryOwner(null); setRestoring(null); setUncertain(false); setNotice(""); setSourceProject(null);
    };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => { window.removeEventListener("hackathon:unauthenticated", clear); epoch.current++; };
  }, []);
  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== owner) { setInput({ ...EMPTY_INPUT }); setMinutes("3"); setUrlIdea(false); }
    previousOwner.current = owner;
    epoch.current++; setArtifact(null); setArtifactOwner(null); setRestoring(null); setNotice(""); setUncertain(false); setHistoryOwner(null); history.setData(null); setSourceProject(null);
    const startEpoch = epoch.current;
    if (owner) void history.reload().then(() => { if (ownerRef.current === owner && epoch.current === startEpoch) setHistoryOwner(owner); });
  }, [owner, history.reload, history.setData]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const revealExamples = () => {
      if (window.location.hash !== "#roadshow-examples") return;
      const target = document.getElementById("roadshow-examples");
      if (!(target instanceof HTMLDetailsElement)) return;
      target.open = true; target.querySelector("summary")?.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
    };
    const onLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.hash === "#roadshow-examples") requestAnimationFrame(revealExamples);
    };
    revealExamples(); window.addEventListener("hashchange", revealExamples); document.addEventListener("click", onLink);
    return () => { window.removeEventListener("hashchange", revealExamples); document.removeEventListener("click", onLink); };
  }, []);

  function currentRequest(startOwner: string | null, startEpoch: number) { return startOwner !== null && ownerRef.current === startOwner && epoch.current === startEpoch; }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || restoring) return;
    setError(null); setNotice("");
    if (!owner) { setError(new Error("请先登录，再生成并保存私人讲稿。")); return; }
    if (!validDuration) { setError(new Error("请填写 1–15 分钟，支持半分钟步进。")); return; }
    const startOwner = owner, startEpoch = epoch.current;
    const controller = new AbortController(); let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 150000);
    inFlight.current = true; setBusy(true);
    try {
      const value = await api<PersonalArtifact>("/me/roadshow/scripts", { method: "POST", body: { ...input, durationSeconds: duration, ...(sourceProject ? { projectSource: { projectId: sourceProject.projectId, revision: sourceProject.revision } } : {}) }, signal: controller.signal });
      const next = readArtifact(value);
      if (!currentRequest(startOwner, startEpoch)) return;
      setArtifact(next); setArtifactOwner(startOwner); setUncertain(false); setNotice("DSH 讲稿已返回并保存。先核对事实，再计时练习。");
      void history.reload();
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (reason) {
      if (!currentRequest(startOwner, startEpoch)) return;
      const unknown = timedOut || (!(reason instanceof ApiError && reason.code === "PROJECT_CONTEXT_UNAVAILABLE") && isUnknownAiOutcome(reason));
      setUncertain(unknown);
      setError(timedOut ? new Error("等待超时，服务端可能仍在处理。请先刷新历史核对保存结果，不要立即重复生成。") : reason instanceof Error ? reason : new Error("生成结果暂时无法确认，请先检查历史。"));
    } finally { clearTimeout(timeout); inFlight.current = false; setBusy(false); }
  }

  async function restore(id: string) {
    if (busy || restoring || !owner) return;
    const startOwner = owner, startEpoch = epoch.current;
    setRestoring(id); setError(null); setNotice("");
    try {
      roadshowPptHref(id);
      const next = readArtifact(await api<PersonalArtifact>(`/me/artifacts/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) }));
      if (!currentRequest(startOwner, startEpoch)) return;
      if (next.id !== id) throw new Error("记录与请求不一致，请刷新历史后重试。");
      setArtifact(next); setArtifactOwner(startOwner); setInput({ ...next.data.input }); setMinutes(String(next.data.input.durationSeconds / 60));
      setSourceProject(next.data.sourceProject ?? null);
      setUrlIdea(false); setNotice("已恢复这份记录的输入和讲稿。修改后生成会保存为新的记录。尚未确认的请求仍需核查。");
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (reason) {
      if (currentRequest(startOwner, startEpoch)) setError(reason instanceof Error && ["TimeoutError", "AbortError"].includes(reason.name) ? new Error("历史读取超时，记录未改变，请稍后重试。") : reason instanceof Error ? reason : new Error("历史读取失败，请稍后重试。"));
    }
    finally { if (currentRequest(startOwner, startEpoch)) setRestoring(null); }
  }

  function download() {
    if (!artifact || !owner || artifactOwner !== owner) return;
    const blob = new Blob([roadshowToMarkdown(artifact.data)], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = href; anchor.download = `路演讲稿-${artifact.id}.md`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setNotice("已发起 Markdown 下载，请查看浏览器下载记录。");
  }
  async function copy() {
    if (!artifact || !owner || artifactOwner !== owner) return;
    const startOwner = owner, startEpoch = epoch.current;
    try { await navigator.clipboard.writeText(roadshowToMarkdown(artifact.data)); if (currentRequest(startOwner, startEpoch)) setNotice("Markdown 讲稿已复制。"); }
    catch { if (currentRequest(startOwner, startEpoch)) setError(new Error("浏览器未允许复制。可展开 Markdown 文本手动选择，或下载讲稿。")); }
  }

  const script = artifactOwner === owner ? artifact?.data.script : null;
  const currentProjectId = sourceProject?.projectId ?? linkedProjectId;
  const optionalInputPresent = FIELDS.some(field => !field.required && input[field.name].trim());
  const renderField = (field: typeof FIELDS[number]) => <div className={styles.field} key={field.name}>
    <label htmlFor={`roadshow-${field.name}`}>{field.title}{field.required ? <span>必填</span> : <span>选填</span>}</label>
    <textarea id={`roadshow-${field.name}`} value={input[field.name]} required={field.required} maxLength={field.max} rows={field.name === "projectIdea" ? 3 : 4} placeholder={field.placeholder} aria-describedby={`roadshow-${field.name}-hint`} onChange={event => setInput(current => ({ ...current, [field.name]: event.target.value }))}/>
    <div className={styles.fieldMeta} id={`roadshow-${field.name}-hint`}><span>{field.hint}</span><span>{input[field.name].length}/{field.max}</span></div>
  </div>;
  return <SiteShell><div className={styles.page}>
    <PresentationWorkflow step="roadshow" projectId={currentProjectId}/>
    <header className={styles.sectionHeading}>
      <div><p className={styles.eyebrow}>路演准备 · 仅本人可见</p><h1>准备我的路演讲稿</h1><p className={styles.hint}>从真实进展开始，分别写清已完成、计划和待验证的内容。可选用空间资料，或继续本人已保存的讲稿。</p>
        <div className={styles.actions}><a className={styles.primary} href="#roadshow-input">准备我的讲稿 ↗</a><a className={styles.textLink} href="#roadshow-examples">先看原创案例</a></div>
      </div>
    </header>

    <section id="roadshow-input" className={styles.section} aria-labelledby="input-title">
      <div className={styles.sectionHeading}><h2 id="input-title">填写或继续我的作品内容</h2><p>四项必填内容，加上主办方要求的演讲时间就能开始。无需先填个人画像；若已填写，服务可参考参赛与表达经验。</p></div>
      {identity.loading && <p role="status" className={styles.callout}>正在读取登录状态…</p>}
      {loggedOut && <div className={styles.callout}><strong>登录后生成并保存到你的账号。</strong><p>原创案例与练习提示可以直接阅读。</p><Link className={styles.textLink} href={`/login?returnTo=${encodeURIComponent(presentationHref("roadshow", linkedProjectId))}`}>去登录 →</Link></div>}
      {!identity.loading && identity.error && !loggedOut && <div className={styles.callout}><Feedback error={identity.error}/><button type="button" className={styles.secondary} onClick={() => void identity.reload()}>重新读取登录状态</button></div>}
      {urlIdea && <p className={styles.hint}>已从链接带入项目想法，请核对后再生成。其余内容请按你的实际情况填写。</p>}
      <PresentationProjectPicker key={owner ?? "public"} accountId={owner} suggestedProjectId={linkedProjectId} busy={busy || Boolean(restoring)} config={projectContextApi} source={sourceProject}
        onUse={snapshot => {
          if ([snapshot.completed, snapshot.planned, snapshot.evidence].some(items => items.join("\n").length > 3000)) {
            setError(new Error("所选项目成果、计划或依据超过讲稿单项 3000 字上限。尚未替换输入；请精简项目说明，或先在 PPT 页选用完整资料。")); return false;
          }
          setInput(current => ({ ...current, projectIdea: snapshot.projectIdea, targetUsers: snapshot.targetUsers, problem: snapshot.problem,
            completedCapabilities: snapshot.completed.join("\n") || "尚未记录明确成果，请按实际情况补充。", plannedCapabilities: snapshot.planned.join("\n"), facts: snapshot.evidence.join("\n") }));
          setSourceProject(snapshot); setUrlIdea(false); setNotice("已带入你确认的项目资料。请补齐缺失信息；修改后生成会保存为新的私人讲稿。");
        }} onClear={() => { setSourceProject(null); setNotice("已解除项目引用，输入文字保留。后续按本人填写的资料生成。"); }}/>
      <form className={styles.form} onSubmit={event => void generate(event)} aria-busy={busy}>
        <fieldset disabled={busy || Boolean(restoring)}><legend className={styles.srOnly}>项目资料与演讲时间</legend><div className={styles.fields}>{FIELDS.filter(field => field.required).map(renderField)}</div>
          <details className={`${styles.fold} ${styles.optionalFields}`} open={optionalInputPresent} onToggle={event => { if (!event.currentTarget.open && optionalInputPresent) event.currentTarget.open = true; }}><summary>选填：计划、技术、依据与待验证事项{optionalInputPresent ? "（已有补充内容，保持展开）" : ""}</summary><p className={styles.hint}>有资料时再补充。已完成与计划分别保存；这里的内容不会自动共享给队友。</p><div className={styles.fields}>{FIELDS.filter(field => !field.required).map(renderField)}</div></details>
          <div className={styles.durationField}><label htmlFor="roadshow-duration">演讲时间（分钟，问答另计）</label><input id="roadshow-duration" type="number" min="1" max="15" step="0.5" required value={minutes} onChange={event => setMinutes(event.target.value)} aria-describedby="duration-hint"/><p id="duration-hint" className={styles.hint}>支持 1–15 分钟。按比赛规则填写；生成稿包含开场、分段讲稿和结尾，演示计入分段时间。</p></div></fieldset>
        <Feedback error={error} notice={notice}/>
        {busy && <p className={styles.callout} role="status">DSH 正在整理并校验讲稿，已等待 {elapsed} 秒。结果返回后才会显示保存成功。</p>}
        {uncertain && <div className={styles.callout}><strong>本次结果尚需核查，未自动重发。</strong><p>先刷新历史查看是否已有记录；未找到也不代表请求没有执行。若服务提示未知请求，请联系管理员核查。</p><button type="button" className={styles.secondary} disabled={history.loading} onClick={() => void history.reload()}>只刷新已保存记录</button></div>}
        <div className={styles.actions}><button className={styles.primary} disabled={busy || Boolean(restoring) || !owner || uncertain} type="submit">{busy ? "正在生成…" : "用 DSH 生成并保存讲稿"}</button><span className={styles.hint}>会使用账号的 AI 请求预算。失败会显示原因，输入仍保留。</span></div>
      </form>
    </section>

    {artifact && script && <section ref={resultRef} tabIndex={-1} className={`${styles.section} ${styles.result}`} aria-labelledby="script-title">
      <div className={styles.sectionHeading}><span>已保存的 DSH 草稿</span><h2 id="script-title">{artifact.title}</h2><p>{dateText(artifact.createdAt)} · provider:dsh · 讲稿分配 {secondsText(script.totalDurationSeconds)}</p></div>
      <p className={styles.callout}>以下根据你提供的资料生成，并未替你执行 Demo 或核验事实。请先处理待核实事项，再用自己的语速彩排和删减。</p>
      {artifact.data.sourceProject && <PresentationSourceSummary snapshot={artifact.data.sourceProject}/>}
      <div className={styles.actions}><button type="button" className={styles.primary} onClick={download}>下载 Markdown 讲稿</button><button type="button" className={styles.secondary} onClick={() => void copy()}>复制讲稿</button><Link className={styles.textLink} href={presentationHref("ppt", artifact.data.sourceProject?.projectId ?? currentProjectId, artifact.id)}>带入这份讲稿，整理 PPT →</Link></div>
      <p className={styles.hint}>PPT 入口只携带记录编号，由当前账号读取讲稿，不把项目内容放进链接。</p>
      <div className={styles.scriptBlock}><span className={styles.timing}>{secondsText(script.opening.durationSeconds)}</span><h3>开场介绍</h3><p>{script.opening.text}</p></div>
      {script.segments.map((segment, index) => <div className={styles.scriptBlock} key={`${index}-${segment.title}`}><span className={styles.timing}>{secondsText(segment.durationSeconds)}</span><h3>{index + 1}. {segment.title}</h3><p>{segment.text}</p></div>)}
      <div className={styles.scriptBlock}><span className={styles.timing}>{secondsText(script.closing.durationSeconds)}</span><h3>结尾</h3><p>{script.closing.text}</p></div>
      <h3 className={styles.subheading}>演示步骤与备选</h3><ol className={styles.demoList}>{script.demoSteps.map((step, index) => <li key={index}><strong>{step.action}</strong><p><span>预期展示：</span>{step.expectedResult}</p><p><span>失败备选：</span>{step.fallback}</p></li>)}</ol>
      <h3 className={styles.subheading}>评委 Q&amp;A（问答另计）</h3><div className={styles.qa}>{script.qa.map((item, index) => <details key={index}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div>
      <div className={styles.verification}><h3>上台前待核实</h3><ul>{script.verificationItems.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
      <details className={styles.fold}><summary>展开 Markdown 文本，手动复制</summary><pre className={styles.markdown} tabIndex={0}>{roadshowToMarkdown(artifact.data)}</pre></details>
    </section>}

    <section id="roadshow-history" className={styles.section} aria-labelledby="history-title"><div className={styles.sectionHeading}><h2 id="history-title">继续本人已保存的讲稿</h2><p>只读取当前账号保存的记录。恢复和刷新历史不会发起新的 AI 生成。</p></div>
      {!owner && <p className={styles.empty}>{identity.loading ? "正在读取登录状态…" : "登录后可以查看和恢复自己的讲稿。"}</p>}
      {owner && <><div className={styles.actions}><button className={styles.secondary} type="button" disabled={history.loading || busy || Boolean(restoring)} onClick={() => void history.reload()}>{history.loading ? "正在读取…" : "刷新历史"}</button></div><Feedback error={history.error}/>{history.loading && <p role="status" className={styles.hint}>正在读取已保存记录…</p>}{!history.loading && !history.error && historyOwner === owner && history.data?.length === 0 && <p className={styles.empty}>还没有保存的路演讲稿。填写项目资料并生成后，记录会出现在这里。</p>}<ul className={styles.historyList}>{historyOwner === owner && history.data?.filter(item => item.kind === "roadshow" && item.provider === "dsh").map(item => <li key={item.id}><div><strong>{item.title}</strong><p>{dateText(item.createdAt)} · DSH{artifactOwner === owner && artifact?.id === item.id ? " · 当前查看" : ""}</p></div><button type="button" className={styles.secondary} disabled={busy || Boolean(restoring)} onClick={() => void restore(item.id)}>{restoring === item.id ? "正在恢复…" : "恢复输入与讲稿"}</button></li>)}</ul></>}
    </section>
    <details id="roadshow-examples" className={`${styles.section} ${styles.fold}`} aria-labelledby="examples-title">
      <summary id="examples-title">路演结构与原创练习案例（需要时展开）</summary>
      <aside className={styles.cueCard} aria-label="路演结构提示"><span className={styles.cardNumber}>01 — 05</span><p>先让人理解，<br/>再让人看见。</p><ol><li>谁遇到了什么问题</li><li>你的方案怎样解决</li><li>现场展示一个核心流程</li><li>说明事实、限制与下一步</li><li>回答评委的问题</li></ol><span className={styles.stamp}>讲稿是草稿 · 彩排才知道时长</span></aside>
      <div className={styles.sectionHeading}><h2>两个原创练习案例</h2><p>以下是本站创作的虚构示例项目，用来说明讲述方法。它们不是获奖作品，也不代表真实用户、测试或运行结果。</p></div>
      <div className={styles.examples}>{ROADSHOW_EXAMPLES.map(example => <article key={example.id} className={styles.example}><span className={styles.tag}>{example.label}</span><h3>{example.title}</h3><p className={styles.hint}>{example.category} · {example.idea}</p><blockquote>{example.opening}</blockquote><p>{example.lesson}</p><details><summary>展开完整讲述思路</summary><div className={styles.detailBody}><h4>展开问题与方案</h4><p>{example.story}</p><h4>演示思路（需要自行实现与验证）</h4><ol>{example.demo.map(step => <li key={step}>{step}</li>)}</ol><h4>结尾</h4><p>{example.ending}</p><h4>评委追问：{example.question}</h4><p>{example.answer}</p></div></details></article>)}</div>
    </details>
    <details className={`${styles.section} ${styles.fold}`} aria-labelledby="rehearsal-title">
      <summary id="rehearsal-title">时间分配、演示备选与排练提示（需要时展开）</summary>
      <p className={styles.hint}>不要把全部时间排满。比赛若把问答算进总时长，先从演讲时间里扣除问答。</p>
      <TimeDiagram seconds={validDuration ? duration : 180}/>
      <div className={styles.reminders}>{ROADSHOW_REMINDERS.map(item => <article key={item.title}><h3>{item.title}</h3><p>{item.text}</p></article>)}</div>
      <details className={styles.fold}><summary>演示失败时，怎样继续讲</summary><ul className={styles.fallbackList}>{DEMO_FALLBACKS.map(item => <li key={item.problem}><strong>{item.problem}</strong><p>{item.action}</p></li>)}</ul></details>
      <details className={styles.fold}><summary>提前准备：评委常问的六个问题</summary><ul className={styles.fallbackList}>{JUDGE_QUESTIONS.map(item => <li key={item.question}><strong>{item.question}</strong><p>{item.answer}</p></li>)}</ul></details>
    </details>
  </div></SiteShell>;
}
