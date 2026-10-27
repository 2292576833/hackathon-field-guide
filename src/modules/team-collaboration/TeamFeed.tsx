"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, api, dateText, message, operationKey, safeLink } from "../../components/client-api.ts";
import { ShareSuggestionPreview } from "./ShareSuggestionPreview.tsx";
import type { EditSuggestionCommand, SuggestionActionCommand, SuggestionReceipt, TaskActivity, TeamFeedItem, TeamFeedSnapshot, TeamSuggestionView } from "./types.ts";
import styles from "./collaboration.module.css";

export interface TeamFeedProps {
  projectId: string;
  currentUserId: string;
  authorLabels?: Record<string, string>;
  reloadToken?: number;
}
interface Editor { id: string; expectedRevision: number; title: string; body: string }
type Action = "edit" | "withdraw" | "adopt";
interface PendingOperation { id: string; ownerUserId: string; action: Action; path: string; method: "PATCH" | "POST"; command: EditSuggestionCommand | SuggestionActionCommand }
type Filter = "all" | "tasks" | "discussion" | "adopted";

const taskLabels: Record<TaskActivity["status"], string> = {
  todo: "待开始", in_progress: "正在做", blocked: "遇到问题", review: "待检查", done: "检查通过", cancelled: "已取消",
};
function accessLost(reason: unknown) { return reason instanceof ApiError && [401, 403, 404].includes(reason.status); }
function outcomeUnknown(reason: unknown) {
  return !(reason instanceof ApiError) || reason.status >= 500 || reason.code === "INVALID_RESPONSE" || /UNKNOWN|UNCERTAIN|TIMEOUT|IN_PROGRESS/.test(reason.code);
}
function suggestionById(snapshot: TeamFeedSnapshot | null, id: string): TeamSuggestionView | undefined {
  const item = snapshot?.items.find(value => value.kind === "suggestion" && value.id === id);
  return item?.kind === "suggestion" ? item.suggestion : undefined;
}

/** M05 activities and explicit shares are one timeline, with no local task writes. */
export function TeamFeed(props: TeamFeedProps) {
  return <TeamFeedPanel key={`${props.projectId}:${props.currentUserId}`} {...props}/>;
}

