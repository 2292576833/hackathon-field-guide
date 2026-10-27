import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise, Tag } from "./ui";

/** 第二幕 · 它是什么：连接选手与主办方，只做一件事——让你知道下一步。 */
export const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - sec(2.4), fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.8) });
  // 截图从右侧滑入，像把网站放到桌面上
  const shotX = interpolate(progress, [0, 1], [180, 0]);
  const shotScale = interpolate(progress, [0, 1], [0.94, 1]);

  return (
    <AbsoluteFill>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "0 120px", flexDirection: "row", alignItems: "center", gap: 70 }}>
        <div style={{ width: 700, flex: "none" }}>
          <Rise delay={4}>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 8, color: COLORS.action }}>草根黑客松情报局</div>
          </Rise>
          <Rise delay={11}>
            <div style={{ marginTop: 22, fontSize: 76, fontWeight: 800, color: COLORS.ink, lineHeight: 1.24 }}>
              一个连接选手<br />和主办方的网站
            </div>
          </Rise>
          <Rise delay={sec(1.5)}>
            <div style={{ marginTop: 30, fontSize: 44, fontWeight: 700, color: COLORS.action, lineHeight: 1.4 }}>
              它只做一件事：<br />让你知道下一步该做什么。
            </div>
          </Rise>
          <Rise delay={sec(4)}>
            <div style={{ marginTop: 40, fontSize: 27, lineHeight: 1.75, color: COLORS.inkSoft }}>
              帮新人理解赛事要求 · 确定分工 · 规划时间<br />
              找到工具与设计参考 · 保存成果 · 完成正式提交
            </div>
          </Rise>
          <Rise delay={sec(5.8)}>
            <div style={{ marginTop: 34, display: "flex", gap: 12 }}>
              <Tag tone="brand">选手</Tag>
              <Tag>参赛团队</Tag>
              <Tag>主办方</Tag>
            </div>
          </Rise>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
          <div style={{ transform: `translateX(${shotX}px) scale(${shotScale})`, width: "100%", borderRadius: 14, overflow: "hidden",
            border: `1px solid ${COLORS.line}`, boxShadow: "0 40px 90px rgba(33,32,28,0.20)", background: COLORS.surface }}>
            <Img src={staticFile("shots4k/home.png")} style={{ width: "100%", display: "block" }} />
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
