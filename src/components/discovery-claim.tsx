"use client";

import { useState, type FormEvent } from "react";
import { api, message, useApi } from "./client-api.ts";
import { Field } from "./site-shell.tsx";
import type { ClaimCandidateInput, ClaimVerification, OrganizerClaimCandidate, OrganizerClaimRequest } from "../modules/organizer/model.ts";
import styles from "../modules/organizer/organizer.module.css";
import feedStyles from "./event-discoveries.module.css";

interface ClaimContext {
  readonly candidate: OrganizerClaimCandidate | null;
  readonly organizations: readonly { readonly id: string; readonly name: string }[];
  readonly existingClaim: OrganizerClaimRequest | null;
}
const VERIFICATION_LABELS: Record<ClaimVerification, string> = {
  official_domain_mailbox: "用官方域名邮箱接收验证信",
  official_statement: "官网或官方公众号有可核对的声明确认",
  authorized_document: "提供盖章授权文件或主办方联系人",
  platform_source_page: "官方平台页与本人身份互证",
  other: "其他方式（在依据里说明，人工判定）",
};

/**
 * 比赛页上的"这是我的比赛"入口（主办方认领）。
 * 候选匹配只作提示：认领必须提交归属依据并由平台人工核实，未通过前不会改写任何公开内容。
 */
export function DiscoveryClaimAction({ discoveryId, signedIn, loginHref }: { discoveryId: string; signedIn: boolean; loginHref: string }) {
  const context = useApi<ClaimContext>(signedIn ? `/organizer/claim-candidates/${encodeURIComponent(discoveryId)}` : null);
  const [open, setOpen] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const [verification, setVerification] = useState<ClaimVerification>("official_statement");
  const [evidenceText, setEvidenceText] = useState("");
  const [evidenceUrls, setEvidenceUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");

  if (!signedIn) return <p className={feedStyles.claimHint}><a className={styles.link} href={loginHref}>登录</a>后如果你是主办方，可以在这里认领这场比赛。</p>;
  if (context.loading) return null;
  if (context.error || !context.data) return null;
  const { candidate, organizations, existingClaim } = context.data;
  if (!candidate) return null;
  if (existingClaim) return <p className={feedStyles.claimHint}>这场比赛已被认领或正在审核。如果你是主办方，请联系我们核对归属。</p>;
  if (!organizations.length) return <p className={feedStyles.claimHint}>如果你是这场比赛的主办方，先完成<a className={styles.link} href="/organizers">机构入驻</a>，再回到这里认领。</p>;

  const selected = organizationId || organizations[0]!.id;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body: ClaimCandidateInput = { discoveryId, verification, evidenceText,
        evidenceUrls: evidenceUrls.split("\n").map(line => line.trim()).filter(Boolean) };
      await api<OrganizerClaimRequest>(`/organizer/organizations/${encodeURIComponent(selected)}/claims`, { method: "POST", body });
      setOpen(false); setEvidenceText(""); setEvidenceUrls("");
      setNotice("认领申请已送交平台人工核实。核实通过前，公开内容不会被改动。");
      await context.reload();
    } catch (reason) { setError(`${message(reason)} 输入已保留；请核对后继续。`); }
    finally { setBusy(false); }
  }

  return <div className={feedStyles.claimBox}>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {!open ? <div className={styles.actions}>
      <button type="button" className={styles.secondary} onClick={() => { setOpen(true); setError(""); }}>这是我的比赛</button>
      <span className={styles.muted}>认领后这一场归你们运营；候选匹配本身不构成归属，需要人工核实。</span>
    </div> : <form className={styles.stack} onSubmit={submit}>
      <Field label="用哪个机构认领" hint="只能选择你作为机构管理员、且已通过入驻审核的机构。">
        <select value={selected} onChange={event => setOrganizationId(event.target.value)}>
          {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>
      <Field label="怎么证明这场比赛是你们的" hint="选一种你能提供的核实方式；平台会按这种方式核对，不能只凭名称相似。">
        <select value={verification} onChange={event => setVerification(event.target.value as ClaimVerification)}>
          {(Object.keys(VERIFICATION_LABELS) as ClaimVerification[]).map(key => <option key={key} value={key}>{VERIFICATION_LABELS[key]}</option>)}
        </select>
      </Field>
      <Field label="归属依据" hint="必填。说明你与这场比赛的关系和可核对之处，例如「官网活动页署名联系人与本人一致」。">
        <textarea value={evidenceText} onChange={event => setEvidenceText(event.target.value)} maxLength={4000} required/>
      </Field>
      <Field label="公开证明链接（选填）" hint="最多 5 条公开 https:// 地址，每行一条；不要填密码或私人材料地址。">
        <textarea value={evidenceUrls} onChange={event => setEvidenceUrls(event.target.value)} placeholder={candidate.sourceUrl}/>
      </Field>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={busy}>{busy ? "正在提交…" : "提交认领申请"}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setOpen(false); setError(""); }}>取消</button>
      </div>
    </form>}
  </div>;
}
