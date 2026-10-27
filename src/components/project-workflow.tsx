"use client";

import Link from "next/link";
import type { Project } from "../modules/projects/model.ts";
import styles from "./site.module.css";
import noviceStyles from "./novice-workspace.module.css";

export const projectSections = [
  ["", "工作台"], ["team", "队友与分工"], ["plan", "任务进度"],
  ["rules", "比赛与资料"], ["delivery", "提交与复盘"],
] as const;

const subSections = {
  team: [["team", "队友与时间"], ["assessment", "职责与分工"]],
  rules: [["rules", "比赛要求"], ["resources", "共享资料"]],
  delivery: [["delivery", "代码与提交"], ["retrospective", "复盘与经验"]],
} as const;

function primarySection(section: string): string {
  if (section === "assessment") return "team";
  if (section === "resources") return "rules";
  if (section === "retrospective") return "delivery";
  return section;
}

export function projectSectionTitle(section: string): string {
  const primary = primarySection(section);
  const title = projectSections.find(([slug]) => slug === primary)?.[1] ?? "团队空间";
  const children = subSections[primary as keyof typeof subSections];
  const child = children?.find(([slug]) => slug === section)?.[1];
  return child ? `${title} · ${child}` : title;
}

export function ProjectWorkflowNavigation({ projectId, section }: { projectId: string; section: string }) {
  const base = `/app/projects/${encodeURIComponent(projectId)}`;
  const primary = primarySection(section);
  const children = subSections[primary as keyof typeof subSections];
  return <>
    <nav className={styles.tabs} aria-label="团队空间">
      {projectSections.map(([slug, label]) => <Link key={slug} className={styles.tab}
        aria-current={primary === slug ? "page" : undefined}
        href={`${base}${slug ? `/${slug}` : ""}`}>{label}</Link>)}
    </nav>
    {children && <div className={styles.spaceSubnavigation}>
      <nav className={styles.tabs} aria-label={`${projectSections.find(([slug]) => slug === primary)?.[1]}内容`}>
        {children.map(([slug, label]) => <Link key={slug} className={styles.tab} aria-current={section === slug ? "page" : undefined} href={`${base}/${slug}`}>{label}</Link>)}
      </nav>
    </div>}
  </>;
}

export function PersonalPreparationLinks({ compact = false }: { compact?: boolean }) {
  return <details className={`${styles.panel} ${noviceStyles.disclosure}`}>
    <summary className={styles.summary}>{compact ? "准备我的路演与 PPT" : "个人准备（出行、路演与经验）"}</summary>
    <p className={styles.muted}>{compact ? "讲稿和 PPT 大纲先保存在本人账号。需要队友查看时，请导出后自行分享或加入空间资料。" : "按需准备，内容仅本人可见。个人建议计划不替代空间里已确认的任务安排。"}</p>
    <ul className={noviceStyles.preparationLinks}>
      {!compact && <><li><Link className={styles.link} href="/participation">参赛与出行建议</Link><span>选定比赛后，整理本人的准备和行程。</span></li><li><Link className={styles.link} href="/app/account#participant-profile">我的经验与时间</Link><span>填写本人资料，供个人计划和助手参考。</span></li></>}
      <li><Link className={styles.link} href="/roadshow">准备路演讲稿</Link><span>需要展示作品时，先整理要讲清的内容。</span></li>
      <li><Link className={styles.link} href="/ppt">准备 PPT 大纲</Link><span>可继承本人讲稿，继续组织逐页内容。</span></li>
      {!compact && <li><Link className={styles.link} href="/app/experience">我的经验、复盘与草稿</Link><span>回顾已经保存的私人经验。</span></li>}
    </ul>
    {compact && <p className={styles.muted}>选择并确认空间资料后，可带入路演或 PPT；已保存的讲稿也可以继续用于制作 PPT。</p>}
  </details>;
}

export function ProjectNextStep({ project, memberCount, canEdit }: { project: Project; memberCount: number; canEdit: boolean }) {
  const base = `/app/projects/${encodeURIComponent(project.id)}`;
  let next = { href: `${base}/rules`, title: "核对比赛要求", text: "先查看资格、时间和需要提交的材料，再安排团队工作。" };
  if (project.stage === "archived") next = { href: `${base}/retrospective`, title: "查看这次参赛的复盘", text: "空间已归档，可以查看保存的资料与经验。" };
  else if (!project.goal.trim() || !project.minimumDeliverable.trim()) next = { href: `${base}#project-goal`, title: canEdit ? "写清楚这次要做出什么" : "查看作品目标", text: canEdit ? "先确定作品解决的问题，以及至少要能演示的一个流程，再开始分工。" : "作品目标还需要补充。先查看已有想法，与空间管理员确定至少要能演示的一个流程。" };
  else if (project.stage === "active") next = { href: `${base}/plan`, title: "查看任务与更新进度", text: "先看自己负责的任务，再记录实际进展和遇到的问题。" };
  else if (project.stage === "finalizing") next = { href: `${base}/delivery`, title: "检查作品并准备提交", text: "核对代码保存、能否运行和官方提交记录，完成其中一项不会自动代表其他项成功。" };
  else if (project.stage === "submitted" || project.stage === "retrospective") next = { href: `${base}/retrospective`, title: "整理这次的经验", text: "记录做成了什么、遇到什么问题，为下次参赛留下可复用的经验。" };
  else if (project.stage === "preparing" && memberCount < 2) next = { href: `${base}/team`, title: "填写时间，或邀请队友", text: "一个人也可以安排任务；多人参赛时，先邀请队友并确认各自可投入的时间。" };
  return <section className={styles.panel} aria-labelledby="project-next-step-heading"><h2 id="project-next-step-heading">从这里继续</h2><p>{next.text}</p><Link href={next.href} className={styles.button}>{next.title}</Link></section>;
}
