"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { DeliveryVerification, GitOperation, RepositoryBinding, SubmissionRecord } from "../modules/github/types.ts";
import type { DeliveryMaterialChecklist, DeliveryMaterialEntry, DeliveryMaterialsSummary, DeliveryMaterialsView, MaterialVerification, SaveDeliveryMaterialsInput } from "../modules/github/delivery-materials-types.ts";
import { DeliverySummaryPanel } from "../modules/retrospectives/client.ts";
import { ApiError, api, chinaInstant, dateText, lines, localInput, message, operationKey, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, type SystemStatus } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import type { ConfirmedRules } from "./discovery-client.tsx";
import styles from "./site.module.css";

/** RepositoryPanel already shows the current repository. Enable this only for a standalone delivery view. */
export function DeliveryPanel({ detail, showRepositorySummary = false }: { detail: ProjectDetail; showRepositorySummary?: boolean }) {
  const base = `/projects/${detail.project.id}`;
  const status = useApi<SystemStatus>(showRepositorySummary ? "/system/status" : null);
  const binding = useApi<RepositoryBinding | null>(showRepositorySummary ? `${base}/repository-binding` : null);
  const operations = useApi<GitOperation[]>(`${base}/git-operations`);
  const verifications = useApi<DeliveryVerification[]>(`${base}/delivery-verifications`);
  const submissions = useApi<SubmissionRecord[]>(`${base}/submission-records`);
  const rules = useApi<ConfirmedRules>(`${base}/rules`);
  const materials = useApi<DeliveryMaterialsView>(`${base}/delivery-materials`);
  const summary = useApi<{ requirements: DeliveryMaterialsSummary }>(`${base}/delivery-summary`);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [pending, setPending] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState(""); const [environment, setEnvironment] = useState(""); const [steps, setSteps] = useState(""); const [outcome, setOutcome] = useState<DeliveryVerification["outcome"]>("inconclusive"); const [blockers, setBlockers] = useState(""); const [verificationEvidence, setVerificationEvidence] = useState(""); const [commit, setCommit] = useState("");
  const [stageId, setStageId] = useState(""); const [submissionStatus, setSubmissionStatus] = useState<"not_submitted" | "reported" | "rejected_or_withdrawn">("not_submitted"); const [submittedAt, setSubmittedAt] = useState(""); const [submissionEvidence, setSubmissionEvidence] = useState(""); const [submissionCommit, setSubmissionCommit] = useState("");
  const readonly = detail.project.stage === "archived" || detail.membership.role !== "manager";
  const stages = rules.data?.rules?.stages.filter(stage => Boolean(stage.submissionUrl)) ?? [];
  const stage = stages.find(item => item.id === stageId);
  const officialUrl = stage?.submissionUrl ? safeLink(stage.submissionUrl) : null;
  const factsLoading = operations.loading || verifications.loading || submissions.loading || summary.loading;
  const factsReady = operations.data !== null && verifications.data !== null && submissions.data !== null && summary.data !== null && !operations.error && !verifications.error && !submissions.error && !summary.error;
  const latestSavedOperation = [...(operations.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).find(operation => operation.status === "saved");
  const currentCommitSha = latestSavedOperation?.commitSha ?? null;
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId !== detail.project.id) return;
      void operations.reload();
      void materials.reload();
      void summary.reload();
      if (showRepositorySummary) void binding.reload();
    };
    window.addEventListener("hackathon:repository-updated", refresh);
    return () => window.removeEventListener("hackathon:repository-updated", refresh);
  }, [detail.project.id, operations.reload, binding.reload, materials.reload, summary.reload, showRepositorySummary]);
  async function action(work: () => Promise<void>) { setPending(true); setError(""); setNotice(""); try { await work(); } catch (reason) { setError(message(reason)); } finally { setPending(false); } }
  return <><Feedback error={error} notice={notice}/>{detail.membership.role !== "manager" && <p className={styles.notice}>材料核对、运行与正式提交记录由当前团队空间的管理员填写，成员可以查看已有记录。</p>}<Feedback error={binding.error ?? operations.error ?? verifications.error ?? submissions.error ?? rules.error ?? summary.error ?? status.error}/>
    {showRepositorySummary && <section className={styles.panel}><h2>当前空间的 GitHub 仓库</h2>{binding.loading ? <Loading/> : binding.data ? <><p><span className={styles.tag}>{binding.data.status === "bound" ? "已绑定" : "绑定已撤销"}</span><a className={styles.link} target="_blank" rel="noopener noreferrer" href={`https://github.com/${encodeURIComponent(binding.data.owner)}/${encodeURIComponent(binding.data.name)}`}>{binding.data.owner}/{binding.data.name}</a></p><p className={styles.muted}>最近检查 {dateText(binding.data.checkedAt)} · 绑定版本 {binding.data.revision}</p></> : !binding.error && <Empty>尚未绑定仓库。</Empty>}
      {status.data && !status.data.githubConfigured && <p className={styles.notice}>GitHub 授权尚未配置，网站暂时不能替你创建仓库、保存代码或推送提交。你仍可在 GitHub 完成这些操作，并在下面记录运行验收和正式提交。</p>}
      <p className={styles.muted}>代码保存、运行验收和赛事平台提交分别核对。保存到仓库不会自动变为“比赛提交成功”。</p>
    </section>}
    {factsLoading ? <Loading/> : factsReady ? <DeliverySummaryPanel facts={{ saves: operations.data!.map(operation => ({ id: operation.id, projectId: operation.projectId, revision: operation.revision, status: operation.status, repositoryUrl: `https://github.com/${encodeURIComponent(operation.target.owner)}/${encodeURIComponent(operation.target.name)}`, branch: operation.branch, commitSha: operation.commitSha, recordedAt: operation.createdAt })), verifications: verifications.data!, submissions: submissions.data!, materials: summary.data!.requirements.materials.map(material => ({ id: material.id, label: material.label, status: material.status === "missing" ? "missing" : material.status === "prepared" && summary.data!.requirements.currentCommitSha?.toLowerCase() === currentCommitSha?.toLowerCase() ? "prepared" : "unknown" })) }}/> : <p className={styles.notice}>交付事实还未读取完整，请先处理上方读取提示。暂时无法确认已有保存、材料、运行或提交记录。</p>}
    <DeliveryMaterialsPanel key={`${detail.project.id}:${detail.membership.membershipId}`} detail={detail} state={materials} summary={summary.error || summary.loading ? null : summary.data?.requirements ?? null} currentCommitSha={currentCommitSha} operationsReady={operations.data !== null && !operations.error && !operations.loading} onSaved={summary.reload}/>
    <section className={styles.panel} id="delivery-verification"><h2>2 · 记录一次真实运行</h2><p className={styles.muted}>由空间管理员记录实际执行过的环境、步骤和证据。本站没有自动运行仓库代码；没有依据时选择“无法确认”。</p><p className={styles.muted}>可直接填写在本地或其他环境中完成的验收，不需要先由本站保存代码。</p><form className={styles.form} onSubmit={async event => { event.preventDefault(); await action(async () => { await api(`${base}/delivery-verifications`, { method: "POST", body: { verifiedAt: chinaInstant(verifiedAt), repositoryCommitSha: commit.trim() || null, environmentSummary: environment, steps: lines(steps), outcome, blockers: lines(blockers), evidenceRefs: lines(verificationEvidence), verificationSource: "user_reported" } }); setNotice("验收记录已保存，来源为成员自报。正式提交需另外记录。"); await verifications.reload(); }); }}>
      <div className={styles.grid}><Field label="实际验收时间（北京时间）"><input type="datetime-local" required value={verifiedAt} disabled={readonly} onChange={event => setVerifiedAt(event.target.value)}/></Field><Field label="验收结果"><select value={outcome} disabled={readonly} onChange={event => setOutcome(event.target.value as DeliveryVerification["outcome"])}><option value="inconclusive">无法确认</option><option value="failed">未通过</option><option value="passed">通过（需要证据）</option></select></Field></div>
      <Field label="运行环境"><input required={outcome === "passed"} disabled={readonly} value={environment} onChange={event => setEnvironment(event.target.value)} placeholder="例如：Windows 11 / Node 24 / Chrome，实际启动方式"/></Field>
      <Field label="实际验收步骤（每行一项）"><textarea required={outcome === "passed"} disabled={readonly} value={steps} onChange={event => setSteps(event.target.value)} placeholder="例如：启动项目；用测试邮箱登录；创建项目后刷新确认数据还在"/></Field>
      <Field label="尚未解决的问题（每行一项）"><textarea disabled={readonly} value={blockers} onChange={event => setBlockers(event.target.value)}/></Field>
      <Field label="验收证据或记录链接（每行一项）"><textarea required={outcome === "passed"} disabled={readonly} value={verificationEvidence} onChange={event => setVerificationEvidence(event.target.value)}/></Field>
      <Field label="验收代码版本（完整 commit SHA，选填）"><input disabled={readonly} value={commit} onChange={event => setCommit(event.target.value)} pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"/></Field>
      <button className={styles.button} disabled={readonly || pending}>{pending ? "正在保存记录…" : "保存验收记录"}</button>
    </form></section>
    <section className={styles.panel} id="official-submission"><h2>3 · 核对主办方正式提交</h2><p className={styles.muted}>先打开主办方入口完成提交，再在这里记录回执或依据。这里保存的是成员自报记录；平台未回传核验结果时，只显示“已报告提交”。</p>{rules.loading ? <Loading/> : !stages.length && <p className={styles.notice}>尚无已确认的赛事提交入口。先到 <Link href={`/app/projects/${encodeURIComponent(detail.project.id)}/rules`} className={styles.link}>当前空间的比赛要求</Link> 核对规则、阶段和官方入口；无法确认的入口不能用于提交记录。</p>}
      <form className={styles.form} onSubmit={async event => { event.preventDefault(); await action(async () => { if (!rules.data?.confirmation || !stage?.submissionUrl) throw new Error("请先选择当前已确认规则中的正式提交阶段。"); const confirmation = rules.data.confirmation; await api(`${base}/submission-records`, { method: "POST", body: { eventId: confirmation.eventId, stageId: stage.id, requirementsVersion: `${confirmation.eventId}:${confirmation.rulesVersion}:${confirmation.revision}`, platformUrl: stage.submissionUrl, submittedAt: submittedAt ? chinaInstant(submittedAt) : null, repositoryCommitSha: submissionCommit.trim() || null, status: submissionStatus, evidenceRefs: lines(submissionEvidence), verificationSource: "user_reported" } }); setNotice("提交记录已保存，网站仍以成员自报标注，不代表平台已核验。"); await submissions.reload(); }); }}>
        <Field label="已确认的提交阶段"><select required disabled={readonly || !stages.length} value={stageId} onChange={event => setStageId(event.target.value)}><option value="">请选择</option>{stages.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>{stage && <p className={styles.notice}>本阶段提交截止：{stage.stageType === "submission" && stage.endsAt?.utc ? dateText(stage.endsAt.utc) : "尚未确定，请人工核对本阶段原文"}{stage.stageType === "submission" && stage.endsAt?.rawText && ` · 原文：${stage.endsAt.rawText}`}</p>}{officialUrl && <p><a href={officialUrl} className={styles.link} target="_blank" rel="noopener noreferrer">打开本阶段官方提交入口（新窗口）</a></p>}
        <div className={styles.grid}><Field label="本次提交状态"><select value={submissionStatus} disabled={readonly} onChange={event => setSubmissionStatus(event.target.value as typeof submissionStatus)}><option value="not_submitted">尚未提交</option><option value="reported">成员报告已提交</option><option value="rejected_or_withdrawn">已撤回或被拒绝</option></select></Field><Field label="实际提交时间（北京时间）"><input type="datetime-local" required={submissionStatus === "reported"} disabled={readonly} value={submittedAt} onChange={event => setSubmittedAt(event.target.value)}/></Field></div>
        <Field label="提交依据（每行一项）"><textarea required={submissionStatus === "reported"} disabled={readonly} value={submissionEvidence} onChange={event => setSubmissionEvidence(event.target.value)} placeholder="例如：平台回执编号、提交记录页链接或已保存的截图说明"/></Field><Field label="提交代码版本（完整 commit SHA，选填）"><input disabled={readonly} value={submissionCommit} onChange={event => setSubmissionCommit(event.target.value)} pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"/></Field><button className={styles.button} disabled={readonly || pending || !stage}>保存成员提交记录</button>
      </form></section>
  </>;
}

