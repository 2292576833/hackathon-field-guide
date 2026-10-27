"use client";

import { useEffect, useId, useRef, useState } from "react";
import { defaultRecruitingClient, RecruitingClientError, recruitingDate, recruitingErrorMessage, recruitingSafeLink } from "./client.ts";
import type { RecruitingClient } from "./client.ts";
import type { GapView } from "./gap.ts";
import { roleLabels } from "./model.ts";
import type { RecruitingApplication, RecruitingPost, RecruitingPostData } from "./model.ts";
import { RecruitingPurposeChoices, RecruitingRoleChoices } from "./RecruitingProfileEditor.tsx";
import styles from "./recruiting.module.css";

export interface RecruitingPostManagerProps {
  projectId: string; isAdministrator: boolean; client?: RecruitingClient;
  onChanged?: (post: RecruitingPost) => void;
}
const emptyPost = (): RecruitingPostData => ({ spaceName: "", title: "", description: "", neededRoles: [], purposes: [], seats: 1, status: "open" });
const postData = (post: RecruitingPost): RecruitingPostData => {
  const { spaceName, title, description, neededRoles, purposes, seats, status } = post;
  return { spaceName, title, description, neededRoles: [...neededRoles], purposes: [...purposes], seats, status };
};
const applicationLabels: Record<RecruitingApplication["status"], string> = { pending: "待审核", approved: "已批准，等待本人加入", rejected: "未通过", withdrawn: "申请人已撤回", joined: "已加入" };

