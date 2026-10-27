"use client";

import { useEffect, useId, useState } from "react";
import type { CSSProperties } from "react";
import { parseSkillUsage } from "./skill-usage.ts";
import type { SkillUsage } from "./skill-usage.ts";
import styles from "./retrospectives.module.css";

export interface SkillUsageFieldsProps {
  value: SkillUsage[];
  onChange(value: SkillUsage[]): void;
  readonly?: boolean;
}
export interface SkillUsageDetailsProps { value?: readonly SkillUsage[] }

type Reference = SkillUsage["reference"];
type UsageText = "purpose" | "feedback" | "limitations";
interface NewUsage {
  kind: Reference["kind"];
  id: string;
  version: string;
  versionId: string;
  contentHash: string;
  revision: string;
  purpose: string;
  feedback: string;
  limitations: string;
}
const emptyUsage = (): NewUsage => ({ kind: "skill", id: "", version: "", versionId: "", contentHash: "", revision: "1", purpose: "", feedback: "", limitations: "" });
const textLabels: Record<UsageText, string> = { purpose: "实际用途", feedback: "本人使用反馈", limitations: "限制与未知" };
const textKeys: UsageText[] = ["purpose", "feedback", "limitations"];
const compact: CSSProperties = { padding: 0, border: 0, background: "transparent", gap: 12 };
const control: CSSProperties = { width: "100%", minWidth: 0, minHeight: 44, padding: "10px 12px", border: "1px solid var(--retro-control)", borderRadius: 8, color: "var(--retro-ink)", background: "var(--retro-surface)", font: "inherit" };
const copyUsages = (value: readonly SkillUsage[]) => value.map(item => ({ ...item, reference: { ...item.reference } }));

/** The own-module parser is browser-safe and does not look up availability. */
function addedUsage(input: NewUsage): SkillUsage {
  if (!/^[0-9]+$/.test(input.revision)) throw new Error("引用修订号需为正整数。");
  const parsed = parseSkillUsage([{
    reference: { kind: input.kind, id: input.id, version: input.version, versionId: input.versionId, contentHash: input.contentHash, revision: Number(input.revision) },
    purpose: input.purpose, feedback: input.feedback, limitations: input.limitations,
  }], { allowIncomplete: true });
  if (!parsed?.[0]) throw new Error("请核对技能使用记录。");
  return parsed[0];
}

function ReferenceDetails({ reference }: { reference: Reference }) {
  return <dl className={styles.facts}>
    <div><dt>引用类型</dt><dd>{reference.kind === "skill" ? "技能" : "技能包"}</dd></div>
    <div><dt>标识</dt><dd className={styles.code}>{reference.id}</dd></div>
    <div><dt>固定版本</dt><dd className={styles.code}>{reference.version}</dd></div>
    <div><dt>版本记录</dt><dd className={styles.code}>{reference.versionId}</dd></div>
    <div><dt>内容哈希</dt><dd className={styles.code}>{reference.contentHash}</dd></div>
    <div><dt>修订号</dt><dd>{reference.revision}</dd></div>
  </dl>;
}

/** Historical member text remains visible even when its fixed version is withdrawn. */
export function SkillUsageDetails({ value }: SkillUsageDetailsProps) {
  return <div className={styles.panel} style={compact}>
    {!value?.length ? <p className={styles.muted}>尚未记录技能使用经验。</p> : <>
      <p className={styles.muted}>以下为本人使用的成员自报，不代表兼容验证、安装成功或任务验收；复制引用不会安装技能。</p>
      <ul className={styles.records}>{value.map((item, index) => <li className={styles.record} key={`${item.reference.kind}:${item.reference.versionId}:${index}`}>
        <p className={styles.recordTitle}>{item.reference.kind === "skill" ? "技能" : "技能包"} · {item.reference.id} · {item.reference.version}</p>
        <span className={styles.tag}>成员自报 · 固定历史版本</span>
        <ReferenceDetails reference={item.reference}/>
        <dl className={styles.latest}>{textKeys.map(key => <div key={key}><dt>{textLabels[key]}</dt><dd>{item[key] || "尚未填写"}</dd></div>)}</dl>
      </li>)}</ul>
    </>}
  </div>;
}

