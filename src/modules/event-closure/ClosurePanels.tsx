"use client";
import { useState } from "react";
import { api, dateText, message, operationKey, useApi } from "../../components/client-api.ts";
import type { MyContactWillingness, PostEventSummary } from "./model.ts";
import styles from "./event-closure.module.css";

/**
 * 赛后闭环界面（规划 33 P09 / 设计 §6.6）。
 *
 * 纪律：
 * - 主办方侧只渲染只读派生事实与唯一新增事实的公开投影；不出现进度条、完成度、评分或排名徽章。
 * - 「愿意被联系」的同意口径**逐字**取自服务端 `consentNotice`（源头是 policy.ts 常量），
 *   组件不得改写，保证"不代表投资/录用/孵化机会"这句话不会被改掉。
 * - 队伍侧指回既有 `my-checklists` 与既有复盘入口，不另做一份赛后清单。
 */

function organizerPath(eventId: string) { return `/organizer/events/${encodeURIComponent(eventId)}/closure`; }
function myPath(eventId: string, teamId: string) { return `/competitions/${encodeURIComponent(eventId)}/contact-willingness?teamId=${encodeURIComponent(teamId)}`; }
function mySubmitPath(eventId: string) { return `/competitions/${encodeURIComponent(eventId)}/contact-willingness`; }
function myWithdrawPath(eventId: string, id: string) { return `${mySubmitPath(eventId)}/${encodeURIComponent(id)}/withdraw`; }

const eventStatusNames: Record<PostEventSummary["event"]["status"], string> = { draft: "草稿", published: "已发布", ended: "已结束", archived: "已归档" };

export interface PostEventClosurePanelProps { eventId: string; eventTitle: string; organizationName: string }

