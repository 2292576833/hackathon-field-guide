"use client";

import { useState, type FormEvent } from "react";
import { api, dateText, lines, message, useApi } from "../../components/client-api.ts";
import { Field } from "../../components/site-shell.tsx";
import type { CreateApplicationInput, EventTemplate, OrganizationApplication, OrganizationKind } from "./model.ts";
import styles from "./organizer.module.css";

export interface OrganizerEntryProps {
  readonly signedIn: boolean;
  readonly loginHref?: string;
  readonly workspaceHref?: string;
  readonly onApplicationSubmitted?: (application: OrganizationApplication) => void;
}
const STATUS = { pending: "待审核", approved: "已通过", rejected: "请补充后重新申请", suspended: "机构已停用" } as const;
const EMPTY: CreateApplicationInput = { name: "", kind: "school", description: "", contactName: "", contactEmail: "", evidenceText: "", evidenceUrls: [] };
/** 平台能提供的能力与明确不做的范围，避免主办方带着错误预期入驻。 */
const PROVIDED = [
  "发布正式规则与报名表，并按你的设置审核报名",
  "维护赛事队伍名单，向选手发布官方通知与公开问答",
  "行程与现场服务：日程、住宿分配、餐券核销、破冰活动",
  "收取正式作品材料并保留不可变快照与回执",
  "人工指派评委、处理回避、按轮次评分并由你确认公布结果",
] as const;
const NOT_PROVIDED = [
  "不收款、不退款、不开票：费用仍由你在自己的渠道处理",
  "不发送短信，也不接管选手的私人备赛空间与私人 AI 对话",
  "不自动决定录取、晋级或获奖，全部由你确认后发布",
  "不替你在微信、公众号等第三方平台发消息，报名链接由你自行发布",
  "入驻或认领成功不等于赛事质量、招生效果或获奖机会的保证",
] as const;
/** 按机构类型给出可核对的凭证方向，减少来回补充。 */
const CREDENTIALS: Record<OrganizationKind, { label: string; items: readonly string[]; note: string }> = {
  school: {
    label: "学校及校内组织",
    items: ["院系或学校官网的活动公告页", "学校域名邮箱（如 @某校.edu.cn）", "指导教师或主管部门的联系方式"],
    note: "若由学生社团代办，请在依据里说明社团与学校的授权关系。",
  },
  company: {
    label: "企业",
    items: ["企业域名邮箱", "公司盖章的授权或合作文件", "官网赛事页与品牌线说明"],
    note: "同一企业有多场赛事或多个品牌线时，请分别说明各自负责人。",
  },
  community: {
    label: "社区 / 开发者组织",
    items: ["历史活动页或往届赛事记录", "社群公告与既有合作方说明", "可核对的负责人公开联系方式"],
    note: "社区通常没有营业执照，我们以公开活动记录与往期赛事作为核查依据。",
  },
};

