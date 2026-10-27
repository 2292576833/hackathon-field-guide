"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { api, ApiError, dateText, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, PageTitle } from "./site-shell.tsx";
import type { EventRuleVersion } from "../modules/events/domain.ts";
import type { EventReview, EventCandidateSnapshot, CriticalFieldChange, CriticalFieldKey } from "../modules/operations/event-review-types.ts";
import type { ResourceReview, ResourceReviewSnapshot, ResourceVerification } from "../modules/operations/resource-review-types.ts";
import type { Correction, CorrectionStatus } from "../modules/operations/correction-types.ts";
import type { SourceConfig } from "../modules/operations/source-domain.ts";
import type { ExecutionRun } from "../modules/operations/run-domain.ts";
import type { Resource } from "../modules/resources/domain.ts";
import { DiscoveryOperations } from "./discovery-operations.tsx";
import { AssessmentCatalog } from "./assessment-catalog.tsx";
import { SourceManager } from "./source-manager.tsx";
import { AdminAuditPanel } from "../modules/operations/audit-query-panel.tsx";
import { RetentionStatus } from "./retention-status.tsx";
import { SkillsAdministrationClient } from "./skills-admin.tsx";
import styles from "./operations.module.css";

type Section = "discovery" | "catalog" | "events" | "resources" | "corrections" | "intake" | "sources" | "audit" | "skills";
interface EventDetail { review: EventReview; candidate: EventCandidateSnapshot; needsRefresh: boolean; changes: readonly CriticalFieldChange[] }
interface EventEvidence { reviewId: string; candidateRevision: number; contentHash: string; rules: EventRuleVersion }
interface ResourceDetail { review: ResourceReview; resource: ResourceReviewSnapshot }
const criticalKeys: readonly CriticalFieldKey[] = ["eligibility", "deadlines", "fees", "deliverables", "submission"];
const criticalNames: Record<CriticalFieldKey, string> = { eligibility: "参赛资格", deadlines: "比赛时间", fees: "费用", deliverables: "交付要求", submission: "提交入口" };
const statusNames: Record<string, string> = {
  pending: "待审核", changes_requested: "需修改", approved: "已通过，待发布", rejected: "已拒绝", published: "已发布",
  received: "已接收", triaging: "核查中", confirmed: "已确认", needs_more_info: "待补充", dismissed: "已驳回", resolved: "已解决",
  draft: "草稿", in_review: "审核中", pending_review: "审核中", withdrawn: "已下架", needs_recheck: "需复核",
  proposed: "待验证", verifying: "验证中", enabled: "启用", paused: "暂停", degraded: "异常",
  queued: "排队中", running: "执行中", review_ready: "可审核", succeeded: "完成", failed: "失败", cancelled: "取消",
};
const correctionTransitions: Record<CorrectionStatus, readonly CorrectionStatus[]> = {
  received: ["triaging"], triaging: ["confirmed", "needs_more_info", "dismissed"], confirmed: ["resolved"],
  needs_more_info: ["triaging", "resolved"], dismissed: ["resolved"], resolved: [],
};
const enc = encodeURIComponent;
function status(value: string) { return statusNames[value] ?? value; }
function parseContent(value: string): Record<string, unknown> {
  if (new TextEncoder().encode(value).byteLength > 120 * 1024) throw new Error("JSON 内容需小于 120 KiB，给请求字段保留空间。");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("JSON 格式不正确，请检查引号、逗号和括号。输入已保留。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请输入完整的 JSON 对象。");
  return parsed as Record<string, unknown>;
}
function JsonView({ value, label = "查看完整记录 JSON" }: { value: unknown; label?: string }) {
  return <details><summary>{label}</summary><pre className={styles.pre}>{JSON.stringify(value, null, 2)}</pre></details>;
}
function Url({ value, children }: { value: string | null | undefined; children?: ReactNode }) {
  const url = safeLink(value);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className={styles.link}>{children ?? value}</a> : <span>未提供有效链接</span>;
}
function useMutation() {
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState("");
  const conflict = error instanceof ApiError && error.status === 409;
  async function run(work: () => Promise<void>, success: string) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(null); setNotice("");
    try { await work(); setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason : new Error("操作未完成，输入已保留。")); }
    finally { guard.current = false; setBusy(false); }
  }
  return { busy, error, notice, conflict, run, clear: () => { setError(null); setNotice(""); } };
}
function MutationFeedback({ mutation, reload }: { mutation: ReturnType<typeof useMutation>; reload?: () => Promise<void> }) {
  return <><Feedback error={mutation.error} notice={mutation.notice} />{mutation.conflict && <p className={styles.warning}>服务器记录已变化。你的输入已保留，请刷新版本并重新核对。
    {reload && <button type="button" className={styles.secondary} disabled={mutation.busy} onClick={() => void mutation.run(reload, "已刷新版本，请保留输入并重新核对。")}>刷新当前版本</button>}</p>}</>;
}
function Queue({ title, kind, selected, onSelect }: { title: string; kind: "event-reviews" | "resource-reviews"; selected: string; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState("pending");
  const [manualId, setManualId] = useState("");
  const queue = useApi<readonly (EventReview | ResourceReview)[]>(`/admin/${kind}?limit=50${filter ? `&status=${filter}` : ""}`);
  return <section className={styles.panel}><h2>{title}</h2>
    <Field label="审核状态"><select value={filter} onChange={event => setFilter(event.target.value)}><option value="">全部状态</option>{["pending", "changes_requested", "approved", "rejected", "published"].map(value => <option key={value} value={value}>{status(value)}</option>)}</select></Field>
    <button type="button" className={styles.secondary} disabled={queue.loading} onClick={() => void queue.reload()}>刷新列表</button>
    <Feedback error={queue.error} />{queue.loading && <Loading />}
    {!queue.loading && !queue.error && !queue.data?.length && <Empty>当前状态暂无审核记录。</Empty>}
    <ul className={styles.list}>{queue.data?.map(item => <li key={item.id} className={item.id === selected ? styles.selected : undefined}><button type="button" onClick={() => onSelect(item.id)}><span className={styles.mono}>{item.id}</span><small>{status(item.status)} · 审核修订 {item.revision}<br />{dateText(item.updatedAt)}</small></button></li>)}</ul>
    <p className={styles.muted}>最多显示 50 条；也可输入已知审核 ID。</p>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); if (manualId.trim()) onSelect(manualId.trim()); }}><Field label="审核 ID"><input value={manualId} onChange={event => setManualId(event.target.value)} maxLength={256} required /></Field><button className={styles.secondary}>加载审核记录</button></form>
  </section>;
}

