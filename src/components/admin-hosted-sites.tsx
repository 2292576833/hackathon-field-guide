"use client";

import { useCallback, useEffect, useState } from "react";
import { api, message as errorMessage } from "./client-api.ts";
import styles from "./event-site-editor.module.css";

interface Summary {
  readonly eventId: string; readonly organizationId: string;
  readonly status: "draft" | "published" | "suspended";
  readonly shortCode: string | null; readonly revision: number;
  readonly publishedRevision: number | null; readonly hasPublished: boolean;
  readonly suspensionKind: "organizer" | "platform" | null; readonly updatedAt: string;
}
interface Inventory { readonly organizationId: string | null; readonly items: readonly Summary[]; readonly truncated: boolean }

const labels: Record<Summary["status"], string> = { draft: "草稿", published: "已发布", suspended: "已停用" };

/**
 * 规划35 §11：管理后台的**只读清点** + 停用/恢复；不能替主办方编辑。
 * 停用不影响平台默认页与报名/提交/结果。
 */
export function AdminHostedSites() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("平台停用：请先核对内容");
  const load = useCallback(async () => {
    setFailure("");
    try { setInventory(await api<Inventory>("/admin/hosted-sites")); }
    catch (error) { setFailure(errorMessage(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function act(item: Summary, action: "suspend" | "resume") {
    if (busy) return;
    setBusy(true); setFailure(""); setNotice("");
    try {
      await api(`/admin/hosted-sites/${encodeURIComponent(item.eventId)}/${action}`, {
        method: "POST", body: action === "suspend" ? { expectedRevision: item.revision, reason } : { expectedRevision: item.revision },
      });
      setNotice(action === "suspend" ? "已停用该专属页；平台赛事页与报名不受影响。" : "已恢复该专属页。");
      await load();
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  }
  if (failure && inventory === null) return <p role="alert">没有读到专属页清单：{failure}</p>;
  if (inventory === null) return <p>正在读取专属页清单…</p>;
  return (
    <section>
      <h1>主办方专属页（只读清点）</h1>
      <p className={styles.rowMeta}>平台只做清点与停用，不替主办方编辑页面。停用不会删除数据，短码保留可恢复。</p>
      <label className={styles.field}><span>停用理由（会记入审计）</span>
        <input value={reason} maxLength={200} onChange={event => setReason(event.target.value)} />
      </label>
      {notice && <p role="status">{notice}</p>}
      {failure && <p role="alert">{failure}</p>}
      {inventory.items.length === 0 ? <p className={styles.rowMeta}>还没有主办方创建专属页。</p> : (
        <table>
          <thead><tr><th>赛事</th><th>状态</th><th>短码</th><th>版本</th><th>停用来源</th><th>操作</th></tr></thead>
          <tbody>
            {inventory.items.map(item => (
              <tr key={item.eventId}>
                <td className={styles.code}>{item.eventId}</td>
                <td>{labels[item.status]}</td>
                <td className={styles.code}>{item.shortCode ?? "—"}</td>
                <td>{item.revision}{item.publishedRevision === null ? "" : ` / 线上 ${item.publishedRevision}`}</td>
                <td>{item.suspensionKind === null ? "—" : item.suspensionKind === "platform" ? "平台" : "主办方"}</td>
                <td>
                  {item.status === "suspended"
                    ? <button type="button" disabled={busy} onClick={() => void act(item, "resume")}>恢复</button>
                    : <button type="button" disabled={busy} onClick={() => void act(item, "suspend")}>停用</button>}
                </td>
              </tr>))}
          </tbody>
        </table>) }
      {inventory.truncated ? <p className={styles.rowMeta}>清单已截断，只显示前一部分。</p> : null}
    </section>);
}
