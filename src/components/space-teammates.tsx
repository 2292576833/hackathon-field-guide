"use client";

import { useApi } from "./client-api.ts";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { SharedIntentionsView } from "../modules/projects/index.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import { memberLabel } from "./member-display.ts";
import { buildTeammateStatuses } from "../modules/space-workflow/teammates.ts";
import type { ReadState } from "../modules/space-workflow/model.ts";
import styles from "./space-teammates.module.css";
import { ShareMarker } from "./share-marker.tsx";
const dutyLabels: Record<string, string> = { requirements: "需求梳理", design: "设计", development: "开发", testing: "测试", documentation: "文档", presentation: "路演", coordination: "协作统筹", other: "其他" };

function readState<T>(state: { data: T | null; loading: boolean; error: Error | null }): ReadState<T> {
  return state.error ? { status: "error", message: "读取失败" } : state.data !== null ? { status: "ready", value: state.data } : state.loading ? { status: "loading" } : { status: "unread" };
}

/**
 * 队友状态（规划27 第1期）：谁在做什么、等谁确认、谁卡住了。
 * 只读派生；不显示完成百分比，不做人员排名。
 */
export function SpaceTeammatesPanel({ detail, current, planningLoading, planningError, inviteAction, onRefresh }: {
  detail: ProjectDetail; current: CurrentPlanningView | null; planningLoading?: boolean; planningError?: unknown;
  /** 邀请入口由父层传入，保证"在界面里直接邀请"而不是跳走。 */
  inviteAction?: ReactNode;
  onRefresh?: () => Promise<void>;
}) {
  const base = `/projects/${encodeURIComponent(detail.project.id)}`;
  const intentions = useApi<SharedIntentionsView>(`${base}/shared-intentions`, { timeoutMs: 15_000 });
  const intentionsReload = useRef(intentions.reload); intentionsReload.current = intentions.reload;
  const intentionsLoading = useRef(intentions.loading); intentionsLoading.current = intentions.loading;
  const sharingScope = `${detail.project.id}:${detail.membership.userId}:${detail.membership.membershipId}`;
  const sharedRead = useRef<{ scope: string; promise: Promise<void> } | null>(null);
  const refreshShared = useCallback((): Promise<void> => {
    if (document.visibilityState !== "visible" || detail.membership.status !== "active") return Promise.resolve();
    if (sharedRead.current?.scope === sharingScope) return sharedRead.current.promise;
    // The original hook owns the initial GET; do not overlap it with a timer,
    // visibility event or manual refresh while its loading state is active.
    if (intentionsLoading.current) return Promise.resolve();
    const request = { scope: sharingScope, promise: Promise.resolve() };
    request.promise = intentionsReload.current().finally(() => { if (sharedRead.current === request) sharedRead.current = null; });
    sharedRead.current = request;
    return request.promise;
  }, [sharingScope, detail.membership.status]);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const pause = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
    const start = () => { if (detail.membership.status === "active" && document.visibilityState === "visible" && timer === null) timer = setInterval(() => { void refreshShared(); }, 15_000); };
    const visibility = () => {
      pause();
      if (document.visibilityState === "visible") { void refreshShared(); start(); }
    };
    start(); document.addEventListener("visibilitychange", visibility);
    return () => { pause(); document.removeEventListener("visibilitychange", visibility); };
  }, [refreshShared, detail.membership.status]);
  const view = buildTeammateStatuses({ detail: detail as never, current, planningLoading, planningError, intentions: readState(intentions) });
  const canInvite = detail.membership.role === "manager" && detail.membership.status === "active" && detail.project.stage !== "archived";

  return <section className={styles.panel} aria-label="队友状态" id="space-teammates">
    <div className={styles.head}><h2>队友状态</h2>
      <div className={styles.actions}>
        <ShareMarker anchor="space-teammates" label="队友状态"/>
        {canInvite && inviteAction}
        <button type="button" className={styles.tag} disabled={intentions.loading || planningLoading} onClick={() => void Promise.all([refreshShared(), onRefresh?.()])}>刷新</button>
      </div></div>
    {view.planningUnread && <p className={styles.notice} role={planningError ? "alert" : "status"}>{view.notice}</p>}
    {detail.project.stage === "archived" && <p className={styles.notice}>已归档，成员记录只读。</p>}
    {intentions.error && <p className={styles.error} role="alert">共享职责读取失败，暂时无法显示。</p>}
    <ul className={styles.list}>{view.teammates.map(member => {
      const rosterMember = detail.members.find(item => item.membershipId === member.membershipId)!;
      const label = memberLabel(rosterMember, undefined, detail.members);
      const mine = member.membershipId === detail.membership.membershipId;
      return <li key={member.membershipId}><details className={styles.card}>
        <summary className={styles.cardHead} aria-label={`${label}${mine ? "，我" : ""}，${member.label}`}>
          <span className={styles.identity}><span className={styles.name}>{label}</span>{mine && <span className={styles.me}>我</span>}</span>
          <span className={styles.tag} data-state={member.status}>{member.label}</span></summary>

        {member.assigned.length > 0 && <ul className={styles.items}>{member.assigned.map(task => <li key={task.id}><span className={styles.state}>待开始</span>{task.title}</li>)}</ul>}

        {member.doing.length > 0 && <div className={styles.section}>
          <ul className={styles.items}>{member.doing.map(task => <li key={task.id}><span className={styles.state}>正在做</span>{task.title}</li>)}</ul></div>}

        {/* 协助：本人不是负责人但参与其中。此前完全不可见，会出现两人帮同一件事而互不知情。 */}
        {member.helping.length > 0 && <div className={styles.section}>
          <ul className={styles.items}>{member.helping.map(task => <li key={task.id}><span className={styles.state}>协助</span>{task.title}</li>)}</ul></div>}

        {member.handingOff.length > 0 && <div className={styles.section}>
          <ul className={styles.items}>{member.handingOff.map(task => <li key={task.id}><span className={styles.state}>待检查</span>{task.title}</li>)}</ul></div>}

        {member.blocked.length > 0 && <div className={`${styles.section} ${styles.blocked}`}>
          <ul className={styles.items}>{member.blocked.map(task => <li key={task.id}><span className={styles.state}>卡住了</span>{task.title}<p className={styles.reason}>{task.reason}</p></li>)}</ul></div>}

        {member.duties.length > 0 && <p className={styles.notice}>已共享职责：{member.duties.map(duty => dutyLabels[duty] ?? duty).join("、")}</p>}

        {member.helpQuestion && <p className={styles.help}><strong>向团队求助：</strong>{member.helpQuestion}</p>}

        {member.checkedCount > 0 && <p className={styles.notice}>{member.checkedCount} 项任务已有检查记录。</p>}
        {member.status === "unassigned" && <p className={styles.notice}>当前记录没有分配给此成员的任务。</p>}
        {member.status === "unknown" && <p className={styles.notice}>{view.notice}</p>}
      </details></li>;
    })}</ul>
    <details className={styles.details}><summary>状态依据</summary><p className={styles.notice}>{view.notice}</p><p className={styles.notice}>职责和求助来自本人主动共享。任务记录不代表在线情况；记录未更新不表示没有工作。</p></details>
  </section>;
}
