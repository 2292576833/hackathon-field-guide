"use client";
import { useEffect, useState } from "react";
import type { OwnPlanningNotification } from "./notification-types.ts";

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal });
  const result = await response.json() as { data?: T; error?: { message?: string } };
  if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("hackathon:unauthenticated"));
  if (!response.ok) throw new Error(result.error?.message ?? "暂时无法读取提醒，请稍后重试。");
  return result.data as T;
}
/** Root supplies verified current user ID; changing account clears the previous private list immediately. */
export function PlanningNotificationsPanel({ viewerId, projectId }: { viewerId: string | null; projectId?: string }) {
  const [state, setState] = useState<{ owner: string | null; items: OwnPlanningNotification[] }>({ owner: null, items: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [lostViewerId, setLostViewerId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setError(""); setState({ owner: viewerId, items: [] });
    if (!viewerId || lostViewerId === viewerId) { setLoading(false); if (viewerId) setError("登录已失效，请重新登录后查看自己的提醒。"); return () => controller.abort(); }
    const clearSession = () => { controller.abort(); setLostViewerId(viewerId); setState({ owner: null, items: [] }); setLoading(false); setError("登录已失效，请重新登录后查看自己的提醒。"); };
    window.addEventListener("hackathon:unauthenticated", clearSession);
    const path = `/me/planning-notifications?limit=100${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`;
    /** 后台重读：只更新列表，**不自动标记已读**、也不清空当前内容（避免列表闪空）。 */
    const reread = () => { call<OwnPlanningNotification[]>(path, undefined, controller.signal)
      .then(items => { if (!controller.signal.aborted) setState({ owner: viewerId, items }); })
      .catch(() => { /* 后台重读失败保留当前列表；用户仍可手动刷新看到错误 */ }); };
    setLoading(true);
    call<OwnPlanningNotification[]>(path, undefined, controller.signal).then(items => { if (!controller.signal.aborted) setState({ owner: viewerId, items }); }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "提醒读取失败。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    // 规划31 第1.3项：提醒由后台 worker 每 30 秒生成，但此前这个面板只读一次，
    // 用户不点「刷新提醒」就永远看不到新提醒。这里跟随可见页面重读（隐藏标签页不轮询）。
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reread(); }, 30_000);
    const visible = () => { if (document.visibilityState === "visible") reread(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("hackathon:unauthenticated", clearSession); };
  }, [viewerId, projectId, refresh, lostViewerId]);
  async function act(item: OwnPlanningNotification, action: "read" | "dismiss") {
    setBusy(item.id); setError("");
    try { await call(`/me/planning-notifications/${encodeURIComponent(item.id)}/${action}`, { expectedRevision: item.revision }); setRefresh(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提醒处理失败。"); setRefresh(value => value + 1); }
    finally { setBusy(null); }
  }
  const items = state.owner === viewerId ? state.items.filter(item => !projectId || item.projectId === projectId) : [];
  if (!viewerId) return <section aria-label="参赛提醒"><h2>参赛提醒</h2><p>登录后查看自己的计划和任务提醒。</p></section>;
  return <section aria-label="参赛提醒" style={{ border: "1px solid var(--line, #ded8cf)", borderRadius: 16, padding: 20 }}>
    <h2>参赛提醒</h2>
    <p>已读只表示你看过提醒。处理任务或计划后，可以收起已处理的提醒。</p>
    <button type="button" disabled={loading || busy !== null} onClick={() => setRefresh(value => value + 1)}>刷新提醒</button>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">正在读取已保存的提醒…</p>}
    {!loading && !items.length && !error && <p>目前没有需要查看的提醒。</p>}
    <ul style={{ paddingLeft: 20 }}>{items.map(item => <li key={item.id} style={{ marginTop: 16 }}>
      <strong>{item.title}</strong> · {item.readAt ? "已读" : "未读"} · {item.status === "archived" ? "项目已归档" : item.status === "resolved" ? "当前依据已不再触发此提醒" : item.requiresAction ? "需要核对" : "安排更新"}
      <p>{item.message}</p>
      <a href={item.href}>查看相关安排</a>{" "}
      {!item.readAt && <button type="button" disabled={busy !== null} onClick={() => void act(item, "read")}>标为已读</button>}{" "}
      <button type="button" disabled={busy !== null} onClick={() => void act(item, "dismiss")}>{item.status === "archived" ? "收起归档提醒" : item.requiresAction ? "收起已处理提醒" : "已知悉，收起"}</button>
    </li>)}</ul>
  </section>;
}
