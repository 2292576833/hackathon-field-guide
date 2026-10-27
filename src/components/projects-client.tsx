"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { DiscoveryCard } from "../server/discovery.ts";
import type { EventRuleVersion } from "../modules/events/domain.ts";
import type { OfficialTrackStatus } from "../modules/events/official-tracks.ts";
import type { ProjectOfficialTracksView } from "../modules/projects/collaboration.ts";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { Project, ProjectMember, ProjectStage, MemberAvailability } from "../modules/projects/model.ts";
import { ApiError, api, chinaInstant, dateText, localInput, message, operationKey, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, PageTitle, SiteShell } from "./site-shell.tsx";
import { MembershipActions } from "./membership-actions.tsx";
import { memberLabel } from "./member-display.ts";
import { InvitationPreviewClient } from "./invitation-client.tsx";
import { SpaceLifecycle } from "./space-lifecycle.tsx";
import { TeamTaskBoard } from "./team-task-board.tsx";
import { SpaceMissionWorkbench } from "./space-mission-workbench.tsx";
import { TeamFeed } from "../modules/team-collaboration/TeamFeed.tsx";
import { RecruitingPostManager } from "../modules/recruiting/RecruitingPostManager.tsx";
import { PersonalPreparationLinks, ProjectWorkflowNavigation, projectSections } from "./project-workflow.tsx";
import { PlanningNotificationsPanel } from "../modules/planning/components.tsx";
import styles from "./site.module.css";
import noviceStyles from "./novice-workspace.module.css";

