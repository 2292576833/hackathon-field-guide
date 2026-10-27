"use client";

import Link from "next/link";
import { useApi } from "./client-api.ts";
import type { EventModuleFlags, EventStaffCapability } from "../shared/organizer-contracts.ts";
import type { EventReadinessItem } from "../modules/organizer/model.ts";
import styles from "./competition-workspace.module.css";

/**
 * 主办方工作台的"现在该做什么"（派生只读，不写入任何状态）。
 *
 * 参照三个站点后收敛成三件事：
 * 1. 像 HackerTrip 的主办方提交那样，把**发布门槛**摊开讲清（缺哪几项、哪几项只有抓取线索），并给出**唯一下一步**；
 * 2. 像 WaytoAGI Events 的"投稿 → 审核 → 上线"那样，把**当前状态**（草稿/已发布/已结束、机构是否暂停、正式规则版本）摆在最上面；
 * 3. 像赛氪的服务端下发选项那样，入口与门槛都由服务端事实决定——这里只显示**你当前身份真的能处理**的部分。
 *
 * 全部数字来自本站已保存的事实（待补清单接口），刷新即重新计算；不新增打勾、进度或第二份完成状态。
 */
export interface OrganizerActionCenterProps {
  eventId: string;
  eventTitle: string;
  organizationName: string;
  status: "draft" | "published" | "ended" | "archived";
  /** 机构是否暂停运营；不传表示这里没有该事实，不做判断。 */
  availability?: "available" | "organization_unavailable";
  publishedRevision: number | null;
  modules: EventModuleFlags;
  capabilities: readonly EventStaffCapability[];
  activeSection?: string;
}

const STATUS_NAMES: Record<OrganizerActionCenterProps["status"], string> = { draft: "草稿（选手看不到）", published: "已发布（选手可见）", ended: "比赛已结束", archived: "已归档" };
const SECTION_NAMES: Record<string, { label: string; capability: EventStaffCapability; enabled: (modules: EventModuleFlags) => boolean }> = {
  registration: { label: "报名审核", capability: "registration_manage", enabled: modules => modules.registration },
  teams: { label: "队伍管理", capability: "teams_manage", enabled: modules => modules.teams },
  communication: { label: "通知与答疑", capability: "communication_manage", enabled: () => true },
  schedule: { label: "行程管理", capability: "schedule_manage", enabled: modules => modules.schedule },
  services: { label: "现场服务", capability: "logistics_manage", enabled: modules => modules.accommodation || modules.mealVouchers || modules.icebreaking },
  judging: { label: "收件与评审", capability: "judging_manage", enabled: modules => modules.judging },
};
/** 门槛里的字段名。与 organizer/model.ts 的 READINESS_FIELDS 同名，缺失即"未确认"。 */
const FIELD_NAMES: Record<string, string> = { registrationOpensAt: "报名开始时间", registrationClosesAt: "报名截止时间", startsAt: "开赛时间", endsAt: "结束时间",
  timezone: "比赛时区", tracks: "官方赛道 / 赛题方向", requiredMaterials: "必交材料", submissionMethod: "作品提交方式",
  resultsAt: "结果公布时间", fee: "费用", eligibility: "参赛资格", aiPolicy: "AI 使用规则" };
const TIME_FIELDS = new Set(["registrationOpensAt", "registrationClosesAt", "startsAt", "endsAt", "timezone"]);

