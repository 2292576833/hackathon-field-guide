"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ParticipantProfile } from "../shared/participant.ts";
import { ApiError, dateText, message } from "./client-api.ts";
import { Feedback, Field, Loading } from "./site-shell.tsx";
import styles from "./site.module.css";

export interface ParticipantProfileFormProps {
  onSaved?: (profile: ParticipantProfile) => void;
  /** Guide the next plan step while still allowing an incomplete profile to be saved. */
  requireForPlan?: boolean;
}

type ProfileInput = Omit<ParticipantProfile, "userId" | "revision" | "updatedAt">;
interface ProfileDraft {
  firstHackathon: "" | "yes" | "no";
  developmentExperience: "" | NonNullable<ParticipantProfile["developmentExperience"]>;
  city: string;
  skills: string;
  interests: string;
  projectIdea: string;
  availableHoursPerDay: string;
  travelPreference: ParticipantProfile["travelPreference"];
  presentationExperience: "" | NonNullable<ParticipantProfile["presentationExperience"]>;
}
interface DraftError { field: keyof ProfileDraft; message: string }
interface ProfileConflict { latestRevision?: number; latest: ParticipantProfile | null; error: string | null; reason: "version" | "unconfirmed" }

const developmentLabels = { none: "还没有开发经验", beginner: "正在入门，做过练习", project: "做过完整项目", experienced: "有持续开发经验" } as const;
const travelLabels = { undecided: "还没决定", rail: "优先铁路", flight: "优先飞机", local: "只考虑本地或线上" } as const;
const presentationLabels = { none: "还没有路演经验", some: "做过一些展示", confident: "能独立准备和讲解" } as const;
const expiredCodes = ["UNAUTHENTICATED", "AUTH_SESSION_REQUIRED", "AUTH_SESSION_EXPIRED", "AUTH_SESSION_REVOKED"];
const hasControls = (value: string) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);

class ProfileApiError extends ApiError {
  latestRevision?: number;
  constructor(message: string, status: number, code: string, requestId?: string, latestRevision?: number) {
    super(message, status, code, requestId);
    this.latestRevision = latestRevision;
  }
}

/** This boundary keeps the conflict metadata that the shared client currently omits. */
async function requestProfile(signal: AbortSignal, input?: ProfileInput & { expectedRevision: number }): Promise<ParticipantProfile> {
  const response = await fetch("/api/v1/me/participant-profile", {
    method: input === undefined ? "GET" : "PATCH", credentials: "same-origin", cache: "no-store", signal,
    ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  });
  let envelope: { data?: ParticipantProfile; error?: { message?: string; code?: string; latestRevision?: number }; requestId?: string };
  try { envelope = await response.json(); }
  catch { throw new ProfileApiError("服务没有返回可读取的画像，请稍后重试。", response.status, "INVALID_RESPONSE"); }
  if (!envelope || typeof envelope !== "object") throw new ProfileApiError("服务返回的画像格式不完整，请稍后重试。", 502, "INVALID_RESPONSE");
  if (!response.ok || envelope.error) {
    const rawCode = envelope.error?.code ?? "REQUEST_FAILED";
    const expired = response.status === 401;
    const code = expired && !expiredCodes.includes(rawCode) ? "UNAUTHENTICATED" : rawCode;
    if (expired && typeof window !== "undefined") window.dispatchEvent(new Event("hackathon:unauthenticated"));
    const revision = envelope.error?.latestRevision;
    throw new ProfileApiError(expired ? "登录已失效，请重新登录。" : envelope.error?.message ?? "画像操作未完成，请重试。", response.status, code, envelope.requestId,
      typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined);
  }
  const profile = envelope.data;
  if (!profile || typeof profile.userId !== "string" || !Number.isSafeInteger(profile.revision) || profile.revision < 0
    || (profile.firstHackathon !== null && typeof profile.firstHackathon !== "boolean")
    || (profile.developmentExperience !== null && !Object.hasOwn(developmentLabels, profile.developmentExperience))
    || typeof profile.city !== "string" || typeof profile.projectIdea !== "string"
    || !Array.isArray(profile.skills) || !profile.skills.every(value => typeof value === "string")
    || !Array.isArray(profile.interests) || !profile.interests.every(value => typeof value === "string")
    || (profile.availableHoursPerDay !== null && (typeof profile.availableHoursPerDay !== "number" || !Number.isFinite(profile.availableHoursPerDay) || profile.availableHoursPerDay < 0 || profile.availableHoursPerDay > 24))
    || !Object.hasOwn(travelLabels, profile.travelPreference)
    || (profile.presentationExperience !== null && !Object.hasOwn(presentationLabels, profile.presentationExperience))
    || (profile.updatedAt !== null && (typeof profile.updatedAt !== "string" || !Number.isFinite(Date.parse(profile.updatedAt))))) {
    throw new ProfileApiError("服务返回的画像格式不完整，请稍后重试。", 502, "INVALID_RESPONSE");
  }
  return profile;
}

