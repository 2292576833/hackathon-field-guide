"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AccountDataOverview, AccountDeletionSummary, DataExportSummary, DeletionImpact } from "./account-types.ts";
import styles from "./account-controls.module.css";

export interface AccountDataControlsApi {
  getOverview(): Promise<AccountDataOverview>;
  requestExport(): Promise<DataExportSummary>;
  prepareExport(id: string, expectedRevision: number): Promise<DataExportSummary>;
  downloadExport(id: string): Promise<{ readonly filename: string; readonly json: string }>;
  requestDeletion(): Promise<AccountDeletionSummary>;
  refreshDeletion(id: string, expectedRevision: number): Promise<AccountDeletionSummary>;
  cancelDeletion(id: string, expectedRevision: number): Promise<AccountDeletionSummary>;
}

export interface AccountDataControlsProps {
  readonly initialState: AccountDataOverview;
  readonly api: AccountDataControlsApi;
  readonly onSessionExpired?: () => void;
  readonly onReauthenticate?: () => void;
}

function readableTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + "（北京时间）";
}

function failureDetails(reason: unknown): { code: string; message: string; sessionExpired: boolean; reauthenticate: boolean } {
  const outer = reason && typeof reason === "object" ? reason as { code?: unknown; message?: unknown; status?: unknown; recoveryAction?: unknown; error?: unknown } : {};
  const nested = outer.error && typeof outer.error === "object" ? outer.error as typeof outer : outer;
  const code = typeof nested.code === "string" ? nested.code : "";
  const known = /^[A-Z][A-Z0-9_]{0,127}$/.test(code);
  const sessionExpired = ["UNAUTHENTICATED", "AUTH_SESSION_REQUIRED", "AUTH_SESSION_EXPIRED", "AUTH_SESSION_REVOKED"].includes(code);
  return {
    code,
    message: sessionExpired ? "登录已失效，请重新登录后查看本人数据。" : known && typeof nested.message === "string" ? nested.message : "操作结果暂未确认，请刷新状态后再继续。",
    sessionExpired,
    reauthenticate: code === "AUTH_REAUTHENTICATION_REQUIRED" || nested.recoveryAction === "reauthenticate",
  };
}

