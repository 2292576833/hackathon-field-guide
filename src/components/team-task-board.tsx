"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CurrentPlanningView, PlanningTask, PlanVersion, ProgressUpdate, TaskStatus } from "../modules/planning/types.ts";
import { dependentTaskIds, unmetDependencies, type TaskBoardGroup } from "../modules/planning/task-board.ts";
import { buildTaskGuidance, dependencyGuidance, taskResourceGuidance } from "../modules/planning/task-guidance.ts";
import { ApiError, api, dateText, lines, message, operationKey, safeLink } from "./client-api.ts";
import { Empty, Feedback, Field } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import { memberLabel } from "./member-display.ts";
import { buildHandoffProgress, emptyHandoffDraft, HANDOFF_FIELDS, HANDOFF_LIMITS, handoffSuggestions, hasHandoffInput, readHandoffProgress, type HandoffDraft } from "../modules/space-workflow/handoff.ts";
import styles from "./site.module.css";
import boardStyles from "./team-task-board.module.css";

const names: Record<TaskBoardGroup, string> = { ready: "可以开始", waiting: "等待队友 / 需要帮助", doing: "正在做", review: "待检查", done: "已完成" };
const statusNames: Record<TaskStatus, string> = { todo: "待开始", in_progress: "正在做", blocked: "遇到问题", review: "待检查", done: "已完成", cancelled: "已删减" };
type TaskPoolSnapshot = {
  plan: Pick<PlanVersion, "id" | "status" | "revision" | "reason" | "createdAt" | "basePlanVersionId" | "baseTasksRevision"> | null;
  tasks: PlanningTask[];
  inputVersionsChanged: boolean;
};
type SavedMutation = { path: string; body: Record<string, unknown>; idempotencyKey: string; notice: string; label?: string; scope: { projectId: string; membershipId: string } };
type MutationResolution = { succeeded: boolean; error: string; notice: string };
type MutationRecoveryPort = {
  remember: (request: SavedMutation) => void;
  resolve: (key: string, value: MutationResolution) => void;
  resolutions: Record<string, MutationResolution>;
};
function unknownMutation(reason: unknown): boolean {
  return !(reason instanceof ApiError) || reason.status >= 500 || reason.status === 408 || /UNKNOWN|UNCERTAIN|TIMEOUT|IN_PROGRESS|INVALID_RESPONSE/.test(reason.code);
}
function accepted(task: PlanningTask): boolean { return task.status === "done" && task.acceptance !== null; }
function ownerName(detail: ProjectDetail, id: string | null): string {
  const member = detail.members.find(value => value.membershipId === id);
  return member ? memberLabel(member, detail.membership.userId, detail.members) : id ? "原队友，请重新分配" : "还未分配";
}

type TeamTaskBoardProps = { detail: ProjectDetail; current: CurrentPlanningView | null; onSnapshot: (value: CurrentPlanningView | null) => void; initialScope?: "mine" | "team" };
/** Changing account, space or membership starts a separate view with no old inputs or requests. */
export function TeamTaskBoard(props: TeamTaskBoardProps) {
  return <TeamTaskBoardPanel key={`${props.detail.project.id}:${props.detail.membership.userId}:${props.detail.membership.membershipId}`} {...props}/>;
}

