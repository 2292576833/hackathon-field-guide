import { ParticipationClient } from "../../../components/participation-client.tsx";
export default async function Page({ searchParams }: { searchParams: Promise<{event?:string|string[]}> }) {
  const parameters=await searchParams;
  return <ParticipationClient eventId={typeof parameters.event==="string"?parameters.event:""}/>;
}
