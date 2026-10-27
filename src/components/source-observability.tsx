"use client";
import { AdminSourceObservabilityPanel as SourcePanel } from "../modules/operations/observability-panel.tsx";
import type { AdminSourceObservabilityPanelProps } from "../modules/operations/observability-panel.tsx";
import type { ResourceLinkMaintenanceStatus } from "../server/resource-link-maintenance.ts";
import { dateText, useApi } from "./client-api.ts";
import { Feedback, Empty } from "./site-shell.tsx";
import styles from "./site.module.css";

export function AdminSourceObservabilityPanel(props: AdminSourceObservabilityPanelProps) {
  return <><SourcePanel {...props}/><p className={styles.muted}>模型调用与费用按 UTC 当日统计；未结预留和未知请求跨全部历史保留，跨日不会自动解除核对。</p></>;
}
const states = { available: "入口可访问", unreachable: "入口返回不存在", unknown: "暂不能确认" };
const reasons: Record<string, string> = {
  http_success: "HEAD 返回成功", http_not_found: "收到 404 或 410", http_restricted: "访问或频率受限", head_unsupported: "网站不支持 HEAD",
  redirect_not_approved: "跳转目标未获批准", redirect_limit: "跳转次数超限", request_timeout: "检查超时", network_error: "网络检查未完成",
  network_address_blocked: "目标网络地址受限", http_other: "返回其他状态", robots_disallowed: "robots 不允许检查", robots_unavailable: "无法可靠读取 robots", resource_changed: "审核版本已经改变",
};
export function AdminResourceLinkMaintenancePanel() {
  const saved = useApi<ResourceLinkMaintenanceStatus>("/admin/resources/link-checks", { timeoutMs: 15000 });
  return <section className={styles.panel} aria-label="资源入口维护" aria-busy={saved.loading}>
    <div className={styles.titleRow}><h2>资源入口维护</h2><button type="button" className={styles.secondary} disabled={saved.loading} onClick={() => void saved.reload()}>{saved.loading ? "正在读取…" : "刷新检查记录"}</button></div>
    <p className={styles.muted}>后台只检查当前已经审核发布的入口，每个网站至少间隔 24 小时。这些结果用于提示人工核对，不会自动修改发布状态；刷新这里只读取记录。</p>
    <Feedback error={saved.error}/>
    {saved.data && <>
      <p>最近一轮完成：{dateText(saved.data.state?.lastCompletedAt)}。{saved.data.state?.phase === "running" ? "检查正在进行。" : saved.data.state?.phase === "stale" ? "检查租约已过期，等待后台接续。" : saved.data.state ? "下一轮由后台按频率安排。" : "后台尚未开始这项维护。"}</p>
      {saved.data.results.length === 0 ? <Empty>还没有当前审核版本的检查记录。待后台检查后，这里会显示结果。</Empty> : <ul className={styles.list}>{saved.data.results.map(item => <li key={`${item.resourceId}:${item.resourceRevision}`}>
        <strong style={{ overflowWrap: "anywhere" }}>{item.hostname}</strong> <span className={styles.tag}>{states[item.status]}</span>
        <p>{reasons[item.reason] ?? "需要人工核对"}{item.httpStatus !== null && ` · HTTP ${item.httpStatus}`}</p>
        <p className={styles.muted}>资源 {item.resourceId} · 内容版本 {item.resourceVersion} · {dateText(item.checkedAt)}</p>
      </li>)}</ul>}
    </>}
  </section>;
}
