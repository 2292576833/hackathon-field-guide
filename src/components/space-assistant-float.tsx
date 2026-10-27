"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProjectDetail } from "./projects-client.tsx";
import { SpaceAiAssistant } from "./space-ai-assistant.tsx";
import styles from "./space-assistant-float.module.css";

export const SPACE_ASSISTANT_OPEN_EVENT = "hackathon:open-space-assistant";

/** Stable space entry; the assistant retains its own authorization and private history. */
export function SpaceAssistantFloat({ detail, onShared, inline = false }: { detail: ProjectDetail; onShared?: () => void; inline?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { dialog.current?.close(); setOpen(false); setMounted(false); }, [detail.project.id, detail.membership.userId]);
  useEffect(() => {
    const requested = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.projectId !== detail.project.id) return;
      setMounted(true); setOpen(true);
    };
    window.addEventListener(SPACE_ASSISTANT_OPEN_EVENT, requested);
    return () => window.removeEventListener(SPACE_ASSISTANT_OPEN_EVENT, requested);
  }, [detail.project.id]);
  const finishClose = useCallback(() => {
    if (dialog.current?.open) return;
    setOpen(false); trigger.current?.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => { dialog.current?.close(); finishClose(); }, [finishClose]);
  useEffect(() => {
    if (!dialog.current) return;
    if (open && !dialog.current.open) dialog.current.showModal();
    else if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  return <>
    <button ref={trigger} type="button" className={inline ? styles.inline : styles.launcher} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setMounted(true); setOpen(true); }}>
      <span className={styles.dot} aria-hidden="true"/>空间 AI
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close(); }} onClose={finishClose}>
      <div className={styles.head}><h2 id={titleId}>空间 AI</h2>
        <button type="button" className={styles.close} onClick={close}>关闭</button></div>
      <div className={styles.body}>{mounted && <SpaceAiAssistant key={`${detail.membership.userId}:${detail.project.id}`}
        accountKey={detail.membership.userId} projectId={detail.project.id} projectName={detail.project.name}
        readOnly={detail.project.stage === "archived"} onShared={onShared}/>}</div>
    </dialog>
  </>;
}
