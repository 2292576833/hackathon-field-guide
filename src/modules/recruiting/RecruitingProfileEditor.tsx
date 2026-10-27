"use client";

import { useEffect, useId, useRef, useState } from "react";
import { defaultRecruitingClient, RecruitingClientError, recruitingDate, recruitingErrorMessage, recruitingSafeLink } from "./client.ts";
import type { RecruitingClient } from "./client.ts";
import { purposeLabels, recruitingPurposes, recruitingRoles, roleLabels } from "./model.ts";
import type { CardDraft, OwnCardState, RecruitingProfileData, RecruitingProfileView, RecruitingPurpose, RecruitingRole, WorkLink } from "./model.ts";
import styles from "./recruiting.module.css";

export interface RecruitingProfileEditorProps {
  client?: RecruitingClient; initialView?: RecruitingProfileView;
  loginHref?: string; onPublished?: (card: OwnCardState) => void;
}
interface Preview {
  provider: "dsh" | "manual"; profileRevision: number; participantRevision: number;
  avatarRevision: number; draft: CardDraft;
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function profileData(view: RecruitingProfileView): RecruitingProfileData {
  const { primaryRoles, supportingRoles, purposes, purposeNote, resume, workLinks, mbti, age } = view.profile;
  return copy({ primaryRoles, supportingRoles, purposes, purposeNote, resume, workLinks, mbti, age });
}
function manualPreview(view: RecruitingProfileView): Preview {
  return {
    provider: "manual", profileRevision: view.profile.revision, participantRevision: view.participant.revision,
    avatarRevision: view.profile.avatarRevision,
    draft: {
      headline: "", introduction: view.profile.resume,
      primaryRoles: [...view.profile.primaryRoles], supportingRoles: [...view.profile.supportingRoles],
      purposes: [...view.profile.purposes], purposeNote: view.profile.purposeNote,
      skills: [...view.participant.skills], city: view.participant.city,
      availableHoursPerDay: view.participant.availableHoursPerDay, workLinks: copy(view.profile.workLinks),
      showMbti: false, showAge: false, showAvatar: false,
    },
  };
}
function toggle<T>(values: T[], value: T): T[] { return values.includes(value) ? values.filter(item => item !== value) : [...values, value]; }

export function RecruitingRoleChoices({ legend, values, onChange, disabled }: { legend: string; values: RecruitingRole[]; onChange: (values: RecruitingRole[]) => void; disabled?: boolean }) {
  return <fieldset className={styles.fieldset} disabled={disabled}><legend>{legend}</legend><div className={styles.choices}>
    {recruitingRoles.map(role => <label className={styles.choice} key={role}><input type="checkbox" checked={values.includes(role)} onChange={() => onChange(toggle(values, role))} />{roleLabels[role]}</label>)}
  </div></fieldset>;
}
export function RecruitingPurposeChoices({ values, onChange, disabled }: { values: RecruitingPurpose[]; onChange: (values: RecruitingPurpose[]) => void; disabled?: boolean }) {
  return <fieldset className={styles.fieldset} disabled={disabled}><legend>这次参赛想获得什么（可多选）</legend><div className={styles.choices}>
    {recruitingPurposes.map(purpose => <label className={styles.choice} key={purpose}><input type="checkbox" checked={values.includes(purpose)} onChange={() => onChange(toggle(values, purpose))} />{purposeLabels[purpose]}</label>)}
  </div></fieldset>;
}
function WorkLinksEditor({ values, onChange, disabled, prefix }: { values: WorkLink[]; onChange: (values: WorkLink[]) => void; disabled: boolean; prefix: string }) {
  return <fieldset className={styles.fieldset} disabled={disabled}><legend>作品链接（选填）</legend>
    {values.map((link, index) => <div className={styles.linkRow} key={index}>
      <label className={styles.field} htmlFor={`${prefix}-title-${index}`}>作品名称<input id={`${prefix}-title-${index}`} value={link.title} maxLength={100} required onChange={event => onChange(values.map((item, position) => position === index ? { ...item, title: event.target.value } : item))} /></label>
      <label className={styles.field} htmlFor={`${prefix}-url-${index}`}>公开网址<input id={`${prefix}-url-${index}`} type="url" inputMode="url" placeholder="https://…" value={link.url} maxLength={2048} required onChange={event => onChange(values.map((item, position) => position === index ? { ...item, url: event.target.value } : item))} /></label>
      <button className={styles.secondary} type="button" onClick={() => onChange(values.filter((_, position) => position !== index))} aria-label={`移除第 ${index + 1} 个作品链接`}>移除</button>
    </div>)}
    <button className={styles.secondary} type="button" disabled={values.length >= 8} onClick={() => onChange([...values, { title: "", url: "" }])}>添加作品链接</button>
  </fieldset>;
}

export function RecruitingProfileEditor({ client = defaultRecruitingClient, initialView, loginHref = "/login?returnTo=%2Fapp%2Faccount", onPublished }: RecruitingProfileEditorProps) {
  const prefix = useId();
  const [view, setView] = useState<RecruitingProfileView | null>(initialView ?? null);
  const [form, setForm] = useState<RecruitingProfileData | null>(initialView ? profileData(initialView) : null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(!initialView);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [summaryUnknown, setSummaryUnknown] = useState(false);
  const identity = useRef(0);
  const initialUser = useRef(initialView?.profile.userId ?? null);
  const dirty = Boolean(view && form && JSON.stringify(form) !== JSON.stringify(profileData(view)));
  const nicknameContainsEmail = Boolean(view && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(view.displayName));

  useEffect(() => {
    const controller = new AbortController();
    const version = ++identity.current;
    setBusy("");
    if (initialView && initialUser.current !== initialView.profile.userId) {
      initialUser.current = initialView.profile.userId;
      setView(initialView); setForm(profileData(initialView)); setPreview(null); setConfirmed(false);
      setUnauthenticated(false); setSummaryUnknown(false); setNotice(""); setError(""); setLoading(false);
    }
    if (!initialView) {
      setLoading(true);
      void client.getProfile(controller.signal).then(next => { if (!controller.signal.aborted && version === identity.current) { setView(next); setForm(profileData(next)); } })
        .catch(reason => { if (!controller.signal.aborted) { setError(recruitingErrorMessage(reason)); setUnauthenticated(reason instanceof RecruitingClientError && reason.status === 401); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    const clear = () => { identity.current++; setView(null); setForm(null); setPreview(null); setUnauthenticated(true); setError("登录已失效，请重新登录后继续。"); setBusy(""); setLoading(false); };
    window.addEventListener("hackathon:unauthenticated", clear);
    return () => { identity.current++; controller.abort(); window.removeEventListener("hackathon:unauthenticated", clear); };
  }, [client, initialView]);

  const operate = async (name: string, action: (current: () => boolean) => Promise<void>) => {
    if (busy) return;
    const version = identity.current;
    setBusy(name); setError(""); setNotice("");
    try { await action(() => version === identity.current); }
    catch (reason) { if (version === identity.current) { setError(recruitingErrorMessage(reason)); if (reason instanceof RecruitingClientError && [401, 403].includes(reason.status)) setUnauthenticated(true); } }
    finally { if (version === identity.current) setBusy(""); }
  };
  const reload = () => operate("读取", async current => {
    const next = await client.getProfile();
    if (!current()) return;
    setView(next); if (!form) setForm(profileData(next)); setPreview(null); setConfirmed(false);
    setUnauthenticated(false); setNotice("已读取最新记录，当前填写仍保留。请核对后再保存。");
  });
  const save = () => operate("保存资料", async current => {
    if (!view || !form) return;
    const next = await client.saveProfile({ expectedRevision: view.profile.revision, profile: form });
    if (!current()) return;
    setView(next); setForm(profileData(next)); setPreview(null); setConfirmed(false);
    setNotice("私人资料已保存。已发布的名片保持原来的快照。");
  });
  const generate = () => operate("AI 归纳", async current => {
    if (!view || dirty || summaryUnknown) return;
    try {
      const result = await client.summarizeProfile({ expectedRevision: view.profile.revision });
      if (!current()) return;
      setPreview({ ...result, draft: { ...result.draft, showAge: false, showMbti: false, showAvatar: false } });
      setConfirmed(false); setNotice("DSH 归纳已返回。请编辑并核对预览，再决定是否公开。");
    } catch (reason) {
      if (current() && (!(reason instanceof RecruitingClientError) || reason.status === 0 || reason.status >= 500 || /UNKNOWN|UNCERTAIN|HOLD|TIMEOUT|IN_PROGRESS/.test(reason.code))) setSummaryUnknown(true);
      throw reason;
    }
  });
  const publish = () => operate("发布名片", async current => {
    if (!view || !preview || !confirmed || dirty) return;
    const next = await client.publishCard({ expectedRevision: view.card.revision, profileRevision: preview.profileRevision,
      participantRevision: preview.participantRevision, avatarRevision: preview.avatarRevision, draft: { ...preview.draft, skills: preview.draft.skills.map(skill => skill.trim()).filter(Boolean) }, confirmed: true });
    if (!current()) return;
    setView({ ...view, card: next }); setConfirmed(false); setNotice("名片已公开发布。以后修改私人资料，需要重新预览并发布才会更新名片。"); onPublished?.(next);
  });
  const withdraw = () => operate("撤回名片", async current => {
    if (!view) return;
    const next = await client.withdrawCard({ expectedRevision: view.card.revision });
    if (!current()) return;
    setView({ ...view, card: next }); setNotice("名片已撤回，不再出现在公开大厅。"); onPublished?.(next);
  });
  const upload = (file: File | undefined) => operate("保存头像", async current => {
    if (!file || !view) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 512 * 1024) throw new Error("请选择不超过 512 KB 的 PNG、JPEG 或 WebP 图片。");
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("图片读取失败，请重新选择。")); reader.readAsDataURL(file);
    });
    const next = await client.uploadAvatar({ expectedRevision: view.profile.avatarRevision, avatar: { mimeType: file.type as "image/png" | "image/jpeg" | "image/webp", base64 } });
    if (!current()) return;
    setView(next); setPreview(null); setConfirmed(false); setNotice("私人头像已保存，已发布名片的头像不会自动改变。");
  });
  const updateDraft = (change: Partial<CardDraft>) => { if (preview) { setPreview({ ...preview, draft: { ...preview.draft, ...change } }); setConfirmed(false); } };

  return <section className={styles.root} aria-labelledby={`${prefix}-heading`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>我的参赛名片</p><h2 id={`${prefix}-heading`}>先说清愿意做什么，再找到伙伴</h2><p>资料默认只给本人看。公开大厅只展示你预览并明确发布的内容。</p></div><a className={styles.secondary} href="/recruiting">看看组队大厅</a></header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {loading && <p role="status">正在读取本人的资料…</p>}
    {unauthenticated && <a className={styles.primary} href={loginHref}>登录后填写参赛资料</a>}
    {!loading && !view && !unauthenticated && <button className={styles.secondary} type="button" onClick={reload} disabled={Boolean(busy)}>重新读取资料</button>}
    {!unauthenticated && view && form && <>
      <form className={styles.panel} onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={busy === "保存资料"}>
        <div className={styles.sectionHeading}><h3>私人参赛资料</h3><span className={styles.badge}>仅本人可见</span></div>
        <RecruitingRoleChoices legend="主要想承担的职责（可多选）" values={form.primaryRoles} disabled={Boolean(busy)} onChange={primaryRoles => setForm({ ...form, primaryRoles })} />
        <RecruitingRoleChoices legend="还愿意协助的职责（选填）" values={form.supportingRoles} disabled={Boolean(busy)} onChange={supportingRoles => setForm({ ...form, supportingRoles })} />
        <RecruitingPurposeChoices values={form.purposes} disabled={Boolean(busy)} onChange={purposes => setForm({ ...form, purposes })} />
        <label className={styles.field} htmlFor={`${prefix}-purpose`}>补充自己的参赛目的（选填）<input id={`${prefix}-purpose`} value={form.purposeNote} maxLength={240} disabled={Boolean(busy)} onChange={event => setForm({ ...form, purposeNote: event.target.value })} /></label>
        <label className={styles.field} htmlFor={`${prefix}-resume`}>简单介绍自己的经历<textarea id={`${prefix}-resume`} value={form.resume} maxLength={4000} rows={5} disabled={Boolean(busy)} placeholder="例如做过什么、想尝试什么、愿意交出什么成果。没有经验也可以直接写。" onChange={event => setForm({ ...form, resume: event.target.value })} /></label>
        <WorkLinksEditor values={form.workLinks} onChange={workLinks => setForm({ ...form, workLinks })} disabled={Boolean(busy)} prefix={`${prefix}-private`} />
        <details className={styles.details}><summary>其他选填信息：MBTI、年龄</summary><p className={styles.muted}>这些信息不会用于判断能力或限制组队，是否公开由你在名片预览中选择。</p><div className={styles.twoColumns}>
          <label className={styles.field} htmlFor={`${prefix}-mbti`}>MBTI（选填）<input id={`${prefix}-mbti`} value={form.mbti} maxLength={4} placeholder="如 INFP" disabled={Boolean(busy)} onChange={event => setForm({ ...form, mbti: event.target.value.toUpperCase() })} /></label>
          <label className={styles.field} htmlFor={`${prefix}-age`}>年龄（选填）<input id={`${prefix}-age`} type="number" inputMode="numeric" min={1} max={120} value={form.age ?? ""} disabled={Boolean(busy)} onChange={event => setForm({ ...form, age: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        </div></details>
        <p className={styles.muted}>技能、城市和每天可投入时间来自已有的私人参赛画像。<a href="/app/account">去个人准备中修改</a>。保存时间：{recruitingDate(view.profile.updatedAt)}</p>
        <div className={styles.actions}><button className={styles.primary} type="submit" disabled={Boolean(busy)}>{busy === "保存资料" ? "正在保存…" : "保存私人资料"}</button><button className={styles.secondary} type="button" disabled={Boolean(busy)} onClick={reload}>读取最新记录，保留填写</button>{dirty && <span className={styles.muted}>有尚未保存的填写</span>}</div>
      </form>
      <details className={styles.panel}><summary>私人头像（选填）</summary><p className={styles.muted}>只支持不超过 512 KB 的 PNG、JPEG、WebP；生成名片时不会把头像发送给 AI。</p>
        {view.profile.hasAvatar && <img className={styles.avatar} src={`${client.privateAvatarUrl()}?revision=${view.profile.avatarRevision}`} alt="本人保存的私人头像" width={64} height={64} />}
        <label className={styles.field} htmlFor={`${prefix}-avatar`}>选择头像<input id={`${prefix}-avatar`} type="file" accept="image/png,image/jpeg,image/webp" disabled={Boolean(busy)} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /></label>
        {view.profile.hasAvatar && <button className={styles.secondary} type="button" disabled={Boolean(busy)} onClick={() => void operate("移除头像", async current => { const next = await client.removeAvatar({ expectedRevision: view.profile.avatarRevision }); if (!current()) return; setView(next); setPreview(null); setConfirmed(false); setNotice("私人头像已移除。已发布头像需要更新名片或撤回后才会变化。"); })}>移除私人头像</button>}
      </details>
      <section className={styles.panel} aria-labelledby={`${prefix}-preview-heading`}>
        <h3 id={`${prefix}-preview-heading`}>准备公开名片</h3><p>先保存资料，再明确请求 DSH 归纳或自己填写。生成、预览和公开发布是分开的操作。</p>
        <div className={styles.actions}><button className={styles.primary} type="button" onClick={generate} disabled={Boolean(busy) || dirty || summaryUnknown}>{busy === "AI 归纳" ? "等待 DSH 返回预览…" : "请求 AI 归纳名片"}</button><button className={styles.secondary} type="button" disabled={Boolean(busy) || dirty} onClick={() => { setPreview(manualPreview(view)); setConfirmed(false); setNotice("已建立手动预览，请填写标题并核对公开内容。"); }}>自己填写名片</button></div>
        {dirty && <p className={styles.muted}>先保存私人资料，才能生成或发布与当前版本一致的名片。</p>}
        {summaryUnknown && <p className={styles.error} role="status">本次 AI 请求结果尚未确认，请稍后核对后台记录。页面不会自动重新发起；你仍可自己填写名片。</p>}
        {preview && <div className={styles.preview}>
          <div className={styles.sectionHeading}><h4>发布前预览 · 可修改</h4><span className={styles.badge}>{preview.provider === "dsh" ? "DSH 归纳 · provider:dsh" : "本人手动填写"}</span></div>
          <p>公开昵称：<strong>{view.displayName}</strong>。昵称来自当前账号，<a href="/app/account">可去账号设置修改</a>。</p>
          {nicknameContainsEmail && <p className={styles.error}>当前昵称包含邮箱，请先到账号设置改成不含邮箱的昵称，再重新读取资料并发布名片。</p>}
          <p className={styles.muted}>仅下列内容会公开，邮箱和私人简历原文不会单独展示。年龄、MBTI、头像仅在你勾选时显示。</p>
          <p className={styles.muted}>请勿在公开标题、介绍、目的、技能或作品链接中填写邮箱。</p>
          <label className={styles.field} htmlFor={`${prefix}-headline`}>名片标题（最多 100 字）<input id={`${prefix}-headline`} value={preview.draft.headline} maxLength={100} disabled={Boolean(busy)} placeholder="用一句话说清愿意贡献什么" onChange={event => updateDraft({ headline: event.target.value })} /></label>
          <label className={styles.field} htmlFor={`${prefix}-introduction`}>公开介绍（最多 1600 字，当前 {preview.draft.introduction.length} 字）<textarea id={`${prefix}-introduction`} value={preview.draft.introduction} maxLength={1600} rows={5} disabled={Boolean(busy)} onChange={event => updateDraft({ introduction: event.target.value })} /></label>
          <RecruitingRoleChoices legend="公开的主要职责" values={preview.draft.primaryRoles} disabled={Boolean(busy)} onChange={primaryRoles => updateDraft({ primaryRoles })} />
          <RecruitingRoleChoices legend="公开的辅助职责" values={preview.draft.supportingRoles} disabled={Boolean(busy)} onChange={supportingRoles => updateDraft({ supportingRoles })} />
          <RecruitingPurposeChoices values={preview.draft.purposes} disabled={Boolean(busy)} onChange={purposes => updateDraft({ purposes })} />
          <label className={styles.field} htmlFor={`${prefix}-public-purpose`}>公开的目的补充<input id={`${prefix}-public-purpose`} value={preview.draft.purposeNote} maxLength={240} disabled={Boolean(busy)} onChange={event => updateDraft({ purposeNote: event.target.value })} /></label>
          <div className={styles.twoColumns}><label className={styles.field} htmlFor={`${prefix}-skills`}>愿意展示的技能（每行一项，最多 30 项，每项 80 字）<textarea id={`${prefix}-skills`} value={preview.draft.skills.join("\n")} maxLength={2429} rows={3} disabled={Boolean(busy)} onChange={event => updateDraft({ skills: event.target.value.split("\n") })} /></label><div>
            <label className={styles.field} htmlFor={`${prefix}-city`}>公开城市（可以留空）<input id={`${prefix}-city`} value={preview.draft.city} maxLength={80} disabled={Boolean(busy)} onChange={event => updateDraft({ city: event.target.value })} /></label>
            <label className={styles.field} htmlFor={`${prefix}-hours`}>每天可投入时间（小时，选填）<input id={`${prefix}-hours`} type="number" min={0} max={24} step={0.5} value={preview.draft.availableHoursPerDay ?? ""} disabled={Boolean(busy)} onChange={event => updateDraft({ availableHoursPerDay: event.target.value === "" ? null : Number(event.target.value) })} /></label>
          </div></div>
          <WorkLinksEditor values={preview.draft.workLinks} onChange={workLinks => updateDraft({ workLinks })} disabled={Boolean(busy)} prefix={`${prefix}-public`} />
          <fieldset className={styles.fieldset} disabled={Boolean(busy)}><legend>自愿公开的选填信息</legend><div className={styles.choices}>
            <label className={styles.choice}><input type="checkbox" checked={preview.draft.showMbti} disabled={!view.profile.mbti} onChange={event => updateDraft({ showMbti: event.target.checked })} />公开 MBTI{view.profile.mbti ? `：${view.profile.mbti}` : "（未填写）"}</label>
            <label className={styles.choice}><input type="checkbox" checked={preview.draft.showAge} disabled={view.profile.age === null} onChange={event => updateDraft({ showAge: event.target.checked })} />公开年龄{view.profile.age !== null ? `：${view.profile.age}` : "（未填写）"}</label>
            <label className={styles.choice}><input type="checkbox" checked={preview.draft.showAvatar} disabled={!view.profile.hasAvatar} onChange={event => updateDraft({ showAvatar: event.target.checked })} />公开头像{!view.profile.hasAvatar && "（未上传）"}</label>
          </div></fieldset>
          {preview.draft.showAvatar && view.profile.hasAvatar && <img className={styles.avatar} src={`${client.privateAvatarUrl()}?revision=${preview.avatarRevision}`} alt="将公开的头像预览" width={64} height={64} />}
          <label className={styles.confirmation}><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={event => setConfirmed(event.target.checked)} />我已核对预览，确认把这些内容发布到公开组队大厅。</label>
          <button className={styles.primary} type="button" disabled={Boolean(busy) || !confirmed || dirty || nicknameContainsEmail || !preview.draft.headline.trim() || !preview.draft.introduction.trim() || preview.draft.introduction.length > 1600} onClick={publish}>{busy === "发布名片" ? "正在发布…" : view.card.status === "published" ? "确认更新公开名片" : "确认发布名片"}</button>
        </div>}
      </section>
      <section className={styles.panel}><div className={styles.sectionHeading}><h3>当前公开快照</h3><span className={styles.badge}>{view.card.status === "published" ? "已公开" : view.card.status === "withdrawn" ? "已撤回" : "尚未发布"}</span></div>
        {view.card.status === "published" && view.card.card ? <><h4>{view.card.card.headline}</h4><p className={styles.preWrap}>{view.card.card.introduction}</p><p className={styles.muted}>发布时间：{recruitingDate(view.card.card.publishedAt)} · 版本 {view.card.revision}</p>
          {view.card.card.workLinks.map((link, index) => { const href = recruitingSafeLink(link.url); return href ? <a className={styles.textLink} key={index} href={href} target="_blank" rel="noreferrer noopener">{link.title || "作品链接"} ↗</a> : null; })}
          <div className={styles.actions}><button className={styles.secondary} type="button" disabled={Boolean(busy)} onClick={withdraw}>{busy === "撤回名片" ? "正在撤回…" : "撤回公开名片"}</button></div></> : <p>目前没有公开的名片。私人资料仍可继续填写与保存。</p>}
      </section>
    </>}
  </section>;
}