function EventReviews({ admin }: { admin: boolean }) {
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [checked, setChecked] = useState<readonly CriticalFieldKey[]>([]);
  const [unknown, setUnknown] = useState<readonly CriticalFieldKey[]>([]);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [replacement, setReplacement] = useState("");
  const detail = useApi<EventDetail>(selected ? `/admin/event-reviews/${enc(selected)}` : null);
  const current = detail.data?.review.id === selected ? detail.data : null;
  const evidence = useApi<EventEvidence>(current ? `/admin/event-reviews/${enc(selected)}/evidence?candidateRevision=${current.candidate.revision}&hash=${enc(current.candidate.contentHash)}` : null);
  const mutation = useMutation();
  const evidenceMatches = Boolean(current && evidence.data && evidence.data.reviewId === current.review.id && evidence.data.candidateRevision === current.candidate.revision && evidence.data.contentHash === current.candidate.contentHash);
  useEffect(() => { setChecked([]); setUnknown([]); }, [selected, current?.candidate.contentHash]);
  useEffect(() => { setPublishConfirmed(false); }, [selected, current?.review.revision, current?.candidate.currentPublishedVersion]);
  async function reload() { await Promise.all([detail.reload(), evidence.reload()]); }
  function select(id: string) { if (mutation.busy) return; setSelected(id); setReason(""); setReplacement(""); mutation.clear(); }
  function toggle(key: CriticalFieldKey, list: readonly CriticalFieldKey[], setter: (value: readonly CriticalFieldKey[]) => void) { setter(list.includes(key) ? list.filter(value => value !== key) : [...list, key]); }
  const unavailable = mutation.busy || mutation.conflict || detail.loading || Boolean(detail.error) || !current || current.needsRefresh;
  const canApprove = !unavailable && evidenceMatches && !evidence.loading && !evidence.error && current?.review.status === "pending" && !current.candidate.validationErrors.length && current.candidate.criticalFields.every(field => field.state !== "conflict") && criticalKeys.every(key => checked.includes(key)) && current.candidate.criticalFields.filter(field => field.state === "unknown").every(field => unknown.includes(field.key)) && Boolean(reason.trim());
  function act(action: "approve" | "decide" | "publish" | "refresh", extra: Record<string, unknown> = {}) {
    if (!current) return;
    void mutation.run(async () => {
      await api(`/admin/event-reviews/${enc(current.review.id)}/${action}`, { method: "POST", body: { expectedRevision: current.review.revision, expectedCandidateRevision: current.candidate.revision, reason, ...extra } });
      await reload();
    }, action === "publish" ? "赛事已正式发布，可在公开赛事页查看。" : "审核状态已保存。可刷新左侧列表查看。");
  }
  return <div className={styles.split}><Queue title="赛事审核" kind="event-reviews" selected={selected} onSelect={select} />
    <section className={styles.panel}><h2>核对比赛规则</h2>{!selected && <Empty>选择或输入审核 ID，读取真实候选与证据。</Empty>}
      <Feedback error={detail.error} />{detail.loading && <Loading />}
      {current && <><div className={styles.actions}><span className={styles.tag}>{status(current.review.status)}</span><button type="button" className={styles.secondary} disabled={mutation.busy || detail.loading} onClick={() => void reload()}>刷新详情</button></div>
        <p className={styles.mono}>赛事 {current.review.eventId}<br />审核修订 {current.review.revision} · 候选修订 {current.candidate.revision} · 已公开版本 {current.candidate.currentPublishedVersion ?? "无"}</p>
        {current.review.reason && <p>最近处理说明：{current.review.reason}</p>}
        {current.candidate.validationErrors.length > 0 && <Feedback error={current.candidate.validationErrors.join("；")} />}
        {current.needsRefresh && <p className={styles.warning}>候选已更新，旧审核与批准已失效。填写原因后点击“将最新候选重新送审”。</p>}
        <Feedback error={evidence.error} />{evidence.loading && <Loading />}
        {evidence.data && !evidenceMatches && <p className={styles.warning}>证据版本与候选不一致，请刷新详情；当前不能批准。</p>}
        {evidenceMatches && evidence.data && <EventEvidenceView rules={evidence.data.rules} />}
        <h3>逐项审核</h3><p className={styles.muted}>依据已读取的原文逐项确认；未知项保持“未说明”。勾选不会自动核验网站。</p>
        {current.candidate.criticalFields.map(field => <div key={field.key} className={styles.critical}><strong>{criticalNames[field.key]}</strong> <span className={styles.tag}>{field.state === "known" ? "有依据" : field.state === "unknown" ? "未说明" : "存在冲突"}</span><p>{field.summary}</p><p className={styles.mono}>证据：{field.evidenceIds.join("、") || "无"}</p>
          {current.changes.find(change => change.key === field.key)?.before && <p className={styles.muted}>已公开内容：{current.changes.find(change => change.key === field.key)?.before?.summary}</p>}
          <label className={styles.check}><input type="checkbox" checked={checked.includes(field.key)} disabled={unavailable || !evidenceMatches || current.review.status !== "pending"} onChange={() => toggle(field.key, checked, setChecked)} />我已核对{criticalNames[field.key]}的原始依据与候选结论</label>
          {field.state === "unknown" && <label className={styles.check}><input type="checkbox" checked={unknown.includes(field.key)} disabled={unavailable || !evidenceMatches || current.review.status !== "pending"} onChange={() => toggle(field.key, unknown, setUnknown)} />确认此项以“未说明”公开，不补写推测结论</label>}
        </div>)}
        <Field label="审核 / 处理说明" hint="批准、退回、拒绝、重新送审与发布均记录说明。"><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} /></Field>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={!canApprove} onClick={() => act("approve", { checkedKeys: checked, acknowledgedUnknownKeys: unknown })}>批准此候选</button>
          <button type="button" className={styles.secondary} disabled={unavailable || !reason.trim() || !["pending", "approved"].includes(current.review.status)} onClick={() => act("decide", { decision: "changes_requested" })}>退回修改</button>
          <button type="button" className={styles.secondary} disabled={unavailable || !reason.trim() || !["pending", "approved"].includes(current.review.status)} onClick={() => act("decide", { decision: "rejected" })}>拒绝</button>
          {current.needsRefresh && <button type="button" className={styles.secondary} disabled={mutation.busy || mutation.conflict || !reason.trim() || current.review.status === "published"} onClick={() => act("refresh")}>将最新候选重新送审</button>}
        </div>
        {current.review.status === "approved" && <div className={styles.critical}><h3>正式发布</h3><p>发布后，所有用户都能看到这份规则。赛事 ID：<span className={styles.mono}>{current.review.eventId}</span>。</p><label className={styles.check}><input type="checkbox" checked={publishConfirmed} onChange={event => setPublishConfirmed(event.target.checked)} disabled={unavailable} />确认将已批准的候选修订 {current.candidate.revision} 发布到公开赛事页</label><button type="button" className={styles.button} disabled={unavailable || evidence.loading || Boolean(evidence.error) || !evidenceMatches || !publishConfirmed || !reason.trim()} onClick={() => act("publish", { expectedPublishedVersion: current.candidate.currentPublishedVersion })}>确认正式发布赛事</button></div>}
        {admin && current.candidate.origin === "manual" && current.review.status !== "published" && <details><summary>修正人工候选 JSON</summary><p className={styles.muted}>提交完整 EventRuleVersion。修正会清除旧批准，重新进入审核；详情刷新不会覆盖你正在编辑的 JSON。</p><Field label="替换候选的完整 JSON"><textarea className={styles.editor} value={replacement} onChange={event => setReplacement(event.target.value)} spellCheck={false} /></Field><button type="button" className={styles.secondary} disabled={mutation.busy || mutation.conflict || detail.loading || Boolean(detail.error) || !replacement.trim() || !reason.trim()} onClick={() => void mutation.run(async () => { await api(`/admin/event-reviews/${enc(current.review.id)}`, { method: "PATCH", body: { expectedRevision: current.review.revision, expectedCandidateRevision: current.candidate.revision, reason, content: parseContent(replacement) } }); await reload(); }, "候选已修正，需重新核对并批准。")}>保存修正并重新送审</button></details>}
        <JsonView value={current} /></>}
      <MutationFeedback mutation={mutation} reload={reload} />
    </section></div>;
}

