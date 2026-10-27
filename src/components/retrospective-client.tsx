"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Retrospective, RetrospectiveContent, Scope } from "../modules/retrospectives/domain.ts";
import type { DocumentView } from "../modules/retrospectives/service.ts";
import type { EditDraftSaveResult, RetrospectiveEditDraft } from "../modules/retrospectives/edit-drafts.ts";
import { createAutosaveController } from "../modules/retrospectives/autosave-controller.ts";
import type { AutosaveController, AutosaveSnapshot } from "../modules/retrospectives/autosave-controller.ts";
import { RetrospectiveEditor, SkillUsageDetails } from "../modules/retrospectives/client.ts";
import type { RetrospectiveEditorProps } from "../modules/retrospectives/client.ts";
import { ApiError, api, dateText, message, useApi } from "./client-api.ts";
import { Empty, Feedback, Loading } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import { RetrospectiveAi } from "./retrospective-ai.tsx";
import { RetrospectiveReferences } from "./evidence-tools.tsx";
import styles from "./site.module.css";

const blankContent: RetrospectiveContent = { answers: { goalAndOutcome: "", blockerAndResponse: "", helpfulPractice: "", scopeReduction: "", nextChange: "" }, evidenceRefs: [], tools: [] };
const retrospectiveStatus = { draft: "草稿", generating: "正在整理", review_required: "待复核", confirmed: "已确认" };
const answerLabels = { goalAndOutcome: "计划与实际交付", blockerAndResponse: "阻塞与处理", helpfulPractice: "有效做法", scopeReduction: "范围删减", nextChange: "下次改变" };
interface PrivatePayload { requestedScope: Scope; draftContent: RetrospectiveContent; baseDocumentRevision: number }
const fromDraft = (draft: RetrospectiveEditDraft): PrivatePayload => ({ requestedScope: draft.requestedScope, draftContent: structuredClone(draft.draftContent), baseDocumentRevision: draft.baseDocumentRevision });
const fromOfficial = (props: RetrospectiveEditorProps): PrivatePayload => ({ requestedScope: props.initialScope, draftContent: structuredClone(props.initialContent), baseDocumentRevision: props.expectedRevision });
const editorInput = (payload: PrivatePayload) => ({ content: structuredClone(payload.draftContent), scope: payload.requestedScope });

function DraftComparison({ title, payload }: { title: string; payload: PrivatePayload }) {
  return <details><summary className={styles.summary}>{title}</summary><p className={styles.muted}>正式复盘基线：{payload.baseDocumentRevision} · 分享意图：{payload.requestedScope === "personal" ? "仅本人" : "本项目"}</p><dl className={styles.facts}>{(Object.keys(answerLabels) as (keyof typeof answerLabels)[]).map(key => <div key={key}><dt>{answerLabels[key]}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{payload.draftContent.answers[key] || "尚未填写"}</dd></div>)}</dl><p className={styles.muted}>证据引用 {payload.draftContent.evidenceRefs.length} 条 · 工具经历 {payload.draftContent.tools.length} 条</p><SkillUsageDetails value={payload.draftContent.skillUsage}/></details>;
}

