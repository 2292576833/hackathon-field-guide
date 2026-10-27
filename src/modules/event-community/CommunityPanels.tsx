"use client";
import { useState } from "react";
import { api, dateText, message, operationKey, useApi } from "../../components/client-api.ts";
import {
  COMMUNITY_REPORT_REASONS,
  type CommunityOverview, type CommunityReportReason,
  type ConversationView, type DirectMessageView, type OrganizerReportsView,
} from "./model.ts";
import styles from "./event-community.module.css";

/**
 * 选手社区界面（规划 34 §4、宪法 XIII）。
 *
 * 纪律：
 * - 主办方没有开启能力时，服务端返回 403；这里**逐字显示服务端说明**，不渲染空列表冒充"功能可用"。
 * - 安全口径（双向同意、屏蔽举报、不暴露联系方式、不做年龄核验、不进模型训练）全部取自服务端字段，
 *   组件不另写一套说法。
 * - 没有任何"关注/粉丝"入口；也没有邮箱、电话字段，本组件不展示、不补全联系方式。
 * - 举报只提交事实；界面不提供"隐藏/裁决"操作（裁决在既有平台/主办方流程里）。
 */

const reportLabels: Record<CommunityReportReason, string> = {
  harassment: "骚扰或人身攻击",
  spam: "垃圾信息或刷屏",
  contact_touting: "索取或兜售联系方式",
  impersonation: "冒充他人",
  other: "其他",
};

function base(eventId: string) { return `/competitions/${encodeURIComponent(eventId)}/community`; }
function conversationPath(eventId: string, peerUserId: string) { return `${base(eventId)}/conversations/${encodeURIComponent(peerUserId)}`; }

export interface CommunityPanelProps { eventId: string; eventTitle: string }

