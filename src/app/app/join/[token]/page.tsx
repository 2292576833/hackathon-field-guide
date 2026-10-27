import { InvitationClient } from "../../../../components/projects-client.tsx";
export default async function Page({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <InvitationClient token={token} />; }