/** 主办方事件页的"赛后"区：只读派生，只列已公布/已批准内容与既有记录。 */
export function PostEventClosurePanel({ eventId, eventTitle, organizationName }: PostEventClosurePanelProps) {
  const summary = useApi<PostEventSummary>(organizerPath(eventId));
  if (summary.error) return <section className={styles.panel} aria-label="赛后闭环"><h2>赛后闭环</h2>
    <p className={styles.error}>{summary.error.message}</p>
    <button className={styles.secondary} type="button" onClick={() => void summary.reload()}>重新读取</button></section>;
  if (!summary.data) return <section className={styles.panel} aria-label="赛后闭环"><h2>赛后闭环</h2>
    <p className={styles.hint}>正在读取本场既有记录…</p></section>;
  const data = summary.data;
  return <section className={styles.panel} aria-label="赛后闭环">
    <div className={styles.head}>
      <h2>赛后闭环 · {eventTitle}</h2>
      <span className={styles.badge}>{eventStatusNames[data.event.status]}</span>
      {data.event.afterEvent ? <span className={styles.badgeMuted}>已过结束时间</span> : null}
    </div>
    <p className={styles.hint}>{organizationName} · {data.notice}</p>

    <h3>本场成果清单（只读）</h3>
    <div className={styles.cards}>
      <article className={styles.card}>
        <div className={styles.cardTop}><strong>正式收件</strong><span className={styles.badge}>{data.outcomes.intake.count} 件</span></div>
        <p>{data.outcomes.intake.latestSubmittedAt ? `最近一次交件：${dateText(data.outcomes.intake.latestSubmittedAt)}` : "本场还没有正式收件记录。"}</p>
      </article>
      <article className={styles.card}>
        <div className={styles.cardTop}><strong>已确认复盘</strong>
          <span className={styles.badge}>{data.outcomes.retrospectives.state === "read" ? `${data.outcomes.retrospectives.confirmedCount ?? 0} 条` : "未读取"}</span></div>
        <p>{data.outcomes.retrospectives.state === "read"
          ? `来自 ${data.outcomes.retrospectives.linkedProjectCount} 个已关联的团队空间；只统计已确认条目，不读取未提交草稿。`
          : data.outcomes.retrospectives.notice}</p>
      </article>
    </div>

    <h3>已公布结果</h3>
    {!data.outcomes.published.length ? <p className={styles.empty}>本场还没有已公布结果；未公布的作品不会出现在这里。</p>
      : <ul className={styles.list}>{data.outcomes.published.map(outcome => <li key={`${outcome.roundId}:${outcome.version}`}>
        <div className={styles.cardTop}><strong>{outcome.roundTitle || "评审轮"} · 第 {outcome.version} 版</strong>
          <span className={styles.badge}>{outcome.visibility === "public" ? "公开" : "仅参与者"}</span></div>
        <p className={styles.hint}>{dateText(outcome.publishedAt)} · {outcome.workCount} 件作品
          {outcome.reviewRequired ? " · 当前需要复核，暂停展示分数与名次" : ` · 已批准反馈 ${outcome.approvedFeedbackCount} 条`}</p>
        {!outcome.reviewRequired && !!outcome.works.length && <ul className={styles.list}>
          {outcome.works.map((work, index) => <li key={`${work.teamId}:${index}`}>{work.title} <span className={styles.hint}>· {work.teamId}</span></li>)}</ul>}
      </li>)}</ul>}

    <h3>下一届可复用（每项指回既有记录）</h3>
    {!data.reuse.length ? <p className={styles.empty}>还没有可复用的既有记录。</p>
      : <ul className={styles.list}>{data.reuse.map(source => <li key={source.id}>
        <a className={styles.link} href={source.href}>{source.label} ↗</a> <span className={styles.hint}>{source.detail}</span></li>)}</ul>}

    <h3>愿意被联系的队伍（{data.contactWillingness.length}）</h3>
    <p className={styles.hint}>只显示主动选择「愿意被联系」的队伍；未选择或选择不愿意的队伍不在这里出现，也不显示数量。它只表示同意就本队成果与本队联系，不代表获奖、投资、录用或孵化机会。</p>
    {!data.contactWillingness.length ? <p className={styles.empty}>目前没有队伍选择「愿意被联系」。</p>
      : <ul className={styles.list}>{data.contactWillingness.map(item => <li key={item.teamId}>队伍 {item.teamId}
        <span className={styles.hint}> · 选择于 {dateText(item.chosenAt)}</span></li>)}</ul>}

    <h3>下一步由既有队列处理</h3>
    <ul className={styles.list}>{data.existingQueues.map(queue => <li key={queue.id}>
      <a className={styles.link} href={queue.href}>{queue.label} ↗</a> <span className={styles.hint}>{queue.note}</span></li>)}</ul>

    <ul className={styles.limits}>{data.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}

export interface ContactWillingnessCardProps { eventId: string; teamId: string }

/** 队伍侧：本人（本队成员）选择是否愿意被联系，并可撤回重提；复用既有赛后清单入口。 */
export function ContactWillingnessCard({ eventId, teamId }: ContactWillingnessCardProps) {
  const view = useApi<MyContactWillingness>(myPath(eventId, teamId));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  async function choose(willing: boolean) {
    if (busy) return;
    setBusy(true); setNote(""); setFailed(false);
    const key = operationKey();
    try {
      await api<unknown>(mySubmitPath(eventId), { method: "POST", idempotencyKey: key, body: { teamId, willing, idempotencyKey: key } });
      setNote(willing ? "已提交：本场主办方在赛后成果区可以看到你们愿意被联系。" : "已记录你们的选择；主办方侧看不到，也不会显示数量。");
      await view.reload();
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }
  async function withdraw() {
    const active = view.data?.active;
    if (!active || busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try {
      await api<unknown>(myWithdrawPath(eventId, active.id), { method: "POST", body: { expectedRevision: active.revision } });
      setNote("已撤回；主办方侧不再显示，之后仍可重新提交。");
      await view.reload();
    } catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }
  if (view.error) return <div className={styles.block}><h3>是否愿意被联系</h3><p className={styles.error}>{view.error.message}</p></div>;
  if (!view.data) return <div className={styles.block}><h3>是否愿意被联系</h3><p className={styles.hint}>正在读取本队的赛后选择…</p></div>;
  const data = view.data;
  return <div className={styles.block}>
    <h3>是否愿意被联系</h3>
    <p className={styles.consent}><strong>{data.active
      ? (data.active.willing ? "你们队现在选择：愿意被联系" : "你们队现在选择：不愿意被联系")
      : "你们队还没有做出选择（默认不公开）"}</strong></p>
    <p className={styles.consent}>{data.consentNotice}</p>
    <p className={styles.hint}>{data.privacyNotice}</p>
    {note && <p className={failed ? styles.error : styles.notice}>{note}</p>}
    {!data.active ? <div className={styles.actions}>
      <button className={styles.primary} type="button" disabled={busy} onClick={() => void choose(true)}>愿意被联系</button>
      <button className={styles.secondary} type="button" disabled={busy} onClick={() => void choose(false)}>不愿意</button>
    </div> : <div className={styles.actions}>
      <button className={styles.secondary} type="button" disabled={busy} onClick={() => void withdraw()}>撤回这条选择</button>
    </div>}
    <p className={styles.hint}>{data.withdrawNotice}</p>
    <h4>本队自己的复用入口</h4>
    <p className={styles.hint}>{data.reuse.notice}</p>
    <ul className={styles.list}>
      <li><a className={styles.link} href={data.reuse.myChecklistsHref}>本人赛后只读复用清单 ↗</a></li>
      {data.reuse.retrospectiveHref ? <li><a className={styles.link} href={data.reuse.retrospectiveHref}>本人复盘（团队空间）↗</a></li> : null}
    </ul>
    {!!data.history.length && <details><summary>本队提交历史（{data.history.length} 条）</summary>
      <ul className={styles.list}>{data.history.map(item => <li key={item.id}>
        {item.willing ? "愿意被联系" : "不愿意"} · {item.status === "active" ? "当前有效" : "已撤回"} · {dateText(item.submittedAt)}
        {item.withdrawnAt ? ` · 撤回于 ${dateText(item.withdrawnAt)}` : ""}</li>)}</ul></details>}
  </div>;
}
