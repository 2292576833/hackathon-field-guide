"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, message, useApi } from "../../components/client-api.ts";
import { Feedback, Field } from "../../components/site-shell.tsx";
import { NoticePreview } from "./NoticePreview.tsx";
import { isNoticePrivacyFailure, NoticeEditorBoundary, PrivateNoticeUnavailable, useNoticePrivacy, type NoticeDraftState } from "./boundary.tsx";
import { NOTICE_LIMITS, renderNoticeExample, sameNoticeContent, validateNoticeContent, type NoticeAccent, type NoticeContent, type NoticeTheme, type SelectionNoticeTemplate } from "./model.ts";
import styles from "./selection-notices.module.css";

export interface SelectionNoticeTemplateEditorProps { eventId: string }
export function SelectionNoticeTemplateEditor({ eventId }: SelectionNoticeTemplateEditorProps) {
  return <NoticeEditorBoundary eventId={eventId}>{(activeId, onDraft) => <TemplateEditor key={activeId} eventId={activeId} onDraft={onDraft}/>}</NoticeEditorBoundary>;
}
function TemplateEditor({ eventId, onDraft }: SelectionNoticeTemplateEditorProps & { onDraft: (state: NoticeDraftState) => void }) {
  const path = `/organizer/events/${encodeURIComponent(eventId)}/selection-notice-template`;
  const query = useApi<SelectionNoticeTemplate>(path);
  const [saved, setSaved] = useState<SelectionNoticeTemplate | null>(null), [draft, setDraft] = useState<NoticeContent | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [recoveredRead, setRecoveredRead] = useState(false);
  const initialized = useRef(false), inFlight = useRef(false), alive = useRef(true), cleared = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const clearPrivate = useCallback(() => { cleared.current = true; initialized.current = false; setSaved(null); setDraft(null); query.setData(null); setError(""); setNotice(""); onDraft({ dirty: false }); }, [onDraft, query.setData]);
  const privacy = useNoticePrivacy(clearPrivate, [query.error]);
  const readError = recoveredRead ? null : query.error;
  useEffect(() => { if (query.data && query.data.eventId === eventId && !initialized.current && !cleared.current) { initialized.current = true; setSaved(query.data); setDraft({ subject: query.data.subject, body: query.data.body, accent: query.data.accent, theme: query.data.theme }); } }, [query.data, eventId]);
  const dirty = Boolean(saved && draft && !sameNoticeContent(saved, draft));
  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current || cleared.current || !saved || !draft || privacy.locked || query.loading || readError) return false;
    const errors = validateNoticeContent(draft);
    if (errors.length) { setError(errors.join(" ")); return false; }
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<SelectionNoticeTemplate>(path, { method: "PUT", body: { expectedRevision: saved.revision, ...draft } });
      if (!alive.current || cleared.current) return false;
      if (result.eventId !== eventId) throw new Error("返回的比赛与当前草稿不符，请重新核对。");
      setSaved(result); setDraft({ subject: result.subject, body: result.body, accent: result.accent, theme: result.theme }); query.setData(result);
      setNotice(`模板第 ${result.revision} 版已保存。下一步：到已通过报名名单，为指定选手预览并发布。`);
      return true;
    } catch (reason) { if (alive.current && !cleared.current) { if (isNoticePrivacyFailure(reason)) privacy.lock(); else setError(`${message(reason)} 草稿已保留；如有版本冲突，请核对最新模板。`); } return false; }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }, [draft, saved, path, eventId, privacy.locked, privacy.lock, query.loading, readError, query.setData]);
  useEffect(() => { onDraft({ dirty: !privacy.locked && (dirty || busy), busy: !privacy.locked && busy, ...(dirty && !busy && !privacy.locked ? { save } : {}) }); }, [onDraft, dirty, busy, save, privacy.locked]);
  async function loadLatest() {
    if (inFlight.current || privacy.locked) return;
    if (dirty && !window.confirm("载入最新模板会放弃当前未保存草稿。确定继续吗？")) return;
    // Wait for a successful read before replacing the draft, so failed recovery keeps input.
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try { const result = await api<SelectionNoticeTemplate>(path); if (!alive.current || cleared.current) return; if (result.eventId !== eventId) throw new Error("返回的比赛与当前草稿不符。"); initialized.current = true; setSaved(result); setDraft({ subject: result.subject, body: result.body, accent: result.accent, theme: result.theme }); query.setData(result); setRecoveredRead(true); setNotice(`已载入模板第 ${result.revision} 版，请核对后继续编辑。`); }
    catch (reason) { if (alive.current && !cleared.current) { if (isNoticePrivacyFailure(reason)) privacy.lock(); else setError(`${message(reason)} 当前草稿已保留。`); } }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  const patch = (value: Partial<NoticeContent>) => { setDraft(current => current && { ...current, ...value }); setNotice(""); setError(""); };
  const preview = draft && saved && (dirty ? renderNoticeExample(draft, { name: "示例参赛者", event: saved.event?.title ?? "当前比赛", organizer: saved.event?.organizationName ?? "本场主办方" }) : { ...draft, ...saved.preview });
  return <section className={styles.panel} aria-label="入选通知模板">
    <p className={styles.kicker}>当前比赛 · 报名工作人员</p><h2>编辑入选通知</h2>
    {saved?.event && <p>{saved.event.organizationName} · {saved.event.title}</p>}
    <p className={styles.muted}>保存本场的标题、正文和样式。保存模板后，到已通过报名名单选择收件人并确认发布。</p>
    {privacy.locked ? <PrivateNoticeUnavailable eventId={eventId}/> : <>
      <Feedback error={error || readError} notice={notice}/>
      {(query.loading || busy) && <p role="status" className={styles.muted}>{busy ? "正在处理模板…" : "正在读取本场模板…"}</p>}
      {draft && saved && <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
        <p className={styles.muted}>{saved.revision ? `已保存第 ${saved.revision} 版` : "尚未保存模板"}{dirty ? " · 当前有未保存草稿" : ""}。模板变化不改写既有通知。</p>
        <fieldset className={styles.boundary} disabled={busy || query.loading}>
          <div className={styles.form}><Field label="通知标题" hint="必填。填写邮件及站内通知标题，例如“{event} 入选通知”。最多 200 个字符，{event} 自动替换为本场比赛名。"><input required maxLength={NOTICE_LIMITS.subject} value={draft.subject} onChange={event => patch({ subject: event.target.value })}/></Field>
          <Field label="通知正文" hint="必填，使用纯文本。说明入选结果、确认参加的方式、时间地点和联系渠道。{name}、{event}、{organizer} 分别自动替换姓名、比赛名、主办方名；请保留完整花括号。"><textarea required rows={8} maxLength={NOTICE_LIMITS.body} value={draft.body} onChange={event => patch({ body: event.target.value })}/></Field>
          <div className={styles.choices}><Field label="通知样式" hint="简洁适合直接读安排；信函适合正式入选邀请。这里只调整展示，不改变收件人或通过状态。"><select value={draft.theme} onChange={event => patch({ theme: event.target.value as NoticeTheme })}><option value="simple">简洁</option><option value="letter">信函</option></select></Field>
          <Field label="强调色" hint="选择本场通知标题与装饰的颜色；下方预览会展示实际效果，不影响发送渠道。"><select value={draft.accent} onChange={event => patch({ accent: event.target.value as NoticeAccent })}><option value="orange">橙红</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="slate">灰蓝</option></select></Field></div></div>
        </fieldset>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || query.loading || Boolean(readError) || !dirty && saved.revision > 0}>{busy ? "正在保存…" : "保存本场模板"}</button><button type="button" className={styles.secondary} disabled={busy || query.loading} onClick={() => void loadLatest()}>载入最新模板</button></div>
      </form>}
      {!draft && !query.loading && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void loadLatest()}>重新读取模板</button>}
      {preview && <section className={styles.previewSection}><h3>样式预览</h3><p className={styles.muted}>这里的姓名是示例。发布前会另外显示所选收件人，实际姓名由服务器替换。</p><NoticePreview content={preview}/></section>}
    </>}
  </section>;
}
