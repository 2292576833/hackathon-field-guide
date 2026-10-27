"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createResourceFeedbackClient, resourceCorrectionInput, resourceCorrectionStatusLabels, type ResourceFeedbackState } from "../modules/resources/feedback-client.ts";
import { api, dateText, message, safeLink } from "./client-api.ts";
import { Feedback, Field, Loading } from "./site-shell.tsx";
import styles from "./site.module.css";

interface FeedbackIdentityProps {
  identityKey: string | null;
  identityLoading?: boolean;
  loginHref: string;
}
function useResourceFeedback(identityKey: string | null) {
  const client = useMemo(() => createResourceFeedbackClient(identityKey, {
    list: signal => api("/me/corrections?limit=100", { signal }),
    detail: (id, signal) => api(`/me/corrections/${encodeURIComponent(id)}`, { signal }),
    submit: (input, signal) => api("/corrections", { method: "POST", body: input, signal }),
  }), [identityKey]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    const clear = () => client.clearPrivate();
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => { window.removeEventListener("hackathon:unauthenticated", clear); client.dispose(); };
  }, [client]);
  return { client, state };
}
function FeedbackRecords({ state, resourceId, resourceName, onRefresh, onSelect }: {
  state: ResourceFeedbackState; resourceId?: string; resourceName?: string;
  onRefresh: () => void; onSelect: (id: string) => void;
}) {
  const [thisResourceOnly, setThisResourceOnly] = useState(Boolean(resourceId));
  const items = state.items.filter(item => !thisResourceOnly || !resourceId || item.original.target.entityId === resourceId);
  const selected = state.selected && items.some(item => item.id === state.selected!.id) ? state.selected : null;
  return <>
    <p className={styles.muted}>这份列表仅本人可见；处理反馈的运营人员会看到问题说明和依据。查询范围是本人最近 100 条反馈，运营回复在本站查看。</p>
    <div className={styles.actions}>
      <button className={styles.secondary} type="button" disabled={state.busy || state.accessLost} onClick={onRefresh}>{state.busy ? "正在读取…" : "刷新处理状态"}</button>
      {resourceId && <label className={styles.check}><input type="checkbox" checked={thisResourceOnly} onChange={event => setThisResourceOnly(event.target.checked)}/>只看当前资源</label>}
    </div>
    {state.busy && <Loading/>}
    {!state.busy && !state.error && items.length === 0 && <p className={styles.muted}>{thisResourceOnly ? "最近的反馈中没有这项资源的记录。可取消‘只看当前资源’查看其他资源。" : "最近的反馈中还没有资源反馈。打开资源详情，可报告失效链接或不准确的信息。"}</p>}
    <ul className={styles.list}>{items.map(item => <li key={item.id}>
      <strong>{resourceCorrectionStatusLabels[item.status]}</strong> · {item.original.field}
      <p>{item.original.target.entityId === resourceId && resourceName ? resourceName : "资源反馈"} · 提交内容版本 {item.original.target.version}</p>
      <p className={styles.muted}>提交于 {dateText(item.original.submittedAt)} · 更新于 {dateText(item.updatedAt)}</p>
      {item.response && <p>运营回复：{item.response}</p>}
      <div className={styles.actions}><button className={styles.secondary} type="button" disabled={state.busy || state.accessLost} aria-expanded={selected?.id === item.id} onClick={() => onSelect(item.id)}>查看我的说明与最新回复</button><Link className={styles.link} href={`/resources/${encodeURIComponent(item.original.target.entityId)}`}>查看对应资源 →</Link></div>
    </li>)}</ul>
    {selected && <section className={styles.panel} aria-label="所选反馈详情">
      <h3>{resourceCorrectionStatusLabels[selected.status]}</h3><p>反馈编号：{selected.id}</p>
      <p>{selected.original.field} · 提交内容版本 {selected.original.target.version}</p>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{selected.original.message}</p>
      {selected.original.evidenceUrls.length > 0 && <ul>{selected.original.evidenceUrls.map((url, index) => <li key={`${index}:${url}`}>{safeLink(url) ? <a className={styles.link} href={safeLink(url)!} target="_blank" rel="noopener noreferrer">查看依据 {index + 1}（新窗口）</a> : "依据链接当前不可用"}</li>)}</ul>}
      <p>运营回复：{selected.response || "尚未有处理回复。"}</p>
      {selected.relatedVersion && <p>处理关联资源版本 {selected.relatedVersion.version}，请打开资源详情核对当前内容。</p>}
      {selected.status === "needs_more_info" && <p className={styles.muted}>请先阅读回复。需要补充时，打开对应资源详情提交新的反馈，并在说明里引用此反馈编号。</p>}
      <p className={styles.muted}>最新更新：{dateText(selected.updatedAt)}</p>
    </section>}
  </>;
}

export function ResourceFeedbackHistory(props: FeedbackIdentityProps) {
  const { client, state } = useResourceFeedback(props.identityKey);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && props.identityKey && !state.accessLost) void client.load(); }, [open, props.identityKey, client, state.accessLost]);
  return <details className={styles.panel} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={styles.summary}>我提交的资源反馈</summary>
    {props.identityLoading ? <Loading/> : !props.identityKey || state.accessLost ? <><p>登录后可以查看本人反馈的处理状态和运营回复。</p><Link className={styles.link} href={props.loginHref}>登录后查看反馈 →</Link></> : <FeedbackRecords state={state} onRefresh={() => void client.load()} onSelect={id => void client.select(id)}/>}
    <Feedback error={state.error} notice={state.notice}/>
  </details>;
}

