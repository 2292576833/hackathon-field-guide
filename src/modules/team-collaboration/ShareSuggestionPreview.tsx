"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, api, message, operationKey } from "../../components/client-api.ts";
import type { PublishSuggestionCommand, ShareSourceKind, SuggestionReceipt, TeamFeedSnapshot } from "./types.ts";
import styles from "./collaboration.module.css";

export interface ShareSuggestionPreviewProps {
  projectId: string;
  sourceKind: ShareSourceKind;
  sourceId: string | null;
  initialTitle?: string;
  initialBody: string;
  onShared?: (receipt: SuggestionReceipt) => void;
}

const sourceNames: Record<ShareSourceKind, string> = {
  navigator: "导航员回答", space_assistant: "空间助手回答", feasibility: "选题检查报告", manual: "成员备注",
};

function accessLost(reason: unknown) { return reason instanceof ApiError && [401, 403, 404].includes(reason.status); }
function outcomeUnknown(reason: unknown) {
  return !(reason instanceof ApiError) || reason.status >= 500 || reason.code === "INVALID_RESPONSE" || /UNKNOWN|UNCERTAIN|TIMEOUT|IN_PROGRESS/.test(reason.code);
}

/** The caller supplies a saved source ID; only the server can validate its ownership. */
export function ShareSuggestionPreview(props: ShareSuggestionPreviewProps) {
  return <ShareEditor key={`${props.projectId}:${props.sourceKind}:${props.sourceId ?? "manual"}`} {...props}/>;
}

