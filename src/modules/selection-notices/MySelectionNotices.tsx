"use client";

import { useCallback, useState } from "react";
import { useApi } from "../../components/client-api.ts";
import { Feedback } from "../../components/site-shell.tsx";
import { PrivateNoticeUnavailable, useNoticePrivacy } from "./boundary.tsx";
import { PublishedNotice } from "./NoticePreview.tsx";
import { currentRegistrationNoticeText, type SelectionNoticeList } from "./model.ts";
import styles from "./selection-notices.module.css";

export interface MySelectionNoticesProps { eventId: string }
export function MySelectionNotices({ eventId }: MySelectionNoticesProps) { return <MyNotices key={eventId} eventId={eventId}/>; }
function MyNotices({ eventId }: MySelectionNoticesProps) {
  const query = useApi<SelectionNoticeList>(`/competitions/${encodeURIComponent(eventId)}/selection-notices`);
  const [cleared, setCleared] = useState(false), clear = useCallback(() => { setCleared(true); query.setData(null); }, [query.setData]);
  const privacy = useNoticePrivacy(clear, [query.error]);
  const notices = !cleared && !privacy.locked ? query.data?.items.filter(item => item.eventId === eventId) : null;
  return <section className={styles.panel} aria-label="我的入选通知"><p className={styles.kicker}>当前比赛 · 本人专属</p><h2>我的入选通知</h2>
    {privacy.locked ? <PrivateNoticeUnavailable eventId={eventId}/> : <>
      <p className={styles.muted}>这里只显示主办方发布给你的通知。历史通知保留当时内容；当前报名状态请在报名区刷新核对。</p>
      <Feedback error={query.error}/>{query.loading && <p className={styles.muted} role="status">正在读取本人通知…</p>}
      {query.data && <p className={query.data.registrationStatus === "approved" ? styles.muted : styles.warning}>{currentRegistrationNoticeText(query.data.registrationStatus)}{query.data.registrationRevision !== undefined && ` 当前报名版本 ${query.data.registrationRevision}。`}</p>}
      {notices?.length ? <div className={styles.list}>{notices.map(item => <PublishedNotice key={item.id} notice={item}/>)}</div> : query.data && !query.loading && !query.error && <p className={styles.empty}>主办方还没有为你发布入选通知。下一步：先刷新审核结果，再留意本场通知。</p>}
      <div className={styles.actions}><button type="button" className={styles.secondary} disabled={query.loading} onClick={() => void query.reload()}>{query.loading ? "正在刷新…" : "刷新本人通知"}</button><a className={styles.secondary} href={`/competitions/${encodeURIComponent(eventId)}`}>查看本场比赛安排</a></div>
    </>}
  </section>;
}