function toDraft(profile: ParticipantProfile): ProfileDraft {
  return {
    firstHackathon: profile.firstHackathon === null ? "" : profile.firstHackathon ? "yes" : "no",
    developmentExperience: profile.developmentExperience ?? "", city: profile.city,
    skills: profile.skills.join("\n"), interests: profile.interests.join("\n"), projectIdea: profile.projectIdea,
    availableHoursPerDay: profile.availableHoursPerDay === null ? "" : String(profile.availableHoursPerDay),
    travelPreference: profile.travelPreference, presentationExperience: profile.presentationExperience ?? "",
  };
}

function draftInput(draft: ProfileDraft): { input: ProfileInput } | { error: DraftError } {
  const city = draft.city.trim(), projectIdea = draft.projectIdea.trim();
  if (city.length > 80 || hasControls(city)) return { error: { field: "city", message: "城市最多 80 个字，请移除异常字符。" } };
  if (projectIdea.length > 4000 || hasControls(projectIdea)) return { error: { field: "projectIdea", message: "项目想法最多 4000 个字，请移除异常字符。" } };
  const parseItems = (value: string) => [...new Set(value.split(/[\r\n,，;；]+/).map(item => item.trim()).filter(Boolean))];
  const skills = parseItems(draft.skills), interests = parseItems(draft.interests);
  for (const field of ["skills", "interests"] as const) {
    const items = field === "skills" ? skills : interests;
    if (items.length > 30 || items.some(item => item.length > 80 || hasControls(item))) {
      return { error: { field, message: `${field === "skills" ? "技能" : "兴趣"}最多 30 项，每项最多 80 个字，请移除异常字符。` } };
    }
  }
  const hours = draft.availableHoursPerDay.trim() === "" ? null : Number(draft.availableHoursPerDay);
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 24)) return { error: { field: "availableHoursPerDay", message: "每日可投入时间需在 0 到 24 小时之间。" } };
  return { input: {
    firstHackathon: draft.firstHackathon === "" ? null : draft.firstHackathon === "yes",
    developmentExperience: draft.developmentExperience === "" ? null : draft.developmentExperience,
    city, skills, interests, projectIdea, availableHoursPerDay: hours,
    travelPreference: draft.travelPreference, presentationExperience: draft.presentationExperience === "" ? null : draft.presentationExperience,
  } };
}

function planMissing(draft: ProfileDraft): string[] {
  return [draft.firstHackathon === "" ? "是否首次参赛" : null, draft.developmentExperience === "" ? "开发经验" : null,
    !draft.city.trim() ? "常住城市" : null, !Number.isFinite(Number(draft.availableHoursPerDay)) || Number(draft.availableHoursPerDay) <= 0 ? "每日可投入时间（大于 0 小时）" : null].filter((value): value is string => value !== null);
}