/** Only saved snapshots are read. A hidden tab cancels the read and stops polling. */
function TeamTaskBoardPanel({ detail: parentDetail, current, onSnapshot, initialScope = "mine" }: TeamTaskBoardProps) {
  const [detail, setDetail] = useState(parentDetail);
  const [progress, setProgress] = useState<ProgressUpdate[]>([]), [scope, setScope] = useState<"mine" | "team">(initialScope), [group, setGroup] = useState<TaskBoardGroup | "all">("all");
  const [error, setError] = useState(""), [checkedAt, setCheckedAt] = useState<string | null>(null), [changed, setChanged] = useState(false);
  const [accessLost, setAccessLost] = useState(false), [locatedTask, setLocatedTask] = useState<string | null>(null), [showCancelled, setShowCancelled] = useState(false);
  const [pool, setPool] = useState<TaskPoolSnapshot | null>(null);
  const [recoveryRequests, setRecoveryRequests] = useState<SavedMutation[]>([]), [resolutions, setResolutions] = useState<Record<string, MutationResolution>>({});
  const controller = useRef<AbortController | null>(null), active = useRef(true), inFlight = useRef(false), generation = useRef(0);
  const canRetainMutation = useRef(true), mutationScope = useRef({ projectId: detail.project.id, membershipId: detail.membership.membershipId });
  mutationScope.current = { projectId: detail.project.id, membershipId: detail.membership.membershipId };
  const rememberMutation = useCallback((request: SavedMutation) => {
    if (!active.current || !canRetainMutation.current || request.scope.projectId !== mutationScope.current.projectId || request.scope.membershipId !== mutationScope.current.membershipId) return;
    setRecoveryRequests(previous => previous.some(value => value.idempotencyKey === request.idempotencyKey) ? previous : [...previous, request]);
  }, []);
  const resolveMutation = useCallback((key: string, value: MutationResolution) => {
    if (!active.current || !canRetainMutation.current) return;
    setRecoveryRequests(previous => previous.filter(request => request.idempotencyKey !== key));
    setResolutions(previous => ({ ...previous, [key]: value }));
  }, []);
  const mutationRecovery: MutationRecoveryPort = { remember: rememberMutation, resolve: resolveMutation, resolutions };
  const snapshot = useRef(current); snapshot.current = current;
  const poolSnapshot = useRef(pool); poolSnapshot.current = pool;
  const clearSensitive = useCallback((reason: unknown) => {
    if (!active.current) return;
    canRetainMutation.current = false;
    controller.current?.abort(); controller.current = null; inFlight.current = false; generation.current++;
    setAccessLost(true); setError(message(reason)); onSnapshot(null); setProgress([]); setPool(null); setLocatedTask(null); setCheckedAt(null); setChanged(false); setRecoveryRequests([]); setResolutions({});
  }, [onSnapshot]);
  const refresh = useCallback(async () => {
    if (document.visibilityState !== "visible" || inFlight.current || !active.current) return;
    inFlight.current = true; const requestGeneration = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    try {
      const [next, history, currentDetail, nextPool] = await Promise.all([api<CurrentPlanningView>(`/projects/${parentDetail.project.id}/plans/current`, { signal: abort.signal }), api<ProgressUpdate[]>(`/projects/${parentDetail.project.id}/progress`, { signal: abort.signal }), api<ProjectDetail>(`/projects/${parentDetail.project.id}`, { signal: abort.signal }), api<TaskPoolSnapshot>(`/projects/${parentDetail.project.id}/task-pool`, { signal: abort.signal })]);
      if (abort.signal.aborted || !active.current || requestGeneration !== generation.current) return;
      if (snapshot.current && (snapshot.current.tasksRevision !== next.tasksRevision || snapshot.current.plan?.id !== next.plan?.id || snapshot.current.inputVersionsChanged !== next.inputVersionsChanged)) setChanged(true);
      if (poolSnapshot.current && (poolSnapshot.current.plan?.id !== nextPool.plan?.id || poolSnapshot.current.plan?.revision !== nextPool.plan?.revision || poolSnapshot.current.inputVersionsChanged !== nextPool.inputVersionsChanged)) setChanged(true);
      if (mutationScope.current.projectId !== currentDetail.project.id || mutationScope.current.membershipId !== currentDetail.membership.membershipId) { setRecoveryRequests([]); setResolutions({}); }
      canRetainMutation.current = true; onSnapshot(next); setProgress(history); setDetail(currentDetail); setPool(nextPool); setAccessLost(false); setError(""); setCheckedAt(new Date().toISOString());
    } catch (reason) {
      if (!abort.signal.aborted && active.current && requestGeneration === generation.current) {
        setError(message(reason));
        if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) clearSensitive(reason);
      }
    } finally { if (controller.current === abort) { controller.current = null; inFlight.current = false; } }
  }, [parentDetail.project.id, onSnapshot, clearSensitive]);
  useEffect(() => {
    active.current = true; let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) clearInterval(timer); timer = null; controller.current?.abort(); controller.current = null; inFlight.current = false; generation.current++; };
    const visibility = () => { stop(); if (document.visibilityState === "visible") { void refresh(); timer = setInterval(() => void refresh(), 10_000); } };
    const unauthenticated = () => { stop(); clearSensitive(new Error("登录已失效，请重新登录后打开团队空间。")); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("hackathon:unauthenticated", unauthenticated); visibility();
    return () => { active.current = false; stop(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("hackathon:unauthenticated", unauthenticated); };
  }, [refresh, clearSensitive]);
  useEffect(() => {
    if (!locatedTask) return;
    const target = document.getElementById(`task-${locatedTask}`);
    if (target && !target.hidden) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center" }); }
    setLocatedTask(null);
  }, [locatedTask, scope, group, showCancelled]);
  const activeMembershipIds = detail.members.filter(member => member.status === "active").map(member => member.membershipId);
  const { planReady, items, readyTasks } = buildTaskGuidance(accessLost ? null : current, { activeMembershipIds, membershipId: detail.membership.membershipId });
  const pendingRequests = progress.filter(update => update.correctionRequest && current?.tasks.some(task => task.id === update.taskId && task.status === "done" && task.acceptance !== null) && [...progress].reverse().find(value => value.taskId === update.taskId && value.acceptance !== null)?.id === update.correctionRequest.acceptanceProgressId);
  const displayed = items.filter(item => scope === "team" || item.task.ownerMembershipId === detail.membership.membershipId || item.task.helperEfforts.some(helper => helper.membershipId === detail.membership.membershipId) || (detail.membership.role === "manager" && pendingRequests.some(update => update.taskId === item.task.id)) || (item.task.status === "review" && (detail.membership.role === "manager" || item.task.reviewerMembershipId === detail.membership.membershipId)));
  function locate(id: string) {
    setScope("team"); setGroup("all");
    if (current?.tasks.some(task => task.id === id && task.status === "cancelled")) setShowCancelled(true);
    setLocatedTask(id);
  }
  const spaceHref = `/app/projects/${encodeURIComponent(detail.project.id)}`;
  const readonly = detail.project.stage === "archived";
  const taskPool = !accessLost && <DraftTaskPool key={`task-pool-${detail.project.id}`} detail={detail} pool={pool} refresh={refresh} onAccessLost={clearSensitive} mutationRecovery={mutationRecovery}/>;
  const recoveryPanel = !accessLost && <MutationRecoveryPanel key={`task-recovery-${detail.project.id}`} requests={recoveryRequests} onResolved={resolveMutation} refresh={refresh} onAccessLost={clearSensitive}/>;
  if (!current?.plan || accessLost) return <section id="team-task-board" className={`${styles.panel} ${boardStyles.board}`} aria-label="团队任务板">
    <h2>团队任务</h2><Feedback error={error}/>
    {accessLost ? <p className={styles.muted}>任务和进度已清除。请核对登录状态与当前空间权限后重新打开。</p> : error ? <p className={styles.muted}>任务安排暂未读取成功，请重新读取后核对。</p> : current ? detail.project.stage === "archived" ? <p className={styles.muted}>空间已归档，尚无生效计划，仅可查看已有资料。</p> : <><Empty>还没有生效计划。先选职责、核对成员时间，再确认一份任务计划。</Empty><div className={styles.actions}><a className={styles.button} href={`${spaceHref}/assessment`}>选择我的职责</a><a className={styles.link} href={`${spaceHref}/team`}>填写可用时间</a></div></> : <p className={styles.muted} role="status">正在读取任务安排…</p>}
    {recoveryPanel}{taskPool}{!accessLost && <><p className={styles.muted}>页面可见时每 10 秒读取队内任务。最近读取：{dateText(checkedAt)}</p><button type="button" className={styles.secondary} onClick={() => void refresh()}>读取最新进度</button></>}
  </section>;
  const ordered = [...items].sort((left, right) => Number(right.group === "ready" && right.task.ownerMembershipId === detail.membership.membershipId) - Number(left.group === "ready" && left.task.ownerMembershipId === detail.membership.membershipId));
  const requiredTasks = current.tasks.filter(task => task.priority === "must" && task.status !== "cancelled");
  const checkedRequired = requiredTasks.filter(accepted).length;
  const allRequiredAccepted = planReady && requiredTasks.length > 0 && checkedRequired === requiredTasks.length;
  return <section id="team-task-board" className={`${styles.panel} ${boardStyles.board}`} aria-label="团队任务板"><h2>团队任务</h2><p className={styles.muted}>提交成果后还需检查；检查通过，依赖它的任务才能开始。页面可见时每 10 秒读取队内进度。</p><Feedback error={error}/>{error && <p className={styles.muted}>下方保留上次读取的安排与输入，重新读取成功后再核对变化。</p>}{changed && <p className={styles.notice} role="status">队内安排或进度有了新版本。下方显示最新记录；正在填写的内容保留，请核对版本提示。<button type="button" className={styles.secondary} onClick={() => setChanged(false)}>知道了</button></p>}<p className={styles.muted}>最近进度：{dateText(current.lastProgressAt)} · 最近读取：{dateText(checkedAt)}</p>
    {recoveryPanel}{taskPool}<div className={boardStyles.teamSummary} role="status"><strong>{allRequiredAccepted ? "本阶段必做成果已检查齐" : "当前计划的队内进展"}</strong><p>必做成果检查通过 {checkedRequired} / {requiredTasks.length} 项 · 待检查 {current.tasks.filter(task => task.status === "review").length} 项 · 遇到问题 {current.tasks.filter(task => task.status === "blocked").length} 项</p>{allRequiredAccepted && <p>仍须核对当前版本运行结果，并按主办方要求正式提交。<a className={styles.link} href={`${spaceHref}/delivery`}>查看运行与提交记录</a></p>}<p className={styles.muted}>可选任务 {current.tasks.filter(task => task.priority === "optional" && task.status !== "cancelled").length} 项，已删减任务 {current.tasks.filter(task => task.status === "cancelled").length} 项，单独保留在计划中。</p></div>
    <h3>当前生效任务</h3>
    <div className={styles.actions}><button type="button" className={styles.secondary} aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>与我有关</button><button type="button" className={styles.secondary} aria-pressed={scope === "team"} onClick={() => setScope("team")}>全队任务</button><button type="button" className={styles.secondary} onClick={() => void refresh()}>读取最新进度</button></div>
    <div className={styles.tabs} aria-label="按状态查看"><button type="button" className={styles.secondary} aria-pressed={group === "all"} onClick={() => setGroup("all")}>全部（{displayed.length}）</button>{(Object.keys(names) as TaskBoardGroup[]).map(value => <button type="button" key={value} className={styles.secondary} aria-pressed={group === value} onClick={() => setGroup(value)}>{readonly && value === "ready" ? "待开始" : names[value]}（{displayed.filter(item => item.group === value).length}）</button>)}</div>
    {detail.project.stage === "archived" && <p className={styles.notice}>空间已归档，任务与进度仅供查看。</p>}{current.inputVersionsChanged && <p className={styles.notice}>空间资料或比赛要求、分工、可用时间有更新，请管理员重新核对计划。</p>}{current.evaluation?.feasibility === "infeasible" && <p className={styles.notice}>有任务因时间或阻塞问题不能照原计划完成，请管理员核对。未受影响、前置成果已检查且已排入工作时间的准备任务仍可先做。</p>}
    {current?.plan && !displayed.some(item => group === "all" || item.group === group) && <Empty>{scope === "mine" ? "这里暂时没有与你有关的任务，可查看全队任务或请管理员核对分工。" : "这个状态下还没有任务。"}</Empty>}
    <ul className={boardStyles.tasks}>{ordered.map(item => {
      const task = item.task, scheduled = current.evaluation?.likely.scheduled.find(value => value.taskId === task.id);
      const relevant = displayed.some(value => value.task.id === task.id);
      const waiting = dependencyGuidance(task, current.tasks), alternatives = readyTasks.filter(value => value.id !== task.id);
      const latest = [...progress].reverse().find(update => update.taskId === task.id && !update.correctionRequest && !update.acceptanceCorrection);
      return <li key={task.id} className={`${boardStyles.task} ${accepted(task) ? boardStyles.checkedTask : ""}`} hidden={!relevant || (group !== "all" && item.group !== group)} id={`task-${task.id}`} tabIndex={-1}>
        <div className={boardStyles.heading}><h3>{task.title}</h3><span className={`${styles.tag} ${accepted(task) ? boardStyles.checkedTag : ""}`}>{accepted(task) ? "✓ 检查通过" : readonly && item.group === "ready" ? "待开始" : names[item.group]}</span></div>
        <p className={boardStyles.owner}>负责人：{ownerName(detail, task.ownerMembershipId)}</p><p className={styles.muted}>计划开始：{dateText(scheduled?.startsAt)}<br/>计划完成：{dateText(scheduled?.finishesAt)}</p><p>要交什么：{task.deliverable}</p>
        {latest && <p className={boardStyles.outcome}>最近成果与进度：{latest.note || "已保存进度，请展开查看依据。"}</p>}
        {!readonly && item.group === "ready" && <p className={styles.muted}>{task.dependencyTaskIds.length ? "前置成果已检查，按计划可以开始。" : "没有等待中的前置成果，按计划可以开始。"}请结合上方安排与自己的实际可用时间。</p>}
        {waiting.length > 0 && <div className={boardStyles.waiting}><strong>还在等：</strong><ul>{waiting.map(value => <li key={value.id}>{value.missing ? <strong>{value.title}</strong> : <a className={styles.link} href={`#task-${value.id}`} onClick={() => locate(value.id)}>{value.title}</a>}<span>负责人：{ownerName(detail, value.ownerMembershipId)} · {value.statusLabel} · {value.checkLabel}</span></li>)}</ul></div>}
        {item.needs.map(need => <p key={need} className={styles.notice}>{need}</p>)}
        {!readonly && (waiting.length > 0 || task.status === "blocked") && <p className={styles.muted}>等待时你可以先做：{alternatives.length ? alternatives.map((value, index) => <span key={value.id}>{index > 0 && "、"}<a className={styles.link} href={`#task-${value.id}`} onClick={() => locate(value.id)}>{value.title}</a></span>) : "暂未找到其他已能开始的任务，可请管理员拆出准备工作或调整依赖。"}</p>}
        {task.acceptance && <p className={styles.muted}>检查通过于 {dateText(task.acceptance.acceptedAt)} · {task.acceptance.mode === "self_check" ? "本人自检" : "队内检查"}</p>}{pendingRequests.filter(update => update.taskId === task.id).map(update => <p key={update.id} className={styles.notice}>队友请求更正这次检查：{update.note} · {dateText(update.createdAt)}。当前任务状态保留，请管理员核对。</p>)}
        <TaskActions task={task} tasks={current.tasks} tasksRevision={current.tasksRevision} detail={detail} progress={progress} canStart={planReady && !item.waitingFor.length && Boolean(task.ownerMembershipId && activeMembershipIds.includes(task.ownerMembershipId)) && (task.status !== "todo" || !item.needs.length)} refresh={refresh} onAccessLost={clearSensitive} mutationRecovery={mutationRecovery} detailsContent={<>
          <p>协助：{task.helperEfforts.map(helper => ownerName(detail, helper.membershipId)).join("、") || "暂未指定"}<br/>检查者：{task.reviewerMembershipId ? ownerName(detail, task.reviewerMembershipId) : "空间管理员；没有指定检查者时，负责人可按条件自检"}</p>
          <p>怎样检查：{task.acceptanceCriteria.join("；") || "还未写清检查条件"}</p><p className={styles.muted}>预计工时：{task.durationEstimate.likelyMinutes} 分钟（{task.durationEstimate.optimisticMinutes}–{task.durationEstimate.pessimisticMinutes}）<br/>估算依据：{task.durationEstimate.basis}<br/>优先级：{task.priority === "must" ? "必须完成" : "有时间再做"}<br/>最后更新：{dateText(task.updatedAt)}</p>
          {task.acceptance && <><p>检查依据：{task.acceptance.note}</p>{task.acceptance.evidenceRefs.map((ref, index) => <Evidence key={index} value={ref}/>)}</>}
          <div className={boardStyles.resources}><h4>这项任务可用的工具与资料</h4><ul>{taskResourceGuidance(task.kind, detail.project.id).map(resource => <li key={resource.href}><a className={styles.link} href={resource.href}>{resource.title}</a><p className={styles.muted}>{resource.purpose}</p></li>)}</ul></div>
        </>}/>
      </li>;
    })}</ul>{current.tasks.some(task => task.status === "cancelled") && <details open={showCancelled} onToggle={event => setShowCancelled(event.currentTarget.open)}><summary className={styles.summary}>查看已删减任务</summary>{current.tasks.filter(task => task.status === "cancelled").map(task => <p key={task.id} id={`task-${task.id}`} tabIndex={-1}>{task.title} · 已删减 · {task.cancellationReason || "请查阅计划历史"}</p>)}</details>}
  </section>;
}