export interface ProjectDetail { project: Project; membership: ProjectMember; members: (ProjectMember & { displayName?: string | null })[] }
export const stageNames: Record<string, string> = { draft: "草稿", preparing: "备赛", active: "执行中", finalizing: "整理提交", submitted: "已记录提交", retrospective: "复盘", archived: "已归档" };
// M02 remains authoritative, including prerequisites checked when saving.
const stageTransitions: Record<ProjectStage, readonly ProjectStage[]> = {
  draft: ["preparing", "retrospective", "archived"], preparing: ["draft", "active", "retrospective", "archived"],
  active: ["finalizing", "retrospective", "archived"], finalizing: ["active", "submitted", "retrospective", "archived"],
  submitted: ["retrospective", "archived"], retrospective: ["preparing", "archived"], archived: ["draft", "preparing"],
};
export const sections = projectSections;
export function ProjectsClient() {
  const state = useApi<Project[]>("/projects"); const [name, setName] = useState(""); const [goal, setGoal] = useState(""); const [minimum, setMinimum] = useState(""); const [deadline, setDeadline] = useState(""); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const [eventId, setEventId] = useState("");
  const [createOpen, setCreateOpen] = useState(false); const [createEdited, setCreateEdited] = useState(false);
  const creation = useRef<HTMLDetailsElement>(null);
  useEffect(() => { const values = new URLSearchParams(window.location.search).getAll("event"); if (values.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(values[0]!)) setEventId(values[0]!); }, []);
  const chosenEvent = useApi<DiscoveryCard>(eventId ? `/event-discoveries/${encodeURIComponent(eventId)}` : null);
  const returnTo = `/app${eventId ? `?event=${encodeURIComponent(eventId)}` : ""}`;
  useEffect(() => { if (chosenEvent.data && !chosenEvent.error) setName(value => value || (chosenEvent.data!.title + " · 参赛空间").slice(0, 120)); }, [chosenEvent.data, chosenEvent.error]);
  const chosenRulesHref = (id: string) => `/app/projects/${encodeURIComponent(id)}/rules${eventId ? `?discovery=${encodeURIComponent(eventId)}` : ""}`;
  const unauthenticated = state.error instanceof ApiError && state.error.status === 401;
  const readable = Boolean(state.data && !state.error && !state.loading);
  const projects = readable ? state.data! : [];
  const hasProjects = projects.length > 0;
  const activeProjects = projects.filter(project => project.stage !== "archived");
  const needsNewSpace = !hasProjects || Boolean(eventId && activeProjects.length === 0);
  // A single accessible space is a safe shortcut; the list order is not a recency or priority fact.
  const singleProject = activeProjects.length === 1 ? activeProjects[0] : projects.length === 1 ? projects[0] : null;
  const keepCreationVisible = createEdited || pending || Boolean(error);
  useEffect(() => {
    if (!readable) return;
    const revealCreation = () => { if (window.location.hash === "#create-project") setCreateOpen(true); };
    revealCreation(); window.addEventListener("hashchange", revealCreation);
    return () => window.removeEventListener("hashchange", revealCreation);
  }, [readable]);
  return <SiteShell>
    <PageTitle eyebrow="YOUR WORKSPACE" title="我的参赛">打开这次参赛的空间，看清下一步。一个人也能开始，队友可以随后加入。</PageTitle>
    {!unauthenticated && <Feedback error={state.error}/>}{state.loading && <Loading/>}
    {unauthenticated && <section className={`${styles.panel} ${noviceStyles.start}`}><h2>先登录，保存你的参赛准备</h2><p>登录后创建空间、查看自己的任务，或接受队友的邀请。</p><div className={styles.actions}><Link className={styles.button} href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>登录后开始参赛准备</Link><Link className={styles.link} href={`/register?returnTo=${encodeURIComponent(returnTo)}`}>注册账号</Link></div></section>}
    {state.error && !unauthenticated && <button className={styles.button} type="button" disabled={state.loading} onClick={() => void state.reload()}>重新读取团队空间</button>}
    {readable && <section className={`${styles.panel} ${noviceStyles.start}`} aria-labelledby="workspace-next-heading">
      <p className={noviceStyles.eyebrow}>{needsNewSpace ? "开始准备" : activeProjects.length ? "继续参赛" : "回顾记录"}</p>
      <h2 id="workspace-next-heading">{needsNewSpace ? "为这次参赛创建一个空间" : eventId ? "在空间里核对所选比赛" : singleProject ? singleProject.name : activeProjects.length ? "选择这次要继续的空间" : "选择要回顾的空间"}</h2>
      <p>{needsNewSpace ? "把作品目标、任务和成果放在一起。暂时没选好比赛或没有队友，也可以先开始。" : eventId ? "选择一个空间核对比赛线索。由空间管理员保存后队友才能查看，报名与官方规则仍需核对。" : singleProject?.stage === "archived" ? "这个空间已归档，可以回顾保存的任务、交付记录与经验。" : "进入空间后，工作台会按已读取的任务和准备记录告诉你下一步。"}</p>
      {!needsNewSpace && singleProject && projects.length === 1 && <><p className={noviceStyles.projectSummary}>{singleProject.minimumDeliverable || singleProject.goal || "作品目标尚未补齐，可以进入空间继续准备。"}</p><p className={styles.muted}>团队安排的截止：{dateText(singleProject.deadline)}；官方截止仍需核对。</p></>}
      <div className={styles.actions}>
        {needsNewSpace ? <a className={styles.button} href="#create-project" onClick={() => setCreateOpen(true)}>创建我的参赛空间 →</a> : <Link className={styles.button} href={singleProject ? eventId ? chosenRulesHref(singleProject.id) : `/app/projects/${encodeURIComponent(singleProject.id)}` : "#participating-projects-heading"}>{singleProject ? eventId ? "在此空间核对比赛" : singleProject.stage === "archived" ? "回顾这个空间" : "进入团队空间" : "选择参赛空间"} →</Link>}
        {needsNewSpace && !eventId && <Link className={styles.link} href="/events">还没选比赛？先去找比赛</Link>}
        {!needsNewSpace && singleProject && projects.length === 1 && <Link className={styles.link} href={`/app/projects/${encodeURIComponent(singleProject.id)}/plan`}>任务与进度</Link>}
      </div>
    </section>}
    {eventId && <section className={`${styles.panel} ${noviceStyles.eventContext}`}><h2>你选择的比赛</h2><Feedback error={chosenEvent.error}/>{chosenEvent.loading && <Loading/>}{chosenEvent.data && !chosenEvent.error && <><strong>{chosenEvent.data.title}</strong><p className={styles.muted}>这是待核对的比赛线索；不会自动完成报名或确认官方规则。</p></>}</section>}
    {hasProjects && (projects.length > 1 || needsNewSpace) && <section className={styles.panel} aria-labelledby="participating-projects-heading">
      <h2 id="participating-projects-heading">我的团队空间</h2>
      <div className={styles.cards}>{projects.map(project => <article key={project.id} className={styles.card}>
        <span className={styles.tag}>{stageNames[project.stage]}</span>
        <h3><Link href={`/app/projects/${encodeURIComponent(project.id)}`} className={styles.link}>{project.name}</Link></h3>
        <p className={noviceStyles.projectSummary}>{project.minimumDeliverable || project.goal || "先写清楚这次至少要做出什么，再开始分工。"}</p>
        <small className={styles.muted}>团队安排的截止：{dateText(project.deadline)}</small>
        <div className={styles.actions}><Link className={styles.secondary} href={eventId && project.stage !== "archived" ? chosenRulesHref(project.id) : `/app/projects/${encodeURIComponent(project.id)}`}>{project.stage === "archived" ? "回顾空间" : eventId ? "在此空间核对所选比赛" : "进入团队空间"}</Link><Link className={styles.link} href={`/app/projects/${encodeURIComponent(project.id)}/plan`}>任务与进度</Link></div>
      </article>)}</div>
    </section>}
    <Feedback error={error}/>
    {readable && <details ref={creation} className={`${styles.panel} ${noviceStyles.disclosure}`} id="create-project" open={createOpen || keepCreationVisible} onToggle={event => { if (!event.currentTarget.open && keepCreationVisible) { event.currentTarget.open = true; return; } setCreateOpen(event.currentTarget.open); }}><summary className={styles.summary}>{hasProjects ? "创建另一个参赛空间" : "创建我的参赛空间"}{createEdited && <span className={noviceStyles.draftLabel}>有未保存填写</span>}</summary>
      <p className={styles.muted}>先写清楚要做什么，创建后可邀请队友。没有队伍也能直接开始。</p>
      <form className={styles.form} onSubmit={async event => { event.preventDefault(); setPending(true); setError(""); try { const result = await api<Project>("/projects", { method: "POST", body: { name, goal, minimumDeliverable: minimum, timezone: "Asia/Shanghai", deadline: deadline ? chinaInstant(deadline) : null } }); window.location.assign(eventId ? chosenRulesHref(result.id) : `/app/projects/${encodeURIComponent(result.id)}`); } catch (reason) { setError(message(reason)); } finally { setPending(false); } }}>
        <div className={styles.grid}><Field label="空间名称"><input required maxLength={120} disabled={pending} value={name} onChange={event => { setName(event.target.value); setCreateEdited(true); }} placeholder="例如：帮助新人准备比赛的小工具"/></Field><Field label="计划完成时间（北京时间，可暂空）" hint="这是团队安排的时间。主办方的正式截止要在比赛要求中核对。"><input type="datetime-local" disabled={pending} value={deadline} onChange={event => { setDeadline(event.target.value); setCreateEdited(true); }}/></Field></div>
        <Field label="作品要解决什么问题（可稍后补充）"><textarea disabled={pending} value={goal} maxLength={4000} onChange={event => { setGoal(event.target.value); setCreateEdited(true); }}/></Field>
        <Field label="这次至少做出什么（可稍后补充）" hint="先确定评委或用户能实际体验的一个完整流程。"><textarea disabled={pending} value={minimum} maxLength={4000} onChange={event => { setMinimum(event.target.value); setCreateEdited(true); }}/></Field>
        <div className={styles.actions}><button className={styles.button} disabled={pending}>{pending ? "正在创建…" : "创建团队空间"}</button>{createEdited && <button type="button" className={styles.secondary} disabled={pending} onClick={() => { setName(""); setGoal(""); setMinimum(""); setDeadline(""); setCreateEdited(false); setError(""); setCreateOpen(false); }}>清空未保存填写</button>}</div>
      </form>
    </details>}
    {readable && <OwnPlanningNotifications/>}
    <section className={`${styles.panel} ${noviceStyles.officialLinks}`}><div><h2>正式报名与比赛</h2><p className={styles.muted}>查看通过本站提交的报名、审核与官方安排。</p></div><div className={styles.actions}><Link className={styles.link} href="/me/competitions">我的报名与比赛 →</Link><Link className={styles.link} href="/competitions">浏览主办方比赛</Link></div></section>
    <PersonalPreparationLinks/>
    <details className={`${styles.panel} ${noviceStyles.disclosure}`}><summary className={styles.summary}>固定队伍（长期一起参赛时再用）</summary><p className={styles.muted}>每次参赛空间单独邀请成员、安排任务；固定队伍可保留长期搭档。</p><Link className={styles.link} href="/app/teams">查看或管理固定队伍</Link></details>
    <p className={styles.muted}>需要看懂流程？<Link className={styles.link} href="/journey">打开参赛指引</Link>。找队友可到<Link className={styles.link} href="/recruiting">组队大厅</Link>，也可直接打开队友发来的邀请链接加入空间。</p>
  </SiteShell>;
}
export function ProjectNavigation({ projectId, section }: { projectId: string; section: string }) { return <ProjectWorkflowNavigation projectId={projectId} section={section}/>; }
function OwnPlanningNotifications() {
  const me = useApi<import("./site-shell.tsx").Me>("/me");
  return me.data ? <PlanningNotificationsPanel key={me.data.profile.id} viewerId={me.data.profile.id}/> : <Feedback error={me.error}/>;
}
export function SpaceTaskSummary({ detail }: { detail: ProjectDetail }) {
  const current = useApi<CurrentPlanningView>(`/projects/${encodeURIComponent(detail.project.id)}/plans/current`);
  // 空间 AI 助手已改为首屏浮动入口（规划27 第1期），这里不再内嵌，避免两处入口重复。
  return <><SpaceMissionWorkbench detail={detail} current={current.data} planningLoading={current.loading} planningError={current.error?.message ?? null}
    taskBoard={<TeamTaskBoard detail={detail} current={current.data} onSnapshot={current.setData} initialScope="team"/>}
    teamFeed={<TeamFeed projectId={detail.project.id} currentUserId={detail.membership.userId} reloadToken={0} authorLabels={Object.fromEntries(detail.members.map(member => [member.userId, memberLabel(member)]))}/>}/>
    <SpaceLifecycle detail={detail} current={current.data} planningLoading={current.loading} planningError={current.error?.message ?? null}/>
  </>;
}
/** 作品目标与团队截止：既用于总览，也在空间首屏的流程线上就地展开。 */
export function ProjectGoalForm({ detail, reload, expanded = false }: { detail: ProjectDetail; reload: () => Promise<void>; expanded?: boolean }) {
  const [goal, setGoal] = useState(detail.project.goal), [minimum, setMinimum] = useState(detail.project.minimumDeliverable);
  const [deadline, setDeadline] = useState(localInput(detail.project.deadline));
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const readonly = detail.membership.role !== "manager" || detail.project.stage === "archived";
  const dirty = goal !== detail.project.goal || minimum !== detail.project.minimumDeliverable || deadline !== localInput(detail.project.deadline);
  return <details className={styles.panel} id="project-goal" open={expanded || !detail.project.goal.trim() || !detail.project.minimumDeliverable.trim() || dirty || Boolean(error)}
    onToggle={event => { if (!event.currentTarget.open && (dirty || pending)) event.currentTarget.open = true; }}>
    <summary className={styles.summary}>作品目标与团队截止{dirty && <span className={noviceStyles.draftLabel}>有未保存填写</span>}</summary>
    <Feedback error={error} notice={notice}/>
    <p className={styles.muted}>修改目标和时间后，已有分工与计划需要重新核对。</p>
    <form className={styles.form} onSubmit={async event => {
      event.preventDefault(); setPending(true); setError(""); setNotice("");
      try {
        await api(`/projects/${detail.project.id}`, { method: "PATCH", body: { expectedRevision: detail.project.revision, goal, minimumDeliverable: minimum, deadline: deadline ? chinaInstant(deadline) : null } });
        setNotice("空间资料已保存。已有分工与计划需要重新检查。"); await reload();
      } catch (reason) { setError(message(reason)); } finally { setPending(false); }
    }}>
      <Field label="作品要解决什么问题"><textarea value={goal} placeholder="例如：帮第一次参赛的人快速找到适合自己的比赛。" maxLength={4000} disabled={readonly || pending} onChange={event => setGoal(event.target.value)}/></Field>
      <Field label="这次至少做出什么" hint="写清楚至少要能演示的一个完整流程，避免一开始做得太多。"><textarea value={minimum} placeholder="例如：用户选兴趣 → 看到三场比赛 → 打开报名链接。" maxLength={4000} disabled={readonly || pending} onChange={event => setMinimum(event.target.value)}/></Field>
      <Field label="团队计划完成时间（北京时间）" hint="这是团队安排的时间，正式比赛截止仍需从主办方要求中核对。"><input type="datetime-local" value={deadline} disabled={readonly || pending} onChange={event => setDeadline(event.target.value)}/></Field>
      {deadline && Date.parse(`${deadline}+08:00`) < Date.now() && <p role="status" className={styles.notice}>这个团队计划时间已经过去。继续备赛前，请核对是否需要调整。</p>}
      <button className={styles.button} disabled={pending || readonly}>{pending ? "正在保存…" : "保存空间资料"}</button>
      {readonly && <p className={styles.muted}>只有空间管理员能修改资料；归档空间只读。</p>}
    </form>
  </details>;
}

