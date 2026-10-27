import React from "react";
import { Composition } from "remotion";
import { ProjectRecord, VIDEO_CONFIG } from "./ProjectRecord";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="ProjectRecord"
    component={ProjectRecord}
    durationInFrames={VIDEO_CONFIG.durationInFrames}
    fps={VIDEO_CONFIG.fps}
    width={VIDEO_CONFIG.width}
    height={VIDEO_CONFIG.height}
  />
);