function MutationRecoveryPanel({ requests, onResolved, refresh, onAccessLost }: { requests: SavedMutation[]; onResolved: MutationRecoveryPort["resolve"]; refresh: () => Promise<void>; onAccessLost: (reason: unknown) => void }) {
  const [pendingKey, setPendingKey] = useState<string | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  async function recover(request: SavedMutation) {
    if (pendingKey) return;
    setPendingKey(request.idempotencyKey); setError(""); setNotice("");
    try {
      await api(request.path, { method: "POST", body: request.body, idempotencyKey: request.idempotencyKey });
      onResolved(request.idempotencyKey, { succeeded: true, error: "", notice: request.notice }); setNotice(request.notice); await refresh();
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) onAccessLost(reason);
      else if (unknownMutation(reason)) setError("服务仍未确认这次操作，原请求继续保留。稍后可以再次核对同一请求。");
      else { const errorText = message(reason); onResolved(request.idempotencyKey, { succeeded: false, error: errorText, notice: "" }); setError(errorText); if (reason instanceof ApiError && reason.status === 409) await refresh(); }
    } finally { setPendingKey(null); }
  }
  if (!requests.length && !error && !notice) return null;
  return <section className={boardStyles.recovery} aria-label="核对未确认操作"><h3>核对未确认操作</h3>{requests.length > 0 && <><p>输入、原版本与请求标识已保留。即使草案已生效、换了新草案或词条不再展示，也会核对原来那一次操作。</p><ul className={boardStyles.recoveryRequests}>{requests.map(request => <li key={request.idempotencyKey}><span>{request.label ?? "任务安排或进度保存"}</span><button type="button" className={styles.secondary} disabled={pendingKey !== null} onClick={() => void recover(request)}>{pendingKey === request.idempotencyKey ? "正在核对…" : "核对原操作结果"}</button></li>)}</ul></>}<Feedback error={error} notice={notice}/></section>;
}

