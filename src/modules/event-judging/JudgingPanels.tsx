"use client";
import { Field } from "../../components/site-shell.tsx";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, dateText, message, operationKey, safeLink, useApi } from "../../components/client-api.ts";
import { blockingIssues, submissionPreflight } from "./preflight.ts";
import type { DuplicatePair, DuplicateReport } from "./duplicates.ts";
import type { FairnessReport, FairnessSuggestion } from "./fairness.ts";
import type { ChecklistItem, PostEventReuse, PreEventChecklist } from "./checklists.ts";
import type { IntakeReceipt, JudgeAssignment, JudgeReceiptView, JudgeRoundView, JudgeWorkItem, JudgingConfig, JudgingRound, JudgingWorkspace,
  ManualScore, PublicationReview, PublishedResults, PublishInput, ResultProjection, ResultSummary, SubmissionMaterials, SubmissionPreview, ResultAppeal, AppealWindowView,
} from "./model.ts";
import type { CalibrationReport } from "./calibration.ts";
import type { IntegrityReport } from "./integrity.ts";
import type { ProgressReport } from "./progress.ts";
import styles from "./judging.module.css";

export interface EventJudgingContextProps {
  eventId: string;
  eventTitle: string;
  organizationName: string;
}
export interface EventSubmissionPanelProps extends EventJudgingContextProps {
  teamId: string;
  deadline?: string | null;
}
export interface JudgeWorkspaceProps extends EventJudgingContextProps {}
export interface JudgingManagerProps extends EventJudgingContextProps {
  /** Optional trusted account choices supplied by the root, never interpreted as authorization. */
  judgeOptions?: readonly { userId: string; displayName: string }[];
  /** Increment after related organizer changes to refresh facts while retaining this panel's local drafts. */
  refreshRevision?: number;
}
export interface EventResultsPanelProps extends EventJudgingContextProps {
  scope?: "public" | "mine";
}
interface JudgeMaterials {
  receipt: JudgeReceiptView;
  round: JudgeRoundView;
  assignment: JudgeAssignment;
  score: ManualScore | null;
}
interface SummaryPreview { round: JudgingRound; summary: ResultSummary; summaryHash: string; publicationReview: PublicationReview }
interface AuditItem { id: string; actorUserId: string; action: string; subjectId: string; reason: string; createdAt: string; details: unknown }
const roundNames: Record<JudgingRound["status"], string> = { setup: "准备中", open: "人工评分中", locked: "已锁定，待公布", published: "已公布" };
const assignmentNames: Record<JudgeAssignment["status"], string> = { active: "已指派", needs_review: "待工作人员核查", recused: "已回避", revoked: "已撤销" };
const accessNames: Record<JudgeWorkItem["accessStatus"], string> = { pending_declaration: "待本人申报", available: "材料可读", needs_review: "访问需重新核查", recused: "已回避", revoked: "已撤销" };
const protectedTitles: Record<JudgeWorkItem["accessStatus"], string> = { pending_declaration: "待完成无冲突申报", available: "正式作品", needs_review: "关联或指派已变化，暂不可读取", recused: "本项指派已回避", revoked: "本项指派已撤销" };
const reviewStepNames: Record<PublicationReview["nextSteps"][number], string> = {
  withdraw_results: "填写原因，撤回本版公布", reopen_round: "填写原因，重新开放本轮评分",
  review_assignments: "补评、核查或处理评委指派", lock_round: "重新锁定评分汇总",
  preview_results: "重新预览有效评分与反馈范围", publish_results: "负责人再次人工确认公布",
};
function PublicationReviewSteps({ review }: { review: PublicationReview }) {
  return <ol className={styles.reviewSteps}>{review.nextSteps.map((step, index) => <li key={`${step}:${index}`}>{step === "preview_results" && index === 0 ? "先核查当前有效评分汇总" : reviewStepNames[step]}</li>)}</ol>;
}
/** 自检结果只陈述边界结论与条目，不提供分数或定性结论。 */
function IntegrityView({ report }: { report: IntegrityReport }) {
  const attention = report.checks.filter(item => item.status === "attention");
  return <div className={styles.preview}>
    <p><span className={styles.badge}>{report.status === "pass" ? "自检通过" : `自检发现 ${attention.length} 项需处理`}</span> {report.notice}</p>
    <div className={styles.cards}>{report.checks.map(item => <article key={item.id} className={styles.card}>
      <div className={styles.cardTop}><strong>{item.label}</strong><span className={styles.badge}>{item.status === "pass" ? "通过" : `需处理 ${item.count}`}</span></div>
      <p>{item.notice}</p>
      {!!item.items.length && <ul className={styles.prose}>{item.items.map((entry, index) => <li key={`${item.id}:${entry.assignmentId ?? entry.snapshotId ?? index}:${index}`}>{entry.judgeUserId ? `评委 ${entry.judgeUserId} · ` : ""}{entry.snapshotId ? `作品 ${entry.snapshotId} · ` : ""}{entry.detail}</li>)}</ul>}
    </article>)}</div>
  </div>;
}
/** 校准只作为派生对照展示：原始分与名次始终排在前面，校准分不改变公布内容。 */
function CalibrationView({ report, judgeOptions }: { report: CalibrationReport; judgeOptions?: readonly { userId: string; displayName: string }[] }) {
  const name = (userId: string) => judgeOptions?.find(item => item.userId === userId)?.displayName ?? userId;
  const flagged = report.judges.filter(judge => judge.compressionFlagged);
  return <div className={styles.preview}>
    <p><span className={styles.badge}>{report.status === "applied" ? "已启用校准（派生）" : "样本不足，未校准"}</span> 门槛：每位评委至少 {report.thresholds.minScoresPerJudge} 份已完成评分，至少 {report.thresholds.minScoredSnapshots} 个作品获得两位及以上评委评分。</p>
    <p className={styles.hint}>{report.notice}</p>
    {!!flagged.length && <div className={styles.reviewAlert} role="status"><h3>需要人工复核的评委打分</h3><p>{flagged.map(judge => name(judge.judgeUserId)).join("、")} 给不同作品的分数几乎没有区别（标准差低于 {report.thresholds.compressionSigma} 分）。这可能是评委的真实共识，也可能只是打分习惯；请人工核对，不要据此直接判定分数无效。</p></div>}
    {!report.judges.length ? <Empty>本轮还没有已提交的评委评分。</Empty> : <div className={styles.cards}>{report.judges.map(judge => <article key={judge.judgeUserId} className={styles.card}>
      <div className={styles.cardTop}><strong>{name(judge.judgeUserId)}</strong><span className={styles.badge}>{judge.eligible ? `已完成 ${judge.submittedCount} 份` : `样本不足 ${judge.submittedCount} 份`}</span></div>
      <p>本人平均分：{judge.mean === null ? "—" : judge.mean.toFixed(2)} · 本人标准差：{judge.standardDeviation === null ? "—" : judge.standardDeviation.toFixed(2)}</p>
    </article>)}</div>}
    <div className={styles.cards}>{report.rows.map(row => <article key={row.snapshotId} className={styles.card}>
      <div className={styles.cardTop}><strong>{row.title || row.snapshotId}</strong><span className={styles.badge}>{row.rawRank === null ? "原始分未进入排名" : `原始第 ${row.rawRank} 名`}</span></div>
      <p>原始分：{row.rawTotal === null ? "缺评，未进入汇总" : row.rawTotal.toFixed(2)}{row.calibratedTotal === null ? "" : ` · 校准分（仅参考）：${row.calibratedTotal.toFixed(2)}${row.calibratedRank === null ? "" : `（第 ${row.calibratedRank} 名）`}`}</p>
    </article>)}</div>
    {!!report.excludedScores.length && <details className={styles.details}><summary>未进入汇总的评分（{report.excludedScores.length}）</summary><ul className={styles.prose}>{report.excludedScores.map(item => <li key={item.assignmentId}>{name(item.judgeUserId)} · {item.reason === "not_submitted" ? "尚未提交评分" : "指派已回避、待复核或已撤销，评分不计入汇总"}</li>)}</ul></details>}
  </div>;
}
/**
 * 评审进度（派生只读视图）。
 * 只报"已有 / 还差"：不出百分比、进度条、完成度或评委排名，也不把未提交写成"不负责"。
 * 已排除的指派（回避 / 待核查 / 已撤销）单独成组并标注原因，且不计入分母。
 */
