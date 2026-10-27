import { ResourcesClient } from "../../../../components/discovery-client.tsx";
export default async function Page({ params }: { params: Promise<{ resourceId: string }> }) { const { resourceId } = await params; return <ResourcesClient resourceId={resourceId} />; }
