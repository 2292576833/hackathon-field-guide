import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from "remotion";
import { DURATION_IN_FRAMES, FPS, HEIGHT, MUSIC_FADE_OUT_FRAMES, WIDTH, sec } from "./theme";
import { SceneFrame } from "./ui";
import { SceneProblem } from "./SceneProblem";
import { SceneIntro } from "./SceneIntro";
import { SceneJourney } from "./SceneJourney";
import { SceneSpace } from "./SceneSpace";
import { SceneCapabilities } from "./SceneCapabilities";
import { SceneHonesty } from "./SceneHonesty";
import { SceneOutro } from "./SceneOutro";

/**
 * 全片时间轴（单位：帧，总长 3540 = 118 秒）。
 *
 * 节奏说明（用户要求"还能再快点"）：内容全部提前上屏，场景留白从原来的十几秒压到 2~4 秒；
 * 入场曲线也从 0.75 秒收紧到 0.42 秒（见 theme.REVEAL_FRAMES）。
 * 画面收在 118 秒，音乐 134.4 秒，尾段自然淡出——不留"画面已结束还在放歌"的空白。
 */
const TIMELINE = [
  { name: "问题", component: SceneProblem, seconds: 14 },
  { name: "它是什么", component: SceneIntro, seconds: 14 },
  { name: "参赛主路径", component: SceneJourney, seconds: 17.4 },
  // 28 → 29 秒：整片最"重"的一幕，多给 1 秒让九类组件与两条结论都有停留。
  { name: "团队空间", component: SceneSpace, seconds: 29 },
  { name: "今天能用的", component: SceneCapabilities, seconds: 19.6 },
  { name: "诚实的边界", component: SceneHonesty, seconds: 11 },
  { name: "收尾", component: SceneOutro, seconds: 13 },
] as const;

/** 时间轴自检：总和必须正好等于总长，否则渲染会有黑帧或截断。 */
export function assertTimeline(): void {
  const total = TIMELINE.reduce((sum, scene) => sum + sec(scene.seconds), 0);
  if (total !== DURATION_IN_FRAMES) {
    throw new Error(`时间轴总长 ${total} 帧与设定 ${DURATION_IN_FRAMES} 帧不一致（差 ${DURATION_IN_FRAMES - total} 帧）`);
  }
}

export const ProjectRecord: React.FC = () => {
  assertTimeline();
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#f6f3eb" }}>
      {/* 音乐整首铺底，尾段淡出，避免结尾被硬切。 */}
      <Audio src={staticFile("music.mp3")} volume={frame => interpolate(
        frame,
        [DURATION_IN_FRAMES - MUSIC_FADE_OUT_FRAMES, DURATION_IN_FRAMES],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      )} />
      {TIMELINE.map(scene => {
        const from = cursor;
        const durationInFrames = sec(scene.seconds);
        cursor += durationInFrames;
        const Scene = scene.component;
        return (
          <Sequence key={scene.name} from={from} durationInFrames={durationInFrames} name={scene.name}>
            {/* 统一幕间过渡：在合成层包一层，所有幕一致，不必逐幕改文件。 */}
            <SceneFrame>
              <Scene />
            </SceneFrame>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const VIDEO_CONFIG = { fps: FPS, width: WIDTH, height: HEIGHT, durationInFrames: DURATION_IN_FRAMES } as const;