function EventEvidenceView({ rules }: { rules: EventRuleVersion }) {
  return <details open><summary>比赛原文与证据 · {rules.metadata.name}</summary><p>{rules.metadata.organizer} · <Url value={rules.metadata.officialUrl}>比赛官网</Url></p>
    <h3>来源快照</h3>{rules.sources.map(source => <div className={styles.evidence} key={source.id}><span className={styles.tag}>{source.kind === "official" ? "官方" : source.kind === "secondary" ? "二手信息" : "用户提供"}</span><span className={styles.tag}>{source.status}</span><Url value={source.url} /><p className={styles.mono}>{source.id} · {source.trustScope}</p><p className={styles.muted}>获取于 {dateText(source.fetchedAt)}</p></div>)}
    <h3>原文摘录</h3>{rules.evidence.length ? rules.evidence.map(item => <article className={styles.evidence} key={item.id}><strong>{item.fieldKey}</strong><p className={styles.mono}>{item.id} · 来源 {item.sourceId}</p><blockquote>{item.excerpt}</blockquote><p>定位：{item.locator}</p>{item.rawDateText && <p>原始日期：{item.rawDateText}</p>}<p className={styles.muted}>人工核验：{item.verifiedAt ? dateText(item.verifiedAt) : "未核验"}</p>{item.conflictsWith.length > 0 && <p className={styles.warning}>冲突证据：{item.conflictsWith.join("、")}</p>}</article>) : <p className={styles.muted}>暂无原文证据；不能把未知信息批准成已知事实。</p>}
    <h3>多阶段时间</h3>{rules.stages.length ? rules.stages.map(stage => <article key={stage.id} className={styles.evidence}><strong>{stage.name}</strong>{(["startsAt", "endsAt"] as const).map(key => { const moment = stage[key]; return <p key={key}>{key === "startsAt" ? "开始" : "结束"}：{moment ? <>{moment.rawText} · 时区 {moment.timeZone ?? "未知"} · {moment.dateOnly ? "仅日期" : moment.utc ? dateText(moment.utc) : "未转换为具体时刻"}</> : "未说明"}</p>; })}{stage.submissionUrl && <Url value={stage.submissionUrl}>该阶段提交入口</Url>}</article>) : <p className={styles.muted}>阶段时间未说明。</p>}
    <JsonView value={rules} label="查看完整比赛候选 JSON（可复制用于修正）" />
  </details>;
}

