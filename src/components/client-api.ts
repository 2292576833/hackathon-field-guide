"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isPublicApiRead } from "../shared/public-api.ts";
import { createInflightReadGroup, isSharedRead, waitForRead } from "./inflight-read.ts";

const sharedReads = createInflightReadGroup();

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly requestId?: string) { super(message); }
}
/** A rejected draft is a known response; transport failures may still have saved work. */
export function isUnknownAiOutcome(reason: unknown): boolean {
  if (!(reason instanceof ApiError)) return true;
  if (["INVALID_PARTICIPATION_OUTPUT", "PPT_OUTPUT_INVALID", "ROADSHOW_OUTPUT_INVALID", "AI_RESPONSE_INVALID", "DSH_NOT_CONFIGURED", "AI_NOT_CONFIGURED"].includes(reason.code)) return false;
  return reason.status >= 500 || /UNKNOWN|UNCERTAIN|TIMEOUT|HOLD|LEASE_LOST|IN_PROGRESS/.test(reason.code);
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") sharedReads.clear();
  if (typeof window !== "undefined" && method === "GET" && options.body === undefined && !options.idempotencyKey && isSharedRead(path)) {
    const result = sharedReads.read<T>(path, () => requestApi<T>(path, { signal: AbortSignal.timeout(15000) }));
    // Separate object ownership; this is not an HTTP or cross-account cache.
    return structuredClone(await waitForRead(result, options.signal));
  }
  return requestApi<T>(path, options);
}
async function requestApi<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await fetch(`/api/v1${path}`, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: options.signal });
  let envelope: { data?: T; error?: { message?: string; code?: string }; requestId?: string };
  try { envelope = await response.json(); } catch { throw new ApiError("服务没有返回可读取的结果，请稍后重试。", response.status, "INVALID_RESPONSE"); }
  if (!response.ok || envelope.error) {
    const code = envelope.error?.code ?? "REQUEST_FAILED";
    const websiteSessionExpired = response.status === 401 && ["UNAUTHENTICATED", "AUTH_SESSION_REQUIRED", "AUTH_SESSION_EXPIRED", "AUTH_SESSION_REVOKED"].includes(code);
    if (websiteSessionExpired && typeof window !== "undefined") { sharedReads.clear(); window.dispatchEvent(new Event("hackathon:unauthenticated")); }
    throw new ApiError(websiteSessionExpired ? "登录已失效，请重新登录。请重新打开项目后继续。" : envelope.error?.message ?? "操作未完成，请重试。", response.status, code, envelope.requestId);
  }
  if (!("data" in envelope)) throw new ApiError("服务返回缺少结果，请刷新后重试。", 502, "INVALID_RESPONSE");
  return envelope.data as T;
}
export function useApi<T>(path: string | null, options: { timeoutMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const generation = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    activeRead.current?.abort();
    if (!path) { setData(null); setLoading(false); return; }
    setLoading(true); setError(null);
    const controller = new AbortController();
    activeRead.current = controller;
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs) : undefined;
    try { const next = await api<T>(path, { signal: controller.signal }); if (generation.current === current) setData(next); }
    catch (reason) { if (generation.current === current) { if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) setData(null); setError(timedOut ? new Error("读取超时，请稍后重试。") : reason instanceof Error ? reason : new Error("读取失败。")); } }
    finally { clearTimeout(timer); if (activeRead.current === controller) activeRead.current = null; if (generation.current === current) setLoading(false); }
  }, [path, options.timeoutMs]);
  useEffect(() => { setData(null); void reload(); return () => { generation.current++; activeRead.current?.abort(); }; }, [reload]);
  useEffect(() => {
    if (!path || isPublicApiRead(path)) return;
    const clear = () => { generation.current++; activeRead.current?.abort(); setData(null); setLoading(false); setError(new ApiError("登录已失效，请重新登录。", 401, "UNAUTHENTICATED")); };
    window.addEventListener("hackathon:unauthenticated", clear); return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, [path]);
  return { data, error, loading, reload, setData };
}
export function message(error: unknown): string { return error instanceof Error ? error.message : "操作未完成，输入已保留。"; }
export function operationKey(): string { return crypto.randomUUID(); }
export function lines(value: string): string[] { return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); }
export function chinaInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("请填写完整的北京时间。 ");
  const result = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(result.getTime())) throw new Error("时间无效。");
  return result.toISOString();
}
export function localInput(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
export function dateText(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + "（北京时间）";
}
export function safeLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; }
}
