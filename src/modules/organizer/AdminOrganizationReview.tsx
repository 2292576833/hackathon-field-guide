"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, dateText, message, safeLink, useApi } from "../../components/client-api.ts";
import { Field } from "../../components/site-shell.tsx";
import type { OrganizationApplication, ReviewApplicationInput } from "./model.ts";
import styles from "./organizer.module.css";

export interface AdminOrganizationReviewProps { readonly onReviewed?: (application: OrganizationApplication) => void }
const STATUS = { pending: "待审核", approved: "已通过", rejected: "已退回", suspended: "已停用" } as const;
function ApplicationReview({ application, onReviewed }: { application: OrganizationApplication; onReviewed: (application: OrganizationApplication) => Promise<void> }) {
  const decisions: readonly ReviewApplicationInput["decision"][] = application.status === "approved" ? ["suspended"] : application.status === "rejected" ? [] : ["approved", "rejected"];
  const [decision, setDecision] = useState<ReviewApplicationInput["decision"]>(decisions[0] ?? "approved"), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setDecision(application.status === "approved" ? "suspended" : "approved"); }, [application.status]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<OrganizationApplication>(`/admin/organizer/applications/${encodeURIComponent(application.id)}/review`, { method: "POST", body: { expectedRevision: application.revision, decision, note } satisfies ReviewApplicationInput }); await onReviewed(result); setNote(""); }
    catch (reason) { setError(`${message(reason)} 审核意见已保留；如申请已更新，请刷新核对后再次提交。`); }
    finally { setBusy(false); }
  }
  return <article className={styles.panel}><div className={`${styles.row} ${styles.between}`}><h3>{application.name}</h3><span className={styles.badge}>{STATUS[application.status]}</span></div>
    <p className={styles.muted}>{application.kind === "school" ? "学校" : application.kind === "company" ? "公司" : "社区"} · 申请版本 {application.revision} · {dateText(application.updatedAt)}</p>
    <p className={styles.rules}>{application.description}</p><div className={styles.scope}><p>联系人：{application.contactName}</p><p>邮箱：{application.contactEmail}</p><p className={styles.muted}>联系信息仅用于审核，不进入公开赛事页面。</p></div>
    <h4>活动或授权依据</h4><p className={styles.rules}>{application.evidenceText}</p>
    {application.evidenceUrls.length > 0 && <ul className={styles.list}>{application.evidenceUrls.map(url => { const href = safeLink(url); return <li key={url}>{href?.startsWith("https://") ? <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">{url}</a> : <span>链接格式无效，请要求申请人补充。</span>}</li>; })}</ul>}
    {application.reviewNote && <p className={styles.todo}>上次审核意见：{application.reviewNote}</p>}
    {application.status === "rejected" ? <p className={styles.todo}>等待申请人补充并重新送审。退回申请不能由审核人员直接改为通过。</p> : <form className={styles.stack} onSubmit={submit}><Field label="审核结果" hint="选择实际处理结果：通过开通办赛权限，退回要求补充材料，停用暂停机构运营。请先核对机构及申请人身份。"><select value={decision} onChange={event => setDecision(event.target.value as ReviewApplicationInput["decision"])}>{decisions.map(item => <option key={item} value={item}>{item === "approved" ? application.status === "suspended" ? "恢复机构运营" : "通过入驻" : item === "rejected" ? "退回补充 / 拒绝" : "停用机构"}</option>)}</select></Field>
      <Field label="审核意见" hint="必填。记录核实依据；退回时明确缺少哪项和如何补充，例如“请提供能证明活动授权的机构公开介绍页”。停用或恢复时写明原因。"><textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} required/></Field>
      {decision === "suspended" && <p className={styles.todo}>停用会暂停该机构的赛事操作。已有公开规则和参赛记录仍保留。</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}<div className={styles.actions}><button className={decision === "suspended" ? styles.danger : styles.button} type="submit" disabled={busy}>{busy ? "正在提交审核…" : "确认审核结果"}</button></div>
    </form>}
  </article>;
}
export function AdminOrganizationReview({ onReviewed }: AdminOrganizationReviewProps) {
  const applications = useApi<OrganizationApplication[]>("/admin/organizer/applications");
  const [filter, setFilter] = useState("pending"), [notice, setNotice] = useState("");
  const visible = applications.data?.filter(application => filter === "all" || application.status === filter) ?? [];
  return <section className={styles.surface} aria-label="机构入驻人工审核"><div className={styles.panel}><h2>机构入驻审核</h2><p className={styles.muted}>核对机构身份与申请人授权。平台管理员不能审核自己的申请；通过入驻只确认身份。</p>
    <div className={styles.grid}><Field label="审核队列" hint="按申请状态筛选；待审核是当前需要处理的新申请，其他选项用于复核历史。"><select value={filter} onChange={event => setFilter(event.target.value)}><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已退回</option><option value="suspended">已停用</option><option value="all">全部申请</option></select></Field><div className={styles.actions}><button className={styles.secondary} type="button" disabled={applications.loading} onClick={() => void applications.reload()}>刷新队列</button></div></div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{applications.loading && <p role="status" className={styles.muted}>正在读取审核队列…</p>}{applications.error && <p role="alert" className={styles.error}>{applications.error.message}</p>}
    {applications.data && !visible.length && <p className={styles.muted}>当前队列没有申请。</p>}</div>
    {visible.map(application => <ApplicationReview key={application.id} application={application} onReviewed={async result => { setNotice(`${result.name}：${STATUS[result.status]}，审核结果已保存。`); await applications.reload(); onReviewed?.(result); }}/>)}</section>;
}
