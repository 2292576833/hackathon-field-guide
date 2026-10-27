"use client";
import { useState } from "react";
import type { Project } from "../modules/projects/model.ts";
import { ShareSuggestionPreview } from "../modules/team-collaboration/ShareSuggestionPreview.tsx";
import styles from "./site.module.css";

export function NavigatorShare({ sourceId, content, projects, currentProjectId }: {
  sourceId: string; content: string; projects: readonly Project[]; currentProjectId?: string;
}) {
  const [open, setOpen] = useState(false);
  const available = projects.filter(project => project.stage !== "archived");
  const [chosenId, setChosenId] = useState(currentProjectId ?? "");
  if (!available.length) return null;
  const selected = available.some(project => project.id === chosenId) ? chosenId : "";
  return <div>
    <button type="button" className={styles.secondary} aria-expanded={open} onClick={() => setOpen(value => !value)}>把有用建议分享给队友</button>
    {open && <div className={styles.form}><label>分享到哪个团队空间<select value={selected} onChange={event => setChosenId(event.target.value)}>
      <option value="">请选择团队空间</option>{available.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label><p className={styles.muted}>先选择片段并预览，只公开你明确确认的内容。</p>
    {selected && <ShareSuggestionPreview projectId={selected} sourceKind="navigator" sourceId={sourceId} initialBody={content}/>}</div>}
  </div>;
}
