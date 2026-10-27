import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise } from "./ui";

/**
 * 第五幕 · 今天能用的能力。
 * 只列**已实现并验证过**的能力，不写用户数/获奖/合作方这类没有依据的内容。
 */
const CAPABILITIES: readonly { title: string; detail: string; shot?: string }[] = [
  { title: "五套配色", detail: "暖白橙红 / 深青绿 / 靛蓝 / 紫罗兰 / 象牙墨黑朱砂，均通过对比度门槛", shot: "home-palette3" },
  { title: "画布批注", detail: "右击出工具：画笔、荧光笔、箭头、文字便签、橡皮" },
  { title: "参赛流程主线", detail: "六段路径串起从找比赛到复盘，点节点就地展开" },
  { title: "团队协作", detail: "协助者可见、没人接的任务可见、每人工作量与可用时间对照" },
  { title: "规则约束", detail: "\u201c红色只用于真正的阻塞\u201d——这一条写进了项目宪法" },
];

/** 第六幕前的过渡与能力展示。 */
export const SceneCapabilities: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slideStart = sec(8);
  const slideProgress = interpolate(frame, [slideStart, slideStart + Math.round(fps * 0.7)], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "76px 130px 0" }}>
        <Rise delay={2}>
          <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: 8, color: COLORS.action }}>今天已经能用的</div>
        </Rise>
        <Rise delay={8}>
          <div style={{ marginTop: 14, fontSize: 56, fontWeight: 800, color: COLORS.ink }}>不是设想，是现在打开就能用</div>
        </Rise>

        <div style={{ marginTop: 42, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 52, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {CAPABILITIES.map((item, index) => (
              <Rise key={item.title} delay={sec(2.4) + index * 7} distance={16}>
                <div style={{ padding: "15px 22px", border: `1px solid ${COLORS.line}`, borderLeft: `4px solid ${COLORS.action}`,
                  borderRadius: 10, background: "rgba(255,255,255,0.78)" }}>
                  <div style={{ fontSize: 30, fontWeight: 800, color: COLORS.ink }}>{item.title}</div>
                  <div style={{ marginTop: 6, fontSize: 22, lineHeight: 1.55, color: COLORS.muted }}>{item.detail}</div>
                </div>
              </Rise>
            ))}
          </div>

          <div style={{ opacity: slideProgress, transform: `translateY(${(1 - slideProgress) * 40}px)` }}>
            <div style={{ borderRadius: 14, overflow: "hidden", border: `1px solid ${COLORS.line}`,
              boxShadow: "0 34px 80px rgba(33,32,28,0.18)", background: COLORS.surface }}>
              <Img src={staticFile("shots4k/home-palette3.png")} style={{ width: "100%", display: "block" }} />
            </div>
            <div style={{ marginTop: 14, fontSize: 21, color: COLORS.muted }}>
              同一套界面，换一套配色：颜色全部来自设计变量，不是写死的色值。
            </div>
            <div style={{ marginTop: 22, borderRadius: 14, overflow: "hidden", border: `1px solid ${COLORS.line}`,
              boxShadow: "0 24px 60px rgba(33,32,28,0.14)", background: COLORS.surface }}>
              <Img src={staticFile("shots4k/journey.png")} style={{ width: "100%", display: "block" }} />
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
