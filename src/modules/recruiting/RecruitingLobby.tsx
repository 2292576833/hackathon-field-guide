"use client";

import { useEffect, useId, useRef, useState } from "react";
import { defaultRecruitingClient, RecruitingClientError, recruitingDate, recruitingErrorMessage, recruitingSafeLink } from "./client.ts";
import type { RecruitingClient } from "./client.ts";
import { purposeLabels, recruitingPurposes, recruitingRoles, roleLabels } from "./model.ts";
import type { OwnApplication, PublicRecruitingCard, RecruitingApplication, RecruitingListFilter, RecruitingPage, RecruitingPost, RecruitingPurpose, RecruitingRole } from "./model.ts";
import styles from "./recruiting.module.css";

export interface RecruitingLobbyProps {
  client?: RecruitingClient; signedIn?: boolean; loginHref?: string; profileHref?: string;
  onJoined?: (application: RecruitingApplication) => void;
}
interface ApplicationDraft { message: string; shareCard: boolean; requestId: string | null }
const applicationLabels: Record<RecruitingApplication["status"], string> = { pending: "等待管理员审核", approved: "已批准，等待本人加入", rejected: "申请未通过", withdrawn: "申请已撤回", joined: "已加入空间" };
function tags(values: string[]) { return values.length ? <div className={styles.tags}>{values.map((value, index) => <span className={styles.tag} key={`${value}-${index}`}>{value}</span>)}</div> : null; }
function publicCard(card: PublicRecruitingCard) {
  return <article className={styles.card} key={card.id}>
    <div className={styles.personHeading}>{card.avatarUrl && <img className={styles.avatar} src={card.avatarUrl} alt={`${card.displayName}的公开头像`} width={56} height={56} />}<div><p className={styles.muted}>{card.displayName}</p><h3>{card.headline}</h3></div></div>
    <p className={styles.preWrap}>{card.introduction}</p>
    {tags(card.primaryRoles.map(role => roleLabels[role]))}
    {card.supportingRoles.length > 0 && <p className={styles.muted}>也愿意协助：{card.supportingRoles.map(role => roleLabels[role]).join("、")}</p>}
    {tags(card.purposes.map(purpose => purposeLabels[purpose]))}
    {card.purposeNote && <p className={styles.preWrap}>{card.purposeNote}</p>}
    {card.skills.length > 0 && <p>愿意使用：{card.skills.join("、")}</p>}
    {(card.city || card.availableHoursPerDay !== null) && <p className={styles.muted}>{[card.city, card.availableHoursPerDay !== null ? `每天可投入 ${card.availableHoursPerDay} 小时` : ""].filter(Boolean).join(" · ")}</p>}
    {(card.mbti || card.age !== null) && <p className={styles.muted}>本人自愿公开：{[card.mbti ? `MBTI ${card.mbti}` : "", card.age !== null ? `${card.age} 岁` : ""].filter(Boolean).join(" · ")}</p>}
    <div className={styles.actions}>{card.workLinks.map((link, index) => { const href = recruitingSafeLink(link.url); return href ? <a className={styles.secondary} key={index} href={href} rel="noopener noreferrer" target="_blank">{link.title || "查看作品"} ↗</a> : null; })}</div>
    <p className={styles.muted}>发布于 {recruitingDate(card.publishedAt)}</p>
  </article>;
}

