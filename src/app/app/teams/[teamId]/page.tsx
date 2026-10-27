import { TeamsClient } from "../../../../components/teams-client.tsx";
export default async function TeamPage({ params }: { params: Promise<{ teamId: string }> }) { const { teamId } = await params; return <TeamsClient teamId={teamId}/>; }