/** A personal editing buffer, separate from the explicit official save and confirmation actions. */
function PrivateDraftEditor({ projectId, userId, editorProps }: { projectId: string; userId: string; editorProps: RetrospectiveEditorProps }) {
  const documentId = editorProps.documentId.startsWith("new:") ? null : editorProps.documentId;
  const path = `/projects/${encodeURIComponent(projectId)}/retrospective-edit-draft${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ""}`;
  const context = useRef(editorProps); context.current = editorProps;
  const controller = useRef<AutosaveController<PrivatePayload> | null>(null);
  const alive = useRef(false), accessLostRef = useRef(false), paused = useRef(false), readGeneration = useRef(0);
  const input = useRef<PrivatePayload>(fromOfficial(editorProps));
  const acceptedOfficialRevision = useRef(editorProps.expectedRevision);
  const [ready, setReady] = useState(false), [reading, setReading] = useState(true), [readError, setReadError] = useState("");
  const [snapshot, setSnapshot] = useState<AutosaveSnapshot<PrivatePayload> | null>(null);
  const [localBase, setLocalBase] = useState(editorProps.expectedRevision), [accessLost, setAccessLost] = useState(false);
  const [restored, setRestored] = useState<ReturnType<typeof editorInput> | undefined>(undefined), [restoreKey, setRestoreKey] = useState(0);
  const [savedDraft, setSavedDraft] = useState<RetrospectiveEditDraft | null>(null);
  const [comparison, setComparison] = useState<{ draft: RetrospectiveEditDraft | null } | null>(null);
  const baseMismatch = (snapshot?.payload.baseDocumentRevision ?? localBase) !== editorProps.expectedRevision;
  const writable = Boolean(editorProps.canEdit) && !accessLost;
  const writableRef = useRef(writable); writableRef.current = writable;

  function stopIfForbidden(reason: unknown) {
    if (reason instanceof ApiError && ([401, 403].includes(reason.status) || reason.code === "PROJECT_ARCHIVED")) {
      accessLostRef.current = true; setAccessLost(true); controller.current?.setEnabled(false);
    }
  }
  function install(initial: PrivatePayload, revision: number, enabled: boolean) {
    controller.current?.dispose();
    let next: AutosaveController<PrivatePayload>;
    next = createAutosaveController({ initial, revision, enabled,
      async save(mutation) {
        const result = await api<EditDraftSaveResult>(path, { method: "PUT", body: { documentId, expectedRevision: mutation.expectedRevision, mutationId: mutation.mutationId, ...mutation.content } });
        if (result.draft.ownerId !== userId || result.draft.projectId !== projectId || result.draft.documentId !== documentId || result.draft.visibility !== "personal") throw new ApiError("保存结果的归属待核对，当前输入仍保留。", 502, "INVALID_RESPONSE");
        if (result.acceptedRevision !== result.draft.revision) throw new ApiError("原保存请求已有回执，但本人草稿随后又有更新。请读取最新草稿并对照。", 409, "VERSION_CONFLICT");
        if (alive.current && controller.current === next) setSavedDraft(result.draft);
        return { revision: result.acceptedRevision, content: fromDraft(result.draft) };
      },
      onChange(state) {
        if (!alive.current || controller.current !== next) return;
        input.current = state.payload; setLocalBase(state.payload.baseDocumentRevision); setSnapshot(state);
        if (state.error && ([401, 403].includes(state.error.status ?? 0) || ["FORBIDDEN", "PROJECT_ARCHIVED"].includes(state.error.code ?? ""))) {
          accessLostRef.current = true; setAccessLost(true);
          if (state.enabled) next.setEnabled(false);
        }
      },
    });
    controller.current = next; input.current = structuredClone(initial); setLocalBase(initial.baseDocumentRevision); setSnapshot(next.snapshot());
    return next;
  }

  useEffect(() => {
    alive.current = true;
    const generation = ++readGeneration.current;
    void api<RetrospectiveEditDraft | null>(path).then(draft => {
      if (!alive.current || readGeneration.current !== generation) return;
      const initial = draft ? fromDraft(draft) : fromOfficial(context.current);
      setSavedDraft(draft); setRestored(editorInput(initial));
      install(initial, draft?.revision ?? 0, !accessLostRef.current && Boolean(context.current.canEdit) && initial.baseDocumentRevision === context.current.expectedRevision);
      setReadError(""); setReady(true); setReading(false);
    }).catch(reason => {
      if (!alive.current || readGeneration.current !== generation) return;
      stopIfForbidden(reason); setReadError(message(reason)); setReady(true); setReading(false);
    });
    const stopped = () => {
      accessLostRef.current = true; readGeneration.current++; setAccessLost(true); controller.current?.setEnabled(false);
      setReady(true); setReading(false); setReadError("登录已失效，已停止读取和自动保存。请重新登录；当前输入仍保留。");
    };
    window.addEventListener("hackathon:unauthenticated", stopped);
    return () => { alive.current = false; readGeneration.current++; controller.current?.dispose(); window.removeEventListener("hackathon:unauthenticated", stopped); };
  }, [path]);

  // A new official revision is never silently used as the base of older private edits.
  useEffect(() => {
    const current = controller.current;
    if (!current) return;
    current.setEnabled(writable && !paused.current && !comparison && current.snapshot().payload.baseDocumentRevision === editorProps.expectedRevision);
  }, [writable, editorProps.expectedRevision, snapshot?.payload.baseDocumentRevision, comparison]);

  const onDraftChange = useCallback((value: { content: RetrospectiveContent; scope: Scope }) => {
    const next = { ...input.current, requestedScope: value.scope, draftContent: structuredClone(value.content) };
    input.current = next; controller.current?.edit(next);
  }, []);

  async function readLatest() {
    if (reading) return;
    const generation = ++readGeneration.current;
    paused.current = true; controller.current?.setEnabled(false); setReading(true); setReadError("");
    try {
      const draft = await api<RetrospectiveEditDraft | null>(path);
      if (documentId && context.current.onLoadLatest && !accessLostRef.current) await context.current.onLoadLatest();
      if (!alive.current || readGeneration.current !== generation) return;
      setComparison({ draft });
    } catch (reason) {
      if (!alive.current || readGeneration.current !== generation) return;
      stopIfForbidden(reason); setReadError(message(reason));
    } finally { if (alive.current && readGeneration.current === generation) setReading(false); }
  }

  function chooseDraft(mode: "adopt" | "rebase") {
    if (!comparison || reading) return;
    const latest = comparison.draft ? fromDraft(comparison.draft) : fromOfficial(context.current);
    const mine = structuredClone(input.current);
    // The comparison includes current official text; rebase is an explicit choice.
    if (mode === "rebase") mine.baseDocumentRevision = context.current.expectedRevision;
    paused.current = false;
    const current = install(latest, comparison.draft?.revision ?? 0, writableRef.current && !accessLostRef.current && (mode === "rebase" ? mine : latest).baseDocumentRevision === context.current.expectedRevision);
    if (mode === "rebase") current.edit(mine);
    else { setRestored(editorInput(latest)); setRestoreKey(value => value + 1); }
    setSavedDraft(comparison.draft); setComparison(null); setReadError("");
  }

  function acceptOfficial(revision: number, mode: "adopt" | "rebase") {
    if (revision !== context.current.expectedRevision || !writableRef.current || accessLostRef.current) return;
    acceptedOfficialRevision.current = revision;
    const prior = structuredClone(input.current);
    const next = mode === "adopt" ? fromOfficial(context.current) : { ...prior, baseDocumentRevision: revision };
    input.current = next; setLocalBase(revision);
    const current = controller.current;
    if (current?.snapshot().error?.code === "DOCUMENT_CHANGED") {
      const replacement = install(prior, current.snapshot().revision, true); replacement.edit(next);
    } else { current?.edit(next); if (!comparison && !paused.current) current?.setEnabled(true); }
    if (mode === "adopt") { setRestored(editorInput(next)); setRestoreKey(value => value + 1); }
  }

  async function saveOfficial(value: Parameters<RetrospectiveEditorProps["onSave"]>[0]) {
    if (input.current.baseDocumentRevision !== value.expectedRevision) throw new ApiError("正式复盘已更新，请先对照当前正文与本人输入。", 409, "DOCUMENT_CHANGED");
    paused.current = true;
    const current = controller.current;
    // Wait for an already running write; failures retain their receipt for explicit recovery.
    await current?.flush(); current?.setEnabled(false);
    try {
      const result = await context.current.onSave(value);
      if (alive.current) {
        acceptedOfficialRevision.current = result.revision;
        const next = { requestedScope: value.scope, draftContent: structuredClone(value.content), baseDocumentRevision: result.revision };
        input.current = next; setLocalBase(result.revision); current?.edit(next);
      }
      return result;
    } catch (reason) { if (alive.current) stopIfForbidden(reason); throw reason; }
    finally {
      paused.current = false;
      if (alive.current && current === controller.current) current?.setEnabled(writableRef.current && !accessLostRef.current && input.current.baseDocumentRevision === context.current.expectedRevision && !comparison);
    }
  }

  async function confirmOfficial(value: Parameters<RetrospectiveEditorProps["onConfirm"]>[0]) {
    paused.current = true; const current = controller.current;
    await current?.flush(); current?.setEnabled(false);
    try {
      const result = await context.current.onConfirm(value);
      const resultRevision = result && typeof result === "object" && "revision" in result ? result.revision : undefined;
      if (alive.current && typeof resultRevision === "number" && Number.isSafeInteger(resultRevision) && resultRevision > value.expectedRevision) {
        acceptedOfficialRevision.current = resultRevision;
        const next = { ...input.current, baseDocumentRevision: resultRevision };
        input.current = next; setLocalBase(resultRevision); current?.edit(next);
      }
      return result;
    } catch (reason) { if (alive.current) stopIfForbidden(reason); throw reason; }
    finally {
      paused.current = false;
      if (alive.current && current === controller.current) current?.setEnabled(writableRef.current && !accessLostRef.current && input.current.baseDocumentRevision === context.current.expectedRevision && !comparison);
    }
  }

  const statusLabel = !controller.current ? "自动保存暂不可用" : {
    idle: savedDraft ? "已载入本人草稿" : "尚未修改", dirty: "等待自动保存…", saving: "正在保存本人草稿…", saved: "本人草稿已自动保存", conflict: "草稿有版本冲突", failed: "本人草稿保存失败", stopped: "已暂停自动保存",
  }[snapshot?.status ?? "idle"];
  const draftConflict = snapshot?.status === "conflict" || snapshot?.error?.status === 409;
  if (!ready) return <section className={styles.panel}><Loading/><p className={styles.muted}>正在读取此账号的本人编辑草稿…</p></section>;
  return <><section className={styles.panel} aria-label="本人编辑草稿">
    <div className={styles.titleRow}><h2>本人编辑草稿</h2><span className={styles.tag} role="status" aria-live="polite">{statusLabel}{snapshot?.revision ? ` · 版本 ${snapshot.revision}` : ""}</span></div>
    <p className={styles.muted}>输入停下后自动保存到本人账号。选择“本项目”只是分享意图；只有下方“正式保存复盘草稿”才会更新正文和分享范围，确认或 AI 整理仍需明确操作。</p>
    {savedDraft && <p className={styles.muted}>最近保存：{dateText(savedDraft.updatedAt)}</p>}
    {readError && <p className={styles.error} role="alert">读取本人草稿失败：{readError} 当前输入保留。{!baseMismatch && !draftConflict && writable ? "可继续人工填写和正式保存；" : "可从我的经验处理已有本人数据；"}自动保存需重新读取后恢复。</p>}
    {snapshot?.error && <p className={styles.error} role="alert">{snapshot.error.message} 当前输入仍保留。</p>}
    {(!writable || snapshot?.status === "stopped" && accessLost) && <p className={styles.notice}>当前项目已停止新的草稿写入。已有本人数据可在<a className={styles.link} href="/app/experience">我的经验</a>中查看、导出和删除。</p>}
    {baseMismatch && <aside className={styles.warning} aria-label="正式复盘基线变化"><p><strong>本人草稿基于正式版本 {snapshot?.payload.baseDocumentRevision ?? localBase}，当前正式版本为 {editorProps.expectedRevision}。</strong> 自动保存和正式保存已暂停，先对照再决定。</p><DraftComparison title="对照当前正式正文" payload={fromOfficial(editorProps)}/>{acceptedOfficialRevision.current === editorProps.expectedRevision ? <div className={styles.actions}><button className={styles.secondary} type="button" disabled={!writable || reading || snapshot?.status === "saving"} onClick={() => acceptOfficial(editorProps.expectedRevision, "rebase")}>已对照，保留本人输入继续编辑</button><button className={styles.secondary} type="button" disabled={!writable || reading || snapshot?.status === "saving"} onClick={() => acceptOfficial(editorProps.expectedRevision, "adopt")}>采用当前正式正文</button></div> : <p className={styles.muted}>请在下方复盘表的最新版本对照中选择“保留我的编辑”或“载入最新”。</p>}</aside>}
    {comparison && <aside className={styles.warning} aria-label="本人草稿版本对照"><p><strong>{comparison.draft ? `已读取最新本人草稿，版本 ${comparison.draft.revision}。` : "已保存的本人草稿不存在或已被删除。"}</strong> 当前输入保留，请选择如何继续。</p><DraftComparison title="查看当前本人输入" payload={input.current}/>{comparison.draft && <DraftComparison title="查看最新保存的本人草稿" payload={fromDraft(comparison.draft)}/>}<DraftComparison title="查看当前正式正文" payload={fromOfficial(editorProps)}/><div className={styles.actions}><button className={styles.secondary} type="button" disabled={reading} onClick={() => chooseDraft("adopt")}>{comparison.draft ? "采用最新本人草稿" : "采用当前正式正文"}</button><button className={styles.secondary} type="button" disabled={!writable || reading} onClick={() => chooseDraft("rebase")}>{comparison.draft ? "已对照，保留本人输入再保存" : "保留本人输入，新建编辑草稿"}</button></div></aside>}
    <div className={styles.actions}>{snapshot?.status === "failed" && writable && !baseMismatch && <button className={styles.secondary} type="button" onClick={() => void controller.current?.retry()}>重试保存本人草稿</button>}{(readError || draftConflict || snapshot?.status === "failed" || comparison) && <button className={styles.secondary} type="button" disabled={reading || snapshot?.status === "saving"} onClick={() => void readLatest()}>{reading ? "正在读取…" : "读取最新本人草稿并对照"}</button>}<a className={styles.link} href="/app/experience">查看、导出或删除已有本人草稿 →</a></div>
  </section><RetrospectiveEditor {...editorProps} canEdit={writable} canSave={!baseMismatch && !comparison && !reading && !draftConflict} preserveDraftOnRemoteChange restoredDraft={restored} restoredDraftKey={restoreKey} onDraftChange={onDraftChange} onAcceptOfficialRevision={acceptOfficial} onSave={saveOfficial} onConfirm={confirmOfficial}/></>;
}

