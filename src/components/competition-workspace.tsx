"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, api, dateText, message, operationKey, useApi } from "./client-api.ts";
import { Field, Feedback, Loading, PageTitle, SiteShell, type Me } from "./site-shell.tsx";
import { OrganizerEntry, OrganizerWorkspace, CompetitionDirectory, CompetitionOverview, AdminOrganizationReview, AdminClaimReview } from "../modules/organizer/ui.ts";
import type { CompetitionIdentity, EventReadinessItem, HostedEvent, PublicCompetition, PublicationChange } from "../modules/organizer/model.ts";
import { DASHBOARD_PANELS, DASHBOARD_PANEL_CAPABILITIES, DASHBOARD_PANEL_LABELS, type DashboardPanelKey, type DashboardView } from "../modules/organizer/dashboard.ts";
import { MyCompetitions, RegistrationPanel, RegistrationManager, RosterTeamManager, RosterTeamsPanel } from "../modules/event-registration/ui.ts";
import type { MyRegistrationView, RegistrationFormView, TeamsView } from "../modules/event-registration/model.ts";
import { EventCommunicationPanel, CommunicationManager, EventSchedulePanel, ScheduleManager, OwnEventServices, LogisticsManager } from "../modules/event-communication/ui.ts";
import type { AnnouncementView, PublicFaq } from "../modules/event-communication/model.ts";
import { EventSubmissionPanel, EventResultsPanel, JudgeWorkspace, JudgingManager } from "../modules/event-judging/ui.ts";
import { ContactWillingnessCard, PostEventClosurePanel } from "../modules/event-closure/ui.ts";
import { CommunityPanel, OrganizerCommunityReportsPanel } from "../modules/event-community/ui.ts";
import { MyWorkShowcase, OrganizerWorkShowcase } from "./work-showcase.tsx";
import { OrganizerStaffInvitations } from "./organizer-staff-invitations.tsx";
import { SelectionNoticeTemplateEditor, SelectionNoticeAction, MySelectionNotices } from "../modules/selection-notices/ui.ts";
import { EventOfficialLinksPanel } from "../modules/event-official-links/ui.ts";
import { SenderSettings } from "../modules/organizer-mail-settings/ui.ts";
import type { IntakeReceipt, JudgeWorkItem } from "../modules/event-judging/model.ts";
import type { EventModuleFlags, EventModuleKey, EventStaffCapability, HostedEventScope } from "../shared/organizer-contracts.ts";
import { eventCalendar, eventJsonLd } from "../modules/events/public-structured-data.ts";
import type { ParticipantSummary } from "../modules/event-communication/index.ts";
import { OrganizerActionCenter, OrganizerPublishGate } from "./organizer-action-center.tsx";
import { OrganizerAssistantPanel, OrganizerAssistantSwitches } from "./organizer-assistant-panel.tsx";
import styles from "./competition-workspace.module.css";

export type CompetitionView = "overview" | "register" | "teams" | "help" | "schedule" | "services" | "submit" | "results";
export type OrganizerSection = "registration" | "teams" | "communication" | "schedule" | "services" | "judging";
type AccountChoice = { userId: string; label: string };
type TrackConfiguration = { configured: boolean; required: boolean; revision: number; options: { id: string; title: string }[] };
function trackOptions(titles: string[], existing: TrackConfiguration["options"], newId: (index: number) => string = () => `track-${operationKey()}`): TrackConfiguration["options"] {
  const byTitle = new Map(existing.map(option => [option.title, option]));
  const reserved = new Set(titles.map(title => byTitle.get(title)?.id).filter((id): id is string => Boolean(id)));
  return titles.map((title, index) => { const named = byTitle.get(title); if (named) return { id: named.id, title }; const oldRow = existing[index]; const id = oldRow && !reserved.has(oldRow.id) ? oldRow.id : newId(index); reserved.add(id); return { id, title }; });
}
const participantNames: Record<CompetitionView, string> = { overview: "比赛概览", register: "报名", teams: "我的队伍", help: "通知与求助", schedule: "行程", services: "现场服务", submit: "提交作品", results: "比赛结果" };
const staffNames: Record<OrganizerSection, string> = { registration: "报名审核", teams: "队伍管理", communication: "通知与答疑", schedule: "行程管理", services: "现场服务", judging: "收件与评审" };
const capabilities: Record<OrganizerSection, EventStaffCapability> = { registration: "registration_manage", teams: "teams_manage", communication: "communication_manage", schedule: "schedule_manage", services: "logistics_manage", judging: "judging_manage" };
const competitionPath = (id: string) => `/competitions/${encodeURIComponent(id)}`;
const staffPath = (id: string) => `/organizers/workspace/${encodeURIComponent(id)}`;
function enabled(modules: EventModuleFlags, view: CompetitionView): boolean {
  if (view === "register") return modules.registration;
  if (view === "teams") return modules.teams;
  if (view === "submit" || view === "results") return modules.judging;
  if (view === "schedule") return modules.schedule;
  if (view === "services") return modules.accommodation || modules.mealVouchers || modules.icebreaking;
  return true;
}
function staffEnabled(modules: EventModuleFlags, section: OrganizerSection): boolean {
  return section === "communication" || section === "registration" && modules.registration || section === "teams" && modules.teams || section === "judging" && modules.judging || section === "schedule" && modules.schedule || section === "services" && (modules.accommodation || modules.mealVouchers || modules.icebreaking);
}
function SignIn({ target, children = "登录后继续这场比赛" }: { target: string; children?: ReactNode }) {
  return <section className={styles.notice}><p>{children}</p><div className={styles.actions}><Link className={styles.primary} href={`/login?returnTo=${encodeURIComponent(target)}`}>登录并继续</Link><Link className={styles.secondary} href={`/register?returnTo=${encodeURIComponent(target)}`}>注册账号</Link></div></section>;
}
function QueryFailure({ error, reload, children }: { error: Error | null; reload: () => Promise<void>; children?: ReactNode }) {
  return <section className={styles.notice}><Feedback error={error}/>{children}<button type="button" className={styles.secondary} onClick={() => void reload()}>重新读取</button></section>;
}
function IdentityFrame({ event, identity, active, staff = false, staffCapabilities }: { event: Pick<PublicCompetition, "eventId" | "title" | "organizationName" | "timezone" | "submissionClosesAt" | "modules">; identity: string; active: string; staff?: boolean; staffCapabilities?: readonly EventStaffCapability[] }) {
  const base = competitionPath(event.eventId);
  return <div className={staff ? styles.stickyChrome : styles.chrome}><header className={styles.context}><div><p className={styles.eyebrow}>{event.organizationName}</p><h1>{event.title}</h1><p className={styles.identity}>当前身份：{identity}</p></div><div className={styles.contextLinks}><Link href="/competitions">切换比赛</Link><Link href="/me/competitions">我的比赛</Link>{staff && <><Link href={staffPath(event.eventId)}>本场概览</Link><Link href={`${staffPath(event.eventId)}/settings`}>比赛设置</Link></>}</div></header>
    {event.modules.judging && <p className={styles.deadline}>作品截止：{formatTime(event.submissionClosesAt, event.timezone)} · 赛事时区：{event.timezone}</p>}
    <nav className={styles.tabs} aria-label={staff ? "本场运营工作" : active === "judging" ? "本场评审" : "本场参赛流程"}>{staff ? (Object.keys(staffNames) as OrganizerSection[]).filter(section => staffEnabled(event.modules, section) && staffCapabilities?.includes(capabilities[section])).map(section => <Link key={section} href={`${staffPath(event.eventId)}/${section}`} aria-current={active === section ? "page" : undefined}>{staffNames[section]}</Link>) : active === "judging" ? <><Link href={`/judging/${encodeURIComponent(event.eventId)}`} aria-current="page">我的评审任务</Link><Link href={base}>公开比赛说明</Link></> : (Object.keys(participantNames) as CompetitionView[]).filter(view => enabled(event.modules, view)).map(view => <Link key={view} href={view === "overview" ? base : `${base}/${view}`} aria-current={active === view ? "page" : undefined}>{participantNames[view]}</Link>)}</nav></div>;
}
function formatTime(value: string | null, timezone: string): string {
  if (!value) return "尚未设置，请向主办方确认";
  try { return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return dateText(value); }
}
function AccountBoundary({ children, target }: { children: (me: Me) => ReactNode; target: string }) {
  const me = useApi<Me>("/me");
  if (me.loading && !me.data) return <Loading/>;
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn target={target}/>;
  if (me.error) return <QueryFailure error={me.error} reload={me.reload}/>;
  return me.data ? <div key={me.data.profile.id}>{children(me.data)}</div> : <Loading/>;
}