export function OrganizerEntry({ signedIn, loginHref = "/login?returnTo=%2Forganizers", workspaceHref = "/organizers/workspace", onApplicationSubmitted }: OrganizerEntryProps) {
  const applications = useApi<OrganizationApplication[]>(signedIn ? "/organizer/applications/mine" : null);
  const templates = useApi<EventTemplate[]>("/organizer/templates");
  const [form, setForm] = useState<CreateApplicationInput>(EMPTY), [evidenceUrls, setEvidenceUrls] = useState("");
  const [editing, setEditing] = useState<OrganizationApplication | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const change = (key: keyof CreateApplicationInput, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const body: CreateApplicationInput = { ...form, evidenceUrls: lines(evidenceUrls) };
      const result = await api<OrganizationApplication>(editing ? `/organizer/applications/${encodeURIComponent(editing.id)}` : "/organizer/applications", {
        method: editing ? "PATCH" : "POST", body: editing ? { ...body, expectedRevision: editing.revision } : body,
      });
      setForm(EMPTY); setEvidenceUrls(""); setEditing(null); setNotice("申请已送交人工审核。你可以在下方查看结果与补充要求。");
      await applications.reload(); onApplicationSubmitted?.(result);
    } catch (reason) { setError(`${message(reason)} 输入已保留；请核对后继续。`); }
    finally { setBusy(false); }
  }
  function supplement(application: OrganizationApplication) {
    setEditing(application); setForm({ name: application.name, kind: application.kind, description: application.description,
      contactName: application.contactName, contactEmail: application.contactEmail, evidenceText: application.evidenceText, evidenceUrls: application.evidenceUrls });
    setEvidenceUrls(application.evidenceUrls.join("\n")); setError(""); setNotice("已载入这份申请。修改后点击“补充并重新送审”。");
  }
  return <section className={styles.surface} aria-label="主办方入驻">
    <div className={`${styles.panel} ${styles.intro}`}><p className={styles.eyebrow}>主办方入驻</p><h2>一个工作台，管理你的组织和比赛</h2>
      <p className={styles.muted}>先提交机构信息，人工审核通过后即可选模板建赛。联系人和证明仅用于入驻审核。</p>
      <ol className={styles.list}><li>填写机构与联系信息</li><li>查看审核结果，需要时补充依据</li><li>选模板创建比赛，预览规则后正式发布</li></ol>
      <details className={styles.details}><summary className={styles.summary}>我们能做什么、不做什么</summary>
        <p className={styles.muted}>先说清边界，省得你带着错误预期入驻。</p>
        <div className={styles.grid}>
          <div className={styles.permissionList}><h4>平台提供</h4><ul className={styles.list}>{PROVIDED.map(item => <li key={item}>{item}</li>)}</ul></div>
          <div className={styles.permissionList}><h4>平台不做</h4><ul className={styles.list}>{NOT_PROVIDED.map(item => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </details>
      {!signedIn && <a className={styles.button} href={loginHref}>登录后申请入驻</a>}
    </div>
    {signedIn && <>
      <section className={styles.panel}><div className={`${styles.row} ${styles.between}`}><h3>我的申请</h3><button type="button" className={styles.secondary} disabled={applications.loading} onClick={() => void applications.reload()}>刷新审核结果</button></div>
        {applications.loading && <p role="status" className={styles.muted}>正在读取申请…</p>}
        {applications.error && <p role="alert" className={styles.error}>{applications.error.message}</p>}
        {applications.data?.length === 0 && <p className={styles.muted}>还没有申请，填写下方表单即可开始。</p>}
        {applications.data?.map(application => <article className={styles.panel} key={application.id}>
          <div className={`${styles.row} ${styles.between}`}><h3>{application.name}</h3><span className={`${styles.badge} ${application.status === "approved" ? styles.active : application.status === "pending" ? styles.warning : styles.unavailable}`}>{STATUS[application.status]}</span></div>
          <p className={styles.muted}>最近更新：{dateText(application.updatedAt)}</p>
          {application.reviewNote && <p className={styles.todo}>审核说明：{application.reviewNote}</p>}
          <div className={styles.actions}>{application.status === "approved" ? <a className={styles.button} href={workspaceHref}>进入主办方工作台</a>
            : ["pending", "rejected"].includes(application.status) ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => supplement(application)}>补充这份申请</button> : <p className={styles.muted}>请根据审核说明联系平台，机构停用期间无法继续运营比赛。</p>}</div>
        </article>)}
      </section>
      <form className={styles.panel} onSubmit={submit}>
        <div className={`${styles.row} ${styles.between}`}><h3>{editing ? `补充申请 · ${editing.name}` : "申请一个组织"}</h3>{editing && <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setEditing(null); setForm(EMPTY); setEvidenceUrls(""); setError(""); setNotice(""); }}>取消补充</button>}</div>
        <div className={styles.grid}><Field label="机构名称" hint="必填。填写实际办赛的学校、公司或社区名称，例如“某大学创新实验室”；不要填写比赛名称。"><input value={form.name} onChange={event => change("name", event.target.value)} maxLength={120} required autoComplete="organization"/></Field>
          <Field label="机构类型" hint="按实际主体选择：学校及校内组织选学校，企业选公司，兴趣社群或开发者组织选社区。"><select value={form.kind} onChange={event => change("kind", event.target.value as OrganizationKind)}><option value="school">学校</option><option value="company">公司</option><option value="community">社区</option></select></Field></div>
        <div className={styles.todo}><strong>这类机构通常需要准备</strong><span>{CREDENTIALS[form.kind].label}</span><ul className={styles.list}>{CREDENTIALS[form.kind].items.map(item => <li key={item}>{item}</li>)}</ul><p className={styles.muted}>{CREDENTIALS[form.kind].note}</p></div>
        <Field label="机构简介" hint="必填。用几句话介绍服务人群和举办的活动，例如“面向学生开展 AI 项目实践，每学期组织开发活动”。"><textarea value={form.description} onChange={event => change("description", event.target.value)} maxLength={2000} required/></Field>
        <div className={styles.grid}><Field label="联系人" hint="必填。填写负责本次入驻、能回答审核问题的联系人姓名或常用称呼。"><input value={form.contactName} onChange={event => change("contactName", event.target.value)} maxLength={80} required autoComplete="name"/></Field>
          <Field label="联系邮箱" hint="必填。填写联系人能正常收信的完整邮箱，例如 contact@example.com；用于入驻联系，不会自动成为通知发信账号。"><input type="email" value={form.contactEmail} onChange={event => change("contactEmail", event.target.value)} maxLength={254} required autoComplete="email"/></Field></div>
        <Field label="活动或授权依据" hint="必填。说明你与机构的关系、办赛授权或以往活动，例如“我是活动负责人，机构介绍页列有我的联系方式”。首版支持文字和公开链接，不需上传证件。"><textarea value={form.evidenceText} onChange={event => change("evidenceText", event.target.value)} maxLength={4000} required/></Field>
        <details className={styles.details}><summary className={styles.summary}>补充证明链接（选填）</summary><Field label="公开 HTTPS 网页" hint="选填。粘贴机构介绍或已办活动的公开 https:// 地址，每行一条，最多 5 条。审核人员应能直接打开；请勿填写密码或私人材料地址。"><textarea value={evidenceUrls} onChange={event => setEvidenceUrls(event.target.value)} placeholder="https://your-organization.org/about"/></Field></details>
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        <div className={styles.actions}><button type="submit" className={styles.button} disabled={busy}>{busy ? "正在送审…" : editing ? "补充并重新送审" : "提交入驻申请"}</button><p className={styles.muted}>审核通过后，下一步是创建比赛。</p></div>
      </form>
    </>}
    <section className={styles.panel}><h3>从常用模板开始</h3><p className={styles.muted}>报名、组队、行程和后勤都有常用默认值，创建时可以调整。</p>
      {templates.loading && <p role="status" className={styles.muted}>正在读取模板…</p>}{templates.error && <p role="alert" className={styles.error}>{templates.error.message}</p>}
      <div className={styles.cards}>{templates.data?.map(template => <article className={styles.panel} key={template.key}><h3>{template.name}</h3><p className={styles.muted}>{template.description}</p><p className={styles.muted}>默认时区：{template.timezone}</p></article>)}</div>
    </section>
  </section>;
}