/** 选手侧社区面板：能力开关 + 请求/连接/屏蔽 + 内嵌会话。 */
export function CommunityPanel({ eventId, eventTitle }: CommunityPanelProps) {
  const overview = useApi<CommunityOverview>(base(eventId));
  const [peer, setPeer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  const [peerInput, setPeerInput] = useState("");

  async function run(work: () => Promise<void>, success: string) {
    if (busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try { await work(); setNote(success); await overview.reload(); }
    catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }

  if (overview.error) return <section className={styles.panel} aria-label="选手社区">
    <h2>选手社区 · {eventTitle}</h2>
    <p className={styles.error}>{overview.error.message}</p>
    <p className={styles.hint}>连接与私信默认关闭；关闭时这里不会显示任何列表。</p>
    <button className={styles.secondary} type="button" onClick={() => void overview.reload()}>重新读取</button>
  </section>;
  if (!overview.data) return <section className={styles.panel} aria-label="选手社区">
    <h2>选手社区 · {eventTitle}</h2>
    <p className={styles.hint}>正在读取本场社区能力…</p>
  </section>;
  const data = overview.data;
  const blockedPeers = new Set(data.blocks.map(block => block.peerUserId));
  return <section className={styles.panel} aria-label="选手社区">
    <div className={styles.head}>
      <h2>选手社区 · {eventTitle}</h2>
      <span className={styles.badge}>{data.capabilities.connections ? "连接已开启" : "连接关闭"}</span>
      <span className={styles.badgeMuted}>{data.capabilities.directMessages ? "私信已开启" : "私信关闭"}</span>
    </div>
    <p className={styles.hint}>{data.notices.mutual}</p>
    <p className={styles.hint}>{data.notices.safety}</p>
    <p className={styles.hint}>{data.notices.age}</p>
    <p className={styles.hint}>{data.notices.training}</p>
    <p className={styles.hint}>{data.capabilities.retentionNotice}</p>
    {note && <p className={failed ? styles.error : styles.notice}>{note}</p>}

    <h3>向本场参赛者发起"想认识"</h3>
    <p className={styles.hint}>名录入口由既有参赛名片提供（P1）；这里只输入对方的账号标识。你还可同时有 {data.limits.pendingRemaining} 条待处理请求（上限 {data.limits.pendingLimit}）。</p>
    <div className={styles.actions}>
      <input className={styles.input} value={peerInput} onChange={event => setPeerInput(event.target.value)} placeholder="对方账号标识" aria-label="对方账号标识" />
      <button className={styles.primary} type="button" disabled={busy || !peerInput.trim()} onClick={() => void run(async () => {
        const key = operationKey();
        await api(base(eventId) + "/connections", { method: "POST", idempotencyKey: key, body: { peerUserId: peerInput.trim(), idempotencyKey: key } });
      }, "已发起连接请求，等待对方接受。")}>发起请求</button>
    </div>

    <h3>收到、发出的请求与已建立的连接</h3>
    {!data.incoming.length && !data.outgoing.length && !data.connections.length
      ? <p className={styles.empty}>目前没有请求或连接。连接必须双方同意，所以这里不会有"关注"。</p>
      : <ul className={styles.list}>
        {data.incoming.map(item => <li key={item.id}>
          <span>来自 {item.peerUserId} 的请求</span>
          <span className={styles.hint}> · {dateText(item.requestedAt)}</span>
          <div className={styles.actions}>
            <button className={styles.primary} type="button" disabled={busy} onClick={() => void run(async () => {
              await api(`${base(eventId)}/connections/${encodeURIComponent(item.id)}/respond`, { method: "POST", body: { decision: "accept", expectedRevision: item.revision } });
            }, "已接受，现在可以互相发消息。")}>接受</button>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => void run(async () => {
              await api(`${base(eventId)}/connections/${encodeURIComponent(item.id)}/respond`, { method: "POST", body: { decision: "reject", expectedRevision: item.revision } });
            }, `已拒绝；同一对账号在 ${data.limits.rejectCooldownDays} 天内不能再次发起。`)}>拒绝</button>
          </div>
        </li>)}
        {data.outgoing.map(item => <li key={item.id}>
          <span>等待 {item.peerUserId} 回应</span>
          <span className={styles.hint}> · {dateText(item.requestedAt)}</span>
          <div className={styles.actions}>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => void run(async () => {
              await api(`${base(eventId)}/connections/${encodeURIComponent(item.id)}/cancel`, { method: "POST", body: { expectedRevision: item.revision } });
            }, "已取消请求。")}>取消请求</button>
          </div>
        </li>)}
        {data.connections.map(item => <li key={item.id}>
          <span>{item.peerUserId}</span>
          <span className={styles.hint}> · 已连接于 {dateText(item.connectedAt)}{item.blocked ? " · 已屏蔽" : ""}</span>
          <div className={styles.actions}>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => setPeer(item.peerUserId)}>打开会话</button>
            {blockedPeers.has(item.peerUserId)
              ? <button className={styles.secondary} type="button" disabled={busy} onClick={() => void run(async () => {
                await api(base(eventId) + "/blocks/delete", { method: "POST", body: { peerUserId: item.peerUserId } });
              }, "已解除屏蔽；此前的事实与冷却不会被撤销。")}>解除屏蔽</button>
              : <button className={styles.secondary} type="button" disabled={busy} onClick={() => void run(async () => {
                await api(base(eventId) + "/blocks", { method: "POST", body: { peerUserId: item.peerUserId } });
              }, "已屏蔽，对方不能再发起连接或发消息。")}>屏蔽</button>}
          </div>
        </li>)}
      </ul>}
    <p className={styles.hint}>{data.notices.block}</p>

    {peer && <CommunityConversation eventId={eventId} peerUserId={peer} onClose={() => setPeer(null)} onChanged={() => void overview.reload()} />}
    {!!data.blocks.length && <details><summary>我屏蔽的账号（{data.blocks.length}）</summary>
      <ul className={styles.list}>{data.blocks.map(block => <li key={block.peerUserId}>{block.peerUserId}<span className={styles.hint}> · {dateText(block.blockedAt)}</span></li>)}</ul>
    </details>}

    <ul className={styles.limits}>{data.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}

