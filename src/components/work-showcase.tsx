"use client";

import { useState } from "react";
import { ApiError, api, dateText, message, operationKey, useApi } from "./client-api.ts";
import { Field, Loading } from "./site-shell.tsx";
import { PeerReviewPanel } from "../modules/event-peer-review/ui.ts";
import styles from "./competition-workspace.module.css";

type WorkScope = "private" | "participants" | "public";
interface CommentView {
  readonly id: string; readonly createdAt: string; readonly text: string | null;
  readonly canHide: boolean; readonly canReport: boolean; readonly reportedCount: number; readonly reportedByViewer: boolean;
}
interface CommentList {
  readonly totalCount: number; readonly hiddenCount: number; readonly truncated: boolean;
  readonly commentMaxLength: number;
  readonly items: readonly CommentView[];
  readonly notices: { readonly separate: string; readonly notRanked: string; readonly rate: string; readonly hide: string; readonly report: string };
  readonly limitations: readonly string[];
}
const error_message = message;
interface WorkFields { title: boolean; description: boolean; links: boolean; files: boolean }
interface ShowcaseEntry {
  readonly teamId: string; readonly snapshotId: string; readonly scope: "participants" | "public"; readonly disclosedFields: readonly string[];
  readonly updatedAt: string; readonly title?: string; readonly description?: string;
  readonly links?: readonly { readonly label: string; readonly url: string }[];
  readonly files?: readonly { readonly name: string; readonly url: string }[];
}
interface ShowcaseList { readonly visibleCount: number; readonly items: readonly ShowcaseEntry[]; readonly notice: string; readonly limitations: readonly string[] }
interface DisclosureView {
  readonly teamId: string; readonly hasFormalReceipt: boolean; readonly canSubmit: boolean; readonly reason: string | null;
  readonly active: { readonly id: string; readonly scope: WorkScope; readonly fields: WorkFields; readonly revision: number } | null;
  readonly notices: { readonly defaultPrivate: string; readonly fieldChoice: string; readonly scope: string; readonly withdraw: string; readonly gate: string };
}
const fieldLabels: readonly (keyof WorkFields)[] = ["title", "description", "links", "files"];
const fieldNames: Record<keyof WorkFields, string> = { title: "作品名称", description: "简介", links: "链接", files: "文件" };

/**
 * 规划34 C①：选手侧「作品展示」。
 *
 * 公开与否由**提交的队伍本人**选择（默认不公开）；主办方只能决定本场是否允许这件事（`community.workShowcase`）。
 * 赛事未开启、本人不是本场参赛者、或本队没有正式收件时**不渲染任何入口**，也不显示空占位。
 */
