"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, message, useApi } from "../../components/client-api.ts";
import { Field } from "../../components/site-shell.tsx";
import { DEFAULT_EVENT_COMMUNITY, EVENT_MODULES, EVENT_STAFF_CAPABILITIES } from "../../shared/organizer-contracts.ts";
import type { EventCommunityConfig, EventModuleFlags, EventModuleKey, EventStaffCapability } from "../../shared/organizer-contracts.ts";
import type { CompetitionIdentity, CreateEventInput, EventConfigurationInput, EventPreview, EventTemplate, EventTemplateKey, GrantStaffInput, HostedEvent, Organization, PublicCompetition, StaffGrant, UpdateEventInput } from "./model.ts";
import { competitionDate, competitionModuleLabels } from "./CompetitionOverview.tsx";
import { EventReadinessPanel } from "./EventReadiness.tsx";
import { OrganizerActionCenter } from "../../components/organizer-action-center.tsx";
import { duplicateComparison, duplicateSourceHint } from "./duplicate.ts";
import type { DuplicateEventResult } from "./service.ts";
import styles from "./organizer.module.css";

export interface OrganizerWorkspaceProps {
  readonly currentUserId: string;
  readonly initialOrganizationId?: string;
  readonly initialEventId?: string;
  readonly entryHref?: string;
  readonly publicEventHref?: (eventId: string) => string;
  readonly moduleLinks?: (event: HostedEvent) => Partial<Record<EventModuleKey, string>>;
  readonly staffAccounts?: readonly { readonly userId: string; readonly label: string }[];
  readonly onEventSaved?: (event: HostedEvent) => void;
  readonly onEventSelected?: (event: HostedEvent | null) => void;
  readonly renderOrganizationSettings?: (organization: Organization) => ReactNode;
  /**
   * 工作台设计 §10 步骤 2：提供后，切换"当前比赛"到一场**既有**比赛会直接跳到该场的设置页，
   * 而不是在本页内联渲染配置表单。这样配置只有一个落点（设置页），列表页只负责选与创建。
   */
  readonly eventSelectionHref?: (eventId: string) => string;
}
interface EventDraft {
  baseEvent: HostedEvent | null;
  templateKey: EventTemplateKey;
  title: string; summary: string; rules: string; location: string; timezone: string;
  startsAt: string; endsAt: string; registrationOpensAt: string; registrationClosesAt: string; submissionClosesAt: string;
  modules: EventModuleFlags; reviewRequired: boolean; capacity: string;
  teamMode: "free" | "assigned" | "mixed"; teamMin: string; teamMax: string; teamLocksAt: string;
  community: EventCommunityConfig;
}
interface SavedDraft { value: EventDraft; baseline: string }
interface Destination { organizationId: string; eventId: string | null }
const CAPABILITY_LABELS: Record<EventStaffCapability, string> = { event_manage: "比赛规则与发布", registration_manage: "报名审核", teams_manage: "队伍管理", communication_manage: "公告与沟通", schedule_manage: "比赛行程", logistics_manage: "住宿与餐券", judging_manage: "评审管理" };
const CAPABILITY_HELP: Record<EventStaffCapability, string> = { event_manage: "可编辑配置、发布规则、结束或归档比赛。", registration_manage: "可设置报名表、查看答卷、审核及导出报名。", teams_manage: "可查看正式名单、建议分组及重开锁定队伍。", communication_manage: "可发布官方公告，读取并回复本场私人求助。", schedule_manage: "可编辑、导入和发布本场行程。", logistics_manage: "可读取并分配住宿、发放和核销餐券、安排破冰。", judging_manage: "可配置评审、指派评委、人工公布结果；不自动成为评委。" };
const MODULE_HELP: Record<EventModuleKey, string> = { registration: "选手在本站填写资料并报名，可选择人工审核。", teams: "通过报名的选手可建立正式队伍；需同时启用报名。", icebreaking: "安排自愿破冰活动并记录参加及分组。", judging: "正式收作品、指派评委和公布人工评分；需报名及组队。", schedule: "发布时间、地点及适用人员的活动行程。", accommodation: "仅线下使用，向本人分配酒店或宿舍安排。", mealVouchers: "仅线下使用，发餐券并记录领取和核销。" };
const STATUS_LABELS = { draft: "草稿", published: "已发布", ended: "已结束", archived: "已归档" } as const;
const CHANGED_FIELDS: Record<string, string> = { title: "比赛名称", timezone: "时区", startsAt: "比赛开始", endsAt: "比赛结束", registrationOpensAt: "报名开始", registrationClosesAt: "报名截止", submissionClosesAt: "作品截止", modules: "开放功能", registration: "报名设置", teams: "组队设置", summary: "比赛简介", rules: "公开规则", location: "参与地点" };

function inputTime(instant: string | null, timezone: string): string {
  if (!instant) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
function instantTime(value: string, timezone: string, required = false): string | null {
  if (!value && !required) return null;
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }); } catch { throw new Error("请选择有效的比赛时区，例如 Asia/Shanghai。"); }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("请填写完整的日期和时间。");
  const [year, month, day, hour, minute] = value.match(/\d+/g)!.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = wall;
  for (let attempt = 0; attempt < 4; attempt++) {
    const represented = inputTime(new Date(candidate).toISOString(), timezone);
    if (represented === value) return new Date(candidate).toISOString();
    const digits = represented.match(/\d+/g)!.map(Number);
    candidate += wall - Date.UTC(digits[0], digits[1] - 1, digits[2], digits[3], digits[4]);
  }
  throw new Error("所填时间在此时区不存在，可能遇到夏令时切换，请调整时间。");
}
function fingerprint(draft: EventDraft) { const { baseEvent: _base, ...fields } = draft; return JSON.stringify(fields); }
function fromEvent(event: HostedEvent): EventDraft {
  return { baseEvent: event, templateKey: event.templateKey, title: event.title, summary: event.summary, rules: event.rules, location: event.location, timezone: event.timezone,
    startsAt: inputTime(event.startsAt, event.timezone), endsAt: inputTime(event.endsAt, event.timezone), registrationOpensAt: inputTime(event.registrationOpensAt, event.timezone),
    registrationClosesAt: inputTime(event.registrationClosesAt, event.timezone), submissionClosesAt: inputTime(event.submissionClosesAt, event.timezone),
    modules: { ...event.modules }, reviewRequired: event.registration.reviewRequired, capacity: event.registration.capacity?.toString() ?? "",
    teamMode: event.teams.mode, teamMin: String(event.teams.minSize), teamMax: String(event.teams.maxSize), teamLocksAt: inputTime(event.teams.locksAt, event.timezone), community: { ...(event.community ?? DEFAULT_EVENT_COMMUNITY) } };
}
function newDraft(template: EventTemplate): EventDraft {
  const start = new Date(Date.now() + 7 * 86400000).toISOString(), end = new Date(Date.parse(start) + 2 * 86400000).toISOString();
  return { baseEvent: null, templateKey: template.key, title: "", summary: "", rules: "", location: "", timezone: template.timezone,
    startsAt: inputTime(start, template.timezone), endsAt: inputTime(end, template.timezone), registrationOpensAt: inputTime(new Date().toISOString(), template.timezone),
    registrationClosesAt: inputTime(start, template.timezone), submissionClosesAt: inputTime(end, template.timezone), modules: { ...template.modules },
    reviewRequired: template.registration.reviewRequired, capacity: template.registration.capacity?.toString() ?? "", teamMode: template.teams.mode,
    teamMin: String(template.teams.minSize), teamMax: String(template.teams.maxSize), teamLocksAt: inputTime(template.teams.locksAt, template.timezone), community: { ...DEFAULT_EVENT_COMMUNITY } };
}
function configuration(draft: EventDraft): EventConfigurationInput {
  return { title: draft.title, timezone: draft.timezone, startsAt: instantTime(draft.startsAt, draft.timezone, true)!, endsAt: instantTime(draft.endsAt, draft.timezone, true)!,
    registrationOpensAt: instantTime(draft.registrationOpensAt, draft.timezone), registrationClosesAt: instantTime(draft.registrationClosesAt, draft.timezone), submissionClosesAt: instantTime(draft.submissionClosesAt, draft.timezone),
    modules: draft.modules, registration: { reviewRequired: draft.reviewRequired, capacity: draft.capacity.trim() ? Number(draft.capacity) : null },
    teams: { mode: draft.teamMode, minSize: Number(draft.teamMin), maxSize: Number(draft.teamMax), locksAt: instantTime(draft.teamLocksAt, draft.timezone) }, community: draft.community, summary: draft.summary, rules: draft.rules, location: draft.location };
}

