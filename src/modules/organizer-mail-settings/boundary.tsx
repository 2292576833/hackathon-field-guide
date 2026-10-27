"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import styles from "./sender-settings.module.css";

export interface SenderDraftState { dirty: boolean; busy: boolean; save?: () => Promise<boolean> }
/** Keep credentials scoped to their original organization until saved or explicitly discarded. */
export function SenderOrganizationBoundary({ organizationId, children }: { organizationId: string; children: (activeId: string, onDraft: (state: SenderDraftState) => void) => ReactNode }) {
  const [activeId, setActiveId] = useState(organizationId), [draft, setDraft] = useState<SenderDraftState>({ dirty: false, busy: false });
  const [saving, setSaving] = useState(false), [continueEditing, setContinueEditing] = useState(false);
  const onDraft = useCallback((state: SenderDraftState) => setDraft(state), []);
  const switching = activeId !== organizationId;
  useEffect(() => { setContinueEditing(false); }, [organizationId]);
  useEffect(() => { if (switching && !draft.dirty && !draft.busy) setActiveId(organizationId); }, [switching, draft.dirty, draft.busy, organizationId]);
  useEffect(() => {
    if (!draft.dirty && !draft.busy) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.pathname === window.location.pathname && link.search === window.location.search) return;
      if (!window.confirm(draft.busy ? "发信设置仍在验证或保存中。离开不会撤销请求，确定离开吗？" : "发信邮箱还有未保存输入，离开会清除授权码。确定放弃并离开吗？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [draft.dirty, draft.busy]);
  const switchNow = () => { setDraft({ dirty: false, busy: false }); setContinueEditing(false); setActiveId(organizationId); };
  return <>{switching && (draft.dirty || draft.busy) && <aside className={styles.switch} role="region" aria-label="切换主办方前处理发信设置"><strong>原主办方还有未保存的发信设置</strong><p>{draft.busy ? "原主办方的验证或保存仍在处理，请等结果后切换。" : "下方仍是原主办方。先保存或放弃输入，再切换；授权码不会转投另一家主办方。"}</p><div className={styles.actions}>
    {draft.save && <button type="button" className={styles.primary} disabled={saving || draft.busy} onClick={async () => { setSaving(true); try { if (await draft.save!()) switchNow(); } finally { setSaving(false); } }}>{saving ? "正在处理…" : "验证保存后切换"}</button>}
    <button type="button" className={styles.secondary} disabled={saving || draft.busy} onClick={switchNow}>放弃输入并切换</button><button type="button" className={styles.secondary} disabled={saving || draft.busy} onClick={() => setContinueEditing(true)}>继续编辑原主办方</button>
  </div></aside>}<fieldset className={styles.boundary} disabled={saving || switching && !continueEditing}>{children(activeId, onDraft)}</fieldset></>;
}