export function MyWorkShowcase({ eventId }: { eventId: string }) {
  const base = `/competitions/${encodeURIComponent(eventId)}`;
  const teams = useApi<{ ownTeam: { id: string; name: string } | null }>(`${base}/teams?limit=1`);
  if (teams.error) return <p role="alert">队伍信息暂时没有读到：{teams.error.message} <button type="button" className={styles.secondary} onClick={() => void teams.reload()}>重新读取</button></p>;
  const team = teams.data?.ownTeam ?? null;
  if (!team) return null;
  return <WorkShowcaseBody eventId={eventId} teamId={team.id}/>;
}
function WorkShowcaseBody({ eventId, teamId }: { eventId: string; teamId: string }) {
  const base = `/competitions/${encodeURIComponent(eventId)}`;
  const disclosure = useApi<DisclosureView>(`${base}/works/${encodeURIComponent(teamId)}/disclosure`);
  if (disclosure.error instanceof ApiError && (disclosure.error.status === 403 || disclosure.error.status === 404)) return null;
  if (disclosure.error) return <p role="alert">公开范围暂时没有读到：{disclosure.error.message} <button type="button" className={styles.secondary} onClick={() => void disclosure.reload()}>重新读取</button></p>;
  if (!disclosure.data) return <Loading/>;
  const view = disclosure.data;
  return <section className={styles.card} aria-label="作品展示与公开范围">
    <h2>作品展示</h2>
    <p className={styles.muted}>{view.notices.scope}</p>
    <p className={styles.muted}>{view.notices.defaultPrivate}</p>
    {!view.hasFormalReceipt ? <p className={styles.muted}>{view.reason ?? "本队还没有正式收件，暂不能选择公开范围。"}</p>
      : <WorkDisclosureForm key={view.active?.revision ?? "none"} eventId={eventId} teamId={teamId} canSubmit={view.canSubmit} reason={view.reason} active={view.active} notices={view.notices} onChanged={disclosure.reload}/>}
    <DisclosedWorks base={base} eventId={eventId}/>
  </section>;
}
function WorkDisclosureForm({ eventId, teamId, canSubmit, reason, active, notices, onChanged }: {
  eventId: string; teamId: string; canSubmit: boolean; reason: string | null;
  active: DisclosureView["active"]; notices: DisclosureView["notices"]; onChanged: () => void;
}) {
  const base = `/competitions/${encodeURIComponent(eventId)}/works/${encodeURIComponent(teamId)}/disclosure`;
  const [scope, setScope] = useState<WorkScope>(active?.scope ?? "private");
  const [fields, setFields] = useState<WorkFields>(active?.fields ?? { title: true, description: true, links: false, files: false });
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [notice, setNotice] = useState("");
  async function save() {
    if (busy || !canSubmit) return;
    setBusy(true); setFailure(""); setNotice("");
    try {
      await api(base, { method: "POST", body: { scope, fields, idempotencyKey: operationKey() } });
      setNotice(scope === "private" ? "已记录：本队选择不公开作品。" : "已保存公开范围；可随时撤回或改回不公开。");
      onChanged();
    } catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  async function withdraw() {
    if (busy || !active) return;
    setBusy(true); setFailure(""); setNotice("");
    try { await api(`${base}/withdraw`, { method: "POST", body: { expectedRevision: active.revision } }); setNotice("已撤回公开选择；作品回到不公开状态。"); onChanged(); }
    catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  return <div>
    <Field label="公开范围" hint={notices.scope}>
      <select value={scope} disabled={busy || !canSubmit} onChange={change => setScope(change.target.value as WorkScope)}>
        <option value="private">不公开（默认）</option>
        <option value="participants">仅本场参赛者</option>
        <option value="public">公开（含访客）</option>
      </select>
    </Field>
    <fieldset disabled={busy || !canSubmit || scope === "private"}>
      <legend>{notices.fieldChoice}</legend>
      {fieldLabels.map(key => <label className={styles.check} key={key}><input type="checkbox" checked={fields[key]} onChange={change => setFields(previous => ({ ...previous, [key]: change.target.checked }))}/><span>{fieldNames[key]}</span></label>)}
    </fieldset>
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={busy || !canSubmit} onClick={() => void save()}>{busy ? "正在保存…" : "保存公开范围"}</button>
      {active && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void withdraw()}>{notices.withdraw}</button>}
    </div>
    {!canSubmit && reason && <p className={styles.muted}>{reason}</p>}
    {failure && <p role="alert">{failure}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
function DisclosedWorks({ base, eventId }: { base: string; eventId: string }) {
  const works = useApi<ShowcaseList>(`${base}/works`);
  if (works.error) return null;
  if (!works.data) return null;
  if (works.data.items.length === 0) return <p className={styles.muted}>目前还没有队伍公开作品。</p>;
  return <div>
    <h3>已公开作品</h3>
    <p className={styles.muted}>{works.data.notice}</p>
    <ul>{works.data.items.map(entry => <li key={entry.teamId}>
      {entry.title ? <strong>{entry.title}</strong> : <strong>未公开作品名称</strong>}
      {entry.description ? <p className={styles.muted}>{entry.description}</p> : null}
      {entry.links && entry.links.length > 0 ? <p>{entry.links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">{link.label} ↗</a>)}</p> : null}
      {entry.files && entry.files.length > 0 ? <ul>{entry.files.map(file => <li key={file.url}><a href={file.url} target="_blank" rel="noreferrer noopener">{file.name}</a></li>)}</ul> : null}
      <p className={styles.muted}>公开范围：{entry.scope === "public" ? "公开（含访客）" : "仅本场参赛者"} · 更新：{dateText(entry.updatedAt)}</p>
      <WorkComments eventId={eventId} snapshotId={entry.snapshotId}/>
      <PeerReviewPanel eventId={eventId} snapshotId={entry.snapshotId}/>
    </li>)}</ul>
    {works.data.limitations.length > 0 && <p className={styles.muted}>{works.data.limitations.join(" ")}</p>}
  </div>;
}

/** 规划34 C①：主办方侧只读——已公开作品 ＋ 未公开队伍**数量**（不含身份）。 */
export function OrganizerWorkShowcase({ eventId }: { eventId: string }) {
  const works = useApi<ShowcaseList & { notDisclosedTeamCount: number }>(`/organizer/events/${encodeURIComponent(eventId)}/judging/works`);
  if (works.error) return null;
  if (!works.data) return null;
  return <section className={styles.card} aria-label="作品展示（本场）">
    <h2>作品展示</h2>
    <p className={styles.muted}>{works.data.notice}</p>
    <p className={styles.muted}>已公开 {works.data.visibleCount} 件；未公开队伍 {works.data.notDisclosedTeamCount} 支（只计数，不显示身份）。</p>
    {works.data.items.length > 0 && <ul>{works.data.items.map(entry => <li key={entry.teamId}>{entry.title ?? "未公开作品名称"} · {entry.scope === "public" ? "公开（含访客）" : "仅本场参赛者"}</li>)}</ul>}
    {works.data.limitations.length > 0 && <p className={styles.muted}>{works.data.limitations.join(" ")}</p>}
  </section>;
}
/**
 * 规划34 C②：作品文字留言（独立区）。
 *
 * 与数值互评、评审分**分列**：这里只出现文字，不计入名次；三层门禁不满足时模块返回 403，本组件不渲染任何空壳。
 * `canHide`/`canReport` 一律用服务端返回值，不在前端自行判断身份。
 */
function WorkComments({ eventId, snapshotId }: { eventId: string; snapshotId: string }) {
  const base = `/competitions/${encodeURIComponent(eventId)}/works/${encodeURIComponent(snapshotId)}/comments`;
  const comments = useApi<CommentList>(base);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [notice, setNotice] = useState("");
  if (comments.error instanceof ApiError && (comments.error.status === 403 || comments.error.status === 404)) return null;
  if (comments.error) return <p role="alert">留言区暂时没有读到：{comments.error.message}</p>;
  if (!comments.data) return null;
  const view = comments.data;
  async function act(path: string, body: unknown, message: string) {
    if (busy) return; setBusy(true); setFailure(""); setNotice("");
    try { await api(path, { method: "POST", body }); setNotice(message); await comments.reload(); }
    catch (reason) { setFailure(error_message(reason)); }
    finally { setBusy(false); }
  }
  async function post() {
    if (busy || !text.trim()) return;
    setBusy(true); setFailure(""); setNotice("");
    try { await api(base, { method: "POST", body: { text, idempotencyKey: operationKey() } }); setText(""); setNotice("已发表。文字留言不计入名次。"); await comments.reload(); }
    catch (reason) { setFailure(error_message(reason)); }
    finally { setBusy(false); }
  }
  return <details className={styles.details} aria-label="文字留言">
    <summary>文字留言（{view.totalCount}）· 不计入名次</summary>
    <p className={styles.muted}>{view.notices.notRanked}</p>
    <p className={styles.muted}>{view.notices.separate}</p>
    <Field label="写一条文字留言" hint={view.notices.rate}>
      <textarea rows={3} maxLength={view.commentMaxLength} value={text} disabled={busy} onChange={change => setText(change.target.value)}/>
    </Field>
    <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy || !text.trim()} onClick={() => void post()}>{busy ? "正在提交…" : "发表留言"}</button></div>
    {failure && <p role="alert">{failure}</p>}
    {notice && <p role="status">{notice}</p>}
    {view.items.length === 0 ? <p className={styles.muted}>还没有留言。</p> : <ul>{view.items.map(item => <li key={item.id}>
      {item.text === null ? <p className={styles.muted}>这条留言已被隐藏，正文不再显示。</p> : <p className={styles.prose}>{item.text}</p>}
      <p className={styles.muted}>{dateText(item.createdAt)}{item.reportedCount > 0 ? ` · 已被举报 ${item.reportedCount} 次` : ""}</p>
      <div className={styles.actions}>
        {item.canHide && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(`${base}/${encodeURIComponent(item.id)}/hide`, { reason: "作者隐藏" }, "已隐藏这条留言。")}>{view.notices.hide}</button>}
        {item.canReport && !item.reportedByViewer && <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(`${base}/${encodeURIComponent(item.id)}/report`, { reason: "需要主办方看看" }, "已记录举报，主办方可以查看；本模块不自动裁决。")}>{view.notices.report}</button>}
      </div>
    </li>)}</ul>}
    {view.hiddenCount > 0 && <p className={styles.muted}>已隐藏 {view.hiddenCount} 条。</p>}
    {view.truncated && <p className={styles.muted}>这里显示的是最新的一部分留言。</p>}
    {view.limitations.length > 0 && <p className={styles.muted}>{view.limitations.join(" ")}</p>}
  </details>;
}