function ResourceReviews() {
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [checks, setChecks] = useState({ link: false, fees: false, license: false });
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const detail = useApi<ResourceDetail>(selected ? `/admin/resource-reviews/${enc(selected)}` : null);
  const current = detail.data?.review.id === selected ? detail.data : null;
  const content = useApi<Resource>(current ? `/admin/resources/${enc(current.resource.resourceId)}?revision=${current.resource.revision}` : null);
  const mutation = useMutation();
  const matches = Boolean(current && current.resource.revision === current.review.resourceRevision && current.resource.contentHash === current.review.contentHash);
  const contentMatches = Boolean(current && content.data && content.data.id === current.resource.resourceId && content.data.revision === current.resource.revision);
  useEffect(() => { setChecks({ link: false, fees: false, license: false }); }, [selected, current?.resource.contentHash]);
  useEffect(() => { setPublishConfirmed(false); }, [selected, current?.review.revision, current?.resource.revision]);
  async function reload() { await Promise.all([detail.reload(), content.reload()]); }
  const blocked = mutation.busy || mutation.conflict || detail.loading || Boolean(detail.error) || !matches;
  const deciding = current && ["pending", "changes_requested"].includes(current.review.status);
  const approvable = !blocked && deciding && contentMatches && !content.loading && !content.error && checks.link && checks.fees && checks.license && Boolean(reason.trim()) && !current?.resource.validationErrors.length && content.data?.linkStatus === "available" && Boolean(content.data?.verifiedAt);
  function decide(decision: "approved" | "changes_requested" | "rejected") {
    if (!current) return;
    const claim = (value: ResourceReviewSnapshot["fees"]): ResourceVerification["fees"] => ({ status: value.state === "known" ? "verified" : "unknown", sourceUrl: value.sourceUrl });
    void mutation.run(async () => { await api(`/admin/resource-reviews/${enc(selected)}/decide`, { method: "POST", body: { expectedRevision: current.review.revision, expectedResourceRevision: current.resource.revision, decision, reason,
      ...(decision === "approved" ? { verification: { link: { status: "available", checkedUrl: current.resource.officialUrl }, fees: claim(current.resource.fees), license: claim(current.resource.license) } } : {}) } }); await reload(); }, "资源审核结论已保存。可刷新左侧列表查看。");
  }
  return <div className={styles.split}><Queue title="资源审核" kind="resource-reviews" selected={selected} onSelect={id => { if (mutation.busy) return; setSelected(id); setReason(""); mutation.clear(); }} />
    <section className={styles.panel}><h2>核对工具与资源</h2>{!selected && <Empty>选择资源审核记录，核对链接、费用与许可。</Empty>}<Feedback error={detail.error} />{detail.loading && <Loading />}
      {current && <><div className={styles.actions}><span className={styles.tag}>{status(current.review.status)}</span><button type="button" className={styles.secondary} disabled={mutation.busy || detail.loading} onClick={() => void reload()}>刷新详情</button></div><p className={styles.mono}>资源 {current.resource.resourceId}<br />审核修订 {current.review.revision} · 资源修订 {current.resource.revision} · 已公开版本 {current.resource.publishedVersion ?? "无"}</p>
        {current.review.reason && <p>最近处理说明：{current.review.reason}</p>}{!matches && current.review.status !== "published" && <p className={styles.warning}>资源已改动。需由管理员重新送审最新草稿，当前审核不能发布。</p>}
        <Feedback error={content.error} />{content.loading && <Loading />}{content.data && !contentMatches && <p className={styles.warning}>资源全文与审核快照修订不一致，请刷新。</p>}
        {contentMatches && content.data && <><h3>{content.data.name}</h3><p>{content.data.summary}</p><p><Url value={content.data.officialUrl}>打开官方链接核验</Url></p><p>适合：{content.data.suitableFor}</p><p>不适合：{content.data.notSuitableFor}</p><ol>{content.data.quickStart.map((step, index) => <li key={index}>{step}</li>)}</ol><p>费用：{content.data.costType} · {content.data.costNote}</p><p>许可：{content.data.licenseStatus} · {content.data.licenseNote}</p><p className={styles.muted}>链接状态 {content.data.linkStatus} · 记录的核验时间 {dateText(content.data.verifiedAt)}</p><JsonView value={content.data} label="查看资源全文与受控标签" /></>}
        {current.resource.validationErrors.length > 0 && <Feedback error={current.resource.validationErrors.join("；")} />}
        <label className={styles.check}><input type="checkbox" checked={checks.link} disabled={blocked || !deciding || !contentMatches} onChange={event => setChecks(value => ({ ...value, link: event.target.checked }))} />我已打开官方链接，确认可访问且对应此资源</label>
        {(["fees", "license"] as const).map(key => <div className={styles.critical} key={key}><strong>{key === "fees" ? "费用" : "许可"}核验</strong><p>{current.resource[key].state === "known" ? <Url value={current.resource[key].sourceUrl}>打开已记录的官方依据</Url> : "无可确认依据，将以未知状态公开。"}</p><label className={styles.check}><input type="checkbox" checked={checks[key]} disabled={blocked || !deciding || !contentMatches} onChange={event => setChecks(value => ({ ...value, [key]: event.target.checked }))} />{current.resource[key].state === "known" ? "已核对依据与资源中的结论一致" : "确认保留未知状态，不补写费用或授权结论"}</label></div>)}
        <Field label="审核说明"><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} /></Field><div className={styles.actions}><button type="button" className={styles.button} disabled={!approvable} onClick={() => decide("approved")}>批准此资源</button><button type="button" className={styles.secondary} disabled={blocked || !deciding || !reason.trim()} onClick={() => decide("changes_requested")}>退回修改</button><button type="button" className={styles.secondary} disabled={blocked || !deciding || !reason.trim()} onClick={() => decide("rejected")}>拒绝</button></div>
        {contentMatches && content.data && (!content.data.verifiedAt || content.data.linkStatus !== "available") && <p className={styles.warning}>草稿需记录真实的 verifiedAt 和 linkStatus=available。请核验后修改资源 JSON，保存并重新送审。</p>}
        {current.review.status === "approved" && <div className={styles.critical}><h3>正式发布</h3><label className={styles.check}><input type="checkbox" checked={publishConfirmed} disabled={blocked} onChange={event => setPublishConfirmed(event.target.checked)} />确认将已批准的资源修订 {current.resource.revision} 发布给所有用户</label><button type="button" className={styles.button} disabled={blocked || !contentMatches || !publishConfirmed} onClick={() => void mutation.run(async () => { await api(`/admin/resource-reviews/${enc(selected)}/publish`, { method: "POST", body: { expectedRevision: current.review.revision, expectedResourceRevision: current.resource.revision } }); await reload(); }, "资源已正式发布，可在工具与灵感页查看。")}>确认正式发布资源</button></div>}
        <JsonView value={current} /></>}<MutationFeedback mutation={mutation} reload={reload} />
    </section></div>;
}

