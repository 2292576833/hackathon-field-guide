"use client";

import { useEffect, useState } from "react";
import type { CurrentPlanningView, PlanningDeadline } from "../modules/planning/types.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import {
  computeSpaceResource, formatMicros,
  type SpaceDeadlineInput, type SpaceDeadlineKind, type SpaceResourceOutcome,
} from "../modules/space-resource/index.ts";
import { adviseScopeCut, type ScopeCutAdvice } from "../modules/scope-cut/index.ts";
import styles from "./space-resource.module.css";

/**
 * 把 (M05) 计划里的截止点映射成本模块要求的输入。
 *
 * 只做**机械映射**，不做推断：
 *  - `registration` / `submission` 原样传递（它们决定 `phase` 边界）；
 *  - `video` / `demo` / `supplement` 归入 `other`，**不当成"开赛"**，否则会把"报名截止刚过、
 *    比赛还没开始"误判成赛中（S2 交付文档里点名的坑）；
 *  - `verified` 与 `sourceText` 原样带出，界面照实显示，绝不提升成"官方确认"。
 */
function deadlineKindOf(deadline: PlanningDeadline): SpaceDeadlineKind {
  if (deadline.kind === "registration") return "registration";
  if (deadline.kind === "submission") return "submission";
  return "other";
}

const DEADLINE_LABEL: Record<PlanningDeadline["kind"], string> = {
  registration: "报名截止", submission: "作品提交截止", video: "视频提交",
  demo: "演示/答辩", supplement: "补充材料", other: "其他时间点",
};

function toInputs(deadlines: readonly PlanningDeadline[]): SpaceDeadlineInput[] {
  return deadlines.map(deadline => ({
    id: deadline.id,
    label: DEADLINE_LABEL[deadline.kind],
    instantUtc: deadline.instantUtc,
    sourceText: deadline.sourceText,
    verified: deadline.verified,
    kind: deadlineKindOf(deadline),
  }));
}

/** 自然日/小时的可读倒计时文案。切天口径按整日向下取整，避免"还剩 1 天"其实只剩 2 小时。 */
export function humanizeRemaining(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return "已过";
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `还剩 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.floor(hours / 24)} 天`;
}

/**
 * 倒计时与资源（规划27 第 4.2 项）。
 *
 * 接入 S2 的纯计算：**事实不足时显示"时间未知"，不回落成"赛前"**；
 * 没有未来截止时不显示"还剩 0 天"；没有预算数据时不显示"0 元"。
 */
export function SpaceResourcePanel({ current, planningLoading, planningError }: {
  readonly current: CurrentPlanningView | null;
  readonly planningLoading?: boolean;
  readonly planningError?: unknown;
}) {
  // 时刻只在挂载后取：服务端与客户端渲染不一致会造成水合不匹配。
  const [nowIso, setNowIso] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNowIso(new Date().toISOString());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (planningError) return <p className={`${styles.panel} ${styles.state}`}>时间信息读取失败，暂时无法倒计时。</p>;
  if (planningLoading || nowIso === null) return <p className={`${styles.panel} ${styles.state}`} role="status">正在读取时间信息…</p>;
  if (current === null) return <p className={`${styles.panel} ${styles.state}`}>还没读到时间信息。它来自你确认过的计划，确认后这里会显示倒计时。</p>;

  const outcome: SpaceResourceOutcome = computeSpaceResource({ now: nowIso, deadlines: toInputs(current.plan?.inputSnapshot.deadlines ?? []) });
  if (!outcome.ok) {
    return <section className={styles.panel}>
      <p className={styles.phase}>时间未知</p>
      <p className={styles.state}>时间信息不完整，暂时无法倒计时。</p>
      <details className={styles.details}><summary>说明</summary><ul className={styles.list}>{outcome.issues.map((issue, index) => <li key={index}>{issue.reason}</li>)}</ul></details>
    </section>;
  }
  const result = outcome.result;
  return <section className={styles.panel}>
    <p className={styles.phase}>{result.phaseLabel}</p>
    {result.next
      ? <>
          <p className={styles.big}>{humanizeRemaining(result.next.remainingMs)}</p>
          <p className={styles.subject}>{result.next.label} · {result.next.at}</p>
          <p className={styles.meta}>
            {result.next.verified ? "已核验" : "未核验，请以主办方最新说明为准"}
          </p>
        </>
      : <p className={styles.state}>没有已知的未来截止时间。这不等于"没有截止"——请到比赛页确认。</p>}
    {result.overdue.length > 0 && <details className={styles.details}>
      <summary>已过期 {result.overdue.length} 项</summary>
      <ul className={styles.list}>{result.overdue.map(item => <li key={item.id}>{item.label} · {item.at}{item.verified ? "" : "（未核验）"}</li>)}</ul>
    </details>}
    {result.budget && <p className={styles.meta}>预算：已用 {formatMicros(result.budget.usedMicros)} / 共 {formatMicros(result.budget.totalMicros)}{result.budget.over ? "（已超）" : ` · 余 ${formatMicros(result.budget.remainingMicros)}`}</p>}
    <details className={styles.details}><summary>说明</summary>
      <p className={styles.meta}>阶段依据：{result.phaseLabel === "时间未知" ? "没有可用时间点" : result.phaseBasis}</p>
      {result.next?.sourceText && <p className={styles.meta}>原文：{result.next.sourceText}</p>}
    </details>
  </section>;
}

