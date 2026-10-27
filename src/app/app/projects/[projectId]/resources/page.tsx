import { ProjectClient } from "../../../../../components/project-client.tsx";
export default async function ResourcesPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <ProjectClient projectId={projectId} section="resources"/>; }
