"use client";

import type { NoticeContent, SelectionNotice } from "./model.ts";
import { mailStateText } from "./model.ts";
import { dateText } from "../../components/client-api.ts";
import styles from "./selection-notices.module.css";

export function NoticePreview({ content, label = "通知预览" }: { content: NoticeContent; label?: string }) {
  return <article aria-label={label} className={`${styles.preview} ${content.theme === "letter" ? styles.letter : styles.simple} ${styles[content.accent]}`}>
    <p className={styles.kicker}>主办方入选通知</p><h4>{content.subject}</h4><p className={styles.body}>{content.body}</p>
  </article>;
}
export function PublishedNotice({ notice }: { notice: SelectionNotice }) {
  return <article className={styles.record} aria-label={`入选通知第 ${notice.version} 版`}>
    <div className={styles.meta}><span className={styles.badge}>站内已发布 · 第 {notice.version} 版</span><span>{dateText(notice.publishedAt)}</span></div>
    <NoticePreview content={notice} label={`已发布通知第 ${notice.version} 版正文`}/>
    <p className={notice.mailState === "unknown_hold" || notice.mailState === "failed" ? styles.warning : styles.muted}>{mailStateText(notice.mailState)}</p>
    <p className={styles.muted}>使用模板第 {notice.templateRevision} 版 · 当时的报名版本 {notice.registrationRevision}</p>
  </article>;
}
