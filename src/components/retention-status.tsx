"use client";
import { dateText, useApi } from "./client-api.ts";
import { Feedback, Loading } from "./site-shell.tsx";
import styles from "./operations.module.css";

export function RetentionStatus() {
  const status = useApi<{checkedAt:string;preservedReceiptCount:string;eligibleTemporarySourceCount:number;expiredExportDocuments:string;explanation:string}>("/admin/operations/retention");
  return <section className={styles.panel}><h2>保留与临时资料清理</h2><Feedback error={status.error}/>{status.loading && <Loading/>}
    {status.data && !status.error && <><p>{status.data.explanation}</p><p>保留采集回执 {status.data.preservedReceiptCount} 条；可清理临时原文 {status.data.eligibleTemporarySourceCount} 条；待清空过期导出 {status.data.expiredExportDocuments} 份。</p><p className={styles.muted}>核对于 {dateText(status.data.checkedAt)}。GitHub 草稿清理另外检查操作状态，结果未知或正在保存的草稿继续保留。</p></>}
    <button className={styles.secondary} disabled={status.loading} onClick={() => void status.reload()}>刷新保留状态</button>
  </section>;
}
