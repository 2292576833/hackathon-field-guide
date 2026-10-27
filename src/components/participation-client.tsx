"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  EventSupplement,
  GenerateParticipationInput,
  MissingProfileField,
  ParticipationContext,
  ParticipationFact,
  ParticipationPlan,
  WeatherSnapshot,
} from "../modules/participation/types.ts";
import type { PersonalArtifact } from "../shared/personal-ai.ts";
import type { DevelopmentExperience } from "../shared/participant.ts";
import { participationPlanMarkdown } from "../modules/participation/markdown.ts";
import { ApiError, api, chinaInstant, dateText, isUnknownAiOutcome, message, safeLink, useApi } from "./client-api.ts";
import { SiteShell } from "./site-shell.tsx";
import styles from "./participation.module.css";

type SavedPlan = PersonalArtifact<ParticipationPlan>;
const missingLabels: Record<MissingProfileField, string> = {
  firstHackathon: "是否第一次参加黑客松",
  developmentExperience: "开发经验",
  city: "所在城市",
  availableHoursPerDay: "每天可投入的时间",
};
const experienceLabels: Record<DevelopmentExperience, string> = {
  none: "还没有开发经验", beginner: "正在入门", project: "做过项目", experienced: "有较多开发经验",
};
const modeLabels = { online: "线上赛", offline: "线下赛", hybrid: "线上与线下结合" };
const checkLabels = { registration: "报名", fees: "费用", entry: "入场", rules: "规则", submission: "正式提交" };
const travelLabels = { undecided: "尚未决定", rail: "优先铁路", flight: "优先飞机", local: "优先本地参赛" };
const presentationLabels = { none: "尚无路演经验", some: "有一些路演经验", confident: "较熟悉路演" };
const eventStatusLabels: Record<string, string> = { unverified: "未核验", active: "可用线索", withdrawn: "已撤回", archived: "已归档", unknown: "待确认" };
const registrationStatusLabels: Record<string, string> = { open: "来源显示报名中", closed: "来源显示已截止", unknown: "尚未核实" };

function isLoginError(error: Error | null | undefined): boolean {
  return error instanceof ApiError && error.status === 401;
}
function originText(fact: ParticipationFact<unknown>): string {
  return fact.origin === "user_supplement" ? "本人补充，尚未核实" : fact.origin === "event_source" ? "赛事来源记录，待官方确认" : "信息不足，待核实";
}
function dayText(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return parts ? `${parts[1]}年${Number(parts[2])}月${Number(parts[3])}日` : value;
}
function minutesText(value: number): string {
  return value < 60 ? `${value} 分钟` : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 60)} 小时`;
}
function safeInternalHref(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/app/account";
}
function eventProfileHref(context: ParticipationContext): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(context.event.id)
    ? `/app/account?event=${encodeURIComponent(context.event.id)}#participant-profile`
    : safeInternalHref(context.profileHref);
}
function readPlan(value: PersonalArtifact): SavedPlan {
  const data = value.data as Partial<ParticipationPlan> | null;
  if (value.kind !== "participation_plan" || !data || data.schemaVersion !== 1 || data.status !== "draft"
    || !data.context?.event || !data.context.profile || !data.context.weather || !data.context.facts
    || !Array.isArray(data.phases) || !data.travel || !data.roadshow || !Array.isArray(data.risks)
    || !Array.isArray(data.verification) || !Array.isArray(data.notices) || !Array.isArray(data.assumptions)) {
    throw new Error("这条记录暂不能显示为参与计划。请刷新历史记录，或联系管理员核对数据版本。");
  }
  return value as SavedPlan;
}
function ErrorBox({ error, loginHref }: { error: Error | null; loginHref: string }) {
  if (!error) return null;
  return <div role="alert" className={styles.error}>
    <p>{isLoginError(error) ? "请登录后读取本人的赛事资料和参与计划。" : error.message}</p>
    {isLoginError(error) && <Link className={styles.link} href={loginHref}>登录后继续</Link>}
    {error instanceof ApiError && error.requestId && <p className={styles.hint}>请求编号：{error.requestId}</p>}
  </div>;
}

