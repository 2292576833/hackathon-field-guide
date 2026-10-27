import { SkillsClient } from "../../../../../components/skills-client.tsx";
import { Suspense } from "react";
export default async function BundlePage({ params }: { params: Promise<{ bundleId: string }> }) { const { bundleId } = await params; return <Suspense fallback={<p>正在读取套餐…</p>}><SkillsClient bundleId={bundleId}/></Suspense>; }
