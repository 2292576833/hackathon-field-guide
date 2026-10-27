import { OperationsClient } from "../../components/operations-client.tsx";
import { SiteShell } from "../../components/site-shell.tsx";

export default function Page() {
  return <SiteShell><OperationsClient /></SiteShell>;
}
