"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AssistantContextCoverage, AssistantConversation, AssistantMessage, AssistantReply, AssistantShareSelection, AssistantSource, TeamAssistantContextSnapshot } from "./model.ts";
import styles from "./assistant.module.css";

export interface AssistantHttpOptions { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal }
/** A root adapter may inject its authenticated HTTP transport. Paths are absolute API paths. */
export type AssistantHttpRequest = <T>(path: string, options?: AssistantHttpOptions) => Promise<T>;
export interface TeamAssistantPanelProps {
  projectId: string;
  /** Root passes the current account ID so changing accounts drops old private UI immediately. */
  accountKey?: string;
  projectName?: string;
  apiBase?: string;
  request?: AssistantHttpRequest;
  initialConversation?: AssistantConversation;
  initialContext?: TeamAssistantContextSnapshot;
  onShare?: (selection: AssistantShareSelection) => void | Promise<void>;
  readOnly?: boolean;
}

class AssistantHttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) { super(message); this.code = code; this.status = status; }
}
export const assistantHttpRequest: AssistantHttpRequest = async <T,>(path: string, options: AssistantHttpOptions = {}): Promise<T> => {
  const response = await fetch(path, {
    method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = value && typeof value === "object" && "error" in value ? value.error : null;
    const error = envelope && typeof envelope === "object" ? envelope as Record<string, unknown> : {};
    throw new AssistantHttpError(typeof error.message === "string" ? error.message : "暂时无法读取结果，请核对已保存状态。", typeof error.code === "string" ? error.code : "HTTP_ERROR", response.status);
  }
  return (value && typeof value === "object" && "data" in value ? value.data : value) as T;
};
export function assistantErrorText(error: unknown): string {
  return error instanceof AssistantHttpError ? error.message : "连接中断，输入已保留。请先核对已保存状态。";
}
export function assistantResultIsUncertain(error: unknown): boolean {
  return !(error instanceof AssistantHttpError) || /UNKNOWN|INTERNAL|HTTP_ERROR|TIMEOUT/.test(error.code);
}
export function assistantAccessWasLost(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; code?: unknown };
  return value.status === 401 || value.status === 403 || typeof value.code === "string" && /UNAUTHENTICATED|SESSION_(INVALID|EXPIRED)|FORBIDDEN|ACCESS_DENIED|PROJECT_UNAVAILABLE|PROJECT_NOT_FOUND/.test(value.code);
}
function requestIdentifier(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function assistantByteLength(value: string): number { return new TextEncoder().encode(value).length; }
export function assistantDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)}（UTC+8）`;
}
function safeHref(value: string): string | undefined {
  if (!value || /[\\\u0000-\u0020]/.test(value) || value.startsWith("//")) return undefined;
  if (value.startsWith("/")) return value;
  try { const url = new URL(value); return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function AssistantSources({ sources }: { sources: readonly AssistantSource[] }) {
  return sources.length ? <ul>{sources.map(source => <li key={source.id}>{source.href && safeHref(source.href) ? <a href={safeHref(source.href)} target={source.href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">{source.label}</a> : source.label}</li>)}</ul> : <p className={styles.muted}>尚未提供可引用来源。</p>;
}
const factLabels: Record<string, string> = {
  project: "作品与阶段", name: "名称", projectName: "作品名称", stage: "当前阶段", goal: "作品目标", goalSummary: "目标摘要", goals: "作品目标", scope: "最小成果范围", minimumScope: "最小成果范围",
  rules: "已确认比赛要求", ruleVersion: "规则版本", selectedTrack: "选择的官方赛道", officialTrack: "官方赛道", track: "赛道", requirements: "必交材料", member: "本人资料", profile: "本人参赛资料", ownProfile: "本人参赛资料",
  responsibilities: "职责", roles: "职责", ownResponsibilities: "本人职责", sharedRoles: "队友已共享职责", tasks: "当前任务", ownTasks: "本人任务", teamTasks: "团队任务", dependencies: "任务依赖", handoffs: "队友交接", availability: "可用时间", ownAvailability: "本人可用时间", deadline: "截止时间", suggestions: "团队有效建议", sharedSuggestions: "团队有效建议", sharedDecisions: "已采纳决定", title: "标题", description: "说明", status: "状态", deliverable: "交付物", acceptanceCriteria: "检查条件", assignee: "负责人", purpose: "参赛目的", summary: "摘要", checks: "实际检查", progress: "实际进展", members: "已共享成员信息", facts: "当前事实",
  me: "本人身份", teammates: "当前队友", myIntention: "本人已保存的职责意向", sharedIntentions: "队友已共享的职责意向", officialRules: "官方要求与当前确认", plan: "当前计划", myTasks: "本人实际任务", reviewTasks: "等待本人检查的交接", recentProgress: "最近真实进展", sharedAdvice: "团队有效建议与决定", minimumDeliverable: "最小交付成果", timezone: "项目时区", role: "成员角色", needsConfirmation: "是否需要重新确认", intention: "职责意向", duties: "职责说明", experience: "相关经历", helpQuestion: "需要的帮助", eventId: "赛事记录", rulesVersion: "规则版本", confirmationRevision: "当前确认版本", trackName: "官方赛道名称", reason: "选择依据", eligibility: "参赛资格", scoringFocus: "评分重点", text: "说明", detail: "详细依据", firstHackathon: "是否首次参赛", developmentExperience: "开发经历", skills: "已填写技能", projectIdea: "作品想法", purposes: "参赛目的", purposeNote: "目的补充", resume: "经历简述", estimatedMinutes: "预计用时（分钟）", availableMinutes: "可用时间（分钟）", responsibleUserId: "负责人记录", reviewerUserId: "检查人记录", dependsOn: "前置任务", check: "检查条件", content: "内容", fullContent: "已授权的详细说明",
};
const factEnums: Record<string, Record<string, string>> = {
  stage: { draft: "准备中", planning: "安排任务", building: "制作作品", submitted: "已记录提交", retrospective: "复盘", archived: "已归档" },
  status: { todo: "待开始", in_progress: "正在做", blocked: "遇到问题", review: "待检查", done: "检查通过", cancelled: "已取消", applied: "已生效", validated: "校验通过，待确认", needs_changes: "草案需要调整", discussion: "待团队讨论", adopted: "团队已采纳", active: "当前有效" },
  priority: { must: "必须完成", optional: "有余力再做" },
  duties: { product: "产品与方案", development: "开发实现", design: "视觉与交互", presentation: "路演讲解", testing: "测试检查", coordination: "协作统筹" },
  roles: { product: "产品与方案", frontend: "前端开发", backend: "后端开发", ai: "AI 实现", design: "视觉与交互", testing: "测试检查", presentation: "路演讲解", coordination: "协作统筹", other: "其他职责" },
  purposes: { award: "争取获奖", learn: "学习实践", meet: "认识伙伴", build: "完成作品", other: "其他目标" },
  developmentExperience: { none: "还未开发过项目", beginner: "刚开始学习", project: "做过一些项目", experienced: "有完整项目经验" },
  role: { manager: "空间管理员", member: "空间成员" },
  presentationExperience: { none: "尚无路演经验", some: "有一些展示经验", confident: "能够独立路演" },
};
function factText(value: unknown, depth = 0, field = ""): string {
  if (value === null || value === undefined || value === "") return "尚未提供";
  if (typeof value === "string" || typeof value === "number") return factEnums[field]?.[String(value)] ?? String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (depth >= 4) return "请从来源入口查看详细记录";
  if (Array.isArray(value)) return value.length ? value.slice(0, 20).map(item => `• ${factText(item, depth + 1, field)}`).join("\n") + (value.length > 20 ? `\n另有 ${value.length - 20} 项，请查看来源。` : "") : "尚未提供";
  if (typeof value === "object") return Object.entries(value).filter(([key]) => !/(?:^id$|Id$|Ids$|fingerprint$|revision$)/i.test(key)).slice(0, 20).map(([key, item]) => `${factLabels[key] ?? key}：${factText(item, depth + 1, key === "primaryRoles" || key === "supportingRoles" ? "roles" : key)}`).join("\n") || "请查看来源记录";
  return "尚未提供";
}
export function AssistantContextDetails({ context, coverage, purpose = "conversation" }: { context?: TeamAssistantContextSnapshot | null; coverage?: AssistantContextCoverage | null; purpose?: "conversation" | "feasibility" }) {
  return <details className={styles.context}>
    <summary>{coverage ? "本次回答的资料与记忆覆盖" : purpose === "feasibility" ? "预览本次检查依据" : "查看当前资料与记忆说明"}</summary>
    <div className={styles.contextBody}>
      {coverage ? <>
        <p>本次按问题选取 {coverage.memory.selectedCount} 条本人记忆；可保留范围内共有 {coverage.memory.retainedCount} 条。{coverage.memory.description}</p>
        <p className={styles.muted}>这里只说明本次读取的有界摘要。导航员完整记录仍在导航员中，本空间私人对话另行保存。</p>
        <p className={styles.muted}>本次资料读取于 {assistantDate(coverage.capturedAt)}</p>
        <AssistantSources sources={coverage.sources} />
        {coverage.missing.length > 0 && <div><strong>本次未提供</strong><ul>{coverage.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      </> : purpose === "feasibility" ? <>
        <p>检查会使用服务器提供的当前空间事实摘要；没有提供的规则、代码、接口验证与时间信息，会保留为缺项。</p>
        <p className={styles.muted}>这份检查保存为本人报告，只有主动分享的摘录才会交给队友。</p>
      </> : <>
        <p>发送时会按问题选择本人导航记录与个人记忆；尚未提供本次选择覆盖。其他空间来源仍需当前访问权限。</p>
        <p className={styles.muted}>私人对话只供本人使用；队友的助手只能读取主动分享且仍有效的内容。</p>
      </>}
      {context && <>
        <p className={styles.muted}>当前事实摘要 · 读取于 {assistantDate(context.capturedAt)}</p>
        <dl className={styles.facts}>{Object.entries(context.facts).map(([key, value]) => <div className={styles.fact} key={key}><dt>{factLabels[key] ?? key}</dt><dd>{factText(value, 0, key)}</dd></div>)}</dl>
        <AssistantSources sources={context.sources} />
        {context.missing.length > 0 && <div><strong>当前缺少的资料</strong><ul>{context.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      </>}
      {!context && !coverage && <p className={styles.muted}>当前事实尚未读取。{purpose === "feasibility" ? "请读取资料后再请求检查。" : "实际提问仍由服务器核对当前空间权限与资料。"}</p>}
    </div>
  </details>;
}
export function AssistantShareEditor({ selection, onShare, onClose }: { selection: AssistantShareSelection; onShare: (value: AssistantShareSelection) => void | Promise<void>; onClose: () => void }) {
  const id = useId();
  const [fragment, setFragment] = useState(selection.fragment.length <= 6000 ? selection.fragment : "");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function share() {
    if (!fragment.trim() || fragment.length > 6000) return;
    setBusy(true); setError("");
    try { await onShare({ ...selection, fragment: fragment.trim() }); onClose(); }
    catch { setError("分享尚未完成，摘录已保留，请核对团队动态后再试。"); }
    finally { setBusy(false); }
  }
  return <div className={styles.shareBox}>
    <label className={styles.label} htmlFor={id}>选择并编辑要交给队友的摘录</label>
    <p className={styles.muted}>确认后，所选摘录会发布到当前团队动态，队友和队友的助手可读取；私人完整对话仍不共享。</p>
    {selection.fragment.length > 6000 && <p className={styles.muted}>原回答较长，请粘贴需要分享的一段，最长 6000 字符。</p>}
    <textarea id={id} className={styles.textarea} value={fragment} onChange={event => { setFragment(event.target.value); setPreview(false); }} maxLength={6000} disabled={busy} />
    {preview && <div className={styles.sharePreview} aria-label="分享摘录预览">{fragment.trim()}</div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}>
      <button className={styles.button} type="button" onClick={() => setPreview(true)} disabled={busy || !fragment.trim()}>预览摘录</button>
      <button className={styles.primary} type="button" onClick={() => void share()} disabled={busy || !preview || !fragment.trim()}>{busy ? "正在分享…" : "确认分享给团队"}</button>
      <button className={styles.textButton} type="button" onClick={onClose} disabled={busy}>取消</button>
    </div>
  </div>;
}

/** Private per-account, per-space chat. Switching projects removes the previous private view immediately. */
export function TeamAssistantPanel(props: TeamAssistantPanelProps) { return <TeamAssistantSession key={`${props.accountKey ?? "session"}:${props.projectId}`} {...props} />; }
function TeamAssistantSession({ projectId, projectName, apiBase = `/api/projects/${encodeURIComponent(projectId)}`, request = assistantHttpRequest, initialConversation, initialContext, onShare, readOnly = false }: TeamAssistantPanelProps) {
  const headingId = useId(), inputId = useId(), helpId = useId();
  const [conversation, setConversation] = useState<AssistantConversation | null>(initialConversation?.projectId === projectId ? initialConversation : null);
  const [context, setContext] = useState<TeamAssistantContextSnapshot | null>(initialContext?.projectId === projectId ? initialContext : null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(initialConversation?.projectId !== projectId);
  const [busy, setBusy] = useState<"send" | "clear" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [contextError, setContextError] = useState("");
  const [status, setStatus] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [selection, setSelection] = useState<AssistantShareSelection | null>(null);
  const [uncertain, setUncertain] = useState<{ requestId: string; message: string } | null>(null);
  const mounted = useRef(true), activeMutation = useRef(false), activeRead = useRef(false);
  const refresh = useCallback(async (preserveError = false) => {
    if (activeRead.current) return;
    activeRead.current = true;
    if (mounted.current) setRefreshing(true);
    const results = await Promise.allSettled([
      request<AssistantConversation>(`${apiBase}/assistant/conversation`),
      request<TeamAssistantContextSnapshot>(`${apiBase}/assistant/context`),
    ]);
    if (mounted.current) {
      if (results.some(result => result.status === "rejected" && assistantAccessWasLost(result.reason))) {
        setConversation(null); setContext(null); setSelection(null); setConfirmClear(false);
        setError("登录状态或空间权限已变化，旧私人记录已收起。请重新登录或确认空间访问权限。"); setContextError("");
      } else {
      if (results[0].status === "fulfilled" && results[0].value.projectId === projectId) {
        const value = results[0].value;
        setConversation(previous => previous && previous.revision > value.revision ? previous : value);
        if (value.pending?.status === "succeeded" || value.pending?.status === "failed") setUncertain(previous => previous && previous.requestId === value.pending?.requestId ? null : previous);
        if (!preserveError) setError("");
      } else setError(results[0].status === "rejected" ? `${assistantErrorText(results[0].reason)} 已显示的记录来自上次读取，可能较旧。` : "当前对话不属于此空间，请重新读取。");
      if (results[1].status === "fulfilled" && results[1].value.projectId === projectId) { setContext(results[1].value); setContextError(""); }
      else setContextError("当前资料预览未能读取，已显示的资料可能较旧。提问时会重新核对。");
      }
      setLoading(false); setRefreshing(false);
    }
    activeRead.current = false;
  }, [apiBase, projectId, request]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => {
    if (conversation?.pending?.status !== "running") return;
    const timer = window.setInterval(() => { if (!document.hidden && !activeMutation.current) void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [conversation?.pending?.status, refresh]);
  const pending = conversation?.pending;
  const repeatsUnknown = (uncertain !== null && draft.trim() === uncertain.message.trim()) || (pending?.status === "unknown" && draft.trim() === pending.message.trim());
  const bytes = assistantByteLength(draft.trim());
  const canSend = Boolean(conversation?.configured) && !readOnly && !busy && pending?.status !== "running" && !repeatsUnknown && bytes > 0 && bytes <= 6000;
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || !conversation || activeMutation.current) return;
    const message = draft.trim(), requestId = requestIdentifier();
    activeMutation.current = true; setBusy("send"); setError(""); setStatus("DSH 正在读取当前任务与相关记忆…");
    try {
      const reply = await request<AssistantReply>(`${apiBase}/assistant/messages`, { method: "POST", body: { message, requestId, expectedRevision: conversation.revision } });
      if (!mounted.current) return;
      setUncertain(null);
      setConversation(previous => previous && previous.revision > reply.revision ? previous : previous ? { ...previous, revision: reply.revision, messages: previous.messages.some(item => item.id === reply.message.id) ? previous.messages : [...previous.messages, reply.message], pending: { requestId, message, status: "succeeded", errorCode: null, createdAt: reply.message.createdAt } } : previous);
      setDraft(previous => previous.trim() === message ? "" : previous);
      setStatus("DSH 回答已保存为本空间私人记录。");
    } catch (cause) {
      if (!mounted.current) return;
      if (assistantAccessWasLost(cause)) { setConversation(null); setContext(null); setSelection(null); }
      if (assistantResultIsUncertain(cause)) setUncertain({ requestId, message });
      setError(assistantErrorText(cause)); setStatus("正在核对本次请求的已保存状态，不会自动重发。");
    } finally {
      activeMutation.current = false;
      if (mounted.current) { setBusy(null); await refresh(true); }
    }
  }
  async function clear() {
    if (!conversation || activeMutation.current || readOnly) return;
    activeMutation.current = true; setBusy("clear"); setError("");
    try {
      await request<{ cleared: true; revision: number }>(`${apiBase}/assistant/conversation`, { method: "DELETE", body: { expectedRevision: conversation.revision } });
      if (mounted.current) { setConfirmClear(false); setSelection(null); setStatus("本空间私人对话已清空。导航员记录、个人记忆与已分享内容仍可在原入口管理。"); }
    } catch (cause) { if (mounted.current) { if (assistantAccessWasLost(cause)) { setConversation(null); setContext(null); setSelection(null); } setError(assistantErrorText(cause)); } }
    finally { activeMutation.current = false; if (mounted.current) { setBusy(null); await refresh(true); } }
  }
  function shareMessage(message: AssistantMessage) {
    const selected = window.getSelection()?.toString().trim();
    setSelection({ sourceKind: "space_assistant", sourceId: message.id, fragment: selected && message.content.includes(selected) ? selected : message.content });
  }
  return <section className={styles.panel} aria-labelledby={headingId}>
    <header className={styles.header}>
      <div className={styles.intro}><p className={styles.eyebrow}>本人专用 · DSH</p><h2 id={headingId}>我的空间助手</h2><p className={styles.muted}>{projectName ? `围绕「${projectName}」的` : "围绕当前作品的"}职责、本人任务、队友交接和工具使用给出下一步。</p></div>
      <div className={styles.actions}><button className={styles.button} type="button" onClick={() => void refresh()} disabled={refreshing || Boolean(busy)}>{refreshing ? "正在核对…" : "核对保存状态"}</button><button className={styles.textButton} type="button" onClick={() => setConfirmClear(true)} disabled={!conversation || Boolean(busy) || readOnly || pending?.status === "running"}>清空本空间对话</button></div>
    </header>
    {loading && <p className={styles.empty} role="status">正在读取本人的空间对话…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {contextError && <p className={styles.notice}>{contextError}</p>}
    {conversation && !conversation.configured && <p className={styles.notice}>空间助手尚未连接 DSH。可以查看已保存记录；当前无法生成新回答。</p>}
    {readOnly && <p className={styles.notice}>当前空间只可查看，暂时不能提问或清空记录。</p>}
    {(pending?.status === "unknown" || uncertain) && <p className={styles.notice}>上一次请求结果尚未核清。请先核对保存状态，需要时请管理员核查；同一问题不会自动重发。可以明确提出不同的新问题。</p>}
    {pending?.status === "running" && <p className={styles.notice} role="status">本次请求正在执行，页面会读取已保存状态；请保留输入并等待结果。</p>}
    {pending?.status === "failed" && <p className={styles.notice}>上次请求未生成可用回答。你可以核对资料后明确发送新问题。</p>}
    {confirmClear && <div className={styles.confirmation}><p>清空本人在此空间的对话记录？导航员记录、个人记忆及已主动分享的内容分别在原入口管理。未知模型请求仍需核查。</p><div className={styles.actions}><button className={styles.danger} type="button" onClick={() => void clear()} disabled={Boolean(busy)}>{busy === "clear" ? "正在清空…" : "确认清空此空间对话"}</button><button className={styles.button} type="button" onClick={() => setConfirmClear(false)} disabled={Boolean(busy)}>保留对话</button></div></div>}
    <AssistantContextDetails context={context} />
    {conversation?.messages.length === 0 && <div className={styles.empty}><p>从你现在要交出的成果开始问。</p><p className={styles.muted}>例如：我今天先做哪件事？等队友接口时还能准备什么？怎样检查这份成果？</p></div>}
    {conversation && conversation.messages.length > 0 && <p className={styles.muted}>展示最近 100 条私人记录；完整历史由服务器保留，本次模型只读取有界相关记录。</p>}
    <div className={styles.messages} aria-label="本人的空间对话记录">{conversation?.messages.map(message => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
      <div className={styles.messageMeta}><strong>{message.role === "user" ? "我" : "空间助手 · DSH"}</strong><time dateTime={message.createdAt}>{assistantDate(message.createdAt)}</time></div>
      <p className={styles.messageContent}>{message.content}</p>
      {message.links.length > 0 && <div className={styles.links}>{message.links.filter(link => safeHref(link.href)).map(link => <a key={link.id} href={safeHref(link.href)}>{link.label}</a>)}</div>}
      {message.role === "assistant" && <><AssistantContextDetails coverage={message.coverage} />{onShare && !readOnly && <button className={styles.textButton} type="button" onClick={() => shareMessage(message)}>选择片段分享给队友</button>}</>}
      {selection?.sourceId === message.id && onShare && <AssistantShareEditor key={message.id} selection={selection} onShare={onShare} onClose={() => setSelection(null)} />}
    </article>)}</div>
    <form className={styles.form} onSubmit={event => void send(event)}>
      <label className={styles.label} htmlFor={inputId}>现在需要什么帮助？</label>
      <textarea id={inputId} className={styles.textarea} value={draft} onChange={event => setDraft(event.target.value)} aria-describedby={helpId} placeholder="例如：根据我的职责和当前任务，今天先交什么，怎样检查？" disabled={readOnly} />
      <div className={styles.formFooter}><p id={helpId} className={styles.muted}>{bytes > 6000 ? "问题过长，请缩短到 6000 字节以内。" : repeatsUnknown ? "这与尚未核清的问题相同，请先核对原请求或提出不同的新问题。" : "点击后明确请求 DSH；建议需由你核对，分享需另行确认。"}</p><button className={styles.primary} type="submit" disabled={!canSend}>{busy === "send" ? "正在请求 DSH…" : "问空间助手"}</button></div>
    </form>
    <p className={styles.status} role="status" aria-live="polite">{status}</p>
  </section>;
}
