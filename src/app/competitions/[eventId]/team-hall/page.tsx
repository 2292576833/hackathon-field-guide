import { TeamHall } from "../../../../components/team-hall.tsx";

export const metadata = { title: "智能组队大厅" };

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <TeamHall eventId={eventId}/>;
}
