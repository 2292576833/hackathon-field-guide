"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { InvitationPreview, PublicSpaceInvitationPreview } from "../modules/projects/model.ts";
import { ApiError, api, dateText, isUnknownAiOutcome, useApi } from "./client-api.ts";
import { Feedback, Loading, PageTitle, SiteShell, type Me } from "./site-shell.tsx";
import { useAction } from "./workflow.tsx";
import styles from "./site.module.css";
import invitationStyles from "./space-invitation.module.css";

const unavailableNames = {
  expired: "这条邀请已过期", revoked: "这条邀请已撤销", used: "这条邀请的名额已用完",
  unavailable: "当前无法使用这条邀请",
};
const roleNames: Record<string, string> = { manager: "空间管理员", captain: "固定队伍队长", member: "普通成员" };
const unknownOutcome = (reason: unknown) => isUnknownAiOutcome(reason) || reason instanceof ApiError && reason.code === "INVALID_RESPONSE";

export function InvitationPreviewClient({ token }: { token: string }) {
  return <InvitationView key={token} token={token}/>;
}

function InvitationView({ token }: { token: string }) {
  const encoded = encodeURIComponent(token); const path = `/invitations/${encoded}`;
  const returnTo = `/app/join/${encoded}`;
  const identity = useApi<Me>("/me");
  // The token permits a minimal public DTO; it never grants membership or private data.
  const [publicView, setPublicView] = useState<PublicSpaceInvitationPreview | null>(null);
  const [publicError, setPublicError] = useState<Error | null>(null);
  const [publicLoading, setPublicLoading] = useState(true);
  const [refreshCount, setRefreshCount] = useState(0);
  const guest = !identity.loading && !identity.data && identity.error instanceof ApiError && identity.error.status === 401;
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setPublicLoading(true); setPublicError(null);
    void api<PublicSpaceInvitationPreview>(`${path}/public-preview`, { signal: controller.signal }).then(data => {
      if (active) setPublicView(data);
    }).catch(reason => {
      if (active) { setPublicView(null); setPublicError(reason instanceof Error ? reason : new Error("邀请说明暂时无法读取。")); }
    }).finally(() => { if (active) setPublicLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [path, refreshCount]);

  return <SiteShell>
    <PageTitle title="先核对邀请，再加入团队空间">打开链接或扫码只读取邀请说明。登录后明确接受，才会加入对应空间。</PageTitle>
    <section className={styles.panel}>
      {identity.data ? <AuthenticatedInvitation key={identity.data.profile.id} path={path} identity={identity.data} publicView={publicView} refreshPublic={() => setRefreshCount(count => count + 1)}/> : <>
        {(publicLoading && !publicView || identity.loading) && <Loading/>}
        {publicView?.status === "pending" && <>
          <h2>{publicView.scopeName}</h2>
          <PublicInvitationContext value={publicView}/>
          <p>加入角色：{roleNames[publicView.requestedRole ?? "member"]}</p>
          {publicView.requestedRole === "manager" && <p className={styles.notice}>此邀请授予空间管理权限，请先确认邀请人的安排。</p>}
          <p>最多 {publicView.maxUses} 人 · 已加入 {publicView.usedUses} 人 · 剩余 {publicView.remainingUses} 个名额</p>
          <p className={styles.muted}>有效至 {dateText(publicView.expiresAt)}。链接与二维码共用同一名额。</p>
        </>}
        {publicView && publicView.status !== "pending" && <>
          <h2>{unavailableNames[publicView.status]}</h2>
          <p>请联系邀请人索取新链接。若你已经加入，可登录后核对并进入空间。</p>
          {publicView.status === "used" && publicView.maxUses !== null && <p>最多 {publicView.maxUses} 人 · 已加入 {publicView.usedUses} 人 · 剩余 {publicView.remainingUses} 个名额</p>}
        </>}
        {publicError && <p className={styles.notice}>邀请的公开说明暂时无法读取。登录后仍需核对目标空间与角色，不会自动加入。</p>}
        {guest && <div className={styles.actions}>
          <Link className={styles.button} href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>登录后继续核对邀请</Link>
          <Link className={styles.secondary} href={`/register?returnTo=${encodeURIComponent(returnTo)}`}>注册账号后回到此邀请</Link>
        </div>}
        {!guest && !identity.loading && <><Feedback error={identity.error}/><button className={styles.secondary} type="button" onClick={() => void identity.reload()}>重新读取登录状态</button></>}
        <button className={styles.secondary} type="button" disabled={publicLoading} onClick={() => setRefreshCount(count => count + 1)}>重新读取邀请说明</button>
      </>}
    </section>
  </SiteShell>;
}

function PublicInvitationContext({ value }: { value: PublicSpaceInvitationPreview }) {
  return <>
    <p>比赛：{value.eventName ?? "暂未提供已核实的比赛名称，请先向邀请人核对。"}</p>
    <p>邀请人：{value.inviterDisplayName ?? "暂未提供公开显示名，请先向发链接的队友核对。"}</p>
  </>;
}

function AuthenticatedInvitation({ path, identity, publicView, refreshPublic }: {
  path: string; identity: Me; publicView: PublicSpaceInvitationPreview | null; refreshPublic: () => void;
}) {
  const initialPreview = useApi<InvitationPreview>(path);
  const [checkedPreview, setCheckedPreview] = useState<{ data: InvitationPreview | null; error: Error | null } | null>(null);
  const preview = {
    data: checkedPreview ? checkedPreview.data : initialPreview.data,
    error: checkedPreview ? checkedPreview.error : initialPreview.error,
    loading: initialPreview.loading,
  };
  const [confirm, setConfirm] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const busy = useRef(false);
  const action = useAction();
  const alreadyMember = Boolean(!preview.error && (preview.data?.alreadyMember || preview.data?.alreadyAccepted));
  const joined = accepted || alreadyMember;
  const scope = preview.data;
  const target = scope ? `/app/${scope.scopeType === "project" ? "projects" : "teams"}/${encodeURIComponent(scope.scopeId)}` : "/app";
  const mismatchedEmail = preview.error instanceof ApiError && preview.error.code === "INVITATION_IDENTITY_MISMATCH";

  useEffect(() => { if (alreadyMember) { setOutcomeUnknown(false); setConfirm(false); } }, [alreadyMember]);
  async function readCurrentPreview() {
    try {
      const value = await api<InvitationPreview>(path);
      setCheckedPreview({ data: value, error: null });
      return value;
    } catch (reason) {
      setCheckedPreview({ data: null, error: reason instanceof Error ? reason : new Error("邀请状态暂时无法读取。") });
      setAccepted(false); setConfirm(false);
      throw reason;
    }
  }
  async function checkSavedOutcome() {
    if (busy.current) return;
    busy.current = true;
    try {
      await action.run(async () => {
        const value = await readCurrentPreview();
        setAccepted(Boolean(value.alreadyMember || value.alreadyAccepted));
        setOutcomeUnknown(false); setConfirm(false); refreshPublic();
        action.setNotice(value.alreadyMember || value.alreadyAccepted ? "已核对：你已在目标空间中。" : "已核对当前邀请。请再次确认后接受。");
      });
    } finally { busy.current = false; }
  }

  return <>
    <h2>{scope?.scopeName ?? (publicView?.status === "pending" ? publicView.scopeName : publicView ? unavailableNames[publicView.status] : "核对当前账号可接受的邀请")}</h2>
    <p className={styles.muted}>当前登录账号：{identity.profile.displayName || "本人"}。加入后只获得这个空间的共享内容，私人测评、画像、行程与讲稿不会自动共享。</p>
    <Feedback error={preview.error}/><Feedback error={action.error} notice={action.notice}/>
    {preview.loading && <Loading/>}
    {mismatchedEmail && <p className={styles.notice}>需要使用邀请人限定的已验证邮箱。请切换到对应账号，或请邀请人重新生成链接；本页不会显示限定邮箱。</p>}
    {!scope && publicView && publicView.status !== "pending" && <p className={styles.notice}>{unavailableNames[publicView.status]}。请联系邀请人索取新链接；已加入的账号可重新核对。</p>}
    {scope && <>
      {!joined && publicView?.status === "pending" && <PublicInvitationContext value={publicView}/>}
      <p>{scope.scopeType === "project" ? "团队空间" : "固定队伍"} · {alreadyMember ? "当前角色" : "邀请角色"} {roleNames[(alreadyMember ? scope.currentRole : scope.requestedRole) ?? "member"]}</p>
      {!joined && <>
        <p>最多 {scope.maxUses} 人 · 已加入 {scope.usedUses} 人 · 剩余 {scope.remainingUses} 个名额</p>
        <p className={styles.muted}>有效至 {dateText(scope.expiresAt)}。链接与二维码共用同一名额。</p>
        {scope.requestedRole === "manager" && <p className={styles.notice}>此邀请授予空间管理权限，请先确认邀请人的安排。</p>}
        {scope.scopeType === "team" && <p>加入固定队伍后，各次参赛空间仍需分别邀请。</p>}
        <label className={styles.check}><input type="checkbox" checked={confirm} disabled={action.busy || outcomeUnknown || preview.loading || Boolean(preview.error)} onChange={event => setConfirm(event.target.checked)}/>我已核对目标与角色，明确接受这条邀请。</label>
        <button className={styles.button} disabled={action.busy || !confirm || outcomeUnknown || preview.loading || Boolean(preview.error)} onClick={async () => {
          if (busy.current || outcomeUnknown || !confirm) return;
          busy.current = true;
          try {
            await action.run(async () => {
              try {
                await api(`${path}/accept`, { method: "POST", body: {} });
              } catch (reason) { if (unknownOutcome(reason)) setOutcomeUnknown(true); throw reason; }
              setConfirm(false); refreshPublic();
              try {
                const current = await readCurrentPreview();
                setAccepted(Boolean(current.alreadyMember || current.alreadyAccepted));
                action.setNotice(current.alreadyMember || current.alreadyAccepted ? "已明确接受邀请，现在可以进入空间选择职责与填写时间。" : "接受操作已返回，请重新核对当前加入状态。" );
              } catch (reason) {
                throw new Error(`接受操作已保存，但当前邀请与成员状态未能读取：${reason instanceof Error ? reason.message : "请重新核对加入结果。"}`);
              }
            });
          } finally { busy.current = false; }
        }}>加入{scope.scopeType === "project" ? "团队空间" : "固定队伍"}</button>
      </>}
      {joined && <div className={invitationStyles.joined}>
        <p className={styles.notice}>{accepted ? "已加入，可以进入空间继续准备。" : "你已经加入，可以直接进入。重复接受邀请不会占名额或自动提升角色。"}</p>
        <div className={invitationStyles.joinedActions}>
          <Link href={target} className={styles.button}>进入{scope.scopeType === "project" ? "团队空间" : "固定队伍"}</Link>
          {scope.scopeType === "project" && <><Link href={`${target}/team`} className={styles.link}>填写本人可用时间</Link><Link href={`${target}/assessment`} className={styles.link}>选择本人职责</Link></>}
        </div>
      </div>}
    </>}
    {outcomeUnknown && <p className={styles.notice}>接受结果尚未确认，页面保留原邀请。请先重新核对结果，确认是否已经加入。</p>}
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={action.busy || preview.loading} onClick={() => void checkSavedOutcome()}>重新核对邀请与加入结果</button></div>
  </>;
}
