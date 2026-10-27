"use client";
import { useEffect, useRef } from "react";
import { useApi } from "./client-api.ts";
import { InspirationCatalog } from "./inspiration-catalog.tsx";
import { inspirationCandidates } from "../server/inspiration-catalog.ts";
import type { InspirationFeed } from "../server/inspiration.ts";

export function InspirationLive() {
  const feed = useApi<InspirationFeed>("/inspiration", { timeoutMs: 10000 });
  const reload = useRef(feed.reload); reload.current = feed.reload;
  const loading = useRef(feed.loading); loading.current = feed.loading;
  useEffect(() => {
    let stopped=false, polling=false; let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (stopped || polling || loading.current || document.visibilityState === "hidden") return;
      polling=true;
      try { await reload.current(); } finally {polling=false;}
    };
    const schedule = () => { clearTimeout(timer); if (!stopped && document.visibilityState !== "hidden") timer=setTimeout(async () => { await refresh(); schedule(); },10000); };
    const visible = () => { clearTimeout(timer); if (document.visibilityState !== "hidden") void refresh().finally(schedule); };
    schedule(); document.addEventListener("visibilitychange",visible);
    return () => { stopped=true; clearTimeout(timer); document.removeEventListener("visibilitychange",visible); };
  },[]);
  return <>
    {feed.error && <p role="alert">{feed.error.message} 已保存的灵感会继续保留，连接恢复后自动刷新。<button type="button" onClick={() => void feed.reload()}>重试读取</button></p>}
    <InspirationCatalog items={feed.data?.items ?? []} pendingItems={feed.data?.pendingItems ?? inspirationCandidates} status={feed.data?.status ?? {kind:"dsh",message:feed.loading ? "正在读取 DSH 分析结果…" : "暂时无法读取灵感更新状态"}} />
  </>;
}
