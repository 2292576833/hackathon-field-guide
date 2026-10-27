"use client";

import { useEffect, useId, useState } from "react";
import type { DiscoveryCard } from "../server/discovery.ts";
import type { ProjectDiscoveryView } from "../server/project-discovery.ts";
import { ApiError, api, dateText, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading } from "./site-shell.tsx";
import { useAction } from "./workflow.tsx";
import { DiscoveryGuidance, DiscoveryRegistrationLinks, DiscoveryRegistrationDeadline, DiscoveryEventDate } from "./event-discoveries.tsx";
import styles from "./site.module.css";
import draftStyles from "./project-discovery.module.css";

interface DiscoveryPage { items: DiscoveryCard[]; nextCursor: string | null }

function DiscoveryAnalysis({ card, heading }: { card: DiscoveryCard; heading: string }) {
  return <article className={draftStyles.analysis}>
    <h3>{heading}</h3><h4>{card.title}</h4><p>{card.summary}</p>
    <DiscoveryEventDate card={card}/>
    {card.sources.some(source => source.sourceKind === "indexed_excerpt") && <p className={styles.notice}>部分依据来自搜索引用，尚未读取原文全文。请打开来源核对完整要求。</p>}
    <DiscoveryRegistrationDeadline card={card} historical/>
    <DiscoveryGuidance card={card} compact={false} groupClassName={draftStyles.analysisGrid}/>
    <DiscoveryRegistrationLinks card={card} originalLabel="查看赛事原文（新窗口）"/>
    <details><summary className={styles.summary}>查看来源与依据</summary><ul className={styles.list}>{card.sources.map((source, index) => {
      const href = safeLink(source.url);
      return <li key={`${source.url}:${index}`}>
        {href ? <a href={href} className={styles.link} target="_blank" rel="noopener noreferrer">{source.title}</a> : <strong>{source.title}</strong>}
        <p>{source.excerpt}</p>
        <p className={styles.muted}>{source.sourceKind === "indexed_excerpt" ? "搜索引用获取于" : "页面获取于"} {dateText(source.fetchedAt)}</p>
      </li>;
    })}</ul></details>
    <p className={styles.muted}>分析版本 {card.revision} · 分析于 {dateText(card.lastAnalyzedAt)}</p>
  </article>;
}

export function ProjectDiscoveryPanel({ projectId, readonly }: { projectId: string; readonly: boolean }) {
  // A project switch must never carry a previous project's local edit into the
  // next project. Server permissions remain authoritative for every request.
  return <ProjectDiscoveryEditor key={projectId} projectId={projectId} readonly={readonly}/>;
}

