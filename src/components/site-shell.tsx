"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, Suspense, type ReactElement } from "react";
import { api, useApi, ApiError } from "./client-api.ts";
import { Navigator } from "./navigator.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { FirstLoginGuide, FIRST_LOGIN_GUIDE_REPLAY_EVENT } from "./first-login-guide.tsx";
import { PaletteSwitcher } from "./palette-switcher.tsx";
import styles from "./site.module.css";

export interface Me { profile: import("../modules/auth/types.ts").UserProfile; platformRoles?: string[] }

/**
 * 账号头像：优先显示本人头像（含从观猹继承来的），没有或读取失败时回落姓名首字。
 *
 * 用普通 `img` 而不是 next/image：这里的接口可能返回 404（没有头像），
 * 由 `onError` 直接切回首字母，不会留下破图占位。
 */
export function AccountAvatar({ displayName, className }: { displayName: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initial = Array.from(displayName.trim() || "我")[0];
  if (failed) return <span className={className} aria-hidden="true">{initial}</span>;
  return <span className={className} aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/api/v1/me/recruiting-profile/avatar" alt="" width={26} height={26}
      style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
      onError={() => setFailed(true)}/>
  </span>;
}
export interface SystemStatus { mode: "local" | "connected"; database: "local" | "postgres"; email: "preview" | "configured" | "unconfigured"; modelConfigured: boolean; githubConfigured: boolean; dshConfigured: boolean; discoveryConfigured: boolean; discoveryProvider?: "brave" | "official_sources" | "dsh_native" | null; discoverySources?: { name: string; url: string }[] }
/** Preserve current same-origin context without forcing every public page into Suspense. */
function ContextualAuthLink({ children, className, mode }: { children: ReactNode; className?: string; mode: "login" | "register" }) {
  const pathname = usePathname(), query = useSearchParams().toString();
  return <Link prefetch={false} className={className} href={`/${mode}?returnTo=${encodeURIComponent(pathname + (query ? `?${query}` : ""))}`}>{children}</Link>;
}
function AuthLink({ children, className, mode = "login" }: { children: ReactNode; className?: string; mode?: "login" | "register" }) {
  const pathname = usePathname();
  return <Suspense fallback={<Link prefetch={false} className={className} href={`/${mode}?returnTo=${encodeURIComponent(pathname)}`}>{children}</Link>}><ContextualAuthLink className={className} mode={mode}>{children}</ContextualAuthLink></Suspense>;
}
/**
 * `wide` 用于"整页画布"这类页面：放宽内容容器的最大宽度，让画布铺满可用区域。
 * `bare` 连站点导航与页脚一起让开，只保留 `main` 内容——用于"整个窗口都是画布"的页面。
 *   注意：用 `bare` 的页面**必须自己提供返回与账号入口**，否则用户会被困住。
 * 默认仍按原来的 1200px 居中且带导航，避免影响其它页面。
 */
export function SiteShell({ children, wide = false, bare = false }: { children: ReactNode; wide?: boolean; bare?: boolean }) {
  const pathname = usePathname();
  const identity = useApi<Me>("/me");
  const status = useApi<SystemStatus>("/system/status");
  const permissions = useApi<{ platformRoles: string[] }>(identity.data ? "/me/permissions" : null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [signingOut, setSigningOut] = useState(false), [accountError, setAccountError] = useState("");
  const resourcePaths = ["/resources", "/inspiration", "/skills", "/library", "/github"];
  const isResourcePage = resourcePaths.some(path => pathname === path || pathname.startsWith(`${path}/`));
  const isWorkspacePage = ["/app", "/participation", "/roadshow", "/ppt", "/me/competitions", "/recruiting"].some(path => pathname === path || pathname.startsWith(`${path}/`)) && !pathname.startsWith("/app/account");
  const isCompetitionPage = ["/events", "/competitions"].some(path => pathname === path || pathname.startsWith(`${path}/`));
  const isOrganizerPage = pathname === "/organizers" || pathname.startsWith("/organizers/");
  const closeMenu = () => menu.current?.removeAttribute("open");
  useEffect(() => {
    closeMenu();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pathname]);
  return <div className={`${styles.shell}${wide ? ` ${styles.shellWide}` : ""}${bare ? ` ${styles.shellBare}` : ""}`}>
    <a href="#page-content" className={styles.skip}>跳到主要内容</a>
    {!bare && <header className={styles.header}><Link prefetch={false} href="/" className={styles.brand}><span className={styles.mark} aria-hidden="true" />草根黑客松情报局</Link>
      <nav className={styles.navigation} aria-label="主导航"><Link prefetch={false} href="/journey" aria-current={pathname === "/journey" ? "page" : undefined}>参赛指引</Link><Link prefetch={false} href="/events" aria-current={isCompetitionPage ? "page" : undefined}>找比赛</Link><Link prefetch={false} href="/app" aria-current={isWorkspacePage ? "page" : undefined}>我的参赛</Link><Link prefetch={false} href="/resources" aria-current={isResourcePage ? "page" : undefined}>工具与资料</Link><Link prefetch={false} href="/ai" aria-current={pathname === "/ai" ? "page" : undefined}>AI 工作台</Link></nav>
      <div className={styles.headerActions}><Link prefetch={false} href="/organizers" className={styles.organizerEntry} aria-current={isOrganizerPage ? "page" : undefined}>主办方入驻 <span aria-hidden="true">↗</span></Link>
      <div className={styles.accountActions} aria-label="账号操作">{identity.data ? <details ref={menu} className={styles.accountMenu} onKeyDown={event => { if (event.key === "Escape") { closeMenu(); menu.current?.querySelector("summary")?.focus(); } }}><summary><AccountAvatar className={styles.avatar} displayName={identity.data.profile.displayName || "我"}/>我的账号</summary><div className={styles.accountPopover}><p className={styles.muted}>{identity.data.profile.displayName || "我的账号"}</p><Link prefetch={false} href="/app/account" onClick={closeMenu}>个人资料与账号设置</Link><Link prefetch={false} href="/app/teams" onClick={closeMenu}>管理固定队伍</Link><button type="button" className={styles.secondary} onClick={() => { closeMenu(); menu.current?.querySelector("summary")?.focus(); window.dispatchEvent(new Event(FIRST_LOGIN_GUIDE_REPLAY_EVENT)); }}>网站使用指引</button>{permissions.data?.platformRoles.some(role => ["admin", "reviewer"].includes(role)) && <Link prefetch={false} href="/admin" onClick={closeMenu}>后台管理</Link>}{permissions.data?.platformRoles.includes("admin") && <Link prefetch={false} href="/admin/services" onClick={closeMenu}>后端服务状态</Link>}<button type="button" className={styles.secondary} disabled={signingOut} onClick={async () => { setSigningOut(true); setAccountError(""); try { await api("/auth/logout", { method: "POST" }); window.location.assign("/login"); } catch { setAccountError("退出登录未完成，请重试。"); await identity.reload(); } finally { setSigningOut(false); } }}>{signingOut ? "正在退出…" : "退出登录"}</button></div></details> : identity.loading ? <span className={styles.muted} role="status">读取账号…</span> : <><AuthLink className={styles.link}>登录</AuthLink><AuthLink className={styles.secondary} mode="register">注册</AuthLink></>}
      {/* 配色预览入口：作为页头里的普通元素参与排布，避免固定定位压住「注册」等按钮。 */}
      <PaletteSwitcher/></div></div></header>}
    {accountError && <Feedback error={accountError}/>}
    {isCompetitionPage && <nav className={styles.sectionNavigation} aria-label="比赛入口"><Link prefetch={false} href="/events" aria-current={pathname.startsWith("/events") ? "page" : undefined}>全网赛事线索</Link><Link prefetch={false} href="/competitions" aria-current={pathname.startsWith("/competitions") ? "page" : undefined}>本站正式赛事</Link><Link prefetch={false} href="/me/competitions">我报名的比赛</Link></nav>}
    {isResourcePage && <nav className={styles.sectionNavigation} aria-label="工具与资料分类">{[["/resources", "工具"], ["/inspiration", "找灵感"], ["/skills", "AI 技能"], ["/library", "新手教程"], ["/github", "GitHub 教程"]].map(([href, label]) => <Link prefetch={false} key={href} href={href} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}>{label}</Link>)}</nav>}
    {status.data?.email === "preview" && <p className={styles.status}>本机调试：验证码在开发邮箱预览。<Link prefetch={false} href="/dev/mailbox" className={styles.link}>查看开发邮件</Link></p>}
    {status.data?.email === "unconfigured" && <p className={styles.status}>验证码邮件服务正在配置，暂时无法注册或登录；公开资料和模板可以直接查看。</p>}
    <FirstLoginGuide/>
    <Navigator/>
    <CommandPalette/>
    <main id="page-content">{children}</main>{!bare && <footer className={styles.footer}><Link prefetch={false} className={styles.link} href="/journey">参赛路线图</Link> · <Link prefetch={false} className={styles.link} href="/organizers">主办方入驻</Link> · <Link prefetch={false} className={styles.link} href="/organizers/workspace">办赛工作台</Link> · 陪你从第一次参赛到完成作品。比赛要求请以主办方最新说明为准，AI 建议由你和队友确认后使用。</footer>}
  </div>;
}
export function PageTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) { return <div className={styles.intro}>{eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}<h1 className={styles.heading}>{title}</h1>{children && <div className={styles.lead}>{children}</div>}</div>; }
export function Feedback({ error, notice }: { error?: Error | string | null; notice?: string }) { return <>{error && <div role="alert" className={styles.error}>{typeof error === "string" ? error : error.message}{((error instanceof ApiError && error.status === 401 && ["UNAUTHENTICATED", "AUTH_SESSION_REQUIRED", "AUTH_SESSION_EXPIRED", "AUTH_SESSION_REVOKED"].includes(error.code)) || (typeof error === "string" && error.startsWith("登录已失效"))) && <p><AuthLink className={styles.link}>重新登录</AuthLink></p>}</div>}{notice && <p role="status" className={styles.notice}>{notice}</p>}</>; }
export function Empty({ children }: { children: ReactNode }) { return <div className={styles.empty}>{children}</div>; }
export function Loading() { return <p role="status" className={styles.muted}>正在读取已保存的内容…</p>; }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const generatedId = useId();
  const child = isValidElement(children) ? children as ReactElement<{ id?: string; "aria-describedby"?: string }> : null;
  const id = child?.props.id ?? generatedId;
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{child ? cloneElement(child, { id, "aria-describedby": [child.props["aria-describedby"], hint ? `${id}-hint` : undefined].filter(Boolean).join(" ") || undefined }) : children}{hint && <span id={`${id}-hint`} className={styles.hint}>{hint}</span>}</div>;
}
