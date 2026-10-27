"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicInvitation } from "../modules/projects/model.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import { ApiError, api, dateText, isUnknownAiOutcome, message, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading } from "./site-shell.tsx";
import { InvitationQr } from "./invitation-qr.tsx";
import styles from "./site.module.css";
import invitationStyles from "./space-invitation.module.css";

interface InvitationMutation { invitation: PublicInvitation; projectRevision: number }
interface IssuedInvitation { invitation: PublicInvitation; link: string }
const accessUnavailable = (reason: unknown) => reason instanceof ApiError && [401, 403, 404].includes(reason.status);
const unknownOutcome = (reason: unknown) => isUnknownAiOutcome(reason) || reason instanceof ApiError && reason.code === "INVALID_RESPONSE";

/** The raw token stays in this mounted view only; the server owns quota and acceptance. */
export function SpaceInvitation({ detail, onChanged }: { detail: ProjectDetail; onChanged: () => Promise<void> }) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}/invitations`;
  const readonly = detail.membership.role !== "manager" || detail.membership.status !== "active" || detail.project.stage === "archived";
  const list = useApi<PublicInvitation[]>(readonly ? null : base);
  const [email, setEmail] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const [revision, setRevision] = useState(detail.project.revision);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [accessError, setAccessError] = useState<Error | null>(null);
  const [notice, setNotice] = useState("");
  const [unknownCreation, setUnknownCreation] = useState(false);
  const [unknownChecked, setUnknownChecked] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [custom, setCustom] = useState(false);
  const permissionLost = accessUnavailable(accessError) || accessUnavailable(list.error);
  const currentInvitation = issued && (list.data?.find(item => item.id === issued.invitation.id) ?? issued.invitation);
  const activeLink = issued && currentInvitation?.displayStatus === "pending" && Date.parse(currentInvitation.expiresAt) > Date.now() ? issued.link : "";
  const disabled = readonly || permissionLost || pending;

  useEffect(() => { setRevision(previous => Math.max(previous, detail.project.revision)); }, [detail.project.revision]);
  useEffect(() => {
    if (readonly || permissionLost) { setIssued(null); setEmail(""); }
  }, [readonly, permissionLost]);

  async function refreshAfterChange() {
    try { await onChanged(); } catch (reason) { setError(`邀请操作已保存，但空间信息未能刷新：${message(reason)} 请读取最新邀请状态。`); }
    await list.reload();
  }

  async function readLatest() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const latest = await api<PublicInvitation[]>(base);
      list.setData(latest);
      await onChanged();
      setUnknownChecked(true);
      setNotice(unknownCreation ? "已读取邀请记录。若出现刚才新建的邀请，原链接无法从记录恢复；可先撤销，再明确生成新链接。" : "已读取最新邀请状态。");
    } catch (reason) { setError(message(reason)); if (accessUnavailable(reason)) setAccessError(reason as Error); }
    finally { busy.current = false; setPending(false); }
  }

  return <section className={invitationStyles.content} aria-label="邀请链接与二维码">
    <p className={styles.muted}>复制到微信、QQ，或让身边的队友扫码。队友登录并明确接受后，以普通成员加入。</p>
    {issued && currentInvitation && <div className={invitationStyles.issued}>
      {activeLink ? <>
        <h3>邀请链接已生成</h3>
        <p>最多 {currentInvitation.maxUses} 人 · 已加入 {currentInvitation.usedUses} 人 · 剩余 {currentInvitation.remainingUses} 个名额</p>
        <p className={styles.muted}>有效至 {dateText(currentInvitation.expiresAt)}。链接与二维码共用同一名额；使用情况以最新读取为准。</p>
        <button type="button" className={`${styles.button} ${invitationStyles.primary}`} disabled={disabled} onClick={async () => {
          setError(""); setNotice("");
          try { await navigator.clipboard.writeText(activeLink); setNotice("邀请链接已复制，可粘贴到微信或 QQ。"); }
          catch { setError("复制失败，请选中下方链接手动复制。"); }
        }}>复制邀请链接</button>
        <Field label="本次邀请链接"><input value={activeLink} readOnly onFocus={event => event.target.select()}/></Field>
        <p className={styles.muted}>关闭弹窗再打开会保留本次链接。离开或刷新页面后无法找回，请及时复制；丢失后可撤销旧邀请并生成新链接。</p>
        <details className={invitationStyles.disclosure}><summary className={styles.summary}>展示同一链接的二维码</summary><InvitationQr value={activeLink}/></details>
      </> : <p className={styles.notice}>本次邀请已撤销、到期或名额已用完，请生成新链接。已加入的成员不会因此退出。</p>}
    </div>}
    <Feedback error={error} notice={notice}/>
    {unknownCreation && <div className={styles.notice}>
      <p>刚才的生成结果尚未确认。请先读取邀请记录，避免重复创建；记录只保存邀请状态，不能恢复原链接。</p>
      <button type="button" className={styles.secondary} disabled={disabled} onClick={() => { setShowHistory(true); void readLatest(); }}>核对刚才的邀请记录</button>
    </div>}
    <form className={styles.form} noValidate onSubmit={async event => {
      event.preventDefault();
      if (busy.current || readonly || permissionLost || (unknownCreation && !unknownChecked)) return;
      const count = Number(maxUses);
      if (!Number.isInteger(count) || count < 1 || count > 50) { setCustom(true); setError("邀请人数需为 1–50 的整数。"); return; }
      busy.current = true; setPending(true); setError(""); setNotice("");
      try {
        const result = await api<InvitationMutation & { token: string }>(base, { method: "POST", body: {
          expectedRevision: revision, role: "member", maxUses: count, invitedEmail: email.trim() || null,
        } });
        if (!result.invitation?.id || !result.token) throw new Error("服务未返回完整的邀请记录，请先核对生成结果。");
        setIssued({ invitation: result.invitation, link: `${window.location.origin}/app/join/${encodeURIComponent(result.token)}` });
        setRevision(result.projectRevision); setEmail(""); setUnknownCreation(false); setUnknownChecked(false);
        list.setData([...(list.data ?? []), result.invitation]);
        setNotice(`已生成最多邀请 ${result.invitation.maxUses} 位新成员的链接。请复制给队友。`);
        await refreshAfterChange();
      } catch (reason) {
        setError(message(reason));
        if (accessUnavailable(reason)) setAccessError(reason as Error);
        if (unknownOutcome(reason)) { setUnknownCreation(true); setUnknownChecked(false); setShowHistory(true); }
      } finally { busy.current = false; setPending(false); }
    }}>
      <fieldset className={invitationStyles.quota} disabled={disabled}>
        <legend>最多通过这条链接新加入的人数</legend>
        <div className={invitationStyles.presets}>{[1, 3, 5].map(count => <button className={styles.secondary} type="button" key={count} aria-pressed={maxUses === String(count)} onClick={() => { setMaxUses(String(count)); setCustom(false); }}>{count} 人</button>)}</div>
        <details className={invitationStyles.disclosure} open={custom} onToggle={event => setCustom(event.currentTarget.open)}><summary className={styles.summary}>自定义人数</summary>
          <Field label="自定义人数（1–50）" hint="活跃成员不占名额；退出或移除后，已使用名额不返还。"><input type="number" min={1} max={50} step={1} value={maxUses} onChange={event => setMaxUses(event.target.value)}/></Field>
        </details>
      </fieldset>
      <details className={invitationStyles.disclosure}><summary className={styles.summary}>更多设置</summary>
        <Field label="限定队友邮箱（选填）" hint="队友需用这个已验证邮箱接受；人数增大不会放宽邮箱限制。"><input type="email" value={email} disabled={disabled} onChange={event => setEmail(event.target.value)} maxLength={320}/></Field>
      </details>
      <p className={styles.muted}>默认 72 小时有效，可随时撤销。生成新链接不会自动撤销旧邀请。</p>
      <button className={activeLink ? styles.secondary : styles.button} disabled={disabled || (unknownCreation && !unknownChecked)}>{pending ? "正在处理…" : unknownCreation ? "已核对记录，生成新邀请" : issued ? "生成另一条邀请" : "生成邀请链接"}</button>
    </form>
    <details className={invitationStyles.history} open={showHistory} onToggle={event => setShowHistory(event.currentTarget.open)}><summary className={styles.summary}>邀请记录</summary>
      <p className={styles.muted}>记录可核对名额、有效期和撤销状态，无法找回原始链接。</p>
      <Feedback error={list.error}/>{list.loading && !list.data && <Loading/>}
      <button type="button" className={styles.secondary} disabled={disabled || list.loading} onClick={() => void readLatest()}>读取最新邀请状态</button>
      {list.data?.length === 0 && !list.error && <Empty>还没有邀请。一个人也能直接选择职责和安排任务。</Empty>}
      <ul className={styles.list}>{list.data?.map(invitation => <li key={invitation.id}>
        <strong>{({ pending: "等待接受", accepted: "名额已用完", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[invitation.displayStatus] ?? invitation.displayStatus}</strong>
        {issued?.invitation.id === invitation.id && <span className={styles.tag}>本次链接</span>}
        <p className={styles.muted}>{invitation.role === "manager" ? "历史管理员邀请" : "普通成员邀请"} · 生成 {dateText(invitation.createdAt)} · 到期 {dateText(invitation.expiresAt)}</p>
        <p>最多 {invitation.maxUses} 人 · 已加入 {invitation.usedUses} 人 · 剩余 {invitation.remainingUses} 个名额</p>
        {invitation.displayStatus === "pending" && <button type="button" className={styles.secondary} disabled={disabled} onClick={async () => {
          if (busy.current) return;
          busy.current = true; setPending(true); setError(""); setNotice("");
          try {
            const result = await api<InvitationMutation>(`${base}/${encodeURIComponent(invitation.id)}`, { method: "DELETE", body: { expectedRevision: revision } });
            setRevision(result.projectRevision);
            setIssued(previous => previous?.invitation.id === result.invitation.id ? null : previous);
            list.setData((list.data ?? []).map(item => item.id === result.invitation.id ? result.invitation : item));
            setNotice("这条邀请已撤销，其链接和二维码不能再接受。其他邀请不受影响。");
            await refreshAfterChange();
          } catch (reason) {
            if (accessUnavailable(reason)) setAccessError(reason as Error);
            setError(unknownOutcome(reason) ? `${message(reason)} 撤销结果尚未确认，请读取最新邀请状态后核对。` : message(reason));
          }
          finally { busy.current = false; setPending(false); }
        }}>撤销这条邀请</button>}
      </li>)}</ul>
    </details>
    {permissionLost && <p className={styles.notice}>当前无法访问邀请记录，本页链接已清除、邀请操作已停用。请重新进入空间核对账号与权限。</p>}
    {readonly && <p className={styles.muted}>只有当前空间管理员能邀请队友；归档空间只读。</p>}
  </section>;
}