function ProgressView({ report, judgeOptions }: { report: ProgressReport; judgeOptions?: readonly { userId: string; displayName: string }[] }) {
  const name = (userId: string) => judgeOptions?.find(item => item.userId === userId)?.displayName ?? userId;
  const statusText = report.status === "empty" ? "本轮尚未排定指派" : report.status === "complete" ? "本轮已收齐" : "本轮仍在收集中";
  return <div className={styles.preview}>
    <p><span className={styles.badge}>{statusText}</span> 本轮最少评委数：{report.requiredJudges} 位 · 已排定有效指派 {report.assignedTotal} 项 · 已提交评分 {report.submittedTotal} 份。</p>
    <p className={styles.hint}>{report.notice}</p>
    <div className={styles.progressGrid}>
      <div className={styles.progressCol}>
        <h4>按作品（{report.snapshotCount} 件）</h4>
        {!report.rows.length ? <Empty>本轮作品名单为空。</Empty> : <ul className={styles.linkList}>{report.rows.map(row => <li key={row.snapshotId} className={styles.progressRow}>
          <span><strong>{row.title || row.snapshotId}</strong><small className={styles.hint}>已提交 {row.submittedCount} / 最少 {row.requiredJudges}</small></span>
          {row.complete ? <span className={`${styles.badge} ${styles.badgeSuccess}`}>已收齐</span> : <span className={`${styles.badge} ${styles.badgeWarning}`}>还差 {row.stillNeeds} 位</span>}
        </li>)}</ul>}
        {!!report.remaining.length && <p className={styles.hint}>尚未收齐：{report.remaining.map(row => `${row.title || row.snapshotId}（还差 ${row.stillNeeds} 位）`).join("、")}。</p>}
      </div>
      <div className={styles.progressCol}>
        <h4>按评委（{report.judges.length} 位）</h4>
        {!report.judges.length ? <Empty>本轮还没有排定评委指派，因此没有评委进度。</Empty> : <ul className={styles.linkList}>{report.judges.map(row => <li key={row.judgeUserId} className={styles.progressRow}>
          <span><strong>{name(row.judgeUserId)}</strong><small className={styles.hint}>已提交 {row.submittedCount} / 应评 {row.assignedCount}{row.excludedCount ? ` · 另有 ${row.excludedCount} 项指派已排除` : ""}</small></span>
          {row.outstanding ? <span className={`${styles.badge} ${styles.badgeWarning}`}>还差 {row.outstanding} 份</span> : <span className={`${styles.badge} ${styles.badgeSuccess}`}>已交齐</span>}
        </li>)}</ul>}
      </div>
    </div>
    <details className={styles.details}>
      <summary>已排除、不计入分母的指派（{report.excluded.length} 项）</summary>
      <p className={styles.hint}>这些指派不会进入"应评数"分母，也不会被计入进度；列出原因只为便于你核对边界，不代表对任何人的评价。</p>
      {!report.excluded.length ? <Empty>没有被排除的指派。</Empty> : <ul className={styles.linkList}>{report.excluded.map(item => <li key={item.assignmentId} className={styles.progressRow}>
        <span><strong>{name(item.judgeUserId)}</strong><small className={styles.hint}>{item.reason}</small></span>
        <span className={`${styles.badge} ${styles.badgeMuted}`}>{assignmentNames[item.status]}</span>
      </li>)}</ul>}
    </details>
    <p className={styles.hint}>本视图只汇总本站已保存的事实，刷新即重新计算：不发起催办、不改变任何评分或指派，也不向任何评委发送通知。</p>
  </div>;
}
const initialConfig = (): JudgingConfig => ({
  title: "作品评审", minJudges: 2, missingPolicy: "block_publication", tiePolicy: "shared_rank",
  criteria: [
    { id: "idea", label: "想法与问题价值", weight: 30, min: 0, max: 10 },
    { id: "execution", label: "实现与完整程度", weight: 40, min: 0, max: 10 },
    { id: "presentation", label: "展示与表达", weight: 30, min: 0, max: 10 },
  ],
});
function urlId(value: string) { return encodeURIComponent(value); }
function competitionPath(eventId: string) { return `/competitions/${urlId(eventId)}`; }
function organizerPath(eventId: string) { return `/organizer/events/${urlId(eventId)}`; }
function judgingPath(eventId: string) { return `/judging/${urlId(eventId)}`; }
function httpsLink(value: string): string | null {
  const result = safeLink(value);
  return result?.startsWith("https:") ? result : null;
}
function Context({ context, identity, deadline, showDeadline = false }: { context: EventJudgingContextProps; identity: string; deadline?: string | null; showDeadline?: boolean }) {
  return <header className={styles.context}>
    <p className={styles.eyebrow}>{context.organizationName} · {identity}</p>
    <h2>{context.eventTitle}</h2>
    {(showDeadline || deadline !== undefined) && <p className={styles.deadline}>作品提交截止：{deadline === undefined ? "待读取，请核对正式预览或赛事信息" : deadline ? dateText(deadline) : "尚未设置，请联系主办方"}</p>}
  </header>;
}
function Notice({ children, error = false }: { children?: ReactNode; error?: boolean }) {
  return children ? <p className={`${styles.notice} ${error ? styles.error : ""}`} role={error ? "alert" : "status"}>{children}</p> : null;
}
function Empty({ children }: { children: ReactNode }) { return <p className={styles.empty}>{children}</p>; }
function Materials({ materials }: { materials: SubmissionMaterials }) {
  return <div className={styles.materials}>
    <h3>{materials.title}</h3><p className={styles.prose}>{materials.description}</p>
    {!!materials.links.length && <ul className={styles.linkList}>{materials.links.map((link, index) => <li key={index}>{httpsLink(link.url) ? <a href={httpsLink(link.url)!} target="_blank" rel="noopener noreferrer">{link.label || link.url} ↗</a> : <span>{link.label}：链接不可打开</span>}</li>)}</ul>}
    {!!materials.files.length && <div className={styles.cards}>{materials.files.map((file, index) => <div className={styles.card} key={index}>
      <strong>{file.name}</strong><p>{file.sizeBytes.toLocaleString()} 字节 · {file.mediaType}</p>
      {httpsLink(file.url) && <a href={httpsLink(file.url)!} target="_blank" rel="noopener noreferrer">打开提交的文件链接 ↗</a>}
      <details><summary>提交者提供的校验信息</summary><p className={styles.mono}>SHA-256：{file.sha256}</p></details>
    </div>)}</div>}
    <p className={styles.hint}>这些是队伍正式提交的文字、链接和文件说明。收件不表示平台已下载文件或运行作品。</p>
  </div>;
}
function Receipt({ receipt }: { receipt: IntakeReceipt }) {
  return <article className={styles.card}>
    <div className={styles.cardTop}><strong>{receipt.materials.title}</strong><span className={styles.badge}>第 {receipt.version} 版 · 已收件</span></div>
    <p>回执号：<span className={styles.mono}>{receipt.receiptNumber}</span></p>
    <p>收到时间：{dateText(receipt.submittedAt)}</p>
    <details><summary>查看已冻结材料与回执依据</summary><Materials materials={receipt.materials} /><p>正式规则版本：{receipt.ruleVersion} · 收件时队伍版本：{receipt.teamRevision}</p><p className={styles.mono}>材料哈希：{receipt.materialHash}</p></details>
  </article>;
}

