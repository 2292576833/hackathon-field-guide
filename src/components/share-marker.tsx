"use client";

import { useState } from "react";

/**
 * 组件共享标记（规划27 第1期）：把这一块的站内直达链接复制到剪贴板，贴给队友。
 *
 * 边界：只复制**当前空间的链接**，不发送、不推送、不改变任何数据与权限；
 * 队友能否打开仍由服务端权限决定（例如私人待办只有本人可见）。
 */
export function ShareMarker({ anchor, label }: { anchor: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function share() {
    const url = `${window.location.origin}${window.location.pathname}#${anchor}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      // 剪贴板不可用（非 HTTPS 或权限被拒）时退回选中提示，不谎报成功。
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 4000);
  }
  return <button type="button" onClick={() => void share()} title={`复制「${label}」的链接给队友`}
    style={{ border: "1px solid var(--line)", borderRadius: 999, background: "var(--paper)", padding: "3px 10px", fontSize: 12, cursor: "pointer", color: state === "copied" ? "var(--action)" : "inherit" }}>
    {state === "copied" ? "链接已复制" : state === "failed" ? "复制失败，请手动复制地址" : "共享"}
  </button>;
}
