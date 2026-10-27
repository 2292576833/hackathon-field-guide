"use client";

import { useEffect, useState } from "react";
import { api, dateText, message, operationKey, useApi } from "../../components/client-api.ts";
import type { WorkPeerReviewView } from "./model.ts";
import styles from "./event-peer-review.module.css";

/**
 * 选手侧数值互评面板（规划 34 P7）。
 *
 * 纪律：
 * - 本组件只渲染**选手读写自己的互评**与**按作品的匿名汇总**；没有任何评委侧入口、没有名次、没有百分比排名。
 * - 门槛未达时只渲染服务端给的「样本不足 / 未达门槛」与门槛值本身，不渲染任何平均分或统计。
 * - 分列/不计名次/匿名/去自评等口径逐字取自服务端 notices，组件不得改写。
 * - 每条评分必须由用户自己为每个维度填写；组件不补默认分值、不补维度。
 */

function basePath(eventId: string, snapshotId: string): string {
  return "/competitions/" + encodeURIComponent(eventId) + "/works/" + encodeURIComponent(snapshotId) + "/peer-review";
}

function valueText(scale: WorkPeerReviewView["scale"], value: number): string {
  if (scale === "yes-no") return value === 1 ? "是" : "否";
  return String(value);
}

export interface PeerReviewPanelProps { eventId: string; snapshotId: string }

