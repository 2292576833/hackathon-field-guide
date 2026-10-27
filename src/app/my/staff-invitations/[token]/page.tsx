import { StaffInvitationClaim } from "../../../../components/organizer-staff-invitations.tsx";
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <StaffInvitationClaim token={token}/>;
}
