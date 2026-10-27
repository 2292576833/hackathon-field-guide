"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../components/client-api.ts";
import styles from "./selection-notices.module.css";

export const isNoticePrivacyFailure = (reason: unknown) => reason instanceof ApiError && [401, 403, 404].includes(reason.status);
export function useNoticePrivacy(clearPrivate: () => void, errors: readonly (Error | null)[]) {
  const [locked, setLocked] = useState(false);
  const clearRef = useRef(clearPrivate); clearRef.current = clearPrivate;
  const lock = useCallback(() => { clearRef.current(); setLocked(true); }, []);
  const denied = errors.some(isNoticePrivacyFailure);
  useEffect(() => { if (denied) lock(); }, [denied, lock]);
  useEffect(() => { window.addEventListener("hackathon:unauthenticated", lock); return () => window.removeEventListener("hackathon:unauthenticated", lock); }, [lock]);
  return { locked: locked || denied, lock };
}
export function PrivateNoticeUnavailable({ eventId }: { eventId: string }) {
  return <div className={styles.empty}><p>登录或权限已变化，私人内容已清除。请重新登录后打开这场比赛。</p><a className={styles.secondary} href={`/login?returnTo=${encodeURIComponent(`/competitions/${encodeURIComponent(eventId)}`)}`}>登录并返回本场比赛</a></div>;
}
export interface NoticeDraftState { dirty: boolean; busy?: boolean; save?: () => Promise<boolean> }

/** Switching props cannot redirect an old draft into the new event. */
export function NoticeEditorBoundary({ eventId, children }: { eventId: string; children: (activeId: string, onDraft: (state: NoticeDraftState) => void) => ReactNode }) {
  const [activeId, setActiveId] = useState(eventId), [draft, setDraft] = useState<NoticeDraftState>({ dirty: false });
  const [saving, setSaving] = useState(false), [continueEditing, setContinueEditing] = useState(false);
  const onDraft = useCallback((value: NoticeDraftState) => setDraft(value), []);
  const switching = eventId !== activeId;
  useEffect(() => { setContinueEditing(false); }, [eventId]);
  useEffect(() => { if (switching && !draft.dirty) setActiveId(eventId); }, [switching, draft.dirty, eventId]);
  useEffect(() => {
    if (!draft.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.pathname === window.location.pathname && link.search === window.location.search) return;
      if (!window.confirm("通知模板还有未保存的输入。确定放弃并离开当前比赛吗？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", navigate, true); };
  }, [draft.dirty]);
  const switchNow = () => { setDraft({ dirty: false }); setContinueEditing(false); setActiveId(eventId); };
  return <>{switching && draft.dirty && <aside className={styles.switch} role="region" aria-label="切换比赛前处理通知草稿">
    <strong>原比赛的通知模板还有未保存输入</strong><p>{draft.busy ? "原比赛的保存仍在处理中，请等待结果后切换。" : "下方仍是原比赛。保存或放弃后，再切换到新比赛。"}</p><div className={styles.actions}>
      {draft.save && <button type="button" className={styles.primary} disabled={saving} onClick={async () => { setSaving(true); try { if (await draft.save!()) switchNow(); } finally { setSaving(false); } }}>{saving ? "正在保存…" : "保存后切换"}</button>}
      <button type="button" className={styles.secondary} disabled={saving || draft.busy} onClick={switchNow}>放弃草稿并切换</button>
      <button type="button" className={styles.secondary} disabled={saving || draft.busy} onClick={() => setContinueEditing(true)}>继续编辑原比赛</button>
    </div></aside>}<fieldset className={styles.boundary} disabled={saving || switching && draft.dirty && !continueEditing}>{children(activeId, onDraft)}</fieldset></>;
}
