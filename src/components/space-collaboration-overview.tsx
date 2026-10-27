"use client";
import Link from "next/link";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import { useApi } from "./client-api.ts";
import type { MemberAvailability, MyIntentionView, ProjectOfficialTracksView } from "../modules/projects/index.ts";
import type { ReadState, SpaceRules } from "../modules/space-workflow/model.ts";
import { buildMissionWorkbench, missionTaskChecked } from "../modules/space-workflow/mission-workbench.ts";
import { buildMemberCapacity, describeMinutes } from "../modules/space-workflow/capacity.ts";
import { memberLabel } from "./member-display.ts";
import styles from "./space-collaboration-overview.module.css";

function readState<T>(state: { data: T | null; loading: boolean; error: Error | null }): ReadState<T> {
  return state.error ? { status: "error", message: "读取失败" } : state.loading ? { status: "loading" } : state.data === null ? { status: "unread" } : { status: "ready", value: state.data };
}

export function SpaceCollaborationOverview({ detail, current, planningLoading, planningError, onOpenNode }: {
  detail: ProjectDetail; current: CurrentPlanningView | null; planningLoading?: boolean; planningError?: unknown;
  onOpenNode?: (nodeId: string) => void;
}) {
  const apiBase = `/projects/${encodeURIComponent(detail.project.id)}`;
  const rules = useApi<SpaceRules>(`${apiBase}/rules`);
  const tracks = useApi<ProjectOfficialTracksView>(`${apiBase}/official-tracks`);
  const intention = useApi<MyIntentionView>(`${apiBase}/my-intention`);
  const availability = useApi<{ availability: MemberAvailability | null; confirmationRequired: boolean }>(`${apiBase}/my-availability`);
  const view = buildMissionWorkbench({ detail, current, planningLoading, planningError,
    preparation: { rules: readState(rules), tracks: readState(tracks), intention: readState(intention), availability: readState(availability) } });
  const base = `/app/projects/${encodeURIComponent(detail.project.id)}`;
  const known = view.state === "current" || view.state === "archived" && current?.plan?.projectId === detail.project.id && current?.plan?.inputSnapshot.projectId === detail.project.id && !current?.inputVersionsChanged && current?.evaluation?.structuralValid;
  const tasks = known ? current!.tasks.filter(task => task.projectId === detail.project.id && task.status !== "cancelled") : null;
  const groups = tasks ? [
    { title: "已检查完成", count: tasks.filter(missionTaskChecked).length },
    { title: "正在做", count: tasks.filter(task => task.status === "in_progress").length },
    { title: "遇到问题", count: tasks.filter(task => task.status === "blocked").length },
    { title: "待检查", count: tasks.filter(task => task.status === "review" || task.status === "done" && !missionTaskChecked(task)).length },
  ] : null;
  const nodeId = ({ goal: "goal", duties: "duties-time", time: "duties-time", rules: "requirements", plan: "applied-plan", "review-plan": "applied-plan" } as Record<string, string>)[view.primary.id];
  // 容量对照：可用分钟早就由排程算好（evaluation.likely.capacityMinutes），此前从未渲染。
  // 门控**不能**用上面的 `known`：那个要求 workbench 处于 current，而"某些任务当前不能开始"（needs_review）
  // 并不妨碍比较既有排程里的工作量与可用时间。这里只要求：同一项目、计划已生效、且依据未失效。
  const sameProjectPlan = Boolean(current?.plan && current.plan.projectId === detail.project.id && current.plan.inputSnapshot.projectId === detail.project.id);
  const capacityUsable = sameProjectPlan && current?.plan?.status === "applied" && !current?.inputVersionsChanged && !current?.staleInputs;
  const activeMembers = detail.members.filter(member => member.projectId === detail.project.id && member.status === "active");
  const capacity = buildMemberCapacity({
    members: activeMembers.map(member => ({ membershipId: member.membershipId, name: memberLabel(member, undefined, detail.members) })),
    tasks: capacityUsable ? current!.tasks.filter(task => task.projectId === detail.project.id) : [],
    capacityMinutes: capacityUsable ? current?.evaluation?.likely?.capacityMinutes ?? null : null,
    staleInputs: Boolean(current?.inputVersionsChanged) || Boolean(current?.staleInputs),
  });
  return <section className={styles.panel} aria-label="团队协作概览" id="space-overview">
    <div className={styles.heading}><h2>团队进度</h2><Link href={`${base}/plan`}>任务列表 →</Link></div>
    {view.readonly && <p className={styles.notice}>已归档，记录只读。</p>}
    {groups ? <div className={styles.counts}>{groups.map(group => <div key={group.title}><strong>{group.count}</strong><span>{group.title}</span></div>)}</div> : <p role={view.state === "error" ? "alert" : "status"} className={styles.notice}>{view.notice}</p>}
    <div className={styles.next}><span>{view.readonly ? "回顾" : "下一步"}</span><strong>{view.primary.title}</strong>{nodeId && onOpenNode && !view.readonly
      ? <button type="button" onClick={() => onOpenNode(nodeId)}>继续处理 →</button>
      : <Link href={view.primary.href}>{view.readonly ? "查看记录" : "继续处理"} →</Link>}</div>
    {view.waiting.length > 0 && <details className={styles.waiting}><summary>我在等什么（{view.waiting.length} 项）</summary><ul>{view.waiting.map(item => <li key={item.taskId}><Link href={item.href}>{item.title}</Link><p>{item.problem}</p>{item.waitingFor.map((prior,index) => <small key={index}>{prior.title} · {prior.owner} · {prior.status}</small>)}</li>)}</ul></details>}
    {/* 容量对照（规划31 第1.5项）：把已算出但从未展示的可用时间与剩余工时并排给出。
        只做减法、不出百分比与排名；依据不足时不比较。 */}
    {capacity.state === "ready" && capacity.rows.length > 0 && <details className={styles.explanation}>
      <summary>每个人剩余工作量与可用时间</summary>
      <ul className={styles.capacityList}>{capacity.rows.map(row => <li key={row.membershipId}>
        <strong>{row.name}</strong>
        <span>剩余工作量 {describeMinutes(row.remainingMinutes)}</span>
        <span>可用时间 {describeMinutes(row.capacityMinutes)}</span>
      </li>)}</ul>
      <p className={styles.note}>两个数字都是记录里的估算，不是承诺；这里只做对照，不代表谁快谁慢。{capacity.notice}</p>
    </details>}
    {capacity.state === "unknown" && <p className={styles.note}>暂时无法对照每个人的剩余工作量与可用时间。{capacity.notice}</p>}
    <details className={styles.explanation}><summary>说明</summary><p className={styles.notice}>{view.primary.purpose}</p><p className={styles.note}>有实际检查记录才计为已检查完成。任务检查、版本运行和向主办方正式提交分别记录；这里的数字不代表报名或正式提交。</p></details>
  </section>;
}
