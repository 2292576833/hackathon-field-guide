"use client";
import { useState } from "react";
import type { AssignmentVersion } from "../modules/assessments/types.ts";
import type { PlanningGenerationJob } from "../modules/planning/generation-types.ts";
import type { PlanningInput, PlanVersion } from "../modules/planning/types.ts";
import { api, dateText, lines, operationKey, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, type SystemStatus } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import { JobProgress, useAction, type JobView } from "./workflow.tsx";
import styles from "./site.module.css";

export function AssignmentAi({ detail, onDraft }: { detail: ProjectDetail; onDraft: (draft: AssignmentVersion) => void }) {
  const system = useApi<SystemStatus>("/system/status"); const [targets, setTargets] = useState(detail.project.minimumDeliverable); const [jobId, setJobId] = useState(""); const [resume, setResume] = useState(""); const [replace, setReplace] = useState(false); const action = useAction();
  const readonly = detail.project.stage === "archived" || detail.membership.role !== "manager";
  return <section className={styles.panel}>
    <h2>请 AI 帮团队拟一份分工</h2><p className={styles.muted}>先让每个人选愿意负责的事，也可以身兼多项职责。管理员可请求 AI 根据官方要求、已共享意愿和时间拟草案，再核对主负责人、交付物与理由；原始私人测评不自动分享。</p>
    <Feedback error={action.error ?? system.error} notice={action.notice}/>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void action.run(async () => {
      const result = await api<{ id: string }>(`/projects/${detail.project.id}/assignment-generation-jobs`, { method: "POST", idempotencyKey: operationKey(), body: { targetDeliverables: lines(targets) } });
      setJobId(result.id); setReplace(false);
    }, "建议请求已排队，尚未采用任何分工。"); }}>
      <Field label="本次要交付的具体成果（每行一项）"><textarea required value={targets} disabled={readonly || action.busy} onChange={event => setTargets(event.target.value)}/></Field>
      <button className={styles.secondary} disabled={readonly || action.busy || !system.data?.modelConfigured || !targets.trim()}>请 AI 帮忙分工</button>
      {system.data && !system.data.modelConfigured && <p className={styles.notice}>当前模型未配置，可继续使用人工分工。</p>}
    </form>
    <details open={Boolean(jobId || action.error)}>
      <summary className={styles.summary}>查看已有分工请求（高级）</summary>
      <p className={styles.muted}>第一次拟分工不用填写编号。若保存结果尚未确认，请先核对原请求，避免重复请求。</p>
      <form className={styles.row} onSubmit={event => { event.preventDefault(); setJobId(resume.trim()); setReplace(false); }}>
        <Field label="恢复查看已有分工生成任务 ID"><input required value={resume} onChange={event => setResume(event.target.value)}/></Field><button className={styles.secondary}>查看任务</button>
      </form>
    </details>
    {jobId && <><label className={styles.check}><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)}/>载入实际结果将替换下方未保存的人工分工输入。</label>
      <JobProgress path={`/assignment-generation-jobs/${encodeURIComponent(jobId)}`} onComplete={async () => { await action.run(async () => {
        if (!replace) throw new Error("请先确认替换下方人工输入。");
        const job = await api<{ status: string; assignmentVersionId: string | null }>(`/assignment-generation-jobs/${jobId}`);
        if (job.status !== "succeeded" || !job.assignmentVersionId) throw new Error("此任务尚无可读取的成功草案。");
        onDraft(await api<AssignmentVersion>(`/assignment-versions/${job.assignmentVersionId}`));
      }, "真实分工草案已载入，请核对负责人和理由，再校验与确认。"); }}/>
    </>}
  </section>;
}

