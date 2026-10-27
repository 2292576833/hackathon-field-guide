import { ProjectClient } from "../../../../components/project-client.tsx";
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <ProjectClient projectId={projectId}/>; }
