import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise, SceneFrame } from "./ui";

/** 第一幕 · 问题：第一次参赛的人，最先遇到的不是技术问题。 */
export const SceneProblem: React.FC = () => {
  const frame = useCurrentFrame();

  // 开场：一句一句压上来，像深夜翻聊天记录。
  // 节奏：标题 0.2 秒上屏，四个"散落"卡片 1.8 秒起每 0.27 秒一个，末句 3.8 秒。
  const lines = ["赛程在群里", "要求在另一份文档里", "分工在聊天记录里", "截止时间靠自己记"];
  const fade = interpolate(frame, [0, sec(0.4)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <SceneFrame>
      {/* 背景与其它幕统一（原来用深色，与相邻幕硬切会闪） */}
      <PaperBackground />
      <AbsoluteFill style={{ padding: "0 140px", justifyContent: "center", opacity: fade }}>
        <Rise delay={6} distance={30}>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 8, color: COLORS.action }}>第一次参加黑客松</div>
        </Rise>
        <Rise delay={14} distance={34}>
          <div style={{ marginTop: 28, fontSize: 104, fontWeight: 800, color: COLORS.ink, lineHeight: 1.2 }}>
            最先遇到的，<br />不是技术问题。
          </div>
        </Rise>
        <Rise delay={sec(1.1)} distance={26}>
          <div style={{ marginTop: 40, fontSize: 54, fontWeight: 700, color: COLORS.action }}>是不知道从哪里开始。</div>
        </Rise>

        <div style={{ marginTop: 80, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18, maxWidth: 1180 }}>
          {lines.map((line, index) => (
            <Rise key={line} delay={sec(1.8) + index * 8} distance={16}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 22px", border: `1px solid ${COLORS.line}`,
                borderRadius: 10, background: "rgba(255,255,255,0.72)", fontSize: 30, color: COLORS.inkSoft }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: COLORS.line, flex: "none" }} />
                {line}
              </div>
            </Rise>
          ))}
        </div>

        <Rise delay={sec(3.8)} distance={16}>
          <div style={{ marginTop: 44, fontSize: 34, fontWeight: 700, color: COLORS.ink }}>
            没有人告诉你，<span style={{ color: COLORS.action }}>现在该做什么</span>。
          </div>
        </Rise>
      </AbsoluteFill>
    </SceneFrame>
  );
};
