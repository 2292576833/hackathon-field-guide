import { LoginClient } from "../../components/login-client.tsx";
export default async function Page({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const query = await searchParams;
  return <LoginClient testAccess={query.test === "1"}/>;
}
