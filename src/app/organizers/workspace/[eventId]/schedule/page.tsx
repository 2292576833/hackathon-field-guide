import { OrganizerSectionPage } from "../../../../../components/competition-workspace.tsx";
export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <OrganizerSectionPage eventId={eventId} section="schedule"/>;
}