function DraftTaskPool({ detail, pool, refresh, onAccessLost, mutationRecovery }: { detail: ProjectDetail; pool: TaskPoolSnapshot | null; refresh: () => Promise<void>; onAccessLost: (reason: unknown) => void; mutationRecovery: MutationRecoveryPort }) {
  const [filter, setFilter] = useState<"all" | "available" | "mine">("all");
  const spaceHref = `/app/projects/${encodeURIComponent(detail.project.id)}`;
  const manager = detail.membership.role === "manager", readonly = detail.project.stage === "archived";
  const tasks = pool?.tasks.filter(task => task.status !== "cancelled") ?? [];
  const available = tasks.filter(task => task.status === "todo" && task.acceptance === null && task.ownerMembershipId === null);
  const displayed = tasks.filter(task => filter === "all" || (filter === "available" ? available.some(value => value.id === task.id) : task.ownerMembershipId === detail.membership.membershipId));
  return <section className={boardStyles.pool} aria-label="未生效任务词条池"><div className={boardStyles.heading}><h3>任务词条池</h3>{pool?.plan && <span className={`${styles.tag} ${boardStyles.draftTag}`}>未生效草案</span>}</div>
    <p className={styles.muted}>先看成果与工时，再领取适合自己的任务。领取只登记负责人；管理员重新检查容量和依赖并确认后，才能按生效安排开始。</p>
    {!pool ? <p role="status" className={styles.muted}>正在读取任务池…</p> : !pool.plan ? <p className={styles.muted}>暂时没有可领取的任务草案。{manager ? "可以从任务安排中起草一份计划。" : "请管理员先起草任务安排。"}</p> : <>
      <p className={styles.muted}>草案说明：{pool.plan.reason || "等待管理员核对"} · 版本 {pool.plan.revision} · {dateText(pool.plan.createdAt)}</p>
      {pool.inputVersionsChanged && <p className={styles.notice}>草案依据或当前任务已变化。负责人暂时保留，请管理员重新检查后再领取或转交。</p>}
      {readonly && <p className={styles.notice}>空间已归档，任务池仅供查看。</p>}
      <div className={`${styles.actions} ${boardStyles.poolFilters}`} aria-label="筛选任务词条"><button type="button" className={styles.secondary} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部词条（{tasks.length}）</button><button type="button" className={styles.secondary} aria-pressed={filter === "available"} onClick={() => setFilter("available")}>待领取（{available.length}）</button><button type="button" className={styles.secondary} aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>我负责的（{tasks.filter(task => task.ownerMembershipId === detail.membership.membershipId).length}）</button></div>
      {!displayed.length && <p className={styles.muted}>{filter === "available" ? "暂时没有待领取的任务；已领取任务与负责人仍保留在“全部词条”中。" : filter === "mine" ? "你还没有负责这份草案中的任务。" : "这份草案还没有可展示的任务词条。"}</p>}
      <ul className={boardStyles.poolTasks}>{tasks.map(task => <li key={`${pool.plan!.id}:${task.id}`} className={boardStyles.poolTask} hidden={!displayed.some(value => value.id === task.id)}>
        <div className={boardStyles.heading}><h4>{task.title}</h4><span className={styles.tag}>{task.ownerMembershipId ? "已有负责人" : "待领取"}</span></div><p className={boardStyles.owner}>负责人：{ownerName(detail, task.ownerMembershipId)}</p><p>要交什么：{task.deliverable}</p><p className={styles.muted}>估计 {task.durationEstimate.likelyMinutes} 分钟 · {task.priority === "must" ? "必做" : "可选"} · 未生效</p>
        <DraftTaskOwnership task={task} plan={pool.plan!} blocked={pool.inputVersionsChanged} detail={detail} refresh={refresh} onAccessLost={onAccessLost} mutationRecovery={mutationRecovery}/>
        <details className={boardStyles.details}><summary className={styles.summary}>查看完成条件、依赖与资料</summary><p>怎样检查：{task.acceptanceCriteria.join("；") || "还未写清检查条件，请管理员补充。"}</p><p>前置任务：{task.dependencyTaskIds.map(id => pool.tasks.find(value => value.id === id)?.title ?? "前置任务缺失，请管理员核对").join("、") || "未设置前置任务"}</p><p className={styles.muted}>协助：{task.helperEfforts.map(helper => ownerName(detail, helper.membershipId)).join("、") || "暂未指定"}<br/>检查者：{task.reviewerMembershipId ? ownerName(detail, task.reviewerMembershipId) : "空间管理员；没有指定检查者时，负责人可按条件自检"}<br/>估算范围：{task.durationEstimate.optimisticMinutes}–{task.durationEstimate.pessimisticMinutes} 分钟<br/>估算依据：{task.durationEstimate.basis}</p>{task.status !== "todo" && <p className={styles.notice}>此词条保留已有任务的进度（{statusNames[task.status]}），不能通过领取改变正在执行的负责人。请在当前生效任务中交接成果。</p>}<div className={boardStyles.resources}><h4>这项任务可用的工具与资料</h4><ul>{taskResourceGuidance(task.kind, detail.project.id).map(resource => <li key={resource.href}><a className={styles.link} href={resource.href}>{resource.title}</a><p className={styles.muted}>{resource.purpose}</p></li>)}</ul></div></details>
      </li>)}</ul>
      {pool.tasks.some(task => task.status === "cancelled") && <p className={styles.muted}>草案另有 {pool.tasks.filter(task => task.status === "cancelled").length} 项已删减任务，完整记录在任务安排中保留。</p>}
    </>}
    {manager && !readonly && <div className={styles.actions}><a className={styles.secondary} href={`${spaceHref}/plan`}>{pool?.plan ? "管理员检查并确认草案" : "起草任务安排"}</a></div>}
  </section>;
}