type VerificationDraft = {
  outcome: "unrecorded" | MaterialVerification["outcome"];
  verifiedAt: string;
  evidence: string;
  note: string;
};
type MaterialDraft = VerificationDraft & { location: string; revision: string; repositoryCommitSha: string };
type BranchDraft = VerificationDraft & { branch: string; repositoryCommitSha: string };
const blankVerification = (): VerificationDraft => ({ outcome: "unrecorded", verifiedAt: "", evidence: "", note: "" });
function verificationDraft(value: MaterialVerification | null | undefined): VerificationDraft {
  return value ? { outcome: value.outcome, verifiedAt: localInput(value.verifiedAt), evidence: value.evidenceRefs.join("\n"), note: value.note } : blankVerification();
}
function verificationInput(value: VerificationDraft): MaterialVerification | null {
  if (value.outcome === "unrecorded") return null;
  return { outcome: value.outcome, verifiedAt: chinaInstant(value.verifiedAt), evidenceRefs: lines(value.evidence), note: value.note, verificationSource: "user_reported" };
}
const materialLabels = { missing: "尚未填写完整", prepared: "当前版本已核对（成员自报）", unknown: "尚待核对", failed: "核对未通过", outdated: "规则或代码版本已变化" } as const;
const branchLabels = { not_verified: "尚未核对", unknown: "要求未知", not_required: "正式规则明确无分支要求", mismatch: "不符合要求", matched: "当前版本已核对（成员自报）" } as const;
function unknownMaterialOutcome(reason: unknown): boolean {
  return !(reason instanceof ApiError) || reason.status >= 500 || reason.status === 408 || /UNKNOWN|UNCERTAIN|TIMEOUT|IN_PROGRESS|INVALID_RESPONSE/.test(reason.code);
}

