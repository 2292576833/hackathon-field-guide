"use client";

import { useCallback, useEffect, useState } from "react";
import { api, message as errorMessage } from "./client-api.ts";
import styles from "./mcp-tokens.module.css";

/**
 * 接入令牌（PAT）管理：给编码工具用的 MCP 插件。
 *
 * 明文只在创建时显示一次；之后列表里只有前缀、权限、过期与调用次数。
 */
interface TokenView {
  readonly id: string; readonly name: string; readonly scopes: readonly string[];
  readonly createdAt: string; readonly expiresAt: string | null; readonly revokedAt: string | null;
  readonly lastUsedAt: string | null; readonly callCount: number;
}
interface Grant { readonly secret: string; readonly token: TokenView }

const SCOPE_LABELS: Record<string, string> = {
  "events:read": "查赛事", "me:read": "我的报名与材料", "hall:read": "组队大厅", "ai:ask": "向专员提问（消耗额度）",
};

export function McpTokens() {
  const [tokens, setTokens] = useState<readonly TokenView[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>(["events:read", "me:read"]);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try { const data = await api<{ tokens?: readonly TokenView[] }>("/me/mcp-tokens"); setTokens(data.tokens ?? []); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (busy || name.trim() === "" || scopes.length === 0) return;
    setBusy(true); setError(""); setSecret("");
    try {
      const grant = await api<Grant>("/me/mcp-tokens", { method: "POST", body: { name: name.trim(), scopes } });
      setSecret(grant.secret);
      setName("");
      await load();
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await api("/me/mcp-tokens/" + encodeURIComponent(id), { method: "DELETE" }); await load(); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }

  return (
    <section className={styles.panel}>
      <h2>接入令牌（给编码工具用）</h2>
      <p className={styles.muted}>在你常用的编码工具里装上本站的 MCP 插件，就能直接查赛事、看报名、问专员。令牌只显示一次，服务端只保存它的哈希。</p>
      <div className={styles.row}>
        <input className={styles.input} value={name} maxLength={60} placeholder="令牌名字，例如「我的 Claude Code」" onChange={event => setName(event.target.value)}/>
        <button type="button" className={styles.primary} disabled={busy || name.trim() === ""} onClick={() => void create()}>{busy ? "处理中…" : "生成令牌"}</button>
      </div>
      <div className={styles.scopes}>
        {Object.entries(SCOPE_LABELS).map(([key, label]) => (
          <label key={key} className={styles.scope}>
            <input type="checkbox" checked={scopes.includes(key)}
              onChange={event => setScopes(current => event.target.checked ? [...current, key] : current.filter(item => item !== key))}/>
            {label}
          </label>))}
      </div>
      {error === "" ? null : <p role="alert" className={styles.error}>{error}</p>}
      {secret === "" ? null : (
        <div className={styles.secret}>
          <p>复制它，填进你的工具配置；关掉就再也看不到了。</p>
          <code>{secret}</code>
        </div>)}
      <h3 className={styles.subhead}>已有令牌</h3>
      {!loaded ? <p className={styles.muted}>读取中…</p> : tokens.length === 0 ? <p className={styles.muted}>还没有令牌。</p> : (
        <ul className={styles.list}>
          {tokens.map(token => (
            <li key={token.id} className={styles.item}>
              <div>
                <strong>{token.name}</strong>
                <p className={styles.meta}>
                  {token.scopes.map(scope => SCOPE_LABELS[scope] ?? scope).join(" · ")}
                  {" · 调用 "}{token.callCount}{" 次"}
                  {token.expiresAt === null ? "" : " · 到期 " + new Date(token.expiresAt).toLocaleDateString("zh-CN")}
                  {token.revokedAt === null ? "" : " · 已撤销"}
                </p>
              </div>
              {token.revokedAt === null ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void revoke(token.id)}>撤销</button> : null}
            </li>))}
        </ul>)}
    </section>);
}