function Corrections() {
  const [filter, setFilter] = useState("received");
  const [selected, setSelected] = useState("");
  const [manualId, setManualId] = useState("");
  const [next, setNext] = useState<CorrectionStatus | "">("");
  const [reason, setReason] = useState("");
  const [version, setVersion] = useState("");
  const queue = useApi<readonly Correction[]>(`/admin/corrections?limit=50${filter ? `&status=${filter}` : ""}`);
  const detail = useApi<Correction>(selected ? `/admin/corrections/${enc(selected)}` : null);
  const mutation = useMutation();
  const current = detail.data?.id === selected ? detail.data : null;
  const available = current ? correctionTransitions[current.status] : [];
  useEffect(() => { setNext(""); }, [selected, current?.revision]);
  async function reload() { await Promise.all([queue.reload(), detail.reload()]); }
  function select(id: string) { if (mutation.busy) return; setSelected(id); setReason(""); setVersion(""); mutation.clear(); }
  return <div className={styles.split}><section className={styles.panel}><h2>统一纠错队列</h2><Field label="处理状态"><select value={filter} onChange={event => setFilter(event.target.value)}><option value="">全部状态</option>{Object.keys(correctionTransitions).map(value => <option key={value} value={value}>{status(value)}</option>)}</select></Field><button type="button" className={styles.secondary} disabled={queue.loading} onClick={() => void queue.reload()}>刷新列表</button><Feedback error={queue.error} />{queue.loading && <Loading />}{!queue.loading && !queue.error && !queue.data?.length && <Empty>当前状态暂无纠错。</Empty>}
    <ul className={styles.list}>{queue.data?.map(item => <li key={item.id} className={item.id === selected ? styles.selected : undefined}><button type="button" onClick={() => select(item.id)}>{item.original.field}<small>{item.original.target.kind === "event" ? "赛事" : "资源"} · {status(item.status)} · 修订 {item.revision}<br /><span className={styles.mono}>{item.id}</span></small></button></li>)}</ul><p className={styles.muted}>最多显示 50 条。</p><form className={styles.form} onSubmit={event => { event.preventDefault(); if (manualId.trim()) select(manualId.trim()); }}><Field label="纠错 ID"><input value={manualId} onChange={event => setManualId(event.target.value)} maxLength={256} required /></Field><button className={styles.secondary}>加载纠错</button></form></section>
    <section className={styles.panel}><h2>核查与处理</h2>{!selected && <Empty>选择纠错记录，查看用户原始反馈。</Empty>}<Feedback error={detail.error} />{detail.loading && <Loading />}{current && <><div className={styles.actions}><span className={styles.tag}>{status(current.status)}</span><button type="button" className={styles.secondary} disabled={mutation.busy || detail.loading} onClick={() => void reload()}>刷新详情</button></div><p className={styles.mono}>{current.original.target.kind} {current.original.target.entityId} · 公开版本 {current.original.target.version} · 纠错修订 {current.revision}</p><h3>{current.original.field}</h3><blockquote>{current.original.message}</blockquote><ul>{current.original.evidenceUrls.map(url => <li key={url}><Url value={url} /></li>)}</ul><p className={styles.muted}>提交于 {dateText(current.original.submittedAt)}</p>{current.response && <p>最近回复：{current.response}</p>}{current.relatedVersion && <p>已关联公开版本 {current.relatedVersion.version}</p>}
      {available.length > 0 ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void mutation.run(async () => { if (!next || !available.includes(next)) throw new Error("请选择当前状态允许的下一步。"); const parsedVersion = version.trim() ? Number(version) : null; if (parsedVersion !== null && (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1)) throw new Error("关联版本需为正整数。"); if (current.status === "confirmed" && next === "resolved" && (!parsedVersion || parsedVersion <= current.original.target.version)) throw new Error("已确认的纠错需关联修正后的更新公开版本。"); await api(`/admin/corrections/${enc(current.id)}`, { method: "PATCH", body: { expectedRevision: current.revision, status: next, reason, ...(parsedVersion ? { relatedVersion: { ...current.original.target, version: parsedVersion } } : {}) } }); await reload(); }, "纠错状态已保存，用户可在站内查看处理说明。"); }}>
        <Field label="下一处理状态"><select value={next} onChange={event => setNext(event.target.value as CorrectionStatus | "")} required><option value="">请选择</option>{available.map(value => <option key={value} value={value}>{status(value)}</option>)}</select></Field><Field label="站内处理说明" hint="此说明会向提交纠错的用户展示。"><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} required /></Field><Field label="关联修正后的公开版本" hint="关联同一赛事或资源的版本；已确认问题标记解决时必填且必须更新。"><input type="number" inputMode="numeric" min={1} step={1} value={version} onChange={event => setVersion(event.target.value)} required={current.status === "confirmed" && next === "resolved"} /></Field><button className={styles.button} disabled={mutation.busy || mutation.conflict || detail.loading || Boolean(detail.error) || !next || !reason.trim()}>保存处理结果</button></form> : <p className={styles.muted}>该纠错已解决，无后续状态。</p>}<JsonView value={current} /></>}<MutationFeedback mutation={mutation} reload={reload} /></section></div>;
}

