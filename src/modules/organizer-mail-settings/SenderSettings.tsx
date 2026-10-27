"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, dateText } from "../../components/client-api.ts";
import { Feedback, Field } from "../../components/site-shell.tsx";
import { SenderOrganizationBoundary, type SenderDraftState } from "./boundary.tsx";
import { senderAuthenticationHelp } from "./help.ts";
import { SENDER_EMAIL_LIMIT, SENDER_PASSWORD_LIMIT, SENDER_PROVIDERS, prepareSenderAccountInput, safeSenderMetadata, senderProviderLabels, senderSaveFailureText, type SenderAccountDraft, type SenderAccountMetadata, type SenderProvider } from "./model.ts";
import styles from "./sender-settings.module.css";

export interface SenderSettingsProps { organizationId: string }
export function SenderSettings({ organizationId }: SenderSettingsProps) {
  return <SenderOrganizationBoundary organizationId={organizationId}>{(activeId, onDraft) => <SenderSettingsEditor key={activeId} organizationId={activeId} onDraft={onDraft}/>}</SenderOrganizationBoundary>;
}
const privateFailure = (reason: unknown) => reason instanceof ApiError && [401, 403, 404].includes(reason.status);
function safeReadError(reason: unknown): string {
  return privateFailure(reason) ? "登录或主办方管理权限已变化，发信设置和输入已清除。" : "发信设置读取未完成，请重新读取；当前输入和上次读取的设置已保留。";
}
async function requestSenderMetadata(path: string, options: { method?: "PUT" | "POST"; body?: unknown } = {}): Promise<unknown> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.method ? 30000 : 20000);
  try { return await api<unknown>(path, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function SenderSettingsEditor({ organizationId, onDraft }: SenderSettingsProps & { onDraft: (state: SenderDraftState) => void }) {
  const path = `/organizer/organizations/${encodeURIComponent(organizationId)}/mail-account`;
  const [metadata, setMetadata] = useState<SenderAccountMetadata | null>(null), [draft, setDraft] = useState<SenderAccountDraft>({ provider: "qq", email: "" });
  const [authorizationCode, setAuthorizationCode] = useState(""), [confirmed, setConfirmed] = useState(false), [disableConfirmed, setDisableConfirmed] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState<"save" | "disable" | "">(""), [locked, setLocked] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const alive = useRef(true), cleared = useRef(false), inFlight = useRef(false), readGeneration = useRef(0), initialized = useRef(false), draftTouched = useRef(false);
  const clearPrivate = useCallback(() => { cleared.current = true; readGeneration.current++; setMetadata(null); setDraft({ provider: "qq", email: "" }); setAuthorizationCode(""); setConfirmed(false); setDisableConfirmed(false); setError(""); setNotice(""); setLocked(true); setLoading(false); onDraft({ dirty: false, busy: false }); }, [onDraft]);
  useEffect(() => {
    alive.current = true; window.addEventListener("hackathon:unauthenticated", clearPrivate);
    return () => { alive.current = false; readGeneration.current++; window.removeEventListener("hackathon:unauthenticated", clearPrivate); };
  }, [clearPrivate]);
  const read = useCallback(async () => {
    if (inFlight.current || cleared.current) return;
    const generation = ++readGeneration.current; setLoading(true); setError(""); setNotice(""); setConfirmed(false); setDisableConfirmed(false);
    try {
      const next = safeSenderMetadata(await requestSenderMetadata(path), organizationId);
      if (!alive.current || cleared.current || generation !== readGeneration.current) return;
      setMetadata(next); setNeedsRefresh(false); setDisableConfirmed(false);
      if (!initialized.current && !draftTouched.current) setDraft({ provider: next.provider ?? "qq", email: "" });
      initialized.current = true;
    } catch (reason) { if (alive.current && generation === readGeneration.current && !cleared.current) { if (privateFailure(reason)) clearPrivate(); else { setNeedsRefresh(true); setError(safeReadError(reason)); } } }
    finally { if (alive.current && generation === readGeneration.current && !cleared.current) setLoading(false); }
  }, [path, organizationId, clearPrivate]);
  useEffect(() => { void read(); }, [read]);
  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current || loading || locked || cleared.current || needsRefresh || !metadata || !confirmed) return false;
    let body;
    try { body = prepareSenderAccountInput(metadata.revision, draft, authorizationCode); }
    catch { setError("请核对所选邮箱服务、完整发信邮箱和授权码。授权码内容不会显示在错误信息中。"); return false; }
    inFlight.current = true; setBusy("save"); setError(""); setNotice(""); setAuthorizationCode(""); setConfirmed(false); setDisableConfirmed(false);
    try {
      const next = safeSenderMetadata(await requestSenderMetadata(path, { method: "PUT", body }), organizationId);
      if (!alive.current || cleared.current) return false;
      if (next.state !== "verified" || next.provider !== body.provider || next.revision !== body.expectedRevision + 1) throw new Error("unexpected metadata");
      setMetadata(next); setDraft({ provider: next.provider, email: "" }); draftTouched.current = false; setNeedsRefresh(false);
      setNotice("SMTP 连接与认证已验证，发信邮箱已保存。没有向选手发送测试邮件；之后发布本主办方的比赛通知时采用此设置。"); return true;
    } catch (reason) {
      if (alive.current && !cleared.current) {
        if (privateFailure(reason)) clearPrivate();
        else { setNeedsRefresh(true); setError(senderSaveFailureText(reason instanceof ApiError ? { status: reason.status, code: reason.code } : undefined)); }
      }
      return false;
    } finally { inFlight.current = false; if (alive.current) setBusy(""); }
  }, [authorizationCode, confirmed, metadata, draft, loading, locked, needsRefresh, path, organizationId, clearPrivate]);
  async function disable() {
    if (inFlight.current || loading || locked || cleared.current || needsRefresh || !metadata || metadata.state !== "verified" || !disableConfirmed) return;
    const expectedRevision = metadata.revision; inFlight.current = true; setBusy("disable"); setError(""); setNotice(""); setAuthorizationCode(""); setConfirmed(false);
    try {
      const next = safeSenderMetadata(await requestSenderMetadata(`${path}/disable`, { method: "POST", body: { expectedRevision } }), organizationId);
      if (!alive.current || cleared.current) return;
      if (next.state !== "disabled" || next.revision !== expectedRevision + 1) throw new Error("unexpected metadata");
      setMetadata(next); setDraft({ provider: next.provider ?? "qq", email: "" }); draftTouched.current = false; setDisableConfirmed(false); setNeedsRefresh(false);
      setNotice("自配发信邮箱已停用，后续本主办方的比赛通知回到网站邮箱。网站邮箱能否发送以平台当前配置为准。");
    } catch (reason) { if (alive.current && !cleared.current) { if (privateFailure(reason)) clearPrivate(); else { setNeedsRefresh(true); setDisableConfirmed(false); setError("停用结果尚未确认，请读取最新设置后核对。不会自动再次停用或验证账号。"); } } }
    finally { inFlight.current = false; if (alive.current) setBusy(""); }
  }
  const dirty = Boolean(draft.email || authorizationCode || draftTouched.current || confirmed || disableConfirmed);
  useEffect(() => { onDraft({ dirty: !locked && (dirty || Boolean(busy)), busy: !locked && Boolean(busy), ...(dirty && confirmed && authorizationCode && !busy && !needsRefresh && !loading && !locked ? { save } : {}) }); }, [onDraft, dirty, busy, confirmed, authorizationCode, needsRefresh, loading, locked, save]);
  function patch(values: Partial<SenderAccountDraft>) { draftTouched.current = true; setDraft(current => ({ ...current, ...values })); setAuthorizationCode(""); setConfirmed(false); setError(""); setNotice(""); }
  const profile = metadata?.profiles.find(item => item.id === draft.provider);
  return <section className={styles.panel} aria-label="主办方发信邮箱设置">
    <p className={styles.kicker}>当前主办方 · 机构管理员</p><h2>设置自己的发信邮箱</h2>
    <p className={styles.muted}>此设置用于本主办方各场比赛的官方通知与入选通知。默认使用网站邮箱；登录验证码始终由网站邮箱发送。</p>
    {locked ? <div className={styles.status}><p>登录或主办方管理权限已变化，发信设置与输入已清除。请重新打开有管理权限的主办方后继续。</p><a className={styles.secondary} href={`/login?returnTo=${encodeURIComponent("/organizers/workspace")}`}>登录并返回办赛工作台</a></div> : <>
      <Feedback error={error} notice={notice}/>{loading && <p className={styles.muted} role="status">正在读取当前主办方的发信设置…</p>}
      {metadata && <div className={styles.status}><strong>{(needsRefresh || loading || busy) && "上次读取的设置 · "}{metadata.state === "verified" ? "使用主办方自配邮箱" : metadata.state === "disabled" ? "自配邮箱已停用 · 使用网站邮箱" : "尚未设置自己的邮箱 · 使用网站邮箱"}</strong>
        {metadata.state === "verified" && <><p>{metadata.provider && senderProviderLabels[metadata.provider]} · {metadata.maskedEmail || "邮箱已脱敏"}</p><p className={styles.muted}>认证验证于 {dateText(metadata.verifiedAt)}。认证通过不等于通知已发送或已送达。</p></>}
        <p className={styles.muted}>设置版本 {metadata.revision}{metadata.updatedAt && ` · 更新于 ${dateText(metadata.updatedAt)}`}。读取只显示脱敏信息，授权码不会回显。{metadata.state !== "verified" && "网站邮箱能否发送以平台当前配置为准。"}</p>
      </div>}
      <div className={styles.actions}><button type="button" className={styles.secondary} disabled={loading || Boolean(busy)} onClick={() => void read()}>{loading ? "正在读取…" : "读取最新设置，保留邮箱输入"}</button></div>
      {metadata && <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
        <h3>{metadata.state === "verified" ? "更换发信账号" : "添加发信账号"}</h3>
        <fieldset className={styles.boundary} disabled={loading || Boolean(busy)}><div className={styles.form}>
          <Field label="邮箱服务" hint="选择实际拥有的 QQ、163、126 或 Gmail 邮箱。服务器按所选服务连接，不需自己填写 SMTP 地址。"><select value={draft.provider} onChange={event => patch({ provider: event.target.value as SenderProvider })}>{SENDER_PROVIDERS.map(id => <option key={id} value={id}>{senderProviderLabels[id]}</option>)}</select></Field>
          <Field label="完整发信邮箱" hint="必填。填写主办方拥有且已开启发信服务的完整地址。QQ 格式为你的号码@qq.com，其他服务使用对应 @163.com、@126.com 或 @gmail.com 地址；脱敏邮箱不能直接提交。"><input type="email" required maxLength={SENDER_EMAIL_LIMIT} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.email} onChange={event => patch({ email: event.target.value })}/></Field>
          <Field label={draft.provider === "gmail" ? "Gmail 应用专用密码" : "邮箱 SMTP 授权码"} hint={draft.provider === "gmail" ? "必填。填写开启两步验证后为本网站生成的 Gmail 应用专用密码；不是 Gmail 登录密码或短信验证码。验证成功后加密保存，不会回显。" : "必填。填写在所选邮箱设置中开启 SMTP 后生成的授权码；不是邮箱登录密码或网站验证码。验证成功后加密保存，不会回显；提交后输入框清除。"}><input type="password" required maxLength={SENDER_PASSWORD_LIMIT} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={authorizationCode} onChange={event => { setAuthorizationCode(event.target.value); setConfirmed(false); setError(""); setNotice(""); }}/></Field>
          {profile?.note && <p className={styles.muted}>{profile.note}</p>}
          <AuthenticationHelp provider={draft.provider}/>
          <p className={styles.hint}>保存只验证 SMTP 连接和认证，不会向选手发送邮件。只有验证及当前权限检查成功，才会采用此邮箱。</p>
          <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>我确认用此邮箱发送本主办方的赛事通知，并同意验证连接和认证。</label>
        </div></fieldset>
        {needsRefresh && <p className={styles.hint}>先读取最新设置核对，再填写授权码并确认保存。</p>}
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={!confirmed || !authorizationCode || needsRefresh || loading || Boolean(busy)}>{busy === "save" ? "正在验证并保存…" : "验证并保存发信邮箱"}</button></div>
      </form>}
      <p className={styles.muted}>Outlook 暂不支持此授权码方式。未配置自有账号时，若网站已配置发信服务，则使用网站邮箱；否则只发布站内通知。</p>
      {metadata?.state === "verified" && <details className={styles.details}><summary>停用自配邮箱</summary><p>停用后，后续通知回到网站发信服务；若网站未配置邮箱，则只发布站内通知。已保存的通知与邮件回执保留。</p>
        <label className={styles.check}><input type="checkbox" checked={disableConfirmed} disabled={Boolean(busy) || loading || needsRefresh} onChange={event => setDisableConfirmed(event.target.checked)}/>确认停用当前自配发信账号</label>
        <button type="button" className={styles.secondary} disabled={!disableConfirmed || Boolean(busy) || loading || needsRefresh} onClick={() => void disable()}>{busy === "disable" ? "正在停用…" : "停用自配邮箱，使用网站邮箱"}</button>
      </details>}
    </>}
  </section>;
}
function AuthenticationHelp({ provider }: { provider: SenderProvider }) {
  const help = senderAuthenticationHelp[provider];
  return <div className={styles.muted}><p>{help.text} <a className={styles.link} href={help.href} target="_blank" rel="noopener noreferrer">{help.label}</a></p></div>;
}
