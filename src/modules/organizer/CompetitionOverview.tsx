"use client";

import type { ReactNode } from "react";
import { useApi } from "../../components/client-api.ts";
import type { EventModuleKey } from "../../shared/organizer-contracts.ts";
import type { PublicCompetition } from "./model.ts";
import styles from "./organizer.module.css";

export interface CompetitionOverviewProps {
  readonly eventId: string;
  readonly directoryHref?: string;
  readonly signedIn?: boolean;
  readonly loginHref?: string;
  readonly moduleLinks?: Partial<Record<EventModuleKey, string>>;
  readonly participationSlot?: ReactNode;
}
export function competitionDate(value: string | null, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "待主办方明确";
  try { return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { return new Date(value).toISOString(); }
}
export const competitionModuleLabels: Record<EventModuleKey, string> = { registration: "报名", teams: "组队", icebreaking: "赛前交流", judging: "作品与评审", schedule: "行程", accommodation: "住宿", mealVouchers: "餐券" };

/**
 * 同一主办方的其他正式比赛（只读互链）。
 *
 * 依据：竞品公开详情页会互相链接同一主办方的其他活动（赛氪详情页「同主办方其他赛事」，REA 观测
 * `ev_22a5f1b3…`）。它只服务"找比赛"这一步：复用既有公开目录接口 `/competitions` 的**已发布**事实，
 * 不新增接口、不新增字段、不写任何状态，也不做排序推荐（按报名截止时间排列，缺失的排在后面）。
 */
function SameOrganizerEvents({ eventId, organizationId, organizationName, directoryHref }: { eventId: string; organizationId: string; organizationName: string; directoryHref: string }) {
  const directory = useApi<PublicCompetition[]>("/competitions");
  const others = (directory.data ?? [])
    .filter(item => item.organizationId === organizationId && item.eventId !== eventId && item.status === "published" && item.availability === "available")
    .sort((left, right) => (left.registrationClosesAt ?? left.startsAt).localeCompare(right.registrationClosesAt ?? right.startsAt))
    .slice(0, 5);
  if (!others.length) return null;
  return <section className={styles.panel} aria-label="同一主办方的其他比赛">
    <h3>同一主办方的其他正式比赛</h3>
    <p className={styles.muted}>{organizationName} 目前还有 {others.length} 场正在公开的比赛。这里是只读链接，是否参加由你决定。</p>
    <ul className={styles.stack}>{others.map(item => <li key={item.eventId}>
      <a className={styles.link} href={`/competitions/${encodeURIComponent(item.eventId)}`}>{item.title}</a>
      <span className={styles.muted}> · {item.format === "online" ? "线上" : "线下"} · 报名截止 {competitionDate(item.registrationClosesAt, item.timezone)}</span>
    </li>)}</ul>
    <a className={styles.secondary} href={directoryHref}>查看全部正式比赛</a>
  </section>;
}
export function CompetitionOverview({ eventId, directoryHref = "/competitions", signedIn = false, loginHref, moduleLinks = {}, participationSlot }: CompetitionOverviewProps) {
  const competition = useApi<PublicCompetition>(`/competitions/${encodeURIComponent(eventId)}`);
  if (!competition.data || competition.data.eventId !== eventId) return <section className={styles.surface}><a className={styles.link} href={directoryHref}>返回比赛目录</a>{competition.loading ? <p role="status" className={styles.muted}>正在读取正式发布的比赛规则…</p> : <div className={styles.error} role="alert"><p>{competition.error?.message ?? "比赛尚未公开发布。"}</p><button className={styles.secondary} type="button" onClick={() => void competition.reload()}>重新读取</button></div>}</section>;
  const event = competition.data, available = event.availability === "available" && event.status === "published";
  const base = `/competitions/${encodeURIComponent(eventId)}`;
  const links: Partial<Record<EventModuleKey, string>> = { registration: `${base}/register`, teams: `${base}/teams`, icebreaking: `${base}/services`, judging: `${base}/submit`, schedule: `${base}/schedule`, accommodation: `${base}/services`, mealVouchers: `${base}/services`, ...moduleLinks };
  return <article className={styles.surface}>
    <a className={styles.link} href={directoryHref}>返回比赛目录</a>
    <header className={`${styles.panel} ${styles.intro}`}><p className={styles.eyebrow}>{event.organizationName} · 主办方发布</p><h2 className={styles.cardTitle}>{event.title}</h2>
      <div className={styles.row}><span className={`${styles.badge} ${available ? styles.active : styles.warning}`}>{event.status === "published" ? "已发布" : event.status === "ended" ? "比赛已结束" : "比赛已归档"}</span><span className={styles.badge}>正式规则 v{event.publishedRevision}</span><span className={styles.badge}>{event.format === "online" ? "线上" : "线下"}</span></div>
      {event.summary && <p className={styles.rules}>{event.summary}</p>}
      <p className={styles.muted}>本页时间均使用 {event.timezone} 时区。报名截止与作品截止分别列出。</p>
      <dl className={styles.deadlines}>{[["报名开始", event.registrationOpensAt], ["报名截止", event.registrationClosesAt], ["比赛开始", event.startsAt], ["作品截止", event.submissionClosesAt], ["比赛结束", event.endsAt]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{competitionDate(value, event.timezone)}</dd></div>)}</dl>
      {event.availability !== "available" && <p className={styles.error} role="status">机构目前无法继续提供运营服务，相关操作已暂停。已有比赛规则与记录保留，后续安排请关注主办方说明。</p>}
      {event.location && <p className={styles.rules}>地点 / 在线参与：{event.location}</p>}
      {!signedIn && available && <a className={styles.button} href={loginHref ?? `/login?returnTo=${encodeURIComponent(`/competitions/${eventId}`)}`}>登录后参加比赛</a>}
      {available && signedIn && <div className={styles.publicLinks}>{(Object.keys(links) as EventModuleKey[]).filter(key => event.modules[key] && links[key]).map(key => <a key={key} className={styles.secondary} href={links[key]}>{competitionModuleLabels[key]}</a>)}</div>}
    </header>
    {competition.error && <p role="alert" className={styles.error}>{competition.error.message} 当前显示上次读取的正式版本。</p>}
    <SameOrganizerEvents eventId={eventId} organizationId={event.organizationId} organizationName={event.organizationName} directoryHref={directoryHref}/>
    <section className={styles.panel}><h3>公开比赛规则</h3><p className={styles.rules}>{event.rules || "主办方尚未补充规则正文。参与前请确认比赛说明。"}</p></section>
    {participationSlot && <section className={styles.panel}>{participationSlot}</section>}
    <details className={styles.details}><summary className={styles.summary}>版本与开放功能</summary><div className={styles.stack}>
      <p className={styles.muted}>v{event.publishedRevision} · {competitionDate(event.publishedAt, event.timezone)} 发布</p><p className={styles.rules}>{event.changeSummary}</p>
      <div className={styles.row}>{(Object.keys(competitionModuleLabels) as EventModuleKey[]).filter(key => event.modules[key]).map(key => <span className={styles.badge} key={key}>{competitionModuleLabels[key]}</span>)}</div>
      <p className={styles.muted}>机构入驻审核只核对主办方身份，参赛要求以此正式版本和主办方后续说明为准。</p>
    </div></details>
  </article>;
}