function VerificationFields({ value, onChange, disabled }: { value: VerificationDraft; onChange: (change: Partial<VerificationDraft>) => void; disabled: boolean }) {
  return <>
    <div className={styles.grid}>
      <Field label="本项实际核对结果"><select value={value.outcome} disabled={disabled} onChange={event => onChange({ outcome: event.target.value as VerificationDraft["outcome"] })}><option value="unrecorded">尚未记录核对</option><option value="inconclusive">无法确认</option><option value="failed">未通过</option><option value="passed">通过（成员自报，需真实依据）</option></select></Field>
      <Field label="实际核对时间（北京时间）"><input type="datetime-local" disabled={disabled || value.outcome === "unrecorded"} required={value.outcome !== "unrecorded"} value={value.verifiedAt} onChange={event => onChange({ verifiedAt: event.target.value })}/></Field>
    </div>
    {value.outcome !== "unrecorded" && <>
      <Field label="真实核对依据（每行一项）"><textarea disabled={disabled} required={value.outcome === "passed"} value={value.evidence} onChange={event => onChange({ evidence: event.target.value })} placeholder="例如：材料版本页、实际观看或检查记录、主办方规则中对应条款" maxLength={60000}/></Field>
      <Field label="核对说明（选填）"><input disabled={disabled} value={value.note} onChange={event => onChange({ note: event.target.value })} maxLength={2000}/></Field>
    </>}
  </>;
}

