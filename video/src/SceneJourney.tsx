import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise } from "./ui";

/** 六段参赛主路径（依据 src/modules/space-workflow/guide-tree.ts，只呈现真实存在的阶段）。 */
const STAGES = [
  { key: "enter", title: "进入", desc: "找比赛、确认报名" },
  { key: "rules", title: "读懂", desc: "比赛要求与截止" },
  { key: "planning", title: "安排", desc: "分工与时间窗口" },
  { key: "execution", title: "执行", desc: "做任务、交接成果" },
  { key: "submission", title: "提交", desc: "核对并正式提交" },
  { key: "reflection", title: "复盘", desc: "留下经验再复用" },
] as const;

/** 第三幕 · 主路径：一段一段点亮，像有人真的带你走一遍。 */
export const SceneJourney: React.FC = () => {
  const frame = useCurrentFrame();
  // 节奏：1.2 秒起每 1.9 秒点亮一个阶段。
  const start = sec(1.2);
  const step = sec(1.9);

  // 连线按进度生长
  const lineProgress = interpolate(frame, [start, start + step * (STAGES.length - 1)], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "110px 140px 0" }}>
        <Rise delay={2}>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 8, color: COLORS.action }}>参赛主路径</div>
        </Rise>
        <Rise delay={8}>
          <div style={{ marginTop: 18, fontSize: 70, fontWeight: 800, color: COLORS.ink }}>
            从找比赛，到复盘，六个阶段
          </div>
        </Rise>

        <div style={{ position: "relative", marginTop: 74 }}>
          {/* 主线 */}
          <div style={{ position: "absolute", left: 26, top: 30, right: 26, height: 3, background: COLORS.lineSoft }} />
          <div style={{ position: "absolute", left: 26, top: 30, height: 3, width: `calc((100% - 52px) * ${lineProgress})`, background: COLORS.action }} />

          <div style={{ display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(0, 1fr))`, gap: 18, position: "relative" }}>
            {STAGES.map((stage, index) => {
              const appear = start + index * step;
              const dot = interpolate(frame, [appear, appear + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
              return (
                <div key={stage.key} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <div style={{ width: 60, height: 60, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
                    border: `3px solid ${dot > 0.5 ? COLORS.action : COLORS.line}`, background: dot > 0.5 ? COLORS.action : COLORS.surface,
                    color: dot > 0.5 ? "#fff" : COLORS.muted, fontSize: 24, fontWeight: 800, transform: `scale(${0.86 + dot * 0.14})` }}>
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <Rise delay={appear} distance={14}>
                    <div style={{ marginTop: 22, fontSize: 38, fontWeight: 800, color: COLORS.ink }}>{stage.title}</div>
                    <div style={{ marginTop: 10, fontSize: 24, lineHeight: 1.6, color: COLORS.muted }}>{stage.desc}</div>
                  </Rise>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 78, display: "flex", gap: 56 }}>
          <Rise delay={sec(13.4)}>
            <div style={{ fontSize: 30, color: COLORS.inkSoft, lineHeight: 1.7 }}>
              <span style={{ fontWeight: 800, color: COLORS.ink }}>每个节点都说清三件事：</span><br />
              何时做 · 具体步骤 · 怎么算核对通过
            </div>
          </Rise>
          <Rise delay={sec(15)}>
            <div style={{ fontSize: 30, color: COLORS.inkSoft, lineHeight: 1.7, borderLeft: `3px solid ${COLORS.action}`, paddingLeft: 24 }}>
              <span style={{ fontWeight: 800, color: COLORS.action }}>事实没读到，就明确说没读到。</span><br />
              不猜，也不把未知当成已完成。
            </div>
          </Rise>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