/** The app route passes the event query; every read is a saved-data GET. */
export function ParticipationClient({ eventId = "" }: { eventId?: string }) {
  const context = useApi<ParticipationContext>(eventId ? `/me/participation/context?eventId=${encodeURIComponent(eventId)}` : null);
  const history = useApi<PersonalArtifact[]>("/me/artifacts?kind=participation_plan");
  const [selected, setSelected] = useState<SavedPlan | null>(null);
  const [selectionError, setSelectionError] = useState<Error | null>(null);
  const [readingId, setReadingId] = useState("");
  const [notice, setNotice] = useState("");
  const [automaticRequested, setAutomaticRequested] = useState(false);
  const markerReadFor = useRef<string | null>(null);
  const selectionVersion = useRef(0);
  const sessionVersion = useRef(0);
  const returnTo = `/participation${eventId ? `?event=${encodeURIComponent(eventId)}` : ""}`;
  const loginHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  const loggedOut = isLoginError(context.error) || isLoginError(history.error) || isLoginError(selectionError);
  const currentContext = context.data?.event.id === eventId ? context.data : null;

  useEffect(() => {
    // Only the explicit event-card action writes this marker. Consume before any POST.
    if (markerReadFor.current === eventId) return;
    markerReadFor.current = eventId;
    setAutomaticRequested(false);
    if (!eventId) return;
    try {
      if (sessionStorage.getItem("participation:generate-event") !== eventId) return;
      sessionStorage.removeItem("participation:generate-event");
      setAutomaticRequested(true);
    } catch { /* A blocked sessionStorage still permits the explicit form button. */ }
  }, [eventId]);
  useEffect(() => { if (loggedOut) setAutomaticRequested(false); }, [loggedOut]);

  useEffect(() => {
    const clear = () => {
      selectionVersion.current++; sessionVersion.current++;
      setSelected(null); setReadingId(""); setNotice(""); setSelectionError(null); setAutomaticRequested(false);
    };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => { selectionVersion.current++; window.removeEventListener("hackathon:unauthenticated", clear); };
  }, []);

  async function viewPlan(id: string) {
    const version = ++selectionVersion.current;
    setReadingId(id); setSelectionError(null); setNotice("");
    try {
      const result = readPlan(await api<PersonalArtifact>(`/me/artifacts/${encodeURIComponent(id)}`));
      if (version === selectionVersion.current) setSelected(result);
    } catch (reason) {
      if (version === selectionVersion.current) setSelectionError(reason instanceof Error ? reason : new Error(message(reason)));
    } finally {
      if (version === selectionVersion.current) setReadingId("");
    }
  }

  return <SiteShell><div className={styles.root} data-participation-print={selected && !loggedOut ? "true" : undefined}>
    <div className={styles.intro}>
      <p className={styles.eyebrow}>我的参赛手册 · 仅本人可见</p>
      <h1>把参赛这件事，安排到每天。</h1>
      <p className={styles.lead}>结合你的经验、可用时间和比赛资料，生成从准备作品到路演提交的个人计划。先核对事实，再决定下一步。</p>
      {eventId && <p className={styles.muted}><Link className={styles.link} href={`/app?event=${encodeURIComponent(eventId)}`}>和队友一起准备？在团队空间继续 →</Link>。个人计划不会自动共享到团队。</p>}
    </div>
    {loggedOut ? <section className={`${styles.panel} ${styles.section}`}>
      <h2>登录后开始准备</h2><p className={styles.muted}>个人画像、生成结果和历史计划保存在你的账号下。</p>
      <Link className={styles.primary} href={loginHref}>登录后继续</Link>
    </section> : <>
      <div className={styles.layout}>
        <section className={styles.panel} aria-labelledby="participation-context-heading">
          <h2 id="participation-context-heading">这次，准备参加哪场比赛</h2>
          {!eventId && <div className={styles.empty}><p>先从赛事情报卡片选择一场比赛，再制定参与计划。</p><Link className={styles.link} href="/events">去找比赛</Link></div>}
          {context.loading && <p className={styles.loading} role="status">正在读取赛事、个人画像和可用天气资料…</p>}
          <ErrorBox error={context.error} loginHref={loginHref}/>
          {context.error && !isLoginError(context.error) && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={context.loading} onClick={() => void context.reload()}>重新读取资料</button><Link href="/events" className={styles.link}>重新选择比赛</Link></div>}
          {currentContext && <>
            <ContextFacts context={currentContext}/>
            <PlanGenerator key={`${eventId}:${currentContext.profile.userId}`} context={currentContext} loginHref={loginHref} sessionVersion={sessionVersion} automaticRequested={automaticRequested}
              onSaved={result => {
                selectionVersion.current++; setReadingId(""); setSelectionError(null); setSelected(result);
                setNotice("DSH 参与计划已生成并保存。请核对建议任务和待确认事项。");
                void history.reload();
              }} onRefreshContext={() => void context.reload()} onRefreshHistory={() => void history.reload()}/>
          </>}
        </section>
        <aside>
          {currentContext && <section className={styles.panel} aria-labelledby="participation-profile-heading">
            <h2 id="participation-profile-heading">按我的情况安排</h2>
            <ProfileSummary context={currentContext}/>
            <div className={styles.actions}><Link className={styles.link} href={eventProfileHref(currentContext)}>调整个人画像</Link></div>
            <WeatherSummary weather={currentContext.weather}/>
          </section>}
          <section className={`${styles.panel} ${currentContext ? styles.section : ""}`} aria-labelledby="participation-history-heading">
            <div className={styles.sectionHeading}><h2 id="participation-history-heading">已保存的计划</h2><button type="button" className={styles.secondary} disabled={history.loading} onClick={() => void history.reload()}>刷新</button></div>
            <p className={styles.muted}>读取历史记录不会再次生成计划。</p>
            {history.loading && <p className={styles.loading} role="status">正在读取本人历史计划…</p>}
            <ErrorBox error={history.error} loginHref={loginHref}/>
            {!history.loading && !history.error && history.data?.length === 0 && <div className={styles.empty}>还没有计划。选择比赛并补齐画像后，点击生成保存第一份。</div>}
            <ul className={styles.history}>{history.data?.filter(item => item.kind === "participation_plan").map(item => <li key={item.id}>
              <button type="button" className={styles.historyButton} aria-pressed={selected?.id === item.id} disabled={readingId === item.id} onClick={() => void viewPlan(item.id)}>
                <strong>{item.title}</strong><small>{dateText(item.createdAt)} · DSH</small>{readingId === item.id && <small>正在读取这份计划…</small>}
              </button>
            </li>)}</ul>
            <ErrorBox error={selectionError} loginHref={loginHref}/>
          </section>
        </aside>
      </div>
      {notice && <p className={`${styles.notice} ${styles.section}`} role="status">{notice} <a href="#participation-saved-plan" className={styles.link}>查看计划</a></p>}
      {selected && <PlanView key={selected.id} artifact={selected}/>
      }
    </>}
  </div></SiteShell>;
}