export function RecruitingPostManager({ projectId, isAdministrator, client = defaultRecruitingClient, onChanged }: RecruitingPostManagerProps) {
  const prefix = useId();
  const [post, setPost] = useState<RecruitingPost | null>(null);
  const [form, setForm] = useState<RecruitingPostData>(emptyPost);
  const [applications, setApplications] = useState<RecruitingApplication[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [loading, setLoading] = useState(isAdministrator);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [permissionLost, setPermissionLost] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const identity = useRef(0);
  const allowed = isAdministrator && !permissionLost;
  const dirty = JSON.stringify(form) !== JSON.stringify(post ? postData(post) : emptyPost());

  useEffect(() => {
    const current = ++identity.current;
    const controller = new AbortController();
    setPost(null); setForm(emptyPost()); setApplications([]); setNotes({}); setPublishConfirmed(false);
    setError(""); setNotice(""); setPermissionLost(false); setLastRead(null); setBusy("");
    if (isAdministrator) {
      setLoading(true);
      void Promise.all([client.getPost(projectId, controller.signal), client.getProjectApplications(projectId, controller.signal)])
        .then(([nextPost, nextApplications]) => { if (!controller.signal.aborted && current === identity.current) { setPost(nextPost); setForm(nextPost ? postData(nextPost) : emptyPost()); setApplications(nextApplications); setLastRead(new Date().toISOString()); } })
        .catch(reason => { if (!controller.signal.aborted && current === identity.current) { setError(recruitingErrorMessage(reason)); if (reason instanceof RecruitingClientError && [401, 403].includes(reason.status)) setPermissionLost(true); } })
        .finally(() => { if (!controller.signal.aborted && current === identity.current) setLoading(false); });
    } else setLoading(false);
    return () => { controller.abort(); identity.current++; };
  }, [client, projectId, isAdministrator]);
  useEffect(() => {
    const clear = () => { identity.current++; setPermissionLost(true); setPost(null); setForm(emptyPost()); setApplications([]); setNotes({}); setError("登录已失效，请重新打开空间后继续。"); setLoading(false); setBusy(""); };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);
  const operate = async (name: string, action: (current: () => boolean) => Promise<void>) => {
    if (busy || !allowed) return;
    const version = identity.current;
    setBusy(name); setError(""); setNotice("");
    try { await action(() => version === identity.current); }
    catch (reason) { if (version === identity.current) { setError(recruitingErrorMessage(reason)); if (reason instanceof RecruitingClientError && [401, 403].includes(reason.status)) { setPermissionLost(true); setApplications([]); } } }
    finally { if (version === identity.current) setBusy(""); }
  };
  const reload = () => operate("读取", async current => {
    const [nextPost, nextApplications] = await Promise.all([client.getPost(projectId), client.getProjectApplications(projectId)]);
    if (!current()) return;
    setPost(nextPost); setApplications(nextApplications); setPublishConfirmed(false); setLastRead(new Date().toISOString());
    setNotice("最新招募和申请已读取，你填写的招募内容与审核说明仍保留。请核对后再保存。");
  });
  const save = () => operate("保存招募", async current => {
    if (!publishConfirmed) throw new Error("请先确认已经核对公开内容。");
    const next = await client.savePost(projectId, { expectedRevision: post?.revision ?? 0, post: form });
    if (!current()) return;
    setPost(next); setForm(postData(next)); setPublishConfirmed(false);
    setNotice(next.status === "open" ? "招募已公开发布。申请不会自动加入空间。" : next.status === "closed" ? "招募已关闭，已有申请保留。" : "招募已撤回，公开大厅不再展示。"); onChanged?.(next);
  });
  const setStatus = (status: RecruitingPostData["status"]) => operate(status === "closed" ? "关闭招募" : "撤回招募", async current => {
    if (!post) return;
    const next = await client.savePost(projectId, { expectedRevision: post.revision, post: { ...postData(post), status } });
    if (!current()) return;
    setPost(next); if (!dirty) setForm(postData(next)); setPublishConfirmed(false);
    setNotice(status === "closed" ? "已关闭招募，已有申请仍保留供你核对。" : "已撤回招募，公开大厅不再展示。填写仍保留。"); onChanged?.(next);
  });
  const review = (application: RecruitingApplication, decision: "approve" | "reject") => operate(`审核:${application.id}`, async current => {
    const result = await client.reviewApplication(application.id, { expectedRevision: application.revision, decision, note: notes[application.id] ?? application.reviewNote });
    if (!current()) return;
    setApplications(items => items.map(item => item.id === result.id ? result : item));
    setNotice(decision === "approve" ? "申请已批准。对方明确点击加入并通过当前权限检查后，才会成为普通成员。" : "审核结果已保存，对方可以在自己的申请中查看说明。");
  });
  const updateForm = (change: Partial<RecruitingPostData>) => { setForm({ ...form, ...change }); setPublishConfirmed(false); };

  return <section className={styles.root} aria-labelledby={`${prefix}-heading`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>空间招募</p><h2 id={`${prefix}-heading`}>说清目标与需要的贡献</h2><p>公开介绍由你本人填写。本站不会自动把空间的私人规则、资料或对话公开。</p></div><a className={styles.secondary} href="/recruiting">查看公开大厅</a></header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!allowed ? <p className={styles.empty}>{permissionLost ? "当前登录或管理权限已失效，请重新进入空间核对权限。" : "只有当前活跃空间管理员可以发布招募和审核申请。你可以在公开组队大厅查看招募。"}</p> : <>
      {loading && <p role="status">正在读取当前招募与申请…</p>}
      <form className={styles.panel} onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={busy === "保存招募"}>
        <div className={styles.sectionHeading}><h3>{post ? "编辑公开招募" : "发布第一条招募"}</h3>{post && <span className={styles.badge}>{post.status === "open" ? "正在招募" : post.status === "closed" ? "已关闭" : "已撤回"} · 版本 {post.revision}</span>}</div>
        <label className={styles.field} htmlFor={`${prefix}-space-name`}>公开的空间名称<input id={`${prefix}-space-name`} value={form.spaceName} maxLength={120} required disabled={loading || Boolean(busy)} onChange={event => updateForm({ spaceName: event.target.value })} /></label>
        <label className={styles.field} htmlFor={`${prefix}-title`}>招募标题<input id={`${prefix}-title`} value={form.title} maxLength={120} required placeholder="如：一起做一个可演示的校园助手，需要设计与前端伙伴" disabled={loading || Boolean(busy)} onChange={event => updateForm({ title: event.target.value })} /></label>
        <label className={styles.field} htmlFor={`${prefix}-description`}>公开介绍<textarea id={`${prefix}-description`} rows={6} value={form.description} maxLength={4000} required placeholder="介绍作品方向、最小成果、希望伙伴贡献什么，以及目前的时间安排。请勿包含私人联系方式或未获授权的队友资料。" disabled={loading || Boolean(busy)} onChange={event => updateForm({ description: event.target.value })} /></label>
        <RecruitingRoleChoices legend="希望补充的职责（可多选）" values={form.neededRoles} disabled={loading || Boolean(busy)} onChange={neededRoles => updateForm({ neededRoles })} />
        <RecruitingPurposeChoices values={form.purposes} disabled={loading || Boolean(busy)} onChange={purposes => updateForm({ purposes })} />
        <div className={styles.twoColumns}><label className={styles.field} htmlFor={`${prefix}-seats`}>计划招募人数<input id={`${prefix}-seats`} type="number" inputMode="numeric" min={1} max={50} value={form.seats} required disabled={loading || Boolean(busy)} onChange={event => updateForm({ seats: Number(event.target.value) })} /></label>
          <label className={styles.field} htmlFor={`${prefix}-status`}>发布状态<select id={`${prefix}-status`} value={form.status} disabled={loading || Boolean(busy)} onChange={event => updateForm({ status: event.target.value as RecruitingPostData["status"] })}><option value="open">公开并接受申请</option><option value="closed">关闭招募</option><option value="withdrawn">从公开大厅撤回</option></select></label>
        </div>
        <label className={styles.confirmation}><input type="checkbox" checked={publishConfirmed} disabled={loading || Boolean(busy)} onChange={event => setPublishConfirmed(event.target.checked)} />我已核对这些公开内容，并确认保存所选招募状态。</label>
        <div className={styles.actions}><button className={styles.primary} type="submit" disabled={loading || Boolean(busy) || !publishConfirmed}>{busy === "保存招募" ? "正在保存…" : form.status === "open" ? post ? "确认更新并公开招募" : "确认公开招募" : "确认保存招募状态"}</button><button className={styles.secondary} type="button" disabled={loading || Boolean(busy)} onClick={reload}>读取最新记录，保留填写</button></div>
        {post?.status === "open" && <div className={styles.actions}><button className={styles.secondary} type="button" disabled={loading || Boolean(busy)} onClick={() => void setStatus("closed")}>立即关闭招募</button><button className={styles.secondary} type="button" disabled={loading || Boolean(busy)} onClick={() => void setStatus("withdrawn")}>撤回公开招募</button></div>}
        {dirty && <p className={styles.muted}>有尚未保存的填写；快速关闭或撤回只改变当前已保存的招募状态。</p>}
        {post && <details className={styles.details}><summary>核对当前已保存的招募</summary><h4>{post.title}</h4><p className={styles.preWrap}>{post.description}</p><p className={styles.muted}>更新于 {recruitingDate(post.updatedAt)} · 状态 {post.status === "open" ? "公开招募" : post.status === "closed" ? "已关闭" : "已撤回"}</p></details>}
      </form>
      <section className={styles.panel} aria-labelledby={`${prefix}-applications`}><div className={styles.sectionHeading}><h3 id={`${prefix}-applications`}>站内申请</h3><span className={styles.muted}>最近读取：{recruitingDate(lastRead)}</span></div><p className={styles.muted}>批准只记录审核结果。申请人明确加入时会再次核对空间、本人及批准者的当前权限，仅授普通成员身份。</p>
        {!loading && applications.length === 0 && <p className={styles.empty}>目前没有站内申请。先公开清楚的招募内容，让伙伴了解需要交出什么。</p>}
        <div className={styles.list}>{applications.map(application => <article className={styles.application} key={application.id}><div className={styles.sectionHeading}><h4>{application.applicantDisplayName}</h4><span className={styles.badge}>{applicationLabels[application.status]}</span></div><p className={styles.preWrap}>{application.message}</p>
          {application.cardSnapshot && <details className={styles.details}><summary>对方明确附上的名片快照</summary><h4>{application.cardSnapshot.headline}</h4><p className={styles.preWrap}>{application.cardSnapshot.introduction}</p><p className={styles.muted}>这是提交申请时的公开快照。</p><div className={styles.actions}>{application.cardSnapshot.workLinks.map((link, index) => { const href = recruitingSafeLink(link.url); return href ? <a className={styles.secondary} href={href} key={index} target="_blank" rel="noreferrer noopener">{link.title || "作品链接"} ↗</a> : null; })}</div></details>}
          {application.reviewNote && <p className={styles.preWrap}>已保存审核说明：{application.reviewNote}</p>}
          {["pending", "approved", "rejected"].includes(application.status) && <><label className={styles.field} htmlFor={`${prefix}-note-${application.id}`}>给申请人的审核说明（选填）<textarea id={`${prefix}-note-${application.id}`} rows={3} value={notes[application.id] ?? application.reviewNote} maxLength={1000} disabled={Boolean(busy)} onChange={event => setNotes(current => ({ ...current, [application.id]: event.target.value }))} /></label><div className={styles.actions}><button className={styles.primary} type="button" disabled={Boolean(busy) || post?.status !== "open"} onClick={() => void review(application, "approve")}>{busy === `审核:${application.id}` ? "正在保存审核…" : application.status === "approved" ? "更新批准及说明" : "批准申请，等待本人加入"}</button><button className={styles.secondary} type="button" disabled={Boolean(busy)} onClick={() => void review(application, "reject")}>{application.status === "approved" ? "撤销批准并保存说明" : "不通过并保存说明"}</button></div></>}
          <p className={styles.muted}>更新于 {recruitingDate(application.updatedAt)}</p>
        </article>)}</div>
      </section>
      {post && <PostGaps projectId={projectId} client={client} refreshKey={`${post.revision}:${applications.length}`}/>}
    </>}
  </section>;
}
/**
 * 缺口互补：列出招募帖还缺的职责与声明了这些职责的人。
 * 只读派生；不评分、不给匹配度、不排能力先后（依据见 gap.ts 顶部注释）。
 */
function PostGaps({ projectId, client, refreshKey }: { projectId: string; client: RecruitingClient; refreshKey: string }) {
  const [view, setView] = useState<GapView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void client.getPostGaps(projectId, controller.signal).then(next => { if (!controller.signal.aborted) { setView(next); setError(""); } },
      reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取缺口信息失败，可以稍后重试。"); });
    return () => controller.abort();
  }, [projectId, client, refreshKey]);
  if (error) return <section className={styles.panel}><h3>缺口与候选人</h3><p className={styles.error} role="alert">{error}</p></section>;
  if (!view) return <section className={styles.panel}><h3>缺口与候选人</h3><p role="status" className={styles.muted}>正在根据招募帖与已加入的人计算缺口…</p></section>;
  return <section className={styles.panel} aria-labelledby="recruiting-gaps-heading">
    <div className={styles.sectionHeading}><h3 id="recruiting-gaps-heading">缺口与候选人</h3><span className={styles.badge}>名额 {view.takenSeats}/{view.seats}</span></div>
    <p className={styles.muted}>{view.notice}</p>
    {!!view.coveredRoles.length && <p className={styles.muted}>已覆盖：{view.coveredRoles.map(item => `${item.label}（${item.by.length} 人）`).join("、")}</p>}
    {!!view.gaps.length && <div className={styles.list}>{view.gaps.map(gap => <article className={styles.application} key={gap.role}>
      <div className={styles.sectionHeading}><h4>还缺：{gap.label}</h4><span className={styles.badge}>{gap.candidates.length} 人声明了这项职责</span></div>
      {!gap.candidates.length ? <p className={styles.empty}>目前没有已发布名片声明这项职责的人。可以调整职责范围，或继续在公开大厅介绍这个空间。</p>
        : <ul className={styles.list}>{gap.candidates.map(candidate => <li key={candidate.userId}>
          <p>{candidate.displayName}{candidate.headline ? ` · ${candidate.headline}` : ""}{candidate.city ? ` · ${candidate.city}` : ""}</p>
          <p className={styles.muted}>能补：{candidate.coveringRoles.map(role => roleLabels[role]).join("、")} · 名片更新于 {recruitingDate(candidate.publishedAt)}</p>
        </li>)}</ul>}
    </article>)}</div>}
    <ul className={styles.muted}>{view.evidence.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}