export function OrganizersPage() {
  const me = useApi<Me>("/me");
  return <SiteShell><div className={styles.container}><PageTitle eyebrow="办好一场黑客松" title="主办方入驻">从常用模板开始，逐步配置报名、队伍和人工评审。</PageTitle>{me.loading && !me.data ? <Loading/> : me.error && !(me.error instanceof ApiError && me.error.status === 401) ? <QueryFailure error={me.error} reload={me.reload}/> : <OrganizerEntry key={me.data?.profile.id ?? "visitor"} signedIn={Boolean(me.data)} workspaceHref="/organizers/workspace"/>}</div></SiteShell>;
}
export function CompetitionsPage() {
  const me = useApi<Me>("/me");
  return <SiteShell><div className={styles.container}><PageTitle eyebrow="正式比赛 · 主办方发布" title="选择你要参加的比赛">进入对应比赛，再报名、组队和提交作品。</PageTitle><div className={styles.actions}><Link className={styles.secondary} href="/events">查看更多 DSH 搜索到的赛事</Link><Link className={styles.secondary} href="/journey">第一次参赛，先看路线图</Link></div>{me.loading && !me.data ? <Loading/> : <><Feedback error={me.error && !(me.error instanceof ApiError && me.error.status === 401) ? me.error : null}/><CompetitionDirectory key={me.data?.profile.id ?? "visitor"} signedIn={Boolean(me.data)} identitySlot={me.data ? <MyCompetitions/> : undefined}/></>}</div></SiteShell>;
}
export function MyCompetitionsPage() {
  return <SiteShell><div className={styles.container}><PageTitle eyebrow="我的比赛" title="继续当前比赛">每场比赛的报名、队伍和评审身份分开保存。</PageTitle><AccountBoundary target="/me/competitions">{me => <div key={me.profile.id} className={styles.sections}><MyCompetitions/><MyJudgingCompetitions/><Link className={styles.secondary} href="/organizers/workspace">我是工作人员，进入赛事工作台</Link></div>}</AccountBoundary></div></SiteShell>;
}
function MyJudgingCompetitions() {
  const events = useApi<{ items: { eventId: string; title: string; organizationName: string; status: string }[] }>("/me/judging-competitions");
  return <section className={styles.card}><h2>我负责评审的比赛</h2>{events.error ? <QueryFailure error={events.error} reload={events.reload}/> : !events.data ? <Loading/> : events.data.items.length ? <div className={styles.cards}>{events.data.items.map(event => <article className={styles.card} key={event.eventId}><p className={styles.eyebrow}>{event.organizationName}</p><h3>{event.title}</h3><p>只查看本场指派给你的正式作品，先申报关系再评分。</p><Link className={styles.primary} href={`/judging/${encodeURIComponent(event.eventId)}`}>进入本场评审</Link></article>)}</div> : <p>你目前没有正式比赛评审指派。主办方指派后会在这里显示。</p>}</section>;
}
export function OrganizerWorkspacePage() {
  return <SiteShell><div className={styles.sectionPage}><PageTitle eyebrow="主办方" title="赛事工作台">先看你的比赛现在处于什么状态；要改规则或创建新比赛时，再展开下方的比赛设置。</PageTitle><WorkbenchEventCards/><details className={styles.details}><summary>创建比赛与机构设置</summary><p className={styles.muted}>这里只负责创建新比赛与机构级设置（发信邮箱、工作人员与授权）；既有比赛的规则、期限与功能开关在它自己的「比赛设置」页修改。</p><Suspense fallback={<Loading/>}><OrganizerWorkspaceFromQuery/></Suspense></details></div></SiteShell>;
}
function OrganizerWorkspaceFromQuery() {
  const query = useSearchParams(), router = useRouter();
  const initialEventId = query.get("event") ?? undefined, initialOrganizationId = query.get("organization") ?? undefined;
  // 工作台设计 §10 步骤 2：历史链接 ?event=… 仍然可用，重定向到该场比赛的设置页。
  useEffect(() => { if (initialEventId) router.replace(`${staffPath(initialEventId)}/settings`); }, [initialEventId, router]);
  if (initialEventId) return <Loading/>;
  return <AccountBoundary target={`/organizers/workspace${query.toString() ? `?${query.toString()}` : ""}`}>{me => <OrganizerSetup key={`${me.profile.id}:${initialEventId ?? ""}:${initialOrganizationId ?? ""}`} me={me} initialEventId={initialEventId} initialOrganizationId={initialOrganizationId}/>}</AccountBoundary>;
}
function OrganizerSetup({ me, initialEventId, initialOrganizationId }: { me: Me; initialEventId?: string; initialOrganizationId?: string }) {
  const identities = useApi<CompetitionIdentity[]>("/me/competition-identities");
  const [selectedEvent, setSelectedEvent] = useState<HostedEvent | null>(null), [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [trackEvents, setTrackEvents] = useState<HostedEvent[]>([]), [trackDirty, setTrackDirty] = useState<Record<string, boolean>>({});
  const lookupEvent = selectedEvent;
  const lookupAllowed = lookupEvent && identities.data?.find(item => item.event.eventId === lookupEvent.eventId)?.capabilities.includes("event_manage");
  useEffect(() => { setAccounts([]); }, [lookupEvent?.eventId]);
  const selectEvent = useCallback((event: HostedEvent | null) => { setSelectedEvent(event); if (event) setTrackEvents(values => values.some(item => item.eventId === event.eventId) ? values.map(item => item.eventId === event.eventId ? event : item) : [...values, event]); }, []);
  useDraftNavigation(Object.values(trackDirty).some(Boolean));
  const links = (event: HostedEvent): Partial<Record<EventModuleKey, string>> => ({ registration: `${staffPath(event.eventId)}/registration`, teams: `${staffPath(event.eventId)}/teams`, schedule: `${staffPath(event.eventId)}/schedule`, judging: `${staffPath(event.eventId)}/judging`, accommodation: `${staffPath(event.eventId)}/services`, mealVouchers: `${staffPath(event.eventId)}/services`, icebreaking: `${staffPath(event.eventId)}/services` });
  return <>{identities.error ? <QueryFailure error={identities.error} reload={identities.reload}/> : <>
    {selectedEvent && <RegistrationSharePanel key={`${selectedEvent.eventId}:${selectedEvent.revision}`} event={selectedEvent} canManageRegistration={Boolean(identities.data?.find(item => item.event.eventId === selectedEvent.eventId)?.capabilities.includes("registration_manage"))}/>}

    {lookupEvent && lookupAllowed && <details className={styles.details}><summary>添加工作人员：通过邮箱找到账号</summary><p>当前查询范围：{lookupEvent.title} · {lookupEvent.organizationName}。对方需要先注册并验证邮箱。</p><AccountLookup key={lookupEvent.eventId} eventId={lookupEvent.eventId} onFound={choice => setAccounts(previous => previous.some(item => item.userId === choice.userId) ? previous : [...previous, choice])}/></details>}
    {trackEvents.filter(event => identities.data?.find(item => item.event.eventId === event.eventId)?.capabilities.includes("event_manage")).map(event => <div key={event.eventId} hidden={event.eventId !== selectedEvent?.eventId}><TrackConfigForm event={event} onDirty={dirty => setTrackDirty(values => values[event.eventId] === dirty ? values : { ...values, [event.eventId]: dirty })}/></div>)}
    {Object.entries(trackDirty).some(([id, dirty]) => dirty && id !== selectedEvent?.eventId) && <p className={styles.warning}>其他比赛仍有未保存的赛道设置。可在下方比赛选择器切回继续编辑；离开本页前请先保存。</p>}
    <OrganizerWorkspace currentUserId={me.profile.id} initialEventId={initialEventId} initialOrganizationId={initialOrganizationId} staffAccounts={accounts} moduleLinks={links} onEventSelected={selectEvent} eventSelectionHref={id => `${staffPath(id)}/settings`} onEventSaved={() => { void identities.reload(); }} renderOrganizationSettings={organization => <details className={styles.details}><summary>发信邮箱：使用主办方自己的账号</summary><p>当前主办方：{organization.name}。本机构的比赛共用这个发信账号，其他主办方无法读取。</p><SenderSettings organizationId={organization.id}/></details>}/>
    <section className={styles.card}><h2>直接进入本场工作</h2>{identities.loading && <Loading/>}{identities.data?.length === 0 ? <p>入驻通过并创建比赛后，这里会显示你可以管理的比赛。</p> : <div className={styles.cards}>{identities.data?.map(item => <article className={styles.card} key={item.event.eventId}><p className={styles.eyebrow}>{item.event.organizationName}</p><h3>{item.event.title}</h3><div className={styles.actions}>{(Object.keys(staffNames) as OrganizerSection[]).filter(section => item.capabilities.includes(capabilities[section]) && staffEnabled(item.event.modules, section)).map(section => <Link className={styles.secondary} key={section} href={`${staffPath(item.event.eventId)}/${section}`}>{staffNames[section]}</Link>)}</div></article>)}</div>}</section>
  </>}</>;
}
type RegistrationWindow = "draft" | "ended" | "archived" | "disabled" | "unknown" | "upcoming" | "closed" | "open";
function registrationWindow(event: Pick<HostedEventScope, "status" | "modules" | "registrationOpensAt" | "registrationClosesAt">, now: number): RegistrationWindow {
  if (event.status !== "published") return event.status;
  if (!event.modules.registration) return "disabled";
  const opens = event.registrationOpensAt ? Date.parse(event.registrationOpensAt) : NaN;
  const closes = event.registrationClosesAt ? Date.parse(event.registrationClosesAt) : NaN;
  if (!Number.isFinite(opens) || !Number.isFinite(closes) || opens >= closes) return "unknown";
  if (now >= closes) return "closed";
  return now < opens ? "upcoming" : "open";
}
function registrationSharingState(view: RegistrationFormView, now: number): RegistrationWindow | "missing_form" | "full" {
  const windowState = registrationWindow(view.event, now);
  if (!view.event.publishedRevision) return "draft";
  if (["draft", "ended", "archived", "disabled"].includes(windowState)) return windowState;
  if (!view.form) return "missing_form";
  if (windowState !== "open") return windowState;
  return view.event.registration.capacity !== null && view.reservedCount >= view.event.registration.capacity ? "full" : "open";
}
const registrationStateNames: Record<ReturnType<typeof registrationSharingState>, string> = { draft: "赛事尚未正式发布", ended: "比赛已结束", archived: "比赛已归档", disabled: "正式版本未开启网站报名", unknown: "报名时间待确认", upcoming: "报名尚未开始", closed: "报名已截止", open: "报名开放中", missing_form: "报名表尚未发布", full: "当前报名名额已占满" };
function useCurrentTime() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}
function RegistrationSharePanel({ event, canManageRegistration }: { event: HostedEvent; canManageRegistration: boolean }) {
  const published = event.publishedRevision !== null;
  const form = useApi<RegistrationFormView>(published ? `${competitionPath(event.eventId)}/registration-form` : null);
  const [origin, setOrigin] = useState(""), [copying, setCopying] = useState(false), [copyNotice, setCopyNotice] = useState("");
  const input = useRef<HTMLInputElement>(null), now = useCurrentTime();
  useEffect(() => { if (window.location.protocol === "http:" || window.location.protocol === "https:") setOrigin(window.location.origin); }, []);
  const management = canManageRegistration && <Link className={styles.primary} href={`${staffPath(event.eventId)}/registration`}>查看报名与审核</Link>;
  if (!published) return <section className={styles.sharePanel}><h2>报名链接</h2><p>{event.title} · {event.organizationName}</p><p className={styles.shareStatus}>赛事尚未正式发布</p><p>先配置并发布报名表，再预览并正式发布赛事。两项都完成后，才能对外开放报名。</p><div className={styles.actions}>{management}</div></section>;
  if (form.error) return <section className={styles.sharePanel}><h2>报名链接</h2><p>{event.title} · {event.organizationName}</p><QueryFailure error={form.error} reload={form.reload}><p>未能核对已发布的报名信息，暂不提供报名邀请。先重新读取或查看本场报名配置。</p></QueryFailure><div className={styles.actions}>{management}</div></section>;
  const value = form.data;
  if (!value) return <section className={styles.sharePanel}><h2>报名链接</h2><p>正在核对本场正式发布版本…</p><Loading/></section>;
  if (value.event.eventId !== event.eventId || value.event.organizationId !== event.organizationId) return <section className={styles.sharePanel}><h2>报名链接</h2><QueryFailure error={new Error("报名信息与当前比赛不一致，暂不能分享链接，请重新读取。")} reload={form.reload}/></section>;
  const scope = value.event, state = registrationSharingState(value, now), windowState = registrationWindow(scope, now);
  const shareable = scope.status === "published" && scope.publishedRevision !== null && scope.modules.registration;
  const url = shareable && origin ? `${origin}${competitionPath(scope.eventId)}/register` : "";
  const ready = state === "open", helpId = `registration-share-help-${scope.eventId}`;
  return <section className={styles.sharePanel} aria-label="本场报名链接">
    <div className={styles.shareHeader}><div><h2>报名链接</h2><p>{scope.title} · {scope.organizationName}</p><p className={styles.shareMeta}>以下按正式赛事第 {scope.publishedRevision} 版与当前已发布报名表显示；未发布的赛事修改不会改变此链接的报名规则。</p></div><span className={`${styles.shareStatus} ${ready ? styles.shareReady : ""}`}>{registrationStateNames[state]}</span></div>
    {scope.modules.registration && <p className={styles.deadline}>报名开放：{formatTime(scope.registrationOpensAt, scope.timezone)}<br/>报名截止：{formatTime(scope.registrationClosesAt, scope.timezone)} · 赛事时区：{scope.timezone}</p>}
    {state === "missing_form" && <p className={styles.warning}>先发布报名表，再对外开放报名。{canManageRegistration ? "进入“查看报名与审核”，配置并发布报名表。" : "请让本场有报名管理权限的工作人员发布报名表。"}</p>}
    {scope.status === "ended" || scope.status === "archived" ? <p>本场不再接受新报名，已有报名记录仍可查看。</p> : !scope.modules.registration ? <p>正式版本未开启网站报名，请通过比赛公开说明告知选手实际参与方式。</p> : windowState === "upcoming" ? <p>现在可分享报名说明；到开放时间后才能正式提交报名。</p> : windowState === "closed" ? <p>报名已截止，此页用于查看报名说明和本人记录，请勿作为仍可报名的邀请。</p> : windowState === "unknown" ? <p>报名时间尚未能确认，先核对正式版本，暂不邀请选手提交。</p> : state === "full" ? <p>当前已占用名额达到上限，暂不接受新的报名。名额变化以报名页提交时的实际核对为准。</p> : ready ? <p>将链接发到微信、公众号、小红书等平台，选手通过链接回到本站报名；主办方在本站集中查看与处理。</p> : null}
    {shareable && <>
      <div className={styles.shareLink}><Field label={ready ? "可公开分享的报名链接" : "报名信息与记录页链接"}><input ref={input} type="text" readOnly value={url} placeholder="正在生成当前网站链接…" aria-describedby={helpId} onFocus={focus => focus.currentTarget.select()}/></Field><button type="button" className={styles.secondary} disabled={!url || copying || form.loading} onClick={async () => {
        if (!url || copying) return;
        setCopying(true); setCopyNotice("");
        try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(url); setCopyNotice(ready ? "报名链接已复制，可粘贴到微信、公众号、小红书等平台。" : "查看链接已复制；当前不接受新的报名，请同时说明上方状态。"); }
        catch { input.current?.focus(); input.current?.select(); setCopyNotice("浏览器未允许自动复制，请长按或右键复制上方只读链接。"); }
        finally { setCopying(false); }
      }}>{copying ? "正在复制…" : ready ? "复制报名链接" : "复制查看链接"}</button></div>
      <p id={helpId}>公开链接无需邀请或邀请码，打开即可查看报名信息；正式提交需要先注册或登录。浏览页面不会自动报名。</p>
      <p>{scope.registration.reviewRequired ? "本场需要主办方审核：选手正式提交后等待审核，审核结果在本站查看。" : "本场无需人工审核：符合报名条件的正式提交会直接通过，报名状态在本站查看。"}</p>
      <Feedback notice={copyNotice}/>
    </>}
    <div className={styles.actions}>{management}{scope.modules.registration && scope.publishedRevision !== null && <Link className={styles.secondary} href={`${competitionPath(scope.eventId)}/register`}>{ready ? "查看报名页" : "查看报名信息与记录"}</Link>}<button type="button" className={styles.secondary} disabled={form.loading} onClick={() => { setCopyNotice(""); void form.reload(); }}>{form.loading ? "正在核对…" : "刷新报名状态"}</button></div>
  </section>;
}
function useDraftNavigation(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { const element = event.target instanceof Element ? event.target.closest("a[href]") : null; if (!(element instanceof HTMLAnchorElement) || element.target === "_blank" || element.href === window.location.href || element.hash && element.pathname === window.location.pathname && element.search === window.location.search) return; if (!window.confirm("本页还有未保存的输入。确认放弃并离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [dirty]);
}
function TrackConfigForm({ event, onDirty }: { event: HostedEvent; onDirty: (dirty: boolean) => void }) {
  const configuration = useApi<TrackConfiguration>(`/organizer/events/${encodeURIComponent(event.eventId)}/tracks`);
  const [draft, setDraft] = useState<{ text: string; required: boolean; baseline: string; baseRevision: number; baseOptions: TrackConfiguration["options"] } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const stamp = (text: string, required: boolean) => JSON.stringify({ text, required });
  const fromConfiguration = (value: TrackConfiguration) => { const text = value.options.map(option => option.title).join("\n"); return { text, required: value.required, baseline: stamp(text, value.required), baseRevision: value.revision, baseOptions: value.options }; };
  useEffect(() => { if (configuration.data && !draft) setDraft(fromConfiguration(configuration.data)); }, [configuration.data, draft]);
  const dirty = Boolean(draft && stamp(draft.text, draft.required) !== draft.baseline);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const stale = Boolean(draft && configuration.data && draft.baseRevision !== configuration.data.revision), writable = event.status === "draft" || event.status === "published";
  const preview = draft ? trackOptions(draft.text.split(/\r?\n/).map(title => title.trim()).filter(Boolean), draft.baseOptions, index => `new-${index}`) : [];
  const renamed = preview.flatMap(option => { const old = draft?.baseOptions.find(value => value.id === option.id); return old && old.title !== option.title ? [{ before: old.title, after: option.title }] : []; });
  return <details className={styles.details}><summary>主办方官方赛道{dirty ? " · 有未保存设置" : ""}</summary><p>当前比赛：{event.title} · {event.organizationName}。只填写主办方正式规定的赛道，一个名称一行。</p>{configuration.error && <QueryFailure error={configuration.error} reload={configuration.reload}/>} {!configuration.data || !draft ? !configuration.error && <Loading/> : <form className={styles.form} onSubmit={async submit => { submit.preventDefault(); if (busy || !writable || configuration.error || stale) return; setBusy(true); setError(""); setNotice(""); try { const titles = draft.text.split(/\r?\n/).map(title => title.trim()).filter(Boolean); if (new Set(titles).size !== titles.length) throw new Error("赛道名称重复，请每个正式赛道只写一行。"); if (draft.required && !titles.length) throw new Error("需要选手必选赛道时，请先填写至少一个正式赛道。"); const options = trackOptions(titles, draft.baseOptions); const next = await api<TrackConfiguration>(`/organizer/events/${encodeURIComponent(event.eventId)}/tracks`, { method: "PUT", body: { expectedRevision: draft.baseRevision, required: draft.required, options } }); configuration.setData(next); setDraft(fromConfiguration(next)); setNotice("本场官方赛道已保存，选手组队时会读取这些选项。"); } catch (reason) { setError(message(reason)); await configuration.reload(); } finally { setBusy(false); } }}><Field label="官方赛道名称" hint="填写主办方公布的正式名称，每行一个、不重复。例如：AI 应用赛道、游戏创作赛道；未设赛道时留空，不要把团队职务写在这里。"><textarea rows={5} value={draft.text} maxLength={8000} disabled={busy || !writable} onChange={change => setDraft({ ...draft, text: change.target.value })} placeholder="一行一个主办方公布的赛道名称"/></Field><label className={styles.check}><input type="checkbox" checked={draft.required} disabled={busy || !writable} onChange={change => setDraft({ ...draft, required: change.target.checked })}/>组队时必须选择一个正式赛道</label><p>新增赛道请追加一行；在原行改名会保留原队伍选择。已被选择的赛道不能直接删除。启用必选前，请先让现有未选择赛道的队伍补齐。</p>{renamed.length > 0 && <aside className={styles.notice}><strong>保存后会更名，已有队伍选择保留：</strong><ul>{renamed.map(item => <li key={item.before}>{item.before} → {item.after}</li>)}</ul></aside>}{stale && <section className={styles.warning}><p>服务器已有第 {configuration.data.revision} 版，你的输入仍保留。请先核对当前官方赛道：{configuration.data.options.map(option => option.title).join("、") || "未配置"}。</p><button type="button" className={styles.secondary} disabled={busy} onClick={() => setDraft({ ...draft, baseRevision: configuration.data!.revision, baseOptions: configuration.data!.options, baseline: stamp(configuration.data!.options.map(option => option.title).join("\n"), configuration.data!.required) })}>我已核对，保留输入继续编辑</button></section>}<div className={styles.actions}><button type="submit" className={styles.secondary} disabled={busy || !writable || Boolean(configuration.error) || stale || !dirty}>{busy ? "正在保存…" : "保存本场官方赛道"}</button><button type="button" className={styles.secondary} disabled={busy || !dirty} onClick={() => { if (window.confirm("确认放弃当前未保存的赛道设置，恢复服务器已保存版本吗？")) { setDraft(fromConfiguration(configuration.data!)); setError(""); setNotice(""); } }}>恢复已保存版本</button></div>{!writable && <p>比赛已结束或归档，当前只查看已保存赛道。</p>}<Feedback error={error} notice={notice}/></form>}</details>;
}

export function CompetitionWorkspace({ eventId, view = "overview" }: { eventId: string; view?: CompetitionView }) {
  const me = useApi<Me>("/me");
  return <SiteShell><div className={styles.container}>{me.loading && !me.data ? <Loading/> : me.error && !(me.error instanceof ApiError && me.error.status === 401) ? <QueryFailure error={me.error} reload={me.reload}/> : <CompetitionInner key={`${eventId}:${me.data?.profile.id ?? "visitor"}`} eventId={eventId} view={view} me={me.data}/>}</div></SiteShell>;
}
/**
 * 公开赛事页的结构化数据与日历导出：只使用主办方已发布确认的字段
 * （见 modules/events/public-structured-data.ts）。日历在浏览器端生成并下载，不新增接口、不写入任何事实。
 */
function PublicEventStructuredData({ event }: { event: PublicCompetition }) {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const jsonLd = eventJsonLd(event, origin), calendar = eventCalendar(event, origin);
  function download() {
    if (!calendar) return;
    const url = URL.createObjectURL(new Blob([calendar.body], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = calendar.filename;
    document.body.append(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  }
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}/>
    {calendar && <p className={styles.prose}>把关键时间放进自己的日历：<button className={styles.secondary} type="button" onClick={download}>下载日历文件（.ics）</button> 只包含已公布的比赛时间与截止时间，未公布的时间不会生成。</p>}
  </>;
}
function CompetitionInner({ eventId, view, me }: { eventId: string; view: CompetitionView; me: Me | null }) {
  const event = useApi<PublicCompetition>(`/competitions/${encodeURIComponent(eventId)}`);
  if (!event.data || event.data.eventId !== eventId || event.error) return event.loading ? <Loading/> : <QueryFailure error={event.error} reload={event.reload}><p>比赛可能尚未发布或链接不正确。</p><Link href="/competitions">回到正式赛事目录</Link></QueryFailure>;
  const value = event.data, context = { eventId, eventTitle: value.title, organizationName: value.organizationName, modules: value.modules }, base = competitionPath(eventId), target = view === "overview" ? base : `${base}/${view}`;
  return <><IdentityFrame event={value} identity={me ? "已登录，参赛者视图" : "公开访客"} active={view}/><PublicEventStructuredData event={value}/>{value.availability !== "available" && <p className={styles.warning}>主办方当前暂停运营。正式规则与历史记录保留，请留意官方通知。</p>}
    {!enabled(value.modules, view) ? <section className={styles.notice}><h2>本场未开启{participantNames[view]}</h2><p>查看比赛规则与官方通知，确认这场比赛的安排。</p><Link className={styles.primary} href={base}>回到比赛概览</Link><Link className={styles.secondary} href={`${base}/help`}>查看官方通知与问答</Link></section> : view === "overview" ? <><OwnProgress event={value} me={me}/>{me && <MyScheduleAndLogistics eventId={eventId}/>}{me && <EventParticipantDirectory eventId={eventId}/>}{me && <MyWorkShowcase eventId={eventId}/>}<CompetitionOverview eventId={eventId} signedIn={Boolean(me)} loginHref={`/login?returnTo=${encodeURIComponent(base)}`}/>{me && <CommunityPanel eventId={eventId} eventTitle={value.title}/>}<OfficialNews {...context}/></> : view === "register" ? <RegistrationPanel key={me?.profile.id ?? "visitor"} eventId={eventId} signedIn={Boolean(me)} renderOwnDetails={registration=><MySelectionNotices key={registration.revision} eventId={registration.eventId}/>}/> : view === "help" ? me ? <ParticipantHelp event={value}/> : <><OfficialNews {...context} showFaq/><SignIn target={target}>登录后查看自己的报名；报名通过后可向本场主办方发送求助。</SignIn></> : view === "schedule" ? <EventSchedulePanel {...context}/> : view === "results" ? <><EventResultsPanel key={me?.profile.id ?? "visitor"} {...context} scope={me ? "mine" : "public"}/>{me && <OwnContactWillingness eventId={eventId} me={me}/>}</> : !me ? <SignIn target={target}/> : view === "teams" ? <RosterTeamsPanel eventId={eventId} currentUserId={me.profile.id}/> : view === "services" ? <OwnEventServices {...context}/> : <OwnSubmission event={value} me={me}/>}</>;
}
function ParticipantHelp({ event }: { event: PublicCompetition }) {
  const registration = useApi<MyRegistrationView>(event.modules.registration ? `${competitionPath(event.eventId)}/my-registration` : null);
  if (registration.error) return <QueryFailure error={registration.error} reload={registration.reload}/>;
  if (event.modules.registration && !registration.data) return <Loading/>;
  const context = { eventId: event.eventId, eventTitle: event.title, organizationName: event.organizationName, modules: event.modules };
  return registration.data?.registration?.status === "approved" ? <EventCommunicationPanel {...context}/> : <><OfficialNews eventId={event.eventId} showFaq/><section className={styles.notice}><h2>先查看公开答复</h2><p>私人求助向本场报名通过的选手开放。当前可以查看正式规则、官方通知和公开问答。</p>{event.modules.registration && <Link className={styles.secondary} href={`${competitionPath(event.eventId)}/register`}>查看我的报名</Link>}</section></>;
}
function OwnProgress({ event, me }: { event: PublicCompetition; me: Me | null }) {
  const base = competitionPath(event.eventId), now = useCurrentTime(), available = event.availability === "available";
  const registration = useApi<MyRegistrationView>(me && available && event.modules.registration ? `${base}/my-registration` : null);
  const publicForm = useApi<RegistrationFormView>(!me && available && event.modules.registration ? `${base}/registration-form` : null);
  const teams = useApi<TeamsView>(me && available && registration.data?.event.status === "published" && registration.data.event.modules.teams && registration.data.registration?.status === "approved" && !registration.error ? `${base}/teams?limit=1` : null);
  let next = "先读比赛规则，确认期限和参赛要求。", href = `${base}/help`, action = "查看官方通知", status = "尚未报名";
  if (!available) { next = "主办方当前暂停运营，暂不开放新报名。先查看保留的正式规则和官方通知。"; status = "主办方暂停运营"; }
  else if (!event.modules.registration) { next = event.status === "published" ? "本场没有开启网站报名，请按公开规则联系主办方。" : "比赛已结束或归档，可查看官方通知与公布结果。"; status = event.status === "published" ? "按主办方说明参与" : "历史赛事"; }
  else {
    const query = me ? registration : publicForm;
    if (query.error) return <QueryFailure error={query.error} reload={query.reload}><p>当前报名信息未能读取；先重新核对，再继续操作。</p></QueryFailure>;
    const view = query.data;
    if (!view) return <Loading/>;
    if (view.event.eventId !== event.eventId || view.event.organizationId !== event.organizationId) return <QueryFailure error={new Error("报名信息与当前比赛不一致，请重新读取后继续。")} reload={query.reload}/>;
    const scope = view.event, current = me ? registration.data?.registration?.status : undefined, phase = registrationSharingState(view, now);
    if (scope.status !== "published") { status = "历史赛事"; next = "比赛已结束或归档，不再接受新报名。已有报名记录仍可查看。"; href = current ? `${base}/register` : scope.modules.judging ? `${base}/results` : `${base}/help`; action = current ? "查看报名记录" : scope.modules.judging ? "查看比赛结果" : "查看官方通知"; }
    else if (!scope.modules.registration) { status = "网站报名已关闭"; next = "本场当前不接受网站新报名，请查看官方安排。已有报名记录仍可查看。"; href = current ? `${base}/register` : `${base}/help`; action = current ? "查看报名记录" : "查看官方通知"; }
    else if (current === "pending") { next = "报名已收到，等待本场工作人员审核。你可以先阅读规则和准备资料。"; href = `${base}/register`; action = "查看报名审核"; status = "等待审核"; }
    else if (current !== "approved" && phase !== "open") {
      status = registrationStateNames[phase]; href = `${base}/register`; action = current ? "查看报名记录" : "查看报名说明";
      next = phase === "upcoming" ? `报名尚未开始，${formatTime(scope.registrationOpensAt, scope.timezone)}开放后才能正式提交。现在先阅读规则并准备资料。` : phase === "closed" ? "报名已截止，不能提交新的报名。可以查看报名说明和自己已保存的记录。" : phase === "missing_form" ? "主办方还没有发布报名表，先阅读规则并等待官方通知。" : phase === "full" ? "当前报名名额已占满，先查看报名说明或联系主办方；已有记录仍可查看。" : "报名时间尚未能确认，先查看报名说明与官方通知。";
      if (current === "withdrawn") status += " · 已撤回报名";
      else if (current === "rejected") status += " · 报名未通过";
      else if (current === "draft") status += " · 仅保存草稿";
    }
    else if (!me) { next = "确认这场比赛适合你后，登录并填写本场报名表；正式提交才算报名。"; href = `/login?returnTo=${encodeURIComponent(`${base}/register`)}`; action = "登录后报名"; }
    else if (current !== "approved") { next = current === "rejected" ? "查看主办方审核说明，修改资料后重新正式提交报名。" : current === "withdrawn" ? "你已撤回报名；想继续参加可重新核对并报名。" : "填写本场报名表；保存草稿后还需要正式提交。"; href = `${base}/register`; action = "继续报名"; status = current === "rejected" ? "报名未通过" : current === "withdrawn" ? "已撤回报名" : current === "draft" ? "报名草稿" : "尚未报名"; }
    else if (!scope.modules.teams) { status = "报名已通过"; next = "本场不需要在网站组队，核对官方行程和下一项参赛安排。"; href = scope.modules.schedule ? `${base}/schedule` : `${base}/help`; action = scope.modules.schedule ? "查看比赛行程" : "查看官方通知"; }
    else if (teams.error) return <QueryFailure error={teams.error} reload={teams.reload}><p>报名已通过，但当前队伍状态未能读取。</p></QueryFailure>;
    else if (teams.loading || !teams.data) return <Loading/>;
    else if (!teams.data.ownTeam) { status = "报名已通过"; next = "自愿加入或创建本场队伍；主办方建议也需要本人确认。"; href = `${base}/teams`; action = "选择本场队伍"; }
    else { const team = teams.data.ownTeam; status = `我的队伍：${team.name}`; next = !team.eligible ? "队伍的当前资格需要核对，请查看名单与报名状态。" : team.status !== "locked" ? "和队友核对名单后，由队长确认锁定；私人团队空间可用于备赛。" : scope.modules.judging ? "名单已锁定。准备正式材料，由当前队长预览并提交作品。" : "名单已锁定，按官方行程准备比赛。"; href = team.status === "locked" && team.eligible && scope.modules.judging ? `${base}/submit` : `${base}/teams`; action = href.endsWith("/submit") ? "提交作品或查看回执" : "查看我的队伍"; }
  }
  return <section className={styles.nextStep} aria-label="当前下一步"><p className={styles.eyebrow}>{status}</p><h2>现在该做什么</h2><p>{next}</p><div className={styles.actions}><Link className={styles.primary} href={href}>{action}</Link>{me && teams.data?.ownTeam?.projectId && !teams.error && <Link className={styles.secondary} href={`/app/projects/${encodeURIComponent(teams.data.ownTeam.projectId)}`}>进入已关联团队空间</Link>}</div></section>;
}
/**
 * 规划 33 P08：选手侧"我的行程与后勤"只读汇总。
 *
 * 为什么只做这几块：同页的 `OwnProgress` 已经承担"现在该做什么"（报名状态、队伍、下一步），
 * 所以这里**只补它没有的**——重要期限、未读官方通知、我的行程、我的住宿与餐券、我的求助。
 * 这是刻意的去重（宪法 X：同义信息只一套），不是漏做。
 *
 * 全部数据来自既有记录的只读投影（`GET competitions/:id/my-summary`）：
 * 每一项都能点回原页面；`unread`（还没读到）与 `absent`（确实没有）严格分开，**不补占位、不编造**。
 * 本组件**零写入**。
 */
function MyScheduleAndLogistics({ eventId }: { eventId: string }) {
  const summary = useApi<ParticipantSummary>(`${competitionPath(eventId)}/my-summary`);
  if (summary.loading && !summary.data) return <Loading/>;
  if (summary.error) return <QueryFailure error={summary.error} reload={summary.reload}><p>你的行程与后勤信息暂时未能读取，可以稍后重试。</p></QueryFailure>;
  const value = summary.data; if (!value) return null;
  const unreadText = (state: "recorded" | "absent" | "unread") => state === "unread" ? "尚未读取" : state === "absent" ? "暂无记录" : null;
  const hasAnything = value.deadlines.length > 0 || value.announcements.total > 0 || value.schedule.state !== "absent" || value.logistics.accommodationState !== "absent" || value.logistics.vouchers.length > 0 || value.tickets.total > 0;
  return <section className={styles.card} aria-label="我的期限、行程与后勤">
    <h2>我的期限、行程与后勤</h2>
    <p className={styles.muted}>这里只汇总你本人在这场赛事里已有的记录，每一项都能回到原页面。没有记录的不补占位；还没读到会明确写出来。</p>

    <h3>重要期限</h3>
    {value.deadlines.length === 0 ? <p>主办方尚未提供可公开的期限，请以正式规则为准。</p> : <dl className={styles.deadlines}>{value.deadlines.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{formatTime(row.at, value.timezone)}</dd></div>)}</dl>}

    <h3>官方通知</h3>
    {value.announcements.total === 0 ? <p>主办方尚未发布通知，先查看正式规则。</p> : <>
      <p className={styles.muted}>共 {value.announcements.total} 条{value.announcements.unread > 0 ? `，其中 ${value.announcements.unread} 条你还没读` : "，都已读过"}。</p>
      <ul>{value.announcements.items.slice(0, 5).map(item => <li key={item.id}>{item.read ? "" : "未读 · "}{item.important ? "重要 · " : ""}<Link href={item.href}>{item.title}</Link>{item.dueAt ? `（处理期限 ${dateText(item.dueAt)}）` : ""}</li>)}</ul>
      <Link href={value.announcements.href}>查看全部通知与问答</Link>
    </>}

    <h3>我的行程</h3>
    {value.schedule.state === "unread" ? <p>行程尚未读取，<Link href={value.schedule.href}>去行程页查看</Link>。</p> : value.schedule.items.length === 0 ? <p>主办方尚未发布适用于你的行程。</p> : <ul>{value.schedule.items.map(item => <li key={item.id}>{formatTime(item.startsAt, value.timezone)}–{formatTime(item.endsAt, value.timezone)} · {item.title}{item.location ? ` · ${item.location}` : ""}</li>)}</ul>}
    {value.schedule.items.length > 0 && <Link href={value.schedule.href}>查看完整行程</Link>}

    {(value.logistics.accommodationState !== "absent" || value.logistics.vouchers.length > 0) && <>
      <h3>我的住宿与餐券</h3>
      <p className={styles.muted}>这两项只有你本人和本场专责工作人员能看到，不会出现在公开页面或队长视图里。</p>
      {value.logistics.accommodationState === "unread" ? <p>住宿安排尚未读取。</p>
        : value.logistics.accommodation ? <ul><li>地点：{value.logistics.accommodation.location || "未提供"}</li><li>房间：{value.logistics.accommodation.room || "未提供"}</li><li>入住：{value.logistics.accommodation.checkIn ? dateText(value.logistics.accommodation.checkIn) : "未提供"}</li><li>退房：{value.logistics.accommodation.checkOut ? dateText(value.logistics.accommodation.checkOut) : "未提供"}</li>{value.logistics.accommodation.note && <li>备注：{value.logistics.accommodation.note}</li>}</ul>
        : <p>{unreadText(value.logistics.accommodationState) ?? "暂无住宿安排"}</p>}
      {value.logistics.vouchers.length > 0 && <ul>{value.logistics.vouchers.map(voucher => <li key={voucher.name}>{voucher.name}：剩余 {voucher.remainingUses} / {voucher.totalUses} 次{voucher.state !== "available" ? `（${voucher.state === "exhausted" ? "已用完" : voucher.state === "expired" ? "已过期" : "已撤销"}）` : ""}{voucher.expiresAt ? `，有效期至 ${dateText(voucher.expiresAt)}` : ""}</li>)}</ul>}
    </>}

    <h3>我的求助</h3>
    {value.tickets.total === 0 ? <p>你还没有向本场主办方提问。报名通过后可以发私人求助。</p> : <>
      <p className={styles.muted}>共 {value.tickets.total} 条{value.tickets.open > 0 ? `，${value.tickets.open} 条还在处理中` : "，都已处理"}{value.registration.state === "unread" ? "（你的报名状态尚未读取，可能需要登录后查看）" : ""}。</p>
      <ul>{value.tickets.items.slice(0, 5).map(item => <li key={item.id}>{item.visibility === "private" ? "私人" : "公开"} · {item.question.length > 40 ? `${item.question.slice(0, 40)}…` : item.question} · <Link href={item.href}>查看处理进度</Link></li>)}</ul>
    </>}

    {!hasAnything && <p role="status">本场还没有与你相关的期限、通知、行程或后勤记录；有更新时会出现在这里。</p>}
    <p className={styles.muted}>规则版本：{value.ruleVersion ? `v${value.ruleVersion}` : "尚未发布"}。汇总只读，不改变任何报名、队伍、后勤或求助状态。</p>
  </section>;
}
function OfficialNews({ eventId, showFaq = false }: { eventId: string; showFaq?: boolean }) {
  const announcements = useApi<AnnouncementView[]>(`${competitionPath(eventId)}/announcements`), faqs = useApi<PublicFaq[]>(showFaq ? `${competitionPath(eventId)}/faq` : null);
  return <section className={styles.card}><h2>最新官方通知</h2>{announcements.error ? <QueryFailure error={announcements.error} reload={announcements.reload}/> : announcements.loading ? <Loading/> : announcements.data?.length ? announcements.data.slice(0, 3).map(item => <article className={styles.notice} key={item.id}><h3>{item.title}{item.important ? " · 重要" : ""}</h3>{item.dueAt && <p className={styles.deadline}>处理期限：{dateText(item.dueAt)}</p>}<p className={styles.prose}>{item.body}</p><p>需要你注意：{item.impact}</p></article>) : <p>主办方尚未发布通知，先查看正式规则。</p>}<Link href={`${competitionPath(eventId)}/help`}>查看全部通知与问答</Link>{showFaq && <><h2>常见问题</h2>{faqs.error ? <QueryFailure error={faqs.error} reload={faqs.reload}/> : faqs.loading ? <Loading/> : faqs.data?.length ? faqs.data.map(item => <details className={styles.details} key={item.id}><summary>{item.title}</summary><p className={styles.prose}>{item.question}</p><p className={styles.prose}>{item.answer}</p></details>) : <p>暂无已发布的常见问题答复。</p>}</>}</section>;
}
function OwnSubmission({ event, me }: { event: PublicCompetition; me: Me }) {
  const state = useApi<TeamsView>(`${competitionPath(event.eventId)}/teams?limit=1`);
  if (state.error) return <QueryFailure error={state.error} reload={state.reload}/>;
  if (!state.data || state.data.event.eventId !== event.eventId) return <Loading/>;
  const team = state.data.ownTeam;
  if (!team) return <section className={styles.notice}><h2>先加入本场队伍</h2><p>作品按本场正式队伍收件；私人团队空间不代替赛事名单。</p><Link className={styles.primary} href={`${competitionPath(event.eventId)}/teams`}>查看本场队伍</Link></section>;
  const captain = team.captainUserId === me.profile.id, ready = team.eligible && team.status === "locked" && event.status === "published" && event.availability === "available" && Boolean(event.submissionClosesAt && Date.now() < Date.parse(event.submissionClosesAt));
  return <><p className={styles.notice}>提交队伍：<strong>{team.name}</strong> · {captain ? "你是当前队长，名单与报名资格核对通过后可正式提交。" : "你是当前成员，可查看已收件记录；正式提交由队长确认。"}</p>{captain && ready ? <EventSubmissionPanel key={`${me.profile.id}:${team.id}`} eventId={event.eventId} eventTitle={event.title} organizationName={event.organizationName} teamId={team.id} deadline={event.submissionClosesAt}/> : <>{captain && !ready && <section className={styles.notice}><h2>先核对名单与比赛状态</h2><p>提交需要队伍名单已锁定、成员当前资格有效，且尚未到作品截止时间。已有正式回执可在下方查看。</p><Link className={styles.secondary} href={`${competitionPath(event.eventId)}/teams`}>查看本场名单</Link></section>}<OwnReceiptList eventId={event.eventId} teamId={team.id}/></>}</>;
}
function OwnReceiptList({ eventId, teamId }: { eventId: string; teamId: string }) {
  const receipts = useApi<{ items: IntakeReceipt[] }>(`${competitionPath(eventId)}/my-submissions?teamId=${encodeURIComponent(teamId)}`);
  if (receipts.error) return <QueryFailure error={receipts.error} reload={receipts.reload}/>;
  if (!receipts.data) return <Loading/>;
  return <section className={styles.card}><h2>本队正式收件回执</h2>{receipts.data.items.length ? receipts.data.items.map(receipt => <article className={styles.notice} key={receipt.id}><h3>{receipt.materials.title} · 第 {receipt.version} 版</h3><p>主办方已收件：{dateText(receipt.submittedAt)}</p><p>回执号：{receipt.receiptNumber}</p><details className={styles.details}><summary>查看正式提交说明</summary><p className={styles.prose}>{receipt.materials.description}</p><p>正式规则版本：{receipt.ruleVersion}</p><p>收件表示收到本版材料，代码运行与获奖由各自事实确认。</p></details></article>) : <p>本队还没有正式收件记录。完成材料后请由当前队长预览并提交。</p>}</section>;
}

/** 规划33 P09：本人结果页的「是否愿意被联系」——默认不公开，只对本场主办方可见。 */
/**
 * 规划34 D1：本场参赛名录（只读派生）。
 * 只显示本人已发布的参赛名片与本场公开队伍；赛事未开启、或调用者不是本场参赛者时**不渲染任何内容**（不显示空占位）。
 */
function EventParticipantDirectory({ eventId }: { eventId: string }) {
  type DirectoryEntry = { userId: string; displayName: string; headline: string; introduction: string; skills: string[]; city: string };
  type DirectoryView = { enabled: boolean; entries: DirectoryEntry[]; teams: { id: string; name: string; track: string }[]; notice: string; limitations: string[] };
  const directory = useApi<DirectoryView>(`${competitionPath(eventId)}/participants`);
  if (directory.loading && !directory.data) return <Loading/>;
  if (directory.error instanceof ApiError && (directory.error.status === 403 || directory.error.status === 404)) return null;
  if (directory.error) return <QueryFailure error={directory.error} reload={directory.reload}/>;
  const value = directory.data;
  if (!value?.enabled) return null;
  return <section className={styles.card} aria-label="本场参赛名录">
    <h2>本场参赛名录</h2>
    <p className={styles.muted}>{value.notice}</p>
    {value.entries.length === 0 ? <p className={styles.muted}>目前还没有人发布参赛名片；发布后会出现在这里。</p>
      : <ul>{value.entries.map(entry => <li key={entry.userId}><strong>{entry.displayName || "参赛者"}</strong>{entry.headline ? ` · ${entry.headline}` : ""}{entry.city ? ` · ${entry.city}` : ""}{entry.skills.length ? ` · ${entry.skills.join("、")}` : ""}{entry.introduction ? <p className={styles.muted}>{entry.introduction}</p> : null}</li>)}</ul>}
    {value.teams.length > 0 && <><h3>本场公开队伍</h3><ul>{value.teams.map(team => <li key={team.id}>{team.name}{team.track ? ` · ${team.track}` : ""}</li>)}</ul></>}
    {value.limitations.length > 0 && <p className={styles.muted}>{value.limitations.join(" ")}</p>}
  </section>;
}
function OwnContactWillingness({ eventId, me }: { eventId: string; me: Me }) {
  const teams = useApi<TeamsView>(`${competitionPath(eventId)}/teams?limit=1`);
  const team = teams.data?.ownTeam ?? null;
  if (teams.error) return <QueryFailure error={teams.error} reload={teams.reload}/>;
  if (!me || !team) return null;
  return <ContactWillingnessCard eventId={eventId} teamId={team.id}/>;
}
export function OrganizerSectionPage({ eventId, section }: { eventId: string; section: OrganizerSection }) {
  return <SiteShell><div className={styles.sectionPage}><AccountBoundary target={`${staffPath(eventId)}/${section}`}>{me => <StaffSection key={`${me.profile.id}:${eventId}`} eventId={eventId} section={section}/>}</AccountBoundary></div></SiteShell>;
}
function StaffSection({ eventId, section }: { eventId: string; section: OrganizerSection }) {
  const identities = useApi<CompetitionIdentity[]>("/me/competition-identities");
  if (identities.error) return <QueryFailure error={identities.error} reload={identities.reload}/>;
  if (!identities.data) return <Loading/>;
  const identity = identities.data.find(item => item.event.eventId === eventId);
  if (!identity || !identity.capabilities.includes(capabilities[section])) return <section className={styles.notice}><h1>没有本场{staffNames[section]}权限</h1><p>请让本场组织管理员确认你的职责；其他比赛的工作人员身份不在这里通用。</p><Link className={styles.primary} href="/organizers/workspace">返回赛事工作台</Link></section>;
  const event = identity.event, context = { eventId, eventTitle: event.title, organizationName: event.organizationName, modules: event.modules };
  return <><StaffIdentity event={event} identity={identity} section={section}/><OrganizerActionCenter eventId={eventId} eventTitle={event.title} organizationName={event.organizationName} status={event.status}
    publishedRevision={event.publishedRevision} modules={event.modules} capabilities={identity.capabilities} activeSection={section}/><OrganizerAssistantPanel eventId={eventId} assistantKey={section}/>{!staffEnabled(event.modules, section) ? <section className={styles.notice}><h2>本场尚未开启{staffNames[section]}</h2><p>请先在比赛设置中核对功能与正式发布版本。</p><Link className={styles.primary} href={`${staffPath(eventId)}/settings`}>查看比赛设置</Link></section> : section === "registration" ? <><details className={styles.details}><summary>入选通知：编辑文字与样式</summary><SelectionNoticeTemplateEditor eventId={eventId}/></details><RegistrationManager eventId={eventId} renderApprovedActions={registration=><SelectionNoticeAction eventId={registration.eventId} registration={registration}/>}/></> : section === "teams" ? <RosterTeamManager eventId={eventId}/> : section === "communication" ? <CommunicationManager {...context}/> : section === "schedule" ? <ScheduleManager {...context}/> : section === "services" ? <LogisticsOperations {...context}/> : <JudgingOperations {...context}/>}</>;
}
function LogisticsOperations({ eventId, eventTitle, organizationName, modules }: { eventId: string; eventTitle: string; organizationName: string; modules: EventModuleFlags }) {
  const participants = useApi<{ items: AccountChoice[] }>(`/organizer/events/${encodeURIComponent(eventId)}/logistics-participants`);
  if (participants.error) return <QueryFailure error={participants.error} reload={participants.reload}><p>当前本场名册未能核对，先重新读取再发放或调整安排。</p></QueryFailure>;
  if (!participants.data) return <Loading/>;
  return <LogisticsManager eventId={eventId} eventTitle={eventTitle} organizationName={organizationName} modules={modules} participants={participants.data.items}/>;
}
function StaffIdentity({ event, identity, section }: { event: HostedEvent; identity: CompetitionIdentity; section: OrganizerSection }) {
  return <IdentityFrame event={event} identity={identity.organizationAdmin ? "组织管理员" : `本场${staffNames[section]}工作人员`} active={section} staff staffCapabilities={identity.capabilities}/>;
}
function AccountLookup({ eventId, onFound }: { eventId: string; onFound: (account: AccountChoice) => void }) {
  const [email, setEmail] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [found, setFound] = useState<AccountChoice | null>(null);
  return <form className={styles.lookup} onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); setFound(null); try { const account = await api<AccountChoice>(`/organizer/events/${encodeURIComponent(eventId)}/account-lookup`, { method: "POST", body: { email } }); setFound(account); onFound(account); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }}><Field label="已注册并验证的邮箱" hint="填写工作人员或评委在本站登录使用的完整邮箱，如 member@example.com。查找仅加入账号选项，之后仍需选择职责并保存授权。"><input type="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)}/></Field><button type="submit" className={styles.secondary} disabled={busy}>{busy ? "正在查找…" : "查找账号"}</button><Feedback error={error}/>{found && <p role="status">已找到：{found.label}。已加入下方账号选项；选择后再明确授权或指派。</p>}</form>;
}
function JudgingOperations({ eventId, eventTitle, organizationName }: { eventId: string; eventTitle: string; organizationName: string }) {
  const [accounts, setAccounts] = useState<AccountChoice[]>([]), [version, setVersion] = useState(0), [notice, setNotice] = useState("");
  return <><details className={styles.details}><summary>添加评委：通过邮箱找到账号</summary><p>对方先注册本站并验证邮箱，查找不会自动授权或指派。</p><AccountLookup eventId={eventId} onFound={choice => setAccounts(values => values.some(item => item.userId === choice.userId) ? values : [...values, choice])}/></details><Feedback notice={notice}/><RelationshipReview key={`review:${version}`} eventId={eventId} accounts={accounts} onReviewed={() => { setNotice("人工关系核查已保存，请在下方重新核对评委指派与回避状态。"); setVersion(value => value + 1); }}/><JudgingManager eventId={eventId} eventTitle={eventTitle} organizationName={organizationName} refreshRevision={version} judgeOptions={accounts.map(account => ({ userId: account.userId, displayName: account.label }))}/></>;
}
function RelationshipReview({ eventId, accounts, onReviewed }: { eventId: string; accounts: AccountChoice[]; onReviewed: () => void }) {
  const [open, setOpen] = useState(false), [teamId, setTeamId] = useState(""), [judgeUserId, setJudgeUserId] = useState(""), [status, setStatus] = useState<"clear" | "conflict">("clear"), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const targets = useApi<{ items: { teamId: string; title: string; revision: number }[] }>(open ? `/organizer/events/${encodeURIComponent(eventId)}/judging/relationship-targets` : null);
  const selected = targets.data?.items.find(item => item.teamId === teamId);
  useDraftNavigation(Boolean(teamId || judgeUserId || note.trim()));
  return <details className={styles.details} onToggle={event => setOpen(event.currentTarget.open)}><summary>核查评委与队伍的关系</summary><p>系统外的辅导、合作等关系，需要非本人工作人员核实。查找评委账号后，选择队伍并写明依据；这一步不会产生评分。</p>{targets.error ? <QueryFailure error={targets.error} reload={targets.reload}/> : targets.loading ? <Loading/> : !targets.data?.items.length ? <p>尚无已收件队伍，先等待正式作品提交。</p> : !accounts.length ? <p>请先在上方按邮箱找到需要核查的评委。</p> : <form className={styles.form} onSubmit={async event => { event.preventDefault(); if (!selected || busy || targets.error) return; setBusy(true); setError(""); try { await api(`/organizer/events/${encodeURIComponent(eventId)}/judging/relationship-review`, { method: "POST", body: { teamId, judgeUserId, status, note, expectedTeamRevision: selected.revision } }); onReviewed(); } catch (reason) { setError(message(reason)); await targets.reload(); } finally { setBusy(false); } }}><Field label="本场队伍" hint="选择要核查利益关系的已收件队伍。其他比赛的队伍不会出现在这里。"><select required disabled={busy} value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">选择已收件队伍</option>{targets.data.items.map(item => <option key={item.teamId} value={item.teamId}>{item.title}</option>)}</select></Field><Field label="评委账号" hint="选择上方通过邮箱找到的评委，核查其与当前队伍的辅导或合作关系。"><select required disabled={busy} value={judgeUserId} onChange={event => setJudgeUserId(event.target.value)}><option value="">选择已查询的账号</option>{accounts.map(account => <option key={account.userId} value={account.userId}>{account.label}</option>)}</select></Field><Field label="人工核查结果" hint="核实关系后选择结论。参与过该队备赛或存在其他利益冲突，应选择回避；不能用未调查代替无冲突。"><select disabled={busy} value={status} onChange={event => setStatus(event.target.value as "clear" | "conflict")}><option value="clear">依据已核实，无已知利益冲突</option><option value="conflict">存在利益冲突，应回避</option></select></Field><Field label="核查依据与说明" hint="写清核查了什么、依据是什么，以及是否需回避。例如：已核对双方声明，评委曾辅导该队，本队评审应回避。1至2000字，不填评分。"><textarea required disabled={busy} maxLength={2000} rows={3} value={note} onChange={event => setNote(event.target.value)}/></Field><button type="submit" className={styles.secondary} disabled={busy || !selected}>{busy ? "正在记录…" : "确认关系核查"}</button><Feedback error={error}/></form>}</details>;
}
export function JudgingPage({ eventId }: { eventId: string }) {
  return <SiteShell><div className={styles.container}><AccountBoundary target={`/judging/${encodeURIComponent(eventId)}`}>{me => <JudgeEvent key={`${me.profile.id}:${eventId}`} eventId={eventId}/>}</AccountBoundary></div></SiteShell>;
}
function JudgeEvent({ eventId }: { eventId: string }) {
  const work = useApi<{ items: JudgeWorkItem[] }>(`/judging/${encodeURIComponent(eventId)}/assignments`), event = useApi<PublicCompetition>(`/competitions/${encodeURIComponent(eventId)}`);
  if (work.error) return <QueryFailure error={work.error} reload={work.reload}><p>评审材料按本场指派开放；请让主办方核对你的评委身份。</p><Link href="/competitions">返回正式赛事目录</Link></QueryFailure>;
  if (!work.data) return <Loading/>;
  if (event.error) return <QueryFailure error={event.error} reload={event.reload}><p>无法核对本场正式信息，先重新读取，再进入评审。</p></QueryFailure>;
  if (!event.data || event.data.eventId !== eventId) return <Loading/>;
  return <><IdentityFrame event={event.data} identity="评委工作视图" active="judging"/><p className={styles.notice}>评审仅使用正式收件材料。先申报关系，再对你被指派的作品人工评分。</p>{work.data.items.length ? <JudgeWorkspace eventId={eventId} eventTitle={event.data.title} organizationName={event.data.organizationName}/> : <section className={styles.notice}><h2>本场没有分配给你的作品</h2><p>请联系本场主办方确认评委指派；其他比赛的评委权限不在本场通用。</p><Link className={styles.secondary} href={competitionPath(eventId)}>查看本场比赛</Link></section>}</>;
}
export function AdminOrganizersPage() {
  return <SiteShell><div className={styles.container}><PageTitle eyebrow="平台人工审核" title="主办方入驻审核">核对机构身份和申请依据，并给出明确的补充或通过说明。</PageTitle><AccountBoundary target="/admin/organizers">{me => <AdminReviewGate key={me.profile.id}/>}</AccountBoundary></div></SiteShell>;
}
function AdminReviewGate() {
  const permissions = useApi<{ platformRoles: string[] }>("/me/permissions");
  if (permissions.error) return <QueryFailure error={permissions.error} reload={permissions.reload}/>;
  if (!permissions.data) return <Loading/>;
  return permissions.data.platformRoles.includes("admin") ? <><AdminOrganizationReview/><AdminClaimReview/><AdminRuleLinks/><OrganizerMailStatus/></> : <section className={styles.notice}><h2>需要平台管理员权限</h2><p>机构负责人和评委不能自行批准入驻申请。</p><Link href="/organizers">查看我的入驻申请</Link></section>;
}
function OrganizerMailStatus() {
  const status=useApi<{configured:boolean;websiteConfigured:boolean;organizationSenders:number;queued:number;accepted:number;held:number;failed:number;cancelled:number;sending:number}>("/admin/organizer/notification-status");
  return <details className={styles.details}><summary>主办方邮件发送状态</summary><p>站内通知独立保存。邮件服务接受请求不表示收件人已收到；结果未知的发送暂停重试。</p>{status.error?<QueryFailure error={status.error} reload={status.reload}/>:status.data?<><p>网站发信服务：{status.data.websiteConfigured?"已配置":"未配置"} · 使用自配邮箱的主办方：{status.data.organizationSenders} 家</p>{!status.data.configured&&<p>邮件未配置，通知仅在站内发布。</p>}<p>待发送 {status.data.queued} · 发送中 {status.data.sending} · 服务已接受 {status.data.accepted} · 结果未知 {status.data.held} · 失败 {status.data.failed} · 已取消 {status.data.cancelled}</p><button className={styles.secondary} type="button" onClick={()=>void status.reload()}>刷新发送状态</button></>:<Loading/>}</details>;
}
function AdminRuleLinks() {
  const events=useApi<PublicCompetition[]>("/competitions"),[eventId,setEventId]=useState("");
  return <details className={styles.details}><summary>关联已审核的正式规则</summary><p>用于核对本站赛事与已审核规则。选择对应比赛后人工确认；名称相同不会自动关联。</p>{events.error?<QueryFailure error={events.error} reload={events.reload}/>:!events.data?<Loading/>:<><Field label="选择本场主办方比赛" hint="选择需要关联正式规则的本站比赛，核对比赛名称和主办方；下方再选择已审核规则，不能仅凭同名自动关联。"><select value={eventId} onChange={change=>setEventId(change.target.value)}><option value="">请选择</option>{events.data.filter(event=>event.status==='published'&&event.availability==='available').map(event=><option key={event.eventId} value={event.eventId}>{event.title} · {event.organizationName}</option>)}</select></Field>{eventId&&<EventOfficialLinksPanel key={eventId} hostedEventId={eventId}/>}</>}</details>;
}

// ---------------------------------------------------------------------------
// 规划 33 · 工作台设计 §4：赛事工作台先给「我的比赛」状态卡（解决跨比赛不可见 F5）。
// 卡片只显示状态、规则版本、期限与待补项数；明确不显示报名人数或评审进度（避免跨比赛比较）。
// ---------------------------------------------------------------------------
const WORKBENCH_STATUS: Record<HostedEvent["status"], string> = { draft: "草稿（选手看不到）", published: "已发布（选手可见）", ended: "比赛已结束", archived: "已归档" };
function WorkbenchEventCards() {
  const identities = useApi<CompetitionIdentity[]>("/me/competition-identities");
  if (identities.loading && !identities.data) return <Loading/>;
  if (identities.error instanceof ApiError && identities.error.status === 401) return <SignIn target="/organizers/workspace">登录后查看你的比赛、状态与唯一下一步。</SignIn>;
  if (identities.error) return <QueryFailure error={identities.error} reload={identities.reload}/>;
  if (!identities.data) return <Loading/>;
  if (!identities.data.length) return <section className={styles.card} aria-label="我的比赛"><h2>我的比赛</h2><p className={styles.muted}>这个账号还没有可管理的比赛。机构管理员创建比赛后，这里会按机构列出。</p><Link className={styles.secondary} href="/organizers">查看入驻状态</Link></section>;
  const order: Record<HostedEvent["status"], number> = { draft: 0, published: 1, ended: 2, archived: 3 };
  const sorted = [...identities.data].sort((a, b) => {
    const byStatus = order[a.event.status] - order[b.event.status];
    if (byStatus) return byStatus;
    const at = a.event.registrationClosesAt ? Date.parse(a.event.registrationClosesAt) : Number.POSITIVE_INFINITY;
    const bt = b.event.registrationClosesAt ? Date.parse(b.event.registrationClosesAt) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.event.title.localeCompare(b.event.title, "zh-Hans-CN");
  });
  return <section aria-label="我的比赛"><h2>我的比赛</h2><p className={styles.muted}>按状态与报名截止排序。卡片只显示状态、正式规则版本、期限和待你们确认的项数，不做跨比赛数字比较。</p><div className={styles.eventCards}>{sorted.map(item => <WorkbenchEventCard key={item.event.eventId} identity={item}/>)}</div></section>;
}
function WorkbenchEventCard({ identity }: { identity: CompetitionIdentity }) {
  const { event, capabilities: grants } = identity;
  const readiness = useApi<EventReadinessItem[]>(grants.includes("event_manage") ? `/organizer/events/${encodeURIComponent(event.eventId)}/readiness` : null);
  const pendingItems = readiness.data ? readiness.data.filter(item => item.state === "missing" || item.state === "conflicting").length : null;
  const canEnter = (Object.keys(staffNames) as OrganizerSection[]).some(section => grants.includes(capabilities[section]) && staffEnabled(event.modules, section));
  return <article className={styles.card}>
    <p className={styles.eyebrow}>{event.organizationName}</p>
    <h3>{event.title}</h3>
    <div className={styles.actions}><span className={styles.badge}>{WORKBENCH_STATUS[event.status]}</span>{event.publishedRevision !== null && <span className={styles.badge}>正式规则 v{event.publishedRevision}</span>}{pendingItems !== null && pendingItems > 0 && <span className={`${styles.badge} ${styles.badgeWarning}`}>还有 {pendingItems} 项待你们确认</span>}</div>
    <dl className={styles.deadlines}>{event.registrationClosesAt && <div><dt>报名截止</dt><dd>{formatTime(event.registrationClosesAt, event.timezone)}</dd></div>}{event.submissionClosesAt && <div><dt>作品截止</dt><dd>{formatTime(event.submissionClosesAt, event.timezone)}</dd></div>}</dl>
    <div className={styles.actions}>{canEnter && <Link className={styles.secondary} href={staffPath(event.eventId)}>进入本场运营</Link>}{grants.includes("event_manage") && <Link className={styles.secondary} href={`${staffPath(event.eventId)}/settings`}>比赛设置</Link>}{event.status === "published" && <Link className={styles.secondary} href={competitionPath(event.eventId)}>看选手看到的样子</Link>}</div>
    {readiness.error && <p role="alert" className={styles.muted}>待你们确认的项数暂时没有读到，稍后可以重新打开本页。</p>}
  </article>;
}

// ---------------------------------------------------------------------------
// 工作台设计 §5.2：本场概览页 /organizers/workspace/[eventId]
// 只用既有只读事实；P07 看板未落地前，此页不渲染任何看板区块。
// ---------------------------------------------------------------------------
export function OrganizerEventOverviewPage({ eventId }: { eventId: string }) {
  return <SiteShell><div className={styles.sectionPage}><AccountBoundary target={staffPath(eventId)}>{me => <EventOverview key={`${me.profile.id}:${eventId}`} eventId={eventId}/>}</AccountBoundary></div></SiteShell>;
}
function EventOverview({ eventId }: { eventId: string }) {
  const identities = useApi<CompetitionIdentity[]>("/me/competition-identities");
  if (identities.error) return <QueryFailure error={identities.error} reload={identities.reload}/>;
  if (!identities.data) return <Loading/>;
  const identity = identities.data.find(item => item.event.eventId === eventId);
  if (!identity) return <section className={styles.notice}><h1>看不到本场比赛</h1><p>你当前没有这场比赛的工作人员身份；其他比赛的身份不在这里通用。</p><Link className={styles.primary} href="/organizers/workspace">返回赛事工作台</Link></section>;
  const event = identity.event;
  return <>
    <IdentityFrame event={event} identity={identity.organizationAdmin ? "组织管理员" : "本场工作人员"} active="overview" staff staffCapabilities={identity.capabilities}/>
    <OrganizerActionCenter eventId={eventId} eventTitle={event.title} organizationName={event.organizationName} status={event.status} publishedRevision={event.publishedRevision} modules={event.modules} capabilities={identity.capabilities} activeSection="overview"/>
    <OrganizerAssistantPanel eventId={eventId} assistantKey="overview"/>
    <EventOverviewMetrics event={event} canSeeRegistration={identity.capabilities.includes("registration_manage") && event.modules.registration}/>
    <EventDashboard eventId={eventId} grants={identity.capabilities}/>
    {identity.capabilities.includes("judging_manage") && <OrganizerWorkShowcase eventId={eventId}/>}
    <EventOverviewEntries event={event} grants={identity.capabilities}/>
    <RecentPublicationChanges eventId={eventId} visible={identity.capabilities.includes("event_manage")}/>
    <OrganizerCommunityReportsPanel eventId={eventId} eventTitle={event.title}/>
    <PostEventClosurePanel eventId={eventId} eventTitle={event.title} organizationName={event.organizationName}/>
  </>;
}
function EventOverviewMetrics({ event, canSeeRegistration }: { event: HostedEvent; canSeeRegistration: boolean }) {
  const counts = useApi<{ counts: Record<string, number>; pending: number; reserved: number }>(canSeeRegistration ? `/organizer/events/${encodeURIComponent(event.eventId)}/registration-counts` : null);
  const readAt = counts.data ? new Date().toISOString() : null;
  const submitted = counts.data ? Object.entries(counts.data.counts).filter(([status]) => status !== "draft").reduce((sum, [, value]) => sum + value, 0) : null;
  const shown = (value: number | null | undefined) => value === null || value === undefined ? "尚未读取" : String(value);
  return <section className={styles.card} aria-label="本场概览指标">
    <h2>本场概览</h2>
    <p className={styles.muted}>这里的数字只统计本场比赛并标注读取时间；没有读到就写「尚未读取」，不用 0 代替。这里不出完成度、百分比，也不做跨比赛比较。</p>
    {!canSeeRegistration ? <p className={styles.muted}>你的身份看不到报名计数。需要时请联系组织管理员。</p>
      : counts.error ? <QueryFailure error={counts.error} reload={counts.reload}/>
      : <div className={styles.metricRow}>
        <div className={styles.metric}><strong>{shown(counts.data?.pending)}</strong><span>待审核报名</span><small className={styles.muted}>{readAt ? `截至 ${dateText(readAt)}` : "尚未读取"}</small></div>
        <div className={styles.metric}><strong>{shown(counts.data?.counts?.approved)}</strong><span>已通过报名</span><small className={styles.muted}>{readAt ? `截至 ${dateText(readAt)}` : "尚未读取"}</small></div>
        <div className={styles.metric}><strong>{shown(submitted)}</strong><span>已提交报名合计</span><small className={styles.muted}>不含只有本人可见的草稿</small></div>
      </div>}
    <dl className={styles.deadlines}>
      {event.registrationClosesAt && <div><dt>报名截止</dt><dd>{formatTime(event.registrationClosesAt, event.timezone)}</dd></div>}
      {event.submissionClosesAt && <div><dt>作品截止</dt><dd>{formatTime(event.submissionClosesAt, event.timezone)}</dd></div>}
      <div><dt>赛事时区</dt><dd>{event.timezone}</dd></div>
    </dl>
  </section>;
}
// ---------------------------------------------------------------------------
// 规划33 P07 / 布局 §3.3 第⑤块：数据看板下钻（只用既有只读事实，筛选页签不是一级导航）。
// undefined 显示「未提供」，绝不用 0 代替；不出预测、成功率、影响力或跨比赛排名。
// ---------------------------------------------------------------------------
function EventDashboard({ eventId, grants }: { eventId: string; grants: readonly EventStaffCapability[] }) {
  const available = DASHBOARD_PANELS.filter(panel => DASHBOARD_PANEL_CAPABILITIES[panel].some(capability => grants.includes(capability)));
  const [selected, setSelected] = useState<DashboardPanelKey | null>(null);
  if (!available.length) return null;
  const active = selected && available.includes(selected) ? selected : available[0]!;
  return <EventDashboardPanel key={active} eventId={eventId} panel={active} available={available} onSelect={setSelected}/>;
}
function EventDashboardPanel({ eventId, panel, available, onSelect }: { eventId: string; panel: DashboardPanelKey; available: readonly DashboardPanelKey[]; onSelect: (panel: DashboardPanelKey) => void }) {
  const view = useApi<DashboardView>(`/organizer/events/${encodeURIComponent(eventId)}/dashboard?panel=${encodeURIComponent(panel)}`);
  const shown = (value: number | undefined) => value === undefined ? "未提供" : String(value);
  return <section className={styles.card} aria-label="数据看板">
    <h2>数据看板</h2>
    <p className={styles.muted}>这里只筛选和汇总本场已经存在的记录，每个数字都带统计口径与数据时间；没有读到写「未提供」，不用 0 代替；也不做预测、成功率、影响力或跨比赛排名。</p>
    <div className={styles.actions} role="tablist" aria-label="看板筛选">{available.map(key => <button key={key} type="button" role="tab" aria-selected={key === panel} className={styles.secondary} onClick={() => onSelect(key)}>{DASHBOARD_PANEL_LABELS[key]}</button>)}</div>
    {view.error ? <QueryFailure error={view.error} reload={view.reload}/> : !view.data ? <Loading/> : view.data.panels.map(item => <div className={styles.sections} key={item.panel}>
      <h3>{item.label}</h3>
      <p className={styles.muted}>统计范围：{item.scope} · 数据时间：{dateText(item.readAt)}</p>
      {item.notAvailableReasons.length > 0 && <p className={styles.warning}>{item.notAvailableReasons.join(" ")}</p>}
      {item.metrics.length > 0 && <div className={styles.metricRow}>{item.metrics.map(metric => <div className={styles.metric} key={metric.key}><strong>{shown(metric.value)}</strong><span>{metric.label}</span><small className={styles.muted}>{metric.definition}</small></div>)}</div>}
      {item.breakdowns.map(breakdown => <div key={breakdown.key}><h4>{breakdown.label}</h4><p className={styles.muted}>{breakdown.definition} · 统计范围：{breakdown.scope}</p>{breakdown.groups.length ? <ul>{breakdown.groups.map(group => <li key={group.label}>{group.label}：{shown(group.value)}</li>)}</ul> : <p className={styles.muted}>这一维度没有可显示的分组。</p>}</div>)}
      {item.sections.map(section => <div key={section.key}><h4>{section.label}</h4><p className={styles.muted}>{section.definition}</p>{section.rows.length ? <ul>{section.rows.map(row => <li key={row.id}>{row.cells.map(cell => `${cell.label}：${cell.value === null ? "未提供" : cell.value}`).join(" · ")}</li>)}</ul> : <p className={styles.muted}>没有记录。</p>}{section.nextCursor && <p className={styles.muted}>当前只显示这一页记录；更多请到对应区块查看。</p>}</div>)}
    </div>)}
  </section>;
}
function EventOverviewEntries({ event, grants }: { event: HostedEvent; grants: readonly EventStaffCapability[] }) {
  const entries = (Object.keys(staffNames) as OrganizerSection[]).filter(section => grants.includes(capabilities[section]) && staffEnabled(event.modules, section));
  return <section className={styles.card} aria-label="本场运营入口">
    <h2>本场运营</h2>
    <p className={styles.muted}>只列你的身份能处理、并且本场已经开启的区块；与上方页签指的是同一批页面。</p>
    {entries.length ? <div className={styles.actions}>{entries.map(section => <Link key={section} className={styles.secondary} href={`${staffPath(event.eventId)}/${section}`}>{staffNames[section]}</Link>)}</div>
      : <p className={styles.muted}>你的身份目前没有可处理的区块。需要时请联系组织管理员。</p>}
  </section>;
}
function RecentPublicationChanges({ eventId, visible }: { eventId: string; visible: boolean }) {
  const changes = useApi<PublicationChange[]>(visible ? `/organizer/events/${encodeURIComponent(eventId)}/publication-changes` : null);
  if (!visible) return null;
  return <section className={styles.card} aria-label="最近变化">
    <h2>最近变化</h2>
    <p className={styles.muted}>正式规则每次发布都会留下变化说明；这里只列已经发布的版本，不代表完成度。</p>
    {changes.error ? <QueryFailure error={changes.error} reload={changes.reload}/> : changes.loading && !changes.data ? <Loading/> : changes.data?.length ? <ul>{changes.data.slice(0, 5).map(item => <li key={item.id}>v{item.version} · {dateText(item.createdAt)}：{item.changeSummary}</li>)}</ul> : <p className={styles.muted}>尚无发布记录。首次发布后，变化说明会出现在这里。</p>}
  </section>;
}

// ---------------------------------------------------------------------------
// 工作台设计 §6.1 / §10 步骤 2：比赛设置页 /organizers/workspace/[eventId]/settings
// 发布门槛清单从每个 section 页移到这里；历史链接 ?event=… 也重定向到这里。
// ---------------------------------------------------------------------------
export function OrganizerEventSettingsPage({ eventId }: { eventId: string }) {
  return <SiteShell><div className={styles.sectionPage}><AccountBoundary target={`${staffPath(eventId)}/settings`}>{me => <EventSettings key={`${me.profile.id}:${eventId}`} me={me} eventId={eventId}/>}</AccountBoundary></div></SiteShell>;
}
function EventSettings({ me, eventId }: { me: Me; eventId: string }) {
  const identities = useApi<CompetitionIdentity[]>("/me/competition-identities");
  if (identities.error) return <QueryFailure error={identities.error} reload={identities.reload}/>;
  if (!identities.data) return <Loading/>;
  const identity = identities.data.find(item => item.event.eventId === eventId);
  if (!identity || !identity.capabilities.includes("event_manage")) return <section className={styles.notice}><h1>没有本场比赛的设置权限</h1><p>编辑规则与发布需要「比赛规则与发布」权限；其他身份不在这里通用。</p><Link className={styles.primary} href="/organizers/workspace">返回赛事工作台</Link></section>;
  const event = identity.event;
  return <>
    <IdentityFrame event={event} identity={identity.organizationAdmin ? "组织管理员" : "本场工作人员"} active="settings" staff staffCapabilities={identity.capabilities}/>
    <OrganizerPublishGate eventId={eventId} status={event.status}/>
    <p className={styles.actions}><Link className={styles.secondary} href={`/organizers/workspace/${encodeURIComponent(eventId)}/page`}>编辑专属页（主办方自助建站）</Link></p>
    {identity.organizationAdmin && <OrganizerStaffInvitations organizationId={event.organizationId}/>}
    <OrganizerAssistantSwitches eventId={eventId}/>
    <OrganizerSetup me={me} initialEventId={eventId}/>
  </>;
}