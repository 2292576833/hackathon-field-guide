import { notFound } from "next/navigation";
import { getApplication } from "../../../server/application.ts";
import { NOINDEX_METADATA } from "../../../shared/noindex.ts";
import { EventSiteRenderer } from "../../../components/event-site-renderer.tsx";
import { deriveLayout, type EventSiteActionTarget } from "../../../modules/event-site/index.ts";

/** 规划35 §2：专属页默认不索引；页面级与 robots.txt 双保险。 */
export const metadata = NOINDEX_METADATA;
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const application = await getApplication();
  let view;
  try {
    view = await application.organizerIntegration.eventSite.publicPage(code);
  } catch {
    // 未发布 / 已停用 / 短码不存在统一 404，不泄露草稿。
    notFound();
  }
  const spec = view.spec;
  const layout = deriveLayout(spec);
  const facts = {
    registrationCloses: view.facts.registrationCloses,
    submissionCloses: view.facts.submissionCloses,
    startsAt: view.facts.startsAt,
    endsAt: view.facts.endsAt,
    scheduleNodes: (view.facts.scheduleNodes ?? []).map(node => ({ id: node.id, title: node.title, startsAt: node.at })),
    faqEntries: (view.facts.faqEntries ?? []).map(entry => ({ id: entry.id, question: entry.question, answer: entry.answer })),
  };
  const eventId = view.eventId;
  const base = "/competitions/" + encodeURIComponent(eventId);
  const actionHref = (target: EventSiteActionTarget): string =>
    target === "register" ? base + "/register"
      : target === "submit" ? base + "/submit"
      : base + "/results";
  return (
    <EventSiteRenderer
      spec={spec}
      layout={layout}
      facts={facts}
      actionHref={actionHref}
      assetUrl={assetId => `/api/v1/page-assets/${encodeURIComponent(assetId)}`}
      eventTitle={view.event?.title ?? "赛事专属页"}
      organizerName={""}
      canonicalHref={base}
      publishedAt={view.publishedAt}
    />);
}
