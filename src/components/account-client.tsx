"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AccountSettings, SessionSummary } from "../modules/auth/types.ts";
import { api, dateText, useApi } from "./client-api.ts";
import { Feedback, Field, Loading, PageTitle, SiteShell, type Me } from "./site-shell.tsx";
import { useAction } from "./workflow.tsx";
import { GitHubConnection } from "./github-connection.tsx";
import { ParticipantProfileForm } from "./participant-profile.tsx";
import { RecruitingProfileEditor } from "../modules/recruiting/RecruitingProfileEditor.tsx";
import { AccountSelfService } from "./account-self-service.tsx";
import styles from "./site.module.css";

export function AccountClient() {
  const identity = useApi<Me>("/me"); const permissions = useApi<{platformRoles:string[]}>("/me/permissions"); const settings = useApi<AccountSettings>("/me/account-settings"); const sessions = useApi<{ sessions: SessionSummary[] }>("/me/sessions"); const action = useAction();
  const [allConfirmed, setAllConfirmed] = useState(false);
  const [eventId, setEventId] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  useEffect(() => { const ids = new URLSearchParams(window.location.search).getAll("event"); if (ids.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(ids[0]!)) setEventId(ids[0]!); }, []);
  const dsh = useApi<{id:string;provider:"dsh";createdAt:string;busy:boolean}>(identity.data ? "/me/dsh-session" : null);
  return <SiteShell><PageTitle title="账号与登录设备">管理昵称、时区、登录设备和本人资料。更换登录邮箱时，需要同时验证当前邮箱和新邮箱。</PageTitle>{eventId && <div className={styles.notice}><p>{profileSaved ? "个人参赛资料已保存。回到刚才的比赛，核对资料后再生成计划。" : "你正在补充刚才所选比赛的个人参赛资料。保存后可以从这里返回。"}</p><Link className={styles.link} href={`/participation?event=${encodeURIComponent(eventId)}`}>返回所选比赛，继续制定计划 →</Link></div>}<Feedback error={identity.error ?? settings.error ?? sessions.error ?? action.error} notice={action.notice}/>{identity.loading && <Loading/>}
    {identity.data && <ProfileForm key={`profile:${identity.data.profile.id}`} me={identity.data} reload={identity.reload}/>}
    {identity.data && <details className={styles.panel} id="recruiting-profile"><summary className={styles.summary}>参赛职责、目标与组队名片</summary><p>选自己想承担的工作、参赛目的和已有经历。私人资料供本人助手使用；头像、年龄和 MBTI 可不填，公开名片需要你单独确认。</p><RecruitingProfileEditor loginHref="/login?returnTo=%2Fapp%2Faccount"/></details>}
    {identity.data && <><section className={styles.panel}><h2>我的 DSH 工作台</h2><p>本账号的对话、参赛计划、路演讲稿和 PPT 大纲单独保存，可换设备继续查看。</p><Feedback error={dsh.error}/>{dsh.data&&<p className={styles.muted}>会话 {dsh.data.id.slice(0,8)} · {dsh.data.busy ? "正在处理请求" : "可以继续使用"}</p>}<div className={styles.actions}><Link href="/participation" className={styles.secondary}>查看参赛计划</Link><Link href="/roadshow" className={styles.secondary}>准备路演</Link><Link href="/ppt" className={styles.secondary}>制作 PPT</Link></div></section><ParticipantProfileForm requireForPlan={Boolean(eventId)} onSaved={() => setProfileSaved(true)}/></>}
    <section className={styles.panel}><h2>当前登录设备</h2><ul className={styles.list}>{sessions.data?.sessions.map(session => <li key={session.id}><strong>{session.current ? "当前会话" : "其他会话"}</strong><p>登录于 {dateText(session.authenticatedAt)} · 到期 {dateText(session.expiresAt)}</p><button className={styles.secondary} disabled={action.busy} onClick={() => void action.run(async () => { await api("/me/sessions/revoke", { method: "POST", body: { sessionId: session.id } }); if (session.current) window.location.assign("/login"); else await sessions.reload(); }, "该会话已退出。")}>退出此会话</button></li>)}</ul></section>
    <section className={styles.panel}><h2>退出全部登录设备</h2><p className={styles.muted}>需要近期完成邮箱验证。{settings.data && <>服务端确认近期认证有效至 {dateText(settings.data.recentAuthenticationUntil)}，当前{settings.data.canLogoutAll ? "允许退出全部设备" : "需要重新登录认证"}。</>}</p><label className={styles.check}><input type="checkbox" checked={allConfirmed} onChange={event => setAllConfirmed(event.target.checked)}/>确认让所有设备重新登录。</label><button className={styles.secondary} disabled={action.busy || !allConfirmed || !settings.data?.canLogoutAll} onClick={() => void action.run(async () => { await api("/auth/logout-all", { method: "POST" }); window.location.assign("/login"); })}>退出所有设备</button></section>
    {permissions.data?.platformRoles.some(role=>["admin","reviewer"].includes(role))&&<p><Link href="/admin" className={styles.link}>打开运营工作台：来源、赛事、资源与题组审核</Link></p>}
    {identity.data && <AccountSelfService key={`self-service:${identity.data.profile.id}`} profile={identity.data.profile}/>}
    {identity.data && <GitHubConnection/>}
  </SiteShell>;
}
function ProfileForm({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const [name, setName] = useState(me.profile.displayName); const [zone, setZone] = useState(me.profile.timezone); const action = useAction();
  return <section className={styles.panel}><h2>本人资料</h2><p className={styles.muted}>{me.profile.email}</p><form className={styles.form} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api("/me", { method: "PATCH", body: { expectedRevision: me.profile.revision, displayName: name, timezone: zone } }); await reload(); }, "资料已保存。碰到版本冲突时，你的本地输入会保留。"); }}><Field label="昵称"><input required maxLength={80} value={name} disabled={action.busy} onChange={event => setName(event.target.value)}/></Field><Field label="IANA 时区"><input required value={zone} disabled={action.busy} onChange={event => setZone(event.target.value)} placeholder="Asia/Shanghai"/></Field><Feedback error={action.error} notice={action.notice}/><button className={styles.button} disabled={action.busy}>保存本人资料</button></form></section>;
}