export function Overview({ detail, reload }: { detail: ProjectDetail; reload: () => Promise<void> }) {
  const [goal, setGoal] = useState(detail.project.goal); const [minimum, setMinimum] = useState(detail.project.minimumDeliverable); const [deadline, setDeadline] = useState(localInput(detail.project.deadline)); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [nextStage, setNextStage] = useState(""); const [stageReason, setStageReason] = useState(""); const [stageError, setStageError] = useState("");
  const readonly = detail.membership.role !== "manager" || detail.project.stage === "archived";
  const [stageNotice, setStageNotice] = useState("");
  const goalDirty = goal !== detail.project.goal || minimum !== detail.project.minimumDeliverable || deadline !== localInput(detail.project.deadline);
  const goalLocked = goalDirty || Boolean(error);
  const stageLocked = Boolean(nextStage || stageReason || stageError);
  return <><SpaceTaskSummary key={`${detail.membership.userId}:${detail.project.id}`} detail={detail}/>
    <Feedback error={error} notice={notice}/>
    <ProjectGoalForm detail={detail} reload={reload}/>
    <Feedback error={stageError} notice={stageNotice}/>
    {detail.membership.role === "manager" && <details className={styles.panel} open={stageLocked} onToggle={event => { if (!event.currentTarget.open && (stageLocked || pending)) event.currentTarget.open = true; }}><summary className={styles.summary}>调整参赛阶段{Boolean(nextStage || stageReason) && <span className={noviceStyles.draftLabel}>有未保存填写</span>}</summary><p className={styles.muted}>阶段记录团队当前安排；更新阶段不代表任务完成。目标、成员、时间或比赛要求实际变化时，仍需重新核对计划。浏览上方指引树不会改变团队记录。</p><form className={styles.form} onSubmit={async event => { event.preventDefault(); setPending(true); setStageError(""); setStageNotice(""); try { await api(`/projects/${detail.project.id}/stage`, { method: "POST", body: { expectedRevision: detail.project.revision, stage: nextStage, reason: stageReason } }); setStageNotice("阶段已更新。正式提交结果仍以“代码与提交”中的记录为准。"); setNextStage(""); setStageReason(""); await reload(); } catch (reason) { setStageError(message(reason)); } finally { setPending(false); } }}><Field label="下一阶段"><select required disabled={pending} value={nextStage} onChange={event => { setNextStage(event.target.value); setStageError(""); }}><option value="">请选择</option>{stageTransitions[detail.project.stage].map(value => <option key={value} value={value}>{stageNames[value]}</option>)}</select></Field>{nextStage === "preparing" && <p className={styles.muted}>开始备赛前需填写作品目标。</p>}{nextStage === "active" && <p className={styles.muted}>开始执行前，请先在“任务进度”中确认任务安排。</p>}{nextStage === "submitted" && <p className={styles.muted}>请先在“代码与提交”中记录向主办方的正式提交，再更新这个阶段。</p>}{detail.project.stage === "archived" && <p className={styles.muted}>重新进入团队空间后，请重新核对比赛截止与当前权限。</p>}<Field label="变更依据"><input required value={stageReason} onChange={event => setStageReason(event.target.value)} maxLength={1000} /></Field><button className={styles.secondary} disabled={pending || !nextStage}>确认更新阶段</button></form></details>}
    <p className={styles.muted}><Link className={styles.link} href="/journey">查看整套参赛路线图</Link>：了解通用步骤、注意事项和对应工具；本空间的实际进度以任务与提交记录为准。</p></>;
}
export function TeamPanel({ detail, reload }: { detail: ProjectDetail; reload: () => Promise<void> }) {
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [pending, setPending] = useState(false);
  const [removeUser, setRemoveUser] = useState(""); const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const administrator = detail.membership.role === "manager"; const readonly = detail.project.stage === "archived";
  const availability = useApi<{ availability: MemberAvailability | null; confirmationRequired: boolean }>(`/projects/${detail.project.id}/my-availability`);
  return <>
    <Feedback error={error} notice={notice}/>
    {administrator && !readonly && <details className={styles.panel}><summary className={styles.summary}>公开招募队友与处理加入申请</summary><RecruitingPostManager projectId={detail.project.id} isAdministrator onChanged={() => void reload()}/></details>}
    <section className={styles.panel}>
      <h2>一起参赛的队友</h2>
      <p className={styles.muted}>{detail.members.length < 2 ? "目前只有你，一个人也可以继续准备和安排任务。" : "队友在这个空间查看共享任务、资料和进度。"} {administrator && !readonly && "要拉人加入，点击页面顶部“邀请队友”。"}</p>
      <ul className={styles.list}>{detail.members.map(member => <li key={member.membershipId}>
        <strong>{memberLabel(member, detail.membership.userId, detail.members)}</strong> <span className={styles.tag}>{member.role === "manager" ? "空间管理员" : "空间成员"}</span>
        <details><summary className={styles.summary}>{administrator ? "成员设置与标识" : "查看成员标识"}</summary>
          <code className={styles.mono}>{member.membershipId}</code>
          {administrator && member.userId !== detail.membership.userId && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={pending || readonly} onClick={async () => {
            setPending(true); setError("");
            try { await api(`/projects/${detail.project.id}/members/${member.userId}`, { method: "PATCH", body: { expectedRevision: detail.project.revision, role: member.role === "manager" ? "member" : "manager" } }); setNotice("空间角色已更新，相关分工与计划需复核。"); await reload(); }
            catch(reason) { setError(message(reason)); } finally { setPending(false); }
          }}>{member.role === "manager" ? "改为普通成员" : "设为空间管理员"}</button></div>}
        </details>
      </li>)}</ul>
    </section>
    <section className={styles.panel}>
      <h2>我能投入的时间</h2>
      <p className={styles.muted}>填写真正可以工作的时间，先扣除休息、课程、出行和其他安排。队内安排会使用你确认的时间；私人行程不会自动共享。</p>
      <Feedback error={availability.error}/>{availability.loading && <Loading/>}
      {availability.data && <AvailabilityForm key={detail.project.id + ":" + (availability.data.availability?.revision ?? 0)} value={availability.data.availability} confirmationRequired={availability.data.confirmationRequired} readonly={readonly} onSave={async windows => {
        await api(`/projects/${detail.project.id}/my-availability`, { method: "PUT", body: { expectedRevision: availability.data?.availability?.revision ?? 0, timezone: "Asia/Shanghai", windows } });
        await availability.reload(); await reload(); setNotice("可用时间已确认。已有分工和计划需重新检查。");
      }}/>}
    </section>
    <details className={styles.panel}><summary className={styles.summary}>成员管理与历史</summary>
      <p className={styles.muted}>空间管理员管理本次参赛的邀请与权限，固定队伍队长管理长期队伍。</p>
      <MembershipActions scope="projects" id={detail.project.id} revision={detail.project.revision} userId={detail.membership.userId} manager={administrator && !readonly} members={detail.members} reload={reload}/>
      {administrator && <section className={styles.panel}><h2>移除空间成员</h2>
        <p className={styles.muted}>移除后相关分工和计划需要重新核对，历史成果会保留。</p>
        <Field label="要移除的活跃成员"><select value={removeUser} disabled={pending || readonly} onChange={event => { setRemoveUser(event.target.value); setRemoveConfirmed(false); }}>
          <option value="">请选择</option>{detail.members.filter(member => member.userId !== detail.membership.userId).map(member => <option key={member.userId} value={member.userId}>{memberLabel(member, detail.membership.userId, detail.members)} · {member.role === "manager" ? "空间管理员" : "空间成员"}</option>)}
        </select></Field>
        <label className={styles.check}><input type="checkbox" checked={removeConfirmed} disabled={pending || readonly} onChange={event => setRemoveConfirmed(event.target.checked)}/>确认移除所选成员，并随后复核分工与计划。</label>
        <button type="button" className={styles.secondary} disabled={pending || readonly || !removeUser || !removeConfirmed} onClick={async () => {
          setPending(true); setError("");
          try { await api(`/projects/${detail.project.id}/members/${encodeURIComponent(removeUser)}`, { method: "DELETE", body: { expectedRevision: detail.project.revision } }); setRemoveUser(""); setRemoveConfirmed(false); await reload(); setNotice("成员已移除，请复核当前分工和计划。"); }
          catch(reason) { setError(message(reason)); } finally { setPending(false); }
        }}>确认移除成员</button>
      </section>}
    </details>
  </>;
}
export function MyAvailabilityPanel({ detail, reload }: { detail: ProjectDetail; reload: () => Promise<void> }) {
  const state = useApi<{ availability: MemberAvailability | null; confirmationRequired: boolean }>(`/projects/${encodeURIComponent(detail.project.id)}/my-availability`);
  return <section className={styles.panel} aria-label="我能投入的时间"><h3>我能投入的时间</h3><p className={styles.muted}>填写实际可以工作的起止时间，按北京时间保存；先扣除休息、课程和出行。只修改你自己的时间。</p>
    <Feedback error={state.error}/>{state.loading && <Loading/>}
    {state.error && <button type="button" className={styles.secondary} onClick={() => void state.reload()}>重新读取本人时间</button>}
    {state.data && <AvailabilityForm key={`${detail.project.id}:${state.data.availability?.revision ?? 0}`} value={state.data.availability} confirmationRequired={state.data.confirmationRequired} readonly={detail.project.stage === "archived"} onSave={async windows => {
      await api(`/projects/${encodeURIComponent(detail.project.id)}/my-availability`, { method: "PUT", body: { expectedRevision: state.data!.availability?.revision ?? 0, timezone: "Asia/Shanghai", windows } });
      await state.reload(); await reload();
    }}/>}
  </section>;
}
function AvailabilityForm({value,confirmationRequired,readonly,onSave}:{value:MemberAvailability|null;confirmationRequired:boolean;readonly:boolean;onSave:(windows:{id:string;startsAt:string;endsAt:string;effectiveMinutes:number}[])=>Promise<void>}){
  const [windows,setWindows]=useState(()=>value?.windows.map(window=>({id:window.id,start:localInput(window.startsAt),end:localInput(window.endsAt)}))??[{id:operationKey(),start:"",end:""}]);const [pending,setPending]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");
  return <form className={styles.form} onSubmit={async event=>{event.preventDefault();setPending(true);setError("");try{const input=windows.map(window=>{const startsAt=chinaInstant(window.start),endsAt=chinaInstant(window.end);const effectiveMinutes=(Date.parse(endsAt)-Date.parse(startsAt))/60000;if(effectiveMinutes<=0)throw new Error("每个时间段的结束必须晚于开始。");return{id:window.id,startsAt,endsAt,effectiveMinutes};});await onSave(input);setNotice("可用时间已确认。已有分工和计划需重新检查。");}catch(reason){setError(message(reason));}finally{setPending(false);}}}>{confirmationRequired&&<p className={styles.notice}>还没有确认可用时间，或空间成员信息有变化。请检查后保存。</p>}{windows.map((window,index)=><div className={styles.grid} key={window.id}><Field label={`时间段 ${index+1} · 开始（北京时间）`}><input type="datetime-local" required value={window.start} disabled={readonly||pending} onChange={event=>setWindows(windows.map(item=>item.id===window.id?{...item,start:event.target.value}:item))}/></Field><Field label="结束（北京时间）"><input type="datetime-local" required value={window.end} disabled={readonly||pending} onChange={event=>setWindows(windows.map(item=>item.id===window.id?{...item,end:event.target.value}:item))}/></Field><button type="button" className={styles.secondary} disabled={readonly||pending} onClick={()=>setWindows(windows.filter(item=>item.id!==window.id))}>移除此时间段</button></div>)}<div className={styles.actions}><button type="button" className={styles.secondary} disabled={readonly||pending||windows.length>=100} onClick={()=>setWindows([...windows,{id:operationKey(),start:"",end:""}])}>增加可工作时间段</button><button className={styles.button} disabled={pending||readonly}>确认并保存可用时间</button></div><Feedback error={error} notice={notice}/></form>;
}
export function InvitationClient({token}:{token:string}){return <InvitationPreviewClient token={token}/>;}

