"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, message, operationKey, useApi } from "../../components/client-api.ts";
import { Feedback } from "../../components/site-shell.tsx";
import { isNoticePrivacyFailure, PrivateNoticeUnavailable, useNoticePrivacy } from "./boundary.tsx";
import { NoticePreview, PublishedNotice } from "./NoticePreview.tsx";
import { latestSelectionNotice, type ManagedSelectionNoticeList, type SelectionNotice, type SelectionNoticeRegistration, type SelectionNoticeTemplate } from "./model.ts";
import { NoticePublicationAttempt, prepareNoticePublication } from "./publication.ts";
import styles from "./selection-notices.module.css";

export interface SelectionNoticeActionProps { eventId: string; registration: SelectionNoticeRegistration }
export function SelectionNoticeAction(props: SelectionNoticeActionProps) {
  return <NoticeAction key={`${props.eventId}:${props.registration.id}:${props.registration.userId}:${props.registration.revision}:${props.registration.status}`} {...props}/>;
}
const unknownOutcome = (reason: unknown) => !(reason instanceof ApiError) || reason.status >= 500 || /UNKNOWN|TIMEOUT|IN_PROGRESS|HOLD|INVALID_RESPONSE/.test(reason.code);

function NoticeAction({ eventId, registration }: SelectionNoticeActionProps) {
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState(false), [newVersionConfirmed, setNewVersionConfirmed] = useState(false);
  const base = `/organizer/events/${encodeURIComponent(eventId)}`;
  const template = useApi<SelectionNoticeTemplate>(open ? `${base}/selection-notice-template` : null);
  const managed = useApi<ManagedSelectionNoticeList>(open ? `${base}/selection-notices?recipientUserId=${encodeURIComponent(registration.userId)}` : null);
  const [attempt, setAttempt] = useState<NoticePublicationAttempt | null>(null), [receipt, setReceipt] = useState<SelectionNotice | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const inFlight = useRef(false), alive = useRef(true), cleared = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const clearPrivate = useCallback(() => { cleared.current = true; setAttempt(null); setReceipt(null); template.setData(null); managed.setData(null); setConfirmed(false); setNewVersionConfirmed(false); setError(""); setNotice(""); }, [template.setData, managed.setData]);
  const privacy = useNoticePrivacy(clearPrivate, [template.error, managed.error]);
  const latest = managed.data && latestSelectionNotice(managed.data.items, registration, eventId);
  const ready = Boolean(template.data && managed.data && !template.loading && !managed.loading && !template.error && !managed.error && !privacy.locked && template.data.revision > 0 && registration.status === "approved" && managed.data.recipient.userId === registration.userId && managed.data.registrationRevision === registration.revision);
  useEffect(() => {
    if (!busy && !receipt && attempt && attempt.state === "ready") { setAttempt(null); setConfirmed(false); setNewVersionConfirmed(false); }
    // New GET data invalidates an unsent confirmation, never a posted operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.data, managed.data]);
  async function reload() {
    if (inFlight.current || privacy.locked) return;
    await Promise.all([template.reload(), managed.reload()]);
  }
  function prepare() {
    if (!ready || !template.data || !managed.data || inFlight.current || attempt?.state === "unknown") return;
    try {
      const preview = prepareNoticePublication(eventId, registration, template.data, managed.data, latest ? operationKey() : undefined);
      setAttempt(new NoticePublicationAttempt(preview)); setReceipt(null); setConfirmed(false); setNewVersionConfirmed(false); setError(""); setNotice("");
    } catch (reason) { setError(message(reason)); }
  }
  async function publish() {
    if (!attempt || !confirmed || attempt.preview.currentVersion > 0 && !newVersionConfirmed || inFlight.current || cleared.current || privacy.locked) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await attempt.send(input => api<SelectionNotice>(`${base}/selection-notices`, { method: "POST", body: input }), unknownOutcome);
      if (!alive.current || cleared.current) return;
      if (result.eventId !== eventId || result.registrationId !== registration.id) throw new Error("返回的通知与本场收件人不符，请读取最新记录核对。");
      setReceipt(result); setNotice(`站内通知第 ${result.version} 版已发布。邮件状态见下方回执。`); setConfirmed(false); setNewVersionConfirmed(false);
      void managed.reload();
    } catch (reason) {
      if (alive.current && !cleared.current) {
        if (isNoticePrivacyFailure(reason)) privacy.lock();
        else setError(attempt.state === "unknown" ? `${message(reason)} 本次发布结果尚未确认。请先读取最新记录；重试会使用同一次发布参数。` : `${message(reason)} 本次预览和发布参数已保留，请核对后重试。`);
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    if (!busy && attempt?.state !== "unknown") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.pathname === window.location.pathname && link.search === window.location.search) return;
      if (!window.confirm("本次通知发布结果仍待核对。离开不会撤销请求；保留此页可重试同一次操作。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", navigate, true); };
  }, [busy, attempt]);
  if (registration.status !== "approved") return null;
  const privateName = managed.data?.recipient.label;
  const visibleReceipt = latest && (!receipt || latest.version >= receipt.version) ? latest : receipt;
  return <div className={styles.action}>
    {!open && <button type="button" className={styles.secondary} onClick={() => setOpen(true)}>查看并发布入选通知</button>}
    {open && <section className={styles.actionPanel} aria-label="为本场已通过选手发布入选通知">
      <h4>入选通知</h4>{privacy.locked ? <PrivateNoticeUnavailable eventId={eventId}/> : <>
        <Feedback error={error || template.error || managed.error} notice={notice}/>
        {(template.loading || managed.loading) && <p role="status" className={styles.muted}>正在读取本场收件人与通知版本…</p>}
        {managed.data && <p className={styles.identity}><strong>收件人：{privateName}</strong><br/><span className={styles.muted}>账号 {managed.data.recipient.userId} · 当前报名版本 {managed.data.registrationRevision}</span></p>}
        {managed.data?.event && <p className={styles.muted}>{managed.data.event.organizationName} · {managed.data.event.title} · 报名工作人员</p>}
        {visibleReceipt && <PublishedNotice notice={visibleReceipt}/>}
        {template.data?.revision === 0 && <p className={styles.empty}>请先在上方编辑并保存本场入选通知模板，再回来读取最新记录。</p>}
        {managed.data && managed.data.registrationRevision !== registration.revision && <p className={styles.warning}>报名版本已变化。请先刷新报名名单，核对通过状态后再发布。</p>}
        {!attempt && <div className={styles.actions}><button type="button" className={styles.primary} disabled={!ready || busy} onClick={prepare}>{latest ? "预览新版通知" : "预览并确认发布"}</button><button type="button" className={styles.secondary} disabled={busy || template.loading || managed.loading} onClick={() => void reload()}>读取最新记录</button></div>}
        {attempt && !receipt && <section className={styles.previewSection} aria-label="发布前核对">
          <h4>核对后发布给 {attempt.preview.recipient.label}</h4>
          <p className={styles.muted}>本场已通过报名 · 模板第 {attempt.preview.input.templateRevision} 版{attempt.preview.currentVersion ? ` · 已发布至第 ${attempt.preview.currentVersion} 版` : " · 首次发布"}</p>
          {attempt.preview.exampleName && <p className={styles.muted}>下方模板中的姓名为示例。发布时，服务器会替换为上方所选收件人的姓名。</p>}
          <NoticePreview content={attempt.preview.content}/>
          <p className={styles.muted}>确认前请逐项核对上方收件人和当前比赛。首次发布只需确认收件内容；再次发布还需确认新版本。确认后会发布站内通知，邮件是否发出以回执状态为准。</p>
          {attempt.preview.currentVersion > 0 && <label className={styles.check}><input type="checkbox" checked={newVersionConfirmed} disabled={busy} onChange={event => setNewVersionConfirmed(event.target.checked)}/>我明确要发布第 {attempt.preview.currentVersion + 1} 版通知。旧版保留，并可能新增一封邮件。</label>}
          <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>我已核对本场收件人、标题、正文和样式，确认发布站内通知；邮件服务已配置时会进入队列。</label>
          {attempt.state === "unknown" && <p className={styles.warning}>发布结果尚未确认。不要另开一次发布来重试；邮件结果未知时也不会自动重发。</p>}
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !confirmed || attempt.preview.currentVersion > 0 && !newVersionConfirmed || Boolean(template.error || managed.error) || template.loading || managed.loading} onClick={() => void publish()}>{busy ? "正在发布…" : attempt.state === "unknown" || attempt.state === "rejected" ? "重试同一次发布" : attempt.preview.currentVersion > 0 ? "确认发布新版本" : "确认发布给此选手"}</button>
            <button type="button" className={styles.secondary} disabled={busy || template.loading || managed.loading} onClick={() => void reload()}>读取最新记录</button>
            {(attempt.state === "ready" || attempt.state === "rejected") && <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setAttempt(null); setConfirmed(false); setNewVersionConfirmed(false); }}>取消本次预览</button>}
          </div>
        </section>}
        {receipt && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={!ready || busy || managed.loading} onClick={() => { setAttempt(null); setReceipt(null); setNotice(""); }}>准备发布另一个新版本</button><button type="button" className={styles.secondary} disabled={busy || managed.loading} onClick={() => void reload()}>刷新邮件状态</button></div>}
      </>}
    </section>}
  </div>;
}
