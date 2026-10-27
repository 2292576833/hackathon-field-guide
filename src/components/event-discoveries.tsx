"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, dateText, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Loading, type Me, type SystemStatus } from "./site-shell.tsx";
import { DiscoveryClaimAction } from "./discovery-claim.tsx";
import styles from "./site.module.css";
import feedStyles from "./event-discoveries.module.css";
import { isRegistrationWindowOpen, type RegistrationWindow } from "../shared/registration-window.ts";
import type { EventWindow } from "../shared/event-window.ts";
import { coveredFeedRevision, shouldRefreshEventFeed } from "./event-feed-refresh.ts";
interface Discovery {
  id: string; canonicalUrl: string; title: string; summary: string;
  analysis: { fit: string | string[]; risks: string | string[]; preparation: string | string[]; unknowns: string | string[] };
  sources: { url: string; title: string; excerpt: string; fetchedAt: string; sourceKind?: "page" | "indexed_excerpt" }[];
  lastAnalyzedAt: string; verificationStatus: "unverified";
  registration?: unknown; participation?: unknown; registrationWindow?: RegistrationWindow; eventWindow?: EventWindow;
}
interface LiveDiscovery {
  version: string; count: number;
  state: "running" | "waiting" | "paused" | "limited" | "attention" | "offline" | "unconfigured";
  minimumIntervalMs: number | null; lastCompletedAt: string | null; nextEligibleAt: string | null;
}
interface DiscoveryPage { items: Discovery[]; nextCursor: string | null; version?: string }
interface CardReadState { cursor: string; data: DiscoveryPage | null; error: Error | null; loading: boolean }
const brief = (value: string, maximum: number) => { const characters = Array.from(value); return characters.length > maximum ? characters.slice(0, maximum).join("") + "…" : value; };
const originalLinkLabel = (url: string) => ["ethglobal.com", "lablab.ai"].includes(new URL(url).hostname) ? "前往比赛官网（新窗口）" : "查看赛事原文（新窗口）";
interface GuidanceCard {
  canonicalUrl: string;
  analysis: { fit: string | readonly string[]; risks: string | readonly string[]; preparation: string | readonly string[]; unknowns: string | readonly string[] };
  sources: readonly { url: string; excerpt: string; sourceKind?: "page" | "indexed_excerpt" }[];
  registration?: unknown; participation?: unknown; registrationWindow?: RegistrationWindow; eventWindow?: EventWindow;
}
interface Participation { recommendation: "consider" | "caution" | "insufficient_info"; reason: string; suitableFor: string[]; cautionFor: string[] }
const recommendationText: Record<Participation["recommendation"], string> = { consider: "值得了解", caution: "先核对再决定", insufficient_info: "信息不足，暂无法判断" };
const boundedText = (value: unknown, maximum: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const analysisItems = (value: string | readonly string[]) => (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).filter(item => boundedText(item, 600));
function participation(value: unknown): Participation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["recommendation", "reason", "suitableFor", "cautionFor"].includes(key)) ||
    typeof item.recommendation !== "string" || !["consider", "caution", "insufficient_info"].includes(item.recommendation) || !boundedText(item.reason, 600) ||
    !Array.isArray(item.suitableFor) || item.suitableFor.length > 8 || !item.suitableFor.every(value => boundedText(value, 600)) ||
    !Array.isArray(item.cautionFor) || item.cautionFor.length > 8 || !item.cautionFor.every(value => boundedText(value, 600))) return null;
  return item as unknown as Participation;
}
function registrationUrl(value: unknown): string | null {
  if (!boundedText(value, 2048) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const href = safeLink(value);
  if (!href) return null;
  const parsed = new URL(href);
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(host) ||
    /^(?:0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || /^\[(?:::|::1|f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/.test(host)) return null;
  if (/(?:^|\/)(?:login|signin|sign-in|signup|sign-up|oauth|authorize|redirect|redir|jump|out|external|go)(?:\/|$)/i.test(parsed.pathname) ||
    ["t.cn", "url.cn", "bit.ly", "tinyurl.com", "dwz.cn", "suo.im", "s.id", "buff.ly", "lnkd.in", "cutt.ly"].includes(host) ||
    [...parsed.searchParams].some(([key, item]) => /^(?:access_?token|token|password|session|sessionid|auth|code|apikey|api_key)$/i.test(key) ||
      /^(?:url|target|redirect|redirect_uri|redirect_url|return|returnurl|continue|next|dest|destination|link|u)$/i.test(key) && /^(?:https?:|\/\/|\/|%2f|%68%74%74%70)/i.test(item))) return null;
  return href;
}
function evidencedRegistration(card: GuidanceCard): { url: string; evidence: string } | null {
  const value = card.registration;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["url", "sourceUrl", "evidence"].includes(key)) || !boundedText(item.evidence, 500)) return null;
  const url = registrationUrl(item.url), sourceUrl = registrationUrl(item.sourceUrl);
  if (!url || !sourceUrl || !card.sources.some(source => registrationUrl(source.url) === sourceUrl && typeof source.excerpt === "string" && source.excerpt.includes(item.evidence as string))) return null;
  return { url, evidence: item.evidence };
}
/** Render only supplied DSH conclusions. Legacy cards receive no synthetic verdict. */
export function DiscoveryGuidance({ card, compact = true, previewOnly = false, groupClassName = "" }: { card: GuidanceCard; compact?: boolean; previewOnly?: boolean; groupClassName?: string }) {
  const advice = participation(card.participation);
  const unique = (values: readonly string[]) => [...new Set(values)];
  const groups = [
    ["适合谁", unique([...analysisItems(card.analysis.fit), ...(advice?.suitableFor ?? [])]), 2],
    ["需谨慎的情况", unique([...(advice?.cautionFor ?? []), ...analysisItems(card.analysis.risks)]), 1],
    ["准备下一步", analysisItems(card.analysis.preparation), 1],
    ["待确认", analysisItems(card.analysis.unknowns), 1],
  ] as const;
  return <div className={feedStyles.guidance}>
    {advice ? <><p className={`${feedStyles.verdict} ${feedStyles[advice.recommendation]}`}><strong>DSH 参赛建议：</strong>{recommendationText[advice.recommendation]}</p><p className={feedStyles.reason}>{compact ? brief(advice.reason, previewOnly ? 70 : 120) : advice.reason}</p></> : <p className={feedStyles.incomplete}>{previewOnly ? "参赛判断信息不完整，请展开已有分析并核对原文。" : "参赛判断信息不完整，以下保留已有 DSH 分析供核对。"}</p>}
    {previewOnly ? <>
      {groups[0][1].length > 0 && <p className={feedStyles.reason}><strong>适合谁：</strong><span>{brief(groups[0][1][0], 65)}</span></p>}
      {groups[1][1].length > 0 && <p className={feedStyles.reason}><strong>主要提醒：</strong><span>{brief(groups[1][1][0], 65)}</span></p>}
    </> : <div className={groupClassName}>{groups.map(([label, values, limit]) => <div className={feedStyles.guidanceGroup} key={label}>
      <strong>{label}：</strong>{values.length ? <ul>{(compact ? values.slice(0, limit) : values).map((value, index) => <li key={index}>{compact ? brief(value, 100) : value}</li>)}</ul> : <p className={styles.muted}>本次分析暂未提供，请另行核实。</p>}
    </div>)}</div>}
  </div>;
}
export function DiscoveryRegistrationLinks({ card, originalLabel }: { card: GuidanceCard; originalLabel?: string }) {
  const registration = evidencedRegistration(card), original = safeLink(card.canonicalUrl);
  return <div className={feedStyles.entryLinks}>
    {registration && <><a href={registration.url} className={styles.button} target="_blank" rel="noopener noreferrer">查看报名入口（新窗口）</a><p className={styles.muted}>报名入口来自来源证据；是否开放及资格请以主办方公告为准。</p></>}
    {original && <a href={original} className={registration ? styles.secondary : styles.button} target="_blank" rel="noopener noreferrer">{originalLabel ?? (card.sources.some(source => source.sourceKind === "indexed_excerpt") ? "查看赛事原文（新窗口）" : originalLinkLabel(original))}</a>}
  </div>;
}
export function DiscoveryRegistrationDeadline({ card, historical = false }: { card: GuidanceCard; historical?: boolean }) {
  const window = card.registrationWindow;
  if (!window) return null;
  const open = isRegistrationWindowOpen(window, new Date());
  const closed = window?.status === "closed";
  const cutoff = window.closesAt ? dateText(window.closesAt) : window.closesOn ? `${window.closesOn}（原文未说明时区）` : "未核实";
  return historical ? <p className={styles.muted}>本版本记录的报名截止：{cutoff}。当前报名状态请以主办方公告为准。</p>
    : <p className={styles.muted}><strong>{closed ? "报名已结束" : open ? "报名未截止" : "报名时间需重新确认"}</strong> · 报名截止：{cutoff}</p>;
}
export function DiscoveryEventDate({ card }: { card: GuidanceCard }) {
  const window = card.eventWindow;
  if (!window) return null;
  const start = window.startsAt ? dateText(window.startsAt) : window.startsOn ? `${window.startsOn}（北京时间日期）` : "未核实";
  return <p className={styles.muted}><strong>开赛时间：</strong>{start}{!card.registrationWindow || card.registrationWindow.status === "unknown" ? " · 报名时间待确认" : ""}</p>;
}
function DiscoveryInformation({ card }: { card: Discovery }) {
  const [expanded, setExpanded] = useState(false);
  return <details className={feedStyles.information} data-event-information onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className={feedStyles.informationToggle}><span>{expanded ? "收起比赛信息与建议" : "展开比赛信息与建议"}</span><span className={feedStyles.toggleMark} aria-hidden="true">⌄</span></summary>
    <div className={feedStyles.informationBody}>
      <p>{card.summary}</p>
      <DiscoveryGuidance card={card} compact={false}/>
      <div className={feedStyles.preparation}>
        <h4>选好这场比赛后，开始准备</h4>
        <p className={styles.muted}>先核对报名要求。个人计划保存在本人账号；团队空间用于和队友协作。</p>
        <div className={styles.actions}><Link className={styles.secondary} href={`/participation?event=${encodeURIComponent(card.id)}`} onClick={() => { try { sessionStorage.setItem("participation:generate-event", card.id); } catch { /* Generation still requires an explicit button. */ } }}>制定我的参赛计划</Link><Link className={styles.link} href={`/app?event=${encodeURIComponent(card.id)}`}>在团队空间继续</Link></div>
      </div>
      <details><summary className={styles.summary}>查看分析依据</summary>{card.sources.map((source, index) => <div key={`${source.url}:${index}`}>
        <a className={styles.link} href={safeLink(source.url) ?? undefined} target="_blank" rel="noopener noreferrer">{source.title}</a>
        <p>{source.excerpt}</p><p className={styles.muted}>{source.sourceKind === "indexed_excerpt" ? "搜索引用获取于" : "页面获取于"} {dateText(source.fetchedAt)}</p>
      </div>)}</details>
      <p className={styles.muted}>分析于 {dateText(card.lastAnalyzedAt)}</p>
    </div>
  </details>;
}
const minimumCardSlots = 24;
function WaitingSlot({ className = "" }: { className?: string }) {
  return <div className={`${feedStyles.placeholder} ${className}`}>
    <span className={feedStyles.placeholderMark} aria-hidden="true">＋</span>
    <strong>等待新赛事分析</strong>
    <p>预留展示位置，有新分析结果时在这里显示。</p>
  </div>;
}
export function EventDiscoveryFeed() {
  const [cursor, setCursor] = useState("");
  const [hasUpdates, setHasUpdates] = useState(false);
  // 比赛页上的主办方认领入口需要当前登录状态与登录回跳地址。
  const identity = useApi<Me>("/me");
  const signedIn = Boolean(identity.data);
  const loginHref = `/login?returnTo=${encodeURIComponent("/events")}`;
  const knownVersion = useRef({ version: null as string | null, revision: 0 });
  const [cards, setCards] = useState<CardReadState>({ cursor: "", data: null, error: null, loading: true });
  const reloadCards = useRef<() => Promise<void>>(async () => {});
  const state = cards.cursor === cursor ? cards : { data: null, error: null, loading: true };
  const status = useApi<SystemStatus>("/system/status");
  const visibleItems = state.data?.items ?? [];
  const placeholderCount = !cursor && state.data && !state.error ? Math.max(0, minimumCardSlots - visibleItems.length) : 0;
  const mobileVisiblePlaceholderCount = Math.min(placeholderCount, Math.max(0, 6 - visibleItems.length));
  const mobileFoldedPlaceholderCount = placeholderCount - mobileVisiblePlaceholderCount;
  async function refresh() { await Promise.all([reloadCards.current(), status.reload()]); }
  function returnToLatest() { setHasUpdates(false); setCursor(""); }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    let activeRequest: AbortController | null = null;
    let listRequest: { controller: AbortController; promise: Promise<void> } | null = null;
    let currentData: DiscoveryPage | null = null;
    let cardError: Error | null = null;
    let handledRevision = knownVersion.current.revision;
    const snapshotVersion = () => typeof currentData?.version === "string" ? currentData.version : null;
    const needsRefresh = () => shouldRefreshEventFeed({ cursor, loading: listRequest !== null, failed: cardError !== null,
      snapshotVersion: snapshotVersion(), observedVersion: knownVersion.current.version,
      observedRevision: knownVersion.current.revision, handledRevision });
    function readCards(): Promise<void> {
      if (stopped) return Promise.resolve();
      // Manual retries and metadata ticks join the same read rather than cancelling it.
      if (listRequest) return listRequest.promise;
      const controller = new AbortController();
      const startedRevision = knownVersion.current.revision;
      let timedOut = false, succeeded = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
      cardError = null;
      setCards({ cursor, data: currentData, error: null, loading: true });
      const request = { controller, promise: Promise.resolve() };
      listRequest = request;
      request.promise = (async () => {
        try {
          const next = await api<DiscoveryPage>(`/event-discoveries?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: controller.signal });
          if (stopped || listRequest !== request) return;
          currentData = next;
          handledRevision = coveredFeedRevision(startedRevision, knownVersion.current.revision, snapshotVersion(), knownVersion.current.version);
          succeeded = true;
        } catch (reason) {
          if (stopped || listRequest !== request) return;
          cardError = timedOut ? new Error("读取超时，请稍后重试。") : reason instanceof Error ? reason : new Error("读取失败。");
        } finally {
          clearTimeout(deadline);
          if (!stopped && listRequest === request) {
            listRequest = null;
            setCards({ cursor, data: currentData, error: cardError, loading: false });
            // Only successful reads catch up immediately. A failure waits for the next
            // metadata tick, including when that tick reports an unchanged version.
            if (succeeded && document.visibilityState === "visible" && needsRefresh()) void readCards();
          }
        }
      })();
      return request.promise;
    }
    reloadCards.current = readCards;
    async function checkForUpdates() {
      if (stopped || document.visibilityState !== "visible" || activeRequest) return;
      const controller = new AbortController();
      activeRequest = controller;
      const deadline = setTimeout(() => controller.abort(), 10000);
      requestTimeout = deadline;
      try {
        // This endpoint only reads saved metadata; browser activity never starts a search.
        const next = await api<LiveDiscovery>("/event-discoveries/live", { signal: controller.signal });
        if (stopped || activeRequest !== controller || document.visibilityState !== "visible") return;
        const previous = knownVersion.current.version;
        const changed = previous !== next.version;
        if (changed) knownVersion.current = { version: next.version, revision: knownVersion.current.revision + 1 };
        if (snapshotVersion() === next.version) handledRevision = knownVersion.current.revision;
        if (!cursor && needsRefresh()) { setHasUpdates(false); void readCards(); }
        else if (cursor && changed && (previous !== null || snapshotVersion() !== null && snapshotVersion() !== next.version)) setHasUpdates(true);
      } catch {
        // A failed metadata read only skips this tick; the next tick retries and cards stay readable.
      } finally {
        clearTimeout(deadline);
        if (activeRequest === controller) {
          requestTimeout = undefined;
          activeRequest = null;
          if (!stopped && document.visibilityState === "visible") timer = setTimeout(() => void checkForUpdates(), 3000);
        }
      }
    }
    function onVisibilityChange() {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") { clearTimeout(requestTimeout); requestTimeout = undefined; activeRequest?.abort(); activeRequest = null; }
      else void checkForUpdates();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void readCards();
    void checkForUpdates();
    return () => { stopped = true; clearTimeout(timer); clearTimeout(requestTimeout); activeRequest?.abort(); listRequest?.controller.abort(); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [cursor]);
  return <section className={styles.panel}>
    <div className={feedStyles.heading}><h2>比赛分析</h2>{state.data && <span className={styles.muted}>本页 {visibleItems.length} 个分析结果</span>}</div>
    <p className={styles.muted}>先看时间和报名入口，展开卡片查看比赛信息与参赛建议。</p>
    {cursor && hasUpdates && <div className={feedStyles.updateNotice} role="status"><span>已有新的比赛分析，当前阅读位置已保留。</span><button className={styles.secondary} onClick={returnToLatest}>查看最新比赛</button></div>}
    <Feedback error={state.error}/>
    {state.error && <button className={styles.secondary} disabled={state.loading} onClick={() => void refresh()}>重新加载比赛</button>}
    {state.loading && !state.data && <Loading/>}
    {state.data && visibleItems.length === 0 && !state.loading && !state.error && <Empty>
      {cursor ? "这一页暂时没有更多比赛，可以返回最新结果。" : status.data?.discoveryConfigured === false ? "自动收集尚未启用，暂时没有比赛分析。" : <><p>暂时没有已保存的比赛分析。后台会继续搜索和分析，完成后自动显示。</p><details className={styles.card}><summary className={styles.summary}>为什么暂时看不到比赛？</summary><p className={styles.muted}>DSH 需要先从来源取得可核对的赛事正文并完成分析；当前日期、报名状态或开赛日期不会再把已保存的分析从这里过滤掉。</p></details></>}
    </Empty>}
    <div className={feedStyles.grid}>{visibleItems.map(item => <article className={`${styles.card} ${feedStyles.card}`} key={item.id}>
      {item.sources.some(source => source.sourceKind === "indexed_excerpt") && <p className={styles.muted}>搜索引用 · 未读取全文，请打开原文确认完整规则。</p>}
      <h3>{item.title}</h3><DiscoveryEventDate card={item}/>
      <DiscoveryRegistrationDeadline card={item}/>
      <DiscoveryRegistrationLinks card={item}/>
      <DiscoveryInformation card={item}/>
      <DiscoveryClaimAction discoveryId={item.id} signedIn={signedIn} loginHref={loginHref}/>
    </article>)}
      {Array.from({ length: placeholderCount }, (_, index) => <WaitingSlot className={index >= mobileVisiblePlaceholderCount ? feedStyles.extraPlaceholder : ""} key={`waiting-${index}`}/>)}
    </div>
    {mobileFoldedPlaceholderCount > 0 && <details className={feedStyles.pendingPositions}>
      <summary className={styles.summary}>更多待更新位置（{mobileFoldedPlaceholderCount} 个）</summary>
      <div className={feedStyles.grid}>{Array.from({ length: mobileFoldedPlaceholderCount }, (_, index) => <WaitingSlot key={`mobile-waiting-${index}`}/>)}</div>
    </details>}
    <div className={styles.actions}>
      {cursor && <button className={styles.secondary} disabled={state.loading} onClick={returnToLatest}>返回最新比赛</button>}
      {state.data?.nextCursor && <button className={styles.secondary} disabled={state.loading} onClick={() => setCursor(state.data?.nextCursor ?? "")}>查看更多比赛</button>}
    </div>
  </section>;
}