function TeamFeedPanel({ projectId, currentUserId, authorLabels = {}, reloadToken = 0 }: TeamFeedProps) {
  const headingId = useId(), editTitleId = useId(), editBodyId = useId();
  const panel = useRef<HTMLElement | null>(null), mounted = useRef(true), epoch = useRef(0), readGeneration = useRef(0);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null), writeLock = useRef(false);
  const [snapshot, setSnapshot] = useState<TeamFeedSnapshot | null>(null);
  const [loading, setLoading] = useState(true), [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(true), [denied, setDenied] = useState(false), [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null), [casConflictId, setCasConflictId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: "withdraw" | "adopt"; expectedRevision: number } | null>(null);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const snapshotRef = useRef<TeamFeedSnapshot | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}/team-feed`;

  const clearPrivate = useCallback((explanation: string) => {
    epoch.current++; readGeneration.current++; readController.current?.abort(); writeController.current?.abort();
    snapshotRef.current = null; setSnapshot(null); setEditor(null); setConfirm(null); setPending(null); setCasConflictId(null);
    setDenied(true); setLoading(false); setReading(false); setBusy(false); setNotice(""); setError(explanation);
    window.dispatchEvent(new CustomEvent("hackathon:team-feed-access-lost", { detail: { projectId } }));
  }, [projectId]);

  const reload = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    const current = epoch.current, generation = ++readGeneration.current;
    setReading(true);
    try {
      const next = await api<TeamFeedSnapshot>(base, { signal: controller.signal });
      if (!mounted.current || current !== epoch.current || generation !== readGeneration.current || controller.signal.aborted) return;
      if (next.projectId !== projectId) { clearPrivate("空间信息已变化，请重新打开当前空间。"); return; }
      snapshotRef.current = next; setSnapshot(next); setDenied(false); setError("");
      setEditor(previous => previous && !suggestionById(next, previous.id)?.canEdit ? null : previous);
      setConfirm(previous => {
        if (!previous) return null;
        const item = next.items.find(value => value.kind !== "task" && value.id === previous.id);
        if (item?.kind === "unavailable") return previous.action === "withdraw" && item.canWithdraw ? previous : null;
        if (item?.kind !== "suggestion") return null;
        return (previous.action === "adopt" ? item.suggestion.canAdopt : item.suggestion.canWithdraw) ? previous : null;
      });
      // A source tombstone closes the editor above. Keep an unknown request's
      // exact payload privately for metadata-only receipt recovery; it is never
      // rendered as a suggestion or sent to AI. Lost access clears it entirely.
    } catch (reason) {
      if (!mounted.current || current !== epoch.current || generation !== readGeneration.current || controller.signal.aborted) return;
      if (accessLost(reason)) clearPrivate(message(reason));
      else setError(`${message(reason)}${snapshotRef.current ? " 上次读取的动态仍在，内容可能已变化。" : ""}`);
    } finally {
      if (mounted.current && current === epoch.current && generation === readGeneration.current) { setReading(false); setLoading(false); }
    }
  }, [base, projectId, clearPrivate]);

  useEffect(() => {
    mounted.current = true;
    const expired = () => clearPrivate("登录已失效，团队正文和编辑输入已清除。请重新登录后打开空间。");
    window.addEventListener("hackathon:unauthenticated", expired);
    return () => {
      mounted.current = false; epoch.current++; readGeneration.current++; readController.current?.abort(); writeController.current?.abort();
      window.removeEventListener("hackathon:unauthenticated", expired);
    };
  }, [clearPrivate]);

  useEffect(() => {
    let inViewport = true;
    const update = () => setVisible(inViewport && document.visibilityState !== "hidden");
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      inViewport = entries[0]?.isIntersecting ?? false; update();
    });
    if (panel.current) observer?.observe(panel.current);
    document.addEventListener("visibilitychange", update); update();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => {
    if (!visible || denied) { readController.current?.abort(); return; }
    void reload();
    const timer = window.setInterval(() => { if (!writeLock.current) void reload(); }, 10_000);
    return () => { window.clearInterval(timer); readController.current?.abort(); };
  }, [visible, denied, reload, reloadToken]);

  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ projectId: string }>).detail?.projectId === projectId && visible && !denied) void reload();
    };
    window.addEventListener("hackathon:team-feed-changed", changed);
    return () => window.removeEventListener("hackathon:team-feed-changed", changed);
  }, [projectId, visible, denied, reload]);

  const label = (userId: string) => {
    if (userId === currentUserId) return "我";
    const name = authorLabels[userId]?.trim();
    return name && !name.includes("@") ? name.slice(0, 80) : "队友";
  };
  const items = useMemo(() => snapshot?.items.filter(item => {
    if (filter === "tasks") return item.kind === "task";
    if (filter === "discussion" || filter === "adopted") return item.kind === "suggestion" && item.suggestion.status === filter;
    return true;
  }) ?? [], [snapshot, filter]);
  const currentEdit = editor ? suggestionById(snapshot, editor.id) : undefined;
  const conflict = Boolean(editor && (currentEdit?.revision !== editor.expectedRevision || casConflictId === editor.id));

  async function mutate(request: PendingOperation) {
    if (writeLock.current || !snapshotRef.current || snapshotRef.current.readOnly || denied) return;
    const item = snapshotRef.current.items.find(value => value.kind !== "task" && value.id === request.id);
    const recovering = pending?.command.idempotencyKey === request.command.idempotencyKey;
    const permitted = recovering
      ? request.action === "adopt" ? snapshotRef.current.role === "manager" : request.ownerUserId === currentUserId
      : item?.kind === "unavailable" ? request.action === "withdraw" && item.canWithdraw
      : item?.kind === "suggestion" && (request.action === "edit" ? item.suggestion.canEdit : request.action === "withdraw" ? item.suggestion.canWithdraw : item.suggestion.canAdopt);
    if (!permitted) return;
    writeLock.current = true; setBusy(true); setError(""); setNotice(""); setPending(request);
    readController.current?.abort(); readGeneration.current++;
    const current = epoch.current, controller = new AbortController(); writeController.current = controller;
    try {
      const result = await api<SuggestionReceipt>(request.path, { method: request.method, body: request.command, idempotencyKey: request.command.idempotencyKey, signal: controller.signal });
      if (!mounted.current || current !== epoch.current) return;
      setPending(null); setConfirm(null); setEditor(null); setCasConflictId(null);
      const resultLabel = result.status === "withdrawn" ? "已撤回" : result.status === "adopted" ? "已采纳决定" : "待讨论";
      setNotice(`服务器已确认这次操作，当前记录为“${resultLabel}”。${result.replayed ? "已恢复同一次操作的回执。" : ""}`);
      if (result.status === "withdrawn") {
        const prior = snapshotRef.current;
        if (prior) {
          // Hide the body immediately. The next read supplies the withdrawal's
          // real timestamp; a metadata-only receipt must not invent that time.
          const next = { ...prior, items: prior.items.filter(item => item.kind === "task" || item.id !== result.id) };
          snapshotRef.current = next; setSnapshot(next);
        }
      }
      await reload();
    } catch (reason) {
      if (!mounted.current || current !== epoch.current) return;
      if (accessLost(reason)) clearPrivate(message(reason));
      else if (outcomeUnknown(reason)) setError("尚未收到这次操作的确定结果。输入和操作标识已保留，请核对这次操作，避免重复修改。");
      else {
        setPending(null);
        if (reason instanceof ApiError && reason.code === "VERSION_CONFLICT") { setCasConflictId(request.id); await reload(); }
        if (reason instanceof ApiError && ["SHARE_SOURCE_UNAVAILABLE", "SUGGESTION_WITHDRAWN", "PROJECT_READ_ONLY"].includes(reason.code)) await reload();
        if (mounted.current && current === epoch.current) setError(`${message(reason)}${reason instanceof ApiError && reason.code === "SHARE_SOURCE_UNAVAILABLE" ? " 旧来源正文已屏蔽。" : " 输入已保留。"}`);
      }
    } finally {
      writeLock.current = false;
      if (mounted.current && current === epoch.current) setBusy(false);
    }
  }

  function action(suggestion: { id: string; authorUserId: string; revision: number }, kind: "withdraw" | "adopt", expectedRevision = suggestion.revision) {
    void mutate({ id: suggestion.id, ownerUserId: suggestion.authorUserId, action: kind, path: `${base}/${encodeURIComponent(suggestion.id)}/${kind}`, method: "POST",
      command: { expectedRevision, idempotencyKey: operationKey() } });
  }
  function saveEdit() {
    if (!editor || conflict || !editor.title.trim() || !editor.body.trim()) return;
    void mutate({ id: editor.id, ownerUserId: currentUserId, action: "edit", path: `${base}/${encodeURIComponent(editor.id)}`, method: "PATCH",
      command: { expectedRevision: editor.expectedRevision, title: editor.title.trim(), body: editor.body.trim(), idempotencyKey: operationKey() } });
  }

  function renderItem(item: TeamFeedItem) {
    if (item.kind === "unavailable") return <li key={`unavailable:${item.id}`} className={styles.unavailable}>
      <p><strong>{label(item.authorUserId)}</strong> 的建议{item.status === "withdrawn" ? "已撤回" : "来源已变化或当前不可用"}</p>
      <p className={styles.hint}>正文不再显示，也不再作为团队 AI 上下文。<time dateTime={item.occurredAt}>{dateText(item.occurredAt)}</time></p>
      {item.canWithdraw && <button type="button" className={styles.textButton} disabled={busy || pending !== null} onClick={() => { setConfirm({ id: item.id, action: "withdraw", expectedRevision: item.revision }); setEditor(null); setError(""); }}>撤回本人分享记录</button>}
      {confirm?.id === item.id && confirm.action === "withdraw" && <div className={styles.confirmation}>
        <p>正文已屏蔽。确认撤回这条本人分享记录？</p>
        {item.revision !== confirm.expectedRevision && <p className={styles.warning}>记录版本已变化，请重新核对当前记录。</p>}
        <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || pending !== null || item.revision !== confirm.expectedRevision} onClick={() => action(item, "withdraw", confirm.expectedRevision)}>确认撤回记录</button>
          {item.revision !== confirm.expectedRevision && <button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => setConfirm({ ...confirm, expectedRevision: item.revision })}>使用当前记录版本</button>}
          <button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => setConfirm(null)}>返回</button></div>
      </div>}
    </li>;
    if (item.kind === "task") {
      const checked = item.status === "done" && item.checked;
      const status = item.status === "done" && !item.checked ? "review" : item.status;
      return <li key={`task:${item.id}`} className={`${styles.card} ${checked ? styles.checkedCard : ""}`}>
        <div className={styles.cardHeading}><span className={`${styles.badge} ${checked ? styles.checkedBadge : ""}`}>任务 · {taskLabels[status]}</span><span className={styles.hint}>{label(item.actorUserId)}</span></div>
        <h3 className={styles.cardTitle}>{item.title}</h3>{item.note && <p className={styles.body}>{item.note}</p>}
        {status === "review" && <p className={styles.hint}>成果已报告完成，仍在等待实际检查。</p>}
        <div className={styles.cardFooter}><time dateTime={item.occurredAt}>{dateText(item.occurredAt)}</time><a className={styles.textLink} href="#team-task-board">查看团队任务</a></div>
        {item.evidenceRefs.length > 0 && <details className={styles.details}><summary>查看交付依据（{item.evidenceRefs.length}）</summary><ul className={styles.evidenceList}>{item.evidenceRefs.map((value, index) => {
          const href = safeLink(value);
          return <li key={`${value}:${index}`}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{value}（新窗口）</a> : <span>{value}</span>}</li>;
        })}</ul></details>}
      </li>;
    }
    const value = item.suggestion, editing = editor?.id === value.id, confirming = confirm?.id === value.id;
    return <li key={`suggestion:${item.id}`} className={styles.card}>
      <div className={styles.cardHeading}><span className={`${styles.badge} ${value.status === "adopted" ? styles.adoptedBadge : ""}`}>{value.status === "adopted" ? "已采纳决定" : "待讨论建议"}</span><span className={styles.hint}>{label(value.authorUserId)} 分享</span></div>
      <h3 className={styles.cardTitle}>{value.title}</h3><p className={styles.body}>{value.body}</p>
      <p className={styles.hint}>来源：{value.source.label} · 版本 {value.revision}{value.updatedAt !== value.createdAt ? " · 已修订" : ""}</p>
      {value.status === "adopted" && <p className={styles.decisionNote}>{value.adoptedByUserId ? `${label(value.adoptedByUserId)}已明确采纳。` : "管理员已明确采纳。"}任务、目标和计划需要在对应入口另行确认。</p>}
      <div className={styles.cardFooter}><time dateTime={value.updatedAt}>{dateText(value.updatedAt)}</time>
        <div className={styles.actions}>
          {value.canEdit && <button type="button" className={styles.textButton} disabled={busy || pending !== null} onClick={() => { setEditor({ id: value.id, expectedRevision: value.revision, title: value.title, body: value.body }); setConfirm(null); setCasConflictId(null); setError(""); }}>编辑本人建议</button>}
          {value.canWithdraw && <button type="button" className={styles.textButton} disabled={busy || pending !== null} onClick={() => { setConfirm({ id: value.id, action: "withdraw", expectedRevision: value.revision }); setEditor(null); setError(""); }}>撤回</button>}
          {value.canAdopt && <button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => { setConfirm({ id: value.id, action: "adopt", expectedRevision: value.revision }); setEditor(null); setError(""); }}>采纳为团队决定</button>}
        </div>
      </div>
      {editing && editor && <form className={styles.editor} onSubmit={event => { event.preventDefault(); saveEdit(); }}>
        <label htmlFor={editTitleId}>修改标题</label><input id={editTitleId} value={editor.title} maxLength={120} disabled={busy || pending !== null} onChange={event => setEditor({ ...editor, title: event.target.value })}/>
        <label htmlFor={editBodyId}>修改共享正文</label><textarea id={editBodyId} value={editor.body} maxLength={6000} rows={6} disabled={busy || pending !== null} onChange={event => setEditor({ ...editor, body: event.target.value })}/>
        <p className={styles.hint}>{editor.body.length}/6000 字{value.status === "adopted" ? " · 修改后重新进入待讨论，需管理员再次明确采纳。" : ""}</p>
        {conflict && <div className={styles.warning} role="alert"><p>记录版本已变化。上方是最新共享内容，下方修改已保留；请核对后再保存。</p><button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => { setEditor({ ...editor, expectedRevision: value.revision }); setCasConflictId(null); setError(""); }}>我已核对，使用当前版本继续编辑</button></div>}
        <div className={styles.actions}><button className={styles.button} disabled={busy || pending !== null || conflict || !editor.title.trim() || !editor.body.trim()}>保存修订</button><button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => setEditor(null)}>放弃本地修改</button></div>
      </form>}
      {confirming && confirm && <div className={styles.confirmation}>
        <p>{confirm.action === "withdraw" ? "撤回后团队动态隐藏这条正文，后续团队 AI 不再读取它。" : "确认将当前版本标记为团队采纳决定？这不会自动修改目标、任务或生效计划。"}</p>
        {value.revision !== confirm.expectedRevision && <div className={styles.warning}><p>建议版本已变化。请核对上方的最新正文，再明确操作当前版本。</p><button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => setConfirm({ ...confirm, expectedRevision: value.revision })}>我已核对当前版本</button></div>}
        <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || pending !== null || value.revision !== confirm.expectedRevision} onClick={() => action(value, confirm.action, confirm.expectedRevision)}>{confirm.action === "withdraw" ? "确认撤回本人建议" : "确认采纳当前版本"}</button><button type="button" className={styles.secondaryButton} disabled={busy || pending !== null} onClick={() => setConfirm(null)}>返回</button></div>
      </div>}
    </li>;
  }

  return <section id="team-feed" ref={panel} className={styles.feed} aria-labelledby={headingId} aria-busy={loading || busy}>
    <div className={styles.panelHeading}><div><h2 id={headingId}>团队动态</h2><p className={styles.muted}>看成果、交接和团队决定；自由聊天继续用队伍已有的沟通群。</p></div><button type="button" className={styles.secondaryButton} disabled={reading || busy} onClick={() => { if (denied) { setDenied(false); setLoading(true); } else void reload(); }}>{reading ? "正在读取…" : "刷新动态"}</button></div>
    {snapshot && <p className={styles.readStatus}>最近读取：<time dateTime={snapshot.checkedAt}>{dateText(snapshot.checkedAt)}</time> · {visible ? "可见时每 10 秒更新" : "已暂停后台读取"}{snapshot.readOnly ? " · 空间当前只读" : ""}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {pending && <div className={styles.warning}><p>这次操作还在等待确定结果。核对时会使用原来的内容、版本和操作标识。</p><button type="button" className={styles.button} disabled={busy || snapshot?.readOnly || denied} onClick={() => void mutate(pending)}>{busy ? "正在核对…" : "核对这次操作"}</button></div>}
    {loading && <p className={styles.muted} role="status">正在读取已保存的团队动态…</p>}
    {snapshot && <>
      <div className={styles.filters} role="group" aria-label="筛选团队动态">{([ ["all", "全部动态"], ["tasks", "任务成果"], ["discussion", "待讨论建议"], ["adopted", "已采纳决定"] ] as const).map(([value, text]) => <button type="button" key={value} className={filter === value ? styles.selectedFilter : styles.filterButton} aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>)}</div>
      {!snapshot.readOnly && <div className={styles.composer}><ShareSuggestionPreview projectId={projectId} sourceKind="manual" sourceId={null} initialBody=""/></div>}
      {items.length === 0 ? <p className={styles.empty}>{filter === "all" ? "还没有团队动态。提交任务成果，或明确分享一条建议后，会在这里留下记录。" : "当前筛选下没有动态。"}</p> : <ul className={styles.feedList}>{items.map(renderItem)}</ul>}
    </>}
  </section>;
}