export function OrganizerWorkspace({ currentUserId, initialOrganizationId, initialEventId, entryHref = "/organizers", publicEventHref = id => `/competitions/${encodeURIComponent(id)}`, moduleLinks, staffAccounts = [], onEventSaved, onEventSelected, renderOrganizationSettings, eventSelectionHref }: OrganizerWorkspaceProps) {
  const organizations = useApi<Organization[]>("/organizer/organizations"), templates = useApi<EventTemplate[]>("/organizer/templates"), identities = useApi<CompetitionIdentity[]>("/me/competition-identities");
  const [organizationId, setOrganizationId] = useState(initialOrganizationId ?? ""), [eventId, setEventId] = useState<string | null>(initialEventId ?? null);
  const events = useApi<HostedEvent[]>(organizationId ? `/organizer/organizations/${encodeURIComponent(organizationId)}/events` : null);
  const event = useApi<HostedEvent>(eventId && eventId !== "new" ? `/organizer/events/${encodeURIComponent(eventId)}` : null);
  useEffect(() => {
    onEventSelected?.(!event.error && event.data?.eventId === eventId ? event.data : null);
  }, [event.data, event.error, eventId, onEventSelected]);
  const grants = useApi<StaffGrant[]>(organizationId ? `/organizer/organizations/${encodeURIComponent(organizationId)}/staff-grants` : null);
  const [drafts, setDrafts] = useState<Record<string, SavedDraft>>({}), [pendingSwitch, setPendingSwitch] = useState<Destination | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<EventPreview | null>(null), [changeSummary, setChangeSummary] = useState(""), [archiveConfirmed, setArchiveConfirmed] = useState(false), [endConfirmed, setEndConfirmed] = useState(false);
  const [serverLatest, setServerLatest] = useState<HostedEvent | null>(null), [responsibleUserId, setResponsibleUserId] = useState("");
  const timezoneListId = useId();
  const organization = organizations.data?.find(item => item.id === organizationId) ?? null;
  const organizationEvents = events.data?.filter(item => item.organizationId === organizationId) ?? [];
  const organizationGrants = grants.data?.filter(item => item.organizationId === organizationId) ?? [];
  const key = eventId === "new" ? `new:${organizationId}` : eventId;
  const candidate = key ? drafts[key] : undefined;
  const record = candidate && (!candidate.value.baseEvent || candidate.value.baseEvent.organizationId === organizationId) ? candidate : undefined, draft = record?.value;
  const publicVersion = useApi<PublicCompetition>(draft?.baseEvent?.publishedRevision ? `/competitions/${encodeURIComponent(draft.baseEvent.eventId)}` : null);
  const dirty = Boolean(draft && (!draft.baseEvent || fingerprint(draft) !== record?.baseline));
  const hasUnsavedDrafts = Object.values(drafts).some(item => !item.value.baseEvent || fingerprint(item.value) !== item.baseline);
  const currentIdentity = identities.data?.find(item => item.event.eventId === eventId);
  const organizationAdmin = Boolean(organizationGrants.some(grant => grant.userId === currentUserId && grant.role === "organization_admin" && grant.eventId === null && grant.status === "active") || identities.data?.some(identity => identity.organizationAdmin && identity.event.organizationId === organizationId));
  const canManage = organization?.status === "approved" && (organizationAdmin || Boolean(currentIdentity?.capabilities.includes("event_manage")));
  const writable = canManage && draft?.baseEvent?.status !== "archived" && draft?.baseEvent?.status !== "ended";
  const format = draft?.baseEvent?.format ?? templates.data?.find(template => template.key === draft?.templateKey)?.format;
  const publishedModules = publicVersion.data?.eventId === draft?.baseEvent?.eventId ? publicVersion.data?.modules : draft?.baseEvent?.modules;
  const eligibleResponsibles = [...new Set(organizationGrants.filter(grant => grant.status === "active" && (grant.eventId === null || grant.eventId === eventId) && (grant.role === "organization_admin" || grant.capabilities.includes("event_manage"))).map(grant => grant.userId))];

  // 规划33 P05：可复制的来源只列本机构自己的比赛；非组织管理员不发起该请求。
  const duplicateSources = useApi<HostedEvent[]>(organizationId && organizationAdmin ? `/organizer/organizations/${encodeURIComponent(organizationId)}/duplicate-sources` : null);
  const [duplicateSourceId, setDuplicateSourceId] = useState(""), [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateIncludeForm, setDuplicateIncludeForm] = useState(true), [duplicateIncludeJudging, setDuplicateIncludeJudging] = useState(true);
  const duplicateSource = duplicateSources.data?.find(item => item.eventId === duplicateSourceId) ?? null;
  const duplicatePlan = duplicateSource ? duplicateComparison(duplicateSource, { includeRegistrationForm: duplicateIncludeForm, includeJudgingConfig: duplicateIncludeJudging }) : null;
  useEffect(() => {
    if (!organizations.data?.length || organizationId) return;
    const selected = identities.data?.find(identity => identity.event.eventId === initialEventId)?.event.organizationId;
    setOrganizationId(selected ?? organizations.data[0].id);
  }, [organizations.data, organizationId, initialEventId, identities.data]);
  useEffect(() => {
    if (!event.data || event.data.eventId !== eventId) return;
    if (event.data.organizationId !== organizationId) setOrganizationId(event.data.organizationId);
    const value = fromEvent(event.data);
    setDrafts(previous => previous[event.data!.eventId] ? previous : { ...previous, [event.data!.eventId]: { value, baseline: fingerprint(value) } });
  }, [event.data, eventId, initialEventId, initialOrganizationId, organizationId]);
  const currentFingerprint = draft ? fingerprint(draft) : "";
  useEffect(() => { setPreview(null); setServerLatest(null); setArchiveConfirmed(false); setEndConfirmed(false); setChangeSummary(""); }, [key]);
  useEffect(() => { setPreview(null); }, [currentFingerprint]);
  useEffect(() => { setResponsibleUserId(draft?.baseEvent?.responsibleUserId ?? ""); }, [key, draft?.baseEvent?.responsibleUserId]);
  useEffect(() => {
    if (!(event.error instanceof ApiError) || ![401, 403, 404].includes(event.error.status) || !eventId || eventId === "new") return;
    setDrafts(previous => { const next = { ...previous }; delete next[eventId]; return next; }); setPreview(null); setServerLatest(null);
  }, [event.error, eventId]);
  useEffect(() => {
    const clear = () => { setDrafts({}); setPreview(null); setServerLatest(null); setPendingSwitch(null); setChangeSummary(""); };
    window.addEventListener("hackathon:unauthenticated", clear); return () => window.removeEventListener("hackathon:unauthenticated", clear);
  }, []);
  useEffect(() => {
    if (!hasUnsavedDrafts) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasUnsavedDrafts]);
  function update<K extends keyof EventDraft>(field: K, value: EventDraft[K]) {
    if (!key || !record) return;
    setDrafts(previous => ({ ...previous, [key]: { ...previous[key], value: { ...previous[key].value, [field]: value } } }));
    setNotice("");
  }
  /** 只改社区配置的某一项；其余字段保持不变。 */
  function setCommunity(patch: Partial<EventCommunityConfig>) {
    if (!draft) return;
    update("community", { ...draft.community, ...patch });
  }
  function go(destination: Destination) {
    // 既有比赛一律到它的设置页继续编辑；只有创建新比赛（eventId === "new"）在本页内联完成。
    if (eventSelectionHref && destination.eventId && destination.eventId !== "new") { window.location.assign(eventSelectionHref(destination.eventId)); return; }
    setOrganizationId(destination.organizationId); setEventId(destination.eventId); setPendingSwitch(null); setError(""); setNotice("");
  }
  function requestSwitch(destination: Destination) {
    if (busy || (destination.organizationId === organizationId && destination.eventId === eventId)) return;
    if (dirty) setPendingSwitch(destination); else go(destination);
  }
  function switchDraft(keep: boolean) {
    if (!pendingSwitch) return;
    if (!keep && key) setDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
    go(pendingSwitch);
  }
  function create() {
    const template = templates.data?.[0]; if (!organization || !template || !organizationAdmin) return;
    const target = `new:${organization.id}`;
    if (!drafts[target]) { const value = newDraft(template); setDrafts(previous => ({ ...previous, [target]: { value, baseline: fingerprint(value) } })); }
    requestSwitch({ organizationId: organization.id, eventId: "new" });
  }
  /**
   * P05：以同一机构的一场既有比赛为起点创建新**草稿**。
   * 走既有 `POST organizer/events/:id/duplicate`（内部仍只经 createEventIn 这一条写路径），
   * 不发布、不改动来源；来源未配置的项由服务端在 `skipped` 里如实返回，不假装复制成功。
   */
  async function duplicateFromSource() {
    const source = duplicateSource;
    if (!source || !organization || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<DuplicateEventResult>(`/organizer/events/${encodeURIComponent(source.eventId)}/duplicate`, { method: "POST", body: { includeRegistrationForm: duplicateIncludeForm, includeJudgingConfig: duplicateIncludeJudging, expectedOrganizationRevision: organization.revision } });
      const skipped = Object.values(result.skipped ?? {});
      await accepted(result.event, `已按「${source.title}」创建草稿「${result.event.title}」。${skipped.length ? `以下内容未复制：${skipped.join("；")}` : "报名表与评审配置已一并复制为草稿，发布前请逐项核对。"}`);
      setDuplicateOpen(false); setDuplicateSourceId("");
    } catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }
  function chooseTemplate(template: EventTemplate) {
    if (!key || !record || draft?.baseEvent) return;
    setDrafts(previous => ({ ...previous, [key]: { ...previous[key], value: { ...previous[key].value, templateKey: template.key, modules: { ...template.modules }, reviewRequired: template.registration.reviewRequired,
      capacity: template.registration.capacity?.toString() ?? "", teamMode: template.teams.mode, teamMin: String(template.teams.minSize), teamMax: String(template.teams.maxSize) } } }));
  }
  function toggleModule(module: EventModuleKey, enabled: boolean) {
    if (!draft) return;
    const modules = { ...draft.modules, [module]: enabled };
    if (module === "registration" && !enabled) { modules.teams = false; modules.judging = false; modules.icebreaking = false; modules.accommodation = false; modules.mealVouchers = false; }
    if (module === "teams") { if (enabled) modules.registration = true; else modules.judging = false; }
    if (module === "judging" && enabled) { modules.registration = true; modules.teams = true; }
    if (["icebreaking", "accommodation", "mealVouchers"].includes(module) && enabled) modules.registration = true;
    update("modules", modules);
  }
  async function accepted(next: HostedEvent, actionNotice: string) {
    const value = fromEvent(next);
    setDrafts(previous => { const updated = { ...previous, [next.eventId]: { value, baseline: fingerprint(value) } }; if (key === `new:${next.organizationId}`) delete updated[key]; return updated; });
    setEventId(next.eventId); event.setData(next); setPreview(null); setServerLatest(null); setNotice(actionNotice);
    await Promise.all([events.reload(), identities.reload(), organizations.reload(), publicVersion.reload()]); onEventSaved?.(next);
  }
  async function recover(reason: unknown) {
    setError(`${message(reason)} 当前输入已保留。`);
    if (reason instanceof ApiError && reason.status === 409 && draft?.baseEvent) {
      try { setServerLatest(await api<HostedEvent>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}`)); }
      catch { /* Keep the current draft if latest permissions or transport no longer allow a read. */ }
    }
    if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { await Promise.all([organizations.reload(), identities.reload(), grants.reload(), event.reload()]); }
  }
  async function save(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault(); if (!draft || !organization || !writable) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const fields = configuration(draft);
      const next = draft.baseEvent ? await api<HostedEvent>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}`, { method: "PATCH", body: { ...fields, expectedRevision: draft.baseEvent.revision } satisfies UpdateEventInput })
        : await api<HostedEvent>(`/organizer/organizations/${encodeURIComponent(organization.id)}/events`, { method: "POST", body: { ...fields, templateKey: draft.templateKey, expectedOrganizationRevision: organization.revision } satisfies CreateEventInput });
      await accepted(next, "草稿已保存。下一步：预览公开规则，再填写发布说明并发布。");
    } catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }
  async function preparePreview() {
    if (!draft?.baseEvent || dirty || !canManage) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await api<EventPreview>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}/preview`); if (result.event.revision !== draft.baseEvent.revision) { setServerLatest(result.event); setError("比赛配置已被其他工作人员更新。当前输入已保留，请核对最新版本后继续。"); setPreview(null); } else setPreview(result); }
    catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }
  async function publish(publishEvent: FormEvent<HTMLFormElement>) {
    publishEvent.preventDefault(); if (!preview || !draft?.baseEvent || dirty || preview.event.revision !== draft.baseEvent.revision || !writable) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api<HostedEvent>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}/publish`, { method: "POST", body: { expectedRevision: preview.event.revision, changeSummary } }); await accepted(next, `正式规则 v${next.publishedRevision} 已发布。选手将看到本次发布的规则与期限。`); setChangeSummary(""); }
    catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!draft?.baseEvent || !archiveConfirmed || dirty || !canManage) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api<HostedEvent>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}/archive`, { method: "POST", body: { expectedRevision: draft.baseEvent.revision } }); await accepted(next, "比赛已归档，已有规则与历史记录保留。"); }
    catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }
  async function changeResponsible(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault(); if (!draft?.baseEvent || !organizationAdmin || dirty || !writable) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api<HostedEvent>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}/responsible`, { method: "POST", body: { expectedRevision: draft.baseEvent.revision, responsibleUserId } }); await accepted(next, "赛事负责人已更新，其他比赛的负责人不受影响。"); }
    catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }
  async function endCompetition() {
    if (!draft?.baseEvent || draft.baseEvent.status !== "published" || !endConfirmed || dirty || !canManage) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api<HostedEvent>(`/organizer/events/${encodeURIComponent(draft.baseEvent.eventId)}/end`, { method: "POST", body: { expectedRevision: draft.baseEvent.revision } }); await accepted(next, "比赛已标记结束，正式规则与已有记录保留。"); }
    catch (reason) { await recover(reason); }
    finally { setBusy(false); }
  }

  return <section className={styles.surface} aria-label="主办方赛事工作台">
    <header className={styles.identity}><div className={`${styles.row} ${styles.between}`}><div className={styles.stack}><p className={styles.eyebrow}>主办方工作台 · {organization?.name ?? "选择组织"}</p><h2>{draft?.title || (eventId === "new" ? "新比赛草稿" : "选择一场比赛")}</h2></div>{draft?.baseEvent && <span className={styles.badge}>{STATUS_LABELS[draft.baseEvent.status]}{draft.baseEvent.publishedRevision ? ` · 规则 v${draft.baseEvent.publishedRevision}` : ""}</span>}</div>
      <div className={styles.grid}><Field label="当前组织" hint="选择本次办赛的机构。下方比赛、工作人员和发信设置均属于这个机构；切换前请保存修改。"><select value={organizationId} disabled={busy || organizations.loading} onChange={change => requestSwitch({ organizationId: change.target.value, eventId: null })}><option value="" disabled>选择组织</option>{organizations.data?.map(item => <option key={item.id} value={item.id}>{item.name}{item.status === "approved" ? "" : "（运营暂停）"}</option>)}</select></Field>
        <Field label="当前比赛" hint="选择要运营的那一场比赛，先核对名称和状态；创建新比赛可用旁边的创建入口。"><select value={eventId ?? ""} disabled={busy || !organizationId || events.loading} onChange={change => requestSwitch({ organizationId, eventId: change.target.value || null })}><option value="">选择比赛</option>{eventId === "new" && <option value="new">新比赛草稿</option>}{organizationEvents.map(item => <option key={item.eventId} value={item.eventId}>{item.title} · {STATUS_LABELS[item.status]}{drafts[item.eventId] && fingerprint(drafts[item.eventId].value) !== drafts[item.eventId].baseline ? "（未保存）" : ""}</option>)}</select></Field></div>
      <div className={styles.actions}>{organizationAdmin && organization?.status === "approved" && <button type="button" className={styles.secondary} disabled={busy || templates.loading || !templates.data?.length} onClick={create}>{drafts[`new:${organizationId}`] ? "继续新比赛草稿" : "创建比赛"}</button>}{draft?.baseEvent?.publishedRevision && <a className={styles.link} href={publicEventHref(draft.baseEvent.eventId)}>查看选手看到的正式规则</a>}</div>
    </header>
    {draft?.baseEvent && <OrganizerActionCenter eventId={draft.baseEvent.eventId} eventTitle={draft.baseEvent.title} organizationName={draft.baseEvent.organizationName}
      status={draft.baseEvent.status} availability={organization?.status === "approved" ? "available" : "organization_unavailable"} publishedRevision={draft.baseEvent.publishedRevision}
      modules={draft.baseEvent.modules} capabilities={identities.data?.find(identity => identity.event.eventId === draft.baseEvent!.eventId)?.capabilities ?? []}/>}
    {pendingSwitch && <div role="alert" className={styles.todo}><p>当前比赛有未保存内容。保留后可以切回继续，离开本页时本地草稿不会自动保存。</p><div className={styles.actions}><button type="button" className={styles.button} onClick={() => switchDraft(true)}>保留草稿并切换</button><button type="button" className={styles.danger} onClick={() => switchDraft(false)}>放弃草稿并切换</button><button type="button" className={styles.secondary} onClick={() => setPendingSwitch(null)}>继续编辑当前比赛</button></div></div>}
    {organizations.loading && <p role="status" className={styles.muted}>正在读取你的组织…</p>}
    {organizations.error && <p role="alert" className={styles.error}>{organizations.error.message}</p>}
    {organizations.data?.length === 0 && <div className={styles.panel}><h3>先申请组织入驻</h3><p className={styles.muted}>审核通过后，你可以在这里创建和管理多场比赛。</p><a className={styles.button} href={entryHref}>填写入驻申请</a></div>}
    {organization && organization.status !== "approved" && <p role="status" className={styles.error}>当前组织未处于可运营状态，请查看入驻审核说明。已有规则和参赛记录仍保留。</p>}
    {events.error && <p role="alert" className={styles.error}>{events.error.message}</p>}
    {templates.error && <p role="alert" className={styles.error}>{templates.error.message}</p>}
    {identities.error && <p role="alert" className={styles.error}>{identities.error.message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {event.error && <p role="alert" className={styles.error}>{event.error.message}</p>}
    {event.loading && !draft && <p role="status" className={styles.muted}>正在读取比赛配置…</p>}
    {serverLatest && draft?.baseEvent && <details className={styles.details} open><summary className={styles.summary}>核对服务器最新版本（当前输入仍保留）</summary><div className={styles.stack}><p>当前输入基于版本 {draft.baseEvent.revision}，服务器为版本 {serverLatest.revision}。</p><p className={styles.rules}>最新名称：{serverLatest.title}\n最新简介：{serverLatest.summary}\n最新规则：{serverLatest.rules}</p><p className={styles.muted}>最新开赛：{competitionDate(serverLatest.startsAt, serverLatest.timezone)}；最新报名截止：{competitionDate(serverLatest.registrationClosesAt, serverLatest.timezone)}；最新作品截止：{competitionDate(serverLatest.submissionClosesAt, serverLatest.timezone)}。时区：{serverLatest.timezone}</p><div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => { if (!key) return; const latest = fromEvent(serverLatest); setDrafts(previous => ({ ...previous, [key]: { value: latest, baseline: fingerprint(latest) } })); event.setData(serverLatest); setServerLatest(null); setError(""); }}>放弃当前输入，载入最新版本</button></div><p className={styles.muted}>如需保留你的改动，请先复制要保留的文字，再载入最新版本后重新填写。页面不会自动覆盖别人的更新。</p></div></details>}
    {!eventId && organization?.status === "approved" && <section className={styles.panel}><h3>下一步：选择或创建一场比赛</h3><p className={styles.muted}>{events.data?.length ? "选择上方比赛，查看规则、期限与开放功能。" : "这个组织还没有比赛。组织管理员可以从常用模板创建第一场。"}</p>{!organizationAdmin && <p className={styles.muted}>工作人员只能管理已授予范围的比赛；创建比赛请联系组织管理员。</p>}</section>}
    {draft?.baseEvent && canManage && <details className={styles.details}><summary className={styles.summary}>待补赛事信息（我们还没确认的部分）</summary><EventReadinessPanel eventId={draft.baseEvent.eventId}/></details>}
    {organizationAdmin && organization?.status === "approved" && <p className={styles.muted}>认领已发现的赛事在<a className={styles.link} href="/events">比赛页</a>对应卡片上操作；这里不重复提供入口。已通过的认领可在下方赛事里查看。</p>}
    {draft && <>
      <section className={styles.todo}><h3>当前待办</h3><p>{draft.baseEvent?.status === "archived" ? "比赛已归档，可查看正式规则和已有记录。" : draft.baseEvent?.status === "ended" ? "比赛已结束，请通过相应页面处理后续记录。" : !draft.baseEvent ? "填写比赛名称、规则和期限，保存后预览发布。" : dirty ? "当前修改尚未保存，先保存草稿。" : !draft.baseEvent.publishedRevision ? "草稿已保存，下一步预览公开规则并首次发布。" : "当前已有正式版本。修改规则后，先保存再预览发布新版。"}</p>
        {draft.baseEvent && moduleLinks && <div className={styles.publicLinks}>{Object.entries(moduleLinks(draft.baseEvent)).filter(([module, href]) => href && draft.baseEvent!.modules[module as EventModuleKey]).map(([module, href]) => <a className={styles.secondary} key={module} href={href}>{competitionModuleLabels[module as EventModuleKey]}</a>)}</div>}
      </section>
      {!canManage && <p className={styles.todo}>你可以查看这场比赛；编辑和发布规则需要“比赛规则与发布”权限。</p>}
      <form className={styles.panel} onSubmit={save}>
        <div className={`${styles.row} ${styles.between}`}><h3>比赛配置</h3><span className={styles.badge}>{dirty ? "尚未保存" : `已保存 · 配置版本 ${draft.baseEvent?.revision ?? "待创建"}`}</span></div>
        {!draft.baseEvent && <div className={styles.stack}><h4>选一个起点</h4><div className={styles.cards}>{templates.data?.map(template => <button type="button" className={styles.template} aria-pressed={draft.templateKey === template.key} key={template.key} disabled={busy || !writable} onClick={() => chooseTemplate(template)}><strong>{template.name}</strong><span className={styles.muted}>{template.description}</span></button>)}</div><p className={styles.muted}>切换模板只调整功能、报名和组队默认值，已填写的名称、规则和期限保留。</p></div>}
        {!draft.baseEvent && organization && organizationAdmin && <div className={styles.stack}>
          <h4>或者：以上一场为起点</h4>
          <p className={styles.muted}>同一机构里的既有比赛可以当起点，只复制配置。不复制上一届的报名答卷、正式队伍、通知与已读、评审分数和发布版本。</p>
          {duplicateSources.error ? <p role="alert" className={styles.error}>{duplicateSources.error.message}</p>
            : duplicateSources.loading && !duplicateSources.data ? <p role="status" className={styles.muted}>正在读取可复制的比赛…</p>
            : !duplicateSources.data?.length ? <p className={styles.muted}>这家机构还没有可复制的比赛。创建第一场后，下一场就能以它为起点。</p>
            : <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => setDuplicateOpen(value => !value)}>{duplicateOpen ? "收起复制设置" : "复制上一场…"}</button></div>}
          {duplicateOpen ? <div className={styles.panel}>
            <Field label="来源比赛" hint="限本机构自己的比赛。已归档的来源也可以选，但它的配置可能已经过时。"><select value={duplicateSourceId} disabled={busy} onChange={change => setDuplicateSourceId(change.target.value)}><option value="" disabled>选择一场比赛</option>{duplicateSources.data?.map(item => <option key={item.eventId} value={item.eventId}>{item.title} · {STATUS_LABELS[item.status]}</option>)}</select></Field>
            {duplicateSource && duplicatePlan && <div className={styles.grid}>
              <div className={styles.stack}><p className={styles.eyebrow}>将复制</p><ul className={styles.list}>{duplicatePlan.items.filter(item => item.inclusion === "copied").map(item => <li key={item.key}><strong>{item.label}</strong>：{item.note}</li>)}</ul></div>
              <div className={styles.stack}><p className={styles.eyebrow}>不复制</p><ul className={styles.list}>{duplicatePlan.items.filter(item => item.inclusion === "skipped").map(item => <li key={item.key}><strong>{item.label}</strong>：{item.note}</li>)}</ul></div>
            </div>}
            <div className={styles.grid}>
              <label className={styles.check}><input type="checkbox" checked={duplicateIncludeForm} disabled={busy} onChange={change => setDuplicateIncludeForm(change.target.checked)}/><span>复制报名表字段<small>新比赛从第 1 版报名表开始，请核对字段是否适用本届。</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={duplicateIncludeJudging} disabled={busy} onChange={change => setDuplicateIncludeJudging(change.target.checked)}/><span>复制评审维度与权重<small>复制为待开始的新评审轮，不带走上一届的评分。</small></span></label>
            </div>
            {duplicateSource && duplicateSourceHint(duplicateSource) && <p className={styles.warning}>{duplicateSourceHint(duplicateSource)}</p>}
            <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || !duplicateSource} onClick={() => void duplicateFromSource()}>{busy ? "正在创建…" : "以它为起点创建草稿"}</button></div>
            <p className={styles.muted}>这里只创建一场新草稿：不会发布，也不会改动来源比赛；时间会整体平移到当前时刻，发布前仍需逐项确认。</p>
          </div> : null}
        </div>}
        <Field label="比赛名称" hint="必填。填写对外公布的完整名称，例如“2026 校园 AI 黑客松”；选手会在报名页看到。"><input value={draft.title} onChange={change => update("title", change.target.value)} maxLength={160} required disabled={busy || !writable}/></Field>
        <Field label="一句话简介" hint="发布前需填写。说明面向谁、做什么，例如“面向首次参赛的学生，在两天内完成一个 AI 应用原型”。"><textarea value={draft.summary} onChange={change => update("summary", change.target.value)} maxLength={4000} disabled={busy || !writable}/></Field>
        <Field label="比赛时区" hint="必填。中国境内通常选 Asia/Shanghai（北京时间 UTC+8）。下方日期按此时区填写；修改后需重新核对所有期限。"><input value={draft.timezone} list={timezoneListId} onChange={change => update("timezone", change.target.value)} required maxLength={80} disabled={busy || !writable}/></Field>
        <datalist id={timezoneListId}>{["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"].map(zone => <option value={zone} key={zone}/>)}</datalist>
        <div className={styles.grid}><Field label="比赛开始" hint="必填。选择正式开赛的日期和时刻；当前预填日期仅供建草稿，请按真实安排修改。"><input type="datetime-local" value={draft.startsAt} onChange={change => update("startsAt", change.target.value)} required disabled={busy || !writable}/></Field><Field label="比赛结束" hint="必填。选择整场活动结束时间，必须晚于开赛；报名、锁队和作品截止不能晚于此时间。"><input type="datetime-local" value={draft.endsAt} onChange={change => update("endsAt", change.target.value)} required disabled={busy || !writable}/></Field>
          <Field label="报名开始" hint="启用报名并发布前需填写。选手从此时可以提交报名；请按实际开放时间修改预填值。"><input type="datetime-local" value={draft.registrationOpensAt} onChange={change => update("registrationOpensAt", change.target.value)} disabled={busy || !writable}/></Field><Field label="报名截止" hint="启用报名并发布前需填写。此时停止收新报名，须晚于报名开始；与作品提交截止分别设置。"><input type="datetime-local" value={draft.registrationClosesAt} onChange={change => update("registrationClosesAt", change.target.value)} disabled={busy || !writable}/></Field>
          <Field label="作品提交截止" hint="启用评审并发布前需填写。队伍须在此时前正式交作品；不能早于开赛或晚于比赛结束。"><input type="datetime-local" value={draft.submissionClosesAt} onChange={change => update("submissionClosesAt", change.target.value)} disabled={busy || !writable}/></Field><Field label="队伍锁定时间（选填）" hint="选填。设置后，到点停止更改正式队伍名单；留空则不另设锁队期限。"><input type="datetime-local" value={draft.teamLocksAt} onChange={change => update("teamLocksAt", change.target.value)} disabled={busy || !writable}/></Field></div>
        <Field label="地点 / 在线参与说明" hint="发布前需填写。线下写城市、场馆和详细地址；线上写参与方式或公开工具入口，例如“全程线上，会议入口见正式通知”。"><textarea value={draft.location} onChange={change => update("location", change.target.value)} maxLength={2000} disabled={busy || !writable} placeholder="线下地址，或线上参赛方式与工具入口"/></Field>
        <Field label="公开比赛规则" hint="发布前需填写。按资格、赛道、队伍人数、作品材料、评审标准、联系渠道逐项说明；这是选手公开看到的正式规则，请勿放密码或私人联系方式。"><textarea className={styles.ruleInput} value={draft.rules} onChange={change => update("rules", change.target.value)} maxLength={30000} disabled={busy || !writable}/></Field>
        <div className={styles.row}>{EVENT_MODULES.filter(module => draft.modules[module]).map(module => <span className={styles.badge} key={module}>{competitionModuleLabels[module]}</span>)}</div>
        <details className={styles.details}><summary className={styles.summary}>调整功能、报名与组队设置</summary><div className={styles.stack}><p className={styles.muted}>只开放需要的功能。组队依赖报名，评审依赖报名和队伍；正式发布后，已启用的功能不能直接关闭。</p>
          <div className={styles.grid}>{EVENT_MODULES.map(module => { const locked = Boolean(draft.baseEvent?.publishedRevision && publishedModules?.[module]); const onlineOnly = format === "online" && ["accommodation", "mealVouchers"].includes(module); return <label className={styles.check} key={module}><input type="checkbox" checked={draft.modules[module]} aria-label={competitionModuleLabels[module]} aria-describedby={timezoneListId + "-module-" + module} disabled={busy || !writable || locked || onlineOnly} onChange={change => toggleModule(module, change.target.checked)}/><span>{competitionModuleLabels[module]}<small id={timezoneListId + "-module-" + module}>{MODULE_HELP[module]}</small>{locked && <small>已发布，保留历史入口</small>}{onlineOnly && <small>仅线下比赛使用</small>}</span></label>; })}</div>
          <div className={styles.grid}><Field label="报名人数上限" hint="选填。填写允许报名的人数整数，例如 100；留空表示不设总上限，不是队伍人数上限。"><input type="number" min={1} max={100000} step={1} value={draft.capacity} onChange={change => update("capacity", change.target.value)} disabled={busy || !writable}/></Field><label className={styles.check}><input type="checkbox" checked={draft.reviewRequired} disabled={busy || !writable} onChange={change => update("reviewRequired", change.target.checked)}/><span>报名需要人工审核<small>开启后，报名需工作人员通过；关闭后按资格和名额检查直接确认。</small></span></label></div>
          <div className={styles.grid}><Field label="组队方式" hint="自愿组队由选手发起和申请；工作人员分配提供建议，仍需本人同意；混合允许两种方式。"><select value={draft.teamMode} onChange={change => update("teamMode", change.target.value as EventDraft["teamMode"])} disabled={busy || !writable}><option value="free">自愿组队</option><option value="assigned">工作人员分配</option><option value="mixed">自愿组队与工作人员分配</option></select></Field><div className={styles.grid}><Field label="队伍最少人数" hint="必填。填写正式参赛队伍至少几人，例如 2；未达到下限时不能锁定名单。"><input type="number" min={1} max={100} step={1} required value={draft.teamMin} onChange={change => update("teamMin", change.target.value)} disabled={busy || !writable}/></Field><Field label="队伍最多人数" hint="必填。填写每队最多几人，例如 5；不得小于最少人数。"><input type="number" min={1} max={100} step={1} required value={draft.teamMax} onChange={change => update("teamMax", change.target.value)} disabled={busy || !writable}/></Field></div></div>
        </div></details>
                <details className={styles.details}><summary className={styles.summary}>公开与社区（可选，默认关闭）</summary>
          <div className={styles.stack}><p className={styles.muted}>下面每一项都默认关闭，只有你在这里开启后才对选手生效；开关随正式发布版本冻结，改动需要重新发布。作品是否公开仍由<strong>提交的队伍本人</strong>选择，你不能替队伍决定披露。</p>
            <div className={styles.grid}>
              <label className={styles.check}><input type="checkbox" checked={draft.community.workShowcase} disabled={busy || !writable} onChange={change => setCommunity({ workShowcase: change.target.checked })}/><span>作品展示<small>允许队伍自愿把作品给本场参赛者看；队伍不选就不公开。</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={draft.community.participantDirectory} disabled={busy || !writable} onChange={change => setCommunity({ participantDirectory: change.target.checked })}/><span>本场参赛名录<small>只显示本人已发布的参赛名片与本场公开队伍，不含邮箱。</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={draft.community.peerFeedback} disabled={busy || !writable} onChange={change => setCommunity({ peerFeedback: change.target.checked })}/><span>文字留言<small>参赛者对已公开作品留言；可隐藏、可举报，不计入名次。</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={draft.community.peerReview} disabled={busy || !writable} onChange={change => setCommunity({ peerReview: change.target.checked })}/><span>数值互评<small>与评委分分列、独立页面展示，默认不计入名次。</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={draft.community.connections} disabled={busy || !writable} onChange={change => setCommunity({ connections: change.target.checked })}/><span>选手连接<small>同场参赛者双向同意后才能互相联系。</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={draft.community.directMessages} disabled={busy || !writable} onChange={change => setCommunity({ directMessages: change.target.checked })}/><span>站内私信<small>只在已同意的连接内可用；默认关闭，带屏蔽与举报。</small></span></label>
            </div>
            <div className={styles.grid}>
              <Field label="互评量纲" hint="选手互评使用的量表；与评委打分分开计算。"><select value={draft.community.peerReviewScale} disabled={busy || !writable} onChange={change => setCommunity({ peerReviewScale: change.target.value as EventCommunityConfig["peerReviewScale"] })}><option value="1-5">1–5 分</option><option value="0-10">0–10 分</option><option value="yes-no">是 / 否</option></select></Field>
              <Field label="互评参与率门槛" hint="0.1 到 1 之间，例如 0.3 表示三成；未达到时只显示「样本不足」，不显示汇总。"><input type="number" min={0.1} max={1} step={0.05} value={draft.community.peerReviewPassRate} disabled={busy || !writable} onChange={change => setCommunity({ peerReviewPassRate: Number(change.target.value) })}/></Field>
              <Field label="留言长度上限" hint="50 到 2000 个字符。"><input type="number" min={50} max={2000} step={10} value={draft.community.commentMaxLength} disabled={busy || !writable} onChange={change => setCommunity({ commentMaxLength: Number(change.target.value) })}/></Field>
              <Field label="私信保留口径" hint="赛事关闭后，既有私信是保留可读、冻结只读，还是到期清理。"><select value={draft.community.directMessageRetention} disabled={busy || !writable} onChange={change => setCommunity({ directMessageRetention: change.target.value as EventCommunityConfig["directMessageRetention"] })}><option value="freeze">冻结只读（默认）</option><option value="keep">保留可读</option><option value="purge">到期清理</option></select></Field>
              {draft.community.directMessageRetention === "purge" && <Field label="清理天数" hint="1 到 3650 天；到期后清理既有私信内容。"><input type="number" min={1} max={3650} step={1} value={draft.community.directMessagePurgeDays ?? 30} disabled={busy || !writable} onChange={change => setCommunity({ directMessagePurgeDays: Number(change.target.value) })}/></Field>}
            </div>
            <Field label="互评维度（每行一个）" hint="这些是选手互评的维度，与评委维度分开定义；最多 12 项。启用数值互评前至少填一项。"><textarea rows={3} value={draft.community.peerReviewDimensions.map(item => item.label).join("\n")} disabled={busy || !writable} onChange={change => setCommunity({ peerReviewDimensions: change.target.value.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 12).map((label, index) => ({ id: `d${index + 1}`, label })) })}/></Field>
            <p className={styles.muted}>关闭某项后，本场不再返回该项的新数据；既有记录的保留按上面的口径处理并在界面写明。</p>
          </div>
        </details>
        <div className={styles.actions}><button className={styles.button} type="submit" disabled={busy || !writable || (!dirty && Boolean(draft.baseEvent))}>{busy ? "正在处理…" : draft.baseEvent ? "保存修改" : "保存比赛草稿"}</button><button className={styles.secondary} type="button" disabled={busy || !canManage || !draft.baseEvent || dirty || draft.baseEvent.status === "archived" || draft.baseEvent.status === "ended"} onClick={() => void preparePreview()}>预览公开规则与发布范围</button></div>
      </form>
      {draft.baseEvent && organizationAdmin && writable && <details className={styles.details}><summary className={styles.summary}>更换这场比赛的运营负责人</summary><form className={styles.stack} onSubmit={changeResponsible}><p className={styles.muted}>新负责人需已拥有本场比赛的“比赛规则与发布”权限。更换前请先保存当前配置。</p><Field label="新负责人" hint="选择已拥有本场规则与发布权限的同事；保存后由此人负责这场比赛，不改变其他工作人员授权。"><select value={responsibleUserId} disabled={busy || dirty} onChange={change => setResponsibleUserId(change.target.value)}><option value="" disabled>选择已授权人员</option>{eligibleResponsibles.map(id => <option value={id} key={id}>{staffAccounts.find(account => account.userId === id)?.label ?? id}{id === draft.baseEvent?.responsibleUserId ? "（当前负责人）" : ""}</option>)}</select></Field><div className={styles.actions}><button className={styles.secondary} type="submit" disabled={busy || dirty || !responsibleUserId || responsibleUserId === draft.baseEvent.responsibleUserId}>确认更换负责人</button></div></form></details>}
      {preview && <section className={styles.panel}><p className={styles.eyebrow}>发布预览 · {preview.publicProjection.organizationName}</p><h3>{preview.publicProjection.title}</h3><p className={styles.muted}>这次将公开比赛名称、简介、规则、地点、期限与开放功能。联系人、入驻证明和工作人员账号不会进入公开规则。</p>
        <dl className={styles.deadlines}>{[["报名截止", preview.publicProjection.registrationClosesAt], ["比赛开始", preview.publicProjection.startsAt], ["作品截止", preview.publicProjection.submissionClosesAt], ["比赛结束", preview.publicProjection.endsAt]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{competitionDate(value, preview.publicProjection.timezone)}</dd></div>)}</dl><p className={styles.muted}>时区：{preview.publicProjection.timezone}</p>
        <p className={styles.rules}>{preview.publicProjection.summary}</p><p className={styles.rules}>{preview.publicProjection.rules}</p>{preview.publicProjection.location && <p className={styles.rules}>地点 / 在线参与：{preview.publicProjection.location}</p>}
        <div className={styles.row}>{EVENT_MODULES.filter(module => preview.publicProjection.modules[module]).map(module => <span className={styles.badge} key={module}>{competitionModuleLabels[module]}</span>)}</div>
        <p className={styles.muted}>本次变化：{preview.changedFields.length ? preview.changedFields.map(field => CHANGED_FIELDS[field] ?? field).join("、") : "公开配置没有变化"}</p>
        {preview.publicationBlockers.length > 0 ? <div className={styles.todo}><h4>发布前还需要</h4><ul className={styles.list}>{preview.publicationBlockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul><p>完成后保存，再重新预览。</p></div> : <p className={styles.notice}>公开配置检查通过，请核对规则与期限后填写发布说明。</p>}
        <form className={styles.stack} onSubmit={publish}><Field label="本次发布说明 / 对参赛者的影响" hint="必填。首次可写“开放报名，请在截止前提交资料”；更新时说明改了什么、影响谁和下一步，例如“作品截止延后一天，已交作品无需重交”。"><textarea value={changeSummary} onChange={change => setChangeSummary(change.target.value)} maxLength={2000} required disabled={busy}/></Field><div className={styles.actions}><button className={styles.button} type="submit" disabled={busy || !writable || dirty || preview.publicationBlockers.length > 0 || Boolean(draft.baseEvent?.publishedRevision && !preview.changedFields.length)}>{busy ? "正在发布…" : draft.baseEvent?.publishedRevision ? "确认发布新版规则" : "确认首次发布"}</button><button className={styles.secondary} type="button" disabled={busy} onClick={() => setPreview(null)}>返回继续编辑</button></div></form>
      </section>}
      {draft.baseEvent && canManage && draft.baseEvent.status !== "archived" && <details className={styles.details}><summary className={styles.summary}>比赛运营结束：标记结束或归档</summary><div className={styles.stack}>
        {draft.baseEvent.status === "published" && <><p className={styles.muted}>比赛结束后，标记结束以停止新的参赛操作；正式规则与记录仍保留。</p><label className={styles.check}><input type="checkbox" checked={endConfirmed} onChange={change => setEndConfirmed(change.target.checked)} disabled={busy || dirty}/><span>确认“{draft.baseEvent.title}”比赛已结束</span></label><div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy || !endConfirmed || dirty} onClick={() => void endCompetition()}>确认标记比赛结束</button></div><hr className={styles.divider}/></>}
        <p className={styles.muted}>归档后停止新的运营操作，已有正式规则与历史记录保留。未保存的修改需要先保存或放弃。</p><label className={styles.check}><input type="checkbox" checked={archiveConfirmed} onChange={change => setArchiveConfirmed(change.target.checked)} disabled={busy || dirty}/><span>确认将“{draft.baseEvent.title}”归档</span></label><div className={styles.actions}><button className={styles.danger} type="button" disabled={busy || !archiveConfirmed || dirty} onClick={() => void archive()}>确认归档这场比赛</button></div></div></details>}
    </>}
    {hasUnsavedDrafts && !dirty && <p className={styles.todo}>仍有其他比赛的本地草稿未保存，切回对应比赛后可以继续编辑。</p>}
    {organization && organizationAdmin && !grants.error && organization.status === "approved" && renderOrganizationSettings?.(organization)}
    {organization && organizationAdmin && <StaffAccess organization={organization} events={organizationEvents} grants={organizationGrants} loading={grants.loading} error={grants.error} staffAccounts={staffAccounts} onBusyChange={setBusy} reload={async () => { await Promise.all([grants.reload(), identities.reload(), organizations.reload(), event.reload()]); }}/>} 
  </section>;
}