const officialTrackStatus: Record<OfficialTrackStatus, string> = {
  unknown: "赛道待核对", none: "主办方未细分赛道", conflict: "赛道信息存在冲突", confirmed: "主办方官方赛道",
};

export function OfficialTrackPanel({ detail, onProjectChange }: { detail: ProjectDetail; onProjectChange?: () => Promise<void> }) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}`;
  const state = useApi<ProjectOfficialTracksView>(`${base}/official-tracks`);
  const evidence = useApi<{ rules: EventRuleVersion | null }>(`${base}/rules`);
  useEffect(() => {
    const refresh = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      // Existing local intention events have no detail. Scoped events from
      // another space must never refresh this space's form or its evidence.
      if (projectId !== undefined && projectId !== detail.project.id) return;
      void Promise.all([state.reload(), evidence.reload()]);
    };
    window.addEventListener("hackathon:project-input-changed", refresh);
    return () => window.removeEventListener("hackathon:project-input-changed", refresh);
  }, [detail.project.id, state.reload, evidence.reload]);
  return <section className={styles.panel} id="official-track">
    <h2>本次参加哪个官方赛道</h2>
    <p className={styles.muted}>赛道以主办方规则为准。每个人可以承担多类工作；工具和技能包的分类只用于找资源。</p>
    <Feedback error={state.error}/>{state.loading && !state.data && <Loading/>}
    {state.error && <p className={styles.notice}>暂时无法读取赛道记录。可以先做通用准备；请核对原文后再确定赛道。</p>}
    {state.data && <OfficialTrackForm detail={detail} value={state.data} rules={evidence.data?.rules ?? null}
      refresh={async () => { await state.reload(); await evidence.reload(); }} onSaved={async value => { state.setData(value); window.dispatchEvent(new CustomEvent("hackathon:project-input-changed", { detail: { projectId: detail.project.id } })); await onProjectChange?.(); }}/>} 
  </section>;
}

function OfficialTrackForm({ detail, value, rules, refresh, onSaved }: {
  detail: ProjectDetail; value: ProjectOfficialTracksView; rules: EventRuleVersion | null;
  refresh: () => Promise<void>; onSaved: (value: ProjectOfficialTracksView) => Promise<void>;
}) {
  const [baseline, setBaseline] = useState(value);
  const [trackId, setTrackId] = useState(value.selection?.trackId ?? "");
  const [reason, setReason] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  useEffect(() => {
    // The first confirmed rules make an untouched empty form usable immediately.
    // Later versions keep the old baseline and all edits until explicit adoption.
    if (!baseline.rules && !baseline.selection && value.rules && !pending && !trackId && !reason && !confirmed) setBaseline(value);
  }, [value, baseline.rules, baseline.selection, pending, trackId, reason, confirmed]);
  const context = baseline.rules;
  const changed = baseline.selection?.revision !== value.selection?.revision ||
    baseline.rules?.confirmationRevision !== value.rules?.confirmationRevision || baseline.projectRevision !== value.projectRevision;
  const readonly = value.readonly || !value.canManage || detail.project.stage === "archived";
  const selected = context?.catalog.tracks.find(track => track.id === trackId);
  const matchingRules = rules && context && rules.eventId === context.eventId && rules.version === context.rulesVersion ? rules : null;
  const evidenceIds = context ? Array.from(new Set([
    ...context.catalog.evidenceIds, ...(selected?.evidenceIds ?? []), ...(selected?.eligibility?.evidenceIds ?? []),
    ...(selected?.scoringFocus?.evidenceIds ?? []), ...(selected?.deliverables.flatMap(item => item.evidenceIds) ?? []),
  ])) : [];
  return <>
    {value.selection && <p><strong>已保存：{value.selection.trackName ?? "统一要求"}</strong> · 规则版本 {value.selection.rulesVersion} · {dateText(value.selection.selectedAt)}</p>}
    {value.needsReview && <p className={styles.notice}>主办方规则或本空间选择有变化。原选择和已确认安排已保留，请重新核对后再更新分工与时间。</p>}
    {value.rules?.latestPublishedRulesVersion && value.rules.latestPublishedRulesVersion !== value.rules.rulesVersion && <p className={styles.notice}>主办方规则已有版本 {value.rules.latestPublishedRulesVersion}，本空间仍使用版本 {value.rules.rulesVersion}。请先在比赛要求中核对新规则。</p>}
    {!context && <Empty>先确认本空间使用的比赛规则版本，才能保存赛道选择。现在可以先整理作品目标、时间和通用任务。</Empty>}
    {context && <>
      <p><span className={styles.tag}>{officialTrackStatus[context.catalog.status]}</span>规则版本 {context.rulesVersion}</p>
      {context.catalog.status === "unknown" && <p>当前证据还不足以确认赛道；旧版规则缺少赛道记录时也保留这个状态。</p>}
      {context.catalog.status === "conflict" && <p>不同规则证据未能对齐，请先核对主办方原文。冲突解决前不保存正式选择。</p>}
      {context.catalog.status === "none" && <p>按主办方统一要求分工，无需选择资源包分类作为赛道。</p>}
      {changed && <p className={styles.notice}>服务器已有新版本，你正在填写的内容仍保留。先读取最新版本再提交。</p>}
      <form className={styles.form} onSubmit={async event => {
        event.preventDefault(); setPending(true); setError(""); setNotice("");
        try {
          const next = await api<ProjectOfficialTracksView>(`/projects/${encodeURIComponent(detail.project.id)}/track-selection`, {
            method: "PUT", body: { expectedRevision: baseline.selection?.revision ?? 0, eventId: context.eventId, confirmationRevision: context.confirmationRevision, rulesVersion: context.rulesVersion,
              trackId: context.catalog.status === "none" ? null : trackId, reason },
          });
          setBaseline(next); setConfirmed(false); setReason(""); await onSaved(next);
          setNotice("项目赛道选择已保存。请复核分工与时间；原选择保留在历史中。");
        } catch (failure) { setError(`${message(failure)} 输入仍保留。`); } finally { setPending(false); }
      }}>
        {context.catalog.status === "confirmed" && <Field label="选择主办方公布的赛道"><select required value={trackId} disabled={readonly || pending} onChange={event => { setTrackId(event.target.value); setConfirmed(false); }}>
          <option value="">请选择官方赛道</option>{context.catalog.tracks.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}
        </select></Field>}
        {selected && <div className={styles.card}>
          <h3>{selected.name}</h3><p>适用资格：{selected.eligibility?.text ?? "待核对"}</p>
          <p>评分重点：{selected.scoringFocus?.text ?? "待核对"}</p>
          <p>必交材料：{selected.deliverables.map(item => matchingRules?.requirements.find(requirement => requirement.id === item.requirementId)?.label ?? "材料说明待核对").join("、") || "待核对"}</p>
        </div>}
        {["none", "confirmed"].includes(context.catalog.status) && <>
          <Field label="本次选择依据"><textarea required maxLength={1000} value={reason} disabled={readonly || pending} onChange={event => { setReason(event.target.value); setConfirmed(false); }} placeholder="说明团队核对了哪些官方要求，以及为什么选择这个方向。"/></Field>
          <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={readonly || pending} onChange={event => setConfirmed(event.target.checked)}/>我已核对当前规则和赛道证据，确认用于本次分工。</label>
          <button className={styles.button} disabled={readonly || pending || changed || !confirmed || !reason.trim() || (context.catalog.status === "confirmed" && !selected)}>保存本空间赛道选择</button>
        </>}
      </form>
    </>}
    <Feedback error={error} notice={notice}/>
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={pending} onClick={async () => { await refresh(); }}>检查服务器新版本</button>
      {changed && <button type="button" className={styles.secondary} disabled={pending} onClick={() => {
        if ((reason.trim() || trackId !== (baseline.selection?.trackId ?? "")) && !window.confirm("读取最新版本会替换本页尚未保存的赛道输入。是否继续？")) return;
        setBaseline(value); setTrackId(value.selection?.trackId ?? ""); setReason(""); setConfirmed(false);
      }}>载入最新版本</button>}
      <Link className={styles.link} href={`/app/projects/${encodeURIComponent(detail.project.id)}/rules`}>核对比赛要求</Link>
    </div>
    {matchingRules && evidenceIds.length > 0 && <details><summary className={styles.summary}>查看官方赛道依据</summary><ul className={styles.list}>{evidenceIds.map(id => {
      const item = matchingRules.evidence.find(value => value.id === id);
      const source = matchingRules.sources.find(value => value.id === item?.sourceId);
      const url = safeLink(source?.url);
      return item ? <li key={id}><p>{item.excerpt}</p>{url && <a className={styles.link} href={url} target="_blank" rel="noreferrer">打开官方原文</a>}<p className={styles.muted}>{item.locator} · 核对于 {dateText(item.verifiedAt)}</p></li> : <li key={id}>依据暂时无法读取，请核对官方原文。</li>;
    })}</ul></details>}
    {value.history.length > 0 && <details><summary className={styles.summary}>赛道选择历史</summary><ul className={styles.list}>{value.history.map(item => <li key={item.revision}>版本 {item.revision} · {item.trackName ?? "统一要求"} · 规则 {item.rulesVersion}<p>{item.reason}</p><p className={styles.muted}>{dateText(item.selectedAt)}</p></li>)}</ul></details>}
    {readonly && <p className={styles.muted}>空间成员可查看选择与依据；保存选择需要当前空间管理员权限。归档空间只读。</p>}
  </>;
}
