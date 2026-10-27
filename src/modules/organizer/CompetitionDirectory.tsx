"use client";

import { useState, type ReactNode } from "react";
import { useApi } from "../../components/client-api.ts";
import { Field } from "../../components/site-shell.tsx";
import type { CompetitionIdentity, PublicCompetition } from "./model.ts";
import { competitionDate } from "./CompetitionOverview.tsx";
import styles from "./organizer.module.css";

export interface CompetitionDirectoryProps {
  readonly signedIn?: boolean;
  readonly organizerHref?: string;
  readonly competitionHref?: (eventId: string) => string;
  readonly workspaceHref?: (eventId: string) => string;
  readonly identitySlot?: ReactNode;
}
export function CompetitionDirectory({ signedIn = false, organizerHref = "/organizers", competitionHref = id => `/competitions/${encodeURIComponent(id)}`, workspaceHref = id => `/organizers/workspace?event=${encodeURIComponent(id)}`, identitySlot }: CompetitionDirectoryProps) {
  const competitions = useApi<PublicCompetition[]>("/competitions"), identities = useApi<CompetitionIdentity[]>(signedIn ? "/me/competition-identities" : null);
  const [query, setQuery] = useState(""), [status, setStatus] = useState("all");
  const visible = competitions.data?.filter(event => `${event.title} ${event.organizationName} ${event.summary}`.toLowerCase().includes(query.trim().toLowerCase()) && (status === "all" || event.status === status)) ?? [];
  return <section className={styles.surface} aria-label="主办方赛事目录">
    <div className={`${styles.panel} ${styles.intro}`}><p className={styles.eyebrow}>主办方正式发布</p><h2>找一场适合参加的比赛</h2><p className={styles.muted}>查看正式规则、报名与作品期限。比赛由各自组织运营。</p><a className={styles.link} href={organizerHref}>我是主办方，申请入驻或管理比赛</a></div>
    {signedIn && <section className={styles.panel}><h3>我有权限的比赛</h3>{identitySlot}
      {identities.loading && <p className={styles.muted} role="status">正在读取工作人员身份…</p>}{identities.error && <p className={styles.error} role="alert">{identities.error.message}</p>}
      {identities.data?.length === 0 && <p className={styles.muted}>你目前没有工作人员身份；可以继续浏览公开比赛。</p>}
      <div className={styles.cards}>{identities.data?.map(identity => <article className={styles.panel} key={identity.event.eventId}><p className={styles.eyebrow}>{identity.event.organizationName}</p><h3>{identity.event.title}</h3><div className={styles.row}><span className={styles.badge}>{identity.organizationAdmin ? "组织管理员" : "工作人员"}</span><span className={styles.badge}>{identity.event.status === "draft" ? "草稿" : identity.event.status === "published" ? "已发布" : identity.event.status === "ended" ? "已结束" : "已归档"}</span></div><a className={styles.secondary} href={workspaceHref(identity.event.eventId)}>进入这场比赛的工作台</a></article>)}</div>
    </section>}
    <section className={styles.panel}><div className={styles.grid}><Field label="搜索比赛或主办方"><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="比赛名称、组织名称或主题"/></Field><Field label="比赛状态"><select value={status} onChange={event => setStatus(event.target.value)}><option value="all">所有正式比赛</option><option value="published">已发布</option><option value="ended">已结束</option><option value="archived">已归档</option></select></Field></div>
      {competitions.loading && <p role="status" className={styles.muted}>正在读取正式比赛…</p>}{competitions.error && <div role="alert" className={styles.error}><p>{competitions.error.message}</p><button type="button" className={styles.secondary} onClick={() => void competitions.reload()}>重新读取</button></div>}
      {competitions.data && !visible.length && <p className={styles.muted}>{competitions.data.length ? "没有符合当前搜索的比赛。可以清空关键词或查看所有状态。" : "暂时没有正式发布的比赛。主办方发布后会在这里出现。"}</p>}
      <div className={styles.cards}>{visible.map(event => <article className={styles.panel} key={event.eventId}><p className={styles.eyebrow}>{event.organizationName}</p><h3 className={styles.cardTitle}>{event.title}</h3><div className={styles.row}><span className={styles.badge}>{event.format === "online" ? "线上" : "线下"}</span><span className={styles.badge}>{event.status === "published" ? "已发布" : event.status === "ended" ? "已结束" : "已归档"}</span>{event.availability !== "available" && <span className={`${styles.badge} ${styles.unavailable}`}>机构运营暂停</span>}</div>
        <p className={styles.muted}>{event.summary || "查看正式比赛说明与规则。"}</p><dl className={styles.deadlines}><div><dt>报名截止</dt><dd>{competitionDate(event.registrationClosesAt, event.timezone)}</dd></div><div><dt>作品截止</dt><dd>{competitionDate(event.submissionClosesAt, event.timezone)}</dd></div></dl><p className={styles.muted}>时区：{event.timezone} · 规则 v{event.publishedRevision}</p><a className={styles.secondary} href={competitionHref(event.eventId)}>查看规则与参赛入口</a></article>)}</div>
    </section>
  </section>;
}