export function PeerReviewPanel({ eventId, snapshotId }: PeerReviewPanelProps) {
  const view = useApi<WorkPeerReviewView>(basePath(eventId, snapshotId));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  const [reported, setReported] = useState<Record<string, boolean>>({});
  const data = view.data;
  const mineId = data?.myReview?.id ?? null;
  const mineRevision = data?.myReview?.revision ?? null;

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const item of data.myReview?.values ?? []) next[item.dimensionId] = String(item.value);
    setDraft(next);
  }, [data, mineId, mineRevision]);

  if (view.error) return <section className={styles.panel} aria-label="选手数值互评">
    <h2>选手数值互评 · 不计入名次</h2>
    <p className={styles.error}>{view.error.message}</p>
    <button className={styles.secondary} type="button" onClick={() => void view.reload()}>重新读取</button>
  </section>;
  if (!data) return <section className={styles.panel} aria-label="选手数值互评">
    <h2>选手数值互评 · 不计入名次</h2>
    <p className={styles.hint}>正在读取本作品的互评…</p>
  </section>;

  const my = data.myReview;
  const labels = new Map(data.dimensions.map(dimension => [dimension.id, dimension.label]));

  function change(dimensionId: string, value: string): void {
    setDraft(current => ({ ...current, [dimensionId]: value }));
  }
  async function submit(): Promise<void> {
    if (busy) return;
    const values: Record<string, number> = {};
    for (const dimension of data!.dimensions) {
      const raw = draft[dimension.id];
      if (raw === undefined || raw === "" || !/^-?\d+$/.test(raw)) { setFailed(true); setNote("请为每个维度填写一个整数后再提交。"); return; }
      values[dimension.id] = Number(raw);
    }
    setBusy(true); setNote(""); setFailed(false);
    const key = operationKey();
    try {
      await api<WorkPeerReviewView>(basePath(eventId, snapshotId), { method: "POST", idempotencyKey: key, body: { values, ...(my ? { expectedRevision: my.revision } : {}), idempotencyKey: key } });
      setNote(my ? "已更新你的互评。" : "已提交你的互评。");
      await view.reload();
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }
  async function withdraw(): Promise<void> {
    if (!my || busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try {
      await api<unknown>(basePath(eventId, snapshotId) + "/withdraw", { method: "POST", body: { expectedRevision: my.revision } });
      setNote("已撤回你的互评。");
      await view.reload();
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }
  async function report(reviewId: string): Promise<void> {
    if (busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try {
      await api<unknown>(basePath(eventId, snapshotId) + "/" + encodeURIComponent(reviewId) + "/report", { method: "POST", body: {} });
      setReported(current => ({ ...current, [reviewId]: true }));
      setNote("已记录这条举报事实；本页不做裁决，主办方按既有流程处理。");
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-label="选手数值互评">
    <div className={styles.head}>
      <h2>选手数值互评 · 不计入名次</h2>
      <span className={styles.badge}>{data.scale === "yes-no" ? "是 / 否" : data.scale === "1-5" ? "1–5 分" : "0–10 分"}</span>
      <span className={styles.badgeMuted}>{data.scope === "participants" ? "仅本场参赛者可见的作品" : "公开作品"}</span>
    </div>
    <p className={styles.hint}>{data.notices.separate}</p>
    <p className={styles.hint}>{data.notices.notRanked}</p>
    <p className={styles.hint}>{data.notices.scale}</p>

    {!data.threshold.met
      ? <p className={styles.notice}>{data.threshold.message}</p>
      : <div className={styles.block}>
        <h3>按作品汇总（匿名）</h3>
        <p className={styles.hint}>{data.summary ? data.summary.reviewCount + " 份有效互评 · " + data.notices.anonymous : data.notices.anonymous}</p>
        {data.summary && data.summary.dimensions.length
          ? <ul className={styles.list}>{data.summary.dimensions.map(dimension => <li key={dimension.id}>
            <strong>{dimension.label}</strong>
            <span className={styles.hint}> 平均 {dimension.average === null ? "暂无评分" : String(dimension.average)} · {dimension.count} 份</span>
          </li>)}</ul>
          : <p className={styles.empty}>本作品还没有可汇总的有效互评。</p>}
        {data.summary && data.summary.anonymousReviews.length
          ? <details><summary>匿名逐条分值（{data.summary.anonymousReviews.length} 条）</summary>
            <ul className={styles.list}>{data.summary.anonymousReviews.map(entry => <li key={entry.reviewId}>
              <span>{entry.values.map(item => (labels.get(item.dimensionId) ?? item.dimensionId) + " " + valueText(data.scale, item.value)).join(" · ")}</span>
              <button className={styles.secondary} type="button" disabled={busy || reported[entry.reviewId] === true}
                onClick={() => void report(entry.reviewId)}>{reported[entry.reviewId] ? "已举报" : "举报这条"}</button>
            </li>)}</ul>
          </details>
          : null}
      </div>}

    <div className={styles.block}>
      <h3>我的互评</h3>
      {my
        ? <p className={styles.hint}>当前版本 v{my.revision} · 更新于 {dateText(my.updatedAt)}；修改后旧版本保留为历史，撤回后仍可重新提交。</p>
        : <p className={styles.hint}>你还没有给这件作品互评。每条评分必须由你本人为每个维度填写，系统不会补默认分。</p>}
      {note && <p className={failed ? styles.error : styles.notice}>{note}</p>}
      {data.canReview
        ? <div className={styles.form}>
          {data.dimensions.map(dimension => <label className={styles.row} key={dimension.id}>
            <span>{dimension.label}</span>
            {data.scale === "yes-no"
              ? <select value={draft[dimension.id] ?? ""} disabled={busy} onChange={event => change(dimension.id, event.target.value)}>
                <option value="">请选择</option><option value="1">是</option><option value="0">否</option>
              </select>
              : <input type="number" inputMode="numeric" step={1} min={data.valueRange.min} max={data.valueRange.max}
                value={draft[dimension.id] ?? ""} disabled={busy} placeholder={String(data.valueRange.min) + "–" + String(data.valueRange.max)}
                onChange={event => change(dimension.id, event.target.value)} />}
          </label>)}
          <div className={styles.actions}>
            <button className={styles.primary} type="button" disabled={busy} onClick={() => void submit()}>{my ? "保存修改" : "提交互评"}</button>
            {my ? <button className={styles.secondary} type="button" disabled={busy} onClick={() => void withdraw()}>撤回我的互评</button> : null}
          </div>
        </div>
        : <p className={styles.empty}>{data.canReviewReason ?? data.notices.selfReview}</p>}
      <p className={styles.hint}>{data.notices.governance}</p>
    </div>

    <ul className={styles.limits}>{data.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}
