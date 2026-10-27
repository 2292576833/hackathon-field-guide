"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, message, operationKey, useApi } from "../../components/client-api.ts";
import type { HostedEventScope, EventRegistrationStatus } from "../../shared/organizer-contracts.ts";
import type { AnswerValue, MyRegistrationView, Registration, RegistrationAnswers, RegistrationField, RegistrationForm, RegistrationFormView } from "./model.ts";
import styles from "./registration.module.css";

export interface RegistrationPanelProps { eventId: string; signedIn?: boolean; renderOwnDetails?: (registration: Registration) => ReactNode }
export const registrationStatusText: Record<EventRegistrationStatus, string> = { draft: "报名草稿", pending: "等待审核", approved: "报名已通过", rejected: "报名未通过", withdrawn: "已撤回" };
export function eventDate(value: string | null, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未设置";
  try { return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + `（${timezone}）`; }
  catch { return new Date(value).toISOString(); }
}
export function EventContext({ event, identity }: { event: HostedEventScope; identity: string }) {
  return <header className={styles.context}><p className={styles.eyebrow}>当前比赛 · {identity}</p><h2>{event.title}</h2><p>{event.organizationName}</p><dl className={styles.deadlines}><div><dt>报名开始</dt><dd>{eventDate(event.registrationOpensAt, event.timezone)}</dd></div><div><dt>报名截止</dt><dd>{eventDate(event.registrationClosesAt, event.timezone)}</dd></div><div><dt>比赛时间</dt><dd>{eventDate(event.startsAt, event.timezone)} 至 {eventDate(event.endsAt, event.timezone)}</dd></div></dl><Link href="/me/competitions" className={styles.link}>选择其他比赛</Link></header>;
}
export function Feedback({ error, notice }: { error?: string | Error | null; notice?: string }) {
  return <>{error && <p className={styles.error} role="alert">{typeof error === "string" ? error : error.message}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}</>;
}
export function LoginPrompt({ eventId, page = "register" }: { eventId: string; page?: string }) {
  const target = `/competitions/${encodeURIComponent(eventId)}/${page}`;
  return <div className={styles.empty}><p>登录后继续这场比赛的{page === "teams" ? "组队" : "报名"}，不会自动提交或加入。</p><div className={styles.actions}><Link className={styles.button} href={`/login?returnTo=${encodeURIComponent(target)}`}>登录后继续</Link><Link className={styles.secondary} href={`/register?returnTo=${encodeURIComponent(target)}`}>注册账号后继续</Link></div></div>;
}
type SwitchState = { dirty: boolean; save?: () => Promise<boolean> };
/** Keep the old editor mounted until its unsaved input has been explicitly handled. */
export function EventEditorBoundary({ eventId, children }: { eventId: string; children: (eventId: string, onDraft: (state: SwitchState) => void) => ReactNode }) {
  const [activeId, setActiveId] = useState(eventId); const [draft, setDraft] = useState<SwitchState>({ dirty: false }); const [saving, setSaving] = useState(false); const [dismissed, setDismissed] = useState("");
  const onDraft = useCallback((state: SwitchState) => setDraft(state), []);
  const switching = eventId !== activeId;
  useEffect(() => { if (switching && !draft.dirty) { setActiveId(eventId); setDismissed(""); } }, [eventId, switching, draft.dirty]);
  useEffect(() => {
    if (!draft.dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null; if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hash && anchor.pathname === window.location.pathname && anchor.search === window.location.search) return; if (!window.confirm("本页还有未保存的输入。确定放弃并离开当前比赛吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [draft.dirty]);
  const switchNow = () => { setDraft({ dirty: false }); setDismissed(""); setActiveId(eventId); };
  return <>{switching && draft.dirty && <aside className={styles.switch} role="region" aria-label="切换比赛前处理草稿"><strong>当前比赛还有未保存输入</strong><p>下方仍是原比赛。先保存或放弃，再切换到新比赛。</p><div className={styles.actions}>{draft.save && <button className={styles.button} disabled={saving} onClick={async () => { setSaving(true); try { if (await draft.save!()) switchNow(); } finally { setSaving(false); } }}>{saving ? "正在保存…" : "保存后切换"}</button>}<button className={styles.danger} disabled={saving} onClick={switchNow}>放弃输入并切换</button><button className={styles.secondary} disabled={saving} onClick={() => setDismissed(eventId)}>继续编辑原比赛</button></div></aside>}<fieldset className={styles.fieldset} disabled={saving || switching && draft.dirty && dismissed !== eventId}>{children(activeId, onDraft)}</fieldset></>;
}
function FieldInput({ field, value, onChange, disabled }: { field: RegistrationField; value: AnswerValue | undefined; onChange: (value: AnswerValue | undefined) => void; disabled: boolean }) {
  const id = `registration-answer-${field.id}`; const label = `${field.label}${field.required ? "（必填）" : "（选填）"}`;
  if (field.type === "multichoice") {
    const chosen = Array.isArray(value) ? value : [];
    return <fieldset className={styles.choices} disabled={disabled}><legend>{label}</legend>{field.description && <p className={styles.hint}>{field.description}</p>}{field.options?.map(option => <label className={styles.check} key={option}><input type="checkbox" checked={chosen.includes(option)} onChange={event => onChange(event.target.checked ? [...chosen, option] : chosen.filter(item => item !== option))}/>{option}</label>)}</fieldset>;
  }
  const props = { id, disabled, "aria-describedby": field.description ? `${id}-hint` : undefined };
  return <label className={styles.field} htmlFor={id}>{label}{field.type === "textarea" ? <textarea {...props} maxLength={field.maxLength ?? 4000} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)}/> : field.type === "choice" ? <select {...props} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)}><option value="">请选择</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input {...props} type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"} step={field.type === "number" ? "any" : undefined} min={field.min} max={field.max} maxLength={field.maxLength ?? 500} value={typeof value === "number" || typeof value === "string" ? value : ""} onChange={event => onChange(field.type === "number" ? event.target.value === "" ? undefined : Number(event.target.value) : event.target.value)}/>} {field.description && <span className={styles.hint} id={`${id}-hint`}>{field.description}</span>}</label>;
}
export function RegistrationPanel({ eventId, signedIn = true, renderOwnDetails }: RegistrationPanelProps) {
  return <EventEditorBoundary eventId={eventId}>{(activeId, onDraft) => <RegistrationEditor key={`${activeId}:${signedIn}`} eventId={activeId} signedIn={signedIn} renderOwnDetails={renderOwnDetails} onDraft={onDraft}/>}</EventEditorBoundary>;
}
function RegistrationEditor({ eventId, signedIn, onDraft, renderOwnDetails }: RegistrationPanelProps & { signedIn: boolean } & { onDraft: (state: SwitchState) => void }) {
  const base = `/competitions/${encodeURIComponent(eventId)}`;
  const publicState = useApi<RegistrationFormView>(`${base}/registration-form`); const own = useApi<MyRegistrationView>(signedIn ? `${base}/my-registration` : null);
  const [registration, setRegistration] = useState<Registration | null>(null); const [editingForm, setEditingForm] = useState<RegistrationForm | null>(null); const [answers, setAnswers] = useState<RegistrationAnswers>({}); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const initialized = useRef(false); const retry = useRef(new Map<string, string>());
  useEffect(() => { if (own.data && !initialized.current) { initialized.current = true; setRegistration(own.data.registration); setAnswers(own.data.registration?.answers ?? {}); } }, [own.data]);
  useEffect(() => { if (own.error instanceof ApiError && [401, 403, 404].includes(own.error.status)) { setRegistration(null); setEditingForm(null); setAnswers({}); setDirty(false); initialized.current = false; } }, [own.error]);
  const data = own.data ?? publicState.data; const form = editingForm ?? registration?.schema ?? data?.form; const event = data?.event;
  const save = useCallback(async (): Promise<boolean> => {
    if (!form || !signedIn || busy) return false;
    setBusy(true); setError(""); setNotice("");
    try { const saved = await api<Registration>(`${base}/my-registration`, { method: "PATCH", body: { expectedRevision: registration?.revision ?? 0, formRevision: form.revision, answers } }); setRegistration(saved); setEditingForm(null); setAnswers(saved.answers); setDirty(false); setNotice("报名草稿已保存。下一步：核对后提交报名。"); return true; }
    catch (reason) { setError(message(reason)); return false; } finally { setBusy(false); }
  }, [form, signedIn, busy, base, registration?.revision, answers]);
  useEffect(() => { onDraft({ dirty, save }); }, [dirty, save, onDraft]);
  async function readLatest() { if (busy || own.loading || publicState.loading) return; if (dirty && !window.confirm("读取服务器最新报名会放弃本页未保存输入。确定继续吗？")) return; initialized.current = false; setEditingForm(null); setDirty(false); setError(""); setNotice(""); await own.reload(); await publicState.reload(); }
  function adoptLatestForm() {
    const latest = data?.form; if (!latest || !form || busy || !registration || !["draft", "rejected", "withdrawn"].includes(registration.status)) return;
    if (!window.confirm("改用最新报名表后，只带入同一字段且仍有效的答案。请重新核对新增或变更的字段；服务器保留原答卷历史。确定继续吗？")) return;
    const carried: RegistrationAnswers = {};
    for (const field of latest.fields) {
      const original = form.fields.find(item => item.id === field.id); const answer = answers[field.id];
      if (!original || original.type !== field.type || answer === undefined) continue;
      if (field.type === "number") { if (typeof answer === "number" && Number.isFinite(answer) && (field.min === undefined || answer >= field.min) && (field.max === undefined || answer <= field.max)) carried[field.id] = answer; }
      else if (field.type === "choice") { if (typeof answer === "string" && field.options?.includes(answer)) carried[field.id] = answer; }
      else if (field.type === "multichoice") { if (Array.isArray(answer) && answer.every(item => field.options?.includes(item))) carried[field.id] = [...answer]; }
      else if (typeof answer === "string" && answer.length <= (field.maxLength ?? (field.type === "textarea" ? 4000 : field.type === "url" ? 2000 : 500))) carried[field.id] = answer;
    }
    setEditingForm(latest); setAnswers(carried); setDirty(true); setError(""); setNotice("已切换到最新报名表。请核对所有字段，再保存或提交；原保存答卷可在下方对照。");
  }
  async function mutate(action: "submit" | "withdraw") {
    if (!form || busy) return;
    if (action === "withdraw" && !window.confirm("确认撤回本场报名？队伍参赛资格会重新核对，私人团队空间会保留。")) return;
    if (action === "submit") {
      const missing = form.fields.find(field => field.required && (answers[field.id] === undefined || answers[field.id] === "" || Array.isArray(answers[field.id]) && (answers[field.id] as string[]).length === 0));
      if (missing) { setError(`请先填写“${missing.label}”。`); document.getElementById(`registration-answer-${missing.id}`)?.focus(); return; }
    }
    setBusy(true); setError(""); setNotice("");
    try {
      let current = registration;
      if (action === "submit" && (dirty || !current || current.status === "rejected" || current.status === "withdrawn")) current = await api<Registration>(`${base}/my-registration`, { method: "PATCH", body: { expectedRevision: current?.revision ?? 0, formRevision: form.revision, answers } });
      if (!current) throw new Error("请先保存报名草稿。");
      setRegistration(current);
      const signature = `${action}:${current.revision}`; let key = retry.current.get(signature); if (!key) { key = operationKey(); retry.current.set(signature, key); }
      const saved = await api<Registration>(`${base}/my-registration/${action}`, { method: "POST", body: { expectedRevision: current.revision, idempotencyKey: key } }); setRegistration(saved); setAnswers(saved.answers); setDirty(false); setNotice(action === "withdraw" ? "报名已撤回。需要再次参加时，请重新核对报名窗口。" : saved.status === "approved" ? event?.modules.teams ? "报名已通过。下一步：加入或创建本场队伍。" : "报名已通过。下一步：查看本场比赛安排与官方通知。" : "报名已收到。可点击“刷新审核结果”查看最新状态。"); void publicState.reload();
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  const closed = Boolean(event && (event.status !== "published" || !event.modules.registration || event.registrationClosesAt && Date.now() >= Date.parse(event.registrationClosesAt)));
  const beforeOpen = Boolean(event?.registrationOpensAt && Date.now() < Date.parse(event.registrationOpensAt));
  const canEdit = signedIn && initialized.current && !own.loading && !publicState.loading && !closed && (!registration || ["draft", "rejected", "withdrawn"].includes(registration.status));
  const unauthenticated = own.error instanceof ApiError && own.error.status === 401;
  return <section className={styles.panel} aria-label="本场报名">{event && <EventContext event={event} identity="本人报名"/>}<h2>{form?.title || "报名参加"}</h2><p>免费报名。账号邮箱由系统读取，无需重复填写。</p>{(publicState.loading || signedIn && own.loading) && <p role="status">正在读取本场报名…</p>}<Feedback error={own.error ?? publicState.error}/>{(own.error || publicState.error) && <button className={styles.secondary} onClick={() => void readLatest()}>重新读取报名状态</button>}{(!signedIn || unauthenticated) && <LoginPrompt eventId={eventId}/>} {registration && <div className={styles.empty}><span className={styles.badge}>{registrationStatusText[registration.status]}</span><p>{registration.status === "draft" ? "草稿还没有提交。填写完成后点击“提交报名”。" : registration.status === "pending" ? event?.modules.teams ? "等待工作人员审核。批准后可以正式组队。" : "等待工作人员审核。通过后可查看本场比赛安排。" : registration.status === "approved" ? event?.modules.teams ? "现在可以加入或创建本场正式队伍。" : "报名已通过，接下来查看本场安排与官方通知。" : registration.status === "rejected" ? "请查看审核说明，修改后可在报名窗口内再次提交。" : "需要重新参加时，可在报名窗口内修改并再次提交。"}</p>{registration.reviewNote && <p><strong>审核说明：</strong>{registration.reviewNote}</p>}<div className={styles.actions}>{registration.status === "approved" && <Link className={styles.button} href={event?.modules.teams ? `${base}/teams` : base}>{event?.modules.teams ? "下一步：前往本场队伍" : "下一步：查看本场安排"}</Link>}{["pending", "approved"].includes(registration.status) && <button type="button" className={styles.secondary} disabled={busy || own.loading || publicState.loading} onClick={() => void readLatest()}>{own.loading || publicState.loading ? "正在刷新…" : "刷新审核结果"}</button>}</div></div>}{registration && !own.error && renderOwnDetails?.(registration)}{event && <p className={styles.muted}>已占报名名额 {data?.reservedCount ?? 0}{event.registration.capacity === null ? " · 未设人数上限" : ` / ${event.registration.capacity} 人`} · {event.registration.reviewRequired ? "需人工审核" : "提交后由服务器确认结果"}</p>}{beforeOpen && !closed && <p className={styles.empty}>报名尚未开始，可以先保存草稿。开放后再确认提交。</p>}{closed && <p className={styles.empty}>当前不接受新的报名修改或提交。已有报名与审核记录仍可查看。</p>}{!form && !publicState.loading && !publicState.error && <p className={styles.empty}>主办方尚未发布报名表。下一步：稍后回到本场赛事查看。</p>}{form && <form className={styles.form} onSubmit={event => { event.preventDefault(); void mutate("submit"); }}><p>{form.description}</p>{registration && data?.form && registration.formRevision !== data.form.revision && <div className={styles.empty}><p>你保存的是报名表第 {registration.formRevision} 版，主办方现为第 {data.form.revision} 版。原保存答卷保留在下面供对照。</p>{["draft", "rejected", "withdrawn"].includes(registration.status) && form.revision !== data.form.revision && <button type="button" className={styles.secondary} disabled={busy || !canEdit} onClick={adoptLatestForm}>改用最新报名表并核对</button>}{editingForm && <p>当前编辑第 {editingForm.revision} 版，尚未保存。请重新核对新增或变化的字段。</p>}<details className={styles.details}><summary>对照原保存的报名答卷</summary><dl className={styles.answer}>{registration.schema.fields.map(field => <div key={field.id}><dt>{field.label}</dt><dd>{Array.isArray(registration.answers[field.id]) ? (registration.answers[field.id] as string[]).join("、") : String(registration.answers[field.id] ?? "未填写")}</dd></div>)}</dl></details></div>}<fieldset className={styles.fieldset} disabled={!canEdit || busy}>{form.fields.length === 0 && <p className={styles.muted}>本场无需补充材料，核对后直接提交即可。</p>}{form.fields.map(field => <div key={field.id} style={{ marginBottom: 18 }}><FieldInput field={field} value={answers[field.id]} disabled={!canEdit || busy} onChange={value => { setAnswers(current => { const next = { ...current }; if (value === undefined) delete next[field.id]; else next[field.id] = value; return next; }); setDirty(true); setNotice(""); }}/></div>)}</fieldset><Feedback error={error} notice={notice}/>{error && <button className={styles.secondary} type="button" disabled={busy} onClick={() => void readLatest()}>核对服务器最新报名（会提示处理未保存输入）</button>}<div className={styles.actions}><button className={styles.secondary} type="button" disabled={!canEdit || busy || Boolean(own.error)} onClick={() => void save()}>{busy ? "正在处理…" : "保存草稿"}</button><button className={styles.button} disabled={!canEdit || beforeOpen || busy || Boolean(own.error)}>提交报名</button>{registration && ["pending", "approved"].includes(registration.status) && <button className={styles.danger} type="button" disabled={busy || own.loading || publicState.loading || Boolean(own.error)} onClick={() => void mutate("withdraw")}>撤回本场报名</button>}</div></form>}</section>;
}
