import { SkillsClient } from "../../../../components/skills-client.tsx";
import { Suspense } from "react";
export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) { const { skillId } = await params; return <Suspense fallback={<p>正在读取技能…</p>}><SkillsClient skillId={skillId}/></Suspense>; }
