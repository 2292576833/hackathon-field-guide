"use client";
import { Field } from "../../components/site-shell.tsx";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { OfficialLinkStaleReason, OfficialRuleLinkView, PublishedOfficialRules, SetOfficialRuleLinkInput, WithdrawOfficialRuleLinkInput } from "./model.ts";
import styles from "./event-official-links.module.css";

export interface EventOfficialLinksPanelProps {
  /** The root page and API must independently verify current platform administrator access. */
  readonly hostedEventId: string;
}

class LinkRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const stateLabels: Record<OfficialRuleLinkView["state"], string> = { unlinked: "尚未关联", active: "关联有效", withdrawn: "已撤回关联", stale: "关联已过期" };
const staleLabels: Record<OfficialLinkStaleReason, string> = {
  hosted_unavailable: "主办方比赛或所属机构当前不可用。",
  hosted_not_published: "主办方比赛当前不是正式发布状态。",
  organization_changed: "比赛所属机构已变化，请重新核对。",
  hosted_version_changed: "主办方比赛已发布新版本，请重新核对后关联。",
  rules_unavailable: "原正式规则当前不可用或已撤下。",
  rules_version_changed: "人工审核的正式规则已发布新版本，请重新核对后关联。",
};
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function rules(value: unknown): value is PublishedOfficialRules {
  return record(value) && typeof value.eventId === "string" && typeof value.title === "string" && value.status === "published"
    && Number.isSafeInteger(value.publishedVersion) && Number(value.publishedVersion) > 0 && (value.sourceUrl === undefined || typeof value.sourceUrl === "string");
}
function view(value: unknown, eventId: string): value is OfficialRuleLinkView {
  if (!record(value) || !["unlinked", "active", "withdrawn", "stale"].includes(String(value.state))) return false;
  const hosted = value.hostedEvent, link = value.link;
  return (hosted === null || (record(hosted) && hosted.eventId === eventId && typeof hosted.organizationName === "string" && typeof hosted.title === "string"
      && ["draft", "published", "ended", "archived"].includes(String(hosted.status)) && (hosted.publishedRevision === null || Number.isSafeInteger(hosted.publishedRevision))))
    && (link === null || (record(link) && link.hostedEventId === eventId && typeof link.linkedEventId === "string" && typeof link.rulesTitle === "string"
      && Number.isSafeInteger(link.rulesVersion) && Number.isSafeInteger(link.hostedPublishedRevision) && Number.isSafeInteger(link.revision)
      && typeof link.auditNote === "string" && (link.status === "active" || link.status === "withdrawn")))
    && (value.currentRules === null || rules(value.currentRules)) && (value.staleMessage === null || typeof value.staleMessage === "string")
    && (value.staleReason === null || typeof value.staleReason === "string" && Object.hasOwn(staleLabels, value.staleReason));
}
function safeSource(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
async function request(path: string, signal: AbortSignal, options?: { method: "PUT" | "DELETE"; body: SetOfficialRuleLinkInput | WithdrawOfficialRuleLinkInput }): Promise<unknown> {
  const response = await fetch(path, { method: options?.method ?? "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(options ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {}) });
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new LinkRequestError("服务未返回可读取的结果，请刷新后核对。", response.status); }
  if (!response.ok || record(envelope) && envelope.error) {
    const error = record(envelope) && record(envelope.error) ? envelope.error : null;
    const message = response.status === 401 ? "登录已失效，请重新登录后读取当前关联。" : response.status === 403 ? "当前账号没有平台管理员权限，请确认权限后重新读取。"
      : error && typeof error.message === "string" ? error.message : "操作未完成，请重新读取当前结果。";
    throw new LinkRequestError(message, response.status);
  }
  if (!record(envelope) || !("data" in envelope)) throw new LinkRequestError("服务返回缺少结果，请刷新后核对。", 502);
  return envelope.data;
}
function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : "读取失败，请稍后重新读取。"; }

export function EventOfficialLinksPanel({ hostedEventId }: EventOfficialLinksPanelProps) {
  // A new event always gets a separate editor; responses from an old editor cannot update it.
  return <RuleLinkEditor key={hostedEventId} hostedEventId={hostedEventId}/>;
}

function RuleLinkEditor({ hostedEventId }: EventOfficialLinksPanelProps) {
  const id = useId(), endpoint = `/api/v1/admin/organizer/events/${encodeURIComponent(hostedEventId)}/rule-link`;
  const [current, setCurrent] = useState<OfficialRuleLinkView | null>(null);
  const [candidates, setCandidates] = useState<readonly PublishedOfficialRules[]>([]);
  const [query, setQuery] = useState(""), [appliedQuery, setAppliedQuery] = useState("");
  const [selectedId, setSelectedId] = useState(""), [note, setNote] = useState("");
  const [reading, setReading] = useState(true), [searching, setSearching] = useState(true), [busy, setBusy] = useState<"set" | "withdraw" | null>(null);
  const [readError, setReadError] = useState(""), [candidateError, setCandidateError] = useState(""), [writeError, setWriteError] = useState(""), [notice, setNotice] = useState("");
  const [mustRefresh, setMustRefresh] = useState(false), [confirming, setConfirming] = useState<"set" | "withdraw" | null>(null);
  const mounted = useRef(false), busyRef = useRef(false), denied = useRef(false);
  const readSerial = useRef(0), candidateSerial = useRef(0);
  const readRequest = useRef<AbortController | null>(null), candidateRequest = useRef<AbortController | null>(null), writeRequest = useRef<AbortController | null>(null);
  const noteInput = useRef<HTMLTextAreaElement | null>(null);

  const loseAccess = useCallback((message: string) => {
    denied.current = true; readSerial.current++; candidateSerial.current++;
    readRequest.current?.abort(); candidateRequest.current?.abort();
    setCurrent(null); setCandidates([]); setConfirming(null); setReading(false); setSearching(false); setReadError(message);
  }, []);
  const readCurrent = useCallback(async () => {
    readRequest.current?.abort(); const controller = new AbortController(); readRequest.current = controller;
    const serial = ++readSerial.current; setReading(true); setReadError(""); setConfirming(null);
    try {
      const result = await request(endpoint, controller.signal);
      if (!mounted.current || controller.signal.aborted || serial !== readSerial.current) return;
      if (!view(result, hostedEventId)) throw new LinkRequestError("关联返回格式无效，请重新读取。", 502);
      denied.current = false; setCurrent(result); setMustRefresh(false);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted || serial !== readSerial.current) return;
      if (reason instanceof LinkRequestError && [401, 403].includes(reason.status)) loseAccess(reason.message);
      else setReadError(errorText(reason));
    } finally { if (mounted.current && !controller.signal.aborted && serial === readSerial.current) setReading(false); }
  }, [endpoint, hostedEventId, loseAccess]);
  const readCandidates = useCallback(async (search: string) => {
    candidateRequest.current?.abort(); const controller = new AbortController(); candidateRequest.current = controller;
    const serial = ++candidateSerial.current; setSearching(true); setCandidateError(""); setConfirming(null);
    try {
      const result = await request(`${endpoint}/candidates?${new URLSearchParams({ query: search.trim() })}`, controller.signal);
      if (!mounted.current || controller.signal.aborted || serial !== candidateSerial.current || denied.current) return;
      if (!Array.isArray(result) || !result.every(rules)) throw new LinkRequestError("候选返回格式无效，请重新搜索。", 502);
      setCandidates(result); setAppliedQuery(search.trim());
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted || serial !== candidateSerial.current) return;
      if (reason instanceof LinkRequestError && [401, 403].includes(reason.status)) loseAccess(reason.message);
      else setCandidateError(errorText(reason));
    } finally { if (mounted.current && !controller.signal.aborted && serial === candidateSerial.current) setSearching(false); }
  }, [endpoint, loseAccess]);
  useEffect(() => {
    mounted.current = true; void readCurrent(); void readCandidates("");
    const expired = () => loseAccess("登录已失效，请重新登录后读取当前关联。输入已保留。");
    window.addEventListener("hackathon:unauthenticated", expired);
    return () => {
      mounted.current = false; readSerial.current++; candidateSerial.current++;
      readRequest.current?.abort(); candidateRequest.current?.abort(); writeRequest.current?.abort();
      window.removeEventListener("hackathon:unauthenticated", expired);
    };
  }, [readCurrent, readCandidates, loseAccess]);

  const hosted = current?.hostedEvent, link = current?.link, selected = candidates.find(item => item.eventId === selectedId);
  const locked = Boolean(busy || reading || readError || mustRefresh || denied.current);
  const canSet = !locked && !searching && !candidateError && Boolean(selected && hosted?.status === "published" && hosted.publishedRevision !== null);
  const canWithdraw = !locked && link?.status === "active";

  function refresh() {
    if (busyRef.current) return;
    setWriteError(""); setNotice(""); denied.current = false;
    void readCurrent(); void readCandidates(query);
  }
  function preview(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (canSet) { setWriteError(""); setNotice(""); setConfirming("set"); } }
  function previewWithdraw() {
    if (!canWithdraw) return;
    if (!note.trim()) { setWriteError("请填写撤回原因，方便之后核对。"); noteInput.current?.focus(); return; }
    setWriteError(""); setNotice(""); setConfirming("withdraw");
  }
  async function save(action: "set" | "withdraw") {
    if (busyRef.current || confirming !== action || !current || !note.trim() || (action === "set" ? !canSet : !canWithdraw)) return;
    if (action === "set" && (!selected || !hosted || hosted.publishedRevision === null)) return;
    busyRef.current = true; setBusy(action); setWriteError(""); setNotice("");
    const controller = new AbortController(); writeRequest.current = controller;
    const body = action === "set" ? { expectedRevision: link?.revision ?? 0, expectedHostedPublishedRevision: hosted!.publishedRevision!, linkedEventId: selected!.eventId, rulesVersion: selected!.publishedVersion, auditNote: note.trim() } satisfies SetOfficialRuleLinkInput
      : { expectedRevision: link!.revision, auditNote: note.trim() } satisfies WithdrawOfficialRuleLinkInput;
    try {
      const result = await request(endpoint, controller.signal, { method: action === "set" ? "PUT" : "DELETE", body });
      if (!mounted.current || controller.signal.aborted || denied.current) return;
      if (!view(result, hostedEventId)) throw new LinkRequestError("保存结果暂时无法核对，请刷新查看当前关联。", 502);
      setCurrent(result); setConfirming(null); setNote(""); setMustRefresh(false);
      setNotice(action === "set" ? "正式规则关联已保存。" : "关联已撤回，原关联与操作记录保留。");
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      setConfirming(null);
      if (reason instanceof LinkRequestError && [401, 403].includes(reason.status)) loseAccess(reason.message);
      else if (reason instanceof LinkRequestError && reason.status === 409) {
        setMustRefresh(true); setWriteError(`${reason.message} 选择和备注已保留，请刷新并核对当前版本后重新确认。`);
      } else if (!(reason instanceof LinkRequestError) || reason.status >= 500 || reason.status < 400) {
        setMustRefresh(true); setWriteError("暂时无法确认本次操作结果。选择和备注已保留，请先刷新当前关联，核对是否已保存后再继续。");
      } else setWriteError(`${reason.message} 选择和备注已保留。`);
    } finally { busyRef.current = false; if (mounted.current && !controller.signal.aborted) setBusy(null); }
  }

  return <section className={styles.panel} aria-labelledby={`${id}-title`} aria-busy={Boolean(busy || reading)}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>平台管理员 · 人工核对</p><h2 id={`${id}-title`}>关联正式规则</h2><p className={styles.muted}>将本场主办方比赛与已人工审核发布的赛事规则关联。请核对比赛身份、主办方与规则来源。</p></div><button type="button" className={styles.secondary} disabled={Boolean(busy || reading || searching)} onClick={refresh}>刷新并核对当前版本</button></div>
    {reading && <p role="status" className={styles.muted}>正在读取当前比赛与关联…</p>}
    {readError && <p role="alert" className={styles.error}>{readError} 输入已保留。</p>}
    {writeError && <p role="alert" className={styles.error}>{writeError}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {current && <>
      <div className={styles.context}><div className={styles.statusRow}><h3>{hosted?.title ?? "当前比赛不可用"}</h3><span className={`${styles.badge} ${current.state === "stale" ? styles.warningBadge : ""}`}>{stateLabels[current.state]}</span></div>
        {hosted && <p className={styles.muted}>{hosted.organizationName} · {hosted.publishedRevision === null ? "尚无正式发布版" : `主办方比赛发布版 ${hosted.publishedRevision}`} · {hosted.status === "published" ? "已发布" : hosted.status === "draft" ? "草稿" : hosted.status === "ended" ? "已结束" : "已归档"}</p>}
        {link ? <><dl className={styles.facts}><div><dt>{current.state === "withdrawn" ? "已撤回的规则" : "已保存的规则"}</dt><dd>{link.rulesTitle}</dd></div><div><dt>关联时版本</dt><dd>主办方比赛发布版 {link.hostedPublishedRevision} · 正式规则版 {link.rulesVersion}</dd></div><div><dt>关联记录版本</dt><dd>{link.revision}</dd></div><div><dt>核对备注</dt><dd className={styles.noteText}>{link.auditNote}</dd></div></dl>{safeSource(link.rulesSourceUrl) && <a className={styles.link} href={safeSource(link.rulesSourceUrl)!} target="_blank" rel="noopener noreferrer">查看已保存的规则来源 ↗</a>}</> : <p className={styles.muted}>本场尚未关联人工审核的正式规则。请在下方选择并核对。</p>}
        {current.state === "stale" && <div className={styles.warning}><strong>原关联当前不再生效</strong><p>{current.staleReason ? staleLabels[current.staleReason] : current.staleMessage ?? "当前版本已变化，请重新核对。"}</p>{current.currentRules ? <p>人工审核规则当前为《{current.currentRules.title}》第 {current.currentRules.publishedVersion} 版。</p> : <p>当前无法读取原赛事的已发布正式规则。</p>}<p>可核对当前版本后重新关联，或填写原因撤回原关联。</p></div>}
      </div>
      {hosted?.status !== "published" && <p className={styles.warning}>本场当前未处于正式发布状态，暂不能建立关联。已保存的关联可按当前权限撤回。</p>}
      <div className={styles.editor}>
        <form className={styles.searchForm} onSubmit={event => { event.preventDefault(); if (!busyRef.current && !reading && !denied.current) void readCandidates(query); }}>
          <Field label="查找已审核赛事" hint="选填。输入比赛名称关键词查找正式规则；留空读取可关联候选。相同名称仍需核对主办方和来源。"><input id={`${id}-query`} type="search" value={query} maxLength={200} autoComplete="off" placeholder="输入赛事名称" disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)}/></Field>
          <button type="submit" className={styles.secondary} disabled={Boolean(busy || reading || searching || readError)}> {searching ? "正在查找…" : "查找候选"}</button>
        </form>
        {candidateError && <p role="alert" className={styles.error}>{candidateError} 请重新查找候选；未读取成功的内容不能用于关联。</p>}
        {!searching && !candidateError && candidates.length === 0 && <p className={styles.empty}>{appliedQuery ? "当前搜索没有已发布的正式规则，请调整搜索词。" : "当前没有可关联的已发布正式规则。完成赛事人工审核发布后，再读取候选。"}</p>}
        <form className={styles.form} onSubmit={preview}>
          <Field label="选择对应的正式赛事规则" hint="必选。选择与当前主办方比赛对应的已人工审核规则，核对标题、来源和版本后再关联。"><select id={`${id}-candidate`} value={selectedId} required disabled={Boolean(locked || searching || candidateError)} onChange={event => { setSelectedId(event.target.value); setConfirming(null); setWriteError(""); setNotice(""); }}><option value="">请选择已人工审核的赛事</option>{selectedId && !selected && <option value={selectedId} disabled>上次选择不在当前候选中，请重新选择</option>}{candidates.map(item => <option key={item.eventId} value={item.eventId}>{item.title} · 正式规则版 {item.publishedVersion} · {item.eventId}</option>)}</select></Field>
          {selected && <div className={styles.preview}><h4>待关联规则预览</h4><p><strong>{selected.title}</strong></p><p className={styles.muted}>赛事标识：{selected.eventId} · 正式规则版 {selected.publishedVersion} · 已人工审核发布</p>{safeSource(selected.sourceUrl) ? <a className={styles.link} href={safeSource(selected.sourceUrl)!} target="_blank" rel="noopener noreferrer">打开正式规则来源核对 ↗</a> : <p className={styles.muted}>当前候选未提供规则来源链接，请核对已审核的赛事内容。</p>}</div>}
          <Field label="核对备注 / 撤回原因" hint="必填。关联时说明如何核对身份及来源，例如“主办方、日期与官网规则一致”；撤回时写原因及后续处理。备注随操作保存，先预览再确认。"><textarea ref={noteInput} id={`${id}-note`} value={note} required maxLength={2000} rows={3} disabled={Boolean(busy)} placeholder="说明如何核对这两场赛事的身份与规则，或为什么撤回关联" onChange={event => { setNote(event.target.value); setConfirming(null); }}/></Field>
          <div className={styles.actions}><button className={styles.primary} type="submit" disabled={!canSet || !note.trim()}>预览并确认关联</button><button className={styles.danger} type="button" disabled={!canWithdraw} onClick={previewWithdraw}>撤回当前关联</button></div>
          {mustRefresh && <p className={styles.warning}>请先使用上方“刷新并核对当前版本”。刷新会保留当前选择和备注，之后需要重新确认。</p>}
        </form>
        {confirming && <div className={styles.confirmation} role="region" aria-labelledby={`${id}-confirm-title`}>
          <h4 id={`${id}-confirm-title`}>{confirming === "set" ? "确认本次正式规则关联" : "确认撤回当前关联"}</h4>
          {confirming === "set" && selected && hosted ? <><p>将《{hosted.title}》发布版 {hosted.publishedRevision}，关联到《{selected.title}》正式规则版 {selected.publishedVersion}。</p><p className={styles.muted}>正式赛事标识：{selected.eventId}。请确认两者对应同一场比赛。</p>{link?.status === "active" && <p>本次确认将替换已保存的关联，历史记录保留。</p>}</> : <p>撤回《{link?.rulesTitle}》正式规则版 {link?.rulesVersion} 的关联。当前关联将停止生效，操作历史保留。</p>}
          <p className={styles.noteText}>本次备注：{note.trim()}</p><div className={styles.actions}><button type="button" className={confirming === "set" ? styles.primary : styles.danger} disabled={Boolean(busy) || (confirming === "set" ? !canSet : !canWithdraw)} onClick={() => void save(confirming)}>{busy ? "正在保存…" : confirming === "set" ? "确认关联并保存" : "确认撤回关联"}</button><button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => setConfirming(null)}>返回核对</button></div>
        </div>}
      </div>
    </>}
  </section>;
}
