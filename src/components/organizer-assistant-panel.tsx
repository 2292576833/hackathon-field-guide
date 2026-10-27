"use client";

import { useState } from "react";
import { api, message, useApi } from "./client-api.ts";
import { Field } from "./site-shell.tsx";
import {
  MODULE_ASSISTANT_PANEL_COPY_HINT, MODULE_ASSISTANT_PANEL_MANUAL_NOTE, MODULE_ASSISTANT_PANEL_READS,
  MODULE_ASSISTANT_PANEL_SWITCH, MODULE_ASSISTANT_PANEL_TITLE,
} from "../modules/module-assistants/ui.ts";
import type { ModuleAssistantKey } from "../modules/module-assistants/model.ts";
import { MODULE_ASSISTANT_REGISTRY } from "../modules/module-assistants/registry.ts";
import styles from "./competition-workspace.module.css";

interface AssistantCatalogEntry { readonly key: ModuleAssistantKey; readonly label: string }
interface AssistantReadScope {
  readonly factKeys: readonly string[];
  readonly sources: readonly { readonly id: string; readonly label: string }[];
  readonly missing: readonly string[];
  readonly capturedAt: string;
}
interface AssistantUsage {
  readonly assistantLabel: string;
  readonly readScope: AssistantReadScope;
  readonly ledgerId: string | null;
  readonly cost: { readonly microUsdEstimated: number | null; readonly note: string } | null;
  readonly platformCallLimit: null;
}
type AssistantResult =
  | { readonly status: "draft"; readonly draft: { readonly kind: string; readonly title: string; readonly body: string; readonly items: readonly { readonly text: string }[]; readonly notes: readonly string[] }; readonly usage: AssistantUsage; readonly disclaimer: string; readonly provider: string }
  | { readonly status: "degraded"; readonly reason: string; readonly message: string; readonly usage: AssistantUsage; readonly manualWorkflowUnaffected: true; readonly provider: string };

/**
 * 规划34 P4：模块助手面板（只读事实 + 只出草稿）。
 *
 * - 只有该身份**确实拥有这项能力**、且该助手**已接入只读事实来源**时才渲染；否则不显示任何入口，也不留空占位。
 * - 顶部四条文案逐字来自模块，不在这里改写；助手不执行任何动作，草稿必须由人工复制或采用。
 * - 主按钮用 `.secondary`：每个 section 只允许一个 `.primary`（布局规格 §9）。
 */
export function OrganizerAssistantPanel({ eventId, assistantKey }: { eventId: string; assistantKey: ModuleAssistantKey }) {
  const catalog = useApi<{ entries: readonly AssistantCatalogEntry[] }>(`/organizer/events/${encodeURIComponent(eventId)}/module-assistants`);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [failure, setFailure] = useState("");
  const entry = catalog.data?.entries.find(item => item.key === assistantKey) ?? null;
  if (catalog.error || catalog.loading || !entry) return null;
  async function run() {
    if (busy || !instruction.trim()) return;
    setBusy(true); setFailure(""); setResult(null);
    try { setResult(await api<AssistantResult>(`/organizer/events/${encodeURIComponent(eventId)}/module-assistants/${assistantKey}`, { method: "POST", body: { instruction } })); }
    catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  return <details className={styles.details} aria-label="本模块助手">
    <summary>{MODULE_ASSISTANT_PANEL_TITLE} · {entry.label}</summary>
    <p className={styles.muted}>{MODULE_ASSISTANT_PANEL_READS}</p>
    <p className={styles.muted}>{MODULE_ASSISTANT_PANEL_COPY_HINT}</p>
    <p className={styles.muted}>{MODULE_ASSISTANT_PANEL_MANUAL_NOTE}</p>
    <p className={styles.muted}>{MODULE_ASSISTANT_PANEL_SWITCH}</p>
    <Field label="你想让它做什么" hint="只描述要做的事；它只给草稿或核对清单，不会替你执行任何操作。">
      <textarea rows={3} value={instruction} maxLength={2000} disabled={busy} onChange={change => setInstruction(change.target.value)}/>
    </Field>
    <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy || !instruction.trim()} onClick={() => void run()}>{busy ? "正在生成…" : "生成草稿"}</button></div>
    {failure && <p role="alert">{failure}</p>}
    {result && <AssistantResultView result={result}/>}
  </details>;
}
function AssistantResultView({ result }: { result: AssistantResult }) {
  const scope = result.usage.readScope;
  return <div>
    {result.status === "degraded"
      ? <p className={styles.warning}>助手暂不可用（{result.reason}）：{result.message} 人工流程照常可用。</p>
      : <>
        <h4>{result.draft.title}</h4>
        <p className={styles.prose}>{result.draft.body}</p>
        {result.draft.items.length > 0 && <ul>{result.draft.items.map((item, index) => <li key={index}>{item.text}</li>)}</ul>}
        {result.draft.notes.length > 0 && <ul>{result.draft.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
        <p className={styles.muted}>{result.disclaimer}</p>
      </>}
    <p className={styles.muted}>只读范围：{scope.factKeys.join("、") || "无"} · 读取时间：{scope.capturedAt}{scope.missing.length > 0 ? ` · 未读取：${scope.missing.join("；")}` : ""}</p>
    <p className={styles.muted}>账本条目：{result.usage.ledgerId ?? "本次没有产生模型调用，因此没有账本条目"} · 费用：{result.usage.cost === null ? "未产生调用" : result.usage.cost.microUsdEstimated === null ? result.usage.cost.note : String(result.usage.cost.microUsdEstimated)} · 平台不设次数上限。</p>
  </div>;
}
interface SwitchView { readonly assistantKey: string; readonly enabled: boolean; readonly revision: number }

/**
 * 规划34 P4：**赛事级模块助手开关**（内部运营项）。
 *
 * 默认全开；关闭即刻生效（不随正式发布版本冻结），每次改动写入既有的主办方审计。
 * 只挂在比赛设置页（`event_manage`），与其他 section 页共用的助手面板分开。
 */
export function OrganizerAssistantSwitches({ eventId }: { eventId: string }) {
  const base = `/organizer/events/${encodeURIComponent(eventId)}/module-assistant-switches`;
  const list = useApi<{ switches: readonly SwitchView[] }>(base);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  if (list.error || list.loading || !list.data) return null;
  async function toggle(current: SwitchView) {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await api(base, { method: "POST", body: { assistantKey: current.assistantKey, enabled: !current.enabled, expectedRevision: current.revision } }); await list.reload(); }
    catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); }
  }
  const label = (key: string) => MODULE_ASSISTANT_REGISTRY.find(entry => entry.key === key)?.label ?? key;
  return <details className={styles.details} aria-label="模块助手开关">
    <summary>{MODULE_ASSISTANT_PANEL_SWITCH}</summary>
    <p className={styles.muted}>默认全开；关闭后该模块的助手入口不再可用，人工流程照常。改动即时生效并写入既有审计，**不随正式发布版本冻结**。</p>
    <ul>{list.data.switches.map(item => <li key={item.assistantKey}>
      <label className={styles.check}><input type="checkbox" checked={item.enabled} disabled={busy} onChange={() => void toggle(item)}/><span>{label(item.assistantKey)}</span></label>
      <span className={styles.muted}> · {item.enabled ? "已开启" : "已关闭"}</span>
    </li>)}</ul>
    {failure && <p role="alert">{failure}</p>}
  </details>;
}
