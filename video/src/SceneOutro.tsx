import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise } from "./ui";

/** 收尾：真实统计数字（由仓库实际文件数统计得出，不是估算）。 */
const NUMBERS = [
  { value: "34", label: "功能模块" },
  { value: "57", label: "页面路由" },
  { value: "71", label: "数据库迁移" },
  { value: "363", label: "测试文件" },
  { value: "55", label: "规划文档" },
] as const;

export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logo = spring({ frame: frame - sec(0.4), fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.8) });
  const fadeToEnd = interpolate(frame, [sec(5.6), sec(7)], [1, 0.86], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: fadeToEnd }}>
      <PaperBackground tone="deep" />
      {/* alignItems:center 必须显式写上：只设 justifyContent 时子元素仍会拉伸到整宽、看起来靠左。 */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ transform: `scale(${0.9 + logo * 0.1})`, opacity: logo, display: "flex", alignItems: "center", gap: 22 }}>
          <div style={{ width: 66, height: 66, borderRadius: 12, background: COLORS.brand }} />
          <div style={{ fontSize: 62, fontWeight: 800, color: COLORS.ink, letterSpacing: 2 }}>草根黑客松情报局</div>
        </div>

        <Rise delay={sec(0.9)}>
          <div style={{ marginTop: 38, fontSize: 46, fontWeight: 700, color: COLORS.ink, textAlign: "center", lineHeight: 1.4 }}>
            让第一次参赛的人，<br />也知道下一步该做什么。
          </div>
        </Rise>

        <div style={{ marginTop: 58, display: "flex", gap: 62, justifyContent: "center" }}>
          {NUMBERS.map((item, index) => (
            <Rise key={item.label} delay={sec(2) + index * 5} distance={16}>
              <div style={{ textAlign: "center", minWidth: 130 }}>
                <div style={{ fontSize: 54, fontWeight: 800, color: COLORS.action, lineHeight: 1 }}>{item.value}</div>
                <div style={{ marginTop: 12, fontSize: 22, color: COLORS.muted }}>{item.label}</div>
              </div>
            </Rise>
          ))}
        </div>

        <Rise delay={sec(3.4)}>
          <div style={{ marginTop: 58, fontSize: 23, color: COLORS.muted, letterSpacing: 3 }}>
            数字来自仓库实际统计 · 未完成项如实列出
          </div>
        </Rise>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
