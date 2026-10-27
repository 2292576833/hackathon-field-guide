"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, dateText, message, useApi } from "./client-api.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import type { SpaceDocument } from "../server/space-documents.ts";
import { DraftProtection, type DraftProtectionView, type ProtectedDraftEntry, type DocumentDraftCollection, type DocumentDraft, type DraftPublication, type DraftPublicationOutcome } from "../modules/document-drafts/client.ts";
import styles from "./space-documents.module.css";

function PlainTextEditor({ id, label, value, onChange, readOnly = false }: {
  id: string; label: string; value: string; onChange: (value: string) => void; readOnly?: boolean;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "0px";
      element.style.height = `${Math.max(180, element.scrollHeight)}px`;
    };
    fit();
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth; fit();
    });
    observer?.observe(element);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [value]);
  return <textarea ref={editor} className={styles.editor} id={id} aria-label={label} value={value}
    onChange={event => onChange(event.target.value)} readOnly={readOnly} maxLength={20000} wrap="soft"/>;
}

function DocumentMenu({ label = "文档更多操作", children }: { label?: string; children: ReactNode }) {
  return <details className={styles.menu} data-space-document-menu data-canvas-options
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
    onClick={event => {
      if (!(event.target instanceof Element) || !event.target.closest("button")) return;
      event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
    }}
    onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
    <summary aria-label={label} title={label}>⋯</summary>
    <div className={styles.menuContents}>{children}</div>
  </details>;
}

/** Identity changes remount synchronously, so no old-account input can flash. */
export function SpaceDocumentsPanel({ detail }: { detail: ProjectDetail }) {
  return <OwnedDocumentsPanel key={`${detail.membership.userId}:${detail.project.id}`} detail={detail}/>;
}