function ContextFacts({ context }: { context: ParticipationContext }) {
  const { event, facts } = context;
  return <>
    <h3 className={styles.eventTitle}>{event.title}</h3><p className={styles.eventSummary}>{event.summary}</p>
    <div className={styles.tags}><span className={`${styles.tag} ${styles.draftTag}`}>来源线索 · 待核实</span><span className={styles.tag}>状态：{eventStatusLabels[event.status] ?? event.status}</span>{event.registrationStatus && <span className={styles.tag}>报名：{registrationStatusLabels[event.registrationStatus] ?? event.registrationStatus}</span>}</div>
    <dl className={styles.factList}>
      <FactRow label="来源日期" value={event.eventDate || "来源尚未给出明确日期"} note="保留来源原文，不把模糊日期视为精确开赛时间。"/>
      <FactRow label="精确开赛" value={facts.eventStartAt.value ? dateText(facts.eventStartAt.value) : "尚未核实"} fact={facts.eventStartAt}/>
      <FactRow label="举办地点" value={event.location || "尚未核实"}/>
      <FactRow label="比赛城市" value={facts.city.value || "尚未核实"} fact={facts.city}/>
      <FactRow label="参赛形式" value={facts.mode.value ? modeLabels[facts.mode.value] : "尚未核实"} fact={facts.mode}/>
      <FactRow label="作品截止" value={facts.submissionDeadline.value ? dateText(facts.submissionDeadline.value) : "未知，请查官方提交要求"} fact={facts.submissionDeadline}/>
      <FactRow label="报名截止" value={event.registrationDeadline ? dateText(event.registrationDeadline) : "未知，请查官方报名要求"}/>
      {event.fetchedAt && <FactRow label="资料更新" value={dateText(event.fetchedAt)}/>}
    </dl>
    <SourceLinks sourceUrl={event.sourceUrl} registrationUrl={event.registrationUrl}/>
    {event.evidence?.length ? <details className={styles.supplement}><summary>查看来源摘录</summary><TextList items={event.evidence}/></details> : null}
    {context.notices.length > 0 && <div className={styles.warning}><ul>{context.notices.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}
  </>;
}
function FactRow({ label, value, fact, note }: { label: string; value: string; fact?: ParticipationFact<unknown>; note?: string }) {
  return <div className={styles.factRow}><dt>{label}</dt><dd>{value}{fact && <span className={styles.origin}>{originText(fact)}{fact.note ? ` · ${fact.note}` : ""}</span>}{note && <span className={styles.origin}>{note}</span>}</dd></div>;
}
function SourceLinks({ sourceUrl, registrationUrl }: { sourceUrl: string; registrationUrl: string | null }) {
  const source = safeLink(sourceUrl), registration = safeLink(registrationUrl);
  return <div className={styles.actions}>{source && <a href={source} target="_blank" rel="noopener noreferrer" className={styles.link}>查看赛事来源 ↗</a>}{registration ? <a href={registration} target="_blank" rel="noopener noreferrer" className={styles.link}>核对报名入口 ↗</a> : <span className={styles.muted}>报名链接尚未核实，请从原文确认。</span>}</div>;
}

function ProfileSummary({ context }: { context: ParticipationContext }) {
  const profile = context.profile;
  return <ul className={styles.profileList}>
    <li><span>参赛经历：</span>{profile.firstHackathon === null ? "待补充" : profile.firstHackathon ? "第一次参加黑客松" : "已有参赛经历"}</li>
    <li><span>开发经验：</span>{profile.developmentExperience ? experienceLabels[profile.developmentExperience] : "待补充"}</li>
    <li><span>所在城市：</span>{profile.city || "待补充"}</li>
    <li><span>每天可用：</span>{profile.availableHoursPerDay === null ? "待补充" : `${profile.availableHoursPerDay} 小时`}</li>
    <li><span>已有技能：</span>{profile.skills.length ? profile.skills.join("、") : "尚未填写"}</li>
    <li><span>出行偏好：</span>{travelLabels[profile.travelPreference]}</li>
    <li><span>路演经验：</span>{profile.presentationExperience ? presentationLabels[profile.presentationExperience] : "尚未填写"}</li>
  </ul>;
}
function WeatherSummary({ weather }: { weather: WeatherSnapshot }) {
  const source = safeLink(weather.sourceUrl);
  return <section className={styles.weather} aria-label="天气资料">
    <h3>天气与出行参考</h3><p className={styles.muted}>{weather.note}</p>
    {weather.status === "available" && <>
      {weather.location && <p className={styles.muted}>{[weather.location.country, weather.location.admin1, weather.location.name].filter(Boolean).join(" · ")}</p>}
      <div className={styles.weatherDays}>{weather.days.map(day => <div key={day.date} className={styles.weatherDay}>
        <strong>{dayText(day.date)}</strong><div><p>{day.temperatureMinC}–{day.temperatureMaxC} °C</p><p>{day.precipitationProbabilityMax === null ? "降水概率未提供" : `最高降水概率 ${day.precipitationProbabilityMax}%`}{day.windSpeedMaxKmh !== null ? ` · 最大风速 ${day.windSpeedMaxKmh} km/h` : ""}</p></div>
      </div>)}</div>
      <p className={styles.hint}>天气为预报，出行前应再次查看；日期按天气地点时区显示。</p>
    </>}
    {weather.fetchedAt && <p className={styles.hint}>资料获取：{dateText(weather.fetchedAt)}</p>}
    {source && <a className={styles.link} href={source} target="_blank" rel="noopener noreferrer">Open-Meteo 天气资料 ↗</a>}
  </section>;
}

function PlanGenerator({ context, loginHref, sessionVersion, automaticRequested, onSaved, onRefreshContext, onRefreshHistory }: {
  context: ParticipationContext; loginHref: string; sessionVersion: { current: number };
  automaticRequested: boolean;
  onSaved: (artifact: SavedPlan) => void; onRefreshContext: () => void; onRefreshHistory: () => void;
}) {
  const [projectIdea, setProjectIdea] = useState(context.profile.projectIdea);
  const [city, setCity] = useState("");
  const [startAt, setStartAt] = useState("");
  const [mode, setMode] = useState<EventSupplement["mode"] | "">("");
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [automaticNotice, setAutomaticNotice] = useState("");
  const automaticHandled = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const incomplete = context.missingProfileFields.length > 0;
  const needsTravelFacts = context.facts.mode.value !== "online" &&
    (!context.facts.city.value || !context.facts.eventStartAt.value || !context.facts.mode.value);

  useEffect(() => {
    if (!automaticRequested || automaticHandled.current) return;
    automaticHandled.current = true;
    if (incomplete) {
      setAutomaticNotice("已读取赛事卡片上的生成操作。请先补全画像，再点击下方按钮生成；不会在补全后自动收费。");
      return;
    }
    setAutomaticNotice("已接收你在赛事卡片上点击的生成操作；该操作仅发起一次模型请求。");
    const version = sessionVersion.current;
    queueMicrotask(() => {
      if (!mounted.current || version !== sessionVersion.current) return;
      void generate();
    });
  }, [automaticRequested, incomplete]);

  async function generate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (sending.current || unknown || incomplete) return;
    sending.current = true; setBusy(true); setError(null);
    const version = sessionVersion.current;
    let issued = false;
    try {
      const supplement: EventSupplement = {};
      if (city.trim()) supplement.city = city.trim();
      if (startAt) supplement.eventStartAt = chinaInstant(startAt);
      if (mode) supplement.mode = mode;
      const input: GenerateParticipationInput = { eventId: context.event.id, projectIdea: projectIdea.trim(), ...(Object.keys(supplement).length ? { supplement } : {}) };
      issued = true;
      const result = readPlan(await api<PersonalArtifact>("/me/participation/plans", { method: "POST", body: input }));
      if (mounted.current && version === sessionVersion.current) onSaved(result);
    } catch (reason) {
      if (mounted.current && version === sessionVersion.current) {
        const resultUnknown = issued && isUnknownAiOutcome(reason);
        setUnknown(resultUnknown);
        setError(reason instanceof Error ? reason : new Error(message(reason)));
      }
    } finally {
      sending.current = false;
      if (mounted.current && version === sessionVersion.current) setBusy(false);
    }
  }

  return <form className={styles.form} onSubmit={event => void generate(event)} aria-busy={busy}>
    {automaticNotice && <p className={styles.muted}>{automaticNotice}</p>}
    {incomplete && <div className={styles.warning}>
      <p><strong>还需要这些资料，才能安排适合你的计划：</strong></p>
      <ul>{context.missingProfileFields.map(field => <li key={field}>{missingLabels[field]}</li>)}</ul>
      <Link href={eventProfileHref(context)} className={styles.link}>去补全个人画像</Link>
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={onRefreshContext}>补全后重新读取</button></div>
    </div>}
    <label className={styles.field}>这次想做什么作品
      <textarea value={projectIdea} disabled={busy || unknown} maxLength={4000} onChange={event => setProjectIdea(event.target.value)} placeholder="例如：做一个帮助同学整理活动通知的小工具，先实现搜索与提醒。"/>
      <span className={styles.hint}>可留空使用个人画像中的想法；越具体，越容易安排最小交付成果。</span>
    </label>
    {needsTravelFacts && <p className={styles.warning}>赛事来源缺少完整的城市、参赛形式或准确时间。目前可以生成任务和通用出行核对建议；填写下面已知的比赛资料后，才能查询对应城市与日期的天气。超过预报范围的日期会提示临近出行再查。</p>}
    <details className={styles.supplement} open={needsTravelFacts}>
      <summary>补充我知道的比赛资料，完善出行与天气建议</summary>
      <p className={styles.hint}>这些内容会标为“本人补充，尚未核实”，不能替代比赛官方规则。</p>
      <div className={styles.supplementFields}>
        <label className={styles.field}>比赛城市<input disabled={busy || unknown} maxLength={120} value={city} onChange={event => setCity(event.target.value)} placeholder="例如：上海, 上海市"/><span className={styles.hint}>同名城市请补充省份或国家，以便查询正确地点的天气。</span></label>
        <label className={styles.field}>参赛形式<select value={mode} disabled={busy || unknown} onChange={event => setMode(event.target.value as typeof mode)}><option value="">使用现有来源资料</option><option value="online">线上</option><option value="offline">线下</option><option value="hybrid">线上与线下结合</option></select></label>
        <label className={styles.field}>准确开赛时间（北京时间 UTC+08:00）<input type="datetime-local" value={startAt} disabled={busy || unknown} onChange={event => setStartAt(event.target.value)}/><span className={styles.hint}>只填已经确认的准确时间；不确定时留空。服务器只在真实预报范围内查询天气。</span></label>
      </div>
    </details>
    <ErrorBox error={error} loginHref={loginHref}/>
    {error instanceof ApiError && ["PARTICIPANT_PROFILE_CHANGED", "PARTICIPANT_PROFILE_INCOMPLETE", "PARTICIPANT_PROFILE_INVALID"].includes(error.code) && <div className={styles.warning}><p>请核对最新个人画像，再决定是否重新生成。当前输入已保留。</p><div className={styles.actions}><Link href={eventProfileHref(context)} className={styles.link}>查看个人画像</Link><button type="button" className={styles.secondary} onClick={onRefreshContext}>重新读取最新资料</button></div></div>}
    {unknown && <div className={styles.warning} role="status"><p>本次生成结果暂未核实，请先刷新历史记录查看是否已保存。此页面不会自动重发请求。</p><button type="button" className={styles.secondary} onClick={onRefreshHistory}>读取已保存记录</button></div>}
    {busy && <div className={`${styles.loading} ${styles.progress}`} role="status"><span className={styles.progressMarker} aria-hidden="true"/><div><p><strong>已发起 DSH 生成，正在等待服务器结果…</strong></p><p>正在安排建议任务，并核对赛事事实、天气与每日可用时间。结果返回后即可查看。</p></div></div>}
    <button type="submit" className={styles.primary} disabled={busy || unknown || incomplete}>{busy ? "正在等待 DSH 计划…" : unknown ? "本次结果待核对" : "用 DSH 生成并保存参与计划"}</button>
    <p className={styles.hint}>点击按钮会发起一次模型请求。结果保存为个人草案，报名、出行和正式提交仍需你核实并执行。</p>
  </form>;
}

