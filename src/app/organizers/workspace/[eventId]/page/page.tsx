import { EventSiteEditor } from "../../../../../components/event-site-editor.tsx";
export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventSiteEditor eventId={eventId}/>;
}
