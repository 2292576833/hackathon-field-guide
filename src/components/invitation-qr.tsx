"use client";

import { useId, useMemo } from "react";
import { invitationQrCode } from "./invitation-qr-code.ts";
import styles from "./site.module.css";

export function InvitationQr({ value }: { value: string }) {
  const titleId = useId();
  const code = useMemo(() => invitationQrCode(value), [value]);
  if (!code) return <p className={styles.muted}>暂时无法显示二维码，请复制邀请链接给队友。</p>;
  return <figure className={styles.invitationQr}>
    <svg role="img" aria-labelledby={titleId} viewBox={`0 0 ${code.size} ${code.size}`} width="232" height="232" shapeRendering="crispEdges">
      <title id={titleId}>扫码打开团队空间邀请</title>
      <rect width={code.size} height={code.size} fill="#fff"/>
      <path d={code.path} fill="#111"/>
    </svg>
    <figcaption className={styles.muted}>让队友扫码打开，再登录并确认加入。</figcaption>
  </figure>;
}