function MaterialRecord({ entry, label }: { entry: DeliveryMaterialEntry; label: string }) {
  const url = safeLink(entry.location);
  return <li><strong>{label}</strong><p>位置：{url ? <a href={url} className={styles.link} target="_blank" rel="noopener noreferrer">{entry.location}</a> : entry.location || "未填写"} · 修订：{entry.revision || "未填写"}</p><p className={styles.muted}>代码版本：{entry.repositoryCommitSha || "未记录"}</p>{entry.verification ? <><p className={styles.muted}>核对：{({ passed: "通过", failed: "未通过", inconclusive: "无法确认" } as const)[entry.verification.outcome]} · 成员自报 · {dateText(entry.verification.verifiedAt)} · 记录人 {entry.verification.verifiedBy}</p>{Boolean(entry.verification.evidenceRefs.length) && <ul>{entry.verification.evidenceRefs.map((item, index) => <li key={index}>{item}</li>)}</ul>}{entry.verification.note && <p>{entry.verification.note}</p>}</> : <p className={styles.muted}>尚无本项核对记录。</p>}</li>;
}

function DeliveryMaterialsPanel({ detail, state, summary, currentCommitSha, operationsReady, onSaved }: {
  detail: ProjectDetail;
  state: { data: DeliveryMaterialsView | null; error: Error | null; loading: boolean; reload: () => Promise<void> };
  summary: DeliveryMaterialsSummary | null;
  currentCommitSha: string | null;
  operationsReady: boolean;
  onSaved: () => Promise<void>;
}) {
  const base = `/projects/${detail.project.id}`;
  const readonly = detail.project.stage === "archived" || detail.membership.role !== "manager";
  const [entries, setEntries] = useState<Record<string, MaterialDraft>>({});
  const [branch, setBranch] = useState<BranchDraft>({ ...blankVerification(), branch: "", repositoryCommitSha: "" });
  const [baseline, setBaseline] = useState<{ expectedVersion: number | null; eventId: string; requirementsVersion: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [recovery, setRecovery] = useState<SaveDeliveryMaterialsInput | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessLost, setAccessLost] = useState(false);
  const inFlight = useRef(false);
  const scopeGeneration = useRef(0);
  const requirements = accessLost ? null : state.data?.requirements ?? null;
  const currentSummary = summary && requirements && summary.requirements?.eventId === requirements.eventId && summary.requirements.requirementsVersion === requirements.requirementsVersion && (summary.checklist?.version ?? null) === (state.data?.current?.version ?? null) && summary.currentCommitSha?.toLowerCase() === currentCommitSha?.toLowerCase() ? summary : null;
  const versionChanged = baseline !== null && state.data !== null && (state.data.current?.version ?? null) !== baseline.expectedVersion;
  const rulesChanged = baseline !== null && requirements !== null && (requirements.eventId !== baseline.eventId || requirements.requirementsVersion !== baseline.requirementsVersion);
  const needsReload = conflict || versionChanged || rulesChanged;
  const disabled = readonly || accessLost || pending || recovery !== null || state.loading || !!state.error || needsReload;
  function loadView(view: DeliveryMaterialsView) {
    const rules = view.requirements;
    if (!rules) { setBaseline(null); setEntries({}); setBranch({ ...blankVerification(), branch: "", repositoryCommitSha: "" }); setDirty(false); setConflict(false); return; }
    const sameRules = view.current?.eventId === rules.eventId && view.current?.requirementsVersion === rules.requirementsVersion;
    const next: Record<string, MaterialDraft> = {};
    for (const material of rules.materials) {
      const entry = view.current?.entries.find(item => item.requirementId === material.id);
      next[material.id] = { location: entry?.location ?? "", revision: entry?.revision ?? "", repositoryCommitSha: entry?.repositoryCommitSha ?? "", ...verificationDraft(sameRules ? entry?.verification : null) };
    }
    const savedBranch = view.current?.branchVerification;
    setEntries(next);
    setBranch({ branch: savedBranch?.branch ?? "", repositoryCommitSha: savedBranch?.repositoryCommitSha ?? "", ...verificationDraft(sameRules ? savedBranch : null) });
    setBaseline({ expectedVersion: view.current?.version ?? null, eventId: rules.eventId, requirementsVersion: rules.requirementsVersion });
    setDirty(false); setConflict(false);
  }
  useEffect(() => { if (state.data && !baseline && !recovery && !state.error && !accessLost) loadView(state.data); }, [state.data, baseline, recovery, state.error, accessLost]);
  function clearSensitive() {
    scopeGeneration.current++; setAccessLost(true); setRecovery(null); setBaseline(null); setEntries({}); setBranch({ ...blankVerification(), branch: "", repositoryCommitSha: "" }); setDirty(false); setConflict(false); setNotice("");
  }
  useEffect(() => {
    window.addEventListener("hackathon:unauthenticated", clearSensitive);
    if (state.error instanceof ApiError && [401, 403, 404].includes(state.error.status)) clearSensitive();
    return () => window.removeEventListener("hackathon:unauthenticated", clearSensitive);
  }, [state.error]);
  function changeEntry(id: string, change: Partial<MaterialDraft>) {
    setEntries(previous => ({ ...previous, [id]: { ...previous[id], ...change } })); setDirty(true); setNotice("");
  }
  function changeBranch(change: Partial<BranchDraft>) { setBranch(previous => ({ ...previous, ...change })); setDirty(true); setNotice(""); }
  async function resolved(record: DeliveryMaterialChecklist) {
    setRecovery(null); setBaseline({ expectedVersion: record.version, eventId: record.eventId, requirementsVersion: record.requirementsVersion }); setDirty(false); setConflict(false);
    setNotice(`材料清单第 ${record.version} 版已保存，核对结果为成员自报。运行与正式提交需分别记录。`);
    await Promise.all([state.reload(), onSaved()]);
  }
  async function send(request: SaveDeliveryMaterialsInput) {
    if (inFlight.current) return;
    inFlight.current = true; const generation = scopeGeneration.current; setPending(true); setError(""); setNotice(""); setRecovery(request);
    try {
      const record = await api<DeliveryMaterialChecklist>(`${base}/delivery-materials`, { method: "PUT", body: request, idempotencyKey: request.idempotencyKey });
      if (scopeGeneration.current === generation) await resolved(record);
    } catch (reason) {
      if (scopeGeneration.current !== generation) return;
      setError(message(reason));
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { clearSensitive(); return; }
      if (unknownMaterialOutcome(reason)) setNotice("这次保存结果尚未确认。原请求、版本和标识已保留，请核对原保存结果后再继续编辑。");
      else {
        setRecovery(null);
        if (reason instanceof ApiError && reason.status === 409) { setConflict(true); await Promise.all([state.reload(), onSaved()]); }
      }
    } finally { inFlight.current = false; setPending(false); }
  }
  async function recover() {
    if (!recovery || inFlight.current) return;
    const request = recovery; const generation = scopeGeneration.current; inFlight.current = true; setPending(true); setError("");
    try {
      const view = await api<DeliveryMaterialsView>(`${base}/delivery-materials`);
      if (scopeGeneration.current !== generation) return;
      const record = [view.current, ...view.history].find(item => item?.idempotencyKey === request.idempotencyKey && item.recordedBy === detail.membership.userId && item.eventId === request.eventId && item.requirementsVersion === request.requirementsVersion);
      if (record) await resolved(record);
      else { inFlight.current = false; await send(request); }
    } catch (reason) { if (scopeGeneration.current === generation) { setError(message(reason)); if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) clearSensitive(); } }
    finally { inFlight.current = false; setPending(false); }
  }
  async function save() {
    setError(""); setNotice("");
    try {
      if (disabled || !baseline || !requirements || !operationsReady) throw new Error("请先读取当前规则、材料清单和仓库保存记录，再核对后保存。");
      const check = requirements.requiredBranch.status === "not_required" ? null : verificationInput(branch);
      const request: SaveDeliveryMaterialsInput = {
        ...baseline, repositoryCommitSha: currentCommitSha,
        entries: requirements.materials.map(material => {
          const entry = entries[material.id];
          if (!entry) throw new Error("材料清单未完整载入，请读取最新清单。");
          return { requirementId: material.id, location: entry.location.trim() || null, revision: entry.revision.trim() || null, repositoryCommitSha: entry.repositoryCommitSha.trim() || null, verification: verificationInput(entry) };
        }),
        branchVerification: check ? { ...check, branch: branch.branch.trim(), repositoryCommitSha: branch.repositoryCommitSha.trim() } : null,
        idempotencyKey: operationKey(),
      };
      await send(request);
    } catch (reason) { setError(message(reason)); }
  }
  const names = new Map(requirements?.materials.map(item => [item.id, item.label]));
  return <section className={styles.panel} id="delivery-materials">
    <h2>1 · 核对必交材料和分支</h2>
    <p className={styles.muted}>清单来自当前空间已确认的正式比赛要求。逐项填写实际位置、修订和核对依据；保存清单不会替你运行作品或向主办方提交。</p>
    <p><Link className={styles.link} href={`/app/projects/${encodeURIComponent(detail.project.id)}/rules`}>打开比赛要求，人工核对原文、必交材料与要求分支 →</Link></p>
    <Feedback error={error || state.error} notice={notice}/>
    {accessLost && <p className={styles.notice}>登录或空间权限已变化，未保存的私人材料输入已清除。请重新打开当前空间，读取最新权限后继续。</p>}
    <div className={styles.actions}><button type="button" className={styles.secondary} disabled={pending || state.loading} onClick={() => void Promise.all([state.reload(), onSaved()])}>重新读取材料与规则</button>{recovery && <button type="button" className={styles.button} disabled={pending || readonly} onClick={() => void recover()}>{pending ? "正在核对…" : "核对原保存结果"}</button>}</div>
    {state.loading && <Loading/>}
    {needsReload && <div className={styles.notice}><p>材料或确认规则已更新。未保存输入仍在下方，请先对照最新事实；继续保存需要载入最新清单。</p><button type="button" className={styles.secondary} disabled={pending || recovery !== null || !state.data || !!state.error || state.loading} onClick={() => { if (state.data) { loadView(state.data); setError(""); setNotice("最新清单已载入。规则变化后需重新记录核对结果，原记录仍在历史中。"); } }}>载入最新清单并替换未保存输入</button></div>}
    {!state.loading && !requirements && <p className={styles.notice}>尚未读取已确认的正式材料要求。必交范围和要求分支保持未知，请先到比赛要求页人工核对；自动发现线索不能作为这份清单的正式要求。</p>}
    {requirements && <>
      <p className={styles.muted}>确认规则版本：{requirements.requirementsVersion} · 确认时间 {dateText(requirements.confirmedAt)} · 材料清单 {state.data?.current ? `第 ${state.data.current.version} 版` : "尚未保存"}</p>
      {requirements.materialsStatus === "unknown" && <p className={styles.notice}>正式规则尚未明确完整材料范围，现有条目不能代表全部必交内容。请人工核对原文并补齐正式规则。</p>}
      {currentSummary ? <><p>材料总体核对：<span className={styles.tag}>{({ not_loaded: "要求未读取", unknown: "仍有未知要求", missing: "缺少必交材料", needs_review: "需要重新核对", ready: "当前版本已核对（成员自报）" } as const)[currentSummary.status]}</span> · 分支：{branchLabels[currentSummary.branch.status]}</p>{currentSummary.gaps.length > 0 && <ul className={styles.notice}>{currentSummary.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}</> : <p className={styles.notice}>材料汇总尚未读取完整，或规则、清单、代码版本与当前事实不一致，暂时无法确认材料是否准备齐全。</p>}
      {requirements.unknowns.length > 0 && <details><summary>正式规则尚待明确的内容（{requirements.unknowns.length} 项）</summary><ul>{requirements.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul></details>}
      <p className={styles.muted}>本次清单关联最新已保存代码：{operationsReady ? currentCommitSha || "尚无已保存 commit，核对通过需先关联真实保存版本" : "仓库保存记录尚未读取完整"}。历史核对的代码版本保留原值，需实际复查后填写。</p>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
        {!requirements.materials.length && <p className={styles.notice}>当前正式规则没有可填写的结构化材料条目，请到比赛要求页核对是否漏录必交内容。</p>}
        {requirements.materials.map(material => {
          const entry = entries[material.id];
          const readiness = currentSummary?.materials.find(item => item.id === material.id);
          if (!entry) return null;
          const materialStage = requirements.stages.find(item => item.id === material.stageId);
          return <fieldset key={material.id} className={styles.form} disabled={disabled}>
            <legend>{material.label} · {({ required: "必交", optional: "选交", unknown: "是否必交待核对" } as const)[material.necessity]}</legend>
            <p className={styles.muted}>已保存状态：{readiness ? materialLabels[readiness.status] : "尚待读取"}{materialStage && ` · 阶段：${materialStage.name}`}</p>
            {materialStage && <p className={styles.muted}>本阶段提交截止：{materialStage.deadline ? dateText(materialStage.deadline) : "尚未确定"}{materialStage.deadlineRawText && ` · 原文：${materialStage.deadlineRawText}`}</p>}
            {material.evidenceRefs.length > 0 && <details><summary>正式规则依据</summary><ul>{material.evidenceRefs.map((reference, index) => <li key={index}>{reference}</li>)}</ul></details>}
            <Field label="实际材料位置或 HTTPS 链接"><input value={entry.location} required={entry.outcome === "passed"} onChange={event => changeEntry(material.id, { location: event.target.value })} placeholder="例如：docs/demo.md，或真实视频/文档版本页链接" maxLength={2048}/></Field>
            <Field label="材料修订或版本"><input value={entry.revision} required={entry.outcome === "passed"} onChange={event => changeEntry(material.id, { revision: event.target.value })} placeholder="填写实际修订号、版本标识或记录名称" maxLength={200}/></Field>
            <Field label="本项核对关联的完整 commit SHA"><input value={entry.repositoryCommitSha} required={entry.outcome === "passed"} onChange={event => changeEntry(material.id, { repositoryCommitSha: event.target.value })} pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}" maxLength={64}/></Field>
            <VerificationFields value={entry} disabled={disabled} onChange={change => changeEntry(material.id, change)}/>
          </fieldset>;
        })}
        <fieldset className={styles.form} disabled={disabled}>
          <legend>核对比赛要求分支</legend>
          <p className={styles.muted}>{requirements.requiredBranch.status === "specified" ? `正式规则要求分支：${requirements.requiredBranch.name}。请在仓库核对该分支确实包含本次代码版本。` : requirements.requiredBranch.status === "not_required" ? "已确认的正式规则明确不要求指定分支。" : `分支要求未知：${requirements.requiredBranch.reason}`}</p>
          {requirements.requiredBranch.status === "unknown" && <p className={styles.notice}>仓库默认分支、已创建 PR 或本次操作分支不能确定比赛要求。人工核对记录不会自动补造规则要求。</p>}
          {requirements.requiredBranch.status !== "not_required" && <>
            <Field label="实际核对的分支名称"><input value={branch.branch} required={branch.outcome !== "unrecorded"} maxLength={255} onChange={event => changeBranch({ branch: event.target.value })}/></Field>
            <Field label="该分支已包含的完整 commit SHA"><input value={branch.repositoryCommitSha} required={branch.outcome !== "unrecorded"} pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}" maxLength={64} onChange={event => changeBranch({ repositoryCommitSha: event.target.value })}/></Field>
            <VerificationFields value={branch} disabled={disabled} onChange={changeBranch}/>
          </>}
        </fieldset>
        {readonly && <p className={styles.notice}>{detail.project.stage === "archived" ? "已归档空间只能查看已有清单。" : "当前身份可以查看材料记录；保存与核对由空间管理员操作。"}</p>}
        <button className={styles.button} disabled={disabled || !baseline || !operationsReady}>{pending ? "正在保存…" : baseline?.expectedVersion ? "保存新的材料清单版本" : "保存材料清单"}</button>
        {dirty && <p className={styles.muted}>下方输入尚未保存；材料状态仍以已保存清单为准。</p>}
      </form>
    </>}
    {!accessLost && !state.error && state.data && <details><summary>材料清单与核对历史（{state.data.history.length} 版）</summary>{state.data.history.length ? [...state.data.history].sort((a, b) => b.version - a.version).map(record => <section key={`${record.id}:${record.version}`} className={styles.panel}><h3>材料清单第 {record.version} 版</h3><p className={styles.muted}>{dateText(record.recordedAt)} · 记录人 {record.recordedBy} · 规则版本 {record.requirementsVersion}</p><p className={styles.muted}>关联代码：{record.repositoryCommitSha || "未记录"}</p><ul>{record.entries.map(entry => <MaterialRecord key={entry.requirementId} entry={entry} label={names.get(entry.requirementId) ?? entry.requirementId}/>)}</ul>{record.branchVerification && <><p>分支核对：{record.branchVerification.branch} · {({ passed: "通过", failed: "未通过", inconclusive: "无法确认" } as const)[record.branchVerification.outcome]}（成员自报）</p><p className={styles.muted}>代码版本 {record.branchVerification.repositoryCommitSha} · {dateText(record.branchVerification.verifiedAt)} · 记录人 {record.branchVerification.verifiedBy}</p><ul>{record.branchVerification.evidenceRefs.map((item, index) => <li key={index}>{item}</li>)}</ul>{record.branchVerification.note && <p>{record.branchVerification.note}</p>}</>}</section>) : <p className={styles.muted}>尚无已保存材料清单。</p>}</details>}
  </section>;
}
