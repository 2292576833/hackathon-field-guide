import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, REVEAL_FRAMES } from "./theme";

/** 纸面底：极淡的网格 + 四角渐隐，呼应网站画布的方格底。 */
export const PaperBackground: React.FC<{ grid?: boolean; tone?: "paper" | "deep" | "dark" }> = ({ grid = true, tone = "paper" }) => {
  const background = tone === "dark" ? "#171613" : tone === "deep" ? COLORS.paperDeep : COLORS.paper;
  const line = tone === "dark" ? "rgba(255,255,255,0.05)" : "rgba(33,32,28,0.055)";
  return (
    <AbsoluteFill style={{ background }}>
      {grid ? (
        <AbsoluteFill
          style={{
            backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
            backgroundSize: "48px 48px",
            maskImage: "radial-gradient(120% 90% at 50% 40%, #000 45%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(120% 90% at 50% 40%, #000 45%, transparent 100%)",
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * 统一幕间过渡：入场 0.15 秒淡入、收尾 0.25 秒淡出。
 *
 * 加这个是为了**连贯性**：原来幕与幕之间是硬切，深色幕（问题/诚实）与纸色幕直接对撞会闪一下。
 * 现在每一幕都用同一层薄过渡包起来，切点不再突兀，同时保持"纪录"的克制感——不做炫技转场。
 */
export const SceneFrame: React.FC<{ children: React.ReactNode; fadeIn?: number; fadeOut?: number }> = ({
  children, fadeIn = 5, fadeOut = 8,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = Math.min(
    fadeIn > 0 ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1,
    fadeOut > 0 ? interpolate(frame, [durationInFrames - fadeOut, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1,
  );
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

/** 淡入 + 上移；delay 以帧为单位。入场时长用 REVEAL_FRAMES（0.42 秒），比原来更快。 */
export const Rise: React.FC<{ delay?: number; children: React.ReactNode; distance?: number; style?: React.CSSProperties }> = ({
  delay = 0, children, distance = 20, style,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame - delay, [0, REVEAL_FRAMES], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (value) => 1 - Math.pow(1 - value, 3),
  });
  return (
    <div style={{ opacity: progress, transform: `translateY(${(1 - progress) * distance}px)`, ...style }}>
      {children}
    </div>
  );
};

/** 逐行出现：每行按顺序递增延迟。既可用 `items` 传入，也可直接放 children。 */
export const Stagger: React.FC<{
  items?: readonly React.ReactNode[];
  children?: React.ReactNode;
  start?: number;
  step?: number;
  gap?: number;
  style?: React.CSSProperties;
}> = ({ items, children, start = 0, step = 8, gap = 14, style }) => {
  const list = items ?? React.Children.toArray(children);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>
      {list.map((item, index) => (
        <Rise key={index} delay={start + index * step}>{item}</Rise>
      ))}
    </div>
  );
};

/** 小型标签：用于"依据""状态"这类附注。 */
export const Tag: React.FC<{ children: React.ReactNode; tone?: "line" | "brand" | "success" }> = ({ children, tone = "line" }) => {
  const color = tone === "brand" ? COLORS.action : tone === "success" ? COLORS.success : COLORS.muted;
  const border = tone === "brand" ? COLORS.action : tone === "success" ? COLORS.success : COLORS.line;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", border: `1px solid ${border}`, borderRadius: 999,
      color, fontSize: 22, fontWeight: 600, letterSpacing: 1, background: "rgba(255,255,255,0.6)" }}>
      {children}
    </span>
  );
};

/** 标题组合：大标题 + 英文小字，统一全片排版。 */
export const Heading: React.FC<{ kicker?: string; title: React.ReactNode; delay?: number; size?: number; align?: "left" | "center" }> = ({
  kicker, title, delay = 0, size = 84, align = "left",
}) => (
  <div style={{ textAlign: align, display: "flex", flexDirection: "column", gap: 18, alignItems: align === "center" ? "center" : "flex-start" }}>
    {kicker ? (
      <Rise delay={delay}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 6, color: COLORS.action }}>{kicker}</div>
      </Rise>
    ) : null}
    <Rise delay={delay + 6}>
      <div style={{ fontSize: size, fontWeight: 800, lineHeight: 1.18, color: COLORS.ink, letterSpacing: 1 }}>{title}</div>
    </Rise>
  </div>
);
