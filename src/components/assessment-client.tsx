"use client";
import { useEffect, useRef, useState } from "react";
import type { AssessmentAnswer, AssessmentAttempt, AssessmentScore, DimensionResult, QuestionSet, ScoringJob, TaskDimension } from "../modules/assessments/types.ts";
import { ApiError, api, dateText, isUnknownAiOutcome, lines, operationKey, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, type SystemStatus } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import type { MemberIntention, MyIntentionView, ProjectDuty, SharedIntentionsView } from "../modules/projects/collaboration.ts";
import type { ParticipantProfile } from "../shared/participant.ts";
import { appendParticipantExperience, createParticipantExperienceRequestGuard, participantExperienceContextMatches, participantExperienceText, type ParticipantExperienceContext } from "../modules/projects/participant-experience.ts";
import type { RoleHelpService } from "../modules/assessments/role-help.ts";
import { memberLabel } from "./member-display.ts";
import { JobProgress, useAction } from "./workflow.tsx";
import styles from "./site.module.css";

const dimensions: Record<TaskDimension, string> = { requirements: "需求梳理", design: "设计", development: "开发", testing: "测试", documentation: "文档", presentation: "路演" };
const duties = {
  requirements: ["梳理需求", "把要解决的问题、比赛要求和最小作品说清楚"],
  design: ["设计界面", "做页面草图、配色和评委看得懂的操作流程"],
  development: ["做出核心功能", "实现能体验或演示的作品流程"],
  testing: ["测试与检查", "验证流程可用，记录并复查问题"],
  documentation: ["整理材料", "写说明、准备提交文档和视频脚本"],
  presentation: ["准备路演", "整理讲稿、演示步骤和答辩准备"],
  coordination: ["协调队伍", "跟进时间、交接和需要协助的地方"],
  other: ["其他工作", "在下面写出愿意交付的具体成果"],
} as const;
const emptyIntention = () => ({ duties: [] as ProjectDuty[], experience: "", wantsAiHelp: false, helpQuestion: "",
  share: { duties: false, experience: false, wantsAiHelp: false, helpQuestion: false } });
const intentionInput = (value: MemberIntention | null) => value ? {
  duties: [...value.duties], experience: value.experience, wantsAiHelp: value.wantsAiHelp,
  helpQuestion: value.helpQuestion, share: { ...value.share },
} : emptyIntention();

