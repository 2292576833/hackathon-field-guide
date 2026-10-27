import { PersonalExperiencePanel } from "../../../components/experience-client.tsx";
import { PageTitle, SiteShell } from "../../../components/site-shell.tsx";

export default function Page() {
  return <SiteShell><PageTitle title="我的经验">找回本人经验、复盘与未写完的草稿。复用到下一场比赛前，再核对新比赛的规则和时间。</PageTitle><PersonalExperiencePanel/></SiteShell>;
}