function ShareEditor({ projectId, sourceKind, sourceId, initialTitle, initialBody, onShared }: ShareSuggestionPreviewProps) {
  const headingId = useId(), titleId = useId(), bodyId = useId(), selectionId = useId(), scopeId = useId();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"select" | "edit" | "preview" | "shared">("select");
  const [sourceText, setSourceText] = useState(initialBody);
  const [title, setTitle] = useState(initialTitle ?? (sourceKind === "manual" ? "成员备注" : "想和队友讨论的建议"));
  const [body, setBody] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [access, setAccess] = useState<"checking" | "write" | "readonly" | "unknown" | "denied">("checking");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PublishSuggestionCommand | null>(null);
  const [receipt, setReceipt] = useState<SuggestionReceipt | null>(null);
  const mounted = useRef(true), epoch = useRef(0), readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null), writeLock = useRef(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}/team-feed`;
  const missingSource = sourceKind !== "manual" && !sourceId;

  const clearPrivate = useCallback((explanation: string) => {
    epoch.current++; readController.current?.abort(); writeController.current?.abort();
    setSourceText(""); setTitle(""); setBody(""); setSelection({ start: 0, end: 0 });
    setPending(null); setReceipt(null); setNotice(""); setBusy(false); setAccess("denied"); setError(explanation);
  }, []);

  const checkAccess = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    const current = epoch.current;
    try {
      const snapshot = await api<TeamFeedSnapshot>(`${base}?limit=1`, { signal: controller.signal });
      if (!mounted.current || current !== epoch.current || controller.signal.aborted) return;
      if (snapshot.projectId !== projectId) { clearPrivate("空间信息已变化，请重新打开分享预览。"); return; }
      setAccess(snapshot.readOnly ? "readonly" : "write");
    } catch (reason) {
      if (!mounted.current || current !== epoch.current || controller.signal.aborted) return;
      if (accessLost(reason)) clearPrivate(message(reason));
      else { setAccess("unknown"); setError(`暂时无法核对团队权限。${message(reason)} 输入已保留。`); }
    }
  }, [base, projectId, clearPrivate]);

  useEffect(() => {
    mounted.current = true;
    const expired = () => clearPrivate("登录已失效。预览内容已清除，请重新登录后打开原回答。");
    const lost = (event: Event) => {
      if ((event as CustomEvent<{ projectId: string }>).detail?.projectId === projectId) clearPrivate("当前账号已无法查看这个空间，预览内容已清除。");
    };
    window.addEventListener("hackathon:unauthenticated", expired);
    window.addEventListener("hackathon:team-feed-access-lost", lost);
    return () => {
      mounted.current = false; epoch.current++; readController.current?.abort(); writeController.current?.abort();
      window.removeEventListener("hackathon:unauthenticated", expired);
      window.removeEventListener("hackathon:team-feed-access-lost", lost);
    };
  }, [clearPrivate, projectId]);

  useEffect(() => {
    if (!open || access === "denied" || step === "shared") return;
    void checkAccess();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void checkAccess(); }, 10_000);
    const visible = () => { if (document.visibilityState === "hidden") readController.current?.abort(); else void checkAccess(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); readController.current?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [open, access === "denied", step === "shared", checkAccess]);

  function choose(fragment: string) {
    if (!fragment.trim()) { setError("请先选择要分享的文字。"); return; }
    if (fragment.length > 6000) { setError("一次最多分享 6000 字，请选择更短的片段。"); return; }
    setBody(fragment.trim()); setStep("edit"); setError("");
  }

  function preview() {
    if (!title.trim() || title.length > 120 || !body.trim() || body.length > 6000) {
      setError("请填写标题和正文：标题最多 120 字，正文最多 6000 字。"); return;
    }
    setError(""); setStep("preview");
    window.requestAnimationFrame(() => heading.current?.focus());
  }

  async function publish(command?: PublishSuggestionCommand) {
    if (writeLock.current || access !== "write" || missingSource) return;
    // Recovery always reuses the exact payload and key, even when its outcome is unknown.
    const request = command ?? pending ?? {
      sourceKind, sourceId: sourceKind === "manual" ? null : sourceId,
      title: title.trim(), body: body.trim(), idempotencyKey: operationKey(),
    };
    writeLock.current = true; setBusy(true); setError(""); setNotice(""); setPending(request);
    const current = epoch.current, controller = new AbortController(); writeController.current = controller;
    try {
      const result = await api<SuggestionReceipt>(base, { method: "POST", body: request, idempotencyKey: request.idempotencyKey, signal: controller.signal });
      if (!mounted.current || current !== epoch.current) return;
      setReceipt(result); setPending(null); setTitle(""); setBody(""); setSourceText(""); setSelection({ start: 0, end: 0 }); setStep("shared");
      setNotice(result.status === "withdrawn" ? "已找到这次分享的回执；该记录目前已撤回。" : "服务器已确认分享。团队动态会显示当前保存版本。");
      window.dispatchEvent(new CustomEvent("hackathon:team-feed-changed", { detail: { projectId } }));
      try { onShared?.(result); } catch { /* An external refresh callback must not turn a confirmed write into an unknown result. */ }
    } catch (reason) {
      if (!mounted.current || current !== epoch.current) return;
      if (accessLost(reason)) clearPrivate(message(reason));
      else if (outcomeUnknown(reason)) setError("尚未收到这次分享的确定结果，内容和操作标识已保留。请点“核对这次分享”，避免重复创建记录。");
      else {
        setPending(null);
        setError(`${message(reason)} 输入已保留。`);
        if (reason instanceof ApiError && reason.code === "PROJECT_READ_ONLY") setAccess("readonly");
      }
    } finally {
      writeLock.current = false;
      if (mounted.current && current === epoch.current) setBusy(false);
    }
  }

  if (!open) return <button type="button" className={styles.secondaryButton} onClick={() => {
    if (step === "shared" && access !== "denied") {
      setSourceText(initialBody); setTitle(initialTitle ?? (sourceKind === "manual" ? "成员备注" : "想和队友讨论的建议"));
      setBody(sourceKind === "manual" ? initialBody : ""); setReceipt(null); setNotice(""); setSelection({ start: 0, end: 0 });
    } else if (sourceKind === "manual") setBody(sourceText);
    if (access !== "denied") setAccess("checking");
    setOpen(true); setStep(sourceKind === "manual" ? "edit" : "select");
  }}>{sourceKind === "manual" ? "写一条团队建议" : "选择内容发到团队动态"}</button>;

  const locked = busy || pending !== null || access === "denied";
  return <section className={styles.sharePanel} aria-labelledby={headingId} aria-describedby={scopeId} aria-busy={busy}>
    <div className={styles.panelHeading}><h3 id={headingId} ref={heading} tabIndex={-1}>{step === "preview" ? "确认发给团队的内容" : step === "shared" ? "分享回执" : "分享前先选择和编辑"}</h3>
      <button type="button" className={styles.textButton} disabled={busy || pending !== null} onClick={() => setOpen(false)}>收起</button></div>
    <p id={scopeId} className={styles.scope}>只有下面选定并确认发送的正文会进入当前团队动态；私人原对话保持私密。分享和采纳都不会自动修改目标、任务或计划。</p>
    {sourceKind !== "manual" && <p className={styles.muted}>来源类型：{sourceNames[sourceKind]} · 分享时由服务器核对本人保存的真实来源。</p>}
    {missingSource && <p className={styles.warning} role="alert">这段回答还没有可核对的保存标识。请先等待回答或报告保存，再从原记录打开分享。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {access === "checking" && <p className={styles.muted} role="status">正在核对当前团队权限…</p>}
    {access === "readonly" && <p className={styles.warning}>空间当前只读，预览已保留；恢复可写后再分享。</p>}
    {access === "unknown" && <button type="button" className={styles.secondaryButton} onClick={() => void checkAccess()} disabled={busy}>重新核对权限</button>}
    {access !== "denied" && step === "select" && <div className={styles.form}>
      <label htmlFor={selectionId}>在原回答中选择要给队友看的文字</label>
      <textarea id={selectionId} className={styles.sourceInput} value={sourceText} readOnly rows={9} onSelect={event => {
        setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
      }} aria-describedby={`${selectionId}-hint`}/>
      <p id={`${selectionId}-hint`} className={styles.hint}>鼠标拖选、手机长按或键盘 Shift + 方向键选择片段。下一步仍可编辑和预览。</p>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={selection.end <= selection.start} onClick={() => choose(sourceText.slice(selection.start, selection.end))}>使用选中的文字</button>
        <button type="button" className={styles.secondaryButton} disabled={!sourceText.trim()} onClick={() => choose(sourceText)}>使用整段内容</button></div>
    </div>}
    {access !== "denied" && step === "edit" && <form className={styles.form} onSubmit={event => { event.preventDefault(); preview(); }}>
      <label htmlFor={titleId}>团队动态标题</label><input id={titleId} value={title} maxLength={120} disabled={locked} onChange={event => setTitle(event.target.value)}/>
      <label htmlFor={bodyId}>只发送这段正文</label><textarea id={bodyId} value={body} rows={7} maxLength={6000} disabled={locked} onChange={event => setBody(event.target.value)} aria-describedby={`${bodyId}-hint`}/>
      <p id={`${bodyId}-hint`} className={styles.hint}>{body.length}/6000 字 · 请去掉不准备给全队看的信息。</p>
      <div className={styles.actions}><button className={styles.button} disabled={locked || missingSource || !body.trim() || !title.trim()}>预览将发送的内容</button>
        {sourceKind !== "manual" && <button type="button" className={styles.secondaryButton} disabled={locked} onClick={() => setStep("select")}>重新选择片段</button>}</div>
    </form>}
    {access !== "denied" && step === "preview" && <>
      <article className={styles.previewCard}><span className={styles.badge}>待讨论建议</span><h4>{title}</h4><p className={styles.body}>{body}</p></article>
      <p className={styles.hint}>发送后当前空间成员可阅读；你可以撤回本人建议，管理员可以标记为采纳决定。</p>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || access !== "write" || missingSource} onClick={() => void publish()}>{busy ? "正在核对并保存…" : pending ? "核对这次分享" : "确认分享到当前团队"}</button>
        <button type="button" className={styles.secondaryButton} disabled={locked} onClick={() => setStep("edit")}>返回修改</button></div>
    </>}
    {step === "shared" && receipt && <p className={styles.hint}>记录版本 {receipt.revision} · {receipt.status === "withdrawn" ? "已撤回" : receipt.status === "adopted" ? "已采纳决定" : "待讨论"}{receipt.replayed ? " · 已恢复同一次操作回执" : ""}</p>}
  </section>;
}
