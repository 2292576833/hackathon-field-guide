"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { EmailChangeReceipt, EmailChangeResult } from "./account-types.ts";
import type { UserProfile } from "./types.ts";
import styles from "./account-controls.module.css";

export interface AccountEmailChangeApi {
  requestEmailChange(input: { readonly newEmail: string; readonly expectedRevision: number }): Promise<EmailChangeReceipt>;
  verifyEmailChange(input: { readonly challengeId: string; readonly currentCode: string; readonly newCode: string }): Promise<EmailChangeResult>;
}

export interface AccountEmailChangeProps {
  readonly profile: UserProfile;
  readonly api: AccountEmailChangeApi;
  readonly onChanged: (result: EmailChangeResult) => void;
  readonly onReauthenticate?: () => void;
}

function readableTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + "（北京时间）";
}

function failureDetails(reason: unknown) {
  const outer = reason && typeof reason === "object" ? reason as { code?: unknown; message?: unknown; recoveryAction?: unknown; error?: unknown } : {};
  const failure = outer.error && typeof outer.error === "object" ? outer.error as typeof outer : outer;
  const code = typeof failure.code === "string" ? failure.code : "";
  const known = /^[A-Z][A-Z0-9_]{0,127}$/.test(code);
  return {
    code,
    message: known && typeof failure.message === "string" ? failure.message : "操作结果暂未确认。请稍后重新获取验证，新的邮箱地址已保留。",
    reauthenticate: ["AUTH_REAUTHENTICATION_REQUIRED", "AUTH_SESSION_REQUIRED", "AUTH_SESSION_EXPIRED", "AUTH_SESSION_REVOKED", "UNAUTHENTICATED"].includes(code) || failure.recoveryAction === "reauthenticate",
  };
}

