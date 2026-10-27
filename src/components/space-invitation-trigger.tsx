"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProjectDetail } from "./projects-client.tsx";
import { SpaceInvitation } from "./space-invitation.tsx";
import styles from "./site.module.css";
import invitationStyles from "./space-invitation.module.css";

export function SpaceInvitationTrigger({ detail, onChanged }: { detail: ProjectDetail; onChanged: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [opened, setOpened] = useState(false);
  const [visible, setVisible] = useState(false);
  const readonly = detail.membership.role !== "manager" || detail.membership.status !== "active" || detail.project.stage === "archived";
  const open = useCallback(() => { if (!readonly) { setOpened(true); setVisible(true); } }, [readonly]);
  const finishClose = useCallback(() => {
    // A queued close event can arrive after a rapid reopen; keep the new dialog open.
    if (dialog.current?.open) return;
    setVisible(false);
    if (window.location.hash === "#space-invitation") window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    trigger.current?.focus();
  }, []);
  const close = useCallback(() => { dialog.current?.close(); finishClose(); }, [finishClose]);

  useEffect(() => {
    const fromHash = () => { if (window.location.hash === "#space-invitation") open(); };
    const fromLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href);
      // Next's same-page hash navigation may use pushState, which does not
      // dispatch hashchange. Recognize only this authorized space's entry.
      if (url.origin === window.location.origin && url.pathname === `/app/projects/${encodeURIComponent(detail.project.id)}` && url.pathname === window.location.pathname && url.hash === "#space-invitation") open();
    };
    fromHash(); window.addEventListener("hashchange", fromHash);
    document.addEventListener("click", fromLink);
    return () => { window.removeEventListener("hashchange", fromHash); document.removeEventListener("click", fromLink); };
  }, [open, detail.project.id]);
  useEffect(() => {
    if (readonly) { dialog.current?.close(); setVisible(false); setOpened(false); }
    else if (visible && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [readonly, visible, opened]);

  return <div className={invitationStyles.trigger} id="space-invitation">
    {readonly ? <p className={invitationStyles.permission}>{detail.project.stage === "archived" ? "归档空间只读，暂不能邀请队友。" : "邀请队友请联系空间管理员。"}</p> : <>
      <button ref={trigger} type="button" className={styles.button} aria-haspopup="dialog" aria-expanded={visible} onClick={open}>邀请队友</button>
      <dialog ref={dialog} className={invitationStyles.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClose={finishClose}>
        <div className={invitationStyles.dialogHeader}><h2 id={titleId}>邀请队友加入团队空间</h2><button type="button" className={styles.secondary} autoFocus onClick={close} aria-label="关闭邀请弹窗">关闭</button></div>
        <p className={invitationStyles.spaceName}>{detail.project.name}</p>
        {opened && <SpaceInvitation key={detail.project.id} detail={detail} onChanged={onChanged}/>}
      </dialog>
    </>}
  </div>;
}