function LatestProfile({ profile }: { profile: ParticipantProfile }) {
  return <div className={styles.card}>
    <h3>最新保存资料 · 版本 {profile.revision}</h3>
    <p className={styles.muted}>更新于 {dateText(profile.updatedAt)}</p>
    <ul className={styles.list}>
      <li>首次参赛：{profile.firstHackathon === null ? "未填写" : profile.firstHackathon ? "是" : "否"} · 开发经验：{profile.developmentExperience === null ? "未填写" : developmentLabels[profile.developmentExperience]}</li>
      <li>常住城市：{profile.city || "未填写"} · 每日时间：{profile.availableHoursPerDay === null ? "未填写" : `${profile.availableHoursPerDay} 小时`}</li>
      <li>技能：{profile.skills.join("、") || "未填写"}</li>
      <li>兴趣：{profile.interests.join("、") || "未填写"}</li>
      <li><strong>项目想法</strong><p style={{ whiteSpace: "pre-wrap" }}>{profile.projectIdea || "未填写"}</p></li>
      <li>出行偏好：{travelLabels[profile.travelPreference]} · 路演经验：{profile.presentationExperience === null ? "未填写" : presentationLabels[profile.presentationExperience]}</li>
    </ul>
  </div>;
}

/** The session chooses the actor; this component never sends an account identifier. */
export function ParticipantProfileForm({ onSaved, requireForPlan = false }: ParticipantProfileFormProps) {
  const titleId = useId();
  const [profile, setProfile] = useState<ParticipantProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string | null>(null), [validation, setValidation] = useState<DraftError | null>(null);
  const [notice, setNotice] = useState(""), [conflict, setConflict] = useState<ProfileConflict | null>(null);
  const activeRequest = useRef<AbortController | null>(null), generation = useRef(0), mounted = useRef(false);

  async function load() {
    const current = ++generation.current;
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    setLoading(true); setError(null);
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const saved = await requestProfile(controller.signal);
      if (!mounted.current || generation.current !== current) return;
      setProfile(saved); setDraft(toDraft(saved)); setConflict(null); setValidation(null); setNotice("");
    } catch (reason) {
      if (mounted.current && generation.current === current) setError(controller.signal.aborted ? "读取画像超时，请重试。" : reason instanceof Error ? reason : new Error("读取画像失败，请重试。"));
    } finally {
      clearTimeout(timer);
      if (mounted.current && generation.current === current) { setLoading(false); activeRequest.current = null; }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const clear = () => {
      generation.current++; activeRequest.current?.abort(); activeRequest.current = null;
      setProfile(null); setDraft(null); setConflict(null); setValidation(null); setNotice(""); setBusy(false); setLoading(false);
      setError(new ApiError("登录已失效，请重新登录。", 401, "UNAUTHENTICATED"));
    };
    window.addEventListener("hackathon:unauthenticated", clear);
    void load();
    return () => { mounted.current = false; generation.current++; activeRequest.current?.abort(); window.removeEventListener("hackathon:unauthenticated", clear); };
    // This form owns its GET lifecycle; a parent rerender must not replace unsaved input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function edit<K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) {
    setDraft(current => current ? { ...current, [field]: value } : current);
    setNotice(""); if (validation?.field === field) setValidation(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !draft || busy || conflict) return;
    const parsed = draftInput(draft);
    setNotice(""); setError(null);
    if ("error" in parsed) { setValidation(parsed.error); return; }
    setValidation(null); setBusy(true);
    const current = ++generation.current;
    const controller = new AbortController(); activeRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    let saved: ParticipantProfile | null = null;
    try {
      saved = await requestProfile(controller.signal, { expectedRevision: profile.revision, ...parsed.input });
      if (!mounted.current || generation.current !== current) { saved = null; return; }
      setProfile(saved); setDraft(toDraft(saved)); setConflict(null);
      setNotice("参赛画像已保存。下次生成计划会使用这份资料。");
    } catch (reason) {
      if (!mounted.current || generation.current !== current) return;
      if (reason instanceof ProfileApiError && reason.status === 409) setConflict({ latestRevision: reason.latestRevision, latest: null, error: null, reason: "version" });
      else if (controller.signal.aborted || !(reason instanceof ProfileApiError) || reason.code === "INVALID_RESPONSE") setConflict({ latest: null, error: null, reason: "unconfirmed" });
      else setError(reason);
    } finally {
      clearTimeout(timer);
      if (mounted.current && generation.current === current) { setBusy(false); activeRequest.current = null; }
    }
    if (saved) onSaved?.(saved);
  }

  async function compareLatest() {
    if (busy || !conflict) return;
    setBusy(true);
    const current = ++generation.current;
    const controller = new AbortController(); activeRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const latest = await requestProfile(controller.signal);
      if (mounted.current && generation.current === current) setConflict(previous => ({ latestRevision: latest.revision, latest, error: null, reason: previous?.reason ?? "version" }));
    } catch (reason) {
      if (mounted.current && generation.current === current) setConflict(previous => previous ? { ...previous, error: controller.signal.aborted ? "读取最新版本超时，请重试。" : message(reason) } : previous);
    } finally {
      clearTimeout(timer);
      if (mounted.current && generation.current === current) { setBusy(false); activeRequest.current = null; }
    }
  }

  const missing = draft ? planMissing(draft) : [];
  const savedMissing = profile ? planMissing(toDraft(profile)) : [];
  const planLabel = (label: string) => requireForPlan ? `${label}（计划必填）` : label;
  const unauthenticated = error instanceof ApiError && error.status === 401;

  return <section id="participant-profile" className={styles.panel} aria-labelledby={titleId} aria-busy={loading || busy}>
    <h2 id={titleId}>我的参赛画像</h2>
    <p className={styles.muted}>填写你的经验、时间和偏好，帮助生成适合自己的参赛计划。资料仅保存在本人账号；可以先保存部分信息，不影响登录。</p>
    {loading && <Loading/>}
    <Feedback error={profile ? null : error}/>
    {!loading && !profile && !unauthenticated && <button type="button" className={styles.secondary} onClick={() => void load()}>重新读取画像</button>}
    {!loading && profile && draft && <>
      {profile.revision === 0 && <p className={styles.notice}>你还没有保存参赛画像。从下面几项开始即可，不会开发也能参加黑客松。</p>}
      {requireForPlan && <p className={styles.warning} role="status">{missing.length ? `生成计划前请补齐：${missing.join("、")}。可以先保存，再继续填写。` : savedMissing.length ? "所需信息已填写，请保存后再生成计划。" : "已保存的画像包含计划所需信息；修改后请先保存，再生成计划。"}</p>}
      <p className={styles.muted}>当前保存版本：{profile.revision === 0 ? "尚未保存" : profile.revision} {profile.updatedAt && <>· {dateText(profile.updatedAt)}</>}</p>
      <form className={styles.form} onSubmit={event => void save(event)}>
        <div className={styles.grid}>
          <Field label={planLabel("是否第一次参加黑客松")}><select value={draft.firstHackathon} disabled={busy} onChange={event => edit("firstHackathon", event.target.value as ProfileDraft["firstHackathon"])}><option value="">暂未填写</option><option value="yes">是，这是第一次</option><option value="no">否，参加过</option></select></Field>
          <Field label={planLabel("开发经验")} hint="按实际经历填写；没有开发经验也可以参与需求、设计、测试或路演。"><select value={draft.developmentExperience} disabled={busy} onChange={event => edit("developmentExperience", event.target.value as ProfileDraft["developmentExperience"])}><option value="">暂未填写</option>{Object.entries(developmentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
          <Field label={planLabel("常住城市")} hint="用于出行建议；填写城市即可，不需要地址。"><input value={draft.city} maxLength={80} autoComplete="address-level2" placeholder="例如：上海" disabled={busy} aria-invalid={validation?.field === "city" || undefined} onChange={event => edit("city", event.target.value)}/></Field>
          <Field label={planLabel("每日可投入时间（小时）")} hint="填写比赛准备期间每天可用的时间，可以填小数。生成计划需大于 0。"><input type="number" min={0} max={24} step="any" inputMode="decimal" value={draft.availableHoursPerDay} placeholder="例如：2.5" disabled={busy} aria-invalid={validation?.field === "availableHoursPerDay" || undefined} onChange={event => edit("availableHoursPerDay", event.target.value)}/></Field>
          <Field label="现有技能（可选）" hint="每行一项，或用逗号分隔。最多 30 项，每项 80 个字；可留空。"><textarea rows={4} maxLength={2430} value={draft.skills} placeholder={"例如：\nPython 入门\n视觉设计\n需求整理"} disabled={busy} aria-invalid={validation?.field === "skills" || undefined} onChange={event => edit("skills", event.target.value)}/></Field>
          <Field label="感兴趣的方向（可选）" hint="每行一项，或用逗号分隔。最多 30 项，每项 80 个字。"><textarea rows={4} maxLength={2430} value={draft.interests} placeholder={"例如：\nAI 工具\n教育\n小游戏"} disabled={busy} aria-invalid={validation?.field === "interests" || undefined} onChange={event => edit("interests", event.target.value)}/></Field>
          <Field label="出行偏好"><select value={draft.travelPreference} disabled={busy} onChange={event => edit("travelPreference", event.target.value as ProfileDraft["travelPreference"])}>{Object.entries(travelLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
          <Field label="路演经验（可选）"><select value={draft.presentationExperience} disabled={busy} onChange={event => edit("presentationExperience", event.target.value as ProfileDraft["presentationExperience"])}><option value="">暂未填写</option>{Object.entries(presentationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
        </div>
        <Field label="项目想法（可选）" hint="写你希望解决什么问题、服务谁，或先留空。最多 4000 个字。"><textarea rows={5} maxLength={4000} value={draft.projectIdea} placeholder="我想做一个……，帮助……解决……" disabled={busy} aria-invalid={validation?.field === "projectIdea" || undefined} onChange={event => edit("projectIdea", event.target.value)}/></Field>
        <Feedback error={validation?.message ?? error} notice={notice}/>
        {conflict && <div className={styles.critical} role="alert">
          <h3>{conflict.reason === "unconfirmed" ? "保存结果尚未确认" : "这份画像已在其他页面更新"}</h3>
          <p>{conflict.reason === "unconfirmed" ? "没有收到完整的保存响应。" : conflict.latestRevision === undefined ? "服务器已有新版本。" : `服务器最新版本为 ${conflict.latestRevision}。`}本页输入已保留，先查看已保存资料，再选择如何继续。</p>
          {conflict.error && <p className={styles.error}>{conflict.error}</p>}
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void compareLatest()}>{busy ? "正在读取最新版本…" : conflict.latest ? "再次读取最新版本" : "读取最新版本作对照"}</button>
          {conflict.latest && <><LatestProfile profile={conflict.latest}/><div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => { if (!conflict.latest) return; setProfile(conflict.latest); setDraft(toDraft(conflict.latest)); setConflict(null); setValidation(null); setError(null); setNotice("已采用最新保存资料。此前的本页输入已替换。"); }}>采用最新资料</button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => { if (!conflict.latest) return; setProfile(conflict.latest); setConflict(null); setError(null); setNotice("已选择保留本页输入。核对后点击保存，会将最新画像替换为本页填写的资料。"); }}>保留本页输入，准备重新保存</button>
          </div></>}
        </div>}
        <div className={styles.actions}><button type="submit" className={styles.button} disabled={busy || Boolean(conflict)}>{busy ? "正在处理…" : "保存参赛画像"}</button><span className={styles.hint}>仅提交画像字段和当前版本，不修改邮箱或昵称。</span></div>
      </form>
    </>}
  </section>;
}
