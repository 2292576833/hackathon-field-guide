import { SkillsClient } from "../../../components/skills-client.tsx";
import { Suspense } from "react";
export default function SkillsPage() { return <Suspense fallback={<p>正在读取技能…</p>}><SkillsClient/></Suspense>; }
