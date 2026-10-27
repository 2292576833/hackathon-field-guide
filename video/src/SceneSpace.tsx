import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { COLORS, sec } from "./theme";
import { PaperBackground, Rise, Stagger } from "./ui";

/** 九类画布组件（依据 src/modules/space-workflow/canvas-board.ts 的真实清单）。 */
const COMPONENTS = ["我的待办", "团队进度", "参赛流程主线", "队友状态", "空间文档", "协作提醒", "空间 AI 助手", "倒计时与资源", "范围调整"] as const;

/** 第四幕 · 团队空间：不是一堆卡片，是一块可以自己摆的画布。 */
export const SceneSpace: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - sec(3.4), fps, config: { damping: 200 }, durationInFrames: Math.round(fps * 0.85) });
  const shotY = interpolate(progress, [0, 1], [130, 0]);
  const shotScale = interpolate(progress, [0, 1], [0.96, 1]);

  return (
    <AbsoluteFill>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "62px 120px 0" }}>
        <div style={{ display: "flex", gap: 70, alignItems: "flex-start" }}>
          <div style={{ width: 640, flex: "none" }}>
            <Rise delay={2}>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 8, color: COLORS.action }}>团队空间</div>
            </Rise>
            <Rise delay={8}>
              <div style={{ marginTop: 12, fontSize: 54, fontWeight: 800, color: COLORS.ink, lineHeight: 1.26 }}>
                需要什么，拖进画布；<br />不需要，删掉。
              </div>
            </Rise>
            <Rise delay={sec(2.4)}>
              <div style={{ marginTop: 18, fontSize: 25, lineHeight: 1.65, color: COLORS.inkSoft }}>
                待办、队友在做什么、文档在哪、还剩多少时间，<br />都在同一块画布上，不用跳来跳去。
              </div>
            </Rise>
            <Stagger start={sec(4)} step={4} gap={5} style={{ marginTop: 20 }}>
              {COMPONENTS.map(name => (
                <div key={name} style={{ display: "inline-flex", alignItems: "center", gap: 11, fontSize: 21, lineHeight: 1.35, color: COLORS.inkSoft }}>
                  <span style={{ width: 6, height: 6, background: COLORS.action, borderRadius: 2, flex: "none" }} />{name}
                </div>
              ))}
            </Stagger>
            <Rise delay={sec(7.6)}>
              <div style={{ marginTop: 20, fontSize: 25, fontWeight: 700, color: COLORS.action, lineHeight: 1.5 }}>
                有真实检查记录才算做完。<br />
                没有人打个钩，系统就说这件事完成了。
              </div>
            </Rise>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ transform: `translateY(${shotY}px) scale(${shotScale})`, borderRadius: 14, overflow: "hidden",
              border: `1px solid ${COLORS.line}`, boxShadow: "0 40px 90px rgba(33,32,28,0.20)", background: COLORS.surface }}>
              <Img src={staticFile("shots4k/space.png")} style={{ width: "100%", display: "block" }} />
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