function TextList({ items, empty = "没有补充建议。" }: { items: string[]; empty?: string }) {
  return items.length ? <ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className={styles.muted}>{empty}</p>;
}
function PlanView({ artifact }: { artifact: SavedPlan }) {
  const { data: plan } = artifact;
  const [exportNotice, setExportNotice] = useState("");
  const [copyFallback, setCopyFallback] = useState(false);
  const [exporting, setExporting] = useState(false);
  const markdown = participationPlanMarkdown(plan);

  async function copy() {
    setExporting(true); setExportNotice("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(markdown); setCopyFallback(false); setExportNotice("计划 Markdown 已复制。");
    } catch { setCopyFallback(true); setExportNotice("浏览器未允许直接复制。可以选中下方文本复制，或下载 Markdown。"); }
    finally { setExporting(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `participation-plan-${artifact.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "saved"}.md`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setExportNotice("已发起 Markdown 下载。");
  }

  return <article className={styles.plan} id="participation-saved-plan" aria-label="已保存的个人参与计划">
    <header className={styles.planHeader}>
      <div><span className={`${styles.tag} ${styles.draftTag}`}>个人草案 · 待核对</span><h2>{plan.title}</h2><p>{plan.projectIdea || "作品方向尚未确定，请先缩小到一个可交付的主流程。"}</p><p className={styles.planMetadata}>{dateText(artifact.createdAt)} · provider:dsh · 仅本人可见</p></div>
      <div className={`${styles.actions} ${styles.nonPrint}`}>
        <button type="button" className={styles.secondary} onClick={() => window.print()}>打印计划</button>
        <button type="button" className={styles.secondary} disabled={exporting} onClick={() => void copy()}>复制 Markdown</button>
        <button type="button" className={styles.secondary} onClick={download}>下载 Markdown</button>
      </div>
    </header>
    {exportNotice && <p className={`${styles.notice} ${styles.nonPrint}`} role="status">{exportNotice}</p>}
    {copyFallback && <div className={`${styles.copyFallback} ${styles.nonPrint}`}><label className={styles.field}>计划 Markdown（可全选复制）<textarea readOnly value={markdown} onFocus={event => event.currentTarget.select()}/></label></div>}
    <dl className={styles.planSummary}>
      <div className={styles.stat}><dt>建议阶段</dt><dd>{plan.phases.length} 个</dd></div>
      <div className={styles.stat}><dt>任务估时合计</dt><dd>{minutesText(plan.estimatedTotalMinutes)}</dd></div>
      <div className={styles.stat}><dt>每天可投入</dt><dd>{plan.context.profile.availableHoursPerDay ?? "未知"} 小时</dd></div>
    </dl>
    <div className={styles.warning}><p>以下阶段和任务日期为建议安排，采用 {plan.context.planningTimeZone} 时区。工时为估算，负责人均为本人；请结合实际进度调整。</p>{!plan.context.facts.submissionDeadline.value && <p><strong>作品提交截止未知：</strong>请先核实官方截止，不能将建议完成日期视为正式提交期限。</p>}</div>
    {plan.notices.length > 0 && <TextList items={plan.notices}/>}
    <section className={styles.planSection} aria-labelledby="participation-schedule-heading">
      <h3 id="participation-schedule-heading">建议任务计划</h3>
      {plan.phases.map((phase, index) => <section className={styles.phase} key={`${phase.kind}:${index}`}>
        <div className={styles.phaseHeader}><h4>{String(index + 1).padStart(2, "0")} · {phase.title}</h4><p>建议 {dayText(phase.startDate)} — {dayText(phase.endDate)}</p></div>
        {phase.tasks.map(task => <article className={styles.task} key={task.id}>
          <p className={styles.taskDate}>{dayText(task.plannedDate)}<small>建议日期</small></p>
          <div className={styles.taskContent}><h5>{task.title} <span className={styles.tag}>{task.priority === "must" ? "必要任务" : "有余力再做"}</span></h5><p><strong>交付成果：</strong>{task.deliverable}</p><p><strong>任务完成后，按这些条件检查：</strong></p><TextList items={task.acceptance} empty="验收要求待补充。"/></div>
          <div className={styles.taskCapacity}><strong>{minutesText(task.durationMinutes)}</strong><span>估时 · {task.owner}</span></div>
        </article>)}
      </section>)}
    </section>
    <div className={styles.twoColumns}>
      <section className={styles.planSection}><h3>出行与现场准备</h3><p><strong>{plan.travel.required ? "需要考虑出行" : "无需强制出行"}</strong></p><p className={styles.muted}>{plan.travel.reason}</p><h4>建议安排</h4><TextList items={plan.travel.suggestions}/><h4>准备清单</h4><TextList items={plan.travel.checklist}/><h4>天气相关提醒</h4><TextList items={plan.travel.weatherAdvice} empty="没有已核实的天气预报可用于建议；出发前再查。"/></section>
      <section className={styles.planSection}><h3>报名、费用与提交核实</h3><p className={styles.muted}>这些事项尚未确认。请从来源核对要求，保留实际回执。</p><ul className={styles.checklist}>{plan.verification.map((check, index) => <li key={index}><strong>{checkLabels[check.kind]} · 待确认</strong><p>{check.action}</p>{safeLink(check.sourceUrl) && <a className={styles.link} href={safeLink(check.sourceUrl)!} target="_blank" rel="noopener noreferrer">核对来源 ↗</a>}</li>)}</ul></section>
    </div>
    <section className={styles.planSection}><h3>路演与 PPT 准备</h3><TextList items={plan.roadshow.suggestions}/><div className={styles.twoColumns}><div><h4>PPT 要准备什么</h4><TextList items={plan.roadshow.pptChecklist}/></div><div><h4>彩排怎么检查</h4><TextList items={plan.roadshow.rehearsalChecklist}/></div></div></section>
    <section className={styles.planSection}><h3>可能卡住的地方与备选方案</h3>{plan.risks.map((risk, index) => <article className={styles.risk} key={index}><h4>{risk.risk}</h4><dl><dt>提前处理</dt><dd>{risk.mitigation}</dd><dt>备选方案</dt><dd>{risk.fallback}</dd></dl></article>)}</section>
    <section className={styles.planSection}><h3>本次规划假设</h3><TextList items={plan.assumptions} empty="没有额外规划假设。"/></section>
    <details className={`${styles.snapshot} ${styles.nonPrint}`}><summary>查看本次保存的赛事、个人画像与天气依据</summary><p className={styles.muted}>以下是生成时保存的快照。来源后续更新不会自动修改这份计划。</p><ContextFacts context={plan.context}/><ProfileSummary context={plan.context}/><WeatherSummary weather={plan.context.weather}/></details>
    <section className={`${styles.planSection} ${styles.printOnly}`}><h3>生成时保存的事实与天气</h3><ContextFacts context={plan.context}/><WeatherSummary weather={plan.context.weather}/></section>
    <section className={styles.planSection}><h3>官方事项仍需确认</h3><p className={styles.muted}>计划不代表已报名、已预订行程或已正式提交。建议安排与官方规则有冲突时，先按官方要求调整。</p><SourceLinks sourceUrl={plan.context.event.sourceUrl} registrationUrl={plan.context.event.registrationUrl}/></section>
  </article>;
}
