"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentId } from "./domain.ts";
import type { SkillCandidate, SkillCandidateDocument, SkillCandidateEvidence, SkillPublicationTarget, SkillReviewSnapshot } from "./publication-types.ts";
import styles from "./skill-review-panel.module.css";

/** The root adapter maps the M08 review record to this browser-only projection. */
export interface SkillReviewPanelRecord extends SkillPublicationTarget {
  reviewId: string;
  candidateRevision: number;
  contentHash: string;
  manifestHash: string;
  revision: number;
  status: "pending" | "changes_requested" | "approved" | "rejected" | "published";
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface SkillReviewPanelExactTarget extends SkillPublicationTarget {
  expectedRevision: number;
  expectedContentHash: string;
  expectedManifestHash: string;
}

/** All permissions, validation, CAS checks and publication run on the server. */
export interface SkillReviewPanelApi {
  listCandidates(): Promise<readonly SkillCandidate[]>;
  listReviews(target: SkillPublicationTarget): Promise<readonly SkillReviewPanelRecord[]>;
  getSnapshot(target: SkillPublicationTarget): Promise<SkillReviewSnapshot | null>;
  createCandidate(input: { document: SkillCandidateDocument; evidence: SkillCandidateEvidence }): Promise<SkillCandidate>;
  updateCandidate(input: SkillPublicationTarget & { expectedRevision: number; document: SkillCandidateDocument; evidence: SkillCandidateEvidence }): Promise<SkillCandidate>;
  registerReview(input: SkillReviewPanelExactTarget): Promise<SkillReviewPanelRecord>;
  decideReview(input: SkillReviewPanelExactTarget & {
    reviewId: string; expectedReviewRevision: number;
    decision: "approved" | "changes_requested" | "rejected";
    reason: string;
    verification?: { licenseChecked: true; behaviorChecked: true; acknowledgedCompatibility: readonly AgentId[] };
  }): Promise<SkillReviewPanelRecord>;
  publishReview(input: SkillReviewPanelExactTarget & { reviewId: string; expectedReviewRevision: number }): Promise<unknown>;
  withdraw(input: SkillReviewPanelExactTarget & { reason: string; operationId: string }): Promise<unknown>;
}

export interface SkillReviewPanelProps { api: SkillReviewPanelApi; }

const EMPTY_DOCUMENT: SkillCandidateDocument = {
  kind: "skill",
  skill: {
    id: "", name: "", title: "", author: "", summary: "", category: "", tracks: ["general"], sourceUrl: "",
    recommendation: { basis: "editorial", reason: "", taskEvaluation: "not_tested", popularity: null },
    prerequisites: [], permissions: [],
    tutorial: { suitableFor: "", limitations: "", steps: [], examplePrompt: "", checkOutput: [], troubleshooting: [] },
    versions: [],
  },
};
const EMPTY_BUNDLE: SkillCandidateDocument = {
  kind: "bundle",
  bundle: { id: "", version: "", name: "", track: "general", outcome: "", skillVersionIds: [], optionalSkillVersionIds: [], compatibility: "not_live_tested", limitations: [], steps: [], status: "published" },
};
const EMPTY_EVIDENCE: SkillCandidateEvidence = {
  license: { status: "unknown", sourceUrl: null, sha256: null, checkedBy: null, checkedAt: null, noticesIncluded: false },
  behavior: { status: "unknown", checkedBy: null, checkedAt: null, note: "" },
  compatibility: [],
};
const LEVEL_LABELS = {
  unknown: "未知，待验证", installer_declared: "安装器声明", command_verified: "命令验证记录",
  file_install_verified: "文件安装验证记录", client_load_verified: "客户端加载验证记录",
  task_verified: "示例任务验证记录", failed: "失败记录",
};
const SOURCE_LABELS = { official_documentation: "官方文档", platform_test: "本站测试", user_reported: "用户自报", model: "模型陈述，不构成验证" };
const REVIEW_LABELS = { pending: "待审核", changes_requested: "要求补充", approved: "审核通过，待发布", rejected: "已拒绝", published: "已发布" };
const STATE_LABELS = { draft: "候选草稿", published: "已发布", withdrawn: "已撤回" };
const REVIEWED_AGENTS: readonly AgentId[] = ["codex", "claude-code", "cursor", "github-copilot", "gemini-cli", "opencode", "windsurf", "cline"];
const json = (value: unknown) => JSON.stringify(value, null, 2);
const keyOf = (target: SkillPublicationTarget) => JSON.stringify([target.kind, target.id, target.versionId]);
const targetOf = ({ kind, id, versionId }: SkillPublicationTarget): SkillPublicationTarget => ({ kind, id, versionId });
const exactOf = (snapshot: SkillReviewSnapshot): SkillReviewPanelExactTarget => ({ ...targetOf(snapshot), expectedRevision: snapshot.revision, expectedContentHash: snapshot.contentHash, expectedManifestHash: snapshot.manifestHash });
const sameSnapshot = (review: SkillReviewPanelRecord, snapshot: SkillReviewSnapshot) => keyOf(review) === keyOf(snapshot) && review.candidateRevision === snapshot.revision && review.contentHash === snapshot.contentHash && review.manifestHash === snapshot.manifestHash;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "操作未完成，请重新读取服务器记录后再尝试。";
}

