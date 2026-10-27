import { EventsClient } from "../../../../components/discovery-client.tsx";
export default async function Page({ params }: { params: Promise<{ eventId: string }> }) { const { eventId } = await params; return <EventsClient eventId={eventId} />; }