const eventSchema = `EventRuleVersion（完整对象，不是仅 metadata）：
eventId: string; version: 正整数; createdAt: 带时区的 ISO 时间
metadata: { name, organizer, format: online|offline|hybrid|unknown, region, officialUrl }
sources: [{ id, eventId, version, sourceConfigId: string|null, url,
  kind: official|user_provided|secondary, contentHash, fetchedAt,
  trustScope: official_rules|user_claim|secondary_report,
  status: available|failed|removed|stale }]
evidence: [{ id, eventId, version, sourceId, fieldKey, excerpt, locator,
  rawDateText: string|null, verifiedBy: string|null, verifiedAt: ISO|null,
  conflictsWith: string[] }]
facts: [{ key, statement, status: verified|unverified|unknown|conflicted, evidenceIds: string[] }]
  必须含 eligibility、fees、team_size、ai_policy，未知也须明确记录。
stages: [{ id, stageType: registration|development|submission|pitch|other,
  name, startsAt: RuleMoment|null, endsAt: RuleMoment|null, submissionUrl: string|null }]
  RuleMoment = { rawText, timeZone: string|null, utc: ISO|null, dateOnly: boolean, evidenceIds: string[] }
requirements: [{ id, label, necessity: required|optional|unknown, stageId: string|null, evidenceIds: string[] }]
qualityFlags: (needs_recheck|source_stale|source_failed|missing_information)[]

子项 eventId/version 必须与顶层一致；evidenceIds 引用本对象的真实证据。
verified 事实必须引用相应字段的官方人工核验证据。
服务器会绑定可信审核身份与新版本；不要编造来源摘要、证据或日期。`;
const resourceSchema = `ResourceInput（不包含 id/revision/version/recordedBy）：
name, officialUrl, summary, suitableFor, notSuitableFor: string
type: inspiration|ai_design|ui_visual|practical_tool
stageTags: (preparation|design|development|delivery|retrospective)[]
useTags: (layout|workspace|form|flowchart|icons|prototype|collaboration|development|deployment|presentation|review)[]
stackTags: (stack_agnostic|html_css|react|vue|unknown)[]
prerequisites: (browse|account|basic_code|environment)[]
quickStart: string[]（1 至 6 步）；各标签数组均至少一项。
costType: free_plan|free_and_paid|usage_based|self_hosted|unknown
costNote: string; costSourceUrl: string|null; costVerifiedAt: ISO|null
licenseStatus: unknown|source_verified; licenseNote: string
licenseSourceUrl: string|null; licenseVerifiedAt: ISO|null
verifiedAt: ISO|null; linkStatus: unknown|available|unreachable
displayOrder: integer

费用或许可未知时对应 sourceUrl/verifiedAt 均为 null，说明中保留未知。
只记录真正发生且带时区的核验时间；正式发布需已核验且链接可访问。`;