function DraftTaskOwnership({ task, plan, blocked, detail, refresh, onAccessLost, mutationRecovery }: { task: PlanningTask; plan: NonNullable<TaskPoolSnapshot["plan"]>; blocked: boolean; detail: ProjectDetail; refresh: () => Promise<void>; onAccessLost: (reason: unknown) => void; mutationRecovery: MutationRecoveryPort }) {
  const [ownerSelection, setOwnerSelection] = useState(task.ownerMembershipId ?? ""), [dirty, setDirty] = useState(false);
  const [baseline, setBaseline] = useState({ revision: plan.revision, taskRevision: task.revision });
  const [pending, setPending] = useState(false), [recovery, setRecovery] = useState<SavedMutation | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const manager = detail.membership.role === "manager", owner = task.ownerMembershipId === detail.membership.membershipId;
  const writable = !blocked && detail.project.stage !== "archived" && task.status === "todo" && task.acceptance === null;
  const stale = dirty && (baseline.revision !== plan.revision || baseline.taskRevision !== task.revision);
  const resolution = recovery ? mutationRecovery.resolutions[recovery.idempotencyKey] : undefined;
  useEffect(() => {
    if (!recovery || !resolution) return;
    setRecovery(null); setError(resolution.error); setNotice(resolution.notice);
    if (resolution.succeeded) setDirty(false);
  }, [recovery, resolution]);
  useEffect(() => {
    if (!dirty && !recovery) { setOwnerSelection(task.ownerMembershipId ?? ""); setBaseline({ revision: plan.revision, taskRevision: task.revision }); }
  }, [dirty, recovery, task.ownerMembershipId, task.revision, plan.revision]);
  async function mutate(action?: "claim" | "release" | "assign") {
    if (pending || (!recovery && (!action || !writable || stale))) return;
    const idempotencyKey = recovery?.idempotencyKey ?? operationKey();
    const request = recovery ?? { path: `/projects/${encodeURIComponent(detail.project.id)}/plan-versions/${encodeURIComponent(plan.id)}/tasks/${encodeURIComponent(task.id)}/${action}`, idempotencyKey, label: `${task.title} · 草案负责人`, scope: { projectId: detail.project.id, membershipId: detail.membership.membershipId },
      body: { expectedRevision: action === "assign" && dirty ? baseline.revision : plan.revision, expectedTaskRevision: action === "assign" && dirty ? baseline.taskRevision : task.revision, idempotencyKey, ...(action === "assign" ? { ownerMembershipId: ownerSelection || null } : {}) },
      notice: action === "release" ? "已退回草案任务，词条保留为待领取。管理员确认前，当前生效安排保留。" : "草案负责人已保存，词条仍保留。请管理员检查容量和依赖并确认后再开始。" };
    setPending(true); setError(""); setNotice("");
    try {
      await api<PlanVersion>(request.path, { method: "POST", body: request.body, idempotencyKey: request.idempotencyKey });
      if (recovery) mutationRecovery.resolve(request.idempotencyKey, { succeeded: true, error: "", notice: request.notice });
      setRecovery(null); setDirty(false); setNotice(request.notice); await refresh();
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { setRecovery(null); onAccessLost(reason); }
      else if (unknownMutation(reason)) { setRecovery(request); mutationRecovery.remember(request); setError("服务器结果尚未确认，原请求已保留。请在任务板顶部核对同一次操作，避免重复领取或转交。"); }
      else { if (recovery) mutationRecovery.resolve(request.idempotencyKey, { succeeded: false, error: message(reason), notice: "" }); setRecovery(null); setError(message(reason)); if (reason instanceof ApiError && reason.status === 409) await refresh(); }
    } finally { setPending(false); }
  }
  return <><div className={styles.actions}>
    {task.ownerMembershipId === null && <button type="button" className={styles.button} disabled={pending || Boolean(recovery) || !writable || stale} onClick={() => void mutate("claim")}>我来负责</button>}
    {task.ownerMembershipId !== null && (owner || manager) && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery) || !writable || stale} onClick={() => void mutate("release")}>退回待领取</button>}
    {task.ownerMembershipId !== null && !owner && !manager && <span className={styles.muted}>已由队友负责；转交请联系管理员。</span>}
  </div>{manager && task.status === "todo" && task.acceptance === null && <details className={boardStyles.assignment}><summary className={styles.summary}>管理员分配或转交</summary><Field label="草案负责人"><select value={ownerSelection} disabled={pending || Boolean(recovery) || !writable} onChange={event => { if (!dirty) setBaseline({ revision: plan.revision, taskRevision: task.revision }); setOwnerSelection(event.target.value); setDirty(true); }}><option value="">退回待领取</option>{detail.members.filter(member => member.status === "active").map(member => <option key={member.membershipId} value={member.membershipId}>{ownerName(detail, member.membershipId)}</option>)}</select></Field>{stale && <p className={styles.notice}>队友已更新这份草案。你的选择已保留，当前负责人是 {ownerName(detail, task.ownerMembershipId)}。<button type="button" className={styles.secondary} disabled={pending || Boolean(recovery)} onClick={() => setBaseline({ revision: plan.revision, taskRevision: task.revision })}>核对后，保留选择继续</button></p>}<button type="button" className={styles.secondary} disabled={pending || Boolean(recovery) || !writable || stale || ownerSelection === (task.ownerMembershipId ?? "")} onClick={() => void mutate("assign")}>保存草案负责人</button></details>}
    <Feedback error={error} notice={notice}/>{recovery && <p className={styles.muted} role="status">此项原请求已保留，请在任务板顶部“核对未确认操作”中继续。</p>}
  </>;
}

