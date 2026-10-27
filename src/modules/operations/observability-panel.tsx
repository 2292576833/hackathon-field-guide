"use client";

import { useEffect, useState } from "react";
import type { SourceObservabilityReport } from "./observability-types.ts";
import styles from "./observability-panel.module.css";

export interface AdminSourceObservabilityPanelProps {
  readonly sourceId: string;
  readonly endpoint?: string;
}
const statusNames: Record<string, string> = { queued: "等待执行", running: "执行中", review_ready: "待审核", succeeded: "分析通过", failed: "失败", cancelled: "已取消" };
const failureNames: Record<string, string> = { timeout: "超时", network_error: "网络错误", rate_limited: "访问频率受限", provider_unavailable: "模型服务不可用", worker_lost: "执行服务中断", access_denied: "访问被拒绝", invalid_input: "输入无效", parse_error: "内容解析失败", schema_invalid: "结构校验失败", source_changed: "来源配置已变更", unknown: "未分类错误" };
const sourceNames: Record<string, string> = { proposed: "待验证", verifying: "验证中", enabled: "已启用", rejected: "未通过", paused: "已暂停", degraded: "需要处理" };
const workerNames: Record<string, string> = { not_started: "尚未启动", idle: "等待任务", running: "正在执行", failed: "发生故障", stopped: "已停止", stale: "心跳过期" };
const admissionNames: Record<string, string> = { allowed: "可接受新任务", limited: "额度受限", unknown_request: "等待未知请求核对", not_configured: "尚未配置" };
const time = (value: string | null) => value ? `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value))}（UTC+8）` : "未记录";
const duration = (value: number | null) => value === null ? "未记录" : value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(1)} 秒`;

export function AdminSourceObservabilityPanel({ sourceId, endpoint }: AdminSourceObservabilityPanelProps) {
  const path = endpoint ?? `/api/v1/admin/sources/${encodeURIComponent(sourceId)}/observability`;
  const [rawReport, setReport] = useState<SourceObservabilityReport | null>(null);
  const report = rawReport?.source.id === sourceId ? rawReport : null;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  // Request identity includes the source; a cursor from another source is never reused.
  const [cursorSource, setCursorSource] = useState(sourceId);
  const activeCursor = cursorSource === sourceId ? cursor : null;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setPending(true); setError(null); setReport(null);
    if (!path.startsWith("/api/") || path.startsWith("//") || /[?#\\]/.test(path)) { setError("故障查询入口尚未正确配置。"); setPending(false); return; }
    const timer = setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ limit: "50" });
    if (activeCursor) params.set("cursor", activeCursor);
    void (async () => {
      try {
        const response = await fetch(`${path}?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("read-failed");
        const body = await response.json() as { data?: SourceObservabilityReport };
        if (!body.data || body.data.source.id !== sourceId || !Array.isArray(body.data.runs)) throw new Error("invalid-report");
        if (active) setReport(body.data);
      } catch { if (active) setError("读取失败，请确认当前管理员权限，并重新查询来源状态。"); }
      finally { clearTimeout(timer); if (active) setPending(false); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [path, sourceId, activeCursor, refresh]);
  function restart() { setCursorSource(sourceId); setCursor(null); setRefresh(value => value + 1); }
  return <section className={styles.panel} aria-label="单来源故障归因" aria-busy={pending}>
    <div className={styles.heading}><div><h2>来源运行情况</h2><p>来源标识：<code>{sourceId}</code>。默认查看最近 7 天创建的任务。</p></div><button type="button" disabled={pending} onClick={restart}>{pending ? "正在读取…" : "重新查询"}</button></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {pending && <p role="status">正在读取已保存的运行记录…</p>}
    {report && <>
      <div className={styles.facts}><p>来源状态<strong>{sourceNames[report.source.status] ?? "未知"}</strong></p><p>连续采集失败<strong>{report.source.consecutiveCrawlFailures} 次</strong></p><p>最近采集成功<strong>{time(report.source.lastSuccessAt)}</strong></p><p>最近采集失败<strong>{time(report.source.lastFailureAt)}</strong></p></div>
      <p className={styles.note}>连续失败数来自该来源的采集健康记录；下列任务汇总按创建时间窗口统计，失败分类也包含后来恢复的任务。</p>
      <p>统计窗口：{time(report.window.since)} 至 {time(report.window.until)}。读取时间：{time(report.observedAt)}。</p>
      <div className={styles.counts}>{report.counts.length ? report.counts.map(item => <span key={item.status}>{statusNames[item.status] ?? "未知状态"}：{item.count}</span>) : <span>这个时间窗口内没有任务。</span>}</div>
      <div className={styles.counts}>{report.failures.length ? report.failures.map(item => <span key={item.category}>{failureNames[item.category] ?? "未分类错误"}：{item.count} 个任务</span>) : <span>这个时间窗口内没有已记录的失败。</span>}</div>
      {report.runtime ? <div className={styles.runtime}>
        <h3>后台与模型状态</h3>
        {report.runtime.worker ? <p>{report.runtime.worker.scope === "all_sources" ? "全部来源共用执行服务" : "当前来源执行服务"}：{workerNames[report.runtime.worker.status] ?? "未知"}；最近心跳 {time(report.runtime.worker.lastSeenAt)}。</p> : <p>执行服务心跳尚未接入。</p>}
        {report.runtime.model ? <p>模型：{admissionNames[report.runtime.model.admission] ?? "未知"}；{report.runtime.model.quotaDay}（UTC）已记录 {report.runtime.model.calls} 次调用，{report.runtime.model.pendingReservations} 项预留，{report.runtime.model.unknownRequests} 项未知请求。{report.runtime.model.completeCostMicroUsd === null ? "费用结算不完整。" : "费用以管理员预算账本为准。"}</p> : <p>此来源模型预算尚未接入。</p>}
      </div> : <p className={styles.note}>来源心跳和模型预算尚未接入此查询；可在已有后台预算与执行服务页面查看。</p>}
      {report.runs.length > 0 && <div className={styles.tableWrap}><table><caption>采集与分析任务：当前页 {report.runs.length} 条</caption><thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">最近失败</th><th scope="col">首次等待</th><th scope="col">最近一次执行</th></tr></thead><tbody>{report.runs.map(run => <tr key={run.id}><td>{run.kind === "crawl" ? "采集" : "分析"}<code>{run.id}</code><small>创建 {time(run.createdAt)}；版本 {run.revision}</small></td><td>{statusNames[run.status] ?? "未知"}<small>第 {run.attempt} 次尝试</small></td><td>{run.latestFailure ? <>{failureNames[run.latestFailure.category] ?? "未分类错误"}<small>{time(run.latestFailure.occurredAt)}</small></> : "未记录失败"}</td><td>{duration(run.initialQueueWaitMs)}{run.queuedAgeMs !== null && <small>当前已等待 {duration(run.queuedAgeMs)}</small>}</td><td>{duration(run.latestAttemptDurationMs)}<small>{run.durationBasis === "running_elapsed" ? "仍在执行，仅当前耗时" : run.durationBasis === "latest_failure" ? "至最近失败" : run.durationBasis === "finished" ? "至记录结束" : "缺少时间记录"}</small></td></tr>)}</tbody></table></div>}
      <div className={styles.pagination}><button type="button" disabled={pending || !report.nextCursor} onClick={() => { setCursorSource(sourceId); setCursor(report.nextCursor); }}>下一页</button><span>后续页沿用原统计窗口；游标 30 分钟有效。</span></div>
    </>}
  </section>;
}
