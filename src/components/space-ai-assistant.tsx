"use client";
import { useState } from "react";
import { TeamAssistantPanel } from "../modules/team-assistant/TeamAssistantPanel.tsx";
import { FeasibilityPanel } from "../modules/team-assistant/FeasibilityPanel.tsx";
import type { AssistantShareSelection } from "../modules/team-assistant/model.ts";
import { api, operationKey } from "./client-api.ts";
import styles from "./site.module.css";

export function SpaceAiAssistant({ projectId, projectName, accountKey, readOnly, onShared }: {
  projectId: string; projectName: string; accountKey: string; readOnly: boolean; onShared?: () => void;
}) {
  const [mode, setMode] = useState<"guide" | "idea">("guide");
  const [sharedNotice, setSharedNotice] = useState("");
  const [pendingShare, setPendingShare] = useState<{ selection: AssistantShareSelection; key: string } | null>(null);
  async function share(selection: AssistantShareSelection) {
    const previous = pendingShare;
    const key = previous && JSON.stringify(previous.selection) === JSON.stringify(selection) ? previous.key : operationKey();
    setPendingShare({ selection, key });
    setSharedNotice("");
    await api(`/projects/${encodeURIComponent(projectId)}/team-feed`, { method: "POST", idempotencyKey: key, body: {
      sourceKind: selection.sourceKind, sourceId: selection.sourceId, title: selection.sourceKind === "feasibility" ? "选题检查：请队友一起考虑" : "空间助手：请队友一起考虑",
      body: selection.fragment, idempotencyKey: key,
    } });
    setPendingShare(null); setSharedNotice("所选建议已发布到本空间的团队动态，队友可以查看和讨论。"); onShared?.();
  }
  const apiBase = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  return <div>
    <p className={styles.muted}>这是你在「{projectName}」的私人助手。它继承本人导航记忆，结合本空间任务和已分享建议；导航员仍可单独使用。</p>
    <nav className={styles.actions} aria-label="空间助手用途">
      <button type="button" className={mode === "guide" ? styles.button : styles.secondary} aria-pressed={mode === "guide"} onClick={() => setMode("guide")}>帮我做下一步</button>
      <button type="button" className={mode === "idea" ? styles.button : styles.secondary} aria-pressed={mode === "idea"} onClick={() => setMode("idea")}>检查项目想法</button>
    </nav>
    {sharedNotice && <p role="status" className={styles.notice}>{sharedNotice}</p>}
    <div hidden={mode !== "guide"}><TeamAssistantPanel accountKey={accountKey} projectId={projectId} projectName={projectName} apiBase={apiBase} readOnly={readOnly} onShare={share}/></div>
    <div hidden={mode !== "idea"}><FeasibilityPanel accountKey={accountKey} projectId={projectId} apiBase={apiBase} readOnly={readOnly} onShare={share}/></div>
  </div>;
}
