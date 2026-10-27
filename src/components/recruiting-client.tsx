"use client";
import { useEffect, useRef } from "react";
import { RecruitingLobby } from "../modules/recruiting/RecruitingLobby.tsx";
import { RecruitingProfileEditor } from "../modules/recruiting/RecruitingProfileEditor.tsx";
import { useApi } from "./client-api.ts";
import { PageTitle, SiteShell, type Me } from "./site-shell.tsx";
import styles from "./site.module.css";

export function RecruitingClient() {
  const identity = useApi<Me>("/me");
  const profileDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!identity.data) return;
    const revealProfile = () => {
      if (window.location.hash !== "#recruiting-profile" || !profileDetails.current) return;
      profileDetails.current.open = true;
      profileDetails.current.querySelector("summary")?.focus({ preventScroll: true });
      profileDetails.current.scrollIntoView({ block: "start" });
    };
    const onLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.hash === "#recruiting-profile") requestAnimationFrame(revealProfile);
    };
    revealProfile(); window.addEventListener("hashchange", revealProfile); document.addEventListener("click", onLink);
    return () => { window.removeEventListener("hashchange", revealProfile); document.removeEventListener("click", onLink); };
  }, [identity.data?.profile.id]);
  return <SiteShell><PageTitle title="找一起参赛的队友">先了解对方想做什么、能投入多少时间，再申请加入团队空间。每份名片由本人确认公开。</PageTitle>
    {identity.data && <details ref={profileDetails} id="recruiting-profile" className={styles.panel}><summary className={styles.summary}>我的参赛名片：填写职责与参赛目标</summary>
      <p className={styles.muted}>经历默认私人保存。你可以手写或让 DSH 归纳名片，预览确认后才会在大厅出现。</p>
      <RecruitingProfileEditor loginHref="/login?returnTo=%2Frecruiting"/>
    </details>}
    <RecruitingLobby signedIn={Boolean(identity.data)} loginHref="/login?returnTo=%2Frecruiting" profileHref="#recruiting-profile"
      onJoined={application => window.location.assign(`/app/projects/${encodeURIComponent(application.projectId)}`)}/>
  </SiteShell>;
}
