"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, dateText, message, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, PageTitle, SiteShell } from "./site-shell.tsx";
import type { Me, SystemStatus } from "./site-shell.tsx";
import styles from "./site.module.css";
import { GuanchaLoginButton } from "./guancha-login.tsx";

interface Challenge { challengeId: string; expiresAt: string; resendAfterSeconds: number }

function internalReturnTo(value: string | null): string {
  return value && value.length <= 2048 && value.startsWith("/") && !value.startsWith("//")
    && !/[\\\u0000-\u0020\u007f#]/.test(value) ? value : "/app";
}

export function LoginClient({ mode = "login", testAccess = false }: { mode?: "login" | "register"; testAccess?: boolean }) {
  const registration = mode === "register";
  const testLogin = testAccess && !registration;
  const [testCredential, setTestCredential] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState(""); const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [returnTo, setReturnTo] = useState("/app");
  const [resendAt, setResendAt] = useState(0); const [now, setNow] = useState(0);
  const status = useApi<SystemStatus>("/system/status"); const identity = useApi<Me>("/me");
  useEffect(() => { setReturnTo(internalReturnTo(new URLSearchParams(window.location.search).get("returnTo"))); }, []);
  useEffect(() => {
    if (!challenge) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);
  useEffect(() => { setChallenge(null); setCode(""); setTestCredential(""); setError(""); setNotice(""); }, [mode, testLogin]);
  const waitSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = challenge && now >= Date.parse(challenge.expiresAt);
  const identityError = identity.error instanceof ApiError && identity.error.status === 401 ? null : identity.error;
  const base = registration ? "/auth/registration-challenges" : "/auth/login-challenges";

  async function send() {
    if (pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const result = await api<Challenge>(base, { method: "POST", body: registration ? { email, displayName } : { email } });
      setChallenge(result); setCode(""); setNow(Date.now()); setResendAt(Date.now() + result.resendAfterSeconds * 1000);
      const delivery = status.data?.email === "preview"
        ? "验证码已写入本地开发邮箱预览，没有发送到真实邮箱。"
        : status.data?.email === "configured" ? "邮件服务已受理验证码，请查看收件箱和垃圾邮件。"
        : "验证码请求已受理，当前投递方式尚未确认。";
      setNotice(`${delivery} 重发后旧验证码会失效。`);
    } catch (reason) { setError(message(reason)); }
    finally { setPending(false); }
  }

  async function verify() {
    if (!challenge || pending) return;
    setPending(true); setError("");
    try {
      const result = await api<{ returnTo: string }>(`${base}/verify`, { method: "POST", body: { challengeId: challenge.challengeId, code, returnTo } });
      window.location.assign(internalReturnTo(result.returnTo));
    } catch (reason) { setError(message(reason)); }
    finally { setPending(false); }
  }

  async function verifyTestAccess() {
    if (pending) return;
    const credential = /^([A-Za-z0-9_-]{1,128})\.([0-9]{8})$/.exec(testCredential.trim());
    if (!credential) { setError("请粘贴完整的管理员测试凭证，保留中间的英文句点。"); return; }
    setPending(true); setError("");
    try {
      const result = await api<{ returnTo: string }>("/auth/login-challenges/verify", { method: "POST", body: { challengeId: credential[1], code: credential[2], returnTo } });
      setTestCredential("");
      window.location.assign(internalReturnTo(result.returnTo));
    } catch (reason) { setError(message(reason)); }
    finally { setPending(false); }
  }

  return <SiteShell><PageTitle eyebrow={testLogin ? "ADMIN / 管理测试" : registration ? "REGISTER / 开始参赛" : "WELCOME / 继续参赛"} title={testLogin ? "管理员测试登录" : registration ? "创建账号，开始你的第一场黑客松。" : "登录，接着把作品做完。"}>
    {testLogin ? "粘贴部署主机签发的测试凭证，再进入管理后台。凭证限时使用一次，不会发送验证码邮件。" : registration ? "填写姓名和邮箱，验证邮箱后创建账号。无需设置密码；参赛画像可以登录后再补充。" : "使用邮箱验证码登录，无需输入密码。同一个邮箱会找回你的账号和已保存内容。"}
  </PageTitle>
    <section className={styles.panel} style={{ maxWidth: 520 }}>
      {identity.loading ? <Loading /> : identity.data ? <><h2>你已登录</h2><p>{identity.data.profile.displayName} · {identity.data.profile.email}</p><div className={styles.actions}><Link className={styles.button} href={returnTo}>继续之前的操作</Link><Link className={styles.secondary} href="/app/account">查看账号与参赛画像</Link></div><p className={styles.muted}>如需使用另一个邮箱，打开顶部「我的账号」菜单，选择「退出登录」后再登录。</p></> : <>
        <Feedback error={identityError} />{identityError && <button type="button" className={styles.secondary} onClick={() => void identity.reload()}>重新检查登录状态</button>}
        {testLogin ? <form className={styles.form} aria-busy={pending} onSubmit={event => { event.preventDefault(); void verifyTestAccess(); }}>
          <Field label="管理员测试凭证" hint="复制本机凭证文件中的整段内容，例如“挑战编号.8位数字”。默认10分钟内有效，使用后失效；账号已有权限决定可访问的后台。"><input type="password" required autoComplete="off" maxLength={137} value={testCredential} disabled={pending} onChange={event => setTestCredential(event.target.value)}/></Field>
          <Feedback error={error}/><button className={styles.button} disabled={pending}>{pending ? "正在验证…" : "使用测试凭证登录"}</button>
          <Link className={styles.link} href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>返回邮箱验证码登录</Link>
        </form> : <><nav className={styles.tabs} aria-label="账号入口"><Link className={styles.tab} aria-current={!registration ? "page" : undefined} href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>登录</Link><Link className={styles.tab} aria-current={registration ? "page" : undefined} href={`/register?returnTo=${encodeURIComponent(returnTo)}`}>注册</Link></nav>
        <GuanchaLoginButton returnTo={returnTo}/>
        <form className={styles.form} aria-busy={pending} onSubmit={event => { event.preventDefault(); void (challenge ? verify() : send()); }}>
          {registration && <Field label="姓名 / 昵称" hint="用于网站内称呼你，1 至 60 个字符。"><input required autoComplete="nickname" maxLength={60} value={displayName} disabled={pending || Boolean(challenge)} onChange={event => setDisplayName(event.target.value)} placeholder="你希望队友怎么称呼你" /></Field>}
          <Field label="邮箱"><input type="email" required autoComplete="email" maxLength={254} value={email} disabled={pending || Boolean(challenge)} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></Field>
          {challenge && <><Field label="8 位验证码" hint={`验证码有效至 ${dateText(challenge.expiresAt)}`}><input required disabled={pending} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></Field>
            {expired && <p role="status" className={styles.warning}>验证码已过期，请重新获取。</p>}
            <div className={styles.actions}><button type="button" className={styles.secondary} disabled={pending} onClick={() => { setChallenge(null); setNotice(""); setError(""); setCode(""); }}>{registration ? "修改姓名或邮箱" : "更换邮箱"}</button><button type="button" className={styles.secondary} disabled={pending || waitSeconds > 0} onClick={() => void send()}>{waitSeconds > 0 ? `${waitSeconds} 秒后可重发` : "重新获取验证码"}</button></div>
          </>}
          <Feedback error={error} notice={notice} /><button className={styles.button} disabled={pending || Boolean(expired)}>{pending ? "正在处理…" : challenge ? registration ? "验证邮箱并注册 / 登录" : "验证并登录" : registration ? "获取注册验证码" : "获取登录验证码"}</button>
          {registration && <p className={styles.muted}>已有该邮箱账号时会进入原账号，原有姓名与资料保持原样。我们不要求设置密码。</p>}
          {status.data?.email === "preview" && <p className={styles.notice}>当前使用本地开发邮箱预览，不会投递到真实邮箱。可在部署主机本机调试时<Link href="/dev/mailbox" target="_blank" className={styles.link}>打开开发邮箱查看验证码</Link>；远程手机登录需要网站启用真实邮件服务。</p>}
          {status.data?.email === "unconfigured" && <p className={styles.warning}>网站暂时无法发送验证码，管理员需要先启用邮件服务。你无需配置任何东西；服务启用后，填写自己的邮箱即可收取验证码。</p>}
        </form></>}
      </>}
    </section>
  </SiteShell>;
}
interface DevMail { id: string; recipient: string; subject: string; body: string; createdAt: string }
export function MailboxClient() { const state = useApi<DevMail[]>("/dev/mailbox"); return <SiteShell><PageTitle eyebrow="LOCAL DEVELOPMENT" title="开发邮箱">仅用于本机开发验证。这里的内容没有发送到真实邮箱。</PageTitle><button className={styles.secondary} onClick={() => void state.reload()} disabled={state.loading}>刷新邮件</button><Feedback error={state.error} />{state.loading && <Loading />}{state.data?.length === 0 && <Empty>尚无开发邮件。先到登录页发送验证码。</Empty>}<ul className={styles.list}>{state.data?.map(mail => <li key={mail.id}><h2>{mail.subject}</h2><p className={styles.muted}>{mail.recipient} · {dateText(mail.createdAt)}</p><pre className={styles.pre}>{mail.body}</pre></li>)}</ul></SiteShell>; }
