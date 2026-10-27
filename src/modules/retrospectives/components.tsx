"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { answerKeys, reusableFields } from "./domain.ts";
import type { Answers, DeliveryFacts, EvidenceKind, ExperienceCard, ReusableField, Retrospective, RetrospectiveContent, ReuseDraft, Scope, ToolExperience } from "./domain.ts";
import { url as validatedUrl } from "./validation.ts";
import styles from "./retrospectives.module.css";
import { SkillUsageDetails, SkillUsageFields } from "./skill-usage-fields.tsx";

const questions: Record<keyof Answers, string> = {
  goalAndOutcome: "原来计划交付什么，最后实际交付了什么？",
  blockerAndResponse: "最大的阻塞是什么，在哪个检查点发现，怎样处理？",
  helpfulPractice: "哪项分工或做法最有帮助，依据是什么？",
  scopeReduction: "哪个功能删掉了，是否帮助按时提交？",
  nextChange: "下一次最想保留或改变的一件事是什么？",
};
const evidenceLabels: Record<EvidenceKind, string> = {
  rule: "赛事规则", plan: "计划", task: "任务", assignment: "分工",
  git_save: "仓库保存", delivery_verification: "运行验收", submission: "赛事提交", project_resource: "项目资料",
};
const fieldLabels: Record<ReusableField, string> = {
  title: "标题", scenario: "问题场景", advice: "建议步骤", conditions: "适用条件", limitations: "不适用或未知", tools: "工具经历", skillUsage: "技能使用反馈（成员自报）",
};
const rechecks = ["当前赛事资格与必交材料", "截止时间与时区", "成员可用时间、估时和任务依赖", "仓库与第三方账号授权", "工具可用性、费用、账号要求、技术栈、许可和比赛允许的 AI 使用范围", "技能固定版本的当前可获取性、目标客户端与环境、许可、学习时间和赛事允许范围；复制反馈不会安装技能"];

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return validatedUrl(value); } catch { return undefined; }
}
function SourceLink({ url, children }: { url?: string; children: ReactNode }) {
  const href = safeHref(url);
  return href ? <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">{children}（新窗口）</a> : <span>{children} · 链接未记录或无效</span>;
}
function dateLabel(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待核对";
  return `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)}（UTC+8）`;
}
function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "VERSION_CONFLICT") return "记录已被更新。你的编辑已保留，请载入最新版本并对照后再保存。";
    if ("message" in error && typeof error.message === "string" && error.message) return error.message;
  }
  return fallback;
}
function equalContent(a: RetrospectiveContent, b: RetrospectiveContent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function ToolExperiences({ tools }: { tools: readonly ToolExperience[] }) {
  if (!tools.length) return <p className={styles.muted}>尚未记录工具经历。</p>;
  return <ul className={styles.records}>{tools.map((tool, index) => <li className={styles.record} key={`${tool.resourceId ?? tool.originalUrl}-${index}`}>
    <p className={styles.recordTitle}>{tool.usedFor}</p>
    <span className={styles.tag}>成员记录 · 使用条件需重新核验</span>
    <dl className={styles.facts}>
      <div><dt>限制</dt><dd>{tool.limitations}</dd></div>
      <div><dt>当时费用</dt><dd>{tool.costAtUse}</dd></div>
      <div><dt>当时核验</dt><dd>{dateLabel(tool.verifiedAt)}</dd></div>
      {tool.resourceId && <div><dt>资源引用</dt><dd>{tool.resourceId}</dd></div>}
      {tool.originalUrl && <div><dt>原始链接</dt><dd><SourceLink url={tool.originalUrl}>查看工具来源</SourceLink></dd></div>}
    </dl>
  </li>)}</ul>;
}

export interface RetrospectiveSaveInput {
  expectedRevision: number;
  scope: Scope;
  content: RetrospectiveContent;
}
export interface RetrospectiveEditorProps {
  documentId: string;
  initialContent: RetrospectiveContent;
  initialScope: Scope;
  /** The current server revision. Update this and initialContent after saving or loading. */
  expectedRevision: number;
  status: Retrospective["status"];
  canEdit?: boolean;
  canChangeScope?: boolean;
  canConfirm?: boolean;
  confirmationUnavailableReason?: string;
  /** A safe response revision is sufficient; returned document bodies are never adopted. */
  onSave(input: RetrospectiveSaveInput): Promise<{ revision: number }>;
  onConfirm(input: { expectedRevision: number; useGeneratedDraft: false }): Promise<unknown>;
  /** Caller loads and authorizes current data; this component never fetches it itself. */
  onLoadLatest?: () => Promise<void>;
  /** Private autosave input. It never changes the official document baseline. */
  restoredDraft?: { content: RetrospectiveContent; scope: Scope };
  /** Change only after an explicit user choice to adopt a private draft. */
  restoredDraftKey?: string | number;
  onDraftChange?: (input: { content: RetrospectiveContent; scope: Scope }) => void;
  canSave?: boolean;
  preserveDraftOnRemoteChange?: boolean;
  onAcceptOfficialRevision?: (revision: number, mode: "adopt" | "rebase") => void;
}

/** Use the document identity as a key so switching documents never mixes their inputs. */
export function RetrospectiveEditor(props: RetrospectiveEditorProps) {
  return <RetrospectiveEditorForm key={props.documentId} {...props} />;
}
function RetrospectiveEditorForm({ initialContent, initialScope, expectedRevision, status, canEdit = true, canChangeScope = true, canConfirm = true, confirmationUnavailableReason, onSave, onConfirm, onLoadLatest, restoredDraft, restoredDraftKey, onDraftChange, canSave = true, preserveDraftOnRemoteChange = false, onAcceptOfficialRevision }: RetrospectiveEditorProps) {
  const id = useId();
  const [content, setContent] = useState<RetrospectiveContent>(() => structuredClone(restoredDraft?.content ?? initialContent));
  const [scope, setScope] = useState(restoredDraft?.scope ?? initialScope);
  const [baseline, setBaseline] = useState(() => ({ content: structuredClone(initialContent), scope: initialScope, revision: expectedRevision }));
  const [busy, setBusy] = useState<"save" | "confirm" | "load" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const restoredKey = useRef(restoredDraftKey);
  const dirty = !equalContent(content, baseline.content) || scope !== baseline.scope;
  const remoteChanged = expectedRevision > baseline.revision;
  const waitingForRevision = expectedRevision < baseline.revision;
  const disabled = !canEdit || Boolean(busy);
  const confirmBlocked = disabled || !canSave || !canConfirm || dirty || remoteChanged || waitingForRevision || status === "confirmed" || status === "generating";
  useEffect(() => {
    if (restoredDraftKey === undefined || restoredKey.current === restoredDraftKey || !restoredDraft) return;
    restoredKey.current = restoredDraftKey;
    setContent(structuredClone(restoredDraft.content)); setScope(restoredDraft.scope);
    setError(""); setNotice("已按你的选择载入本人编辑草稿，正式复盘仍需显式保存。");
  }, [restoredDraftKey, restoredDraft]);
  useEffect(() => { onDraftChange?.({ content: structuredClone(content), scope }); }, [content, scope, onDraftChange]);

  // New server data may replace a clean form, but never overwrites local edits.
  useEffect(() => {
    if (preserveDraftOnRemoteChange || !remoteChanged || dirty || busy) return;
    setContent(structuredClone(initialContent)); setScope(initialScope);
    setBaseline({ content: structuredClone(initialContent), scope: initialScope, revision: expectedRevision });
  }, [remoteChanged, dirty, busy, initialContent, initialScope, expectedRevision, preserveDraftOnRemoteChange]);

  async function run(action: "save" | "confirm" | "load", work: () => Promise<void>, success: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(action); setError(""); setNotice("");
    try { await work(); setNotice(success); }
    catch (reason) { setError(errorText(reason, "操作未完成，输入已保留。请稍后重试。")); }
    finally { locked.current = false; setBusy(null); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !canSave || remoteChanged || waitingForRevision || !dirty) return;
    const snapshot = structuredClone(content), savedScope = scope;
    void run("save", async () => {
      const saved = await onSave({ expectedRevision, scope: savedScope, content: snapshot });
      if (!Number.isSafeInteger(saved.revision) || saved.revision <= expectedRevision) throw new Error("保存结果的版本待核对，输入已保留。请获取最新版本。");
      setBaseline({ content: snapshot, scope: savedScope, revision: saved.revision });
    }, "草稿已保存。确认前请核对正文和分享范围。");
  }
  function acceptLatest() {
    setContent(structuredClone(initialContent)); setScope(initialScope);
    setBaseline({ content: structuredClone(initialContent), scope: initialScope, revision: expectedRevision });
    setError(""); setNotice("已载入最新版本。");
    onAcceptOfficialRevision?.(expectedRevision, "adopt");
  }
  const statusLabel = { draft: "草稿", generating: "正在整理", review_required: "待复核", confirmed: "已确认" }[status];
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>把本次经历留下来</p><h2 id={`${id}-title`}>参赛复盘</h2></div><span className={styles.tag}>{statusLabel} · 版本 {expectedRevision}</span></header>
    <p className={styles.muted} id={`${id}-help`}>可以填写“不知道”“没有记录”或“不愿分享”。先保存草稿，再核对并确认。</p>
    <form className={styles.form} onSubmit={save} aria-describedby={`${id}-help`} aria-busy={Boolean(busy)}>
      <fieldset className={styles.fieldset} disabled={disabled}>
        <legend>五个问题</legend>
        {answerKeys.map((key, index) => <div className={styles.field} key={key}>
          <label htmlFor={`${id}-${key}`}><span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>{questions[key]}</label>
          <textarea id={`${id}-${key}`} name={key} rows={4} maxLength={4000} required value={content.answers[key]} onChange={event => {
            setContent(previous => ({ ...previous, answers: { ...previous.answers, [key]: event.target.value } })); setNotice("");
          }} />
        </div>)}
      </fieldset>
      <fieldset className={styles.fieldset} disabled={disabled || !canChangeScope} aria-describedby={`${id}-scope-help`}>
        <legend>谁可以看这份复盘</legend>
        <div className={styles.choices}>
          <label className={styles.choice}><input type="radio" name={`${id}-scope`} value="personal" checked={scope === "personal"} onChange={() => { setScope("personal"); setNotice(""); }} /><span><strong>仅本人</strong><small>个人笔记，由你主动决定是否分享。</small></span></label>
          <label className={styles.choice}><input type="radio" name={`${id}-scope`} value="project" checked={scope === "project"} onChange={() => { setScope("project"); setNotice(""); }} /><span><strong>本项目成员</strong><small>保存后，当前项目成员可以查看正文和已共享引用。</small></span></label>
        </div>
        <p className={styles.muted} id={`${id}-scope-help`}>{canChangeScope ? "分享范围随本次保存生效。项目共同结论需由当前项目管理员确认。" : "只有作者可以改变分享范围。"}</p>
      </fieldset>
      <div className={styles.subsection}><h3>证据引用</h3>{content.evidenceRefs.length ? <ul className={styles.evidenceList}>{content.evidenceRefs.map(ref => <li key={`${ref.kind}-${ref.id}-${ref.revision}`}>{evidenceLabels[ref.kind]} · {ref.id} · 版本 {ref.revision}</li>)}</ul> : <p className={styles.muted}>尚未引用项目证据。保存或确认时会重新校验已有引用。</p>}</div>
      <div className={styles.subsection}><h3>工具经历</h3><ToolExperiences tools={content.tools} /></div>
      <SkillUsageFields value={content.skillUsage ?? []} readonly={disabled} onChange={skillUsage => setContent(previous => ({ ...previous, skillUsage }))}/>
      {remoteChanged && <aside className={styles.warning} aria-label="最新版本对照">
        <p><strong>已有新的服务器版本，你的编辑仍保留。</strong></p>
        <details><summary>对照最新版本 {expectedRevision}</summary><dl className={styles.latest}>{answerKeys.map(key => <div key={key}><dt>{questions[key]}</dt><dd>{initialContent.answers[key]}</dd></div>)}<div><dt>最新分享范围</dt><dd>{initialScope === "personal" ? "仅本人" : "本项目成员"}</dd></div></dl></details>
        <div className={styles.actions}><button className={styles.secondaryButton} type="button" disabled={disabled} onClick={() => { setBaseline({ content: structuredClone(initialContent), scope: initialScope, revision: expectedRevision }); setError(""); setNotice("已保留你的编辑。保存将使用当前服务器版本，请再核对差异。"); onAcceptOfficialRevision?.(expectedRevision, "rebase"); }}>已对照，保留我的编辑</button><button className={styles.secondaryButton} type="button" disabled={disabled} onClick={acceptLatest}>放弃本地编辑，载入最新</button></div>
      </aside>}
      {error && <p className={styles.error} role="alert">{error} {onLoadLatest && <button className={styles.textButton} type="button" disabled={Boolean(busy)} onClick={() => { void run("load", onLoadLatest, "已获取最新版本。你的输入仍保留，请对照后选择。"); }}>获取最新版本</button>}</p>}
      <p className={styles.feedback} role="status" aria-live="polite">{busy === "save" ? "正在保存草稿…" : busy === "confirm" ? "正在确认复盘…" : busy === "load" ? "正在获取最新版本…" : notice}</p>
      <div className={styles.actions}><button className={styles.primaryButton} type="submit" disabled={disabled || !canSave || remoteChanged || waitingForRevision || !dirty}>{busy === "save" ? "正在保存…" : "正式保存复盘草稿"}</button><button className={styles.secondaryButton} type="button" disabled={confirmBlocked} onClick={() => { void run("confirm", async () => { await onConfirm({ expectedRevision, useGeneratedDraft: false }); }, "复盘已确认。"); }}>{busy === "confirm" ? "正在确认…" : "确认已保存的复盘"}</button></div>
      <p className={styles.muted}>{!canEdit ? "当前为只读模式。" : waitingForRevision ? "已保存，正在等待最新版本信息。" : dirty ? "有未保存的编辑，请先保存后再确认。" : !canConfirm ? confirmationUnavailableReason ?? "当前账号没有确认这份复盘的权限。" : status === "generating" ? "整理任务进行中，完成后可确认人工正文。" : status === "confirmed" ? "复盘已确认。修改后可保存为新的草稿。" : "确认采用当前已保存的人工正文。"}</p>
    </form>
  </section>;
}

export interface ExperienceReuseInput {
  sourceCardId: string;
  sourceRevision: number;
  selectedFields: ReusableField[];
  acknowledgeRechecks: true;
}
export interface ExperienceReusePickerProps {
  card: ExperienceCard;
  targetProjectId: string;
  targetProjectName: string;
  needsReview?: boolean;
  canCreateDraft?: boolean;
  onCreateDraft(input: ExperienceReuseInput): Promise<Pick<ReuseDraft, "id" | "projectId" | "sourceCardId" | "sourceRevision">>;
}
export function ExperienceReusePicker(props: ExperienceReusePickerProps) {
  return <ExperienceReusePickerForm key={`${props.card.id}:${props.card.revision}:${props.targetProjectId}`} {...props} />;
}
function ExperienceReusePickerForm({ card, targetProjectId, targetProjectName, needsReview = false, canCreateDraft = true, onCreateDraft }: ExperienceReusePickerProps) {
  const id = useId();
  const [selected, setSelected] = useState<ReusableField[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");
  const locked = useRef(false);
  const blocked = !canCreateDraft || needsReview || card.status !== "confirmed" || card.projectId === targetProjectId;
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || blocked || !acknowledged || !selected.length || createdId) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const draft = await onCreateDraft({ sourceCardId: card.id, sourceRevision: card.revision, selectedFields: reusableFields.filter(field => selected.includes(field)), acknowledgeRechecks: true });
      if (!draft.id || draft.projectId !== targetProjectId || draft.sourceCardId !== card.id || draft.sourceRevision !== card.revision) throw new Error("返回的草稿与本次选择不一致，请核对结果。");
      setCreatedId(draft.id);
    } catch (reason) { setError(errorText(reason, "草稿未创建，选择已保留。请稍后重试。")); }
    finally { locked.current = false; setBusy(false); }
  }
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>带着条件复用</p><h2 id={`${id}-title`}>选择经验，创建新草稿</h2></div><span className={styles.tag}>个人草稿</span></header>
    <div className={styles.subsection}><h3>{card.content.title}</h3><p>{card.content.scenario}</p><p className={styles.muted}>来源项目：{card.projectId} · 经验版本 {card.revision} · 来源范围：{card.scope === "personal" ? "仅本人" : "当前项目成员"}</p><dl className={styles.latest}><div><dt>适用条件</dt><dd>{card.content.conditions}</dd></div><div><dt>不适用或未知</dt><dd>{card.content.limitations}</dd></div></dl></div>
    <form className={styles.form} onSubmit={create} aria-busy={busy}>
      <fieldset className={styles.fieldset} disabled={busy || blocked || Boolean(createdId)}>
        <legend>复制到「{targetProjectName}」的内容</legend>
        <div className={styles.fieldOptions}>{reusableFields.map(field => <label className={styles.choice} key={field}><input type="checkbox" disabled={field === "skillUsage" && !card.content.skillUsage?.length} checked={selected.includes(field)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, field] : previous.filter(item => item !== field)); }} /><span>{fieldLabels[field]}</span></label>)}</div>
      </fieldset>
      <details className={styles.subsection}><summary>查看建议步骤与工具经历</summary><ol>{card.content.advice.map((step, index) => <li key={index}>{step}</li>)}</ol><ToolExperiences tools={card.content.tools} /></details>
      <div className={styles.subsection} aria-live="polite"><h3>本次将保存到新项目的参考内容</h3>{selected.length ? <dl className={styles.latest}>{reusableFields.filter(field => selected.includes(field)).map(field => <div key={field}><dt>{fieldLabels[field]}</dt><dd>{field === "advice" ? <ol>{card.content.advice.map((step, index) => <li key={index}>{step}</li>)}</ol> : field === "tools" ? <ToolExperiences tools={card.content.tools}/> : field === "skillUsage" ? <SkillUsageDetails value={card.content.skillUsage}/> : card.content[field]}</dd></div>)}</dl> : <p className={styles.muted}>选择字段后，在这里核对具体内容。</p>}</div>
      <div className={styles.warning}><h3>新项目需要重新核验</h3><ul>{rechecks.map(item => <li key={item}>{item}</li>)}</ul><p>草稿仅包含选中的参考内容。旧授权、旧日期、旧提交状态和他人原始测评不会复制。</p></div>
      <label className={styles.choice}><input type="checkbox" checked={acknowledged} disabled={busy || blocked || Boolean(createdId)} onChange={event => { setAcknowledged(event.target.checked); }} /><span>我会在新项目中重新核验这些条件，确认后再使用。</span></label>
      {blocked && <p className={styles.warning}>{!canCreateDraft ? "当前账号不能在目标项目创建草稿。" : card.projectId === targetProjectId ? "请选择另一个项目作为复用目标。" : needsReview ? "来源依据或工具条件已变化，请先复核经验卡。" : "经验卡尚未确认或已归档，请选择当前已确认的经验。"}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.feedback} role="status" aria-live="polite">{busy ? "正在创建个人草稿…" : createdId ? `已在「${targetProjectName}」创建个人草稿。请完成核验后再确认使用。` : ""}</p>
      <div className={styles.actions}><button className={styles.primaryButton} type="submit" disabled={busy || blocked || !acknowledged || !selected.length || Boolean(createdId)}>{busy ? "正在创建…" : createdId ? "草稿已创建" : "创建个人复用草稿"}</button><span className={styles.muted}>已选择 {selected.length} 项</span></div>
    </form>
  </section>;
}

