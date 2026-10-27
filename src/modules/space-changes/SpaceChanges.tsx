"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, dateText, message } from "../../components/client-api.ts";
import type { SpaceChangeAcknowledgement, SpaceChangeItem, SpaceChangeValue, SpaceChangesList, SpaceChangesReconciled } from "./types.ts";
import styles from "./space-changes.module.css";

export interface SpaceChangesProps { projectId: string; currentUserId: string; readOnly?: boolean; reloadToken?: number }
export function SpaceChanges(props: SpaceChangesProps) {
  return <SpaceChangesPanel key={`${props.projectId}:${props.currentUserId}`} {...props}/>;
}
function pageVisible() { return document.visibilityState !== "hidden"; }
function valueText(value: SpaceChangeValue, change: SpaceChangeItem): string {
  if (value === null) return change.taskId ? "未安排" : "未设置";
  if (typeof value === "object") return value.displayName;
  return change.field === "deadline" ? dateText(value) : value || "未填写";
}
function SpaceChangesPanel({ projectId, currentUserId, readOnly = false, reloadToken = 0 }: SpaceChangesProps) {
  const [snapshot, setSnapshot] = useState<SpaceChangesList | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false), [busyId, setBusyId] = useState<string | null>(null);
  const [denied, setDenied] = useState(false), [reading, setReading] = useState(false);
  const snapshotRef = useRef<SpaceChangesList | null>(null), generation = useRef(0), mounted = useRef(true);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const activeRead = useRef(false), activeWrite = useRef(false), accessDenied = useRef(false);
  const base = `/projects/${encodeURIComponent(projectId)}/space-changes`;
  const clear = useCallback((text: string) => {
    accessDenied.current = true; generation.current++;
    readController.current?.abort(); writeController.current?.abort();
    snapshotRef.current = null; setSnapshot(null); setExpanded(false); setDenied(true); setNotice(""); setError(text); setReading(false);
  }, []);
  const accept = useCallback((next: SpaceChangesList, append = false) => {
    if (next.projectId !== projectId || next.userId !== currentUserId) { clear("当前登录身份已变化，请重新打开空间。"); return; }
    const previous = snapshotRef.current;
    if (previous && previous.membershipId !== next.membershipId) { setExpanded(false); setNotice(""); append = false; }
    const items = append && previous
      ? [...previous.items.filter(item => !next.items.some(value => value.id === item.id)), ...next.items]
      : next.items;
    const value = { ...next, items };
    snapshotRef.current = value; setSnapshot(value); setError("");
  }, [projectId, currentUserId, clear]);
  const refresh = useCallback(async (beforeVersion?: number) => {
    if (!pageVisible() || accessDenied.current || (activeRead.current && !readController.current?.signal.aborted) || activeWrite.current) return;
    activeRead.current = true; setReading(true);
    const controller = new AbortController(), current = ++generation.current; readController.current = controller;
    try {
      if (beforeVersion === undefined && !readOnly && !snapshotRef.current?.readOnly) {
        try { await api<SpaceChangesReconciled>(`${base}/reconcile`, { method: "POST", body: {}, signal: controller.signal }); }
        catch (reason) {
          // Archive may happen between page load and this check; continue with a read.
          if (!(reason instanceof ApiError && ["PROJECT_READ_ONLY", "PROJECT_ARCHIVED"].includes(reason.code))) throw reason;
        }
      }
      if (controller.signal.aborted || !pageVisible()) return;
      const next = await api<SpaceChangesList>(`${base}${beforeVersion === undefined ? "" : `?beforeVersion=${beforeVersion}`}`, { signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && current === generation.current) accept(next, beforeVersion !== undefined);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted || current !== generation.current) return;
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) clear(message(reason));
      else setError(`变更待核对：${message(reason)}`);
    } finally {
      if (readController.current === controller) activeRead.current = false;
      if (mounted.current && current === generation.current) setReading(false);
    }
  }, [base, readOnly, accept, clear]);

  useEffect(() => {
    mounted.current = true;
    const expired = () => clear("登录已失效，请重新登录后打开空间。");
    window.addEventListener("hackathon:unauthenticated", expired);
    return () => { mounted.current = false; generation.current++; readController.current?.abort(); writeController.current?.abort(); window.removeEventListener("hackathon:unauthenticated", expired); };
  }, [clear]);
  useEffect(() => {
    if (denied) return;
    const visible = () => {
      if (document.visibilityState === "hidden") { readController.current?.abort(); setReading(false); }
      else void refresh();
    };
    visible();
    const timer = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); readController.current?.abort(); };
  }, [refresh, reloadToken, denied]);

  async function acknowledge(item: SpaceChangeItem) {
    if (activeWrite.current || accessDenied.current || readOnly || snapshotRef.current?.readOnly || item.acknowledgedAt) return;
    readController.current?.abort();
    const current = ++generation.current, controller = new AbortController(); writeController.current = controller;
    activeWrite.current = true; setBusyId(item.id); setReading(false); setError(""); setNotice("");
    try {
      const result = await api<SpaceChangeAcknowledgement>(`${base}/acknowledge`, {
        method: "POST", body: { changeId: item.id, version: item.version, understood: true }, signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted || current !== generation.current) return;
      if (result.projectId !== projectId || result.changeId !== item.id || result.version !== item.version) throw new Error("确认回执待核对，请刷新查看。");
      const previous = snapshotRef.current;
      if (previous) accept({ ...previous, pendingCount: Math.max(0, previous.pendingCount - 1), items: previous.items.map(value => value.id === result.changeId ? { ...value, acknowledgedAt: result.acknowledgedAt } : value) });
      setNotice("已记录你了解此变更；任务和计划保持原记录。");
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted || current !== generation.current) return;
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) clear(message(reason));
      else setError(`${message(reason)} 请刷新核对；再次点击只会确认同一条变更。`);
    } finally {
      activeWrite.current = false;
      if (mounted.current) setBusyId(null);
    }
  }

  return <div className={styles.root} id="space-changes">
    <button type="button" className={styles.summary} aria-expanded={expanded} disabled={denied} onClick={() => setExpanded(value => !value)}>
      <span>{expanded ? "▾" : "▸"}</span> 关键变更 · {error ? "待核对" : snapshot ? `${snapshot.pendingCount} 条待确认` : "正在读取…"}
    </button>
    {error && <p role="alert" className={styles.error}>{error}{!denied && <button type="button" className={styles.link} disabled={reading || busyId !== null} onClick={() => void refresh()}>重新读取</button>}</p>}
    {expanded && snapshot && <div className={styles.content}>
      <p className={styles.hint}>“我已了解”仅记录本人知悉，不代表同意方案、重排计划或完成任务。{(readOnly || snapshot.readOnly) && " 空间已归档，只能查看。"}</p>
      {notice && <p role="status" className={styles.hint}>{notice}</p>}
      {snapshot.items.length === 0 && <p className={styles.hint}>暂无与你当前成员身份相关的变更。</p>}
      <ul className={styles.list}>{snapshot.items.map(item => <li key={item.id} className={styles.item}>
        <strong>{item.title}</strong><small>变更版本 {item.version} · {dateText(item.recordedAt)}</small>
        <dl className={styles.values}><dt>之前</dt><dd>{valueText(item.before, item)}</dd><dt>现在</dt><dd>{valueText(item.after, item)}</dd></dl>
        {item.acknowledgedAt ? <small>我已了解 · {dateText(item.acknowledgedAt)}</small>
          : <button type="button" className={styles.confirm} disabled={Boolean(error) || busyId !== null || readOnly || snapshot.readOnly} onClick={() => void acknowledge(item)}>{busyId === item.id ? "正在记录…" : "我已了解"}</button>}
      </li>)}</ul>
      {snapshot.nextBeforeVersion !== null && <button type="button" className={styles.link} disabled={reading || busyId !== null} onClick={() => void refresh(snapshot.nextBeforeVersion!)}>查看更早的变更</button>}
    </div>}
  </div>;
}