/**
 * 范围调整（规划27 第 4.3 项，S1 模块）。
 *
 * 只把结论放主视觉：`verdict` + 要守住的 + 可以砍的；依据说明折叠。
 * **`unknown` 不做成状态标签**（它只表示"事实不够"），也不给勾选、不写回任何事实。
 */
export function SpaceScopeCutPanel({ detail, current, planningLoading, planningError }: {
  readonly detail: ProjectDetail;
  readonly current: CurrentPlanningView | null;
  readonly planningLoading?: boolean;
  readonly planningError?: unknown;
}) {
  const [nowIso, setNowIso] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNowIso(new Date().toISOString());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (planningError) return <p className={`${styles.panel} ${styles.state}`} role="alert">时间与任务信息读取失败，请刷新团队进度后再判断范围。</p>;
  if (nowIso === null || planningLoading) return <p className={`${styles.panel} ${styles.state}`} role="status">正在读取时间与任务信息…</p>;
  const deadlines: readonly PlanningDeadline[] = current?.plan?.inputSnapshot.deadlines ?? [];
  const upcoming = deadlines.map(deadline => Date.parse(deadline.instantUtc)).filter((value: number) => Number.isFinite(value) && value > Date.parse(nowIso));
  const tasks = current?.tasks ?? [];
  const remainingMs = upcoming.length > 0 ? Math.min(...upcoming) - Date.parse(nowIso) : Number.NaN;
  const advice: ScopeCutAdvice = adviseScopeCut({
    goal: detail.project.goal ?? "",
    minimumDeliverable: detail.project.minimumDeliverable ?? "",
    remainingMs,
    stage: String(detail.project.stage ?? ""),
    tasks: { total: tasks.length,
      done: tasks.filter(task => task.status === "done").length,
      blocked: tasks.filter(task => task.status === "blocked").length,
      inProgress: tasks.filter(task => task.status === "in_progress").length },
  });
  const headline = advice.verdict === "must_cut" ? "建议现在就砍范围"
    : advice.verdict === "at_risk" ? "时间偏紧，先保底线"
    : advice.verdict === "on_track" ? "暂未发现明显的范围风险"
    : "还看不出要不要砍";
  // 事实不足时：主视觉只给一句人话，字段名与缺口明细一律收进"依据说明"，
  // 不把 tasks.total / remainingMs 这类内部名字摆到用户面前（S1 交付文档明确警告过）。
  const unknown = advice.verdict === "unknown";
  return <section className={styles.panel}>
    <p className={styles.phase}>{headline}</p>
    <details className={styles.details}><summary>{unknown ? "说明" : "查看调整建议"}</summary>
      <p className={styles.say}>{unknown && advice.keep.length > 0 ? advice.keep[0] : advice.sayToTeam}</p>
      {!unknown && advice.keep.length > 0 && <><p className={styles.meta}>必须守住</p>
        <ul className={styles.list}>{advice.keep.map(item => <li key={item}>{item}</li>)}</ul></>}
      {!unknown && advice.cut.length > 0 && <><p className={styles.meta}>可以砍或降级</p>
        <ul className={styles.list}>{advice.cut.map(item => <li key={item}>{item}</li>)}</ul></>}
      <p className={styles.meta}>{advice.notice}</p>
    </details>
  </section>;
}
