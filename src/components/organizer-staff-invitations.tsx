"use client";

import { useState } from "react";
import { ApiError, api, dateText, message, useApi } from "./client-api.ts";
import { Field, Loading } from "./site-shell.tsx";
import styles from "./competition-workspace.module.css";

const capabilityLabels: Record<string, string> = {
  event_manage: "比赛规则与发布", registration_manage: "报名审核", teams_manage: "队伍管理",
  communication_manage: "通知与答疑", schedule_manage: "行程管理", logistics_manage: "现场服务", judging_manage: "收件与评审",
};
const capabilityKeys = Object.keys(capabilityLabels);
type InvitationRole = "staff" | "organization_admin";

interface InvitationView {
  readonly id: string; readonly role: InvitationRole; readonly capabilities: readonly string[];
  readonly status: "open" | "claimed" | "revoked" | "expired"; readonly expiresAt: string;
  readonly emailBound: boolean; readonly boundEmailMasked: string | null;
  readonly claimedAt: string | null; readonly revokedAt: string | null;
  readonly createdAt: string; readonly note: string; readonly revision: number;
  readonly eventId: string | null; readonly eventTitle: string | null;
}
interface InvitationPreview {
  readonly organizationName: string; readonly eventTitle: string | null; readonly role: InvitationRole;
  readonly capabilities: readonly string[]; readonly status: "open" | "claimed" | "revoked" | "expired";
  readonly expiresAt: string; readonly emailBound: boolean; readonly boundEmailMasked: string | null; readonly claimable: boolean;
}

/**
 * 规划34 A：受限邀请的**生成与撤销**面板（机构管理员）。
 *
 * 链接只显示一次：token 只在这里出现，列表接口从不回显；不能"点开即授权"，必须登录且邮箱已验证并核对绑定邮箱。
 */