function ProjectDiscoveryEditor({ projectId, readonly }: { projectId: string; readonly: boolean }) {
  const headingId = useId();
  const base = `/projects/${encodeURIComponent(projectId)}/discovery-draft`;
  const stored = useApi<ProjectDiscoveryView>(base);
  const action = useAction();
  const [editorOpen, setEditorOpen] = useState(false);
  const [selection, setSelection] = useState<DiscoveryCard | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [sourceConflict, setSourceConflict] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [incomingId, setIncomingId] = useState("");
  const [incomingApplied, setIncomingApplied] = useState(false);
  useEffect(() => { const values = new URLSearchParams(window.location.search).getAll("discovery"); if (values.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(values[0]!)) setIncomingId(values[0]!); }, []);
  const incoming = useApi<DiscoveryCard>(incomingId ? `/event-discoveries/${encodeURIComponent(incomingId)}` : null);
  useEffect(() => {
    if (incomingApplied || !incoming.data || incoming.error || !stored.data || stored.error || readonly) return;
    if (!selection && !editorOpen) { setSelection(incoming.data); setEditorOpen(true); setExpectedRevision(stored.data.revision); }
    setIncomingApplied(true);
  }, [incomingApplied, incoming.data, incoming.error, stored.data, stored.error, readonly, selection, editorOpen]);
  const editing = Boolean(stored.data && !readonly && (editorOpen || !stored.data.draft));
  const params = new URLSearchParams({ limit: "24" });
  if (query) params.set("query", query);
  if (cursor) params.set("cursor", cursor);
  const list = useApi<DiscoveryPage>(editing ? `/event-discoveries?${params.toString()}` : null);
  const draft = stored.data?.draft;
  const selectedSavedSource = Boolean(selection && draft && selection.id === draft.discoveryId && selection.revision === draft.discoveryRevision);
  const selectedSourceUnavailable = Boolean(selectedSavedSource && stored.data?.sourceState === "unavailable");
  const selectedSourceChanged = Boolean(selectedSavedSource && stored.data?.sourceState === "changed");

  useEffect(() => {
    if (stored.data && !stored.data.draft && expectedRevision === null) setExpectedRevision(stored.data.revision);
  }, [stored.data, expectedRevision]);
  useEffect(() => {
    if (!readonly) return;
    setEditorOpen(false); setSelection(null); setNotes(""); setExpectedRevision(null);
  }, [readonly]);

  function beginEdit(replacing: boolean) {
    if (!stored.data || readonly) return;
    setExpectedRevision(stored.data.revision);
    setNotes(stored.data.draft?.notes ?? "");
    setSelection(replacing ? null : stored.data.draft?.snapshot ?? null);
    setEditorOpen(true); setConflict(false); setSourceConflict(false);
    action.setError(""); action.setNotice("");
  }
  async function selectCard(id: string) {
    if (action.busy) return;
    setSelectingId(id);
    try {
      await action.run(async () => {
        const card = await api<DiscoveryCard>(`/event-discoveries/${encodeURIComponent(id)}`);
        setSelection(card); setSourceConflict(false);
      });
    } finally { setSelectingId(null); }
  }
  function classifyError(reason: unknown) {
    if (reason instanceof ApiError && reason.code === "DISCOVERY_DRAFT_CHANGED") setConflict(true);
    if (reason instanceof ApiError && ["DISCOVERY_CHANGED", "DISCOVERY_UNAVAILABLE"].includes(reason.code)) setSourceConflict(true);
  }
  async function reread() {
    await action.run(async () => {
      const fresh = await api<ProjectDiscoveryView>(base);
      stored.setData(fresh); setExpectedRevision(fresh.revision); setConflict(false);
      // Deliberately retain local selection and notes. The stored snapshot is
      // shown separately so the user can compare before choosing to save.
    }, "已重新读取队友版本。你的选择和备赛备注已保留，请与已保存内容对照后再保存。");
  }
  async function save() {
    if (!selection || expectedRevision === null) return;
    await action.run(async () => {
      try {
        const fresh = await api<ProjectDiscoveryView>(base, { method: "POST", body: {
          discoveryId: selection.id, discoveryRevision: selection.revision, expectedRevision, notes,
        } });
        stored.setData(fresh); setExpectedRevision(fresh.revision);
        setEditorOpen(false); setSelection(null); setNotes(""); setConflict(false); setSourceConflict(false);
      } catch (reason) { classifyError(reason); throw reason; }
    }, "赛事线索草案已保存。来源和分析仍未核验，正式赛事规则需另行确认。");
  }
  async function clear() {
    if (!stored.data) return;
    await action.run(async () => {
      try {
        const fresh = await api<ProjectDiscoveryView>(base, { method: "DELETE", body: { expectedRevision: stored.data!.revision } });
        stored.setData(fresh); setExpectedRevision(fresh.revision);
        setEditorOpen(false); setSelection(null); setNotes(""); setConflict(false); setSourceConflict(false);
      } catch (reason) { classifyError(reason); throw reason; }
    }, "已清除本项目的赛事线索草案。比赛分析和已确认赛事规则不受影响。");
  }

  return <section className={styles.panel} aria-labelledby={headingId}>
    <h2 id={headingId}>赛事线索草案</h2>
    <p className={styles.muted}>把比赛页的分析带入项目，记录来源、风险和队伍准备事项。这里保存的是未核验线索，不能替代下方已确认的赛事要求。</p>
    {incomingId && <><Feedback error={incoming.error}/>{incoming.loading && <Loading/>}{incoming.data && !incoming.error && <p className={styles.notice}>刚才选择：{incoming.data.title}。{readonly ? "请空间管理员核对后保存到团队。" : "已带入供你核对，点击“保存赛事线索草案”后队友才能看到。"}</p>}</>}
    <p className={styles.muted}>若这场比赛还没有人工审核的正式规则，可以先保存线索、核对主办方原文并填写团队时间来安排任务。官方赛道与提交阶段保持待核对，本站不会把线索当作已确认规则或替你完成报名。</p>
    <Feedback error={action.error || stored.error} notice={action.notice}/>
    {stored.loading && !stored.data && <Loading/>}
    {stored.error && <button type="button" className={styles.secondary} disabled={stored.loading || action.busy} onClick={() => void stored.reload()}>重新读取赛事线索草案</button>}
    {draft && <div className={draftStyles.saved}>
      <span className={styles.tag}>未核验 · 项目草案</span>
      {stored.data?.sourceState === "changed" && <p className={styles.notice}>比赛分析已有更新。此处保留团队保存时的版本；编辑时可重新选择最新分析，核对后再保存。</p>}
      {stored.data?.sourceState === "unavailable" && <p className={styles.notice}>这条赛事线索已不在公开列表中。原草案保留供团队对照，请重新核实来源或替换其他比赛。</p>}
      <DiscoveryAnalysis card={draft.snapshot} heading="已保存的赛事线索"/>
      <h3>已保存的队伍备赛备注</h3>
      <p className={draftStyles.notes}>{draft.notes || "尚未记录队伍备赛备注。"}</p>
      <p className={styles.muted}>草案版本 {draft.revision} · 保存于 {dateText(draft.savedAt)}</p>
      {!readonly && <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={action.busy || editing} onClick={() => beginEdit(false)}>编辑已保存草案</button>
        <button type="button" className={styles.secondary} disabled={action.busy || editing} onClick={() => beginEdit(true)}>替换赛事线索</button>
        <button type="button" className={styles.secondary} disabled={action.busy || conflict} onClick={() => void clear()}>清除项目草案</button>
      </div>}
    </div>}
    {stored.data && !draft && readonly && <Empty>项目还没有保存赛事线索草案，请由项目管理员选择比赛并记录准备事项。</Empty>}
    {readonly && stored.data && <p className={styles.muted}>当前可阅读草案。只有未归档项目的管理员可以编辑、替换或清除。</p>}
    {editing && <div className={draftStyles.editor}>
      <h3>{draft ? "编辑项目赛事线索" : "选择比赛，开始准备"}</h3>
      <form className={styles.row} onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setCursor(""); }}>
        <Field label="搜索赛事线索" hint="按比赛名称或分析摘要查找。"><input value={search} maxLength={100} disabled={action.busy} onChange={event => setSearch(event.target.value)}/></Field>
        <button className={styles.secondary} disabled={action.busy || list.loading}>搜索比赛</button>
        {query && <button type="button" className={styles.secondary} disabled={action.busy} onClick={() => { setSearch(""); setQuery(""); setCursor(""); }}>清除搜索</button>}
      </form>
      <Feedback error={list.error}/>
      {list.loading && <Loading/>}
      {list.error && <button type="button" className={styles.secondary} disabled={list.loading || action.busy} onClick={() => void list.reload()}>重新加载可选比赛</button>}
      {list.data && <fieldset className={draftStyles.choices} disabled={action.busy || list.loading}>
        <legend>选择赛事线索</legend>
        <p className={styles.muted}>本页 {list.data.items.length} 条线索。选择后请阅读完整分析和来源。</p>
        <div className={draftStyles.choiceGrid}>{list.data.items.map(card => <label key={card.id} className={`${draftStyles.choice} ${(selectingId ?? selection?.id) === card.id ? draftStyles.selected : ""}`}>
          <input type="radio" name={`discovery-${projectId}`} aria-label={card.title} checked={(selectingId ?? selection?.id) === card.id} onChange={() => void selectCard(card.id)}/>
          <span><strong>{card.title}</strong><span className={draftStyles.choiceSummary}>{card.summary}</span><span className={styles.tag}>AI 分析 · 未核验</span></span>
        </label>)}</div>
        {!list.data.items.length && <Empty>{query ? "没有找到符合关键词的比赛，可以清除搜索或换个关键词。" : cursor ? "这一页暂无线索，可以返回第一页。" : "暂时没有可选赛事线索。后台产生新的分析后会出现在比赛页。"}</Empty>}
      </fieldset>}
      <div className={styles.actions}>
        {cursor && <button type="button" className={styles.secondary} disabled={list.loading || action.busy} onClick={() => setCursor("")}>返回第一页</button>}
        {list.data?.nextCursor && <button type="button" className={styles.secondary} disabled={list.loading || action.busy} onClick={() => setCursor(list.data?.nextCursor ?? "")}>更多赛事线索</button>}
      </div>
      {selection && <DiscoveryAnalysis card={selection} heading="准备引用的赛事分析"/>}
      {(selectedSourceChanged || sourceConflict) && selection && <p className={styles.notice}>当前选择的来源需要重新核对。请读取最新分析或选择其他比赛，再保存；备赛备注会保留。</p>}
      {selectedSourceUnavailable && <p className={styles.notice}>这条线索已不可用，请选择其他比赛。</p>}
      {(selectedSourceChanged || sourceConflict) && selection && <button type="button" className={styles.secondary} disabled={action.busy} onClick={() => void selectCard(selection.id)}>读取这场比赛的最新分析</button>}
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
        <Field label="队伍备赛备注" hint="记录拟参赛方向、需要核实的资格和时间、分工想法。这里填写的内容不会自动成为官方规则。">
          <textarea value={notes} maxLength={4000} disabled={action.busy} onChange={event => setNotes(event.target.value)}/>
        </Field>
        {conflict && <p className={styles.notice}>队友修改了草案。请先重新读取队友版本并对照，当前输入会保留。</p>}
        <div className={styles.actions}>
          <button className={styles.button} disabled={action.busy || !selection || expectedRevision === null || conflict || sourceConflict || selectedSourceChanged || selectedSourceUnavailable}>保存赛事线索草案</button>
          {conflict && <button type="button" className={styles.secondary} disabled={action.busy} onClick={() => void reread()}>重新读取队友版本</button>}
          {draft && <button type="button" className={styles.secondary} disabled={action.busy} onClick={() => { setEditorOpen(false); setSelection(null); setNotes(""); setConflict(false); setSourceConflict(false); action.setError(""); action.setNotice(""); }}>取消编辑</button>}
        </div>
      </form>
    </div>}
    {conflict && !editing && <button type="button" className={styles.secondary} disabled={action.busy} onClick={() => void reread()}>重新读取队友版本</button>}
    {action.busy && <p role="status" className={styles.muted}>正在处理赛事线索草案…</p>}
  </section>;
}
