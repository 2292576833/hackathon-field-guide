"use client";

import { useState, type FormEvent } from "react";
import { api, dateText, message, safeLink, useApi } from "../../components/client-api.ts";
import { Field } from "../../components/site-shell.tsx";
import type { EventReadinessItem, ReadinessField } from "./model.ts";
import styles from "./organizer.module.css";

const FIELD_LABELS: Record<ReadinessField, string> = {
  registrationClosesAt: "报名截止时间", registrationOpensAt: "报名开始时间", startsAt: "开赛时间", endsAt: "结束时间",
  timezone: "比赛时区", tracks: "官方赛道 / 赛题方向", requiredMaterials: "必交材料", submissionMethod: "作品提交方式",
  resultsAt: "结果公布时间", fee: "费用", eligibility: "参赛资格", aiPolicy: "AI 使用规则",
};
const STATE_LABELS: Record<EventReadinessItem["state"], string> = {
  known_from_organizer: "主办方已确认", known_from_source: "仅有抓取线索", missing: "还没有信息", conflicting: "两侧不一致，需要你判断",
};
const CONFIGURED_FIELDS: readonly ReadinessField[] = ["registrationOpensAt","registrationClosesAt","startsAt","endsAt","timezone"];

/**
 * 待补字段清单（P03）。清单是派生视图：不显示完成百分比、不落勾选。
 * 抓取线索与主办方确认的值在界面上必须可区分；时间类字段回比赛配置修改，避免两份时间。
 */
export function EventReadinessPanel({ eventId }: { eventId: string }) {
  const items = useApi<EventReadinessItem[]>(`/organizer/events/${encodeURIComponent(eventId)}/readiness`);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const missingCount = items.data?.filter(item => item.state === "missing").length ?? 0;

  return <section className={styles.surface} aria-label="待补赛事信息">
    <div className={styles.panel}>
      <h2>待补赛事信息</h2>
      <p className={styles.muted}>我们只确认了其中一部分，剩下的只有你们能给权威答案。按对选手的重要程度排序，<strong>报名截止排在最前</strong>。填写后选手在该场看到的就是你们确认的信息。</p>
      <div className={styles.actions}><button type="button" className={styles.secondary} disabled={items.loading} onClick={() => void items.reload()}>刷新清单</button></div>
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {items.loading && <p role="status" className={styles.muted}>正在整理清单…</p>}
      {items.error && <p role="alert" className={styles.error}>{items.error.message}</p>}
      {items.data && <p className={styles.muted}>当前还有 {missingCount} 项没有信息。清单只用于提示，不代表任何完成度。</p>}
    </div>
    {items.data?.map(item => <ReadinessRow key={item.field} eventId={eventId} item={item} onDone={async text => { setNotice(text); setError(""); await items.reload(); }} onError={setError}/>)}
  </section>;
}

function ReadinessRow({ eventId, item, onDone, onError }: { eventId: string; item: EventReadinessItem; onDone: (text: string) => Promise<void>; onError: (text: string) => void }) {
  return <article className={styles.panel}>
    <div className={`${styles.row} ${styles.between}`}><h3>{FIELD_LABELS[item.field]}</h3><span className={styles.badge}>{STATE_LABELS[item.state]}</span></div>
    {item.sourceEvidence.length > 0 && <div className={styles.todo}>
      <strong>我们抓到的原文线索（未核验，不能当你们的声明）</strong>
      <ul className={styles.list}>{item.sourceEvidence.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <p className={styles.muted}>{item.sourceUrl ? <>来源：<a className={styles.link} href={safeLink(item.sourceUrl) ?? "#"} target="_blank" rel="noopener noreferrer">{item.sourceUrl}（新窗口）</a></> : "来源链接缺失"}{item.checkedAt ? ` · 我们最后一次核验：${dateText(item.checkedAt)}` : ""}</p>
    </div>}
    {item.state === "conflicting" && <p className={styles.todo}>这一项我们抓到的内容与已有信息不一致。请核对原文后由你们确认；系统不会自动选一边。</p>}
    {CONFIGURED_FIELDS.includes(item.field)
      ? <p className={styles.muted}>这一项属于比赛配置，请在比赛配置里修改并重新发布，避免出现两份时间。</p>
      : <ProfileField eventId={eventId} item={item} onDone={onDone} onError={onError}/>}
  </article>;
}

function ProfileField({ eventId, item, onDone, onError }: { eventId: string; item: EventReadinessItem; onDone: (text: string) => Promise<void>; onError: (text: string) => void }) {
  const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try {
      await api<unknown>(`/organizer/events/${encodeURIComponent(eventId)}/readiness`, { method: "PATCH",
        body: { field: item.field, value: value.trim() ? value.trim() : null, expectedRevision: item.revision } });
      setEditing(false); setValue("");
      await onDone(`${FIELD_LABELS[item.field]}已保存。`);
    } catch (reason) { onError(`${message(reason)} 输入已保留；请核对后继续。`); }
    finally { setBusy(false); }
  }
  return <div className={styles.stack}>
    {item.organizerValue && <p className={styles.rules}><strong>你们确认的内容：</strong>{item.organizerValue}</p>}
    {!editing ? <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => { setEditing(true); setValue(item.organizerValue ?? ""); }}>{item.organizerValue ? "修改这一项" : "填写这一项"}</button></div>
      : <form className={styles.stack} onSubmit={submit}>
        <Field label={FIELD_LABELS[item.field]} hint="填写你们对外公布的真实内容。留空并保存会清除这一项，不会用抓取线索顶替。">
          <textarea value={value} onChange={event => setValue(event.target.value)} maxLength={2000}/>
        </Field>
        <div className={styles.actions}><button type="submit" className={styles.button} disabled={busy}>{busy ? "正在保存…" : "保存这一项"}</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => { setEditing(false); setValue(""); }}>取消</button></div>
      </form>}
  </div>;
}