export function MemberIntentionsPanel({ detail, onProjectChange }: { detail: ProjectDetail; onProjectChange?: () => Promise<void> }) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}`;
  const mine = useApi<MyIntentionView>(`${base}/my-intention`);
  const shared = useApi<SharedIntentionsView>(`${base}/shared-intentions`);
  return <>
    <section className={styles.panel} id="my-duties"><h2>先选自己愿意做的事</h2>
      <p className={styles.muted}>可以多选、随时调整。这里记录本次空间的意愿，不会改写你的私人画像或测评结果，也不要求先做测评。</p>
      <Feedback error={mine.error}/>{mine.loading && !mine.data && <Loading/>}
      {mine.error && <p className={styles.notice}>暂时无法读取本人职责记录。管理员仍可手动安排任务；本人输入只有保存成功后才会成为空间记录。</p>}
      {mine.data?.projectId === detail.project.id && (!mine.data.intention || mine.data.intention.userId === detail.membership.userId) && <MemberIntentionForm key={`${detail.project.id}:${detail.membership.membershipId}:${detail.membership.userId}`} detail={detail} value={mine.data} refresh={mine.reload} onSaved={async value => { mine.setData(value); window.dispatchEvent(new Event("hackathon:project-input-changed")); await onProjectChange?.(); await shared.reload(); }}/>} 
    </section>
    <section className={styles.panel}><h2>队友明确共享的意愿</h2>
      <p className={styles.muted}>只显示本人选为队内可见的字段。没有共享不代表没有经验或不愿意负责；每个交付物仍需要管理员与成员确认负责人。</p>
      <Feedback error={shared.error}/>{shared.loading && !shared.data && <Loading/>}
      <button className={styles.secondary} type="button" disabled={shared.loading} onClick={() => void shared.reload()}>读取队友最新意愿</button>
      {shared.data?.intentions.length === 0 && <Empty>还没有队友共享意愿。可以先讨论，或在上方勾选自己的共享范围。</Empty>}
      <ul className={styles.list}>{shared.data?.intentions.map(item => {
        const member = detail.members.find(value => value.userId === item.userId);
        return <li key={item.userId}><strong>{member ? memberLabel(member, detail.membership.userId, detail.members) : "成员身份需重新核对"}</strong>
          {item.duties !== undefined && <p>愿意做：{item.duties.map(duty => duties[duty][0]).join("、") || "尚未选择具体职责"}</p>}
          {item.experience !== undefined && <p>本人提供的经验：{item.experience || "未填写"}</p>}
          {item.wantsAiHelp !== undefined && <p>{item.wantsAiHelp ? "希望 AI 帮助判断职责" : "目前可以自行选择职责"}</p>}
          {item.helpQuestion !== undefined && <p>希望协助：{item.helpQuestion || "未填写"}</p>}
          <p className={styles.muted}>意愿版本 {item.revision} · 更新于 {dateText(item.updatedAt)}</p>
        </li>;
      })}</ul>
    </section>
  </>;
}

function MemberIntentionForm({ detail, value, refresh, onSaved }: {
  detail: ProjectDetail; value: MyIntentionView; refresh: () => Promise<void>;
  onSaved: (value: MyIntentionView) => Promise<void>;
}) {
  const [baseline, setBaseline] = useState(value);
  const [input, setInput] = useState(() => intentionInput(value.intention));
  const action = useAction();
  const dirty = JSON.stringify(input) !== JSON.stringify(intentionInput(baseline.intention));
  const changed = (value.intention?.revision ?? 0) !== (baseline.intention?.revision ?? 0) || value.membershipRevision !== baseline.membershipRevision;
  const readonly = value.readonly || detail.project.stage === "archived";
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function loadLatest() {
    if (dirty && !window.confirm("读取最新版本会替换尚未保存的意愿输入。是否继续？")) return;
    setBaseline(value); setInput(intentionInput(value.intention)); action.setNotice("已载入服务器最新版本。");
  }
  return <>
    <p className={styles.muted}>{baseline.intention ? `本人意愿版本 ${baseline.intention.revision} · 更新于 ${dateText(baseline.intention.updatedAt)}` : "还没有保存本次空间的职责意愿。"}</p>
    {value.needsConfirmation && <p className={styles.notice}>成员身份已有变化，旧的共享选择暂停使用。请核对意愿和共享范围，再明确保存。</p>}
    {changed && <p className={styles.notice}>本人意愿或成员身份已有新版本。本地输入保留，请读取新版本并核对后再保存。</p>}
    <form className={styles.form} onSubmit={event => {
      event.preventDefault(); void action.run(async () => {
        const next = await api<MyIntentionView>(`/projects/${encodeURIComponent(detail.project.id)}/my-intention`, {
          method: "PUT", body: { expectedRevision: baseline.intention?.revision ?? 0, ...input },
        });
        setBaseline(next); setInput(intentionInput(next.intention)); await onSaved(next);
      }, "本次意愿与共享范围已保存。团队确认分工后才成为正式任务安排。");
    }}>
      <fieldset disabled={readonly || action.busy}><legend>愿意负责的工作（可多选）</legend>
        {Object.entries(duties).map(([duty, [label, description]]) => <label className={styles.check} key={duty}>
          <input type="checkbox" checked={input.duties.includes(duty as ProjectDuty)} onChange={event => setInput(previous => ({ ...previous, duties: event.target.checked ? [...previous.duties, duty as ProjectDuty] : previous.duties.filter(value => value !== duty) }))}/>
          <span><strong>{label}</strong> · {description}</span>
        </label>)}
      </fieldset>
      <Field label="做过什么，或希望从哪里开始（选填）" hint="写实际经历或想交出的成果。默认只由本人查看。"><textarea maxLength={2000} value={input.experience} disabled={readonly || action.busy} onChange={event => setInput({ ...input, experience: event.target.value })}/></Field>
      <ParticipantExperienceReference context={{ projectId: detail.project.id, userId: detail.membership.userId, membershipId: detail.membership.membershipId,
        membershipRevision: value.membershipRevision, intentionRevision: value.intention?.revision ?? 0,
        editable: !readonly && !changed && !action.busy && detail.membership.status === "active" }} onRecheck={refresh} onAdopt={text => {
          const result = appendParticipantExperience(input, text);
          if (result.status === "applied") { setInput(result.draft); action.setNotice("已把预览追加到本人经验草稿，尚未保存或共享。经验共享已取消勾选；如需队友和分工 AI 查看，请核对后重新勾选并保存。"); }
          return result.status;
        }}/>
      <label className={styles.check}><input type="checkbox" checked={input.wantsAiHelp} disabled={readonly || action.busy} onChange={event => setInput({ ...input, wantsAiHelp: event.target.checked })}/>我不确定，请 AI 帮我判断</label>
      <Field label="想解决的疑问或需要的协助（选填）"><textarea maxLength={2000} value={input.helpQuestion} disabled={readonly || action.busy} onChange={event => setInput({ ...input, helpQuestion: event.target.value })} placeholder="例如：我会一点页面开发，但不确定这次先做界面还是整理测试。"/></Field>
      <fieldset disabled={readonly || action.busy}><legend>明确选择队友和分工 AI 能看到的字段</legend>
        <p className={styles.muted}>私有字段不会自动进入团队分工。取消全部勾选并保存可撤回共享；已有正式分工的历史事实保留。</p>
        {([ ["duties", "愿意负责的工作"], ["experience", "本人提供的经验"], ["wantsAiHelp", "是否希望 AI 协助"], ["helpQuestion", "希望解决的疑问"] ] as const).map(([field, label]) => <label className={styles.check} key={field}>
          <input type="checkbox" checked={input.share[field]} onChange={event => setInput({ ...input, share: { ...input.share, [field]: event.target.checked } })}/>{label}
        </label>)}
      </fieldset>
      <Feedback error={action.error} notice={action.notice}/>
      <div className={styles.actions}><button className={styles.button} disabled={readonly || action.busy || changed || (!dirty && !value.needsConfirmation)}>保存本人意愿与共享范围</button>
        <button type="button" className={styles.secondary} disabled={action.busy} onClick={() => void refresh()}>检查本人新版本</button>
        {changed && <button type="button" className={styles.secondary} disabled={action.busy} onClick={loadLatest}>载入最新版本</button>}
      </div>
      {dirty && <p className={styles.muted}>有未保存输入。读取队友意愿和 AI 建议不会替换这些内容。</p>}
    </form>
    {readonly ? <p className={styles.muted}>归档空间只读，意愿仅能由成员本人修改。</p> : input.wantsAiHelp && <RoleHelpPanel detail={detail} initialExperience={input.experience} initialInterests={input.duties.map(duty => duties[duty][0]).join("、")} initialConstraints={input.helpQuestion}
      onChoose={duty => { setInput(previous => ({ ...previous, duties: previous.duties.includes(duty) ? previous.duties : [...previous.duties, duty] })); action.setNotice("已把建议填入本人意愿，尚未保存或共享。请检查后保存。"); }}/>} 
  </>;
}

function ParticipantExperienceReference({ context, onAdopt, onRecheck }: {
  context: ParticipantExperienceContext;
  onAdopt: (text: string) => ReturnType<typeof appendParticipantExperience>["status"];
  onRecheck: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<{ text: string; context: ParticipantExperienceContext; revision: number; updatedAt: string | null } | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState<Error | null>(null); const [notice, setNotice] = useState("");
  const [requestGuard] = useState(createParticipantExperienceRequestGuard); const controller = useRef<AbortController | null>(null);
  const current = useRef(context); current.current = context;
  const adopt = useRef(onAdopt); adopt.current = onAdopt;
  useEffect(() => {
    const clear = () => { requestGuard.invalidate(); controller.current?.abort(); setPreview(null); setPending(false); setError(null); setNotice(""); };
    clear(); window.addEventListener("hackathon:unauthenticated", clear);
    return () => { requestGuard.invalidate(); controller.current?.abort(); window.removeEventListener("hackathon:unauthenticated", clear); };
  }, [context.projectId, context.userId, context.membershipId, context.membershipRevision, context.intentionRevision, context.editable]);

  async function read(accept: boolean) {
    if (!current.current.editable || pending || (accept && !preview)) return;
    const source = accept ? preview!.context : { ...current.current };
    const chosenText = preview?.text ?? "";
    const request = requestGuard.begin(); controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15000);
    setPending(true); setError(null); setNotice("");
    try {
      const [profile, fresh] = await Promise.all([
        api<ParticipantProfile>("/me/participant-profile", { signal: abort.signal }),
        api<MyIntentionView>(`/projects/${encodeURIComponent(source.projectId)}/my-intention`, { signal: abort.signal }),
      ]);
      if (!requestGuard.isCurrent(request) || abort.signal.aborted) return;
      if (!participantExperienceContextMatches(source, current.current, profile.userId, fresh)) {
        setPreview(null); void onRecheck();
        throw new Error("账号、空间权限或本人意愿已变化，原预览未被带入。请检查最新版本后重新读取本人经验；已有输入保留。");
      }
      if (accept) {
        if (profile.revision !== preview!.revision) { setPreview(null); throw new Error("本人画像已更新，原预览未被带入。请重新读取并核对；已有输入保留。"); }
        const result = adopt.current(chosenText);
        if (result === "too_long") { setNotice("追加后会超过经验的 2000 字上限。请删减下方预览，或自行整理上方经验草稿，再带入；已有文字不会被截断。"); return; }
        if (result === "empty") { setNotice("请先在预览中保留要带入的实际经验。"); return; }
        if (result === "duplicate") { setNotice("草稿中已经有这段经验，未重复追加，已有输入和共享选择保留。"); return; }
        setPreview(null); setNotice("已追加到上方草稿，尚未保存或共享。请核对经验和共享选择后再保存本人意愿。");
      } else {
        const text = participantExperienceText(profile);
        if (!text) { setPreview(null); setNotice("本人画像还没有开发经历、技能或路演经历。可以直接填写上方经验，或到账号资料补充后再读取。"); return; }
        setPreview({ text, context: source, revision: profile.revision, updatedAt: profile.updatedAt });
        setNotice("已读取本人画像供预览，上方经验和共享选择尚未改变。");
      }
    } catch (reason) {
      if (!requestGuard.isCurrent(request)) return;
      if (abort.signal.aborted) { setError(new Error("读取本人经验超时，已有输入保留。可以重试，或直接填写上方经验。")); return; }
      setError(reason instanceof Error ? reason : new Error("本人经验暂时无法读取，已有输入保留。"));
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { setPreview(null); void onRecheck(); }
    } finally { clearTimeout(timer); if (requestGuard.isCurrent(request)) setPending(false); }
  }

  return <div className={styles.card}>
    <p className={styles.muted}>本人画像可以提供经验参考。先预览、按本次参赛修改，再明确带入；不会替你选择职责或改写私人画像。</p>
    <button type="button" className={styles.secondary} disabled={!context.editable || pending} onClick={() => void read(false)}>{pending ? "正在核对本人经验与空间权限…" : preview ? "重新读取本人经验预览" : "带入本人经验"}</button>
    <Feedback error={error} notice={notice}/>
    {preview && context.editable && <>
      <p className={styles.muted}>来源：本人账号画像 · 版本 {preview.revision} · 保存于 {dateText(preview.updatedAt)}</p>
      <Field label="带入前的经验预览（可编辑）" hint="这里只预览本人主动填写的开发经历、技能和路演经历。追加会保留上方已有文字，取消经验的共享勾选；其余共享选择保持原样。"><textarea rows={5} maxLength={2000} value={preview.text} disabled={pending} onChange={event => setPreview({ ...preview, text: event.target.value })}/></Field>
      <p className={styles.muted}>预览 {preview.text.length} / 2000 字；追加后的上方经验也需在 2000 字内。</p>
      {preview.text.length > 2000 && <p className={styles.notice}>预览超过上限，请先编辑删减。已有经验和未保存文字不会被截断。</p>}
      <div className={styles.actions}><button type="button" className={styles.secondary} disabled={pending || !preview.text.trim() || preview.text.length > 2000} onClick={() => void read(true)}>把预览追加到经验草稿</button>
        <button type="button" className={styles.secondary} disabled={pending} onClick={() => { setPreview(null); setError(null); setNotice("已取消带入，已有经验和共享选择保留。"); }}>取消带入</button></div>
    </>}
  </div>;
}

type RoleHelpView = Awaited<ReturnType<RoleHelpService["getJob"]>>;
function roleHelpUncertain(value: RoleHelpView | null | undefined) {
  return value?.execution?.status === "unknown" || Boolean(value?.failureCode && /UNKNOWN|UNCERTAIN|TIMEOUT|HOLD|LEASE_LOST|IN_PROGRESS/.test(value.failureCode));
}

export function RoleHelpPanel({ detail, initialExperience, initialInterests, initialConstraints, onChoose }: {
  detail: ProjectDetail; initialExperience: string; initialInterests: string; initialConstraints: string;
  onChoose: (duty: TaskDimension) => void;
}) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}/role-help`;
  const latest = useApi<{ job: RoleHelpView | null }>(`${base}/latest`);
  const [jobId, setJobId] = useState(""); const selected = useApi<RoleHelpView>(jobId ? `/role-help-jobs/${encodeURIComponent(jobId)}` : null);
  const [answers, setAnswers] = useState({ experience: "", interests: "", constraints: "" });
  const [unknownKey, setUnknownKey] = useState(""); const action = useAction();
  const job = jobId ? selected.data : latest.data?.job;
  const waiting = [job, latest.data?.job].some(value => value && ["queued", "running"].includes(value.status));
  const uncertain = [job, latest.data?.job].some(roleHelpUncertain);
  const readonly = detail.project.stage === "archived";
  const terminalNames = { queued: "已排队", running: "正在分析", succeeded: "已生成本人建议", failed: "未完成", unknown: "调用结果待核实" };
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (document.visibilityState !== "visible") return;
      timer = setInterval(() => { if (document.visibilityState === "visible") { void latest.reload(); if (jobId) void selected.reload(); } }, 4000);
    };
    sync(); document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [waiting, jobId, selected.reload, latest.reload]);
  useEffect(() => {
    if (unknownKey && latest.data?.job?.idempotencyKey === unknownKey) { setJobId(latest.data.job.id); setUnknownKey(""); }
  }, [unknownKey, latest.data]);
  useEffect(() => {
    const reload = () => { if (document.visibilityState === "visible") { void latest.reload(); if (jobId) void selected.reload(); } };
    window.addEventListener("hackathon:project-input-changed", reload);
    return () => window.removeEventListener("hackathon:project-input-changed", reload);
  }, [latest.reload, selected.reload, jobId]);
  return <section className={styles.panel} aria-labelledby="role-help-heading">
    <h3 id="role-help-heading">我不确定，请 AI 帮我判断</h3>
    <p className={styles.muted}>回答三个小问题即可，不需要正式测评。回答和建议仅本人可见；选择建议只会填入上方草稿，再由你决定保存及共享哪些字段。</p>
    <Feedback error={action.error || selected.error || latest.error} notice={action.notice}/>
    {latest.loading && !latest.data && <Loading/>}
    {latest.error && <p className={styles.notice}>本人 AI 职责帮助暂时无法读取，可以直接自选职责。只有服务端返回实际结果后，才会显示建议。</p>}
    <form className={styles.form} onSubmit={event => {
      event.preventDefault(); const key = operationKey();
      void action.run(async () => {
        try {
          const next = await api<RoleHelpView>(`${base}-jobs`, { method: "POST", body: { answers }, idempotencyKey: key });
          setJobId(next.id); setUnknownKey(""); await latest.reload();
          action.setNotice("请求已保存。建议尚未成为本人意愿或团队分工。");
        } catch (reason) {
          const knownUnavailable = reason instanceof ApiError && ["MODEL_UNAVAILABLE", "MODEL_NOT_CONFIGURED", "INVALID_MODEL_CONFIG"].includes(reason.code);
          if (!knownUnavailable && isUnknownAiOutcome(reason)) { setUnknownKey(key); action.setNotice("请求结果尚未确认，本页不会重复派发。先读取已保存请求；仍可以手动选择职责。"); }
          throw reason;
        }
      });
    }}>
      <button className={styles.secondary} type="button" disabled={readonly || action.busy} onClick={() => {
        if (Object.values(answers).some(value => value.trim()) && !window.confirm("带入会替换这三个问题的未提交输入。是否继续？")) return;
        setAnswers({ experience: initialExperience.slice(0, 2000), interests: initialInterests.slice(0, 2000), constraints: initialConstraints.slice(0, 2000) });
      }}>把上方本人草稿带入这三个问题</button>
      <Field label="你做过什么，或用过什么工具"><textarea maxLength={2000} value={answers.experience} disabled={readonly || action.busy} onChange={event => setAnswers({ ...answers, experience: event.target.value })}/></Field>
      <Field label="这次想尝试什么，或愿意交出什么"><textarea maxLength={2000} value={answers.interests} disabled={readonly || action.busy} onChange={event => setAnswers({ ...answers, interests: event.target.value })}/></Field>
      <Field label="有什么顾虑，需要哪种协助"><textarea maxLength={2000} value={answers.constraints} disabled={readonly || action.busy} onChange={event => setAnswers({ ...answers, constraints: event.target.value })}/></Field>
      <button className={styles.button} disabled={readonly || action.busy || waiting || uncertain || Boolean(unknownKey) || latest.loading || Boolean(latest.error) || !Object.values(answers).some(value => value.trim())}>请 AI 生成本人职责建议</button>
    </form>
    {unknownKey && <p className={styles.notice}>请求是否保存还未核实。输入保留，不自动重新请求；请读取最近请求核对。</p>}
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={action.busy || latest.loading || selected.loading} onClick={() => { void latest.reload(); if (jobId) void selected.reload(); }}>读取已保存请求与结果</button>
      {jobId && latest.data?.job && latest.data.job.id !== jobId && <button className={styles.secondary} type="button" onClick={() => setJobId(latest.data!.job!.id)}>查看本人最近一次请求</button>}
    </div>
    {job && <>
      <p aria-live="polite"><span className={styles.tag}>{roleHelpUncertain(job) ? "调用结果待核实" : terminalNames[job.status]}</span>请求于 {dateText(job.createdAt)}</p>
      {job.failureCode && <p className={styles.muted}>本次状态：{job.failureCode}</p>}
      {uncertain && <p className={styles.notice}>{roleHelpUncertain(job) ? "本次模型请求" : "本人最近一次模型请求"}结果未知，服务端保留记录，不能自动重发。</p>}
      {job.inputFreshness === "changed" && <p className={styles.notice}>{job.staleReason ?? "比赛要求或成员输入已变化。此结果保留作历史，重新核对后再决定职责。"}</p>}
      {job.status === "succeeded" && job.result && <>
        <div className={styles.cards}>{job.result.suggestions.map((suggestion, index) => <article className={styles.card} key={`${suggestion.taskDimension}:${index}`}>
          <h4>{suggestion.title}</h4><p>建议交付：{suggestion.deliverable}</p><p>为什么适合尝试：{suggestion.reason}</p><p>第一步：{suggestion.firstStep}</p>
          <button className={styles.secondary} type="button" disabled={readonly || job.inputFreshness !== "current"} onClick={() => onChoose(suggestion.taskDimension)}>把“{dimensions[suggestion.taskDimension]}”填入本人意愿</button>
        </article>)}</div>
        {job.result.missingInformation.length > 0 && <p className={styles.notice}>还需了解：{job.result.missingInformation.join("；")}</p>}
        <p className={styles.muted}>{job.result.limitations.join("；")} · 模型 {job.result.modelVersion}</p>
      </>}
    </>}
  </section>;
}
interface Report { attempt: AssessmentAttempt; scores: AssessmentScore[]; dimensionResults: { scoreId: string; dimensions: DimensionResult[] }[]; scoreMeaning: string }
export function AssessmentPanel({ detail }: { detail: ProjectDetail }) {
  const catalog = useApi<{ items: QuestionSet[] }>("/assessment-question-sets"); const attempts = useApi<{ items: AssessmentAttempt[] }>(`/projects/${detail.project.id}/assessment-attempts`); const [selected, setSelected] = useState(""); const report = useApi<Report>(selected ? `/assessment-attempts/${selected}/report` : null); const status = useApi<SystemStatus>("/system/status"); const action = useAction(); const [questionSetId, setQuestionSetId] = useState("");
  return <section className={styles.panel}><h2>可选：本人测评</h2><p className={styles.muted}>原始回答只由你查看。评分说明本次题组的表现，不能推算真实能力或完工速度。你可以直接选择职责，再由空间管理员安排任务；无需先完成测评。</p><Feedback error={catalog.error ?? attempts.error ?? report.error ?? action.error} notice={action.notice}/>{(catalog.loading || attempts.loading || report.loading) && <Loading/>}
    <div className={styles.grid}><form className={styles.form} onSubmit={event => { event.preventDefault(); void action.run(async () => { const attempt = await api<AssessmentAttempt>(`/projects/${detail.project.id}/assessment-attempts`, { method: "POST", body: { questionSetId } }); setSelected(attempt.id); await attempts.reload(); }); }}><Field label="已发布题组"><select required value={questionSetId} onChange={event => setQuestionSetId(event.target.value)}><option value="">请选择题组</option>{catalog.data?.items.map(set => <option value={set.id} key={set.id}>{set.difficultyLabel} · 版本 {set.version}</option>)}</select></Field><button className={styles.secondary} disabled={action.busy || detail.project.stage === "archived" || !questionSetId}>开始本人测评</button>{catalog.data?.items.length === 0 && <Empty>还没有正式发布的题组，待审核题目不会用于真实评分。</Empty>}</form><Field label="继续已有本人测评"><select value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择</option>{attempts.data?.items.map(attempt => <option value={attempt.id} key={attempt.id}>{attempt.questionSetSnapshot.difficultyLabel} · {attempt.status} · {attempt.id.slice(0, 8)}</option>)}</select></Field></div>
    {report.data && <AttemptEditor key={`${report.data.attempt.id}:${report.data.attempt.revision}`} report={report.data} readonly={detail.project.stage === "archived"} modelConfigured={Boolean(status.data?.modelConfigured)} reload={async () => { await report.reload(); await attempts.reload(); }}/>} 
  </section>;
}
function AttemptEditor({ report, readonly, modelConfigured, reload }: { report: Report; readonly: boolean; modelConfigured: boolean; reload: () => Promise<void> }) {
  const attempt = report.attempt; const base = `/assessment-attempts/${attempt.id}`; const action = useAction();
  const [profile, setProfile] = useState(attempt.profile);
  const [answers, setAnswers] = useState<AssessmentAnswer[]>(attempt.questionSetSnapshot.questions.map(question => attempt.answers.find(answer => answer.questionId === question.id) ?? { questionId: question.id, text: "", aiUsage: "", evidence: [] }));
  const [followUps, setFollowUps] = useState(attempt.followUps.map(item => ({ id: item.id, answer: item.answer ?? "" })));
  const [sharing, setSharing] = useState(attempt.sharing); const [correction, setCorrection] = useState(""); const [jobId, setJobId] = useState(attempt.activeJobId ?? "");
  const editable = !readonly && ["draft", "in_progress"].includes(attempt.status);
  const initialSignature = JSON.stringify({ profile: attempt.profile, answers: attempt.questionSetSnapshot.questions.map(question => attempt.answers.find(answer => answer.questionId === question.id) ?? { questionId: question.id, text: "", aiUsage: "", evidence: [] }), followUps: attempt.followUps.map(item => ({ id: item.id, answer: item.answer ?? "" })) });
  const dirty = JSON.stringify({ profile, answers, followUps }) !== initialSignature;
  function change(questionId: string, patch: Partial<AssessmentAnswer>) { setAnswers(answers.map(answer => answer.questionId === questionId ? { ...answer, ...patch } : answer)); }
  return <><p><span className={styles.tag}>仅本人</span><span className={styles.tag}>{attempt.status} · 版本 {attempt.revision}</span></p><p className={styles.notice}>允许工具：{attempt.questionSetSnapshot.allowedTools.join("、") || "按题组说明"}。{attempt.questionSetSnapshot.limitations.join("；")}</p><Feedback error={action.error} notice={action.notice}/>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api(base + "/answers", { method: "PATCH", body: { expectedRevision: attempt.revision, profile: { ...profile, tools: profile.tools.map(tool => tool.trim()).filter(Boolean) }, answers, followUpAnswers: followUps } }); await reload(); }, "本人回答草稿已保存。"); }}>
      <Field label="你做过什么项目或任务"><textarea value={profile.experience} disabled={!editable || action.busy} onChange={event => setProfile({ ...profile, experience: event.target.value })}/></Field><Field label="使用过的工具（每行一个）"><textarea value={profile.tools.join("\n")} disabled={!editable || action.busy} onChange={event => setProfile({ ...profile, tools: event.target.value.split("\n") })}/></Field><div><p>你愿意负责哪些任务</p>{Object.entries(dimensions).map(([dimension, label]) => <label className={styles.check} key={dimension}><input type="checkbox" disabled={!editable || action.busy} checked={profile.preferredTasks.includes(dimension as TaskDimension)} onChange={event => setProfile({ ...profile, preferredTasks: event.target.checked ? [...profile.preferredTasks, dimension as TaskDimension] : profile.preferredTasks.filter(value => value !== dimension) })}/>{label}</label>)}</div>
      {attempt.questionSetSnapshot.questions.map((question, index) => { const answer = answers.find(item => item.questionId === question.id)!; return <section className={styles.card} key={question.id}><h3>问题 {index + 1}</h3><p>{question.prompt}</p><Field label="你的回答"><textarea required={question.required} disabled={!editable || action.busy} value={answer.text} onChange={event => change(question.id, { text: event.target.value })}/></Field><Field label="AI 帮助了哪些部分（没有使用也请注明）"><input disabled={!editable || action.busy} value={answer.aiUsage} onChange={event => change(question.id, { aiUsage: event.target.value })}/></Field><Field label="作品或验证证据（选填，填写实际依据）"><textarea disabled={!editable || action.busy} value={answer.evidence[0]?.text ?? ""} onChange={event => change(question.id, { evidence: event.target.value ? [{ id: answer.evidence[0]?.id ?? operationKey(), kind: "work_sample", text: event.target.value, url: answer.evidence[0]?.url ?? null }] : [] })}/></Field>{answer.evidence.length > 0 && <Field label="作品证据 HTTP(S) 链接（选填）"><input type="url" disabled={!editable || action.busy} value={answer.evidence[0]?.url ?? ""} onChange={event => change(question.id, { evidence: answer.evidence.map((item, i) => i === 0 ? { ...item, url: event.target.value || null } : item) })}/></Field>}<div className={styles.actions}>{question.criterionIds.map(id => <button key={id} type="button" className={styles.secondary} disabled={!editable || action.busy || dirty || attempt.followUps.some(item => item.questionId === question.id && item.criterionId === id)} onClick={() => void action.run(async () => { await api(base + "/follow-ups", { method: "POST", body: { expectedRevision: attempt.revision, questionId: question.id, criterionId: id } }); await reload(); })}>补充“{attempt.rubricSnapshot.criteria.find(item => item.id === id)?.label ?? id}”追问</button>)}</div></section>; })}
      {attempt.followUps.map(item => <Field key={item.id} label={item.prompt}><textarea disabled={!editable || action.busy} value={followUps.find(answer => answer.id === item.id)?.answer ?? ""} onChange={event => setFollowUps(followUps.map(answer => answer.id === item.id ? { ...answer, answer: event.target.value } : answer))}/></Field>)}
      <button className={styles.button} disabled={!editable || action.busy || !dirty}>保存回答草稿</button>
    </form>
    {dirty && <p className={styles.notice}>回答有未保存修改。先保存，再提交评分、添加追问或改变分享范围。</p>}
    <div className={styles.actions}><button className={styles.secondary} disabled={readonly || action.busy || dirty || !modelConfigured || !["draft", "in_progress", "scoring_failed"].includes(attempt.status)} onClick={() => void action.run(async () => { const job = await api<ScoringJob>(base + "/submit", { method: "POST", body: { expectedRevision: attempt.revision }, idempotencyKey: operationKey() }); setJobId(job.id); })}>提交已保存回答并评分</button><button className={styles.secondary} disabled={!editable || action.busy || dirty} onClick={() => void action.run(async () => { await api(base + "/cancel", { method: "POST", body: { expectedRevision: attempt.revision } }); await reload(); })}>取消未提交测评</button></div>{!modelConfigured && <p className={styles.muted}>模型未配置，回答可以先保存；评分入口将在真实服务配置后开放。</p>}{jobId && <JobProgress path={`/assessment-scoring-jobs/${jobId}`} onComplete={reload}/>}
    {report.scores.map(score => <section className={styles.panel} key={score.id}><h3>评分报告</h3><p>{report.scoreMeaning}</p><p className={styles.muted}>{score.modelVersion} · {score.provenance === "model" ? "模型结果" : "测试来源"}</p><ul className={styles.list}>{score.criterionScores.map(item => <li key={item.criterionId}><strong>{attempt.rubricSnapshot.criteria.find(criterion => criterion.id === item.criterionId)?.label ?? item.criterionId}</strong>：{item.state === "scored" ? item.score : item.state === "insufficient_evidence" ? "证据不足" : "不适用"}<p>{item.reason}</p><p className={styles.muted}>{item.unverified.join("；")}</p></li>)}</ul><p className={styles.notice}>{score.limitations.join("；")}</p></section>)}
    {report.scores.length > 0 && <section className={styles.panel}><h3>申请重新评估</h3><Field label="本次更正或重评的依据"><textarea value={correction} onChange={event => setCorrection(event.target.value)}/></Field><button className={styles.secondary} disabled={readonly || action.busy || !modelConfigured || !correction.trim()} onClick={() => void action.run(async () => { const job = await api<ScoringJob>(base + "/reassess", { method: "POST", body: { expectedRevision: attempt.revision, correctionReason: correction }, idempotencyKey: operationKey() }); setJobId(job.id); })}>申请重评</button></section>}
    <section className={styles.panel}><h3>主动选择队伍可见摘要</h3><p className={styles.muted}>只共享勾选的任务意愿和评分项，不共享原始回答、证据文本与评分理由。全不勾选并保存即撤回共享。</p>{Object.entries(dimensions).map(([dimension, label]) => <label className={styles.check} key={dimension}><input type="checkbox" checked={sharing.confirmedTasks.includes(dimension as TaskDimension)} onChange={event => setSharing({ ...sharing, confirmedTasks: event.target.checked ? [...sharing.confirmedTasks, dimension as TaskDimension] : sharing.confirmedTasks.filter(value => value !== dimension) })}/>{label}任务意愿</label>)}{attempt.rubricSnapshot.criteria.map(criterion => <label key={criterion.id} className={styles.check}><input type="checkbox" checked={sharing.criterionIds.includes(criterion.id)} onChange={event => setSharing({ ...sharing, criterionIds: event.target.checked ? [...sharing.criterionIds, criterion.id] : sharing.criterionIds.filter(value => value !== criterion.id) })}/>{criterion.label}评分项</label>)}<button className={styles.button} disabled={readonly || action.busy || dirty} onClick={() => void action.run(async () => { await api(base + "/sharing", { method: "PATCH", body: { expectedRevision: attempt.revision, selection: sharing } }); await reload(); }, "共享范围已更新。")}>保存共享范围</button></section>
  </>;
}