export function OrganizerStaffInvitations({ organizationId }: { organizationId: string }) {
  const base = `/organizer/organizations/${encodeURIComponent(organizationId)}/staff-invitations`;
  const list = useApi<readonly InvitationView[]>(base);
  const [role, setRole] = useState<InvitationRole>("staff");
  const [picked, setPicked] = useState<readonly string[]>(["registration_manage"]);
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [boundEmail, setBoundEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [issued, setIssued] = useState("");
  if (list.error instanceof ApiError && (list.error.status === 403 || list.error.status === 404)) return null;
  if (list.error) return <p role="alert">邀请列表暂时没有读到：{list.error.message} <button type="button" className={styles.secondary} onClick={() => void list.reload()}>重新读取</button></p>;
  const capabilities = role === "organization_admin" ? capabilityKeys : picked;
  async function issue() {
    if (busy) return;
    setBusy(true); setFailure(""); setIssued("");
    try {
      const created = await api<{ invitation: InvitationView; token: string }>(base, { method: "POST", body: {
        role, capabilities, expiresInDays: Number(expiresInDays) || 7,
        ...(boundEmail.trim() ? { boundEmail: boundEmail.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      } });
      setIssued(`${window.location.origin}/my/staff-invitations/${created.token}`);
      setNote(""); setBoundEmail("");
      await list.reload();
    } catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  async function revoke(invitation: InvitationView) {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await api(`/organizer/staff-invitations/${encodeURIComponent(invitation.id)}/revoke`, { method: "POST", body: { expectedRevision: invitation.revision } }); await list.reload(); }
    catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  return <details className={styles.details} aria-label="工作人员与授权">
    <summary>工作人员与授权（受限邀请）</summary>
    <p className={styles.muted}>邀请链接**单次使用、有期限、可撤销、可绑定指定邮箱**；对方必须登录且邮箱已验证并核对绑定邮箱后才能领取。平台不做「点开即授权」。</p>
    <Field label="角色"><select value={role} disabled={busy} onChange={change => setRole(change.target.value as InvitationRole)}>
      <option value="staff">本场工作人员（可指定能力）</option>
      <option value="organization_admin">机构管理员（全部能力，机构范围）</option>
    </select></Field>
    {role === "staff" && <fieldset disabled={busy}><legend>能力（按需勾选）</legend>
      {capabilityKeys.map(key => <label className={styles.check} key={key}><input type="checkbox" checked={picked.includes(key)} onChange={change => setPicked(previous => change.target.checked ? [...previous, key] : previous.filter(item => item !== key))}/><span>{capabilityLabels[key]}</span></label>)}
    </fieldset>}
    <Field label="有效期（天，1–30）"><input type="number" min={1} max={30} value={expiresInDays} disabled={busy} onChange={change => setExpiresInDays(change.target.value)}/></Field>
    <Field label="绑定邮箱（可选）" hint="填了就只允许这个已验证邮箱领取。"><input type="email" value={boundEmail} disabled={busy} onChange={change => setBoundEmail(change.target.value)}/></Field>
    <Field label="备注（可选，不展示给领取人）"><input value={note} disabled={busy} onChange={change => setNote(change.target.value)}/></Field>
    <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => void issue()}>{busy ? "正在生成…" : "生成邀请链接"}</button></div>
    {failure && <p role="alert">{failure}</p>}
    {issued && <p role="status">链接只显示这一次，请现在复制：<code>{issued}</code></p>}
    {!list.data ? <Loading/> : list.data.length === 0 ? <p className={styles.muted}>还没有发出过邀请。</p>
      : <ul>{list.data.map(item => <li key={item.id}>
        <strong>{item.role === "organization_admin" ? "机构管理员" : "本场工作人员"}</strong>
        <span className={styles.muted}> · {item.capabilities.map(key => capabilityLabels[key] ?? key).join("、")}</span>
        <p className={styles.muted}>状态：{item.status === "open" ? "待领取" : item.status === "claimed" ? "已领取" : item.status === "revoked" ? "已撤销" : "已过期"} · 有效期至 {dateText(item.expiresAt)}{item.emailBound ? ` · 绑定邮箱 ${item.boundEmailMasked ?? ""}` : ""}{item.eventTitle ? ` · ${item.eventTitle}` : " · 机构范围"}</p>
        {item.status === "open" && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => void revoke(item)}>撤销邀请</button></div>}
      </li>)}</ul>}
  </details>;
}

/** 规划34 A：领取页 `/my/staff-invitations/<token>`——必须是已登录且邮箱已验证的账号，领取只写既有 StaffGrant。 */
export function StaffInvitationClaim({ token }: { token: string }) {
  const base = `/my/staff-invitations/${encodeURIComponent(token)}`;
  const preview = useApi<InvitationPreview>(base);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [done, setDone] = useState(false);
  if (preview.error) return <section className={styles.notice}><h1>这个邀请不可用</h1><p>{preview.error.message}</p><p><a href="/organizers">回到主办方入口</a></p></section>;
  if (!preview.data) return <Loading/>;
  const view = preview.data;
  async function claim() {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await api(`${base}/claim`, { method: "POST", body: {} }); setDone(true); }
    catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  return <section className={styles.card} aria-label="工作人员邀请">
    <h1>你被邀请加入「{view.organizationName}」</h1>
    <p>{view.eventTitle ? `本场：${view.eventTitle}` : "机构范围（适用于该机构下所有比赛）"}</p>
    <p>角色：{view.role === "organization_admin" ? "机构管理员" : "本场工作人员"}</p>
    <p>能力：{view.capabilities.map(key => capabilityLabels[key] ?? key).join("、")}</p>
    <p>有效期至：{dateText(view.expiresAt)}</p>
    {view.emailBound && <p>此邀请绑定了邮箱 {view.boundEmailMasked ?? ""}；请用该已验证邮箱的账号领取。</p>}
    <p className={styles.muted}>领取后权限来自既有工作人员授权；平台不做「点开即授权」，也不会把邀请链接本身当作权限。</p>
    {done ? <p role="status">已领取。你可以从「主办方工作台」进入本场工作。</p>
      : view.claimable ? <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => void claim()}>{busy ? "正在领取…" : "接受邀请"}</button></div>
      : <p role="alert">这个邀请当前不可领取（{view.status === "claimed" ? "已被领取" : view.status === "revoked" ? "已被撤销" : "已过期"}）。</p>}
    {failure && <p role="alert">{failure}</p>}
  </section>;
}
