import type { Metadata } from "next";
import { getJourneyGuide } from "../../../modules/journey/index.ts";
import { JourneyTree } from "../../../modules/journey/ui.ts";
import { PageTitle, SiteShell } from "../../../components/site-shell.tsx";
import journeyStyles from "../../../modules/journey/journey.module.css";

export const metadata: Metadata = {
  title: "参赛路线图 · 草根黑客松情报局",
  description: "从找比赛开始，用树状图了解赛前、赛中和赛后要做的事，以及相应的团队协作、工具和资料。",
};

export default function JourneyPage() {
  return <SiteShell>
    <div className={journeyStyles.pageIntro}><PageTitle eyebrow="YOUR HACKATHON JOURNEY" title="参赛路线图">
      找比赛 → 赛前准备 → 赛中协作 → 赛后复盘。沿着树枝找到要做的事、注意事项和可用工具。
    </PageTitle></div>
    <JourneyTree guide={getJourneyGuide()}/>
  </SiteShell>;
}
