"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, dateText, message } from "../../components/client-api.ts";
import { Field } from "../../components/site-shell.tsx";
import type { OrganizerClaimRequest, ReviewClaimInput } from "./model.ts";
import styles from "./organizer.module.css";

export interface AdminClaimReviewProps { readonly onReviewed?: (claim: OrganizerClaimRequest) => void }
const VERIFICATION: Record<OrganizerClaimRequest["verification"], string> = {
  official_domain_mailbox: "官方域名邮箱", official_statement: "官方声明确认",
  authorized_document: "盖章授权文件", platform_source_page: "官方平台页互证", other: "其他（需说明）",
};
const STATUS_TEXT: Record<OrganizerClaimRequest["status"], string> = { pending: "待审核", approved: "已通过", rejected: "已驳回", withdrawn: "已撤回" };
interface Queue { readonly claims: OrganizerClaimRequest[]; readonly candidates: Record<string, { title: string; sourceUrl: string; sourceHost: string } | null> }

/** 平台管理员审核"认领已发现赛事"。候选匹配本身不构成归属，必须人工核对材料。 */
export function AdminClaimReview({ onReviewed }: AdminClaimReviewProps) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const claims = await api<OrganizerClaimRequest[]>("/admin/organizer/claims");
      setQueue({ claims, candidates: {} });
    } catch (reason) { setError(message(reason)); setQueue(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return <section className={styles.surface} aria-label="赛事认领人工审核"><div className={styles.panel}>
    <h2>赛事认领审核</h2>
    <p className={styles.muted}>主办方认领我们自动发现的赛事。候选匹配只表示"可能是他办的"，通过前必须核对一篇可核对的材料；未通过核实的认领不会改写任何公开赛事内容。</p>
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={loading} onClick={() => void load()}>刷新队列</button></div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {loading && <p role="status" className={styles.muted}>正在读取认领队列…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {queue && !queue.claims.length && <p className={styles.muted}>当前没有待审核的认领申请。</p>}
  </div>
    {queue?.claims.map(claim => <ClaimReview key={claim.id} claim={claim} onReviewed={async result => { setNotice(`认领 ${result.id}：${STATUS_TEXT[result.status]}，结果已保存。`); await load(); onReviewed?.(result); }}/>)}
  </section>;
}

function ClaimReview({ claim, onReviewed }: { claim: OrganizerClaimRequest; onReviewed: (claim: OrganizerClaimRequest) => Promise<void> }) {
  const [decision, setDecision] = useState<ReviewClaimInput["decision"]>("approved"), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setDecision("approved"); }, [claim.id]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<OrganizerClaimRequest>(`/admin/organizer/claims/${encodeURIComponent(claim.id)}/review`, {
        method: "POST", body: { expectedRevision: claim.revision, decision, note } satisfies ReviewClaimInput });
      await onReviewed(result); setNote("");
    } catch (reason) { setError(`${message(reason)} 审核意见已保留；如申请已更新，请刷新核对后再次提交。`); }
    finally { setBusy(false); }
  }
  return <article className={styles.panel}>
    <div className={`${styles.row} ${styles.between}`}><h3>认领请求 {claim.id.slice(0, 8)}…</h3><span className={styles.badge}>{STATUS_TEXT[claim.status]}</span></div>
    <div className={styles.scope}>
      <p>机构标识：{claim.organizationId}</p>
      <p>来源域名：{claim.sourceHost}</p>
      <p>赛事线索标识：{claim.discoveryId.slice(0, 16)}…</p>
      <p className={styles.muted}>申请人：{claim.requestedBy} · 提交 {dateText(claim.createdAt)} · 版本 {claim.revision}</p>
    </div>
    <p className={styles.muted}>核实方式：<strong>{VERIFICATION[claim.verification]}</strong></p>
    <h4>申请人提交的归属依据</h4><p className={styles.rules}>{claim.evidenceText}</p>
    {claim.evidenceUrls.length > 0 && <ul className={styles.list}>{claim.evidenceUrls.map(url => <li key={url}><a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">{url}</a></li>)}</ul>}
    {claim.status !== "pending" ? <p className={styles.muted}>{claim.reviewNote ? `审核说明：${claim.reviewNote}` : "该申请已处理。"}</p>
      : <form className={styles.stack} onSubmit={submit}>
        <Field label="审核结果" hint="通过表示你已核对到可核对的归属材料；驳回表示材料不足或与该赛事不符。通过只确认归属，不替主办方保证赛事质量。">
          <select value={decision} onChange={event => setDecision(event.target.value as ReviewClaimInput["decision"])}>
            <option value="approved">通过认领</option><option value="rejected">驳回</option>
          </select>
        </Field>
        <Field label="核实说明" hint="通过时必填：写明你核对的是哪一份材料，例如「官网活动页署名与申请人一致」。驳回时说明缺少什么、如何补充。">
          <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} required={decision === "approved"}/>
        </Field>
        <p className={styles.todo}>通过后该赛事线索归此机构运营；未通过前不会改写任何公开赛事内容。同一线索只能被一个机构认领。</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.actions}><button className={decision === "rejected" ? styles.danger : styles.button} type="submit" disabled={busy}>{busy ? "正在提交审核…" : "确认审核结果"}</button></div>
      </form>}
  </article>;
}