function Evidence({ value }: { value: string }) {
  const href = safeLink(value);
  return <p>{href ? <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">查看成果依据</a> : value}</p>;
}

function HandoffNote({ note }: { note: string }) {
  const saved = readHandoffProgress(note);
  return saved.kind === "legacy" ? <p style={{ whiteSpace: "pre-wrap" }}>{note || "已记录进度"}</p> : <>
    <dl>{HANDOFF_FIELDS.map(field => <div key={field.key}><dt>{field.label}</dt><dd style={{ marginInlineStart: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{saved.handoff[field.key]}</dd></div>)}</dl>
    {saved.note && <p style={{ whiteSpace: "pre-wrap" }}>{saved.note}</p>}
  </>;
}

function TaskActions({ task, tasks, tasksRevision, detail, progress, canStart, refresh, onAccessLost, mutationRecovery, detailsContent }: { task: PlanningTask; tasks: PlanningTask[]; tasksRevision: number; detail: ProjectDetail; progress: ProgressUpdate[]; canStart: boolean; refresh: () => Promise<void>; onAccessLost: (reason: unknown) => void; mutationRecovery: MutationRecoveryPort; detailsContent: ReactNode }) {
  const [editing, setEditing] = useState(false), [status, setStatus] = useState<TaskStatus>("review"), [baseline, setBaseline] = useState({ revision: task.revision, tasksRevision, status: task.status }), [note, setNote] = useState(""), [evidence, setEvidence] = useState(""), [remaining, setRemaining] = useState("");
  const [requestingCorrection, setRequestingCorrection] = useState(false), [correcting, setCorrecting] = useState(false), [acknowledged, setAcknowledged] = useState(false), [acceptedId, setAcceptedId] = useState(""), [progressCorrectionId, setProgressCorrectionId] = useState<string | null>(null), [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState<SavedMutation | null>(null);
  const [handoff, setHandoff] = useState<HandoffDraft>(emptyHandoffDraft), [handoffOpen, setHandoffOpen] = useState(false);
  // 交接候选（规划31 第1.4项）：只来自本任务已承诺的交付物与检查条件；没有依据时为空，不编造。
  const handoffCandidates = handoffSuggestions({ title: task.title, acceptanceCriteria: task.acceptanceCriteria, deliverable: task.deliverable });
  const inputStarted = useRef(false);
  const resolution = recovery ? mutationRecovery.resolutions[recovery.idempotencyKey] : undefined;
  useEffect(() => {
    if (!recovery || !resolution) return;
    setRecovery(null); setError(resolution.error); setNotice(resolution.notice);
    if (resolution.succeeded) { setEditing(false); setCorrecting(false); setNote(""); setEvidence(""); setRemaining(""); setAcknowledged(false); setHandoff(emptyHandoffDraft()); setHandoffOpen(false); inputStarted.current = false; }
  }, [recovery, resolution]);
  const manager = detail.membership.role === "manager", owner = task.ownerMembershipId === detail.membership.membershipId, reviewer = task.reviewerMembershipId === detail.membership.membershipId;
  const readonly = detail.project.stage === "archived", canUpdate = !readonly && (manager || owner), canCheck = !readonly && (manager || reviewer || (owner && task.reviewerMembershipId === null));
  const stale = editing && (baseline.revision !== task.revision || (correcting && !requestingCorrection && baseline.tasksRevision !== tasksRevision));
  const canRequest = !readonly && (owner || task.helperEfforts.some(helper => helper.membershipId === detail.membership.membershipId));
  const dependents = dependentTaskIds(task.id, tasks), lastAccepted = [...progress].reverse().find(update => update.taskId === task.id && update.acceptance !== null);
  const records = progress.filter(update => update.taskId === task.id).slice(-8).reverse();
  const currentProgressId = [...progress].reverse().find(update => update.taskId === task.id && !update.correctionRequest)?.id ?? null;
  const lastHandoff = [...progress].reverse().find(update => update.taskId === task.id && update.projectId === detail.project.id && update.status === "review" && !update.correctionRequest && !update.acceptanceCorrection);
  function begin(next: TaskStatus, correction = false, request = false) {
    if (pending || recovery) return;
    if (!editing) { setBaseline({ revision: task.revision, tasksRevision, status: task.status }); setAcceptedId(lastAccepted?.id ?? ""); }
    if (!inputStarted.current && next === "review" && !correction && task.status === "review" && lastHandoff && !note && !evidence && !hasHandoffInput(handoff)) {
      const saved = readHandoffProgress(lastHandoff.note);
      setNote(saved.note); setEvidence(lastHandoff.evidenceRefs.join("\n")); setHandoff(saved.handoff);
    }
    inputStarted.current = true;
    if (next === "review" && !correction && task.status !== "review") setHandoffOpen(true);
    setEditing(true); setStatus(next); setCorrecting(correction); setRequestingCorrection(request); setAcknowledged(false); setError(""); setNotice("");
    setProgressCorrectionId(!correction && task.status === "review" && ["in_progress", "blocked"].includes(next) ? currentProgressId : null);
  }
  function useLatestRecord() {
    setBaseline({ revision: task.revision, tasksRevision, status: task.status }); setAcceptedId(lastAccepted?.id ?? ""); setAcknowledged(false);
    setProgressCorrectionId(!correcting && task.status === "review" && ["in_progress", "blocked"].includes(status) ? currentProgressId : null);
  }
  async function submit() {
    if (pending) return;
    setPending(true); setError(""); setNotice("");
    let request = recovery;
    try {
      if (!request) {
        if (stale) throw new Error("队友已更新记录。输入已保留，请先核对并使用最新版本继续。");
        const idempotencyKey = operationKey(), taskPath = `/projects/${encodeURIComponent(detail.project.id)}/tasks/${encodeURIComponent(task.id)}`;
        if (requestingCorrection) {
          request = { path: `${taskPath}/acceptance-correction-request`, idempotencyKey, label: `${task.title} · 进度与检查记录`, scope: { projectId: detail.project.id, membershipId: detail.membership.membershipId }, body: { expectedRevision: baseline.revision, acceptanceProgressId: acceptedId, reason: note, idempotencyKey }, notice: "请求已保存，管理员在任务板可看到理由。当前检查和任务状态保留。" };
        } else if (correcting) {
          if (!acknowledged || !acceptedId) throw new Error("请先核对原验收记录和受影响的后续任务。");
          request = { path: `${taskPath}/acceptance-correction`, idempotencyKey, label: `${task.title} · 进度与检查记录`, scope: { projectId: detail.project.id, membershipId: detail.membership.membershipId }, body: { expectedRevision: baseline.revision, expectedTasksRevision: baseline.tasksRevision, correctionOf: acceptedId, correctionReason: note, status, acknowledgedDependentTaskIds: dependents, idempotencyKey }, notice: "已记录更正，原验收和后续影响保留在历史中。" };
        } else {
          let progressNote = note, progressEvidence = lines(evidence);
          if (status === "review") {
            try {
              const saved = buildHandoffProgress({ handoff, note, evidenceRefs: progressEvidence, allowLegacy: task.status === "review" && Boolean(lastHandoff) });
              progressNote = saved.note; progressEvidence = saved.evidenceRefs;
            } catch (reason) { setHandoffOpen(true); throw reason; }
          }
          if (progressCorrectionId && !note.trim()) throw new Error("请说明为什么更正这次完成报告。");
          request = { path: `${taskPath}/progress`, idempotencyKey, label: `${task.title} · 进度与检查记录`, scope: { projectId: detail.project.id, membershipId: detail.membership.membershipId }, body: { expectedRevision: baseline.revision, status, remainingEstimate: remaining ? { optimisticMinutes: Number(remaining), likelyMinutes: Number(remaining), pessimisticMinutes: Number(remaining), basis: "本次由负责人重新估算剩余工时" } : null, blocker: status === "blocked" ? note : null, evidenceRefs: progressEvidence, note: progressNote, ...(progressCorrectionId ? { correctionOf: progressCorrectionId, correctionReason: note } : {}), idempotencyKey }, notice: status === "review" ? "成果已交到待检查，队友可以看到。" : status === "done" ? "检查已通过，依赖此成果的任务可以继续。" : "进度已保存，队友可以看到。" };
        }
      }
      await api(request.path, { method: "POST", body: request.body, idempotencyKey: request.idempotencyKey });
      if (recovery) mutationRecovery.resolve(request.idempotencyKey, { succeeded: true, error: "", notice: request.notice });
      setRecovery(null); setEditing(false); setCorrecting(false); setNote(""); setEvidence(""); setRemaining(""); setAcknowledged(false); setHandoff(emptyHandoffDraft()); setHandoffOpen(false); inputStarted.current = false; setNotice(request.notice); await refresh();
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { setRecovery(null); onAccessLost(reason); }
      else if (request && unknownMutation(reason)) { setRecovery(request); mutationRecovery.remember(request); setError("这次保存的结果尚未确认。输入和原请求已保留，请在任务板顶部核对同一次操作，确认前暂不提交其他修改。"); }
      else { if (request && recovery) mutationRecovery.resolve(request.idempotencyKey, { succeeded: false, error: message(reason), notice: "" }); setRecovery(null); setError(message(reason)); if (reason instanceof ApiError && reason.status === 409) await refresh(); }
    } finally { setPending(false); }
  }
  const dependenciesAccepted = unmetDependencies(task, tasks).length === 0;
  const selfCheck = !manager && !reviewer && owner && task.reviewerMembershipId === null;
  let primaryAction: ReactNode = null;
  if (canUpdate && ["todo", "blocked"].includes(task.status)) primaryAction = <button type="button" className={styles.button} disabled={pending || Boolean(recovery) || !canStart} onClick={() => begin("in_progress")}>开始做</button>;
  else if (canUpdate && task.status === "in_progress") primaryAction = <button type="button" className={styles.button} disabled={pending || Boolean(recovery)} onClick={() => begin("review")}>提交成果，请队友检查</button>;
  else if (task.status === "review" && canCheck) primaryAction = <button type="button" className={styles.button} disabled={pending || Boolean(recovery) || !dependenciesAccepted} onClick={() => begin("done")}>{selfCheck ? "按条件自检通过" : "检查通过"}</button>;
  else if (task.status === "review" && canUpdate) primaryAction = <button type="button" className={styles.button} disabled={pending || Boolean(recovery)} onClick={() => begin("review")}>补充成果说明</button>;
  return <>{primaryAction && <div className={`${styles.actions} ${boardStyles.primaryAction}`}>{primaryAction}</div>}
    <details className={boardStyles.details}><summary className={styles.summary}>任务详情、检查与更多操作</summary>{detailsContent}
      <div className={styles.actions}>
        {canUpdate && task.status === "todo" && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery)} onClick={() => begin("review")}>提交成果，请队友检查</button>}
        {canUpdate && task.status === "in_progress" && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery)} onClick={() => begin("in_progress")}>更新进度与剩余工时</button>}
        {canUpdate && task.status === "review" && canCheck && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery)} onClick={() => begin("review")}>补充成果说明</button>}
        {canUpdate && ["in_progress", "blocked", "review"].includes(task.status) && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery)} onClick={() => begin("blocked")}>遇到问题，请队友帮助</button>}
        {canUpdate && task.status === "review" && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery) || !canStart} onClick={() => begin("in_progress")}>还需继续做 / 更正误勾</button>}
        {task.status === "done" && !readonly && (manager ? <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery) || !lastAccepted} onClick={() => begin("review", true)}>更正这次检查记录</button> : <>{canRequest && <button type="button" className={styles.secondary} disabled={pending || Boolean(recovery) || !lastAccepted} onClick={() => begin("done", true, true)}>发现问题，请求更正</button>}<p className={styles.muted}>空间管理员核对理由与后续依赖后，才能更正检查记录。</p></>)}
      </div>
      {records.length > 0 && <><h4>最近进度与更正记录</h4><ul className={styles.list}>{records.map(update => <li key={update.id}><strong>{update.correctionRequest ? "请求管理员更正" : statusNames[update.status]}</strong> · {dateText(update.createdAt)} · {ownerName(detail, detail.members.find(member => member.userId === update.actorId)?.membershipId ?? null)}<HandoffNote note={update.note}/>{update.correctionReason && <p className={styles.notice}>更正理由：{update.correctionReason} · 原记录保留</p>}{update.acceptanceCorrection && <p className={styles.muted}>原检查通过：{dateText(update.acceptanceCorrection.previousAcceptance.acceptedAt)} · 影响后续任务 {update.acceptanceCorrection.impactedTasks.length} 项</p>}{update.evidenceRefs.map((ref, index) => <Evidence key={index} value={ref}/>)}</li>)}</ul></>}
    </details>
    {task.status === "done" && !lastAccepted && <p className={styles.muted}>原检查对应的进度记录还未载入，或旧数据缺少记录。请读取最新进度，由空间管理员核对历史。</p>}<Feedback error={error} notice={notice}/>{recovery && <p className={styles.muted} role="status">输入和原请求已保留，请在任务板顶部“核对未确认操作”中继续。</p>}{editing && <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}><h4>{requestingCorrection ? "请管理员核对这次检查" : correcting ? "更正已经通过的检查" : status === "review" ? "把成果交给队友检查" : status === "done" ? "按完成条件检查成果" : status === "blocked" ? "告诉队友哪里需要帮助" : "开始或继续这项任务"}</h4>{stale && <p className={styles.notice} role="status">输入开始时是“{statusNames[baseline.status]}”（版本 {baseline.revision}），现在是“{statusNames[task.status]}”（版本 {task.revision}）。输入没有丢失。<button type="button" className={styles.secondary} disabled={pending || Boolean(recovery) || (correcting && task.status !== "done")} onClick={useLatestRecord}>保留输入，按最新记录继续</button></p>}
      {status === "done" && !correcting && <p className={styles.notice}>{selfCheck ? "这次由你本人按条件自检。" : "请实际核对成果再确认。"}检查条件：{task.acceptanceCriteria.join("；") || "还未写清检查条件"}。检查说明和依据会保存到队内记录。</p>}
      {status === "review" && !correcting && <details className={boardStyles.assignment} open={handoffOpen} onToggle={event => setHandoffOpen(event.currentTarget.open)}>
        <summary className={styles.summary}>成果交接：位置、版本、打开与检查方法</summary>
        <p className={styles.muted}>{task.status === "review" && lastHandoff ? "原交接内容已带入；旧记录可以继续保存，也可补齐四项。" : "把四项写清楚，队友才能接手。PPT、设计稿、文档和代码都适用。"}交接只进入待检查，仍需按任务条件确认。</p>
        {/* 候选带出（规划31 第1.4项）：只在你点一下时填入，并注明来自哪里；不自动填写，避免替你编造交接事实。 */}
        {handoffCandidates.length > 0 && <p className={styles.muted}>可以带出已有信息（点一下填入，之后仍由你修改）：
          {handoffCandidates.map(candidate => <button key={candidate.key} type="button" className={boardStyles.handoffChip}
            disabled={pending || Boolean(recovery) || readonly || handoff[candidate.key].trim() === candidate.value}
            title={`${candidate.source}：${candidate.value}`}
            onClick={() => setHandoff(previous => ({ ...previous, [candidate.key]: candidate.value }))}>
            {HANDOFF_FIELDS.find(field => field.key === candidate.key)?.label}：{candidate.value.length > 24 ? `${candidate.value.slice(0, 24)}…` : candidate.value}
          </button>)}
        </p>}
        {HANDOFF_FIELDS.map(field => <Field key={field.key} label={field.label}>{field.key === "location" || field.key === "version"
          ? <input type="text" value={handoff[field.key]} disabled={pending || Boolean(recovery) || readonly} onChange={event => setHandoff(previous => ({ ...previous, [field.key]: event.target.value }))} placeholder={`例如：${field.example}`}/>
          : <textarea value={handoff[field.key]} disabled={pending || Boolean(recovery) || readonly} onChange={event => setHandoff(previous => ({ ...previous, [field.key]: event.target.value }))} placeholder={`例如：${field.example}`}/>}</Field>)}
        <p className={styles.muted}>四项与补充说明合计最多{HANDOFF_LIMITS.note}字，成果位置会一并保存为成果依据。</p>
      </details>}
      <Field label={correcting ? "为什么需要更正" : status === "blocked" ? "遇到了什么问题，想请谁帮助" : status === "done" ? "怎样确认满足检查条件" : status === "review" ? "补充说明（选填）" : "这次完成了什么 / 进度说明"}><textarea required={correcting || status === "done" || status === "blocked"} value={note} disabled={pending || Boolean(recovery) || readonly} onChange={event => setNote(event.target.value)} placeholder={status === "blocked" ? "例如：接口还没提供，想请负责服务的队友确认；我先准备页面草图。" : "说明可以看到或检查的成果。"}/></Field>
      {!correcting && <><Field label={status === "review" ? "额外成果依据（选填，每行一项）" : "成果链接或记录依据（每行一项）"}><textarea value={evidence} required={status === "done"} disabled={pending || Boolean(recovery) || readonly} onChange={event => setEvidence(event.target.value)} placeholder={status === "review" ? "可补充截图、测试记录或其他文件位置。" : "可填写作品、截图、测试记录链接；也可在上方解释成果。"}/></Field>{status !== "done" && <Field label="预计还需多久（分钟，选填）"><input type="number" min="0" step="1" value={remaining} disabled={pending || Boolean(recovery) || readonly} onChange={event => setRemaining(event.target.value)}/></Field>}</>}
      {requestingCorrection && <p className={styles.notice}>填写你发现的问题，管理员可以在任务板看到并核对。提交请求不会修改已完成状态或后续依赖。</p>}{correcting && !requestingCorrection && <><p className={styles.notice}>原记录不会删除。此任务退回待检查；已完成的后续成果重新待检查，正在做的后续任务标记等待前置成果。</p><p>受影响的后续任务：{dependents.map(id => tasks.find(value => value.id === id)?.title ?? "未找到的任务").join("、") || "没有后续依赖任务"}</p><label className={styles.check}><input type="checkbox" checked={acknowledged} disabled={pending || Boolean(recovery) || readonly} onChange={event => setAcknowledged(event.target.checked)}/>我已核对原验收与全部后续任务，确认保留记录并重新检查。</label></>}
      <div className={styles.actions}><button className={styles.button} disabled={pending || Boolean(recovery) || readonly || stale || (requestingCorrection && (!canRequest || !acceptedId)) || (correcting && !requestingCorrection && (!manager || !acknowledged)) || (!correcting && (task.status === "done" || (status === "done" && (!canCheck || !dependenciesAccepted)) || (status === "in_progress" && task.status !== "in_progress" && !canStart) || (status !== "done" && !canUpdate)))}>{requestingCorrection ? "保存更正请求" : correcting ? "保存更正记录" : status === "review" ? "提交到待检查" : status === "done" ? "确认检查通过" : "保存进度"}</button><button type="button" className={styles.secondary} disabled={pending || Boolean(recovery)} onClick={() => setEditing(false)}>收起，保留输入</button></div>
    </form>}</>;
}
