"use client";
import { useEffect, useState } from "react";
import { api, dateText, message, useApi } from "./client-api.ts";
import { Feedback } from "./site-shell.tsx";
import styles from "./site.module.css";

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(true); setError(""); setNotice("");
    try { const result = await work(); if (success) setNotice(success); return result; }
    catch (reason) { setError(message(reason)); return undefined; }
    finally { setBusy(false); }
  }
  return { busy, error, notice, run, setError, setNotice };
}
export interface JobView { id: string; status: string; failureCode?: string | null; errorCode?: string | null; startedAt?: string | null; finishedAt?: string | null; execution?: { status: string; errorCode: string | null; sourceRevision: number; updatedAt: string } }
const jobLabels: Record<string, string> = { queued: "已排队", running: "处理中", succeeded: "已生成待确认结果", failed: "失败", cancelled: "已取消", abandoned: "已结束", unknown: "执行结果尚未核实" };
export function JobProgress({ path, onComplete }: { path: string; onComplete?: () => Promise<void> }) {
  const state = useApi<JobView>(path);
  const executionStopped = state.data?.execution && ["failed", "cancelled", "unknown"].includes(state.data.execution.status);
  const status = executionStopped ? state.data!.execution!.status : state.data?.status;
  const failureCode = state.data?.execution?.errorCode ?? state.data?.failureCode ?? state.data?.errorCode;
  const terminal = Boolean(status && ["succeeded", "failed", "cancelled", "abandoned", "unknown"].includes(status));
  useEffect(() => { if (terminal || state.error) return; const timer = setInterval(() => void state.reload(), 4000); return () => clearInterval(timer); }, [terminal, state.error, state.reload]);
  return <div className={styles.panel} aria-live="polite"><p><strong>任务状态：{status ? jobLabels[status] ?? status : "读取中"}</strong></p><Feedback error={state.error}/>{failureCode ? <p className={styles.error}>错误类别：{failureCode}</p> : null}{status === "unknown" && <p className={styles.notice}>调用结果尚未核实，为避免重复费用，本次任务不会自动重发。</p>}{state.data?.finishedAt && <p className={styles.muted}>结束于 {dateText(state.data.finishedAt)}</p>}<div className={styles.actions}><button type="button" className={styles.secondary} disabled={state.loading} onClick={() => void state.reload()}>刷新任务状态</button>{status === "succeeded" && onComplete && <button type="button" className={styles.button} onClick={() => void onComplete()}>载入实际结果</button>}</div><p className={styles.muted}>状态来自服务端。生成结果仍需核对内容和当前版本，不能自动替团队确认。</p></div>;
}
export async function downloadExport(path: string, body: unknown, filename: string) {
  const response = await fetch(`/api/v1${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message ?? "导出未完成。"); }
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
export { api };