/** Fits inside an existing form: all add/remove controls are local buttons. */
export function SkillUsageFields({ value, onChange, readonly: readOnly = false }: SkillUsageFieldsProps) {
  const id = useId();
  const [adding, setAdding] = useState<NewUsage>(emptyUsage);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const valueFingerprint = JSON.stringify(value);
  type PendingRows = Record<string, Partial<Record<UsageText, string>>>;
  const [pending, setPending] = useState<{ fingerprint: string; rows: PendingRows }>(() => ({ fingerprint: valueFingerprint, rows: {} }));
  // A changed controlled value ignores old overlays immediately, before effects run.
  const pendingText = pending.fingerprint === valueFingerprint ? pending.rows : {};
  const clearPending = () => setPending({ fingerprint: valueFingerprint, rows: {} });
  // An explicit parent restore must replace old, rejected local overlays too.
  useEffect(() => { setPending({ fingerprint: valueFingerprint, rows: {} }); }, [valueFingerprint]);
  const rowKey = (item: SkillUsage, index: number) => `${item.reference.kind}:${item.reference.id}:${item.reference.versionId}:${item.reference.contentHash}:${item.reference.revision}:${index}`;
  const currentValues = () => copyUsages(value).map((item, index) => ({ ...item, ...pendingText[rowKey(item, index)] }));

  function add() {
    setError(""); setNotice("");
    try {
      if (readOnly) return;
      if (value.length >= 12) throw new Error("最多记录12项技能使用经验。");
      const item = addedUsage(adding);
      onChange([...currentValues(), item]);
      clearPending(); setAdding(emptyUsage()); setNotice("已加入本地记录。实际用途、反馈和限制可稍后补齐；仍需正式保存才能采用。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "未能加入记录，当前输入已保留。"); }
  }
  function editText(index: number, key: UsageText, text: string) {
    if (readOnly) return;
    const item = value[index];
    if (!item) return;
    const identity = rowKey(item, index);
    try {
      const next = currentValues();
      // Retain edits across a rejected parent callback, rather than dropping typed text.
      next[index] = { ...next[index], [key]: text };
      onChange(next);
      clearPending();
      setError(""); setNotice("");
    } catch {
      setPending(previous => {
        const rows = previous.fingerprint === valueFingerprint ? previous.rows : {};
        return { fingerprint: valueFingerprint, rows: { ...rows, [identity]: { ...rows[identity], [key]: text } } };
      });
      setError("暂未采用本条编辑，输入仍保留。请继续核对并重试保存。");
    }
  }
  function remove(index: number) {
    if (readOnly) return;
    try {
      onChange(currentValues().filter((_, itemIndex) => itemIndex !== index));
      // Keys include the local row index; clear overlays when the row order changes.
      clearPending(); setError(""); setNotice("已移除此条本地记录，尚未执行外部删除。");
    } catch { setError("未能移除此条本地记录，输入仍保留。"); }
  }

  return <details className={styles.panel} style={compact}>
    <summary>技能使用经验（可选，{value.length}/12）</summary>
    <div className={styles.form}>
      <p className={styles.muted}>记录本人使用过的精确技能或技能包版本。历史版本停用不会删除本人文字；成员自报不能作为兼容或安装成功依据，复制引用不会安装。</p>
      {readOnly ? <SkillUsageDetails value={value}/> : <>
        {value.length ? <ul className={styles.records}>{value.map((item, index) => <li className={styles.record} key={rowKey(item, index)}>
          <p className={styles.recordTitle}>{item.reference.kind === "skill" ? "技能" : "技能包"} · {item.reference.id} · {item.reference.version}</p>
          <span className={styles.tag}>本人使用 · 成员自报</span>
          <details><summary>查看固定引用</summary><ReferenceDetails reference={item.reference}/></details>
          {textKeys.map(key => <div className={styles.field} key={key}><label htmlFor={`${id}-${index}-${key}`}>{textLabels[key]}</label><textarea id={`${id}-${index}-${key}`} rows={3} maxLength={2000} value={pendingText[rowKey(item, index)]?.[key] ?? item[key]} onChange={event => editText(index, key, event.target.value)}/></div>)}
          <div className={styles.actions}><button className={styles.secondaryButton} type="button" onClick={() => remove(index)}>移除此条本地记录</button></div>
        </li>)}</ul> : <p className={styles.muted}>尚未加入技能使用记录。</p>}
        <fieldset className={styles.fieldset}>
          <legend>添加技能使用记录</legend>
          <p className={styles.muted}>先填写固定引用并点击添加，才会进入本次草稿。用途、反馈和限制可稍后填写；正式保存经验前需补齐，也可明确写“不知道”或“没有记录”。</p>
          <div className={styles.fieldOptions}>
            <div className={styles.field}><label htmlFor={`${id}-kind`}>引用类型</label><select id={`${id}-kind`} style={control} value={adding.kind} onChange={event => setAdding(previous => ({ ...previous, kind: event.target.value as Reference["kind"] }))}><option value="skill">技能</option><option value="bundle">技能包</option></select></div>
            <div className={styles.field}><label htmlFor={`${id}-skill-id`}>技能或技能包标识</label><input id={`${id}-skill-id`} style={control} maxLength={240} value={adding.id} autoComplete="off" spellCheck={false} onChange={event => setAdding(previous => ({ ...previous, id: event.target.value }))}/></div>
            <div className={styles.field}><label htmlFor={`${id}-version`}>固定版本</label><input id={`${id}-version`} style={control} maxLength={240} value={adding.version} autoComplete="off" spellCheck={false} placeholder="明确版本，不使用 latest" onChange={event => setAdding(previous => ({ ...previous, version: event.target.value }))}/></div>
            <div className={styles.field}><label htmlFor={`${id}-version-id`}>版本记录标识</label><input id={`${id}-version-id`} style={control} maxLength={240} value={adding.versionId} autoComplete="off" spellCheck={false} onChange={event => setAdding(previous => ({ ...previous, versionId: event.target.value }))}/></div>
            <div className={styles.field}><label htmlFor={`${id}-hash`}>内容哈希（64位小写）</label><input id={`${id}-hash`} style={control} maxLength={64} value={adding.contentHash} autoComplete="off" spellCheck={false} onChange={event => setAdding(previous => ({ ...previous, contentHash: event.target.value }))}/></div>
            <div className={styles.field}><label htmlFor={`${id}-revision`}>引用修订号</label><input id={`${id}-revision`} style={control} inputMode="numeric" maxLength={16} value={adding.revision} autoComplete="off" onChange={event => setAdding(previous => ({ ...previous, revision: event.target.value }))}/></div>
          </div>
          {textKeys.map(key => <div className={styles.field} key={key}><label htmlFor={`${id}-new-${key}`}>{textLabels[key]}（可稍后补）</label><textarea id={`${id}-new-${key}`} rows={3} maxLength={2000} value={adding[key]} onChange={event => setAdding(previous => ({ ...previous, [key]: event.target.value }))}/></div>)}
          <div className={styles.actions}><button className={styles.secondaryButton} type="button" disabled={value.length >= 12} onClick={add}>添加到本地记录</button></div>
          {value.length >= 12 && <p className={styles.muted}>已达到12项上限，可先整理已有记录。</p>}
        </fieldset>
        {error && <p className={styles.error} role="alert">{error} 当前输入未清除。</p>}
        <p className={styles.feedback} role="status" aria-live="polite">{notice}</p>
      </>}
    </div>
  </details>;
}