function StaffAccess({ organization, events, grants, loading, error, staffAccounts, reload, onBusyChange }: { organization: Organization; events: readonly HostedEvent[]; grants: readonly StaffGrant[]; loading: boolean; error: Error | null; staffAccounts: readonly { readonly userId: string; readonly label: string }[]; reload: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const [userId, setUserId] = useState(""), [eventId, setEventId] = useState(""), [role, setRole] = useState<StaffGrant["role"]>("staff");
  const [capabilities, setCapabilities] = useState<readonly EventStaffCapability[]>(["communication_manage"]), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [failure, setFailure] = useState(""), [revoking, setRevoking] = useState<string | null>(null);
  const accountListId = useId();
  useEffect(() => { setUserId(""); setEventId(""); setRole("staff"); setCapabilities(["communication_manage"]); setNotice(""); setFailure(""); setRevoking(null); }, [organization.id]);
  const accountLabel = (id: string) => staffAccounts.find(account => account.userId === id)?.label ?? id;
  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); onBusyChange(true); setFailure(""); setNotice("");
    try { await api<StaffGrant>(`/organizer/organizations/${encodeURIComponent(organization.id)}/staff-grants`, { method: "POST", body: { expectedOrganizationRevision: organization.revision, userId, eventId: role === "organization_admin" || !eventId ? null : eventId, role, capabilities: role === "organization_admin" ? EVENT_STAFF_CAPABILITIES : capabilities } satisfies GrantStaffInput }); setUserId(""); setNotice("授权已保存，同事可以在自己的赛事入口看到对应比赛。"); await reload(); }
    catch (reason) { setFailure(`${message(reason)} 授权输入已保留。`); }
    finally { setBusy(false); onBusyChange(false); }
  }
  async function revoke(grant: StaffGrant) {
    setBusy(true); onBusyChange(true); setFailure(""); setNotice("");
    try { await api<StaffGrant>(`/organizer/staff-grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST", body: { expectedRevision: grant.revision } }); setRevoking(null); setNotice("授权已撤销，后续操作会按当前权限重新检查。"); await reload(); }
    catch (reason) { setFailure(message(reason)); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <details className={styles.details}><summary className={styles.summary}>{organization.name} · 工作人员与授权</summary><div className={styles.stack}><p className={styles.muted}>按组织或单场比赛授权。组织管理员可以创建比赛和管理授权；评委身份仍需在评审页面明确指派。</p>
    {loading && <p className={styles.muted} role="status">正在读取当前授权…</p>}{error && <p className={styles.error} role="alert">{error.message}</p>}
    {grants.filter(grant => grant.status === "active").map(grant => <article key={grant.id} className={styles.permissionList}><strong>{accountLabel(grant.userId)}</strong><p className={styles.muted}>{grant.eventId ? events.find(event => event.eventId === grant.eventId)?.title ?? "指定比赛" : "本组织全部比赛"} · {grant.role === "organization_admin" ? "组织管理员" : "工作人员"}</p><p className={styles.muted}>{grant.capabilities.map(capability => CAPABILITY_LABELS[capability]).join("、")}</p>
      <div className={styles.actions}>{revoking === grant.id ? <><button type="button" className={styles.danger} disabled={busy} onClick={() => void revoke(grant)}>确认撤销此授权</button><button type="button" className={styles.secondary} disabled={busy} onClick={() => setRevoking(null)}>保留授权</button></> : <button type="button" className={styles.secondary} disabled={busy} onClick={() => setRevoking(grant.id)}>撤销授权</button>}</div></article>)}
    <form className={styles.stack} onSubmit={grant}><h3>增加工作人员</h3><Field label="工作人员账号标识" hint={staffAccounts.length ? "必填。从已查找账号提示中选择同事，核对身份后复制本站账号编号；不要填写姓名、电话或邮箱代替。" : "必填。请同事提供本站账号编号，或先使用上方邮箱查找账号；不要填姓名、电话或邮箱代替编号。"}><input value={userId} list={accountListId} onChange={event => setUserId(event.target.value)} maxLength={200} required disabled={busy}/></Field><datalist id={accountListId}>{staffAccounts.map(account => <option key={account.userId} value={account.userId}>{account.label}</option>)}</datalist>
      <div className={styles.grid}><Field label="授权角色" hint="工作人员只获得勾选能力；组织管理员可管理本组织全部比赛和授权，请只授予可信负责人。"><select value={role} disabled={busy} onChange={event => setRole(event.target.value as StaffGrant["role"])}><option value="staff">工作人员</option><option value="organization_admin">组织管理员</option></select></Field><Field label="可管理范围" hint="选一场比赛则只管理该场；选择本组织全部比赛会覆盖这个机构的各场比赛。组织管理员始终是全机构范围。"><select value={role === "organization_admin" ? "" : eventId} disabled={busy || role === "organization_admin"} onChange={event => setEventId(event.target.value)}><option value="">本组织全部比赛</option>{events.map(event => <option key={event.eventId} value={event.eventId}>{event.title}</option>)}</select></Field></div>
      {role === "staff" ? <div className={styles.grid}>{EVENT_STAFF_CAPABILITIES.map(capability => <label className={styles.check} key={capability}><input type="checkbox" checked={capabilities.includes(capability)} aria-label={CAPABILITY_LABELS[capability]} aria-describedby={accountListId + "-capability-" + capability} disabled={busy} onChange={event => setCapabilities(previous => event.target.checked ? [...previous, capability] : previous.filter(item => item !== capability))}/><span>{CAPABILITY_LABELS[capability]}<small id={accountListId + "-capability-" + capability}>{CAPABILITY_HELP[capability]}</small></span></label>)}</div> : <p className={styles.todo}>组织管理员将获得本组织全部比赛的运营与授权管理权限，请确认范围。</p>}
      {failure && <p role="alert" className={styles.error}>{failure}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}<div className={styles.actions}><button type="submit" className={styles.button} disabled={busy || (role === "staff" && !capabilities.length)}>{busy ? "正在保存…" : "确认授予权限"}</button></div>
    </form>
  </div></details>;
}