function parseInput(documentText: string, evidenceText: string): { document: SkillCandidateDocument; evidence: SkillCandidateEvidence } {
  let document: unknown;
  let evidence: unknown;
  try { document = JSON.parse(documentText); } catch { throw new Error("候选内容不是有效 JSON，请检查括号、逗号和引号。"); }
  try { evidence = JSON.parse(evidenceText); } catch { throw new Error("审核证据不是有效 JSON，请检查括号、逗号和引号。"); }
  if (!document || typeof document !== "object" || !("kind" in document) || !["skill", "bundle"].includes(String(document.kind))) throw new Error("候选内容必须指定 kind 为 skill 或 bundle。");
  if (!evidence || typeof evidence !== "object" || !("license" in evidence) || !("behavior" in evidence) || !("compatibility" in evidence)) throw new Error("证据需要分别提供 license、behavior 和 compatibility。");
  // The server parses the full schema, fixed source allowlist and manifest again.
  return { document: document as SkillCandidateDocument, evidence: evidence as SkillCandidateEvidence };
}

export function SkillReviewPanel({ api }: SkillReviewPanelProps) {
  const formId = useId();
  const [candidates, setCandidates] = useState<readonly SkillCandidate[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [snapshot, setSnapshot] = useState<SkillReviewSnapshot | null>(null);
  const [reviews, setReviews] = useState<readonly SkillReviewPanelRecord[]>([]);
  const [reviewId, setReviewId] = useState("");
  const [documentText, setDocumentText] = useState(json(EMPTY_DOCUMENT));
  const [evidenceText, setEvidenceText] = useState(json(EMPTY_EVIDENCE));
  const [newCandidate, setNewCandidate] = useState(false);
  const [editBaseRevision, setEditBaseRevision] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [unknownAcknowledged, setUnknownAcknowledged] = useState(false);
  const [licenseChecked, setLicenseChecked] = useState(false);
  const [behaviorChecked, setBehaviorChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const apiGeneration = useRef(0);
  const mounted = useRef(true);
  const operationKeys = useRef(new Map<string, string>());

  const putEditor = useCallback((candidate: SkillCandidate) => {
    setDocumentText(json(candidate.document)); setEvidenceText(json(candidate.evidence));
    setEditBaseRevision(candidate.revision); setNewCandidate(false);
  }, []);

  const readDetail = useCallback(async (target: SkillPublicationTarget, replaceEditor: boolean) => {
    const request = ++generation.current;
    const [current, currentReviews] = await Promise.all([api.getSnapshot(target), api.listReviews(target)]);
    if (!mounted.current || request !== generation.current) return current;
    setSnapshot(current); setReviews(currentReviews); setUnknownAcknowledged(false); setLicenseChecked(false); setBehaviorChecked(false);
    setReviewId(previous => currentReviews.some(review => review.reviewId === previous) ? previous : (currentReviews.find(review => current && sameSnapshot(review, current))?.reviewId ?? currentReviews[0]?.reviewId ?? ""));
    if (replaceEditor && current) putEditor(current);
    return current;
  }, [api, putEditor]);

  const refresh = useCallback(async (target: SkillPublicationTarget | null, replaceEditor = false) => {
    const epoch = apiGeneration.current;
    const [items, current] = await Promise.all([api.listCandidates(), target ? readDetail(target, replaceEditor) : Promise.resolve(null)]);
    if (!mounted.current || epoch !== apiGeneration.current) return current;
    setCandidates(items);
    if (!target && items.length) setSelectedKey(keyOf(items[0]!));
    return current;
  }, [api, readDetail]);

  useEffect(() => {
    let cancelled = false;
    apiGeneration.current += 1;
    mounted.current = true;
    setLoading(true); setBusy(null); setError(""); setNotice(""); setSnapshot(null); setReviews([]); setSelectedKey("");
    setDocumentText(json(EMPTY_DOCUMENT)); setEvidenceText(json(EMPTY_EVIDENCE)); setNewCandidate(false); setEditBaseRevision(null); setReason("");
    operationKeys.current.clear();
    api.listCandidates().then(items => {
      if (cancelled || !mounted.current) return;
      setCandidates(items); setSelectedKey(items[0] ? keyOf(items[0]) : "");
    }).catch(problem => { if (!cancelled && mounted.current) setError(errorMessage(problem)); }).finally(() => { if (!cancelled && mounted.current) setLoading(false); });
    return () => { cancelled = true; mounted.current = false; generation.current += 1; apiGeneration.current += 1; };
  }, [api]);

  useEffect(() => {
    if (!selectedKey) { setSnapshot(null); setReviews([]); return; }
    let cancelled = false;
    const [kind, id, versionId] = JSON.parse(selectedKey) as [SkillPublicationTarget["kind"], string, string];
    setLoading(true); setSnapshot(null); setReviews([]); setReviewId(""); setReason(""); setUnknownAcknowledged(false); setLicenseChecked(false); setBehaviorChecked(false);
    readDetail({ kind, id, versionId }, true).catch(problem => { if (!cancelled && mounted.current) setError(errorMessage(problem)); }).finally(() => { if (!cancelled && mounted.current) setLoading(false); });
    return () => { cancelled = true; generation.current += 1; };
  }, [readDetail, selectedKey]);

  const review = reviews.find(item => item.reviewId === reviewId) ?? null;
  const exactReview = Boolean(snapshot && review && sameSnapshot(review, snapshot));
  const controlsDisabled = loading || busy !== null;
  const unknownAgents = snapshot ? REVIEWED_AGENTS.filter(agentId => !snapshot.evidence.compatibility.some(item => item.agentId === agentId && item.level === "task_verified" && item.source === "platform_test")) : [];
  const unknownCompatibility = unknownAgents.length > 0;
  const approvalReady = Boolean(snapshot && review && exactReview && licenseChecked && behaviorChecked && snapshot.validationErrors.length === 0 && snapshot.evidence.license.status === "verified" && snapshot.evidence.behavior.status === "reviewed" && (!unknownCompatibility || unknownAcknowledged));
  const currentVersion = snapshot?.document.kind === "skill" ? snapshot.document.skill.versions.find(version => version.id === snapshot.versionId) : null;
  const canDecide = Boolean(review && exactReview && ["pending", "changes_requested"].includes(review.status));
  const canPublish = Boolean(snapshot && review && exactReview && review.status === "approved" && snapshot.state === "draft" && snapshot.validationErrors.length === 0);
  const localVersionChanged = Boolean(snapshot && !newCandidate && editBaseRevision !== snapshot.revision);

  async function run(label: string, work: (isActive: () => boolean) => Promise<void>, success: string, target = snapshot ? targetOf(snapshot) : null) {
    if (controlsDisabled) return;
    const epoch = apiGeneration.current;
    const isActive = () => mounted.current && epoch === apiGeneration.current;
    setBusy(label); setError(""); setNotice("");
    try {
      await work(isActive);
      if (isActive()) setNotice(success);
    } catch (problem) {
      if (!isActive()) return;
      const message = errorMessage(problem);
      // Preserve local JSON and reason on every failure, including version conflicts.
      if (target) {
        try { await refresh(target); } catch { /* Keep the original failure and existing local input. */ }
      }
      if (isActive()) setError(`${message} 本地输入已保留。`);
    } finally { if (isActive()) setBusy(null); }
  }

  function operationId(exact: SkillReviewPanelExactTarget, reason: string): string {
    const key = json({ action: "withdraw", exact, reason });
    const existing = operationKeys.current.get(key);
    if (existing) return existing;
    const value = crypto.randomUUID(); operationKeys.current.set(key, value); return value;
  }

  function startNew(kind: "skill" | "bundle") {
    setDocumentText(json(kind === "skill" ? EMPTY_DOCUMENT : EMPTY_BUNDLE)); setEvidenceText(json(EMPTY_EVIDENCE));
    setNewCandidate(true); setEditBaseRevision(null); setError(""); setNotice("");
  }

  return <section className={styles.panel} aria-label="技能版本审核与发布" aria-busy={controlsDisabled}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>技能运营</p><h2>核对固定版本，再审核发布</h2><p className={styles.hint}>许可、行为和工具兼容分别记录。示例任务验证只适用于记录中的工具版本与系统。</p></div>
      <button type="button" className={styles.secondary} disabled={controlsDisabled} onClick={() => void run("刷新", async () => { await refresh(snapshot ? targetOf(snapshot) : null); }, "已重新读取服务器记录，本地输入保留。")}>刷新记录</button>
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {busy && <p className={styles.hint} role="status">正在{busy}…</p>}
    <div className={styles.layout}>
      <aside className={styles.card} aria-label="候选版本列表">
        <h3>候选版本</h3>
        <label className={styles.field}>选择精确版本<select value={selectedKey} disabled={controlsDisabled} onChange={event => { setError(""); setNotice(""); setSelectedKey(event.target.value); }}>
          <option value="">请选择版本</option>
          {candidates.map(candidate => <option key={keyOf(candidate)} value={keyOf(candidate)}>{candidate.kind === "skill" ? "技能" : "技能包"} · {candidate.id} · {candidate.versionId} · r{candidate.revision} · {STATE_LABELS[candidate.state]}</option>)}
        </select></label>
        {!loading && candidates.length === 0 && <p className={styles.hint}>暂无候选。录入固定版本清单和证据后交由服务端校验。</p>}
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={controlsDisabled} onClick={() => startNew("skill")}>新增技能候选</button><button type="button" className={styles.secondary} disabled={controlsDisabled} onClick={() => startNew("bundle")}>新增技能包候选</button></div>
        <p className={styles.hint}>此面板只保存结构化候选与审核记录，录入链接不会下载文件或执行脚本。</p>
      </aside>
      <div className={styles.main}>
        {!loading && selectedKey && !snapshot && <p className={styles.warning}>此版本暂时无法读取。请刷新服务器记录或选择其他候选；本地输入保留。</p>}
        {snapshot && <section className={styles.card} aria-label="当前服务器快照">
          <div className={styles.sectionTitle}><h3>{snapshot.kind === "skill" ? "技能" : "技能包"}服务器快照</h3><span className={styles.badge}>{STATE_LABELS[snapshot.state]}</span></div>
          <dl className={styles.facts}>
            <div><dt>条目 ID</dt><dd><code>{snapshot.id}</code></dd></div><div><dt>版本 ID</dt><dd><code>{snapshot.versionId}</code></dd></div><div><dt>内容修订</dt><dd>r{snapshot.revision}</dd></div>
            <div className={styles.wide}><dt>内容哈希</dt><dd><code>{snapshot.contentHash}</code></dd></div><div className={styles.wide}><dt>清单哈希</dt><dd><code>{snapshot.manifestHash}</code></dd></div>
            <div><dt>最近记录人</dt><dd>{snapshot.recordedBy}</dd></div><div><dt>记录时间</dt><dd>{snapshot.recordedAt}</dd></div>
          </dl>
          {snapshot.validationErrors.length > 0 && <div className={styles.warning}><strong>服务端校验尚有缺项</strong><ul>{snapshot.validationErrors.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
          <div className={styles.evidenceGrid}>
            <div className={styles.evidenceBox}><h4>许可核验：{snapshot.evidence.license.status === "verified" ? "有核验记录" : "未知"}</h4><p>必要声明：{snapshot.evidence.license.noticesIncluded ? "记录为已包含" : "未确认包含"}</p><p>核验人 / 日期：{snapshot.evidence.license.checkedBy ?? "未知"} / {snapshot.evidence.license.checkedAt ?? "未知"}</p><p className={styles.breakText}>来源：{snapshot.evidence.license.sourceUrl ?? "未提供"}</p><p className={styles.breakText}>许可哈希：<code>{snapshot.evidence.license.sha256 ?? "未提供"}</code></p></div>
            <div className={styles.evidenceBox}><h4>行为核验：{snapshot.evidence.behavior.status === "reviewed" ? "有审核记录" : "未知"}</h4><p>审核人 / 日期：{snapshot.evidence.behavior.checkedBy ?? "未知"} / {snapshot.evidence.behavior.checkedAt ?? "未知"}</p><p>{snapshot.evidence.behavior.note || "尚无行为说明"}</p></div>
          </div>
          <h4>兼容证据</h4>
          {snapshot.evidence.compatibility.length === 0 ? <p className={styles.warning}>尚无兼容证据。各工具的安装、加载与示例任务结果均待验证。</p> : <div className={styles.tableScroll}><table><caption className={styles.srOnly}>当前固定版本各工具兼容证据</caption><thead><tr><th>工具与阶段</th><th>证据来源</th><th>工具版本 / 系统 / 日期</th><th>任务与限制</th></tr></thead><tbody>{snapshot.evidence.compatibility.map((item, index) => <tr key={`${item.agentId}-${index}`}><td>{item.agentId}<br/><span className={styles.badge}>{LEVEL_LABELS[item.level]}</span></td><td>{SOURCE_LABELS[item.source]}<p className={styles.breakText}>{item.evidenceUrl ?? "未提供证据地址"}</p></td><td>{item.clientVersion ?? "版本未知"}<br/>{item.os ?? "系统未知"}<br/>{item.checkedAt ?? "日期未知"}</td><td>{item.task ?? "未记录示例任务"}<p>{item.limitation || "未补充限制"}</p>{item.requiredVersionIds && <p className={styles.breakText}>共同验证必需版本：{item.requiredVersionIds.join("、") || "未列出"}</p>}</td></tr>)}</tbody></table></div>}
          {currentVersion && <details className={styles.details}><summary>固定来源与文件清单（{currentVersion.files.length} 个文件）</summary><dl className={styles.facts}><div><dt>仓库</dt><dd>{currentVersion.repository}</dd></div><div><dt>子目录</dt><dd>{currentVersion.skillPath}</dd></div><div className={styles.wide}><dt>完整 commit</dt><dd><code>{currentVersion.commit}</code></dd></div><div><dt>许可声明</dt><dd>{currentVersion.license.spdx}</dd></div></dl><div className={styles.tableScroll}><table><thead><tr><th>相对路径 / 仓库路径</th><th>字节</th><th>SHA-256 / 固定来源</th></tr></thead><tbody>{currentVersion.files.map(file => <tr key={file.relativePath}><td>{file.relativePath}<p>{file.repositoryPath}</p></td><td>{file.bytes}</td><td className={styles.breakText}><code>{file.sha256}</code><p>{file.downloadUrl}</p></td></tr>)}</tbody></table></div></details>}
          {snapshot.document.kind === "bundle" && <details className={styles.details}><summary>技能包固定引用</summary><p>必需版本：{snapshot.document.bundle.skillVersionIds.join("、") || "未提供"}</p><p>可选版本：{snapshot.document.bundle.optionalSkillVersionIds.join("、") || "无"}</p><p>整包共同环境验证须覆盖所有必需版本，单项记录不能合并为整包通过。</p></details>}
        </section>}

        <section className={styles.card} aria-label="候选内容编辑">
          <div className={styles.sectionTitle}><h3>{newCandidate ? "新增候选" : "编辑候选内容与证据"}</h3>{snapshot && <button type="button" className={styles.secondary} disabled={controlsDisabled} onClick={() => { putEditor(snapshot); setNotice("已将服务器快照载入编辑框。"); }}>载入服务器内容</button>}</div>
          <p className={styles.hint}>内容 JSON 必须含精确技能版本或技能包版本；证据 JSON 分别填写许可、行为与兼容阶段。许可未知或模型陈述不能冒充验证。</p>
          {!newCandidate && snapshot && snapshot.state !== "draft" && <p className={styles.warning}>已发布或撤回的固定版本不可覆盖。可以以此内容起草新候选，再明确更新完整 commit、文件清单或包版本；许可与行为证据需重新核对。</p>}
          {snapshot && <button type="button" className={styles.secondary} disabled={controlsDisabled} onClick={() => { setDocumentText(json(snapshot.document)); setEvidenceText(json(EMPTY_EVIDENCE)); setNewCandidate(true); setEditBaseRevision(null); setNotice("已用当前内容起草新候选。请改为新固定版本，核对清单与证据后保存。"); }}>以当前内容起草新版本</button>}
          {!newCandidate && editBaseRevision !== null && <p className={styles.hint}>本地编辑基于 r{editBaseRevision}。{localVersionChanged ? "服务器版本已变化；输入保留，请核对并重新载入后编辑。" : "保存时服务端再次核对版本。"}</p>}
          <label className={styles.field} htmlFor={`${formId}-document`}>候选内容 JSON<textarea id={`${formId}-document`} className={styles.jsonInput} rows={14} spellCheck={false} value={documentText} disabled={controlsDisabled} onChange={event => setDocumentText(event.target.value)} /></label>
          <label className={styles.field} htmlFor={`${formId}-evidence`}>审核证据 JSON<textarea id={`${formId}-evidence`} className={styles.jsonInput} rows={10} spellCheck={false} value={evidenceText} disabled={controlsDisabled} onChange={event => setEvidenceText(event.target.value)} /></label>
          <button type="button" className={styles.primary} disabled={controlsDisabled || (!newCandidate && (!snapshot || snapshot.state !== "draft" || localVersionChanged || editBaseRevision === null))} onClick={() => void run("保存候选", async isActive => {
            const input = parseInput(documentText, evidenceText);
            const saved = newCandidate ? await api.createCandidate(input) : await api.updateCandidate({ ...targetOf(snapshot!), expectedRevision: editBaseRevision!, ...input });
            if (!isActive()) return;
            putEditor(saved); setSelectedKey(keyOf(saved)); await refresh(targetOf(saved), true);
          }, "候选已由服务器保存；审核与发布仍需分别完成。")}>{newCandidate ? "创建候选并校验" : "保存候选并校验"}</button>
        </section>

        {snapshot && <section className={styles.card} aria-label="审核决定与发布">
          <div className={styles.sectionTitle}><h3>审核与发布</h3><button type="button" className={styles.secondary} disabled={controlsDisabled || snapshot.state !== "draft"} onClick={() => void run("登记审核", async isActive => { const registered = await api.registerReview(exactOf(snapshot)); if (!isActive()) return; setReviewId(registered.reviewId); await refresh(targetOf(snapshot)); }, "已登记当前精确版本的审核。")}>登记当前快照审核</button></div>
          <label className={styles.field}>审核记录<select value={reviewId} disabled={controlsDisabled} onChange={event => { setReviewId(event.target.value); setUnknownAcknowledged(false); setLicenseChecked(false); setBehaviorChecked(false); setReason(""); }}><option value="">请选择审核记录</option>{reviews.map(item => <option key={item.reviewId} value={item.reviewId}>{item.reviewId} · 候选 r{item.candidateRevision} · 审核 r{item.revision} · {REVIEW_LABELS[item.status]}</option>)}</select></label>
          {review && <><p>状态：{REVIEW_LABELS[review.status]} · 审核修订 r{review.revision}</p><p className={styles.hint}>审核人 / 日期：{review.reviewedBy ?? "尚未审核"} / {review.reviewedAt ?? "尚未审核"}</p><p className={styles.breakText}>审核内容哈希：<code>{review.contentHash}</code><br/>审核清单哈希：<code>{review.manifestHash}</code></p>{review.reason && <p>已有审核说明：{review.reason}</p>}{!exactReview && <p className={styles.warning}>此审核对应旧内容修订或不同哈希，不能用于当前版本的决定或发布。请登记当前快照审核。</p>}</>}
          <label className={styles.field} htmlFor={`${formId}-reason`}>审核 / 撤回说明<textarea id={`${formId}-reason`} rows={3} maxLength={1000} value={reason} disabled={controlsDisabled} onChange={event => setReason(event.target.value)} placeholder="说明所核对的证据、需补充内容或撤回原因" /></label>
          <div className={styles.checks}>
            <label className={styles.checkbox}><input type="checkbox" checked={licenseChecked} disabled={controlsDisabled} onChange={event => setLicenseChecked(event.target.checked)} /><span>我已核对许可来源、哈希及必要声明。</span></label>
            <label className={styles.checkbox}><input type="checkbox" checked={behaviorChecked} disabled={controlsDisabled} onChange={event => setBehaviorChecked(event.target.checked)} /><span>我已审阅此固定版本的文件行为、权限和依赖说明。</span></label>
            {unknownCompatibility && <label className={styles.checkbox}><input type="checkbox" checked={unknownAcknowledged} disabled={controlsDisabled} onChange={event => setUnknownAcknowledged(event.target.checked)} /><span>我已核对以下工具的本站示例任务验证缺项：{unknownAgents.join("、")}。批准仅发布当前证据说明；未知的工具、环境和阶段继续显示待验证，不作为已验证安装包。</span></label>}
          </div>
          <div className={styles.actions}>
            {(["approved", "changes_requested", "rejected"] as const).map(decision => <button key={decision} type="button" className={decision === "approved" ? styles.primary : styles.secondary} disabled={controlsDisabled || !canDecide || !reason.trim() || (decision === "approved" && !approvalReady)} onClick={() => void run("保存审核决定", async isActive => { await api.decideReview({ ...exactOf(snapshot), reviewId: review!.reviewId, expectedReviewRevision: review!.revision, decision, reason: reason.trim(), ...(decision === "approved" ? { verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: unknownAgents } } : {}) }); if (isActive()) await refresh(targetOf(snapshot)); }, "审核决定已由服务器保存。")}>{decision === "approved" ? "审核通过" : decision === "changes_requested" ? "要求补充" : "拒绝"}</button>)}
            <button type="button" className={styles.primary} disabled={controlsDisabled || !canPublish} onClick={() => void run("发布", async isActive => { const exact = exactOf(snapshot); await api.publishReview({ ...exact, reviewId: review!.reviewId, expectedReviewRevision: review!.revision }); if (isActive()) await refresh(targetOf(snapshot)); }, "服务器已发布此固定版本。兼容证据仍按已记录环境展示。")}>发布已批准的精确版本</button>
          </div>
          <p className={styles.hint}>审核通过后另行发布；服务器在同一事务复核权限、当前 revision、内容哈希、清单哈希与审核记录。</p>
          <div className={styles.withdraw}><p>撤回停止此版本的新发布或受控安装，保留历史引用与审核记录。</p><button type="button" className={styles.danger} disabled={controlsDisabled || snapshot.state !== "published" || !reason.trim()} onClick={() => void run("撤回", async isActive => { const exact = exactOf(snapshot); await api.withdraw({ ...exact, reason: reason.trim(), operationId: operationId(exact, reason.trim()) }); if (isActive()) await refresh(targetOf(snapshot)); }, "服务器已撤回此固定版本，历史记录保留。")}>按当前精确快照撤回</button></div>
        </section>}
      </div>
    </div>
  </section>;
}