/** Two mailbox proofs are held only in component memory and are never saved to browser storage. */
export function AccountEmailChange({ profile, api, onChanged, onReauthenticate }: AccountEmailChangeProps) {
  const [newEmail, setNewEmail] = useState("");
  const [receipt, setReceipt] = useState<EmailChangeReceipt | null>(null);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [newCode, setNewCode] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [needsAuthentication, setNeedsAuthentication] = useState(false);
  const [result, setResult] = useState<EmailChangeResult | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  const emailInputId = useId();
  const currentCodeId = useId();
  const newCodeId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setNewEmail(""); setReceipt(null); setReceiptEmail(""); setCurrentCode(""); setNewCode("");
    setError(""); setNeedsAuthentication(false); setResult(null); setResendAt(0);
  }, [profile.id]);
  useEffect(() => {
    setNow(Date.now());
    if (!receipt && !resendAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [receipt, resendAt]);
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = Boolean(receipt && now > 0 && Date.parse(receipt.expiresAt) <= now);
  const sameEmail = newEmail.trim().toLowerCase() === profile.email.toLowerCase();

  function showFailure(reason: unknown, sending: boolean) {
    const failure = failureDetails(reason);
    setError(failure.message); setNeedsAuthentication(failure.reauthenticate);
    if (failure.reauthenticate || failure.code === "AUTH_CHALLENGE_UNAVAILABLE") {
      setReceipt(null); setReceiptEmail(""); setCurrentCode(""); setNewCode("");
    }
    if (sending && (failure.code === "AUTH_EMAIL_UNAVAILABLE" || !failure.code || failure.code === "AUTH_RATE_LIMITED")) {
      // Acceptance may be unknown. Never submit or resend the same challenge automatically.
      const instant = Date.now(); setNow(instant); setResendAt(instant + 60_000);
      setReceipt(null); setCurrentCode(""); setNewCode("");
    }
  }

  async function requestChange() {
    if (running.current || result || cooldown > 0) return;
    running.current = true; setBusy("send"); setError(""); setNeedsAuthentication(false);
    setReceipt(null); setReceiptEmail(""); setCurrentCode(""); setNewCode("");
    const target = newEmail.trim();
    try {
      const next = await api.requestEmailChange({ newEmail: target, expectedRevision: profile.revision });
      if (!mounted.current) return;
      const instant = Date.now();
      setReceipt(next); setReceiptEmail(target); setNow(instant); setResendAt(instant + Math.max(0, next.resendAfterSeconds) * 1000);
    } catch (reason) { if (mounted.current) showFailure(reason, true); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  async function verifyChange() {
    if (running.current || !receipt || expired || result) return;
    running.current = true; setBusy("verify"); setError(""); setNeedsAuthentication(false);
    try {
      const next = await api.verifyEmailChange({ challengeId: receipt.challengeId, currentCode, newCode });
      if (!mounted.current) return;
      setResult(next); setReceipt(null); setCurrentCode(""); setNewCode("");
      try { onChanged(next); }
      catch { setError("邮箱已更换，请通过下方入口重新登录。"); }
    } catch (reason) { if (mounted.current) showFailure(reason, false); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  return <section className={styles.controls} aria-label="更换登录邮箱" aria-busy={Boolean(busy)}>
    <h2>更换登录邮箱</h2>
    <p className={styles.muted}>当前邮箱：<span className={styles.email}>{profile.email}</span></p>
    <p>先重新确认本人身份，再分别验证当前邮箱和新邮箱。账号 ID 与参赛记录保持归属，成功后所有旧登录设备需要重新登录。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {needsAuthentication && <div className={styles.warning}><p>请先重新验证当前登录邮箱，再回到这里继续。新邮箱地址会保留在当前页面。</p>{onReauthenticate ? <button type="button" className={styles.secondary} onClick={onReauthenticate}>重新验证当前邮箱</button> : <a className={styles.link} href="/login?returnTo=%2Fapp%2Faccount">重新登录认证</a>}</div>}
    {result ? <div className={styles.success} role="status"><strong>登录邮箱已更换为 {result.profile.email}</strong><p>旧登录会话已撤销，请使用新邮箱重新登录。验证码已从本页清除。</p><a className={styles.link} href="/login?returnTo=%2Fapp%2Faccount">用新邮箱重新登录</a></div> : <>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void requestChange(); }}>
        <label className={styles.field} htmlFor={emailInputId}>新的登录邮箱<input id={emailInputId} type="email" required autoComplete="email" maxLength={254} value={newEmail} disabled={Boolean(busy) || Boolean(receipt)} onChange={event => setNewEmail(event.target.value)} placeholder="填写本人可以收信的新邮箱"/><small>需要能同时收取当前邮箱和新邮箱的验证邮件。两个邮箱的验证码不同。</small></label>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={Boolean(busy) || cooldown > 0 || !newEmail.trim() || sameEmail}>{busy === "send" ? "正在请求验证…" : cooldown > 0 ? `${cooldown} 秒后可重新获取` : receipt ? "重新获取两封验证邮件" : "获取两封验证邮件"}</button>
          {receipt && <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => { setReceipt(null); setReceiptEmail(""); setCurrentCode(""); setNewCode(""); setError(""); }}>修改新邮箱</button>}
        </div>
        {sameEmail && newEmail.trim() && <p className={styles.muted}>新邮箱需要与当前登录邮箱不同。</p>}
      </form>
      {receipt && <div className={styles.section}>
        <div className={expired ? styles.warning : styles.note} role="status"><p>{expired ? "本次验证已过期，请重新获取两封验证邮件。" : receipt.message}</p><p>当前邮箱 {profile.email} 与新邮箱 {receiptEmail} 分别收取验证码，有效期至 {readableTime(receipt.expiresAt)}。</p></div>
        <form className={styles.form} onSubmit={event => { event.preventDefault(); void verifyChange(); }}>
          <div className={styles.codeFields}>
            <label className={styles.field} htmlFor={currentCodeId}>当前邮箱验证码<input id={currentCodeId} type="text" inputMode="numeric" autoComplete="off" required minLength={8} maxLength={8} pattern="[0-9]{8}" value={currentCode} disabled={Boolean(busy) || expired} onChange={event => setCurrentCode(event.target.value.replace(/\D/g, "").slice(0, 8))}/><small>从 {profile.email} 收到的 8 位数字。</small></label>
            <label className={styles.field} htmlFor={newCodeId}>新邮箱验证码<input id={newCodeId} type="text" inputMode="numeric" autoComplete="off" required minLength={8} maxLength={8} pattern="[0-9]{8}" value={newCode} disabled={Boolean(busy) || expired} onChange={event => setNewCode(event.target.value.replace(/\D/g, "").slice(0, 8))}/><small>从 {receiptEmail} 收到的 8 位数字。</small></label>
          </div>
          <p className={styles.muted}>确认更换会退出所有旧登录会话。验证失败时可核对两封邮件；重新获取会使之前的验证码失效。</p>
          <button type="submit" className={styles.primary} disabled={Boolean(busy) || expired || !/^\d{8}$/.test(currentCode) || !/^\d{8}$/.test(newCode)}>{busy === "verify" ? "正在确认…" : "确认更换并退出旧登录"}</button>
        </form>
      </div>}
    </>}
  </section>;
}
