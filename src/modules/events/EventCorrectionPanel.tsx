"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicEvent } from "./model.ts";
import { createEventCorrectionClient, EventCorrectionApiError, eventCorrectionReasons, eventCorrectionStatuses, getFormalEventCorrectionTarget, makeEventCorrectionInput, ownEventCorrections, safeCorrectionEvidenceUrl } from "./correction-client.ts";
import type { EventCorrectionDto, EventCorrectionReason } from "./correction-client.ts";
import styles from "./event-completion.module.css";

export interface EventCorrectionPanelProps {
  eventId: string;
  /** Exact currently published M03 event/rules; never a DSH discovery object. */
  currentEvent: PublicEvent;
  /** Verified viewer ID from the parent session; display guard only. The API authenticates independently. */
  viewerId: string | null;
}
const client = createEventCorrectionClient();
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请刷新后查看。";
function time(value: string): string { return Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + "（北京时间）" : "时间未记录"; }

/** Its key remounts all private state on account/event/version changes, including pending requests. */
export function EventCorrectionPanel(props: EventCorrectionPanelProps) {
  return <CorrectionContent key={`${props.viewerId ?? "guest"}:${props.eventId}:${props.currentEvent?.rules?.version ?? "none"}`} {...props} />;
}
function CorrectionContent({ eventId, currentEvent, viewerId }: EventCorrectionPanelProps) {
  const [field, setField] = useState("");
  const [reason, setReason] = useState<EventCorrectionReason>("incorrect");
  const [message, setMessage] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [records, setRecords] = useState<readonly EventCorrectionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const generation = useRef(0);
  const active = useRef(true);
  const submitLock = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  let formalError: string | null = null;
  try { getFormalEventCorrectionTarget(eventId, currentEvent); } catch (error) { formalError = errorText(error); }

  function failed(error: unknown) {
    if (error instanceof EventCorrectionApiError && [401, 403].includes(error.status)) { setSessionLost(true); setRecords([]); }
    setError(errorText(error));
  }
  async function refresh() {
    if (!viewerId || sessionLost) return;
    const current = ++generation.current, controller = new AbortController();
    controllers.current.add(controller); setLoading(true); setError(null);
    try {
      const saved = await client.listOwn(controller.signal);
      if (active.current && current === generation.current) { setRecords(ownEventCorrections(saved, eventId, viewerId)); }
    } catch (error) { if (active.current && current === generation.current) failed(error); }
    finally { controllers.current.delete(controller); if (active.current && current === generation.current) setLoading(false); }
  }
  useEffect(() => {
    active.current = true; void refresh();
    const clearSession = () => { generation.current++; controllers.current.forEach(controller => controller.abort()); setRecords([]); setSessionLost(true); setLoading(false); setError("登录已失效，请重新登录后查看本人记录。"); };
    window.addEventListener("hackathon:unauthenticated", clearSession);
    return () => { active.current = false; generation.current++; controllers.current.forEach(controller => controller.abort()); window.removeEventListener("hackathon:unauthenticated", clearSession); };
    // The wrapper key remounts when account/event/version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function submit() {
    if (!viewerId || sessionLost || formalError || submitLock.current || outcomeUnknown) return;
    let input;
    try { input = makeEventCorrectionInput(eventId, currentEvent, { field, reason, message, evidenceText }); } catch (error) { failed(error); return; }
    submitLock.current = true; setSending(true); setError(null); setNotice(null);
    const controller = new AbortController(); controllers.current.add(controller);
    // Invalidate an earlier list read so it cannot overwrite the returned saved submission.
    generation.current++; setLoading(false);
    try {
      const saved = await client.submit(input, controller.signal);
      if (!active.current) return;
      if (saved.submittedBy !== viewerId) { setSessionLost(true); setRecords([]); setError("登录账号发生变化，请重新打开赛事详情后查看。"); return; }
      setRecords(previous => [saved, ...previous.filter(record => record.id !== saved.id)]);
      setMessage(""); setEvidenceText(""); setNotice("纠错已收到。审核员会核对来源，处理说明会保存在下面的本人记录中。");
    } catch (error) {
      if (active.current) {
        failed(error);
        if (!(error instanceof EventCorrectionApiError) || error.status >= 500) { setOutcomeUnknown(true); setNotice("提交结果暂不确定。请先刷新本人记录核对，避免重复提交；输入已保留。"); }
      }
    } finally { controllers.current.delete(controller); submitLock.current = false; if (active.current) setSending(false); }
  }
  const canUse = !!viewerId && !sessionLost;
  return <section className={styles.panel} aria-label="赛事纠错与本人处理记录">
    <h2>这条正式赛事信息有问题？</h2>
    <p className={styles.muted}>提交具体字段、原因和可核对的来源。审核员核实后处理，不会直接改变队伍已确认的规则与计划。</p>
    {formalError && <p className={styles.warning}>{formalError} 请从原文核对，或联系站内审核员将线索送入正式赛事审核。</p>}
    {!canUse && <p className={styles.warning}>{sessionLost ? "登录已失效。" : "登录后可以提交纠错并查看本人的处理记录。"} <a href="/login">去登录</a></p>}
    {error && <p role="alert" className={styles.warning}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {canUse && !formalError && <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>针对《{currentEvent.rules.metadata.name}》正式规则版本 {currentEvent.rules.version}</p>
      <label>要纠正的字段<input required maxLength={120} value={field} placeholder="例如：报名截止、参赛资格、提交材料" onChange={event => setField(event.target.value)} disabled={sending} /></label>
      <label>原因<select value={reason} onChange={event => setReason(event.target.value as EventCorrectionReason)} disabled={sending}>{Object.entries(eventCorrectionReasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>具体说明<textarea required maxLength={3900} rows={4} value={message} placeholder="说明哪里有误、正确信息是什么，以及来源中的具体位置。没有核对到的部分请注明。" onChange={event => setMessage(event.target.value)} disabled={sending} /></label>
      <label>可核对的来源链接（选填，每行一个，最多 5 个）<textarea rows={3} value={evidenceText} placeholder="https://..." onChange={event => setEvidenceText(event.target.value)} disabled={sending} /></label>
      <p className={styles.muted}>优先提供官网公告或规则原文。暂时没有链接时，请在说明中注明依据和待核对部分。</p>
      <button type="submit" className={styles.button} disabled={sending || outcomeUnknown}>{sending ? "正在提交…" : "提交纠错"}</button>
      {outcomeUnknown && <label className={styles.check}><input type="checkbox" onChange={event => { if (event.target.checked) { setOutcomeUnknown(false); setNotice("请先核对本人记录；确认没有已有记录后再提交。"); } }} />我已刷新并核对本人记录，确认仍需重新提交。</label>}
    </form>}
    {canUse && <div>
      <div className={styles.heading}><h3>我对这场赛事提交的纠错</h3><button type="button" className={styles.secondary} onClick={() => void refresh()} disabled={loading || sending}>{loading ? "正在读取…" : "刷新处理状态"}</button></div>
      <p className={styles.muted}>显示本人最近 100 条纠错中属于这场赛事的记录，含此前正式版本。只读取已保存状态。</p>
      {!loading && records.length === 0 && <p>暂时没有查到本人对这场赛事的纠错记录。</p>}
      <ul className={styles.list}>{records.map(record => <li key={record.id} className={styles.record}>
        <div className={styles.heading}><h4>{record.original.field}</h4><span className={styles.status}>{eventCorrectionStatuses[record.status].label}</span></div>
        <p>{eventCorrectionStatuses[record.status].description}</p>
        <p className={styles.muted}>提交时规则版本 {record.original.target.version} · {time(record.original.submittedAt)}</p>
        <p className={styles.preserve}>{record.original.message}</p>
        {record.original.evidenceUrls.length > 0 && <ul>{record.original.evidenceUrls.map((value, index) => { const url = safeCorrectionEvidenceUrl(value); return <li key={`${index}:${value}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">来源依据 {index + 1}</a> : "来源链接不可用"}</li>; })}</ul>}
        <p className={styles.preserve}>处理说明：{record.response ?? "尚未留下处理说明。"}</p>
        {record.relatedVersion?.kind === "event" && record.relatedVersion.entityId === eventId && <p>关联正式规则版本：{record.relatedVersion.version}</p>}
        <p className={styles.muted}>状态更新：{time(record.updatedAt)}</p>
      </li>)}</ul>
    </div>}
  </section>;
}
