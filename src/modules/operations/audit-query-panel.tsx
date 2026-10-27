"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { auditActions, auditObjectKinds } from "./audit-query-types.ts";
import type { AuditAction, AuditObjectKind, AuditQueryInput, AuditQueryPage } from "./audit-query-types.ts";
import styles from "./audit-query-panel.module.css";

export interface AdminAuditPanelProps {
  /** Root must register an admin-only GET; this component never grants access. */
  readonly endpoint?: string;
  readonly loadPage?: (input: AuditQueryInput, signal: AbortSignal) => Promise<AuditQueryPage>;
  readonly initialPage?: AuditQueryPage;
  /** Preserve server-rendered filters so the signed cursor can load the next page. */
  readonly initialInput?: Omit<AuditQueryInput, "cursor">;
}
export function createAdminAuditLoader(endpoint: string) {
  if (!endpoint.startsWith("/api/") || endpoint.startsWith("//") || /[?#\\]/.test(endpoint)) throw new Error("Audit endpoint must be a same-origin API path");
  return async (input: AuditQueryInput, signal: AbortSignal): Promise<AuditQueryPage> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    const response = await fetch(`${endpoint}?${query}`, { credentials: "same-origin", cache: "no-store", signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "当前账号无审计查询权限，请重新登录或联系管理员。" : "审计读取失败，请重新查询。");
    const body = await response.json() as { data?: AuditQueryPage };
    if (!body.data || !Array.isArray(body.data.items) || !body.data.window) throw new Error("审计返回格式无效，请重新查询。");
    return body.data;
  };
}
const objectLabels: Record<AuditObjectKind, string> = { source: "采集来源", run: "采集与分析任务", event: "公开赛事", resource: "策展资源", correction: "纠错处理", scheduler: "发现调度" };
const actionLabels: Partial<Record<AuditAction, string>> = {
  SourceProposed: "登记来源", SourceConfigRevised: "修订来源", SourceEnabled: "启用来源", SourcePaused: "暂停来源",
  RunFailed: "任务失败", RunCancelled: "取消任务", RunClaimed: "领取任务", RunLeaseReclaimed: "回收超时任务",
  CrawlRunQueued: "创建采集任务", AnalysisRunQueued: "创建分析任务", AnalysisInputReused: "复用既有分析", CrawlCandidateReady: "采集候选就绪", AnalysisValidated: "分析通过校验",
  candidate_approved: "批准赛事候选", event_published: "发布赛事", event_withdrawn: "撤下赛事",
  resource_approved: "批准资源", resource_published: "发布资源", resource_withdrawn: "撤下资源",
  correction_resolved: "解决纠错", discovery_paused: "暂停自动发现", discovery_resumed: "恢复自动发现", unrecognized: "未识别动作",
};
const dateLabel = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

const localInput = (value: string | undefined) => value ? new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(0, 16) : "";
export function AdminAuditPanel({ endpoint = "/api/v1/admin/operations/audit", loadPage, initialPage, initialInput }: AdminAuditPanelProps) {
  const id = useId();
  const [page, setPage] = useState<AuditQueryPage | null>(initialPage ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actorId, setActorId] = useState(initialInput?.actorId ?? "");
  const [objectId, setObjectId] = useState(initialInput?.objectId ?? "");
  const [objectKind, setObjectKind] = useState(initialInput?.objectKind ?? "");
  const [action, setAction] = useState(initialInput?.action ?? "");
  const [revision, setRevision] = useState(initialInput?.revision?.toString() ?? "");
  const [from, setFrom] = useState(localInput(initialInput?.from));
  const [to, setTo] = useState(localInput(initialInput?.to));
  const [applied, setApplied] = useState<AuditQueryInput>(initialInput ?? { limit: 50 });
  const request = useRef<AbortController | null>(null);
  const serial = useRef(0);
  const loaderRef = useRef(loadPage ?? createAdminAuditLoader(endpoint));
  loaderRef.current = loadPage ?? createAdminAuditLoader(endpoint);

  async function read(input: AuditQueryInput) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const current = ++serial.current;
    setPending(true); setError(null);
    try {
      const result = await loaderRef.current(input, controller.signal);
      if (current !== serial.current || controller.signal.aborted) return;
      setPage(result); setApplied({ ...input, cursor: undefined });
    } catch {
      if (current !== serial.current || controller.signal.aborted) return;
      setPage(null); setError("无法读取审计记录，请确认当前账号有管理员权限后重新查询。");
    } finally { if (current === serial.current && !controller.signal.aborted) setPending(false); }
  }
  useEffect(() => {
    const input = initialInput ?? { limit: 50 };
    if (initialPage) { setPage(initialPage); setApplied(input); }
    else void read(input);
    setActorId(input.actorId ?? ""); setObjectId(input.objectId ?? ""); setObjectKind(input.objectKind ?? ""); setAction(input.action ?? "");
    setRevision(input.revision?.toString() ?? ""); setFrom(localInput(input.from)); setTo(localInput(input.to));
    return () => { serial.current++; request.current?.abort(); };
  }, [initialPage, initialInput, endpoint, loadPage]);
  function search(event: FormEvent) {
    event.preventDefault();
    const date = (value: string) => value ? new Date(`${value.length === 16 ? `${value}:00` : value}+08:00`).toISOString() : undefined;
    try {
      void read({ actorId: actorId.trim() || undefined, objectId: objectId.trim() || undefined, objectKind: (objectKind || undefined) as AuditObjectKind | undefined,
        action: (action || undefined) as AuditAction | undefined, revision: revision ? Number(revision) : undefined, from: date(from), to: date(to), limit: 50 });
    } catch { setError("时间格式无效，请重新填写起止时间。"); }
  }
  return <section className={styles.panel} aria-labelledby={`${id}-title`} aria-busy={pending}>
    <div className={styles.heading}><div><h2 id={`${id}-title`}>运营审计</h2><p>查看谁在什么时间更改了哪个公开运营对象。每次最多 50 条，默认最近 7 天，最长 31 天。</p></div></div>
    <form onSubmit={search} className={styles.filters}>
      <label htmlFor={`${id}-actor`}>操作者标识<input id={`${id}-actor`} value={actorId} onChange={event => setActorId(event.target.value)} maxLength={200} autoComplete="off" /></label>
      <label htmlFor={`${id}-kind`}>对象类型<select id={`${id}-kind`} value={objectKind} onChange={event => setObjectKind(event.target.value)}><option value="">全部</option>{auditObjectKinds.map(kind => <option key={kind} value={kind}>{objectLabels[kind]}</option>)}</select></label>
      <label htmlFor={`${id}-object`}>对象标识<input id={`${id}-object`} value={objectId} onChange={event => setObjectId(event.target.value)} maxLength={200} autoComplete="off" /></label>
      <label htmlFor={`${id}-action`}>动作<select id={`${id}-action`} value={action} onChange={event => setAction(event.target.value)}><option value="">全部</option>{auditActions.map(item => <option key={item} value={item}>{actionLabels[item] ?? item}</option>)}</select></label>
      <label htmlFor={`${id}-revision`}>审计版本<input id={`${id}-revision`} type="number" min={1} step={1} value={revision} onChange={event => setRevision(event.target.value)} /></label>
      <label htmlFor={`${id}-from`}>起始时间（UTC+8）<input id={`${id}-from`} type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label htmlFor={`${id}-to`}>结束时间（UTC+8）<input id={`${id}-to`} type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
      <button type="submit" disabled={pending}>{pending ? "正在读取…" : "查询记录"}</button>
    </form>
    <p className={styles.note}>仅展示操作元数据。审计版本来自来源、任务或审核记录；内容版本单独列出。资源撤下无审核版本时显示该资源版本。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {pending && <p role="status">正在读取已保存的审计记录…</p>}
    {page && <>
      <p className={styles.window}>当前查询：{dateLabel(page.window.from)} 至 {dateLabel(page.window.to)}（UTC+8），{page.items.length} 条。</p>
      {page.items.length ? <div className={styles.tableWrap}><table><caption>公开内容运营的操作记录</caption><thead><tr><th scope="col">时间（UTC+8）</th><th scope="col">操作者</th><th scope="col">动作</th><th scope="col">对象</th><th scope="col">版本</th></tr></thead><tbody>{page.items.map(entry => <tr key={entry.id}>
        <td><time dateTime={entry.occurredAt}>{dateLabel(entry.occurredAt)}</time></td><td>{entry.actorKind === "worker" ? "执行服务" : "账号"}<code>{entry.actorId}</code></td>
        <td>{actionLabels[entry.action] ?? entry.action}</td><td>{objectLabels[entry.objectKind]}<code>{entry.objectId}</code></td>
        <td>审计 {entry.revision}{entry.contentVersion !== null && <span className={styles.contentVersion}>内容 {entry.contentVersion}</span>}</td>
      </tr>)}</tbody></table></div> : <p className={styles.empty}>这个时间窗口和筛选条件下没有记录。可调整筛选后重新查询。</p>}
      <div className={styles.pagination}><button type="button" disabled={pending || !page.nextCursor} onClick={() => void read({ ...applied, cursor: page.nextCursor ?? undefined })}>下一页</button><span>查询游标 15 分钟有效；过期后重新查询。</span></div>
    </>}
  </section>;
}
