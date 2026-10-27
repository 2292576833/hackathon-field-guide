import { Suspense } from "react";
import { InspirationLive } from "../../../components/inspiration-live.tsx";
import { SiteShell } from "../../../components/site-shell.tsx";

export default function InspirationPage() {
  return <SiteShell><Suspense fallback={<p>正在读取灵感目录…</p>}><InspirationLive /></Suspense></SiteShell>;
}
