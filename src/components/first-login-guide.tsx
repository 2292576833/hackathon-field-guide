"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, useApi } from "./client-api.ts";
import type { Me } from "./site-shell.tsx";
import { FIRST_LOGIN_GUIDE_VERSION, firstLoginSteps, type OnboardingState } from "../modules/onboarding/model.ts";
import styles from "./first-login-guide.module.css";

/** May be dispatched from the account menu or Navigator without navigating. */
export const FIRST_LOGIN_GUIDE_REPLAY_EVENT = "hackathon:replay-first-login-guide";

function deferredKey(accountId: string): string {
  return `hackathon:first-login-deferred:${FIRST_LOGIN_GUIDE_VERSION}:${accountId}`;
}

async function guideRequest(options: { method?: string; body?: unknown } = {}): Promise<OnboardingState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try { return await api<OnboardingState>("/me/onboarding", { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

export function FirstLoginGuide() {
  const pathname = usePathname();
  const identity = useApi<Me>("/me");
  const accountId = identity.data?.profile.id ?? null;
  const invitationPage = /^\/app\/join\//.test(pathname);
  const registrationPage = /^\/competitions\/[^/]+\/register\/?$/.test(pathname);
  const priorityPage = invitationPage || registrationPage;
  const dialog = useRef<HTMLDialogElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusBeforeOpen = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const activeAccount = useRef<string | null>(null);
  const [saved, setSaved] = useState<OnboardingState | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failedSave, setFailedSave] = useState<{ stepIndex: number; completed: boolean } | null>(null);

  function clearAccount() {
    generation.current++;
    setSaved(null); setOpen(false); setBusy(false); setLoading(false);
    setStepIndex(0); setFailedSave(null); setError(""); setDeferred(false); setReplaying(false); setManuallyOpened(false);
  }

  async function loadState(id: string) {
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      const state = await guideRequest();
      if (generation.current !== current || activeAccount.current !== id) return;
      setSaved(state); setStepIndex(state.stepIndex);
    } catch (reason) {
      if (generation.current !== current || activeAccount.current !== id) return;
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) clearAccount();
      else setError("网站指引暂时没有读取成功。你可以继续使用网站，或重试读取指引。");
    } finally { if (generation.current === current) setLoading(false); }
  }

  useEffect(() => {
    activeAccount.current = accountId;
    clearAccount();
    if (!accountId) return;
    try { setDeferred(sessionStorage.getItem(deferredKey(accountId)) === "yes"); } catch { /* Optional per-tab pause only; completion is saved on the server. */ }
    void loadState(accountId);
    return () => { generation.current++; };
  }, [accountId]);

  useEffect(() => {
    const clear = () => { activeAccount.current = null; clearAccount(); };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);

  useEffect(() => {
    if (saved && !saved.completedAt && !deferred && !priorityPage) setOpen(true);
    // Explicit invitations and registration take priority; their context stays intact.
    if (priorityPage && !manuallyOpened) setOpen(false);
  }, [saved, deferred, priorityPage, manuallyOpened]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      focusBeforeOpen.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      node.showModal(); stepHeading.current?.focus();
    } else if (!open && node.open) {
      node.close();
      const previous = focusBeforeOpen.current;
      if (previous?.isConnected) previous.focus(); else trigger.current?.focus();
    }
  }, [open]);

  useEffect(() => { if (open) stepHeading.current?.focus(); }, [stepIndex, open]);

  function startGuide() {
    if (!accountId || !saved) return;
    setError(""); setFailedSave(null);
    setReplaying(saved.completedAt !== null);
    setManuallyOpened(true);
    setStepIndex(saved.completedAt ? 0 : saved.stepIndex);
    setDeferred(false);
    try { sessionStorage.removeItem(deferredKey(accountId)); } catch { /* Optional per-tab pause. */ }
    setOpen(true);
  }

  useEffect(() => {
    const replay = () => startGuide();
    window.addEventListener(FIRST_LOGIN_GUIDE_REPLAY_EVENT, replay);
    return () => window.removeEventListener(FIRST_LOGIN_GUIDE_REPLAY_EVENT, replay);
  }, [accountId, saved]);

  function pauseGuide() {
    if (busy) return;
    if (accountId) {
      try { sessionStorage.setItem(deferredKey(accountId), "yes"); } catch { /* Does not record completion. */ }
    }
    setDeferred(true); setOpen(false); setReplaying(false); setManuallyOpened(false);
  }

  async function saveStep(target: number, completed = false) {
    if (!saved || !accountId || busy) return;
    const id = accountId, current = generation.current;
    setStepIndex(target); setBusy(true); setError(""); setFailedSave(null);
    if (replaying) {
      setBusy(false);
      if (completed) { setOpen(false); setReplaying(false); }
      return;
    }
    try {
      const state = await guideRequest({
        method: "POST", body: { expectedRevision: saved.revision, stepIndex: target, ...(completed ? { completed: true } : {}) },
      });
      if (generation.current !== current || activeAccount.current !== id) return;
      setSaved(state);
      if (completed && state.completedAt) { setOpen(false); setReplaying(false); }
    } catch (reason) {
      if (generation.current !== current || activeAccount.current !== id) return;
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) { clearAccount(); return; }
      if (reason instanceof ApiError && reason.status === 409) {
        try {
          const latest = await guideRequest();
          if (generation.current !== current || activeAccount.current !== id) return;
          setSaved(latest);
          if (latest.completedAt && completed) { setOpen(false); return; }
        } catch (refreshError) {
          if (refreshError instanceof ApiError && [401, 403].includes(refreshError.status)) { clearAccount(); return; }
        }
      }
      if (generation.current !== current || activeAccount.current !== id) return;
      setFailedSave({ stepIndex: target, completed });
      setError("进度暂时没有保存成功，当前步骤已保留。请重试保存，或稍后从这里继续。");
    } finally { if (generation.current === current) setBusy(false); }
  }

  if (!accountId) return null;
  const step = firstLoginSteps[stepIndex] ?? firstLoginSteps[0];
  return <>
    {(!saved?.completedAt || error) && <div className={styles.entry}>
      {invitationPage && saved && !saved.completedAt && <p className={styles.invitationNote}>先处理队友邀请，进入团队空间后会继续网站指引。</p>}
      {registrationPage && saved && !saved.completedAt && <p className={styles.invitationNote}>先完成本场报名，之后继续网站指引。</p>}
      <button ref={trigger} type="button" className={styles.entryButton} aria-haspopup="dialog" disabled={loading || !saved} onClick={startGuide}>
        {loading ? "读取网站指引…" : deferred ? "继续网站指引" : priorityPage ? "现在看网站指引" : "网站使用指引"}
      </button>
      {!open && error && <div className={styles.readError} role="alert"><p>{error}</p><button type="button" disabled={loading} onClick={() => void loadState(accountId)}>重试读取指引</button></div>}
    </div>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="first-login-guide-title" aria-describedby="first-login-guide-description" onCancel={event => { event.preventDefault(); pauseGuide(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(button => button.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); stepHeading.current?.focus(); return; }
      const focused = document.activeElement;
      if (event.shiftKey && (focused === first || !controls.includes(focused as HTMLButtonElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (focused === last || !controls.includes(focused as HTMLButtonElement))) {
        event.preventDefault(); first.focus();
      }
    }}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>网站使用指引 · 第 {stepIndex + 1} / {firstLoginSteps.length} 步</p>
        <h2 id="first-login-guide-title">先认识网站，继续你的操作</h2>
        <p className={styles.context}>看完后继续当前页面。以后可以随时重看。</p>
        <ol className={styles.dots} aria-label="网站指引步骤">{firstLoginSteps.map((item, index) => <li key={item.title} aria-current={index === stepIndex ? "step" : undefined}><span className={styles.srOnly}>{index + 1}. {item.title}{index === stepIndex ? "，当前步骤" : ""}</span><span aria-hidden="true" /></li>)}</ol>
      </header>
      <section className={styles.content}>
        <h3 ref={stepHeading} tabIndex={-1}>{step.title}</h3>
        <p id="first-login-guide-description">{step.description}</p>
        {stepIndex === 0 && <ol className={styles.flow} aria-label="参赛流程">{["找比赛", "个人准备", "团队协作", "正式提交", "复盘"].map((label, index) => <li key={label}>{index > 0 && <span aria-hidden="true">→ </span>}{label}</li>)}</ol>}
        <ul className={styles.actionList}>{step.actions.map(item => <li key={item.label}><strong>{item.label}</strong><p>{item.detail}</p></li>)}</ul>
        <p className={styles.reminder}>{step.reminder}</p>
        {error && <div role="alert" className={styles.saveError}><p>{error}</p>{failedSave && <button type="button" disabled={busy} onClick={() => void saveStep(failedSave.stepIndex, failedSave.completed)}>重试保存进度</button>}</div>}
      </section>
      <footer className={styles.footer}>
        <button type="button" className={styles.secondary} disabled={busy || !!failedSave || stepIndex === 0} onClick={() => void saveStep(stepIndex - 1)}>上一步</button>
        <button type="button" className={styles.primary} disabled={busy || !!failedSave} onClick={() => void saveStep(Math.min(stepIndex + 1, firstLoginSteps.length - 1), stepIndex === firstLoginSteps.length - 1)}>{busy ? "保存进度…" : stepIndex === firstLoginSteps.length - 1 ? "了解了，继续刚才的操作" : "下一步"}</button>
        <button type="button" className={styles.pause} disabled={busy} onClick={pauseGuide}>{invitationPage ? "先处理邀请" : registrationPage ? "先完成报名" : "稍后继续"}</button>
      </footer>
    </dialog>
  </>;
}