/** Root should also key by the trusted current account ID, so account changes discard private drafts. */
export function EventSubmissionPanel(props: EventSubmissionPanelProps) {
  return <SubmissionPanel key={`${props.eventId}:${props.teamId}`} {...props} />;
}
function SubmissionPanel(props: EventSubmissionPanelProps) {
  const id = useId();
  const history = useApi<{ items: IntakeReceipt[] }>(`${competitionPath(props.eventId)}/my-submissions?teamId=${urlId(props.teamId)}`);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [links, setLinks] = useState([{ label: "作品或演示链接", url: "" }]);
  const [files, setFiles] = useState<{ name: string; url: string; sizeBytes: string; sha256: string; mediaType: string }[]>([]);
  const [preview, setPreview] = useState<SubmissionPreview | null>(null);
  const [lastReceipt, setLastReceipt] = useState<IntakeReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false); const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [failed, setFailed] = useState(false);
  useEffect(() => {
    const clear = () => { setTitle(""); setDescription(""); setLinks([{ label: "作品或演示链接", url: "" }]); setFiles([]); setPreview(null); setLastReceipt(null); setConfirmed(false); setKey(""); };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);
  function edit(change: () => void) { change(); setPreview(null); setConfirmed(false); setKey(""); setNote(""); }
  function readMaterials(): SubmissionMaterials {
    const usableLinks = links.filter(link => link.url.trim());
    if (usableLinks.some(link => !httpsLink(link.url.trim()))) throw new Error("作品链接需要完整的 HTTPS 地址，请检查后再预览。");
    const metadata = files.map(file => {
      if (!httpsLink(file.url.trim()) || !/^\d+$/.test(file.sizeBytes) || !Number.isSafeInteger(Number(file.sizeBytes)) || Number(file.sizeBytes) > 1073741824 || !/^[a-fA-F0-9]{64}$/.test(file.sha256.trim())) throw new Error("文件说明需要 HTTPS 链接、不超过 1 GB 的非负整数字节数和 64 位 SHA-256。");
      return { name: file.name.trim(), url: file.url.trim(), sizeBytes: Number(file.sizeBytes), sha256: file.sha256.trim(), mediaType: file.mediaType.trim() };
    });
    return { title: title.trim(), description: description.trim(), links: usableLinks.map(link => ({ label: link.label.trim(), url: link.url.trim() })), files: metadata };
  }
  /** 提交前字段级自检：一次列出全部问题；有阻断项就不发请求（服务器校验仍是唯一权威）。 */
  const issues = useMemo(() => submissionPreflight({ title, description, links, files }), [title, description, links, files]);
  const blockers = useMemo(() => blockingIssues(issues), [issues]);
  async function showPreview(event: FormEvent) {
    event.preventDefault();
    if (blockers.length) { setFailed(false); setNote(`还有 ${blockers.length} 项需要先修正，已在表单下方逐条列出；这次没有发出任何请求。`); return; }
    setBusy(true); setNote(""); setFailed(false);
    try {
      const next = await api<SubmissionPreview>(`${competitionPath(props.eventId)}/submissions/preview`, { method: "POST", body: { teamId: props.teamId, materials: readMaterials() } });
      if (next.eventId !== props.eventId || next.teamId !== props.teamId) throw new Error("赛事或队伍上下文已变化，请重新进入本赛事。");
      setPreview(next); setConfirmed(false); setKey(operationKey()); setNote("请核对下面的冻结预览，再确认正式交给主办方。");
    } catch (error) { setFailed(true); setNote(`${message(error)} 输入已保留。`); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!preview || !confirmed || !key) return;
    setBusy(true); setNote(""); setFailed(false);
    try {
      const receipt = await api<IntakeReceipt>(`${competitionPath(props.eventId)}/submissions/submit`, { method: "POST", idempotencyKey: key, body: {
        teamId: props.teamId, materials: preview.materials, expectedEventRevision: preview.eventRevision,
        expectedTeamRevision: preview.teamRevision, expectedPreviousVersion: preview.previousVersion,
        expectedMaterialHash: preview.materialHash, idempotencyKey: key,
      } });
      if (receipt.eventId !== props.eventId || receipt.teamId !== props.teamId) throw new Error("回执上下文不一致，请重新读取本赛事回执。");
      setLastReceipt(receipt); setPreview(null); setConfirmed(false); setNote("主办方已正式收到本版材料。下一步：保存回执，等待评审与公布。"); void history.reload();
    } catch (error) { setFailed(true); setNote(`${message(error)} 材料与本次提交标识已保留；网络中断后重试会使用同一标识，也可先刷新回执确认。`); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-label="正式提交作品">
    <Context context={props} identity="当前队伍 · 正式交件" deadline={preview?.submissionClosesAt ?? props.deadline} showDeadline />
    <p className={styles.next}>下一步：填写最终材料 → 预览并核对 → 正式提交 → 查看收件回执。</p>
    <form className={styles.form} onSubmit={event => void showPreview(event)}>
      <Field label="作品名称" hint="必填。填写本次正式提交的作品名，应与演示和项目资料一致。"><input id={`${id}-title`} required maxLength={160} value={title} disabled={busy} onChange={event => edit(() => setTitle(event.target.value))} /></Field>
      <Field label="作品说明" hint="必填。写解决的问题、已经完成的功能、体验步骤和限制，帮助主办方核对正式材料。"><textarea id={`${id}-description`} required rows={5} maxLength={12000} value={description} disabled={busy} onChange={event => edit(() => setDescription(event.target.value))} placeholder="说明解决什么问题、已完成什么，以及如何体验。" /></Field>
      <fieldset className={styles.fieldset}><legend>作品与演示链接</legend>{links.map((link, index) => <div className={styles.linkEditor} key={index}>
        <Field label="链接名称" hint="填写网址时必填。写明用途，例如演示网站、代码仓库或路演视频。"><input value={link.label} required={!!link.url.trim()} maxLength={100} disabled={busy} onChange={event => edit(() => setLinks(links.map((item, position) => position === index ? { ...item, label: event.target.value } : item)))} /></Field>
        <Field label="HTTPS 地址" hint="选填。粘贴主办方和评委能访问的完整 https:// 链接，先检查权限；不能放账号密码。"><input type="url" inputMode="url" value={link.url} maxLength={2048} disabled={busy} placeholder="https://" onChange={event => edit(() => setLinks(links.map((item, position) => position === index ? { ...item, url: event.target.value } : item)))} /></Field>
        <button className={styles.tertiary} type="button" disabled={busy} onClick={() => edit(() => setLinks(links.filter((_, position) => position !== index)))}>移除此链接</button>
      </div>)}<button className={styles.secondary} type="button" disabled={busy || links.length >= 12} onClick={() => edit(() => setLinks([...links, { label: "", url: "" }]))}>添加链接</button></fieldset>
      <details className={styles.details}><summary>文件说明（可选）</summary><p className={styles.hint}>提供已托管文件的链接及元数据。此处不会上传文件；不要填写电脑路径。</p>
        {files.map((file, index) => <fieldset className={styles.fieldset} key={index}><legend>文件 {index + 1}</legend><div className={styles.grid}>
          {([{ key: "name", label: "文件名称", max: 180 }, { key: "url", label: "HTTPS 下载链接", max: 2048 }, { key: "sizeBytes", label: "文件大小（字节，最多 1 GB）", max: 10 }, { key: "mediaType", label: "文件类型", max: 120 }, { key: "sha256", label: "SHA-256", max: 64 }] as const).map(field => <label className={styles.field} key={field.key}>{field.label}<input required maxLength={field.max} type={field.key === "url" ? "url" : "text"} inputMode={field.key === "sizeBytes" ? "numeric" : undefined} value={file[field.key]} disabled={busy} onChange={event => edit(() => setFiles(files.map((item, position) => position === index ? { ...item, [field.key]: event.target.value } : item)))} /></label>)}
        </div><button className={styles.tertiary} type="button" disabled={busy} onClick={() => edit(() => setFiles(files.filter((_, position) => position !== index)))}>移除此文件说明</button></fieldset>)}
        <button className={styles.secondary} type="button" disabled={busy || files.length >= 12} onClick={() => edit(() => setFiles([...files, { name: "", url: "", sizeBytes: "", sha256: "", mediaType: "" }]))}>添加文件说明</button>
      </details>
      <button className={styles.primary} type="submit" disabled={busy || !!history.error}>{busy ? "正在处理…" : "预览正式提交材料"}</button>
      {!!issues.length && <div className={styles.preflight} role="status" aria-label="提交前自检">
        <h4>{blockers.length ? `提交前自检：还有 ${blockers.length} 项需要修正` : "提交前自检：可以提交，另有提示供你确认"}</h4>
        <p className={styles.hint}>这里一次列出全部问题，避免逐条试错；有需要修正的项时不会发出任何请求。</p>
        <ul className={styles.linkList}>{issues.map((issue, index) => <li key={index}>
          <span className={styles.badge}>{issue.severity === "block" ? "需要修正" : "提示"}</span> {issue.label}：{issue.message}
        </li>)}</ul>
      </div>}
    </form>
    {preview && <div className={styles.preview}><h3>第 {preview.previousVersion + 1} 版 · 即将正式提交</h3><Materials materials={preview.materials} /><p className={styles.deadline}>提交截止：{dateText(preview.submissionClosesAt)}</p><Notice>{preview.warning}</Notice>
      <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我已核对，将以上材料正式交给本赛事主办方；历史版本会保留。</label>
      <button className={styles.primary} type="button" disabled={busy || !confirmed} onClick={() => void submit()}>确认正式提交</button>
    </div>}
    <Notice error={failed}>{note}</Notice>
    <details className={styles.details}><summary>赛前自检与赛后复用清单（只读，不写入任何打勾）</summary><ChecklistView eventId={props.eventId} teamId={props.teamId}/></details>
    {lastReceipt && <Receipt receipt={lastReceipt} />}
    <div className={styles.sectionTop}><h3>本队伍的收件记录</h3><button className={styles.secondary} type="button" disabled={busy || history.loading} onClick={() => void history.reload()}>刷新回执</button></div>
    <Notice error>{history.error?.message}</Notice>
    {history.loading && <Empty>正在读取收件记录…</Empty>}
    {history.data && !history.data.items.length && <Empty>还没有正式收件记录。完成上方预览后，再明确确认提交。</Empty>}
    <div className={styles.cards}>{history.data?.items.filter(item => item.id !== lastReceipt?.id).map(receipt => <Receipt key={receipt.id} receipt={receipt} />)}</div>
  </section>;
}

export function JudgeWorkspace(props: JudgeWorkspaceProps) { return <JudgePanel key={props.eventId} {...props} />; }
function JudgePanel(props: JudgeWorkspaceProps) {
  const work = useApi<{ items: JudgeWorkItem[] }>(`${judgingPath(props.eventId)}/assignments`);
  const [selectedId, setSelectedId] = useState(""); const [reason, setReason] = useState<Record<string, string>>({});
  const [scoreDirty, setScoreDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [failed, setFailed] = useState(false);
  const selected = work.data?.items.find(item => item.assignment.id === selectedId);
  const canOpen = selected?.accessStatus === "available";
  const materials = useApi<JudgeMaterials>(canOpen ? `${judgingPath(props.eventId)}/assignments/${urlId(selectedId)}/materials` : null);
  useEffect(() => {
    if (!selectedId || selected?.accessStatus === "available") return;
    materials.setData(null); setSelectedId(""); setScoreDirty(false);
  }, [selectedId, selected?.accessStatus, materials.setData]);
  useEffect(() => { if (materials.error) void work.reload(); }, [materials.error, work.reload]);
  useEffect(() => {
    const clear = () => { setSelectedId(""); setReason({}); setScoreDirty(false); };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);
  async function declare(item: JudgeWorkItem, hasConflict: boolean) {
    setBusy(true); setNote(""); setFailed(false);
    try {
      const assignment = await api<JudgeAssignment>(`${judgingPath(props.eventId)}/assignments/${urlId(item.assignment.id)}/conflicts`, { method: "POST", body: { expectedRevision: item.assignment.revision, hasConflict, reason: reason[item.assignment.id] ?? "" } });
      setSelectedId(""); setScoreDirty(false); materials.setData(null); work.setData(null);
      await work.reload();
      if (!hasConflict) setSelectedId(assignment.id);
      setNote(hasConflict ? "已记录回避，不能继续读取或评分本作品。请处理其他已指派作品。" : "已记录本人无冲突声明；材料访问以最新核查结果为准。系统检查不涵盖所有线下关系。");
    } catch (error) { setFailed(true); setNote(`${message(error)} 申报说明已保留。`); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-label="评委工作台">
    <Context context={props} identity="本人评委工作台" />
    <p className={styles.next}>下一步：确认利益冲突 → 阅读正式材料 → 保存草稿 → 明确提交人工评分。</p>
    <div className={styles.sectionTop}><h3>我的指派</h3><button className={styles.secondary} type="button" disabled={busy || work.loading || scoreDirty} onClick={() => { setSelectedId(""); void work.reload(); }}>刷新指派</button></div>
    {scoreDirty && <Notice>有未保存评分。先保存草稿或提交后切换作品；也可<button className={styles.inlineButton} type="button" disabled={busy} onClick={() => { setSelectedId(""); setScoreDirty(false); }}>放弃未保存评分</button>。</Notice>}
    <Notice error>{work.error?.message}</Notice><Notice error={failed}>{note}</Notice>
    {work.loading && <Empty>正在读取当前赛事指派…</Empty>}
    {work.data && !work.data.items.length && <Empty>当前赛事没有指派给你的作品。请联系本赛事负责人。</Empty>}
    <div className={styles.cards}>{work.data?.items.map(item => <article className={styles.card} key={item.assignment.id}>
      <div className={styles.cardTop}><strong>{item.accessStatus === "available" ? item.title : protectedTitles[item.accessStatus] ?? "材料访问待核查"}</strong><span className={styles.badge}>{accessNames[item.accessStatus] ?? "访问待核查"}</span></div>
      <p>{item.round.config.title} · {roundNames[item.round.status]} · {item.accessStatus !== "available" ? "材料与评分当前不可读" : item.score?.state === "submitted" ? "评分已提交" : item.score ? "有评分草稿" : "尚未评分"}</p>
      {!!item.assignment.conflictReasons.length && <p className={styles.hint}>核查说明：{item.assignment.conflictReasons.join("；")}</p>}
      {["active", "needs_review"].includes(item.assignment.status) && <>
        <p className={styles.hint}>请核对本人是否是队伍成员、提供过辅导，或有其他影响公正的关系；平台无法获知所有线下关联。</p>
        {item.accessStatus === "pending_declaration" && item.round.status === "open" && <button className={styles.primary} type="button" disabled={busy || scoreDirty} onClick={() => void declare(item, false)}>确认本人无利益冲突</button>}
        {item.accessStatus === "available" && <button className={styles.primary} type="button" disabled={busy || scoreDirty || selectedId === item.assignment.id} onClick={() => setSelectedId(item.assignment.id)}>打开材料与评分</button>}
        <details className={styles.details}><summary>申报回避（锁定后发现冲突仍可申报）</summary><Field label="回避原因" hint="申报回避时必填。说明与该队的辅导、合作或其他利益关系；记录后会停止本次材料访问和评分。"><textarea maxLength={1000} rows={3} disabled={busy} value={reason[item.assignment.id] ?? ""} onChange={event => setReason({ ...reason, [item.assignment.id]: event.target.value })} /></Field><button className={styles.danger} type="button" disabled={busy || !(reason[item.assignment.id] ?? "").trim()} onClick={() => void declare(item, true)}>记录回避并停止访问</button></details>
      </>}
      {item.accessStatus === "needs_review" && <p className={styles.hint}>当前关联或指派需要工作人员重新核查。已有无冲突声明不能替代本次访问授权。</p>}
    </article>)}</div>
    {materials.loading && <Empty>正在核对权限并读取正式材料…</Empty>}<Notice error>{materials.error?.message}</Notice>
    {canOpen && materials.data && <JudgeScoreForm key={selectedId} eventId={props.eventId} view={materials.data} onDirty={setScoreDirty} onSaved={score => {
      materials.setData(current => current?.assignment.id === score.assignmentId ? { ...current, score } : current);
      work.setData(current => current ? { items: current.items.map(item => item.assignment.id === score.assignmentId && item.accessStatus === "available" ? { ...item, score } : item) } : current);
    }} onRefresh={materials.reload} />}
  </section>;
}
function JudgeScoreForm({ eventId, view, onSaved, onRefresh, onDirty }: { eventId: string; view: JudgeMaterials; onSaved(score: ManualScore): void; onRefresh(): Promise<void>; onDirty(value: boolean): void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(view.round.config.criteria.map(item => [item.id, view.score?.values[item.id]?.toString() ?? ""])));
  const [feedback, setFeedback] = useState(view.score?.feedback ?? ""); const [correction, setCorrection] = useState("");
  const [confirmed, setConfirmed] = useState(false); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [failed, setFailed] = useState(false);
  const revision = useRef(view.score?.revision ?? 0);
  const writable = view.round.status === "open" && view.assignment.status === "active" && view.assignment.declaration === "clear";
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (revision.current === (view.score?.revision ?? 0)) return;
    revision.current = view.score?.revision ?? 0;
    if (!dirty) { setValues(Object.fromEntries(view.round.config.criteria.map(item => [item.id, view.score?.values[item.id]?.toString() ?? ""]))); setFeedback(view.score?.feedback ?? ""); }
    else setNote("已读取更新后的评分版本，本地输入保留，请逐项核对后保存。");
  }, [view, dirty]);
  async function save(state: "draft" | "submit") {
    setBusy(true); setNote(""); setFailed(false);
    try {
      const scoreValues: Record<string, number> = {};
      for (const criterion of view.round.config.criteria) {
        const raw = values[criterion.id]?.trim();
        if (!raw) { if (state === "submit") throw new Error(`请填写“${criterion.label}”的分数；缺失分不会当作 0。`); continue; }
        const numeric = Number(raw);
        if (!Number.isInteger(numeric) || numeric < criterion.min || numeric > criterion.max) throw new Error(`“${criterion.label}”须是 ${criterion.min} 至 ${criterion.max} 之间的整数。`);
        scoreValues[criterion.id] = numeric;
      }
      const next = await api<ManualScore>(`${judgingPath(eventId)}/assignments/${urlId(view.assignment.id)}/scores/${state}`, { method: "POST", body: {
        expectedAssignmentRevision: view.assignment.revision, expectedScoreRevision: view.score?.revision ?? 0,
        values: scoreValues, feedback, ...(view.score ? { correctionReason: correction } : {}),
      } });
      setDirty(false); setConfirmed(false); setCorrection(""); revision.current = next.revision; onSaved(next);
      setNote(state === "draft" ? "评分草稿已保存，尚未进入最终汇总。下一步：核对各项分数后提交。" : "人工评分已提交，系统将按已冻结标准汇总。负责人确认公布后，选手才能看到允许公开的结果。");
    } catch (error) { setFailed(true); setNote(`${message(error)} 分数、反馈和修改说明已保留。`); }
    finally { setBusy(false); }
  }
  return <article className={styles.preview}>
    <div className={styles.sectionTop}><h3>正式材料 · 第 {view.receipt.version} 版</h3><span className={styles.badge}>{roundNames[view.round.status]}</span></div>
    <p>回执号：{view.receipt.receiptNumber} · {dateText(view.receipt.submittedAt)}</p><Materials materials={view.receipt.materials} />
    <h3>按冻结标准人工评分</h3>
    <p className={styles.hint}>分数由你填写。各维度按分数范围换算为 0–100，再按权重汇总；有效评委等权平均。草稿不算已提交评分。</p>
    <div className={styles.criteria}>{view.round.config.criteria.map(criterion => <label className={styles.scoreField} key={criterion.id}><span><strong>{criterion.label}</strong><small>权重 {criterion.weight}% · {criterion.min}–{criterion.max} 分</small></span><input type="number" step={1} min={criterion.min} max={criterion.max} value={values[criterion.id] ?? ""} disabled={busy || !writable} aria-label={`${criterion.label}分数`} onChange={event => { setValues({ ...values, [criterion.id]: event.target.value }); setDirty(true); setConfirmed(false); }} /></label>)}</div>
    <Field label="人工反馈" hint="选填。根据已读作品写具体优点和改进建议；原始反馈不会自动公开，负责人另行确认公布内容。"><textarea rows={4} maxLength={3000} value={feedback} disabled={busy || !writable} onChange={event => { setFeedback(event.target.value); setDirty(true); setConfirmed(false); }} placeholder="引用作品中的具体事实，说明优点及建议。公开内容由负责人另外确认。" /></Field>
    {view.score && <Field label={"本次修改说明" + (view.score.state === "submitted" ? "（必填）" : "（可选）")} hint={"修改已提交分数时必填，草稿更正选填。说明具体变化和原因，例如“核对演示后将完成度从 6 分改为 7 分”；旧记录保留。"}><input maxLength={1000} value={correction} disabled={busy || !writable} onChange={event => { setCorrection(event.target.value); setDirty(true); }} placeholder="修改已提交评分时说明原因，历史记录保留。" /></Field>}
    {writable ? <><label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我已阅读原材料，核对所有维度，并确认提交这份人工评分。</label><div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy || view.score?.state === "submitted"} onClick={() => void save("draft")}>保存评分草稿</button><button className={styles.primary} type="button" disabled={busy || !confirmed || view.score?.state === "submitted" && !correction.trim()} onClick={() => void save("submit")}>{view.score?.state === "submitted" ? "提交评分纠正" : "提交人工评分"}</button><button className={styles.tertiary} type="button" disabled={busy} onClick={() => void onRefresh()}>刷新当前版本</button></div></> : <Notice>当前轮次或指派不可评分；已提交记录保留。</Notice>}
    <Notice error={failed}>{note}</Notice>
  </article>;
}

export function JudgingManager(props: JudgingManagerProps) { return <ManagerPanel key={props.eventId} {...props} />; }
function ManagerPanel(props: JudgingManagerProps) {
  const actionsId = useId();
  const workspace = useApi<JudgingWorkspace>(`${organizerPath(props.eventId)}/judging/config`);
  const [roundId, setRoundId] = useState(""); const [config, setConfig] = useState<JudgingConfig>(initialConfig);
  const [configDirty, setConfigDirty] = useState(false); const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(""); const [failed, setFailed] = useState(false);
  const [snapshotId, setSnapshotId] = useState(""); const [judgeUserId, setJudgeUserId] = useState("");
  const [assignmentReasons, setAssignmentReasons] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<SummaryPreview | null>(null);
  const [visibility, setVisibility] = useState<PublishInput["visibility"]>("participants");
  const [feedback, setFeedback] = useState<Record<string, { text: string; visibility: "team" | "public" }>>({});
  const [order, setOrder] = useState<string[]>([]); const [approved, setApproved] = useState(false); const [withdrawReason, setWithdrawReason] = useState("");
  const [published, setPublished] = useState<PublishedResults | null>(null);
  const [calibrationReport, setCalibrationReport] = useState<CalibrationReport | null>(null);
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);
  const [fairnessReport, setFairnessReport] = useState<FairnessReport | null>(null);
  const [progressReport, setProgressReport] = useState<ProgressReport | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [publicationDirty, setPublicationDirty] = useState(false);
  const initialized = useRef(false);
  const configRevision = useRef<string>("");
  const lastRefreshRevision = useRef(props.refreshRevision);
  const round = workspace.data?.rounds.find(item => item.id === roundId);
  const publicationReviews = workspace.data?.publicationReviews.filter(item => item.required && workspace.data?.rounds.some(round => round.id === item.roundId && round.status === "published")) ?? [];
  const currentPublicationReview = round?.status === "published" ? publicationReviews.find(item => item.roundId === round.id) : undefined;
  const configurable = !round || round.status === "setup";
  const weight = config.criteria.reduce((sum, item) => sum + item.weight, 0);
  useEffect(() => {
    if (Object.is(lastRefreshRevision.current, props.refreshRevision)) return;
    lastRefreshRevision.current = props.refreshRevision;
    void workspace.reload();
  }, [props.refreshRevision, workspace.reload]);
  useEffect(() => {
    if (!workspace.data || initialized.current) return;
    initialized.current = true;
    const latest = workspace.data.rounds.at(-1);
    if (latest) { setRoundId(latest.id); setConfig(latest.config); }
  }, [workspace.data]);
  useEffect(() => {
    if (!round) return;
    const current = `${round.id}:${round.revision}`;
    if (configRevision.current === current) return;
    configRevision.current = current;
    if (!configDirty) setConfig(round.config);
    else setNote("已读取当前轮次的新修订，本地配置仍保留，请核对后再保存。");
  }, [round, configDirty]);
  useEffect(() => {
    const clear = () => { setRoundId(""); setConfig(initialConfig()); setConfigDirty(false); setSnapshotId(""); setJudgeUserId(""); setAssignmentReasons({}); setPreview(null); setFeedback({}); setOrder([]); setApproved(false); setPublished(null); setWithdrawReason(""); setReopenReason(""); setPublicationDirty(false); setCalibrationReport(null); setIntegrityReport(null); setFairnessReport(null); setProgressReport(null); configRevision.current = ""; initialized.current = false; };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);
  function editConfig(next: JudgingConfig) { setConfig(next); setConfigDirty(true); setPreview(null); setApproved(false); }
  function chooseRound(value: string) {
    const next = workspace.data?.rounds.find(item => item.id === value);
    setRoundId(value); setConfig(next?.config ?? initialConfig()); setConfigDirty(false); setPreview(null); setPublished(null); setFeedback({}); setOrder([]); setApproved(false); setSnapshotId(""); setPublicationDirty(false); setNote("");
    // 进度与轮次强相关：切换轮次必须清空，避免把上一轮的进度当成当前轮。
    // 其余派生视图保持既有行为不变（不在本次授权范围内）。
    setProgressReport(null);
  }
  function updateRound(next: JudgingRound) {
    workspace.setData(current => current ? { ...current,
      rounds: current.rounds.some(item => item.id === next.id) ? current.rounds.map(item => item.id === next.id ? next : item) : [...current.rounds, next],
      publicationReviews: next.status === "published" ? current.publicationReviews : current.publicationReviews.filter(item => item.roundId !== next.id),
    } : current);
    setRoundId(next.id);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setNote(""); setFailed(false);
    try { await action(); } catch (error) { setFailed(true); setNote(`${message(error)} 本页输入已保留；版本冲突时请刷新并核对。`); }
    finally { setBusy(false); }
  }
  async function saveConfig(event: FormEvent) {
    event.preventDefault(); await run(async () => {
      const next = await api<JudgingRound>(`${organizerPath(props.eventId)}/judging/config`, { method: "PUT", body: { ...(round ? { roundId: round.id } : {}), expectedRevision: round?.revision ?? 0, config } });
      updateRound(next); setConfig(next.config); setConfigDirty(false); setNote("评分配置已保存。下一步：核对正式收件名单，再冻结标准并开始评审。");
    });
  }
  async function transition(action: "start" | "lock") {
    if (!round) return;
    await run(async () => {
      const next = await api<JudgingRound>(`${organizerPath(props.eventId)}/judging/rounds/${urlId(round.id)}/${action}`, { method: "POST", body: { expectedRevision: round.revision } });
      updateRound(next); setPreview(null); setApproved(false); setNote(action === "start" ? "标准和本轮正式作品名单已冻结。下一步：指派无冲突评委。" : "评分已锁定。下一步：预览汇总，核对缺评及同分，再人工确认公布。");
    });
  }
  async function assign(event: FormEvent) {
    event.preventDefault(); if (!round) return;
    await run(async () => {
      const assignment = await api<JudgeAssignment>(`${organizerPath(props.eventId)}/judge-assignments`, { method: "POST", body: { roundId: round.id, snapshotId, judgeUserId, expectedRoundRevision: round.revision } });
      workspace.setData(current => current ? { ...current, assignments: [...current.assignments.filter(item => item.id !== assignment.id), assignment] } : current);
      setPreview(null); setApproved(false); setNote(assignment.status === "needs_review" ? "指派已记录，但关联核查尚不确定。下一步：人工核查并说明；此评委尚不能读取作品。" : "已记录指派。下一步：评委本人申报利益冲突，阅读并人工评分。");
    });
  }
  async function changeAssignment(item: JudgeAssignment, action: "review" | "revoke") {
    await run(async () => {
      const next = await api<JudgeAssignment>(`${organizerPath(props.eventId)}/judging/assignments/${urlId(item.id)}/${action}`, { method: "POST", body: { expectedRevision: item.revision, reason: assignmentReasons[item.id] ?? "" } });
      workspace.setData(current => current ? { ...current, assignments: current.assignments.map(value => value.id === next.id ? next : value) } : current);
      setPreview(null); setApproved(false); setNote(action === "review" ? "人工核查说明已记录。评委仍需本人申报无冲突后评分。" : "指派已撤销，此评委不能继续访问该作品。历史评分记录保留。");
    });
  }
  async function showSummary(targetRoundId = round?.id) {
    if (!targetRoundId) return;
    await run(async () => {
      const next = await api<SummaryPreview>(`${organizerPath(props.eventId)}/judging/results/preview`, { method: "POST", body: { roundId: targetRoundId } });
      updateRound(next.round); setPreview(next); if (!publicationDirty) setOrder(next.summary.rows.filter(row => row.total !== null).map(row => row.snapshotId)); setApproved(false);
      workspace.setData(current => current ? { ...current, publicationReviews: [
        ...current.publicationReviews.filter(item => item.roundId !== next.round.id),
        ...(next.round.status === "published" && next.round.publishedResultId ? [{ roundId: next.round.id, publishedResultId: next.round.publishedResultId, ...next.publicationReview }] : []),
      ] } : current);
      setNote(next.publicationReview.required ? "当前汇总与本版公布依据需要重新核查。请先核对汇总，再填写原因撤回公布并重新开放评分。" : next.summary.complete ? "已读取当前人工评分汇总。请核对同分、公开范围与反馈。" : "仍有作品缺评。请查看下方缺评数量及处理规则，必要时补充指派。");
    });
  }
  /** 派生视图：只读取校准结果，不写入任何事实，也不参与公布。 */
  async function showCalibration() {
    if (!round) return;
    await run(async () => {
      const next = await api<CalibrationReport>(`${organizerPath(props.eventId)}/judging/rounds/${urlId(round.id)}/calibration`);
      setCalibrationReport(next);
      setNote(next.status === "applied" ? "已读取校准视图。它只用于复核评委严格度差异，正式结果仍以原始分为准。" : next.notice);
    });
  }
  /** 只读边界自检：报告"回避与撤销是否真的没被计入"等问题，不修改任何事实。 */
  async function showIntegrity() {
    if (!round) return;
    await run(async () => {
      const next = await api<IntegrityReport>(`${organizerPath(props.eventId)}/judging/rounds/${urlId(round.id)}/integrity`);
      setIntegrityReport(next);
      setNote(next.notice);
    });
  }
  /** 只读公平规则包：整理本轮冻结规则与待人工确认的扣分建议，不修改任何事实、不自动扣分。 */
  async function showFairness() {
    if (!round) return;
    await run(async () => {
      const next = await api<FairnessReport>(`${organizerPath(props.eventId)}/judging/rounds/${urlId(round.id)}/fairness`);
      setFairnessReport(next);
      setNote(next.notice);
    });
  }
  /** 只读进度视图：只汇总既有事实，不发起催办、不改变任何评分或指派。 */
  async function showProgress() {
    if (!round) return;
    await run(async () => {
      const next = await api<ProgressReport>(`${organizerPath(props.eventId)}/judging/rounds/${urlId(round.id)}/progress`);
      setProgressReport(next);
      setNote(next.notice);
    });
  }
  async function copyFairness() {
    if (!fairnessReport) return;
    const text = `${fairnessReport.declaration.title}\n${fairnessReport.declaration.lines.map(line => `· ${line}`).join("\n")}`;
    try { await navigator.clipboard.writeText(text); setNote("规则包文本已复制。是否公开、放到哪里，由你决定；本站不会自动替你发布。"); }
    catch { setNote("浏览器没有允许自动复制，请手动选中上面的规则包文本复制。"); }
  }
  async function publish() {
    if (!round || !preview || !approved) return;
    await run(async () => {
      const input: PublishInput = {
        expectedRevision: preview.round.revision, expectedSummaryHash: preview.summaryHash, visibility,
        ...(preview.round.config.tiePolicy === "manual_order" ? { orderedSnapshotIds: order } : {}),
        approvedFeedback: preview.summary.rows.flatMap(row => feedback[row.snapshotId]?.text.trim() ? [{ snapshotId: row.snapshotId, text: feedback[row.snapshotId].text.trim(), visibility: feedback[row.snapshotId].visibility }] : []),
      };
      const next = await api<PublishedResults>(`${organizerPath(props.eventId)}/judging/results/publish`, { method: "POST", body: { roundId: round.id, ...input } });
      setPublished(next); setPreview(null); setApproved(false); setPublicationDirty(false); setNote(`人工确认的结果第 ${next.version} 版已公布。`); void workspace.reload();
    });
  }
  async function withdraw() {
    if (!round) return;
    await run(async () => {
      const next = await api<JudgingRound>(`${organizerPath(props.eventId)}/judging/results/withdraw`, { method: "POST", body: { roundId: round.id, expectedRevision: round.revision, reason: withdrawReason } });
      updateRound(next); setPublished(null); setPreview(null); setApproved(false); setNote("公布已撤回，历史版本保留。下一步：填写原因重新开放本轮评分，补评并处理指派后，再锁定、预览并人工公布。");
      await workspace.reload();
    });
  }
  async function reopen() {
    if (!round) return;
    await run(async () => {
      const next = await api<JudgingRound>(`${organizerPath(props.eventId)}/judging/rounds/${urlId(round.id)}/reopen`, { method: "POST", body: { expectedRevision: round.revision, reason: reopenReason } });
      updateRound(next); setPreview(null); setApproved(false); setNote("已记录重新开放原因。评分标准保持冻结，可补充分配或纠正评分；完成后重新锁定并核对结果。");
      await workspace.reload();
    });
  }
  const assignments = workspace.data?.assignments.filter(item => item.roundId === roundId) ?? [];
  const received = workspace.data?.submissions ?? [];
  const latestByTeam = received.filter(receipt => !received.some(other => other.teamId === receipt.teamId && other.version > receipt.version));
  const selectableReceipts = round ? received.filter(receipt => round.snapshotIds.includes(receipt.id)) : latestByTeam;
  const pendingScores = assignments.filter(item => item.status === "active" && !workspace.data?.scores.some(score => score.assignmentId === item.id && score.state === "submitted")).length;
  return <section className={styles.panel} aria-label="收件与人工评审管理">
    <Context context={props} identity="本赛事评审负责人" deadline={workspace.data?.submissionClosesAt} showDeadline />
    <p className={styles.next}>当前：{latestByTeam.length} 队已交件 · {assignments.filter(item => item.status === "needs_review").length} 项指派待核查 · {pendingScores} 份评分待提交。</p>
    {publicationReviews.map(review => <div className={styles.reviewAlert} role="alert" key={review.roundId}>
      <h3>{workspace.data?.rounds.find(item => item.id === review.roundId)?.config.title ?? "已公布轮次"} · 结果需要负责人复核</h3>
      <p>{review.notice ?? "当前有效评分与公布依据需要重新核查，暂不展示本版分数、排名和反馈。"}</p>
      <PublicationReviewSteps review={review} />
      <div className={styles.actions}><button className={styles.primary} type="button" disabled={busy || configDirty || publicationDirty} onClick={() => { if (roundId !== review.roundId) chooseRound(review.roundId); void showSummary(review.roundId); }}>核查本轮当前汇总</button>{roundId === review.roundId && <a className={styles.reviewLink} href={`#${actionsId}-withdraw`}>填写原因并撤回公布 ↓</a>}</div>
    </div>)}
    <div className={styles.sectionTop}><h3>评审轮次</h3><button className={styles.secondary} type="button" disabled={busy || workspace.loading} onClick={() => { setPreview(null); setApproved(false); void workspace.reload(); }}>刷新收件与评分</button></div>
    <Notice error>{workspace.error?.message}</Notice><Notice error={failed}>{note}</Notice>
    {workspace.loading && <Empty>正在核对本赛事管理权限…</Empty>}
    {workspace.data && <>
      <Field label="当前评审轮次" hint="选择需要运营的轮次；新建评审轮次可设置独立标准。开始评审后，本轮标准和作品名单冻结。"><select value={roundId} disabled={busy || configDirty || publicationDirty} onChange={event => chooseRound(event.target.value)}><option value="">新建评审轮次</option>{workspace.data.rounds.map(item => <option value={item.id} key={item.id}>{item.config.title} · {roundNames[item.status]}</option>)}</select></Field>
      {configDirty && <p className={styles.hint}>有未保存配置。保存后切换轮次，或<button type="button" className={styles.inlineButton} disabled={busy} onClick={() => chooseRound(roundId)}>放弃本轮配置修改</button>。</p>}
      {publicationDirty && <p className={styles.hint}>有尚未公布的反馈或排序，本地内容保留。确认公布后切换轮次，或<button type="button" className={styles.inlineButton} disabled={busy} onClick={() => { setPublicationDirty(false); setPreview(null); setFeedback({}); setOrder([]); setApproved(false); }}>放弃未公布的内容</button>。</p>}
      <form className={styles.form} onSubmit={event => void saveConfig(event)}>
        <Field label="轮次名称" hint="必填。填写这一阶段的名称，例如“初评”或“决赛路演”，便于评委识别。"><input required maxLength={100} value={config.title} disabled={busy || !configurable} onChange={event => editConfig({ ...config, title: event.target.value })} /></Field>
        <div className={styles.sectionTop}><h3>评分维度</h3><span className={weight === 100 ? styles.badge : styles.invalidWeight}>权重合计 {Number(weight.toFixed(6))}% / 100%</span></div>
        <div className={styles.criteria}>{config.criteria.map((criterion, index) => <fieldset key={criterion.id} className={styles.criterionEditor}><legend>维度 {index + 1}</legend><div className={styles.grid}>
          <Field label="维度名称" hint="必填。填写真人评委需要评分的项目，例如“问题价值”“完成度”；不要只写内部编号。"><input required maxLength={100} disabled={busy || !configurable} value={criterion.label} onChange={event => editConfig({ ...config, criteria: config.criteria.map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} /></Field>
          {([{ key: "weight", label: "权重（%）", min: 1, max: 100 }, { key: "min", label: "最低分", min: 0, max: 1000 }, { key: "max", label: "最高分", min: 1, max: 1000 }] as const).map(field => <Field label={field.label} hint={field.key === "weight" ? "必填整数。此维度占总分的百分比，1 至 100；各维度合计必须为 100%。" : field.key === "min" ? "必填整数。评委可打的最低分，0 至 1000，例如 0。" : "必填整数。评委可打的最高分，1 至 1000 且大于最低分，例如 10。"} key={field.key}><input type="number" step={1} required min={field.min} max={field.max} disabled={busy || !configurable} value={criterion[field.key]} onChange={event => editConfig({ ...config, criteria: config.criteria.map((item, position) => position === index ? { ...item, [field.key]: Number(event.target.value) } : item) })} /></Field>)}
        </div>{configurable && <button className={styles.tertiary} type="button" disabled={busy || config.criteria.length <= 1} onClick={() => editConfig({ ...config, criteria: config.criteria.filter((_, position) => position !== index) })}>移除此维度</button>}</fieldset>)}</div>
        {configurable && <button className={styles.secondary} type="button" disabled={busy || config.criteria.length >= 12} onClick={() => editConfig({ ...config, criteria: [...config.criteria, { id: `criterion-${operationKey()}`, label: "新维度", weight: 1, min: 0, max: 10 }] })}>添加评分维度</button>}
        <div className={styles.grid}><Field label="每件作品至少几位评委" hint="必填。输入 1 至 20 的整数，例如 3；每件作品需有这么多份有效人工评分才算齐全。"><input type="number" min={1} max={20} step={1} required disabled={busy || !configurable} value={config.minJudges} onChange={event => editConfig({ ...config, minJudges: Number(event.target.value) })} /></Field>
          <Field label="缺评处理" hint="补齐前阻止公布会等待缺评补完；缺评作品不进入排名允许公布其余作品。请按已公布比赛规则选择。"><select disabled={busy || !configurable} value={config.missingPolicy} onChange={event => editConfig({ ...config, missingPolicy: event.target.value as JudgingConfig["missingPolicy"] })}><option value="block_publication">补齐评分前阻止公布</option><option value="exclude_incomplete">缺评作品不进入排名</option></select></Field>
          <Field label="同分处理" hint="同分并列保留相同名次；负责人确认顺序需在汇总时人工核定同分顺序。不要用 AI 决定名次。"><select disabled={busy || !configurable} value={config.tiePolicy} onChange={event => editConfig({ ...config, tiePolicy: event.target.value as JudgingConfig["tiePolicy"] })}><option value="shared_rank">同分并列</option><option value="manual_order">负责人确认同分顺序</option></select></Field>
        </div>
        <p className={styles.hint}>各维度按分数范围换算为 0–100，再按权重汇总；有效评委等权平均。开始后标准与本轮作品名单冻结。未提交评分不当作 0 分；需要新的标准时另建轮次。</p>
        <div className={styles.actions}>{configurable && <button className={styles.primary} type="submit" disabled={busy || Math.abs(weight - 100) > 0.000001}>保存评分配置</button>}{round?.status === "setup" && <button className={styles.secondary} type="button" disabled={busy || configDirty} onClick={() => void transition("start")}>冻结标准与名单，开始评审</button>}{round?.status === "open" && <button className={styles.primary} type="button" disabled={busy} onClick={() => void transition("lock")}>结束评分并锁定汇总</button>}</div>
      </form>
      <details className={styles.details}><summary>正式收件材料与历史（{received.length} 版）</summary>{!received.length && <Empty>还没有正式收件。只有真实回执会进入此名单。</Empty>}<div className={styles.cards}>{received.map(receipt => <Receipt key={receipt.id} receipt={receipt} />)}</div></details>
      {round && <>
        <h3>本轮评委指派</h3>
        {round.status === "open" && <form className={styles.form} onSubmit={event => void assign(event)}><div className={styles.grid}>
          <Field label="正式作品" hint="选择本轮已正式收件的作品版本，核对队伍和收件回执；草稿或仓库链接不能代替正式收件。"><select required value={snapshotId} disabled={busy} onChange={event => setSnapshotId(event.target.value)}><option value="">选择本轮作品</option>{selectableReceipts.map(receipt => <option value={receipt.id} key={receipt.id}>{receipt.materials.title} · 第 {receipt.version} 版 · {receipt.receiptNumber}</option>)}</select></Field>
          <Field label={"评委账号"} hint={"必填。选择已查询的本站评委账号；手动填写时使用本站账号编号，不是姓名、电话或邮箱。系统仍会核查回避关系。"}>{props.judgeOptions ? <select required disabled={busy} value={judgeUserId} onChange={event => setJudgeUserId(event.target.value)}><option value="">选择评委</option>{props.judgeOptions.map(item => <option key={item.userId} value={item.userId}>{item.displayName}</option>)}</select> : <input required maxLength={160} value={judgeUserId} disabled={busy} onChange={event => setJudgeUserId(event.target.value)} placeholder="填写已确认的评委账号标识" />}</Field>
        </div><p className={styles.hint}>系统检查本站已知参赛与辅导关联；无法判断时需要工作人员核查。评委本人仍需申报线下关系。</p><button className={styles.primary} disabled={busy || !snapshotId || !judgeUserId.trim()} type="submit">核查关联并指派评委</button></form>}
        {!assignments.length && <Empty>本轮尚无评委指派。开始评审后，为每件作品指派足够的评委。</Empty>}
        <div className={styles.cards}>{assignments.map(item => {
          const receipt = received.find(value => value.id === item.snapshotId); const score = workspace.data?.scores.find(value => value.assignmentId === item.id);
          return <article key={item.id} className={styles.card}><div className={styles.cardTop}><strong>{receipt?.materials.title ?? "正式作品"}</strong><span className={styles.badge}>{assignmentNames[item.status]}</span></div><p>评委：{props.judgeOptions?.find(value => value.userId === item.judgeUserId)?.displayName ?? item.judgeUserId}</p><p>本人申报：{item.declaration === "clear" ? "无冲突" : item.declaration === "conflict" ? "有冲突，已回避" : "尚未确认"} · {score?.state === "submitted" ? "评分已提交" : score ? "仅保存草稿" : "尚未评分"}</p>{!!item.conflictReasons.length && <p>{item.conflictReasons.join("；")}</p>}
            {round.status === "open" && ["active", "needs_review"].includes(item.status) && <details><summary>核查或撤销此指派</summary><Field label="人工处理说明" hint="处理指派时必填。记录核查依据或撤销原因，例如“已核实无辅导关系”或“评委曾参与该队项目，应回避”。"><textarea rows={3} maxLength={1000} value={assignmentReasons[item.id] ?? ""} disabled={busy} onChange={event => setAssignmentReasons({ ...assignmentReasons, [item.id]: event.target.value })} /></Field><div className={styles.actions}>{item.status === "needs_review" && <button className={styles.secondary} type="button" disabled={busy || !(assignmentReasons[item.id] ?? "").trim()} onClick={() => void changeAssignment(item, "review")}>已人工核查，通过此指派</button>}<button className={styles.danger} type="button" disabled={busy || !(assignmentReasons[item.id] ?? "").trim()} onClick={() => void changeAssignment(item, "revoke")}>撤销指派</button></div></details>}
          </article>;
        })}</div>
        <div className={styles.sectionTop}><h3>人工汇总与公布</h3><button className={styles.secondary} type="button" disabled={busy || round.status === "setup"} onClick={() => void showSummary()}>预览当前汇总</button></div>
        {preview && <div className={styles.preview}>
          {preview.publicationReview.required && <div className={styles.reviewAlert} role="alert"><h3>本版公布依据需要复核</h3><p>{preview.publicationReview.notice ?? "请核对当前汇总，按下面的人工流程处理本版公布。"}</p><PublicationReviewSteps review={preview.publicationReview} /><a className={styles.reviewLink} href={`#${actionsId}-withdraw`}>前往填写撤回原因 ↓</a></div>}
          <p>缺评规则：{preview.summary.missingPolicy === "block_publication" ? "缺评时阻止公布" : "缺评作品不进入排名"} · 同分：{preview.summary.tiePolicy === "shared_rank" ? "并列名次" : "人工确认顺序"}</p><p className={styles.hint}>系统按已提交的真人评分和冻结权重汇总；这是当前核查预览，公开结果以有效的人工公布版本为准。</p>
          <div className={styles.cards}>{preview.summary.rows.map(row => <article key={row.snapshotId} className={styles.card}><div className={styles.cardTop}><strong>{row.title}</strong><span className={styles.badge}>{row.rank === null ? "暂无排名" : `第 ${row.rank} 名`}</span></div><p>加权总分（100 分制）：{row.total === null ? "缺评，未进入汇总" : row.total.toFixed(2)} · 已提交 {row.submittedJudgeCount} 位 · 还缺 {row.missingJudges} 位</p>
            {preview.round.status === "locked" && <><Field label="允许公布的反馈（可选）" hint="选填。整理可向队伍或公开展示的具体建议，删除私人信息；原始评委反馈不会自动公开。"><textarea rows={3} maxLength={3000} value={feedback[row.snapshotId]?.text ?? ""} disabled={busy} onChange={event => { setFeedback({ ...feedback, [row.snapshotId]: { text: event.target.value, visibility: feedback[row.snapshotId]?.visibility ?? "team" } }); setPublicationDirty(true); setApproved(false); }} /></Field><Field label="此反馈可见范围" hint="仅该队伍用于私下建议；随公布结果可见用于面向结果查看者。请确认内容适合所选范围。"><select value={feedback[row.snapshotId]?.visibility ?? "team"} disabled={busy} onChange={event => { setFeedback({ ...feedback, [row.snapshotId]: { text: feedback[row.snapshotId]?.text ?? "", visibility: event.target.value as "team" | "public" } }); setPublicationDirty(true); setApproved(false); }}><option value="team">仅该队伍</option><option value="public">随公布结果可见</option></select></Field></>}
          </article>)}</div>
          {preview.round.status === "locked" && <>
            {preview.round.config.tiePolicy === "manual_order" && <div className={styles.fieldset}><h4>确认结果顺序</h4><p className={styles.hint}>有分作品均需确认；不同分数保持分数顺序，仅同分时可调整。</p><ol className={styles.orderList}>{order.map((snapshot, index) => {
              const row = preview.summary.rows.find(item => item.snapshotId === snapshot); const previous = preview.summary.rows.find(item => item.snapshotId === order[index - 1]); const next = preview.summary.rows.find(item => item.snapshotId === order[index + 1]);
              function move(delta: number) { const changed = [...order]; [changed[index], changed[index + delta]] = [changed[index + delta], changed[index]]; setOrder(changed); setPublicationDirty(true); setApproved(false); }
              return <li key={snapshot}><span>{row?.title} · {row?.total?.toFixed(2)} 分</span><div className={styles.actions}><button type="button" className={styles.tertiary} disabled={busy || !previous || previous.total !== row?.total} onClick={() => move(-1)} aria-label={`上移${row?.title}`}>上移</button><button type="button" className={styles.tertiary} disabled={busy || !next || next.total !== row?.total} onClick={() => move(1)} aria-label={`下移${row?.title}`}>下移</button></div></li>;
            })}</ol></div>}
            <Field label="结果公开范围" hint="仅赛事参与者只向本场当前报名已通过的选手展示，须登录；公开展示允许任何访客查看本版结果。"><select value={visibility} disabled={busy} onChange={event => { setVisibility(event.target.value as PublishInput["visibility"]); setPublicationDirty(true); setApproved(false); }}><option value="participants">仅赛事参与者</option><option value="public">公开展示</option></select></Field>
            <label className={styles.check}><input type="checkbox" disabled={busy} checked={approved} onChange={event => setApproved(event.target.checked)} />我已核对评分、缺评处理、同分顺序及反馈范围，确认人工公布本版结果。</label>
            <button className={styles.primary} type="button" disabled={busy || !approved || !preview.summary.complete && preview.summary.missingPolicy === "block_publication"} onClick={() => void publish()}>人工确认并公布结果</button>
          </>}
          {preview.round.status === "open" && <Notice>当前仍在评分中。结束评分并锁定后，才能确认公布。</Notice>}
        </div>}
        <details className={styles.details} onToggle={event => { if (event.currentTarget.open && !calibrationReport && round.status !== "setup") void showCalibration(); }}>
          <summary>评委严格度校准（派生视图，不改变正式结果）</summary>
          <p className={styles.hint}>用于发现“严评委/松评委”造成的偏差，以及给所有作品几乎同样分数的评委。校准分只供复核参考：正式总分、名次与公布仍以原始分为准。</p>
          <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy || round.status === "setup"} onClick={() => void showCalibration()}>读取校准视图</button></div>
          {round.status === "setup" ? <Notice>本轮尚未开始评分。开始并收到足够的人工评分后，才能读取校准视图。</Notice> : calibrationReport ? <CalibrationView report={calibrationReport} judgeOptions={props.judgeOptions} /> : null}
        </details>
        <details className={styles.details} onToggle={event => { if (event.currentTarget.open && !integrityReport) void showIntegrity(); }}>
          <summary>评审隔离自检（只读，不改变结果）</summary>
          <p className={styles.hint}>回答"这轮的边界还成立吗"：回避或撤销的评分是否真的没被计入、分数是否都落在冻结标准内、同一评委对同一作品是否只有一条有效指派、本轮作品是否都有正式收件材料。</p>
          <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy} onClick={() => void showIntegrity()}>运行隔离自检</button></div>
          {integrityReport ? <IntegrityView report={integrityReport} /> : null}
        </details>
        <details className={styles.details} onToggle={event => { if (event.currentTarget.open && !progressReport && round.status !== "setup") void showProgress(); }}>
          <summary>评审进度（只读，不催办）</summary>
          <p className={styles.hint}>看这一轮还差谁：每件作品已提交几位评委的评分、每位评委还差几份。回避或撤销的指派单独列出并标注原因，不计入"应评数"。本视图只汇总既有事实，不会自动催办，也不会改变任何评分、指派或公布。</p>
          <div className={styles.actions}>
            <button className={styles.secondary} type="button" disabled={busy || round.status === "setup"} onClick={() => void showProgress()}>读取评审进度</button>
            {progressReport && <button className={styles.tertiary} type="button" disabled={busy} onClick={() => void showProgress()}>刷新进度</button>}
          </div>
          {round.status === "setup" ? <Notice>本轮尚未开始评分。开始并指派评委后，才能读取进度视图。</Notice> : progressReport ? <ProgressView report={progressReport} judgeOptions={props.judgeOptions} /> : null}
        </details>
        <details className={styles.details} onToggle={event => { if (event.currentTarget.open && !fairnessReport) void showFairness(); }}>
          <summary>公开公平规则包与扣分建议（需人工确认）</summary>
          <p className={styles.hint}>把本轮已冻结的规则整理成一段可以直接展示给选手的说明，并按已有事实列出待你确认的处理建议（迟交、材料过薄、缺评）。系统不会自动扣分、不会取消资格，也不会改动任何结果。</p>
          <div className={styles.actions}>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => void showFairness()}>生成规则包</button>
            {fairnessReport && <button className={styles.secondary} type="button" disabled={busy} onClick={() => void copyFairness()}>复制规则包文本</button>}
          </div>
          {fairnessReport ? <FairnessView report={fairnessReport} /> : null}
        </details>
        {published && !currentPublicationReview && <Notice>第 {published.version} 版结果已于 {dateText(published.publishedAt)} 公布，可见范围：{published.visibility === "public" ? "公开" : "赛事参与者"}。</Notice>}
        {round.status === "locked" && <details className={styles.details}><summary>重新开放本轮评分</summary><p className={styles.hint}>补充评委、处理回避或纠正分数时使用。冻结标准保持不变，需要重新锁定并核对汇总。</p><Field label="重新开放原因" hint="必填。说明要补评或纠正什么，例如“某评委回避，需要补充指派并重新核对汇总”。冻结的评分标准不会改变。"><textarea rows={3} maxLength={1000} disabled={busy} value={reopenReason} onChange={event => setReopenReason(event.target.value)} /></Field><button className={styles.secondary} type="button" disabled={busy || !reopenReason.trim()} onClick={() => void reopen()}>记录原因并重新开放评分</button></details>}
        {round.status === "published" && <details className={styles.details} id={`${actionsId}-withdraw`} open={currentPublicationReview ? true : undefined}><summary>撤回已公布结果</summary><p className={styles.hint}>撤回会停止展示本版结果，历史公布与处理说明保留。之后填写原因重新开放评分，补评并处理指派，再重新锁定、预览与人工公布。</p><Field label="撤回原因" hint="必填。说明本版结果为什么停止展示以及后续处理，例如“发现利益冲突，撤回后补评并重新公布”。"><textarea rows={3} maxLength={1000} disabled={busy} value={withdrawReason} onChange={event => setWithdrawReason(event.target.value)} /></Field><button className={styles.danger} type="button" disabled={busy || !withdrawReason.trim()} onClick={() => void withdraw()}>记录原因并撤回公布</button></details>}
      </>}
      <DuplicateQueue eventId={props.eventId} />
      <AppealQueue eventId={props.eventId} judgeOptions={props.judgeOptions} />
      <ManagementRecords eventId={props.eventId} workspace={workspace.data} roundId={round?.id ?? ""} roundTitle={round?.config.title ?? ""} />
    </>}
  </section>;
}

/** 相似/重复材料的人工复核线索：只读、只给可核对事实，不下判定、不通知任何人。 */
function DuplicateQueue({ eventId }: { eventId: string }) {
  const report = useApi<DuplicateReport>(`${organizerPath(eventId)}/judging/duplicates`);
  const strengthNames: Record<DuplicatePair["strength"], string> = { high: "同一文件", medium: "同一地址", low: "同名作品" };
  return <details className={styles.details}>
    <summary>相似 / 重复材料（人工复核线索 {report.data?.pairs.length ?? 0} 条）</summary>
    {report.error && <Notice error>{report.error.message}</Notice>}
    {report.loading && <Empty>正在比较各队最新一版正式材料…</Empty>}
    {report.data && <><p className={styles.hint}>{report.data.notice}</p>
      {!report.data.pairs.length && <Empty>没有发现共同事实的线索。没有线索不等于没有重复，只是这些可核对的事实都不相同。</Empty>}
      <div className={styles.cards}>{report.data.pairs.map((pair, index) => <article className={styles.card} key={`${pair.left.receiptId}:${pair.right.receiptId}:${index}`}>
        <div className={styles.cardTop}><strong>{pair.left.title || pair.left.teamId} ↔ {pair.right.title || pair.right.teamId}</strong><span className={styles.badge}>{strengthNames[pair.strength]}</span></div>
        <p className={styles.muted}>队伍 {pair.left.teamId}（第 {pair.left.version} 版） · 队伍 {pair.right.teamId}（第 {pair.right.version} 版）</p>
        <ul className={styles.linkList}>{pair.reasons.map((reason, position) => <li key={position}>{reason.detail}</li>)}</ul>
      </article>)}</div>
      <ul className={styles.hint}>{report.data.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul></>}
  </details>;
}
/** 公开规则包与人工确认建议：只读展示，复制文本由主办方自己决定是否公开。 */
function FairnessView({ report }: { report: FairnessReport }) {
  const kindNames: Record<FairnessSuggestion["kind"], string> = { late_submission: "迟交", incomplete_materials: "材料过薄", missing_judges: "缺评" };
  return <div className={styles.preflight}>
    <h4>{report.declaration.title}</h4>
    <ul className={styles.linkList}>{report.declaration.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    <p className={styles.hint}>{report.organizerRulesNote}</p>
    <h4>需要你确认的处理建议（{report.suggestions.length} 条）</h4>
    {!report.suggestions.length ? <Empty>没有需要处理的事实。这里不会自动扣分，也不会自动联系队伍。</Empty>
      : <div className={styles.cards}>{report.suggestions.map((item, index) => <article className={styles.card} key={`${item.teamId}:${item.kind}:${index}`}>
        <div className={styles.cardTop}><strong>{kindNames[item.kind]} · 队伍 {item.teamId}</strong><span className={styles.badge}>需你确认</span></div>
        <p>事实：{item.fact}</p><p className={styles.hint}>建议：{item.suggestion}</p>
      </article>)}</div>}
    <ul className={styles.hint}>{report.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </div>;
}
/** 赛前自检与赛后只读复用清单：只看本人队伍自己的事实。 */
function ChecklistView({ eventId, teamId }: { eventId: string; teamId: string }) {
  const checklists = useApi<{ preEvent: PreEventChecklist; postEvent: PostEventReuse }>(`${competitionPath(eventId)}/my-checklists?teamId=${urlId(teamId)}`);
  if (checklists.error) return <Notice error>{checklists.error.message}</Notice>;
  if (!checklists.data) return <Empty>正在核对你们自己的参赛进度…</Empty>;
  const { preEvent, postEvent } = checklists.data;
  const stateNames: Record<ChecklistItem["state"], string> = { done: "已具备", todo: "待处理", info: "按规则确认" };
  return <>
    <h4>赛前自检（{preEvent.ready}/{preEvent.total} 项已具备）</h4>
    <p className={styles.hint}>{preEvent.notice}</p>
    <ul className={styles.linkList}>{preEvent.items.map(item => <li key={item.id}><span className={styles.badge}>{stateNames[item.state]}</span> {item.label}：{item.detail}</li>)}</ul>
    <h4>赛后只读复用清单（{postEvent.entries.length} 条）</h4>
    <p className={styles.hint}>{postEvent.notice}</p>
    {!!postEvent.entries.length && <ul className={styles.linkList}>{postEvent.entries.map((entry, index) => <li key={index}>
      {entry.url ? <a href={entry.url} target="_blank" rel="noreferrer noopener">{entry.label} ↗</a> : <strong>{entry.label}</strong>} <span className={styles.hint}>{entry.detail}</span>
    </li>)}</ul>}
    <ul className={styles.hint}>{[...preEvent.limitations, ...postEvent.limitations].map((line, index) => <li key={index}>{line}</li>)}</ul>
  </>;
}
/** 主办方处理申诉：只改申诉状态并留审计，不改动分数、名次或公布。 */
function AppealQueue({ eventId, judgeOptions }: { eventId: string; judgeOptions?: readonly { userId: string; displayName: string }[] }) {
  const appeals = useApi<{ items: { appeal: ResultAppeal; roundTitle: string }[]; openCount: number }>(`${organizerPath(eventId)}/judging/appeals`);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [failed, setFailed] = useState(false);
  const name = (userId: string) => judgeOptions?.find(item => item.userId === userId)?.displayName ?? userId;
  async function decide(appeal: ResultAppeal, decision: "accepted" | "rejected" | "handled") {
    if (busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try {
      await api<ResultAppeal>(`${organizerPath(eventId)}/judging/appeals/${urlId(appeal.id)}/resolve`, { method: "POST", body: { expectedRevision: appeal.revision, decision, note: notes[appeal.id] ?? "" } });
      setNotes(current => ({ ...current, [appeal.id]: "" }));
      setNote(decision === "accepted" ? "已受理。受理只表示会处理；如需更正分数，请走撤回 → 重新开放 → 补评 → 重新核定公布。" : "已记录处理结论并留审计，本版结果没有被改动。");
      await appeals.reload();
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }
  return <details className={styles.details}>
    <summary>参赛者申诉（待处理 {appeals.data?.openCount ?? 0}）</summary>
    <p className={styles.hint}>申诉只记录选手的说明与依据，不改变分数、名次或公布；需要更正分数时请使用下方"撤回已公布结果 → 重新开放评分"的既有流程。撤回后该队伍可以重新提交。</p>
    {note && <Notice error={failed}>{note}</Notice>}
    {appeals.error && <Notice error>{appeals.error.message}</Notice>}
    {!appeals.loading && !appeals.data?.items.length && <Empty>本场还没有申诉。</Empty>}
    <div className={styles.cards}>{appeals.data?.items.map(({ appeal, roundTitle }) => <article className={styles.card} key={appeal.id}>
      <div className={styles.cardTop}><strong>{appealStatusNames[appeal.status]}</strong><span className={styles.badge}>{roundTitle || "评审轮"} · 第 {appeal.resultVersion} 版 · {dateText(appeal.filedAt)}</span></div>
      <p>队伍 {appeal.teamId} · 提交人 {name(appeal.authorUserId)} · 申诉截止 {dateText(appeal.deadlineAt)}</p>
      <p className={styles.prose}>{appeal.reason}</p>
      {appeal.requestedOutcome && <p className={styles.hint}>希望的处理：{appeal.requestedOutcome}</p>}
      {appeal.decisionNote && <p className={styles.hint}>处理说明：{appeal.decisionNote}</p>}
      {appeal.status === "submitted" && <details><summary>处理这条申诉</summary>
        <Field label="处理说明" hint="必填。写清核查依据与结论，例如“已核对第二位评委的评分记录与书面反馈，分数无误”。受理不等于改分。"><textarea rows={3} maxLength={2000} disabled={busy} value={notes[appeal.id] ?? ""} onChange={event => setNotes(current => ({ ...current, [appeal.id]: event.target.value }))} /></Field>
        <div className={styles.actions}>
          <button className={styles.secondary} type="button" disabled={busy || !(notes[appeal.id] ?? "").trim()} onClick={() => void decide(appeal, "accepted")}>受理</button>
          <button className={styles.tertiary} type="button" disabled={busy || !(notes[appeal.id] ?? "").trim()} onClick={() => void decide(appeal, "rejected")}>不受理</button>
          <button className={styles.primary} type="button" disabled={busy || !(notes[appeal.id] ?? "").trim()} onClick={() => void decide(appeal, "handled")}>已处理并回复</button>
        </div></details>}
    </article>)}</div>
  </details>;
}
function recordObject(value: unknown): Record<string, unknown> | null {  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function AuditVersion({ value, labels }: { value: unknown; labels: Readonly<Record<string, string>> }) {
  const version = recordObject(value);
  if (!version) return <span className={styles.hint}>无上一条记录</span>;
  const scores = recordObject(version.values);
  return <div className={styles.auditVersion}>
    {typeof version.revision === "number" && <p>修订 {version.revision}</p>}
    {typeof version.version === "number" && <p>公布版本 {version.version}</p>}
    {version.state === "draft" && <p>评分草稿</p>}{version.state === "submitted" && <p>已提交评分</p>}
    {typeof version.status === "string" && <p>状态：{roundNames[version.status as JudgingRound["status"]] ?? assignmentNames[version.status as JudgeAssignment["status"]] ?? version.status}</p>}
    {scores && <ul className={styles.linkList}>{Object.entries(scores).map(([key, value]) => typeof value === "number" ? <li key={key}>{labels[key] ?? key}：{value} 分</li> : null)}</ul>}
    {typeof version.feedback === "string" && version.feedback && <p className={styles.prose}>人工反馈：{version.feedback}</p>}
  </div>;
}
function ManagementRecords({ eventId, workspace, roundId, roundTitle }: { eventId: string; workspace: JudgingWorkspace; roundId: string; roundTitle: string }) {
  const [open, setOpen] = useState(false);
  const records = useApi<{ items: AuditItem[] }>(open ? `${organizerPath(eventId)}/judging/audit` : null);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState("");
  const names: Record<string, string> = { config_saved: "保存评分标准", round_started: "冻结标准并开始", judge_assigned: "指派评委", conflict_reviewed: "人工核查关联", assignment_revoked: "撤销指派", conflict_declared: "评委申报利益冲突", score_draft: "保存评分草稿", score_submitted: "提交人工评分", score_corrected: "纠正已提交评分", round_locked: "锁定评分汇总", round_reopened: "重新开放评分", results_published: "人工公布结果", results_withdrawn: "撤回公布结果", results_exported: "导出已公布结果", judge_access_denied: "被拒绝的评审访问（越权尝试）" };
  /** 下载既有写法：GET 拿 {filename,csv}，前端用 Blob + 临时 <a download> 下发，不新造机制。 */
  function saveCsv(csv: string, filename: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "judging.csv";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download() {
    setBusy(true); setNote("");
    try {
      saveCsv((await api<{ filename: string; csv: string }>(`${organizerPath(eventId)}/judging/export`)).csv, "judging-scores.csv");
      setNote("已准备本赛事评分明细导出（含评委账号，仅供内部核对），请在浏览器下载中查看。");
    } catch (error) { setNote(message(error)); }
    finally { setBusy(false); }
  }
  async function downloadResults() {
    if (!roundId) return;
    setBusy(true); setNote("");
    try {
      const result = await api<{ filename: string; csv: string }>(`${organizerPath(eventId)}/judging/rounds/${urlId(roundId)}/results-export`);
      saveCsv(result.csv, result.filename || "judging-results.csv");
      setNote("已准备本轮的已公布结果导出（作品级结果与公开反馈，不含评委账号与联系人），可在浏览器下载中查看。");
    } catch (error) { setNote(message(error)); }
    finally { setBusy(false); }
  }
  return <details className={styles.details} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>评分修改、公布记录与导出</summary><p className={styles.hint}>仅当前有权评审负责人可读取。两种导出用途不同，请按需要选择，避免把内部对账件外发。</p>
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy} onClick={() => void download()}>导出分数明细（内部对账）</button><button className={styles.tertiary} type="button" disabled={records.loading} onClick={() => void records.reload()}>刷新操作记录</button></div>
    <p className={styles.hint}><strong>导出分数明细（内部对账）</strong>：指派级分数表，<strong>包含评委账号</strong>，用于内部逐项核对，<strong>不要外发</strong>。</p>
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy || !roundId} onClick={() => void downloadResults()}>导出已公布结果（可对外留档）</button></div>
    <p className={styles.hint}><strong>导出已公布结果（可对外留档）</strong>：当前选中轮次（{roundTitle || "尚未选择轮次"}）的作品级结果与已批准公开反馈，<strong>不含</strong>评委身份与联系人，可交给赞助方或学校。本轮未公布或已撤回时无法导出。</p>
    <Notice>{note}</Notice><Notice error>{records.error?.message}</Notice>{records.loading && <Empty>正在读取本赛事操作记录…</Empty>}
    {records.data && !records.data.items.length && <Empty>目前没有评分或公布操作记录。</Empty>}
    <div className={styles.cards}>{records.data?.items.map(item => {
      const details = recordObject(item.details); const latest = recordObject(details?.after) ?? recordObject(details?.before);
      const assignment = workspace.assignments.find(value => value.id === latest?.assignmentId);
      const round = workspace.rounds.find(value => value.id === assignment?.roundId);
      const labels = Object.fromEntries((round?.config.criteria ?? []).map(criterion => [criterion.id, criterion.label]));
      return <article className={styles.card} key={item.id}><div className={styles.cardTop}><strong>{names[item.action] ?? "评审操作"}</strong><span className={styles.hint}>{dateText(item.createdAt)}</span></div><p>操作账号：{item.actorUserId}</p>{item.reason && <p className={styles.prose}>说明：{item.reason}</p>}{details && <details><summary>查看修改前后记录</summary><div className={styles.grid}><div><h4>修改前</h4><AuditVersion value={details.before} labels={labels} /></div><div><h4>修改后</h4><AuditVersion value={details.after} labels={labels} /></div></div></details>}</article>;
    })}</div>
  </details>;
}

export function EventResultsPanel(props: EventResultsPanelProps) { return <ResultsPanel key={`${props.eventId}:${props.scope ?? "public"}`} {...props} />; }
/** 状态名直接写在这里：客户端组件不能引入 appeal.ts（会带进 node:crypto）。 */
const appealStatusNames: Record<ResultAppeal["status"], string> = { submitted: "待主办方处理", accepted: "已受理", rejected: "不受理", handled: "已处理", withdrawn: "已撤回" };
function OwnAppealPanel({ eventId }: { eventId: string }) {
  const appeals = useApi<{ items: ResultAppeal[]; window: AppealWindowView | null }>(`${competitionPath(eventId)}/appeals`);
  const [reason, setReason] = useState(""); const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false); const [note, setNote] = useState(""); const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(() => operationKey());
  async function file(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try {
      await api<ResultAppeal>(`${competitionPath(eventId)}/appeals`, { method: "POST", body: { roundId: appeals.data?.window?.roundId, reason, requestedOutcome: outcome, idempotencyKey: key } });
      setReason(""); setOutcome(""); setKey(operationKey());
      setNote("申诉已提交。它只记录你的说明，不会自动改分；主办方处理后你会在这里看到状态。");
      await appeals.reload();
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }
  const view = appeals.data?.window ?? null;
  return <details className={styles.details}>
    <summary>对结果有异议？提交申诉（{appeals.data?.items.length ?? 0} 条记录）</summary>
    <p className={styles.hint}>申诉只用于把你们的情况和依据正式告诉主办方。它**不会自动改变分数或名次**；如需更正，主办方会按撤回 → 重新开放 → 补评 → 重新核定公布处理。</p>
    {appeals.error && <Notice error>{appeals.error.message}</Notice>}
    {!appeals.loading && !view && <Empty>当前没有属于你所在队伍的已公布结果，暂时不能提交申诉。</Empty>}
    {view && <p className={styles.hint}>{view.roundTitle} · 公布版本 {view.resultVersion} · 公布于 {dateText(view.publishedAt)} · 申诉截止 {dateText(view.deadlineAt)}</p>}
    {view && !view.canFile && !view.filed && <Notice>{view.closedReason ?? "本版结果的申诉已经截止。"}</Notice>}
    {view?.canFile && !view.filed && <form className={styles.form} onSubmit={event => void file(event)}>
      <Field label="申诉理由" hint="必填。写清你认为哪里不对、依据是什么（例如与收到的书面反馈不一致、材料版本不符）。不要填写密码、Token 或他人的私人信息。"><textarea required rows={4} maxLength={4000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} /></Field>
      <Field label="希望的处理结果（可选）" hint="选填。例如“希望核对第二位评委的评分记录并给出说明”。"><input maxLength={1000} disabled={busy} value={outcome} onChange={event => setOutcome(event.target.value)} /></Field>
      <button className={styles.primary} type="submit" disabled={busy || !reason.trim()}>提交申诉</button>
    </form>}
    {view?.filed && <Notice>你们队已经对这版结果提交过申诉，请等待主办方处理。</Notice>}
    {!!appeals.data?.items.length && <div className={styles.cards}>{appeals.data.items.map(item => <article className={styles.card} key={item.id}>
      <div className={styles.cardTop}><strong>{appealStatusNames[item.status]}</strong><span className={styles.badge}>第 {item.resultVersion} 版结果 · {dateText(item.filedAt)}</span></div>
      <p className={styles.prose}>{item.reason}</p>
      {item.requestedOutcome && <p className={styles.hint}>希望的处理：{item.requestedOutcome}</p>}
      {item.decisionNote && <div className={styles.feedback}><h4>主办方处理说明</h4><p className={styles.prose}>{item.decisionNote}</p></div>}
    </article>)}</div>}
  </details>;
}
function ResultsPanel(props: EventResultsPanelProps) {
  const results = useApi<ResultProjection>(`${competitionPath(props.eventId)}/results${props.scope === "mine" ? "/mine" : ""}`);
  const needsReview = results.data?.status === "needs_review" || results.data?.reviewRequired === true;
  return <section className={styles.panel} aria-label={props.scope === "mine" ? "我的赛事结果" : "赛事公布结果"}>
    <Context context={props} identity={props.scope === "mine" ? "本人队伍 · 结果与反馈" : "赛事公布结果"} />
    <div className={styles.sectionTop}><h3>{needsReview ? "本版结果正在复核" : results.data?.status === "published" ? "人工确认的公布结果" : "结果状态"}</h3><button className={styles.secondary} type="button" disabled={results.loading} onClick={() => void results.reload()}>刷新结果</button></div>
    <Notice error>{results.error?.message}</Notice>{results.loading && <Empty>正在读取允许查看的结果…</Empty>}
    {needsReview && <div className={styles.reviewAlert} role="status"><h3>请等待主办方重新核查与公布</h3><p>{results.data?.reviewNotice ?? "本版结果需要主办方重新核查，当前暂停展示分数、排名和反馈。"}</p><p className={styles.hint}>{results.data?.roundTitle} · 原公布版本 {results.data?.version} · {dateText(results.data?.publishedAt)}</p><p>下一步：关注本赛事官方通知；复核完成后刷新此页查看负责人确认的结果。</p></div>}
    {!needsReview && results.data?.status === "waiting_publication" && <Empty>结果待评审或待负责人公布。下一步：关注赛事官方通知；当前没有已公布排名。</Empty>}
    {!needsReview && results.data?.status === "published" && <><p className={styles.hint}>{results.data.roundTitle} · 公布版本 {results.data.version} · {dateText(results.data.publishedAt)}</p>{!results.data.rows.length && <Empty>当前可见范围内没有结果条目。登录本人赛事入口查看允许提供的反馈。</Empty>}<div className={styles.cards}>{results.data.rows.map((row, index) => <article className={styles.card} key={`${row.teamId}:${index}`}><div className={styles.cardTop}><strong>{row.title}</strong><span className={styles.badge}>{row.rank === null ? "未进入排名" : `第 ${row.rank} 名`}</span></div><p>加权总分（100 分制）：{row.total === null ? "未形成完整评分" : row.total.toFixed(2)}</p>{row.feedback && <div className={styles.feedback}><h4>负责人批准的反馈</h4><p className={styles.prose}>{row.feedback}</p></div>}</article>)}</div></>}
    {props.scope === "mine" && <OwnAppealPanel eventId={props.eventId} />}
  </section>;
}