function remediationLink(value: string): string | null {
  return /^\/(?!\/)[A-Za-z0-9/_?=&%#.-]*$/.test(value) ? value : null;
}

function DeletionImpactDetails({ impact }: { readonly impact: DeletionImpact }) {
  return <div className={styles.impact}>
    <p>删除处理将涉及网站账号与本人私人资料。队友的共享成果、必要审计记录和外部 GitHub 仓库需要分别处理，提交申请不会自动删除这些内容。</p>
    {impact.notices.length > 0 && <ul className={styles.notices}>{impact.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}
    {impact.lastManagerProjects.length > 0 && <div className={styles.warning}>
      <strong>先处理最后管理员身份</strong>
      <p>以下团队空间目前只有你一名管理员。请先转交管理员或按空间规则归档，再刷新检查结果。</p>
      <ul className={styles.notices}>{impact.lastManagerProjects.map(project => <li key={project.projectId}>
        {remediationLink(project.remediationUrl) ? <a className={styles.link} href={remediationLink(project.remediationUrl)!}>{project.name} · 前往转交或归档</a> : <span>{project.name} · 请打开该团队空间转交或归档</span>}
      </li>)}</ul>
    </div>}
  </div>;
}

const exportStatus: Record<DataExportSummary["status"], string> = {
  queued: "等待整理", ready: "可以下载", failed: "整理失败", expired: "已过期",
};
const exportFailure: Record<string, string> = {
  ACCOUNT_EXPORT_COLLECTION_FAILED: "整理资料时未完成，确认服务恢复后可重试。",
  ACCOUNT_EXPORT_TOO_LARGE: "资料超过本次导出的数量或大小上限，请联系站点支持处理。",
  ACCOUNT_EXPORT_SCOPE_INVALID: "项目权限已变化，请刷新状态并重新申请。",
  ACCOUNT_EXPORT_UNSAFE_DATA: "资料安全检查未通过，请联系站点支持处理。",
};
const deletionStatus: Record<AccountDeletionSummary["status"], string> = {
  pending: "申请已保存，等待处理", blocked: "申请已保存，需要先处理团队空间", processing: "已进入删除处理", cancelled: "申请已取消",
};

/** Owner-only controls. The root injects authenticated APIs; no account ID is sent from this form. */
export function AccountDataControls({ initialState, api, onSessionExpired, onReauthenticate }: AccountDataControlsProps) {
  const [overview, setOverview] = useState(initialState);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsAuthentication, setNeedsAuthentication] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const confirmationId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOverview(initialState); }, [initialState]);

  async function run(label: string, work: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(label); setError(""); setNotice(""); setNeedsAuthentication(false);
    try { await work(); }
    catch (reason) {
      if (!mounted.current) return;
      const failure = failureDetails(reason);
      setError(failure.message); setNeedsAuthentication(failure.reauthenticate);
      if (failure.sessionExpired) {
        setSessionExpired(true);
        setOverview({ exports: [], deletionRequest: null, impact: { lastManagerProjects: [], notices: [] } });
        onSessionExpired?.();
      }
    } finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  function saveExport(next: DataExportSummary) {
    if (!mounted.current) return;
    setOverview(current => ({ ...current, exports: [next, ...current.exports.filter(record => record.id !== next.id)] }));
  }
  function saveDeletion(next: AccountDeletionSummary) {
    if (!mounted.current) return;
    setOverview(current => ({ ...current, deletionRequest: next, impact: next.impact }));
    setConfirmed(false);
  }
  const deletion = overview.deletionRequest;
  const canRequestDeletion = !deletion || deletion.status === "cancelled";
  const blocked = Boolean(busy) || sessionExpired;

  return <section className={styles.controls} aria-label="本人数据与删除申请" aria-busy={Boolean(busy)}>
    <header className={styles.header}><div><h2>本人数据与删除申请</h2><p className={styles.muted}>查看保存的申请状态，按需要导出资料或申请删除账号。</p></div>
      <button type="button" className={styles.secondary} disabled={blocked} onClick={() => void run("refresh", async () => {
        const latest = await api.getOverview();
        if (mounted.current) { setOverview(latest); setNotice("已读取最新申请状态。"); }
      })}>{busy === "refresh" ? "正在读取…" : "刷新状态"}</button>
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {needsAuthentication && <div className={styles.warning}><p>提交删除申请需要近期验证邮箱。重新认证后，请再核对影响并提交。</p>{onReauthenticate ? <button type="button" className={styles.secondary} onClick={onReauthenticate}>重新验证当前邮箱</button> : <a className={styles.link} href="/login?returnTo=%2Fapp%2Faccount">重新登录认证</a>}</div>}
    {notice && <p className={styles.success} role="status">{notice}</p>}
    {!sessionExpired && <>
      <div className={styles.section}>
        <h3>导出我的资料</h3>
        <p className={styles.muted}>包含本人资料、对话、生成记录、原始测评、复盘、收藏及当前有权查看的项目摘要。导出只供本人下载，有效期和整理结果以每份请求为准。</p>
        <div className={styles.actions}><button type="button" className={styles.primary} disabled={blocked} onClick={() => void run("request-export", async () => {
          const next = await api.requestExport(); saveExport(next);
          if (mounted.current) setNotice("导出申请已保存。点击“整理这份资料”继续准备下载。");
        })}>{busy === "request-export" ? "正在申请…" : "申请新的导出"}</button></div>
        {overview.exports.length === 0 ? <p className={styles.empty}>还没有导出申请。申请后会在这里保留状态。</p> : <ul className={styles.records}>{overview.exports.map(record => <li key={record.id} className={styles.record}>
          <div className={styles.recordTop}><strong>申请于 {readableTime(record.createdAt)}</strong><span className={record.status === "failed" ? styles.badgeWarning : styles.badge}>{exportStatus[record.status]}</span></div>
          <p className={styles.muted}>有效期至 {readableTime(record.expiresAt)}{record.byteLength !== null && <> · {Math.ceil(record.byteLength / 1024)} KB</>} · 已整理 {record.attempts} 次</p>
          {record.errorCode && <p className={styles.error}>{exportFailure[record.errorCode] ?? "本次整理未完成，请刷新状态或联系站点支持。"}<span className={styles.code}>错误编号：{record.errorCode}</span></p>}
          <div className={styles.actions}>
            {(record.status === "queued" || record.status === "failed") && <button type="button" className={styles.secondary} disabled={blocked || record.attempts >= 3} onClick={() => void run(`prepare-${record.id}`, async () => {
              const next = await api.prepareExport(record.id, record.revision); saveExport(next);
              if (mounted.current) setNotice(next.status === "ready" ? "资料已整理完成，可以下载。" : "已保存本次整理结果，请查看该申请的状态。");
            })}>{busy === `prepare-${record.id}` ? "正在整理…" : record.status === "failed" ? "重试整理" : "整理这份资料"}</button>}
            {record.status === "ready" && <button type="button" className={styles.primary} disabled={blocked} onClick={() => void run(`download-${record.id}`, async () => {
              const file = await api.downloadExport(record.id);
              if (!mounted.current) return;
              const url = URL.createObjectURL(new Blob([file.json], { type: "application/json;charset=utf-8" }));
              const link = document.createElement("a");
              link.href = url; link.download = file.filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180) || "my-account-data.json";
              try { document.body.appendChild(link); link.click(); setNotice("已开始下载本人资料。请妥善保管导出文件。"); }
              finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
            })}>{busy === `download-${record.id}` ? "正在读取…" : "下载 JSON 资料"}</button>}
            {record.status === "expired" && <p className={styles.muted}>这份下载已失效，需要重新申请。</p>}
            {record.status === "failed" && record.attempts >= 3 && <p className={styles.muted}>已达到本次重试上限，可稍后重新申请或联系站点支持。</p>}
          </div>
        </li>)}</ul>}
      </div>
      <div className={styles.section}>
        <h3>申请删除账号</h3>
        {deletion && <div className={deletion.status === "blocked" ? styles.warning : styles.note}>
          <strong>{deletionStatus[deletion.status]}</strong><p>申请于 {readableTime(deletion.createdAt)} · 更新于 {readableTime(deletion.updatedAt)}</p>
          {deletion.status === "processing" ? <p>已进入实际处理阶段，不能在这里取消。此状态不表示删除已经完成；进入处理后旧登录会话会退出。</p> : deletion.status !== "cancelled" && <p>申请成功只表示已保存请求，账号尚未删除。进入实际处理前可以取消。</p>}
        </div>}
        <DeletionImpactDetails impact={deletion?.impact ?? overview.impact}/>
        {canRequestDeletion && <>
          <label className={styles.check} htmlFor={confirmationId}><input id={confirmationId} type="checkbox" checked={confirmed} disabled={blocked} onChange={event => setConfirmed(event.target.checked)}/><span>我已阅读以上影响说明，确认提交本人账号的删除申请。</span></label>
          <button type="button" className={styles.danger} disabled={blocked || !confirmed} onClick={() => void run("request-deletion", async () => {
            const next = await api.requestDeletion(); saveDeletion(next);
            if (mounted.current) setNotice(next.status === "blocked" ? "申请已保存，请先处理最后管理员身份。账号尚未删除。" : "删除申请已保存，账号尚未删除。进入实际处理前可以取消。");
          })}>{busy === "request-deletion" ? "正在保存申请…" : "确认提交删除申请"}</button>
        </>}
        {deletion && ["pending", "blocked"].includes(deletion.status) && <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={blocked} onClick={() => void run("refresh-deletion", async () => {
            const next = await api.refreshDeletion(deletion.id, deletion.revision); saveDeletion(next);
            if (mounted.current) setNotice("已重新检查删除影响，请查看申请状态。");
          })}>{busy === "refresh-deletion" ? "正在检查…" : "重新检查删除影响"}</button>
          <button type="button" className={styles.secondary} disabled={blocked} onClick={() => void run("cancel-deletion", async () => {
            const next = await api.cancelDeletion(deletion.id, deletion.revision); saveDeletion(next);
            if (mounted.current) setNotice("删除申请已取消。");
          })}>{busy === "cancel-deletion" ? "正在取消…" : "取消删除申请"}</button>
        </div>}
      </div>
    </>}
  </section>;
}