function Intake() {
  const [eventJson, setEventJson] = useState("");
  const [eventId, setEventId] = useState("");
  const [createdReview, setCreatedReview] = useState<EventReview | null>(null);
  const eventMutation = useMutation();
  const [resourceJson, setResourceJson] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [draft, setDraft] = useState<Resource | null>(null);
  const [resourceReview, setResourceReview] = useState<ResourceReview | null>(null);
  const resourceMutation = useMutation();
  async function loadDraft() { if (!resourceId.trim()) throw new Error("请填写资源 ID。"); setDraft(await api<Resource>(`/admin/resources/${enc(resourceId.trim())}`)); }
  return <div className={styles.split}><section className={styles.panel}><h2>录入赛事候选</h2><p className={styles.muted}>根据真实官方规则录入完整候选。保存后进入审核，批准后仍需明确发布。</p><details><summary>展开真实内容格式</summary><pre className={styles.pre}>{eventSchema}</pre></details><form className={styles.form} onSubmit={event => { event.preventDefault(); void eventMutation.run(async () => { const review = await api<EventReview>("/admin/event-reviews", { method: "POST", body: { ...(eventId.trim() ? { eventId: eventId.trim() } : {}), content: parseContent(eventJson) } }); setCreatedReview(review); }, "赛事候选已进入审核。请复制审核 ID，打开赛事审核核对与发布。"); }}><Field label="已有赛事 ID（可选）" hint="更新已有赛事时填写；新赛事 ID 可随完整 JSON 提供。"><input value={eventId} onChange={event => setEventId(event.target.value)} maxLength={256} /></Field><Field label="完整 EventRuleVersion JSON"><textarea className={styles.editor} value={eventJson} onChange={event => setEventJson(event.target.value)} spellCheck={false} required placeholder="粘贴根据真实比赛规则整理的完整 JSON" /></Field><button className={styles.button} disabled={eventMutation.busy || !eventJson.trim()}>保存候选并进入审核</button></form>{createdReview && <p className={styles.mono}>审核 ID：{createdReview.id}<br />赛事 ID：{createdReview.eventId}</p>}<MutationFeedback mutation={eventMutation} /></section>
    <section className={styles.panel}><h2>资源草稿与送审</h2><p className={styles.muted}>先保存真实资源草稿，再送审。资源核验与正式发布在“资源审核”完成。</p><details><summary>展开真实内容格式</summary><pre className={styles.pre}>{resourceSchema}</pre></details><Field label="完整 ResourceInput JSON"><textarea className={styles.editor} value={resourceJson} onChange={event => setResourceJson(event.target.value)} spellCheck={false} placeholder="粘贴人工精选并核验的资源 JSON" /></Field>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={resourceMutation.busy || !resourceJson.trim()} onClick={() => void resourceMutation.run(async () => { const saved = await api<Resource>("/admin/resources", { method: "POST", body: { content: parseContent(resourceJson) } }); setDraft(saved); setResourceId(saved.id); setResourceReview(null); }, "资源草稿已保存，还需送审与正式发布。")}>新建资源草稿</button></div>
      <form className={styles.row} onSubmit={event => { event.preventDefault(); void resourceMutation.run(loadDraft, "资源草稿已读取。JSON 编辑内容保留；修改时请粘贴完整 ResourceInput。"); }}><Field label="已有资源 ID"><input value={resourceId} onChange={event => setResourceId(event.target.value)} maxLength={256} required /></Field><button className={styles.secondary} disabled={resourceMutation.busy}>加载草稿版本</button></form>
      {draft && <><p>{draft.name} · {status(draft.publicationStatus)}</p><p className={styles.mono}>资源 ID {draft.id}<br />内容版本 {draft.version} · 修订 {draft.revision}</p><JsonView value={draft} label="查看现有草稿 JSON" /><div className={styles.actions}><button type="button" className={styles.secondary} disabled={resourceMutation.busy || resourceMutation.conflict || !resourceJson.trim() || resourceId.trim() !== draft.id} onClick={() => void resourceMutation.run(async () => { const saved = await api<Resource>(`/admin/resources/${enc(draft.id)}`, { method: "PATCH", body: { expectedRevision: draft.revision, content: parseContent(resourceJson) } }); setDraft(saved); setResourceReview(null); }, "资源已保存为新草稿，旧核验不能发布新内容。")}>用 JSON 更新已加载资源</button><button type="button" className={styles.button} disabled={resourceMutation.busy || resourceMutation.conflict || draft.publicationStatus !== "draft" || resourceId.trim() !== draft.id} onClick={() => void resourceMutation.run(async () => { const result = await api<{ resource: Resource; review: ResourceReview }>(`/admin/resources/${enc(draft.id)}/request-review`, { method: "POST", body: { expectedRevision: draft.revision } }); setDraft(result.resource); setResourceReview(result.review); }, "资源已进入审核，请复制审核 ID 到资源审核页面。")}>送审此草稿修订 {draft.revision}</button></div></>}
      {resourceReview && <p className={styles.mono}>资源审核 ID：{resourceReview.id}</p>}<MutationFeedback mutation={resourceMutation} reload={async () => { await loadDraft(); }} />
    </section></div>;
}

