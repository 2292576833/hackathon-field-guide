"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useApi } from "./client-api.ts";
import { Feedback, Loading, SiteShell } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import { SpaceOperationDeck } from "./space-operation-deck.tsx";
import { projectSectionTitle } from "./project-workflow.tsx";
import { SpaceInvitationTrigger } from "./space-invitation-trigger.tsx";
import styles from "./site.module.css";

// Load each editor when its section is actually rendered. Keep the canvas entry eager.
const TeamPanel = dynamic(() => import("./projects-client.tsx").then(module => module.TeamPanel), { loading: Loading });
const OfficialTrackPanel = dynamic(() => import("./projects-client.tsx").then(module => module.OfficialTrackPanel), { loading: Loading });
const SpaceSubmissionChecklist = dynamic(() => import("./space-lifecycle.tsx").then(module => module.SpaceSubmissionChecklist), { loading: Loading });
const AssignmentPanel = dynamic(() => import("./planning-client.tsx").then(module => module.AssignmentPanel), { loading: Loading });
const PlanPanel = dynamic(() => import("./planning-client.tsx").then(module => module.PlanPanel), { loading: Loading });
const ProjectResourcesPanel = dynamic(() => import("./discovery-client.tsx").then(module => module.ProjectResourcesPanel), { loading: Loading });
const RulesPanel = dynamic(() => import("./discovery-client.tsx").then(module => module.RulesPanel), { loading: Loading });
const DeliveryPanel = dynamic(() => import("./delivery-client.tsx").then(module => module.DeliveryPanel), { loading: Loading });
const RetrospectivePanel = dynamic(() => import("./retrospective-client.tsx").then(module => module.RetrospectivePanel), { loading: Loading });
const AssessmentPanel = dynamic(() => import("./assessment-client.tsx").then(module => module.AssessmentPanel), { loading: Loading });
const MemberIntentionsPanel = dynamic(() => import("./assessment-client.tsx").then(module => module.MemberIntentionsPanel), { loading: Loading });
const RuleAnalysisPanel = dynamic(() => import("./rule-analysis-client.tsx").then(module => module.RuleAnalysisPanel), { loading: Loading });
const RepositoryPanel = dynamic(() => import("./repository-client.tsx").then(module => module.RepositoryPanel), { loading: Loading });
const ExperiencePanel = dynamic(() => import("./experience-client.tsx").then(module => module.ExperiencePanel), { loading: Loading });
const ProjectSkillSelectionClient = dynamic(() => import("./project-skill-selection.tsx").then(module => module.ProjectSkillSelectionClient), { loading: Loading });
const ProjectActions = dynamic(() => import("./project-actions.tsx").then(module => module.ProjectActions), { loading: Loading });

export function ProjectClient({ projectId, section = "" }: { projectId: string; section?: string }) {
  const state = useApi<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`);
  const detail = state.data;
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  useEffect(() => {
    if (!detail || section !== "") return;
    const revealSection = () => {
      if (!["#space-settings", "#project-goal"].includes(window.location.hash)) return;
      const target = document.getElementById(window.location.hash.slice(1));
      if (!(target instanceof HTMLDetailsElement)) return;
      target.open = true;
      target.scrollIntoView({ block: "start" });
    };
    revealSection();
    const revealClickedSection = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !["#space-settings", "#project-goal"].includes(url.hash)) return;
      const target = document.getElementById(url.hash.slice(1));
      if (target instanceof HTMLDetailsElement) { target.open = true; target.scrollIntoView({ block: "start" }); }
    };
    window.addEventListener("hashchange", revealSection);
    document.addEventListener("click", revealClickedSection);
    return () => { window.removeEventListener("hashchange", revealSection); document.removeEventListener("click", revealClickedSection); };
  }, [detail, section]);
  return <SiteShell wide bare={section === ""}>
    <Feedback error={state.error}/>{state.loading && <Loading/>}
    {detail && <>
      {section !== "" && <nav aria-label="当前团队空间" className={styles.panel} style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}><Link className={styles.link} href={`/app/projects/${encodeURIComponent(projectId)}`}>← 返回团队空间</Link><h1 style={{ margin: 0, fontSize: 20, overflowWrap: "anywhere" }}>{detail.project.name}</h1><span className={styles.muted}>{projectSectionTitle(section)}</span><SpaceInvitationTrigger detail={detail} onChanged={state.reload}/></nav>}
      {detail.project.stage === "archived" && <p className={styles.notice}>空间已归档，工作记录只读。</p>}
      {section === "" && <>
        <SpaceOperationDeck key={`${projectId}:${detail.membership.userId}`} detail={detail} reload={state.reload} membersError={state.error?.message}/>
        <details key={`settings:${projectId}`} className={styles.panel} id="space-settings" onToggle={event => { if (event.currentTarget.open) setSettingsProject(projectId); }}><summary className={styles.summary}>空间设置与历史记录</summary><p className={styles.muted}>关联固定队伍、创建下一次团队空间、查看变更记录或离开空间。</p>{settingsProject === projectId && <ProjectActions key={`actions:${projectId}`} detail={detail} reload={state.reload}/>}</details>
      </>}
      {section === "team" && <><TeamPanel key={projectId} detail={detail} reload={state.reload}/>
        <section className={styles.panel}><h2>下一步：选择愿意做的事</h2><p>可以多选职责，不确定时请 AI 帮助；一个人也能继续。管理员再核对每个人的交付物和依赖。</p>
          <Link className={styles.button} href={`/app/projects/${encodeURIComponent(projectId)}/assessment`}>选择职责与确定分工</Link>
        </section>
      </>}
      {section === "rules" && <><RulesPanel key={projectId} detail={detail}/><OfficialTrackPanel key={`track:${projectId}`} detail={detail} onProjectChange={state.reload}/><RuleAnalysisPanel key={`analysis:${projectId}`} detail={detail}/></>}
      {section === "assessment" && <>
        <OfficialTrackPanel key={`track:${projectId}`} detail={detail} onProjectChange={state.reload}/>
        <MemberIntentionsPanel key={`intention:${projectId}`} detail={detail} onProjectChange={state.reload}/>
        <AssignmentPanel key={projectId} detail={detail}/>
        <details className={styles.panel}><summary className={styles.summary}>可选：通过测评了解自己适合的任务</summary><p className={styles.muted}>不知道如何分工时，可回答已发布的题组。原始回答仅本人可见，你可以主动选择向队友分享哪些摘要。</p><AssessmentPanel key={`assessment:${projectId}`} detail={detail}/></details>
      </>}
      {section === "plan" && <PlanPanel key={projectId} detail={detail}/>}
      {section === "delivery" && <><SpaceSubmissionChecklist detail={detail}/><RepositoryPanel key={projectId} detail={detail}/><DeliveryPanel key={`delivery:${projectId}`} detail={detail}/></>}
      {section === "resources" && <><ProjectResourcesPanel key={projectId} detail={detail}/><details className={styles.panel}><summary className={styles.summary}>本次项目的技能与技能包（可选）</summary><p>记录团队选择的固定版本、用途和学习时间。选择后仍需在自己的工具里安装与验证。</p><ProjectSkillSelectionClient key={`${detail.membership.userId}:${projectId}`} projectId={projectId}/></details></>}
      {section === "retrospective" && <><RetrospectivePanel key={projectId} detail={detail}/><ExperiencePanel key={`experience:${projectId}`} detail={detail}/></>}
    </>}
  </SiteShell>;
}