export interface CommunityConversationProps { eventId: string; peerUserId: string; onClose?: () => void; onChanged?: () => void }

/** 一段会话：只在已连接时可见；撤回后双方都看不到正文。 */
export function CommunityConversation({ eventId, peerUserId, onClose, onChanged }: CommunityConversationProps) {
  const view = useApi<ConversationView>(conversationPath(eventId, peerUserId));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState<CommunityReportReason>("harassment");
  const [detail, setDetail] = useState("");

  async function run(work: () => Promise<void>, success: string) {
    if (busy) return;
    setBusy(true); setNote(""); setFailed(false);
    try { await work(); setNote(success); await view.reload(); onChanged?.(); }
    catch (error) { setFailed(true); setNote(message(error)); }
    finally { setBusy(false); }
  }

  if (view.error) return <div className={styles.block}><h3>与 {peerUserId} 的会话</h3>
    <p className={styles.error}>{view.error.message}</p>
    {onClose && <button className={styles.secondary} type="button" onClick={onClose}>关闭</button>}</div>;
  if (!view.data) return <div className={styles.block}><h3>与 {peerUserId} 的会话</h3><p className={styles.hint}>正在读取…</p></div>;
  const data = view.data;
  return <div className={styles.block}>
    <div className={styles.head}><h3>与 {peerUserId} 的会话</h3>
      <span className={styles.badge}>{data.messagesEnabled ? "可以发送" : "私信关闭 · 只读"}</span>
      {onClose && <button className={styles.secondary} type="button" onClick={onClose}>关闭</button>}
    </div>
    <p className={styles.hint}>{data.retentionNotice}</p>
    <p className={styles.hint}>{data.notices.safety}</p>
    {note && <p className={failed ? styles.error : styles.notice}>{note}</p>}
    {!data.messages.length ? <p className={styles.empty}>还没有消息。平台不会替你们交换联系方式；是否交换由你们自己决定。</p>
      : <ul className={styles.messages}>{data.messages.map(item => <MessageRow key={item.id} item={item}
        onWithdraw={() => void run(async () => {
          await api(`${base(eventId)}/messages/${encodeURIComponent(item.id)}/withdraw`, { method: "POST", body: { expectedRevision: item.revision } });
        }, "已撤回；对方不再看到这条消息的内容。")} disabled={busy} />)}</ul>}
    {data.canSend ? <div className={styles.form}>
      <textarea className={styles.textarea} value={draft} maxLength={data.limits.messageMaxLength}
        onChange={event => setDraft(event.target.value)} placeholder={`最多 ${data.limits.messageMaxLength} 个字符`} aria-label="消息内容" />
      <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={busy || !draft.trim()} onClick={() => void run(async () => {
          const key = operationKey();
          await api(base(eventId) + "/messages", { method: "POST", idempotencyKey: key, body: { peerUserId, content: draft, idempotencyKey: key } });
          setDraft("");
        }, "已发送；通知只走既有通知通道。")}>发送</button>
        <span className={styles.hint}>本窗口还可发 {data.limits.rateRemaining} 条（每 {Math.round(data.limits.messageRateWindowSeconds / 60)} 分钟最多 {data.limits.messageRateMax} 条）。</span>
      </div>
    </div> : <p className={styles.hint}>{data.sendBlockedReason}</p>}
    <details><summary>举报（只记录事实与最近消息快照）</summary>
      <p className={styles.hint}>{data.notices.report}</p>
      <div className={styles.form}>
        <select className={styles.select} value={reason} onChange={event => setReason(event.target.value as CommunityReportReason)} aria-label="举报原因">
          {COMMUNITY_REPORT_REASONS.map(value => <option key={value} value={value}>{reportLabels[value]}</option>)}
        </select>
        <textarea className={styles.textarea} value={detail} maxLength={1000} onChange={event => setDetail(event.target.value)} placeholder="补充说明（可留空）" aria-label="举报说明" />
        <button className={styles.secondary} type="button" disabled={busy} onClick={() => void run(async () => {
          const key = operationKey();
          await api(base(eventId) + "/reports", { method: "POST", idempotencyKey: key, body: { peerUserId, reason, detail, idempotencyKey: key } });
          setDetail("");
        }, "已提交举报；平台与主办方按既有权限处理，本模块不自行裁决。")}>提交举报</button>
      </div>
    </details>
    <div className={styles.actions}>
      <button className={styles.secondary} type="button" disabled={busy} onClick={() => void run(async () => {
        await api(base(eventId) + "/blocks", { method: "POST", body: { peerUserId } });
      }, "已屏蔽；对方不能继续发消息或发起连接。")}>屏蔽对方</button>
    </div>
  </div>;
}