export function OrganizerActionCenter(props: OrganizerActionCenterProps) {
  const readiness = useApi<EventReadinessItem[]>(`/organizer/events/${encodeURIComponent(props.eventId)}/readiness`);
  const canSeeRegistration = props.capabilities.includes("registration_manage") && props.modules.registration;
  // 精确计数由服务端算（列表接口是分页且没有总数，不能用第一页冒充总数）；请求失败就不显示数字。
  const counts = useApi<{ pending: number; reserved: number }>(canSeeRegistration ? `/organizer/events/${encodeURIComponent(props.eventId)}/registration-counts` : null);
  const pending = counts.data?.pending ?? null;
  const settingsHref = `/organizers/workspace/${encodeURIComponent(props.eventId)}/settings`;
  const registrationHref = `/organizers/workspace/${encodeURIComponent(props.eventId)}/registration`;
  const ready = readiness.data ?? [];
  const missing = ready.filter(item => item.state === "missing");
  const conflicting = ready.filter(item => item.state === "conflicting");
  const hintOnly = ready.filter(item => item.state === "known_from_source");
  const canManage = (Object.keys(SECTION_NAMES) as (keyof typeof SECTION_NAMES)[]).filter(key => props.capabilities.includes(SECTION_NAMES[key]!.capability) && SECTION_NAMES[key]!.enabled(props.modules));
  const sections = canManage.map(key => SECTION_NAMES[key]!.label).join("、");

  let next: { title: string; detail: string; href: string; action: string };
  if (props.availability === "organization_unavailable") next = { title: "先处理机构状态", detail: "本站显示机构当前暂停运营：新报名与相关操作已暂停。先核对机构审核状态，再继续本场比赛的运营。", href: "/organizers/workspace", action: "查看机构与比赛设置" };
  else if (props.status === "draft" && (missing.length || conflicting.length)) next = { title: `还有 ${missing.length + conflicting.length} 项信息需要你们确认`, detail: "选手在比赛页看到的是你们确认过的信息；现在这几项还没有权威答案，先补完再发布，避免选手按错误信息准备。", href: settingsHref, action: "去补赛事信息" };
  else if (props.status === "draft") next = { title: "可以预览并发布了", detail: "关键信息已经齐了。预览选手看到的样子，确认无误后正式发布；发布后选手即可报名。", href: settingsHref, action: "预览并发布" };
  else if (props.status === "published") next = { title: pending !== null && pending > 0 ? `有 ${pending} 条报名等待审核` : "照看正在进行的事项", detail: `比赛已发布（正式规则 v${props.publishedRevision ?? 1}）。${pending !== null && pending > 0 ? `先处理待审核的报名（共 ${pending} 条），` : ""}按你的身份，可以处理：${sections || "当前没有可操作的模块"}。`, href: canSeeRegistration && pending !== null && pending > 0 ? registrationHref : settingsHref, action: pending !== null && pending > 0 ? "去处理报名" : "回到比赛设置" };
  else next = { title: "本场已结束", detail: "选手侧的规则、结果与回执仍然可查；需要归档或复用资料时按公开规则处理。", href: settingsHref, action: "查看比赛设置" };

  return <section className={styles.nextStep} aria-label="本场状态与下一步">
    <div className={styles.actions}>
      <span className={styles.eyebrow}>现在该做什么</span>
      <span className={styles.badge}>{STATUS_NAMES[props.status]}</span>
      <span className={styles.badge}>正式规则 v{props.publishedRevision}</span>
      {props.availability === "organization_unavailable" && <span className={styles.badge}>机构暂停运营</span>}
    </div>
    <h2>{next.title}</h2>
    <p>{next.detail}</p>
    <div className={styles.actions}><Link className={styles.primary} href={next.href}>{next.action}</Link>{props.status === "published" && <Link className={styles.secondary} href={`/competitions/${encodeURIComponent(props.eventId)}`}>看选手现在看到的样子</Link>}</div>

  </section>;
}

export interface OrganizerPublishGateProps {
  eventId: string;
  status: "draft" | "published" | "ended" | "archived";
}

/**
 * 发布门槛清单（派生只读）。
 *
 * 按工作台设计 §6.1 的裁决：门槛属于"改配置"，只在比赛设置页出现一次，
 * 不再随每个 section 页重复挂载；判定与文案与改造前完全一致，只换了落点。
 * 清单只说明"有没有权威答案"，不产生完成度、不打勾、不写入任何状态。
 */
export function OrganizerPublishGate({ eventId, status }: OrganizerPublishGateProps) {
  const readiness = useApi<EventReadinessItem[]>(`/organizer/events/${encodeURIComponent(eventId)}/readiness`);
  const ready = readiness.data ?? [];
  const missing = ready.filter(item => item.state === "missing");
  const conflicting = ready.filter(item => item.state === "conflicting");
  const hintOnly = ready.filter(item => item.state === "known_from_source");
  return <details className={styles.details} open={status === "draft" && Boolean(missing.length || conflicting.length)}>
    <summary>发布门槛清单（{missing.length ? `${missing.length} 项没有信息` : "关键信息已齐"}）</summary>
    <p className={styles.muted}>清单只提示"有没有权威答案"，不代表任何完成度，也不会打勾。带「仅有抓取线索」的项表示我们抓到了原文但你们还没确认。</p>
    {readiness.loading && <p role="status">正在读取赛事信息清单…</p>}
    {readiness.error && <p role="alert">{readiness.error.message}</p>}
    {readiness.data && <>
      {!missing.length && !conflicting.length && <p role="status">关键信息都已由主办方确认，可以按上面的下一步继续。</p>}
      {!!conflicting.length && <ul>{conflicting.map(item => <li key={item.field}><span className={styles.badge}>两侧不一致</span> {FIELD_NAMES[item.field] ?? item.field}：我们抓到的线索与你们的设置不一致，需要你们判断以哪个为准。
        {item.sourceUrl && <> 线索来源：<a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">原文 ↗</a></>}</li>)}</ul>}
      {!!missing.length && <ul>{missing.map(item => <li key={item.field}><span className={styles.badge}>需要确认</span> {FIELD_NAMES[item.field] ?? item.field}{TIME_FIELDS.has(item.field) ? "（在比赛设置里改，避免出现两份时间）" : "（在比赛设置的赛事补充资料里填写）"}</li>)}</ul>}
      {!!hintOnly.length && <p className={styles.muted}>另有 {hintOnly.length} 项只有抓取线索、你们尚未确认：{hintOnly.map(item => FIELD_NAMES[item.field] ?? item.field).join("、")}。</p>}
    </>}
  </details>;
}