export function RecruitingLobby({ client = defaultRecruitingClient, signedIn = false, loginHref = "/login?returnTo=%2Frecruiting", profileHref = "/app/account", onJoined }: RecruitingLobbyProps) {
  const prefix = useId();
  const [tab, setTab] = useState<"posts" | "cards">("posts");
  const [role, setRole] = useState<RecruitingRole | "">("");
  const [purpose, setPurpose] = useState<RecruitingPurpose | "">("");
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<RecruitingListFilter>({ limit: 24 });
  const [cards, setCards] = useState<RecruitingPage<PublicRecruitingCard> | null>(null);
  const [posts, setPosts] = useState<RecruitingPage<RecruitingPost> | null>(null);
  const [applications, setApplications] = useState<OwnApplication[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ApplicationDraft>>({});
  const [joining, setJoining] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [applicationsError, setApplicationsError] = useState("");
  const [applicationsLoading, setApplicationsLoading] = useState(signedIn);
  const [notice, setNotice] = useState("");
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(signedIn);
  const generation = useRef(0);
  const identity = useRef(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => { identity.current++; setAuthenticated(signedIn); setBusy(""); if (!signedIn) { setApplications([]); setDrafts({}); setJoining({}); setApplicationsLoading(false); } }, [signedIn]);
  useEffect(() => {
    const clear = () => { identity.current++; setAuthenticated(false); setApplications([]); setDrafts({}); setJoining({}); setApplicationsLoading(false); setBusy(""); setApplicationsError("登录已失效，请重新登录后查看申请。"); };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setLoading(true); setError("");
    void Promise.allSettled([client.listCards(filter, controller.signal), client.listPosts(filter, controller.signal)]).then(results => {
      if (controller.signal.aborted || current !== generation.current) return;
      const [cardResult, postResult] = results;
      if (cardResult.status === "fulfilled") setCards(cardResult.value);
      if (postResult.status === "fulfilled") setPosts(postResult.value);
      const failures = results.filter(result => result.status === "rejected").map(result => recruitingErrorMessage((result as PromiseRejectedResult).reason));
      setError(failures.join(" ")); if (!failures.length) setLastRead(new Date().toISOString());
      setLoading(false);
    });
    return () => controller.abort();
  }, [client, filter]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    const version = identity.current;
    setApplicationsError(""); setApplicationsLoading(true);
    void client.getApplications(controller.signal).then(next => { if (!controller.signal.aborted && version === identity.current) setApplications(next); })
      .catch(reason => { if (!controller.signal.aborted && version === identity.current) { setApplicationsError(recruitingErrorMessage(reason)); if (reason instanceof RecruitingClientError && [401, 403].includes(reason.status)) setApplications([]); } })
      .finally(() => { if (!controller.signal.aborted && version === identity.current) setApplicationsLoading(false); });
    return () => controller.abort();
  }, [client, authenticated]);
  const readApplications = async () => {
    const version = identity.current;
    setApplicationsError(""); setApplicationsLoading(true);
    try { const next = await client.getApplications(); if (version === identity.current) setApplications(next); }
    catch (reason) { if (version === identity.current) { setApplicationsError(recruitingErrorMessage(reason)); if (reason instanceof RecruitingClientError && [401, 403].includes(reason.status)) setApplications([]); } }
    finally { if (version === identity.current) setApplicationsLoading(false); }
  };
  const operate = async (name: string, action: (current: () => boolean) => Promise<void>) => {
    if (busy) return;
    const version = identity.current;
    setBusy(name); setError(""); setNotice("");
    try { await action(() => version === identity.current); } catch (reason) { if (version === identity.current) setError(recruitingErrorMessage(reason)); } finally { if (version === identity.current) setBusy(""); }
  };
  const loadMore = () => operate("加载更多", async current => {
    const active = filterRef.current;
    if (tab === "cards" && cards?.nextCursor) {
      const next = await client.listCards({ ...active, cursor: cards.nextCursor });
      if (!current() || active !== filterRef.current) return;
      setCards({ items: [...cards.items, ...next.items.filter(card => !cards.items.some(existing => existing.id === card.id))], nextCursor: next.nextCursor });
    } else if (tab === "posts" && posts?.nextCursor) {
      const next = await client.listPosts({ ...active, cursor: posts.nextCursor });
      if (!current() || active !== filterRef.current) return;
      setPosts({ items: [...posts.items, ...next.items.filter(post => !posts.items.some(existing => existing.id === post.id))], nextCursor: next.nextCursor });
    }
  });
  const updateApplication = (result: RecruitingApplication, post?: RecruitingPost) => {
    setApplications(current => {
      const previous = current.find(item => item.id === result.id);
      const next: OwnApplication = { ...result, post: previous?.post ?? post ?? null, canJoin: result.status === "approved" && (previous?.canJoin ?? false) };
      return previous ? current.map(item => item.id === next.id ? next : item) : [next, ...current];
    });
  };
  const apply = (post: RecruitingPost) => operate(`申请:${post.id}`, async current => {
    const draft = drafts[post.id] ?? { message: "", shareCard: false, requestId: null };
    if (!draft.message.trim()) throw new Error("请简单介绍自己愿意贡献什么，再提交申请。");
    const requestId = draft.requestId ?? crypto.randomUUID();
    setDrafts(current => ({ ...current, [post.id]: { ...draft, requestId } }));
    const existing = applications.find(item => item.postId === post.id);
    const result = await client.apply(post.id, { expectedPostRevision: post.revision, expectedRevision: existing?.revision ?? 0, requestId, message: draft.message, shareCard: draft.shareCard });
    if (!current()) return;
    updateApplication(result, post); setDrafts(current => ({ ...current, [post.id]: { message: "", shareCard: false, requestId: null } }));
    setNotice("申请已保存到站内，等待管理员审核。审核通过后仍需你明确加入。");
  });
  const selectedItems = tab === "cards" ? cards?.items : posts?.items;

  return <section className={styles.root} aria-labelledby={`${prefix}-heading`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>公开组队大厅</p><h1 id={`${prefix}-heading`}>找到愿意一起交出作品的伙伴</h1><p>按想承担的职责、参赛目的和关键词看看伙伴或团队。没有经验、尚未报名也可以准备名片。</p></div><a className={styles.primary} href={authenticated ? profileHref : loginHref}>{authenticated ? "准备我的名片" : "登录后准备名片"}</a></header>
    <div className={styles.tabs} aria-label="组队内容"><button type="button" className={tab === "posts" ? styles.selectedTab : styles.secondary} aria-pressed={tab === "posts"} onClick={() => setTab("posts")}>团队在招募</button><button type="button" className={tab === "cards" ? styles.selectedTab : styles.secondary} aria-pressed={tab === "cards"} onClick={() => setTab("cards")}>看看伙伴名片</button></div>
    <form className={styles.filter} onSubmit={event => { event.preventDefault(); setFilter({ ...(role ? { role } : {}), ...(purpose ? { purpose } : {}), ...(keyword.trim() ? { keyword: keyword.trim() } : {}), limit: 24 }); }}>
      <label className={styles.field} htmlFor={`${prefix}-role`}>想做的职责<select id={`${prefix}-role`} value={role} onChange={event => setRole(event.target.value as RecruitingRole | "")}><option value="">不限职责</option>{recruitingRoles.map(item => <option key={item} value={item}>{roleLabels[item]}</option>)}</select></label>
      <label className={styles.field} htmlFor={`${prefix}-purpose`}>参赛目的<select id={`${prefix}-purpose`} value={purpose} onChange={event => setPurpose(event.target.value as RecruitingPurpose | "")}><option value="">不限目的</option>{recruitingPurposes.map(item => <option key={item} value={item}>{purposeLabels[item]}</option>)}</select></label>
      <label className={styles.field} htmlFor={`${prefix}-keyword`}>关键词<input id={`${prefix}-keyword`} type="search" value={keyword} maxLength={120} placeholder="如作品方向、技能、城市" onChange={event => setKeyword(event.target.value)} /></label>
      <button className={styles.primary} type="submit" disabled={loading || Boolean(busy)}>查找</button><button className={styles.secondary} type="button" disabled={loading || Boolean(busy)} onClick={() => { setRole(""); setPurpose(""); setKeyword(""); setFilter({ limit: 24 }); }}>清除筛选</button>
    </form>
    {error && <div className={styles.error} role="alert">{error} 已读取的内容可能较旧，填写仍保留。<button className={styles.secondary} type="button" disabled={loading || Boolean(busy)} onClick={() => setFilter({ ...filterRef.current })}>重新读取大厅</button></div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <p className={styles.muted} aria-live="polite">{loading ? "正在读取已发布的内容…" : `最近读取：${recruitingDate(lastRead)}`}</p>
    {!loading && selectedItems?.length === 0 && <div className={styles.empty}><h3>{tab === "posts" ? "暂时没有符合条件的招募" : "暂时没有符合条件的名片"}</h3><p>可以放宽筛选，或准备自己的名片，等更多伙伴明确发布。这里不会用示例人物或虚构团队补位。</p><button className={styles.secondary} type="button" onClick={() => { setRole(""); setPurpose(""); setKeyword(""); setFilter({ limit: 24 }); }}>查看全部</button></div>}
    <div className={styles.grid} aria-busy={loading}>
      {tab === "cards" ? cards?.items.map(publicCard) : posts?.items.map(post => {
        const application = applications.find(item => item.postId === post.id);
        const draft = drafts[post.id] ?? { message: "", shareCard: false, requestId: null };
        const canApply = post.status === "open" && (!application || ["withdrawn", "rejected"].includes(application.status));
        return <article className={styles.card} key={post.id}><div className={styles.sectionHeading}><p className={styles.eyebrow}>{post.spaceName}</p><span className={styles.badge}>{post.status === "open" ? "正在招募" : post.status === "closed" ? "已关闭招募" : "已撤回"}</span></div><h3>{post.title}</h3><p className={styles.preWrap}>{post.description}</p>
          {tags(post.neededRoles.map(item => roleLabels[item]))}{tags(post.purposes.map(item => purposeLabels[item]))}<p className={styles.muted}>希望招募 {post.seats} 人 · 更新于 {recruitingDate(post.updatedAt)}</p>
          {application && <p className={styles.badge}>{applicationLabels[application.status]}</p>}
          {!authenticated ? <a className={styles.secondary} href={loginHref}>登录后申请加入</a> : canApply ? <details className={styles.details}><summary>{application ? "重新申请这个团队" : "申请加入这个团队"}</summary><form onSubmit={event => { event.preventDefault(); void apply(post); }}>
            <label className={styles.field} htmlFor={`${prefix}-message-${post.id}`}>想承担什么、能贡献什么<textarea id={`${prefix}-message-${post.id}`} rows={4} value={draft.message} maxLength={2000} required disabled={Boolean(busy)} onChange={event => setDrafts(current => ({ ...current, [post.id]: { ...draft, message: event.target.value, requestId: null } }))} /></label>
            <label className={styles.choice}><input type="checkbox" checked={draft.shareCard} disabled={Boolean(busy)} onChange={event => setDrafts(current => ({ ...current, [post.id]: { ...draft, shareCard: event.target.checked, requestId: null } }))} />随申请附上我当前已发布的名片快照（选填）</label>
            <p className={styles.muted}>提交仅产生站内申请，不会自动加入空间。管理员会看到这段介绍，以及你明确选择附上的公开名片。</p><button className={styles.primary} type="submit" disabled={Boolean(busy) || !draft.message.trim()}>{busy === `申请:${post.id}` ? "正在提交…" : "提交站内申请"}</button>
          </form></details> : null}
        </article>;
      })}
    </div>
    {(tab === "cards" ? cards?.nextCursor : posts?.nextCursor) && <div className={styles.actions}><button className={styles.secondary} type="button" disabled={loading || Boolean(busy)} onClick={loadMore}>{busy === "加载更多" ? "正在读取…" : "加载更多"}</button></div>}
    {authenticated && <section className={styles.panel} aria-labelledby={`${prefix}-applications`}><div className={styles.sectionHeading}><h2 id={`${prefix}-applications`}>我的申请</h2><button type="button" className={styles.secondary} disabled={Boolean(busy) || applicationsLoading} onClick={() => void readApplications()}>读取最新申请</button></div>
      {applicationsError && <p className={styles.error} role="alert">{applicationsError}</p>}
      {applicationsLoading && <p role="status">正在读取本人的申请…</p>}
      {!applicationsLoading && !applicationsError && applications.length === 0 && <p className={styles.muted}>还没有站内申请。先看团队的目标，再介绍自己愿意做什么。</p>}
      <div className={styles.list}>{applications.map(application => <article className={styles.application} key={application.id}><div className={styles.sectionHeading}><h3>{application.post?.title ?? "原招募已不可公开查看"}</h3><span className={styles.badge}>{applicationLabels[application.status]}</span></div>
        <p className={styles.preWrap}>{application.message}</p>{application.reviewNote && <p className={styles.preWrap}>管理员说明：{application.reviewNote}</p>}<p className={styles.muted}>更新于 {recruitingDate(application.updatedAt)}</p>
        {application.status === "approved" && <><p>批准表示管理员同意你的申请。加入前请确认这就是你要参加的空间。</p>
          {application.canJoin ? <><label className={styles.confirmation}><input type="checkbox" checked={joining[application.id] ?? false} disabled={Boolean(busy)} onChange={event => setJoining(current => ({ ...current, [application.id]: event.target.checked }))} />我确认加入{application.post?.spaceName ? `「${application.post.spaceName}」` : "这个空间"}，成为普通成员。</label><button type="button" className={styles.primary} disabled={Boolean(busy) || !joining[application.id]} onClick={() => void operate(`加入:${application.id}`, async current => { const result = await client.joinApplication(application.id, { expectedRevision: application.revision, confirmed: true }); if (!current()) return; updateApplication(result); setJoining(previous => ({ ...previous, [application.id]: false })); setNotice("已实际加入空间，成员身份已保存。"); onJoined?.(result); })}>{busy === `加入:${application.id}` ? "正在加入…" : "确认加入空间"}</button></> : <p className={styles.muted}>当前尚不能加入，请读取最新申请或与管理员确认招募及空间状态。</p>}
        </>}
        {["pending", "approved"].includes(application.status) && <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => void operate(`撤回:${application.id}`, async current => { const result = await client.withdrawApplication(application.id, { expectedRevision: application.revision }); if (!current()) return; updateApplication(result); setNotice("申请已撤回。"); })}>{busy === `撤回:${application.id}` ? "正在撤回…" : "撤回申请"}</button>}
        {application.status === "joined" && <a className={styles.primary} href={`/app/projects/${encodeURIComponent(application.projectId)}`}>进入已加入的空间</a>}
      </article>)}</div>
    </section>}
    <aside className={styles.muted}>名片只表达本人愿意贡献的内容，MBTI 和年龄不用于能力排名。联系与合作请尊重对方；这里的审批和加入都在站内完成。</aside>
  </section>;
}