export interface DeliverySummaryPanelProps {
  /** Already authorized projections from M06; no write action is performed here. */
  facts: DeliveryFacts;
}
export function DeliverySummaryPanel({ facts }: DeliverySummaryPanelProps) {
  const id = useId();
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>核对本次交付</p><h2 id={`${id}-title`}>交付事实</h2></div><span className={styles.tag}>项目记录</span></header>
    <div className={styles.deliveryGrid}>
      <section className={styles.deliveryColumn} aria-labelledby={`${id}-saves`}><h3 id={`${id}-saves`}>仓库保存</h3><p className={styles.muted}>记录保存到仓库的版本。</p>{!facts.saves.length ? <p className={styles.empty}>尚无仓库保存记录。</p> : <ul className={styles.records}>{facts.saves.map(save => <li className={styles.record} key={save.id}><span className={styles.tag}>{({ draft: "保存草稿", ready_for_preview: "等待变更预览", saving: "正在保存", saved: "保存已完成", blocked: "保存受阻", failed: "保存失败", unknown: "保存结果未知" } as const)[save.status] ?? "保存状态待核对"}</span><dl className={styles.facts}><div><dt>分支</dt><dd>{save.branch}</dd></div><div><dt>版本</dt><dd className={styles.code}>{save.commitSha ?? "未记录"}</dd></div><div><dt>记录时间</dt><dd>{dateLabel(save.recordedAt)}</dd></div><div><dt>仓库</dt><dd><SourceLink url={save.repositoryUrl}>查看仓库</SourceLink></dd></div></dl></li>)}</ul>}</section>
      <section className={styles.deliveryColumn} aria-labelledby={`${id}-runs`}><h3 id={`${id}-runs`}>运行验收</h3><p className={styles.muted}>记录指定环境与步骤中的结果。</p>{!facts.verifications.length ? <p className={styles.empty}>尚无运行验收记录。</p> : <ul className={styles.records}>{facts.verifications.map(run => <li className={styles.record} key={run.id}><span className={styles.tag}>{({ passed: "验收通过", failed: "验收未通过", inconclusive: "无法确认" } as const)[run.outcome] ?? "验收状态待核对"} · 队员记录（用户自报）</span><dl className={styles.facts}><div><dt>环境</dt><dd>{run.environmentSummary}</dd></div><div><dt>验收时间</dt><dd>{dateLabel(run.verifiedAt)}</dd></div><div><dt>验收人</dt><dd>{run.verifierId}</dd></div><div><dt>仓库版本</dt><dd className={styles.code}>{run.repositoryCommitSha ?? "未记录"}</dd></div></dl>{Boolean(run.steps.length) && <details><summary>验收步骤（{run.steps.length} 项）</summary><ol>{run.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>}{Boolean(run.blockers.length) && <div className={styles.warning}><strong>阻塞项</strong><ul>{run.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}</li>)}</ul>}</section>
      <section className={styles.deliveryColumn} aria-labelledby={`${id}-submissions`}><h3 id={`${id}-submissions`}>赛事正式提交</h3><p className={styles.muted}>按赛事阶段与平台来源核对。</p>{!facts.submissions.length ? <p className={styles.empty}>尚无赛事提交记录，实际是否提交无法确认。</p> : <ul className={styles.records}>{facts.submissions.map(submission => {
        const inconsistent = (submission.status === "verified" && submission.verificationSource !== "platform_verified") || (submission.status === "reported" && submission.verificationSource !== "user_reported");
        const label = inconsistent ? "来源与状态待核对" : ({ not_submitted: "记录为未提交", reported: "自报已提交", verified: "平台核验已提交", rejected_or_withdrawn: "被拒绝或已撤回" } as const)[submission.status] ?? "提交状态待核对";
        return <li className={styles.record} key={submission.id}><span className={styles.tag}>{label}</span><p className={styles.muted}>来源：{submission.verificationSource === "user_reported" ? "队员记录（用户自报）" : submission.verificationSource === "platform_verified" ? "平台核验" : "来源未知"}</p><dl className={styles.facts}><div><dt>赛事 / 阶段</dt><dd>{submission.eventId} / {submission.stageId}</dd></div><div><dt>要求版本</dt><dd>{submission.requirementsVersion}</dd></div><div><dt>提交时间</dt><dd>{dateLabel(submission.submittedAt)}</dd></div><div><dt>仓库版本</dt><dd className={styles.code}>{submission.repositoryCommitSha ?? "未记录"}</dd></div><div><dt>平台</dt><dd><SourceLink url={submission.platformUrl}>查看平台记录</SourceLink></dd></div></dl></li>;
      })}</ul>}</section>
    </div>
    <div className={styles.subsection}><h3>材料清单</h3>{facts.materials.length ? <ul className={styles.materials}>{facts.materials.map(material => <li key={material.id}><span>{material.label}</span><span className={styles.tag}>{({ missing: "尚未准备", prepared: "已准备", unknown: "准备状态未知" } as const)[material.status] ?? "状态待核对"}</span></li>)}</ul> : <p className={styles.empty}>尚无材料清单记录。</p>}</div>
    <p className={styles.muted}>三类记录分别来自对应事实。仓库保存、运行验收和赛事提交需要逐项核对；材料已准备仍需确认实际提交。</p>
  </section>;
}