function MessageRow({ item, onWithdraw, disabled }: { item: DirectMessageView; onWithdraw: () => void; disabled: boolean }) {
  const withdrawn = item.withdrawn || item.purged;
  return <li className={styles.message}>
    <span className={styles.meta}>{item.mine ? "我" : "对方"} · {dateText(item.createdAt)}</span>
    <span className={withdrawn ? styles.hint : styles.body}>{item.display}</span>
    {item.mine && item.status === "active" && <button className={styles.secondary} type="button" disabled={disabled} onClick={onWithdraw}>撤回</button>}
  </li>;
}

export interface OrganizerCommunityReportsPanelProps { eventId: string; eventTitle: string }

/** 主办方举报队列：只读，只含被举报连接的快照；没有读取任意私信的通道。 */
export function OrganizerCommunityReportsPanel({ eventId, eventTitle }: OrganizerCommunityReportsPanelProps) {
  const view = useApi<OrganizerReportsView>(`/organizer/events/${encodeURIComponent(eventId)}/community/reports`);
  if (view.error) return <section className={styles.panel} aria-label="举报处理">
    <h2>选手社区举报 · {eventTitle}</h2>
    <p className={styles.error}>{view.error.message}</p>
    <button className={styles.secondary} type="button" onClick={() => void view.reload()}>重新读取</button></section>;
  if (!view.data) return <section className={styles.panel} aria-label="举报处理">
    <h2>选手社区举报 · {eventTitle}</h2><p className={styles.hint}>正在读取举报记录…</p></section>;
  const data = view.data;
  return <section className={styles.panel} aria-label="举报处理">
    <div className={styles.head}><h2>选手社区举报 · {eventTitle}</h2><span className={styles.badge}>{data.count} 条</span></div>
    <p className={styles.hint}>{data.notice}</p>
    {!data.reports.length ? <p className={styles.empty}>目前没有举报记录。未被举报的对话不会出现在这里。</p>
      : <ul className={styles.list}>{data.reports.map(report => <li key={report.id}>
        <div className={styles.cardTop}><strong>{report.reasonLabel}</strong><span className={styles.badge}>待处理</span></div>
        <p className={styles.hint}>举报人 {report.reporterUserId} → 被举报 {report.reportedUserId} · {dateText(report.createdAt)}</p>
        {report.detail && <p>{report.detail}</p>}
        {report.snapshot.length
          ? <ul className={styles.messages}>{report.snapshot.map(entry => <li key={entry.messageId} className={styles.message}>
            <span className={styles.meta}>{entry.senderUserId} → {entry.recipientUserId} · {dateText(entry.createdAt)} · {entry.status}</span>
            <span className={entry.content ? styles.body : styles.hint}>{entry.content ?? "正文未复制（撤回、已清理或保留口径为到期清理）。"}</span>
          </li>)}</ul>
          : <p className={styles.hint}>这条举报没有消息快照（当时没有已连接的消息）。</p>}
      </li>)}</ul>}
    <ul className={styles.limits}>{data.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}
