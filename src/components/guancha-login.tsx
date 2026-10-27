"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, message, useApi } from "./client-api.ts";
import { GuanchaLogo } from "./guancha-logo.tsx";
import { Feedback, Loading, PageTitle, SiteShell, type Me } from "./site-shell.tsx";
import styles from "./site.module.css";

interface GuanchaStatus { enabled: boolean; pending: boolean; linked: boolean; returnTo?: string }
const linkPage = "/app/account/guancha";
const loginHref = `/login?returnTo=${encodeURIComponent(linkPage)}`;
const registerHref = `/register?returnTo=${encodeURIComponent(linkPage)}`;

export function GuanchaLoginButton({ returnTo }: { returnTo: string }) {
  const state = useApi<GuanchaStatus>("/auth/guancha/status");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [callbackMessage, setCallbackMessage] = useState("");
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("guancha");
    if (reason === "cancelled") setCallbackMessage("已取消观猹登录，可以重新尝试或使用邮箱验证码。");
    else if (reason === "failed") setCallbackMessage("这次观猹登录未完成。请重新尝试，或使用下方邮箱验证码登录。");
  }, []);
  async function begin() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const result = await api<{ authorizationUrl: string }>("/auth/guancha/begin", { method: "POST", body: { returnTo } });
      const url = new URL(result.authorizationUrl);
      if (url.origin !== "https://watcha.cn" || url.pathname !== "/oauth/authorize" || url.username || url.password) throw new Error("授权地址无法确认，请使用邮箱登录。");
      window.location.assign(url.href);
    } catch (reason) { setError(message(reason)); setPending(false); }
  }
  return <>
    <Feedback notice={callbackMessage} error={error}/>
    {state.data?.enabled && <div className={styles.form}>
      {state.data.pending ? <Link className={styles.secondary} href={linkPage}>继续关联观猹账号</Link>
        : <button type="button" className={`${styles.secondary} ${styles.guanchaButton}`} disabled={pending} onClick={() => void begin()}>
            <GuanchaLogo size={15}/>{pending ? "正在前往观猹…" : "使用观猹登录"}
          </button>}
      <p className={styles.muted}>首次使用需要验证邮箱并关联本站账号，以后可直接用观猹登录。</p>
    </div>}
  </>;
}

export function GuanchaLinkClient() {
  const state = useApi<GuanchaStatus>("/auth/guancha/status"), me = useApi<Me>("/me");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  async function confirm() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ returnTo: string }>("/auth/guancha/confirm", { method: "POST", body: { confirm: true } });
      const destination = new URL(result.returnTo, window.location.origin);
      if (destination.origin !== window.location.origin) throw new Error("回到网站后请从我的参赛继续。");
      window.location.assign(destination.href);
    } catch (reason) { setError(message(reason)); setBusy(false); await state.reload(); }
  }
  async function cancel() {
    if (busy) return;
    setBusy(true); setError("");
    try { await api("/auth/guancha/cancel", { method: "POST", body: {} }); window.location.assign("/login"); }
    catch (reason) { setError(message(reason)); setBusy(false); }
  }
  return <SiteShell><PageTitle title="关联观猹账号">首次关联后，观猹登录会进入同一个本站账号。</PageTitle>
    <section className={styles.panel} style={{ maxWidth: 560 }}>
      <Feedback error={state.data?.linked ? null : error || state.error || (!unauthenticated ? me.error : null)}/>
      {state.loading || me.loading ? <Loading/> : state.error ? <button className={styles.secondary} onClick={() => void state.reload()}>重新检查关联状态</button>
        : state.data?.linked ? <><p>观猹账号已成功关联到当前本站账号。</p><Link className={styles.button} href={state.data.returnTo ?? "/app"}>继续之前的操作</Link></>
        : !state.data?.pending ? <><p>当前没有待关联的观猹登录，或本次关联已过期。</p><Link className={styles.button} href="/login">返回登录</Link></>
        : me.data ? <>
          <h2>关联到这个账号？</h2><p>{me.data.profile.displayName} · {me.data.profile.email}</p>
          <p>关联后，使用刚才的观猹账号即可进入此账号，保留原有队伍、文档和任务。</p>
          <div className={styles.actions}><button className={styles.button} disabled={busy} onClick={() => void confirm()}>确认关联并继续</button><button className={styles.secondary} disabled={busy} onClick={() => void cancel()}>取消关联</button></div>
          <details><summary>需要重新验证邮箱或换账号？</summary><p>先退出本站，再用需要关联的邮箱登录；本次观猹关联约10分钟内有效。</p><button className={styles.secondary} disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await api("/auth/logout", { method: "POST" }); window.location.assign(loginHref); } catch (reason) { setError(message(reason)); setBusy(false); } }}>退出并验证邮箱</button></details>
        </> : unauthenticated ? <>
          <h2>先验证你的邮箱</h2><p>这样可以保留你在本站已有的参赛记录。没有本站账号也可以注册。</p>
          <div className={styles.actions}><Link className={styles.button} href={loginHref}>验证邮箱并登录</Link><Link className={styles.secondary} href={registerHref}>注册本站账号</Link><button className={styles.secondary} disabled={busy} onClick={() => void cancel()}>取消关联</button></div>
        </> : <button className={styles.secondary} onClick={() => void me.reload()}>重新读取账号</button>}
    </section></SiteShell>;
}