interface Current { plan: PlanVersion | null; tasksRevision: number }
export function PlanAi({ detail, onDraft }: { detail: ProjectDetail; onDraft: (draft: PlanVersion) => void }) {
  const base = `/projects/${detail.project.id}`; const system = useApi<SystemStatus>("/system/status"); const facts = useApi<PlanningInput>(`${base}/planning-input`); const current = useApi<Current>(`${base}/plans/current`); const jobs = useApi<PlanningGenerationJob[]>(`${base}/plan-generation-jobs`); const [jobId, setJobId] = useState(""); const selected = useApi<PlanningGenerationJob>(jobId ? `${base}/plan-generation-jobs/${jobId}` : null); const [goal, setGoal] = useState(detail.project.minimumDeliverable || detail.project.goal); const [instructions, setInstructions] = useState(""); const [resources, setResources] = useState(""); const [buffer, setBuffer] = useState("30"); const action = useAction();
  const readonly = detail.membership.role !== "manager" || detail.project.stage === "archived";
  const selectedExecution = (selected.data as (PlanningGenerationJob & Pick<JobView, "execution">) | null)?.execution;
  const selectedUnknown = selectedExecution?.status === "unknown" || Boolean(selected.data?.errorCode && /UNKNOWN|UNCERTAIN/.test(selected.data.errorCode));
  const jobLabels: Record<string, string> = { queued: "已排队", running: "处理中", succeeded: "已生成草案", failed: "失败", cancelled: "已取消" };
  return <section className={styles.panel}>
    <h2>AI 拆任务与估算时间</h2><p className={styles.muted}>从一开始就安排工时和依赖：能提前做的工作可以并行，依赖成果要等检查通过。建议需包含学习、环境准备、集成、测试、演示和提交缓冲；容量不足先缩小范围。AI 估算需你核对，确认后才生效。</p>
    <Feedback error={action.error ?? jobs.error ?? selected.error ?? facts.error ?? current.error} notice={action.notice}/>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void action.run(async () => {
      if (!facts.data || !current.data) throw new Error("请等待当前计划与时间事实载入。");
      const job = await api<PlanningGenerationJob>(`${base}/plan-generation-jobs`, { method: "POST", body: { goal, instructions, resourceIds: lines(resources), buffers: facts.data.deadlines.map(deadline => ({ deadlineId: deadline.id, reservedMinutes: Number(buffer), basis: "团队本次明确为提交预留的时间" })), expectedTasksRevision: current.data.tasksRevision, basePlanVersionId: current.data.plan?.id ?? null, idempotencyKey: operationKey() } });
      setJobId(job.id); await jobs.reload();
    }, "计划建议已排队，当前生效计划保留。"); }}>
      <Field label="要在本次时间内完成什么"><textarea required value={goal} disabled={readonly || action.busy} onChange={event => setGoal(event.target.value)}/></Field>
      <Field label="额外约束（选填）"><textarea value={instructions} disabled={readonly || action.busy} onChange={event => setInstructions(event.target.value)} placeholder="例如：页面草图和讲稿先并行准备，最终视频等可演示版本检查通过后再录；先保证主流程。"/></Field>
      <Field label="每个截止点的提交缓冲（分钟）"><input type="number" min="0" step="1" required value={buffer} disabled={readonly || action.busy} onChange={event => setBuffer(event.target.value)}/></Field>
      <details open={Boolean(resources.trim())}><summary className={styles.summary}>指定已审核资源（高级，选填）</summary>
        <p className={styles.muted}>不了解资源编号时可以留空；仍可在工具与资料库查看名称和用途。</p>
        <Field label="已审核资源 ID（选填，每行一个）"><textarea value={resources} disabled={readonly || action.busy} onChange={event => setResources(event.target.value)}/></Field>
      </details>
      <button className={styles.secondary} disabled={readonly || action.busy || !system.data?.modelConfigured || !facts.data?.deadlines.length || !current.data}>请求 AI 计划建议</button>
      {system.data && !system.data.modelConfigured && <p className={styles.notice}>当前模型未配置，请使用人工任务草案。</p>}
    </form>
    <details open={Boolean(jobId || jobs.data?.length || jobs.error || action.error)}>
      <summary className={styles.summary}>查看已有计划请求（高级）</summary>
      <p className={styles.muted}>已有请求的状态和结果在这里继续查看。保存结果尚未确认时，先核对已有请求，避免再次生成。</p>
      <Field label="查看已有 AI 计划任务"><select value={jobId} onChange={event => setJobId(event.target.value)}><option value="">请选择</option>{jobs.data?.map(job => <option key={job.id} value={job.id}>{jobLabels[job.status] ?? job.status} · {dateText(job.createdAt)} · {job.id.slice(0, 8)}</option>)}</select></Field>
      <button type="button" className={styles.secondary} disabled={jobs.loading} onClick={() => void jobs.reload()}>读取已有计划请求</button>
      {jobs.data?.length === 0 && <Empty>没有已保存的计划生成请求。</Empty>}
    </details>
    {jobId && <><JobProgress path={`${base}/plan-generation-jobs/${jobId}`} onComplete={async () => { await action.run(async () => {
      const job = await api<PlanningGenerationJob>(`${base}/plan-generation-jobs/${jobId}`);
      if (job.status !== "succeeded" || !job.resultPlanId) throw new Error("该任务尚无成功生成的草案。");
      const history = await api<PlanVersion[]>(`${base}/plan-versions`); const draft = history.find(plan => plan.id === job.resultPlanId);
      if (!draft) throw new Error("未找到生成的计划，请刷新后重试。");
      onDraft(draft); await selected.reload();
    }, "实际草案已载入下方，请检查全部任务、变更与校验问题再确认。"); }}/>
      {selectedUnknown && <p className={styles.notice}>本次结果尚未核实，当前请求不能直接重试；请先刷新状态核对。</p>}
      <div className={styles.actions}>{selected.data?.status === "failed" && <button className={styles.secondary} disabled={readonly || action.busy || selectedUnknown} onClick={() => void action.run(async () => {
        await api(`${base}/plan-generation-jobs/${jobId}/retry`, { method: "POST", body: { expectedRevision: selected.data!.revision } }); await selected.reload(); await jobs.reload();
      })}>按当前失败版本重试</button>}
      {selected.data && ["queued", "running"].includes(selected.data.status) && <button className={styles.secondary} disabled={readonly || action.busy} onClick={() => void action.run(async () => {
        await api(`${base}/plan-generation-jobs/${jobId}/cancel`, { method: "POST", body: { expectedRevision: selected.data!.revision } }); await selected.reload(); await jobs.reload();
      })}>取消此生成任务</button>}</div>
    </>}
  </section>;
}