export interface ResourceFeedbackProps extends FeedbackIdentityProps {
  resource: { id: string; version: number; name: string };
  open: boolean;
  onToggle: (open: boolean) => void;
}
export function ResourceFeedback(props: ResourceFeedbackProps) {
  return <ResourceFeedbackContent key={JSON.stringify([props.identityKey, props.resource.id, props.resource.version])} {...props}/>;
}
function ResourceFeedbackContent({ resource, identityKey, identityLoading, loginHref, open, onToggle }: ResourceFeedbackProps) {
  const { client, state } = useResourceFeedback(identityKey);
  const [field, setField] = useState("链接失效"), [note, setNote] = useState(""), [evidence, setEvidence] = useState(""), [inputError, setInputError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open && identityKey && !identityLoading && !state.accessLost) noteInput.current?.focus(); }, [open, identityKey, identityLoading, state.accessLost]);
  useEffect(() => { if (state.accessLost) { setNote(""); setEvidence(""); setInputError(""); } }, [state.accessLost]);
  useEffect(() => { if (historyOpen && identityKey && !state.accessLost) void client.load(); }, [historyOpen, identityKey, client, state.accessLost]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!identityKey || state.accessLost || state.busy) return;
    setInputError("");
    try {
      const saved = await client.submit(resourceCorrectionInput(resource, field, note, evidence));
      if (saved) { setNote(""); setEvidence(""); setHistoryOpen(true); }
    } catch (reason) { setInputError(message(reason)); }
  }
  return <section className={styles.panel} id="resource-feedback" aria-labelledby="resource-feedback-title">
    <h2 id="resource-feedback-title">资源有问题？告诉我们</h2>
    <p className={styles.muted}>失效链接、费用变化、使用条件或内容说明不准确，都可以反馈。运营核查后处理，你可在这里看回复。</p>
    <div className={styles.actions}><button className={styles.secondary} type="button" aria-expanded={open} aria-controls="resource-feedback-form" onClick={() => onToggle(!open)}>{open ? "收起反馈表单" : "报告失效或信息错误"}</button><button className={styles.secondary} type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>{historyOpen ? "收起我的反馈" : "查看我的反馈与回复"}</button></div>
    {open && <div id="resource-feedback-form">
      {identityLoading ? <Loading/> : !identityKey || state.accessLost ? <><p>登录后提交，反馈说明默认只有你和处理此反馈的运营人员可见。</p><Link className={styles.link} href={loginHref}>登录后反馈 →</Link></> : <form className={styles.form} onSubmit={event => void submit(event)} aria-busy={state.busy}>
        <p>反馈对象：{resource.name} · 内容版本 {resource.version}</p>
        <Field label="哪里有问题？"><select value={field} disabled={state.busy} onChange={event => { setField(event.target.value); setInputError(""); }}>{["链接失效", "费用或免费额度变化", "使用条件不准确", "许可说明有误", "内容说明不准确", "其他问题"].map(value => <option key={value}>{value}</option>)}</select></Field>
        <Field label="问题说明" hint="说明你看到的情况和希望核查的内容；不要填写密码、验证码或密钥。"><textarea ref={noteInput} required rows={4} maxLength={4000} value={note} disabled={state.busy} onChange={event => { setNote(event.target.value); setInputError(""); }}/></Field>
        <Field label="依据链接（选填）" hint="最多 5 个公开 HTTP(S) 链接，每行一个。本站不会因提交反馈自动抓取这些链接。"><textarea rows={3} maxLength={10010} value={evidence} disabled={state.busy} onChange={event => { setEvidence(event.target.value); setInputError(""); }}/></Field>
        <button className={styles.button} type="submit" disabled={state.busy || Boolean(state.uncertainInput)}>{state.busy ? "正在处理…" : "提交反馈"}</button>
      </form>}
    </div>}
    <Feedback error={inputError || state.error} notice={state.notice}/>
    {state.uncertainInput && <button className={styles.secondary} type="button" disabled={state.busy || state.accessLost} onClick={() => { setHistoryOpen(true); void client.load(); }}>核对我的反馈，确认是否已保存</button>}
    {state.uncertainInput && state.reviewedUncertain && <div className={styles.notice}><p>本次列表暂未找到对应记录，不能证明刚才的请求未保存。如果再次提交，可能产生重复反馈。</p><button className={styles.secondary} type="button" disabled={state.busy || state.accessLost} onClick={() => client.allowUnconfirmedRetry()}>我已核对，仍要再次提交</button></div>}
    {historyOpen && (identityLoading ? <Loading/> : !identityKey || state.accessLost ? <><p>登录后查看本人处理状态。</p><Link className={styles.link} href={loginHref}>登录后查看 →</Link></> : <FeedbackRecords state={state} resourceId={resource.id} resourceName={resource.name} onRefresh={() => void client.load()} onSelect={id => void client.select(id)}/>)}
  </section>;
}