export function OperationsClient() {
  const permissions = useApi<{ platformRoles: readonly string[] }>("/me/permissions");
  const [section, setSection] = useState<Section>("events");
  const admin = permissions.data?.platformRoles.includes("admin") ?? false;
  const allowed = admin || (permissions.data?.platformRoles.includes("reviewer") ?? false);
  const sections: readonly { id: Section; name: string }[] = [{ id: "events", name: "赛事审核" }, { id: "resources", name: "资源审核" }, { id: "skills", name: "技能审核" }, { id: "corrections", name: "统一纠错" }, ...(admin ? [{ id: "intake" as const, name: "人工录入" }] : []), { id: "sources", name: "来源与运行" }, { id: "catalog", name: "题组审核" }, ...(admin ? [{ id: "discovery" as const, name: "自动发现" }, { id: "audit" as const, name: "操作记录" }] : [])];
  return <><PageTitle eyebrow="运营工作台" title="让发布的内容有据可查"><p>核验真实规则与资源，处理用户纠错。公开发布需要先完成审核，再明确确认。</p></PageTitle>
    <Feedback error={permissions.error} />{permissions.loading && <Loading />}{!permissions.loading && permissions.data && !allowed && <section className={styles.panel}><h2>需要运营权限</h2><p>当前账号没有 admin 或 reviewer 角色，无法查看审核队列或执行运营操作。</p></section>}
    {allowed && !permissions.error && <><p className={styles.muted}>当前角色：{admin ? "管理员" : "审核员"}。每次操作由服务器再次校验权限与版本。</p><nav className={styles.tabs} aria-label="运营模块">{admin && <><Link href="/admin/organizers" className={styles.tab}>主办方入驻审核</Link><Link href="/admin/services" className={styles.tab}>后端服务控制台</Link></>}{sections.map(item => <button key={item.id} type="button" className={styles.tab} aria-pressed={section === item.id} onClick={() => setSection(item.id)}>{item.name}</button>)}</nav><p className={styles.muted}>切换模块会清空尚未保存的表单；请先保存或复制输入。</p>
      {section === "events" && <EventReviews admin={admin} />}{section === "resources" && <ResourceReviews />}{section === "skills" && <SkillsAdministrationClient/>}{section === "corrections" && <Corrections />}{section === "intake" && admin && <Intake />}{section === "sources" && <SourceManager admin={admin} />}{section === "catalog" && <AssessmentCatalog/>}{section === "discovery" && <DiscoveryOperations admin={admin}/>} {section === "audit" && admin && <><AdminAuditPanel/><RetentionStatus/></>}</>}
  </>;
}