function OwnedDocumentsPanel({ detail }: { detail: ProjectDetail }) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}`;
  const docs = useApi<SpaceDocument[]>(`${base}/space-documents`);
  const protection = useRef<DraftProtection | null>(null);
  const [view, setView] = useState<DraftProtectionView>({ phase: "loading", readOnly: false, error: "", entries: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [archived, setArchived] = useState(false);
  const readonly = detail.project.stage === "archived" || archived || view.readOnly;
  const accessBlocked = view.phase === "blocked" || docs.error instanceof ApiError && [401, 403, 404].includes(docs.error.status);
  const documents = accessBlocked ? [] : docs.data ?? [];
  const observedStage = useRef(detail.project.stage);
  const draftPath = (documentId: string | null) => `${base}/document-drafts/${documentId === null ? "new" : encodeURIComponent(documentId)}`;
  useEffect(() => {
    const controller = new DraftProtection({ ownerId: detail.membership.userId, projectId: detail.project.id, transport: {
      list: () => api<DocumentDraftCollection>(`${base}/document-drafts`),
      get: documentId => api<DocumentDraft>(draftPath(documentId)),
      save: (documentId, input) => api<DocumentDraft>(draftPath(documentId), { method: "PUT", body: input }),
      remove: (documentId, expectedRevision) => api<DocumentDraft>(`${draftPath(documentId)}/remove`, { method: "POST", body: { expectedRevision, expectedOwnerId: detail.membership.userId } }),
      publish: (documentId, input) => api<DraftPublicationOutcome>(`${draftPath(documentId)}/publish`, { method: "POST", body: input }),
      receipt: attemptId => api<DraftPublication | null>(`${base}/document-draft-publications/${encodeURIComponent(attemptId)}`),
    } });
    protection.current = controller;
    controller.setWritable(detail.project.stage !== "archived");
    const unsubscribe = controller.subscribe(setView);
    void controller.load();
    const clear = () => controller.block("登录已失效，私人输入已隐藏。请重新登录后恢复本人草稿。");
    const leaving = (event: BeforeUnloadEvent) => { if (controller.needsLeaveWarning()) { event.preventDefault(); event.returnValue = ""; } };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !controller.needsLeaveWarning()) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const target = new URL(link.href);
      if (target.origin === window.location.origin && target.pathname === window.location.pathname && target.search === window.location.search) return;
      if (!window.confirm("私人草稿尚未确认保护或发布仍在进行。本页输入可能丢失。先取消离开，保护或复制草稿后再继续。仍要离开吗？")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("hackathon:unauthenticated", clear);
    window.addEventListener("beforeunload", leaving);
    document.addEventListener("click", navigate, true);
    return () => {
      controller.dispose(); unsubscribe(); if (protection.current === controller) protection.current = null;
      window.removeEventListener("hackathon:unauthenticated", clear); window.removeEventListener("beforeunload", leaving); document.removeEventListener("click", navigate, true);
    };
  }, [base, detail.membership.userId]);
  useEffect(() => { protection.current?.setWritable(!readonly); }, [readonly]);
  useEffect(() => {
    if (observedStage.current === detail.project.stage) return;
    observedStage.current = detail.project.stage;
    setArchived(detail.project.stage === "archived");
    protection.current?.setWritable(detail.project.stage !== "archived");
  }, [detail.project.stage]);
  useEffect(() => {
    if (docs.error instanceof ApiError && [401, 403, 404].includes(docs.error.status)) protection.current?.block("当前账号或空间权限已失效，私人输入已隐藏。");
  }, [docs.error]);
  useEffect(() => {
    const reveal = () => {
      if (window.location.hash.startsWith("#space-document-")) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [docs.data]);
  const entryFor = (documentId: string | null) => view.entries.find(entry => entry.documentId === documentId);
  const newDraft = entryFor(null);
  const missingDrafts = view.entries.filter(entry => entry.documentId !== null && entry.editing && !documents.some(document => document.id === entry.documentId));
  function clearFeedback() { setError(""); setNotice(""); }
  async function copyBody(value: string, draft = false) {
    clearFeedback();
    try { await navigator.clipboard.writeText(value); setNotice(draft ? "已复制完整草稿正文。" : "已复制完整正文。"); }
    catch { setError("暂时无法自动复制。请选中正文后复制。"); }
  }
  async function copyLocation(anchor: string) {
    clearFeedback();
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${anchor}`);
      setNotice("已复制文档位置，打开仍需本空间成员权限。");
    } catch { setError("暂时无法自动复制位置，请手动复制当前页面地址。"); }
  }
  async function refresh() { await docs.reload(); if (view.phase === "load-error") await protection.current?.load(); }
  async function remember(document: SpaceDocument) {
    if (readonly || accessBlocked || busy) return;
    setBusy(true); clearFeedback();
    try {
      await api(`${base}/space-todos`, { method: "POST", body: {
        title: `阅读：${document.title}`.slice(0, 200),
        note: `来源：本空间文档「${document.title}」。\n/app/projects/${encodeURIComponent(detail.project.id)}#space-document-${encodeURIComponent(document.id)}\n这是本人私人备忘，标记完成不代表已读确认或团队任务完成。`,
      } });
      setNotice("已加入私人备忘，只有你可见。");
      window.dispatchEvent(new CustomEvent("hackathon:space-todos-changed", { detail: { projectId: detail.project.id } }));
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function handleWriteError(reason: unknown) {
    setError(message(reason));
    if (reason instanceof ApiError && reason.code === "PROJECT_ARCHIVED") setArchived(true);
    if (reason instanceof ApiError && [403, 404, 409].includes(reason.status)) await docs.reload();
  }
  async function publish(documentId: string | null, retryOriginal = false) {
    if (readonly || accessBlocked || busy) return;
    setBusy(true); clearFeedback();
    try {
      const result = await protection.current?.publish(documentId, retryOriginal);
      if (result?.receipt.status === "succeeded") {
        setNotice(result.receipt.cleared ? "正文已保存，本空间成员可以阅读。" : "正文已保存，本空间成员可以阅读。较新的私人草稿仍保留。");
      } else if (result) {
        setError(result.receipt.errorMessage ?? "发布结果尚未确认，私人草稿仍保留。请查询原回执。");
        if (result.receipt.errorCode === "PROJECT_ARCHIVED") setArchived(true);
      }
      await docs.reload();
    } catch (reason) { await handleWriteError(reason); } finally { setBusy(false); }
  }
  async function checkPublication(documentId: string | null) {
    clearFeedback();
    const result = await protection.current?.checkPublication(documentId);
    if (result?.receipt.status === "succeeded") { setNotice("已核实正文保存成功，本空间成员可以阅读。"); await docs.reload(); }
    else if (result) setError(result.receipt.errorMessage ?? "原发布仍待核查，私人草稿仍保留。");
  }
  async function share(document: SpaceDocument, teamEditable: boolean) {
    if (readonly || accessBlocked || busy) return;
    setBusy(true); clearFeedback();
    try {
      await api<SpaceDocument>(`${base}/space-documents/${encodeURIComponent(document.id)}/share`, { method: "POST", body: { teamEditable, expectedRevision: document.revision } });
      setNotice(teamEditable ? "已允许队友编辑。" : "已收回队友编辑权限，队友仍可阅读。"); await docs.reload();
    } catch (reason) { await handleWriteError(reason); } finally { setBusy(false); }
  }
  async function remove(document: SpaceDocument) {
    if (readonly || accessBlocked || busy) return;
    setBusy(true); clearFeedback();
    try {
      await api<{ id: string }>(`${base}/space-documents/${encodeURIComponent(document.id)}/remove`, { method: "POST" });
      setNotice("已删除这份文档。"); await docs.reload();
    } catch (reason) { await handleWriteError(reason); } finally { setBusy(false); }
  }
  function draftStatus(entry: ProtectedDraftEntry | undefined, canEdit: boolean, conflict: boolean) {
    if (!entry) return null;
    const held = entry.server.publication?.status === "pending" || entry.server.publication?.status === "unknown";
    return <>
      {entry.error && <p role="alert" className={styles.error}>{entry.error}</p>}
      {held && <p role="alert" className={styles.error}>发布结果尚未确认，私稿仍保留。请查询原回执，不会重复新建。</p>}
      {conflict && <p role="alert" className={styles.error}>团队正文已有新版本。私稿仍保留，请核对最新正文后再决定发布。</p>}
      {!canEdit && <p role="status" className={styles.draftState}>当前只能恢复、阅读和复制本人私稿，不能发布。</p>}
      {!entry.error && <p role="status" className={styles.draftState}>{entry.publishing ? "正在保存到团队正文…" : entry.status === "protecting" ? "正在保护私人草稿…" : entry.dirty ? "私人草稿尚未确认保护，离开前请保护或复制。" : entry.status === "protected" ? "已保护私人草稿，尚未保存到团队。" : "编辑中"}</p>}
    </>;
  }
  function draftMenu(entry: ProtectedDraftEntry | undefined, documentId: string | null, canEdit: boolean, conflict: boolean, currentRevision?: number) {
    const held = entry?.server.publication?.status === "pending" || entry?.server.publication?.status === "unknown";
    return <>
      <p className={styles.menuNote}>私人保护不会让队友看到；点击保存后，本空间成员可读。</p>
      {canEdit && <button type="button" disabled={busy || held || conflict || view.phase !== "ready" || entry?.status === "conflict" || entry?.status === "error" || (documentId === null && !entry?.body.trim())} onClick={() => void publish(documentId)}>保存</button>}
      <button type="button" onClick={() => void copyBody(entry?.body ?? "", true)}>复制草稿正文</button>
      {entry?.status === "conflict" && <>
        <button type="button" disabled={busy} onClick={() => void protection.current?.resolve(documentId, "restore")}>恢复已保护私稿</button>
        {!readonly && <button type="button" disabled={busy} onClick={() => void protection.current?.resolve(documentId, "keep")}>保留本页输入，覆盖私稿</button>}
      </>}
      {entry?.status === "error" && !readonly && <button type="button" disabled={busy} onClick={() => void protection.current?.resolve(documentId, "keep")}>重试保护私人草稿</button>}
      {conflict && canEdit && currentRevision && <button type="button" disabled={busy} onClick={() => protection.current?.rebase(documentId, currentRevision)}>已核对最新正文，保留输入继续编辑</button>}
      {entry?.server.publication && <button type="button" disabled={busy} onClick={() => void checkPublication(documentId)}>查询原发布回执</button>}
      {entry?.server.publication?.status === "failed" && canEdit && <button type="button" disabled={busy} onClick={() => void publish(documentId, true)}>重试原发布</button>}
      {documentId !== null && <button type="button" disabled={busy} onClick={() => protection.current?.showTeam(documentId)}>查看已保存正文，保留私稿</button>}
      {!readonly && !held && <button type="button" disabled={busy || entry?.publishing || entry?.status === "conflict" || view.phase !== "ready"} onClick={() => void protection.current?.remove(documentId)}>放弃草稿，读取已保存正文</button>}
    </>;
  }
  function renderDocument(document: SpaceDocument | null, entry?: ProtectedDraftEntry) {
    const documentId = document?.id ?? entry!.documentId!, mine = document?.authorId === detail.membership.userId;
    const canEdit = Boolean(document && !readonly && !accessBlocked && (mine || document.teamEditable));
    const conflict = Boolean(entry?.editing && document && entry.baseDocumentRevision !== document.revision);
    const editing = Boolean(entry?.editing && !accessBlocked);
    return <li className={styles.item} key={documentId} id={`space-document-${documentId}`}>
      <div className={styles.bodyFrame} data-space-document-body>
        <DocumentMenu>
          {editing ? draftMenu(entry, documentId, canEdit, conflict, document?.revision) : <>
            {document && <p className={styles.menuNote}>{mine ? "你写的" : "队友写的"} · {dateText(document.updatedAt)}<br/>{document.teamEditable ? "队友可编辑" : "仅作者可编辑"}</p>}
            <button type="button" onClick={() => void copyBody(document?.body ?? "")}>复制正文</button>
            {entry?.server.body !== null && entry && <button type="button" onClick={() => protection.current?.edit(documentId, document?.body ?? "", document?.revision ?? 1)}>恢复私人草稿</button>}
            {canEdit && <button type="button" disabled={busy} onClick={() => { clearFeedback(); protection.current?.edit(documentId, document!.body, document!.revision); }}>编辑</button>}
            {mine && !readonly && !accessBlocked && <button type="button" disabled={busy} onClick={() => void share(document!, !document!.teamEditable)}>{document?.teamEditable ? "收回队友编辑" : "允许队友编辑"}</button>}
            {mine && !readonly && !accessBlocked && <button type="button" className={styles.delete} disabled={busy} onClick={() => void remove(document!)}>删除文档</button>}
          </>}
          {document && !readonly && !accessBlocked && <button type="button" disabled={busy} onClick={() => void remember(document)}>加入私人备忘</button>}
          <button type="button" disabled={docs.loading || busy} onClick={() => void refresh()}>刷新文档</button>
          <button type="button" onClick={() => void copyLocation(`space-document-${documentId}`)}>复制文档位置</button>
        </DocumentMenu>
        {editing ? <>
          <PlainTextEditor id={`doc-body-${documentId}`} label="正文" value={entry!.body} readOnly={!canEdit || Boolean(entry?.publishing)}
            onChange={value => { setNotice(""); protection.current?.change(documentId, value); }}/>
          {draftStatus(entry, canEdit, conflict)}
        </> : <div className={styles.fullText} data-space-document-text>{document?.body ?? ""}</div>}
      </div>
    </li>;
  }
  const linkedDocument = newDraft?.server.publishedDocumentId ? documents.find(document => document.id === newDraft.server.publishedDocumentId) : null;
  const canPublishNew = !readonly && !accessBlocked && (!newDraft?.server.publishedDocumentId || Boolean(linkedDocument && (linkedDocument.authorId === detail.membership.userId || linkedDocument.teamEditable)));
  const newConflict = Boolean(linkedDocument && newDraft?.baseDocumentRevision !== linkedDocument.revision);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await publish(null); }
  return <section className={styles.panel} aria-label="空间文档" id="space-documents">
    {readonly && <p role="status" className={styles.readonly}>空间已归档，文档只读。</p>}
    {notice && <p role="status" className={styles.noticeLine}>{notice}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {docs.error && <p role="alert" className={styles.error}>{docs.error.message}</p>}
    {view.error && <p role="alert" className={styles.error}>{view.error}{view.phase !== "blocked" && <button type="button" className={styles.recovery} onClick={() => void protection.current?.load()}>重新读取私人草稿</button>}</p>}
    {docs.loading && <p role="status" className={styles.loading}>正在读取文档…</p>}
    {(documents.length > 0 || !accessBlocked && missingDrafts.length > 0) && <ul className={styles.list}>
      {documents.map(document => renderDocument(document, entryFor(document.id)))}
      {!accessBlocked && missingDrafts.map(entry => renderDocument(null, entry))}
    </ul>}
    {(!readonly && !accessBlocked || !accessBlocked && Boolean(newDraft?.body)) && <form onSubmit={create} className={styles.newDocument}>
      <div className={styles.bodyFrame} data-space-document-body>
        <DocumentMenu label="新文档更多操作">
          {draftMenu(newDraft, null, canPublishNew, newConflict, linkedDocument?.revision)}
          <button type="button" disabled={docs.loading || busy} onClick={() => void refresh()}>刷新文档</button>
          <button type="button" onClick={() => void copyLocation("space-documents")}>复制文档位置</button>
        </DocumentMenu>
        <PlainTextEditor id="new-doc-body" label="新文档正文" value={accessBlocked ? "" : newDraft?.body ?? ""} readOnly={!canPublishNew || Boolean(newDraft?.publishing)}
          onChange={value => { setNotice(""); protection.current?.change(null, value); }}/>
        {newDraft && (newDraft.body || newDraft.dirty || newDraft.server.body !== null || ["pending", "unknown"].includes(newDraft.server.publication?.status ?? "")) && draftStatus(newDraft, canPublishNew, newConflict)}
      </div>
    </form>}
  </section>;
}
