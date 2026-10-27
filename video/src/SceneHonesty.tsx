import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise } from "./ui";

/**
 * 第六幕 · 诚实的边界。
 * 这些是**真实未完成**的项，写在这里是为了不让视频把没做到的说成做到了。
 */
const UNFINISHED = [
  { title: "观猹登录全链路", detail: "还需要一次真人登录验证；本地无法替代真实外部验收" },
  { title: "正式域名与证书", detail: "域名已保留，证书与回调登记尚未落地" },
  { title: "配色收口", detail: "主要界面已用设计变量，仍有部分历史页面保留旧色值" },
] as const;

export const SceneHonesty: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <PaperBackground tone="dark" grid={false} />
      <AbsoluteFill style={{ padding: "120px 150px 0", color: "#f2efe6" }}>
        <Rise delay={4}>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 8, color: COLORS.brand }}>也有一些事，还没做到</div>
        </Rise>
        <Rise delay={12}>
          <div style={{ marginTop: 20, fontSize: 62, fontWeight: 800, lineHeight: 1.26 }}>
            未完成就写未完成，<br />不写进「已完成」里。
          </div>
        </Rise>

        <div style={{ marginTop: 54, display: "flex", flexDirection: "column", gap: 20, maxWidth: 1360 }}>
          {UNFINISHED.map((item, index) => (
            <Rise key={item.title} delay={sec(2.2) + index * 10} distance={18}>
              <div style={{ display: "flex", gap: 22, alignItems: "baseline", paddingBottom: 20, borderBottom: "1px solid rgba(255,255,255,0.14)" }}>
                <div style={{ fontSize: 36, fontWeight: 800, flex: "none", width: 360 }}>{item.title}</div>
                <div style={{ fontSize: 27, lineHeight: 1.65, color: "rgba(242,239,230,0.72)" }}>{item.detail}</div>
              </div>
            </Rise>
          ))}
        </div>

        <Rise delay={sec(6.4)}>
          <div style={{ marginTop: 48, fontSize: 29, color: "rgba(242,239,230,0.86)", lineHeight: 1.7 }}>
            这也是项目给自己定的规矩：<span style={{ color: COLORS.brand, fontWeight: 800 }}>事实不足时，就说事实不足。</span>
          </div>
        </Rise>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