export function RetrospectivePanel({ detail }: { detail: ProjectDetail }) {
  const list = useApi<{ items: DocumentView<Retrospective>[]; nextCursor: string | null }>(`/projects/${detail.project.id}/retrospectives`);
  const [selected, setSelected] = useState<DocumentView<Retrospective> | null>(null); const [creating, setCreating] = useState(false); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const readonly = detail.project.stage === "archived" || detail.membership.status !== "active";
  async function select(id: string) { setLoading(true); setError(""); setSelected(null); setCreating(false); try { setSelected(await api<DocumentView<Retrospective>>(`/retrospectives/${id}`)); } catch (reason) { setError(message(reason)); } finally { setLoading(false); } }
  const document = selected?.document;
  const own = !document || document.ownerId === detail.membership.userId;
  const canEdit = !readonly && (own || detail.membership.role === "manager");
  const canConfirm = Boolean(document) && canEdit && (document?.scope === "personal" ? own : detail.membership.role === "manager");
  const editorProps: RetrospectiveEditorProps = {
    documentId: document?.id ?? `new:${detail.project.id}`, initialContent: document?.content ?? blankContent, initialScope: document?.scope ?? "personal", expectedRevision: document?.revision ?? 0, status: document?.status ?? "draft", canEdit, canChangeScope: own && !readonly, canConfirm, confirmationUnavailableReason: creating ? "请先正式保存复盘草稿，才能确认。" : "项目范围复盘需由当前项目管理员确认。",
    onSave: async value => {
      if (!document) { const saved = await api<Retrospective>(`/projects/${detail.project.id}/retrospectives`, { method: "POST", body: { scope: value.scope, content: value.content } }); setSelected(await api<DocumentView<Retrospective>>(`/retrospectives/${saved.id}`)); setCreating(false); await list.reload(); return { revision: saved.revision }; }
      const saved = await api<DocumentView<Retrospective>>(`/retrospectives/${document.id}`, { method: "PATCH", body: value }); setSelected(saved); await list.reload(); return { revision: saved.revision };
    },
    onConfirm: async value => { if (!document) throw new Error("请先正式保存复盘草稿。"); const confirmed = await api<Retrospective>(`/retrospectives/${document.id}/confirm`, { method: "POST", body: value }); setSelected(await api<DocumentView<Retrospective>>(`/retrospectives/${document.id}`)); await list.reload(); return { revision: confirmed.revision }; },
    onLoadLatest: document ? async () => { const latest = await api<DocumentView<Retrospective>>(`/retrospectives/${document.id}`); if (!latest.document) throw new Error("正式正文的依据暂不可访问。当前本人输入仍保留，可在我的经验处理已有草稿。"); setSelected(latest); await list.reload(); } : undefined,
  };
  return <><p className={styles.notice}>先用五个问题记录真实经历，再正式保存并确认。个人笔记默认仅本人可见；正式保存为项目范围后，当前项目成员可以查看。无需 AI，也能完整使用人工复盘。</p><Feedback error={error}/><Feedback error={list.error}/>{list.loading && <Loading/>}
    <section className={styles.panel}><div className={styles.titleRow}><h2>已有复盘</h2><button className={styles.secondary} disabled={readonly || loading} onClick={() => { setSelected(null); setCreating(true); setError(""); }}>新建本人复盘</button></div>{list.data?.items.length === 0 && <Empty>还没有复盘。把目标、阻塞、有效做法和下次变化留下来。</Empty>}<ul className={styles.list}>{list.data?.items.map(item => <li key={item.id}><button className={styles.secondary} disabled={loading} onClick={() => void select(item.id)}>{retrospectiveStatus[item.status]} · {item.scope === "personal" ? "仅本人" : "本项目"} · 版本 {item.revision}</button>{item.document && <p className={styles.muted}>{dateText(item.document.updatedAt)}</p>}{item.needsReview && <p className={styles.notice}>引用或资源已经变化，需重新核对。</p>}</li>)}</ul></section>
    {loading && <Loading/>}{selected && !document && <p className={styles.notice}>这份记录的依据已撤回或不可访问，正文暂时不可展示。请核对引用状态后重新获取。<a className={styles.link} href="/app/experience">处理已有本人数据 →</a></p>}
    {(creating || document) && (own ? <PrivateDraftEditor key={`${detail.project.id}:${detail.membership.userId}:${document?.id ?? "new"}`} projectId={detail.project.id} userId={detail.membership.userId} editorProps={editorProps}/> : <RetrospectiveEditor {...editorProps}/>)}
    {document && <RetrospectiveReferences key={`${document.id}:${document.revision}`} document={document} canEdit={canEdit} reload={async()=>{setSelected(await api<DocumentView<Retrospective>>(`/retrospectives/${document.id}`));await list.reload();}}/>}
    {document && <RetrospectiveAi document={document} canEdit={canEdit} canConfirm={canConfirm} reload={async () => { setSelected(await api<DocumentView<Retrospective>>(`/retrospectives/${document.id}`)); await list.reload(); }}/>}
  </>;
}
