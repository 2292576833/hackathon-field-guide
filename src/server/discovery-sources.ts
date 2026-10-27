import type { Clock } from "../shared/contracts.ts";
import {
  assertAllowedSourceUrl,
  assertRobotsAllowed,
  createOfficialSourceProvider,
  discoveryPageText,
  fetchApprovedSource,
  normalizeSourceUrl,
  OFFICIAL_EVENT_SOURCES,
  officialSourceDetailPolicy,
  type NetworkPolicy,
  type PinnedFetchPort,
  type PublicDnsPort,
  type PublicSearchPort,
  type PublicSearchResponse,
  type PublicSearchResult,
} from "../modules/operations/index.ts";
import type { ApplicationConfig } from "./config.ts";

const MAX_RESULTS = 5;
const MAX_LIST_BYTES = 2_097_152;
const MAX_READ_MS = 20_000;
const officialSources = OFFICIAL_EVENT_SOURCES.filter(source => source.id === "ethglobal" || source.id === "lablab");
type CatalogueKind = "official_listing" | "third_party_listing" | "organizer_page";
interface Catalogue { id: string; kind: CatalogueKind; url: (now: Date) => string; }
const fixed = (url: string) => () => url;
// Only public, reviewed entry points. A fixed organizer identity is not a saved
// card: it produces a hint only after an actual allowed source read succeeds.
const catalogues: readonly Catalogue[] = [
  { id: "hackertrip", kind: "third_party_listing", url: now => `https://hackertrip.space/hackathon/month/${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}` },
  { id: "tencent", kind: "official_listing", url: fixed("https://tch.cloud.tencent.com/") },
  { id: "xiaoyuanvc", kind: "third_party_listing", url: fixed("https://xiaoyuanvc.com/resources/china-hackathon-statistics") },
  { id: "hsinchu", kind: "organizer_page", url: fixed("https://115hsinchuhackathon.com/") },
  ...officialSources.map(source => ({ id: source.id, kind: "official_listing" as const, url: fixed(source.listUrl) })),
];

export interface DiscoverySourceHint extends PublicSearchResult {
  readonly provenance: { readonly catalogueId: string; readonly catalogueUrl: string; readonly kind: CatalogueKind; readonly fetchedAt: string };
}
// Fragments (headings/link labels) may be shorter than the whole-page evidence
// minimum. Decode them without treating a short label as a failed source read.
function plain(html: string): string {
  return cleanHtml(html).replace(/<[^>]*>/gu, " ")
    .replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/giu, (_all, number: string | undefined, named: string | undefined) => {
      if (named) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[named.toLowerCase()]!;
      const point = number!.toLowerCase().startsWith("x") ? parseInt(number!.slice(1), 16) : Number(number);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : " ";
    }).replace(/\s+/gu, " ").trim();
}
function cleanHtml(html: string): string {
  return html.replace(/<!--[^]*?(?:-->|$)/gu, " ")
    .replace(/<(script|style|template|noscript|svg)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/giu, " ");
}
function decodedAttribute(value: string): string {
  return plain(`<p>${value.replace(/</gu, "&lt;")}</p>`);
}
function anchors(html: string): { href: string; title: string; description: string }[] {
  const found = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([^]*?)<\/a\s*>/giu)) {
    if (found.length >= 200) break;
    const attributes = [...match[1]!.matchAll(/(?:^|\s)([a-z_:][a-z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/giu)];
    if (attributes.some(attribute => attribute[1]!.toLowerCase() === "hidden" ||
        (attribute[1]!.toLowerCase() === "aria-hidden" && (attribute[2] ?? attribute[3] ?? attribute[4]) === "true") ||
        (attribute[1]!.toLowerCase() === "style" && /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attribute[2] ?? attribute[3] ?? attribute[4] ?? "")))) continue;
    const hrefs = [...match[1]!.matchAll(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)];
    if (hrefs.length !== 1) continue;
    const heading = match[2]!.match(/<h[1-6]\b[^>]*>([^]*?)<\/h[1-6]\s*>/iu)?.[1];
    const description = plain(match[2]!).trim();
    const title = plain(heading ?? match[2]!).trim().slice(0, 200);
    if (title) found.push({ href: decodedAttribute(hrefs[0]![1] ?? hrefs[0]![2] ?? hrefs[0]![3]!), title, description: description.slice(0, 1200) });
  }
  return found;
}
function section(html: string, start: RegExp, end: RegExp): string {
  const headings = [...html.matchAll(/<h[1-3]\b[^>]*>([^]*?)<\/h[1-3]\s*>/giu)];
  const first = headings.find(heading => start.test(plain(heading[1]!)));
  if (!first) return "";
  const last = headings.find(heading => heading.index! > first.index! && end.test(plain(heading[1]!)));
  return html.slice(first.index! + first[0].length, last?.index ?? html.length);
}
function pathPolicy(url: string, timeoutMs: number): NetworkPolicy {
  const target = new URL(normalizeSourceUrl(url));
  return { version: 1, rules: [{ hostname: target.hostname, pathPrefix: target.pathname }], maxRedirects: 2,
    maxBytes: MAX_LIST_BYTES, timeoutMs, acceptedContentTypes: ["text/html"] };
}
function safeDetail(selected: Catalogue, raw: string, now: Date, timeoutMs: number): { url: string; detailPolicy: NetworkPolicy } | null {
  try {
    if (!raw || /[\u0000-\u0020\\]/u.test(raw)) return null;
    const url = new URL(raw, selected.url(now));
    if (url.hash || url.username || url.password) return null;
    const normalized = new URL(normalizeSourceUrl(url.toString()));
    if (/(?:^|\/)(?:login|signin|sign-in|oauth|authorize|private|archive|resources|collections|month|city)(?:\/|$)/iu.test(normalized.pathname) ||
        /\.(?:png|jpe?g|gif|svg|pdf|zip|js|css)$/iu.test(normalized.pathname)) return null;
    const legacy = officialSources.find(source => source.id === selected.id);
    if (legacy) {
      const detailPolicy = officialSourceDetailPolicy(url.toString(), { timeoutMs, maxBytes: MAX_LIST_BYTES });
      if (!legacy.detailLinkRules.hosts.includes(normalized.hostname)) return null;
      normalized.hostname = new URL(legacy.listUrl).hostname; normalized.pathname = normalized.pathname.replace(/\/$/u, "");
      return { url: normalized.toString(), detailPolicy };
    }
    if (selected.id === "hackertrip") {
      if (normalized.hostname !== "hackertrip.space" || !/^\/hackathon\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/iu.test(normalized.pathname)) return null;
    } else if (selected.id === "tencent") {
      if (normalized.hostname !== "tch.cloud.tencent.com" || !/^\/contest\/[1-9]\d{0,7}\/?$/u.test(normalized.pathname)) return null;
    } else if (selected.kind === "organizer_page") {
      const target = new URL(selected.url(now));
      if (normalized.origin !== target.origin || normalized.pathname.replace(/\/$/u, "") !== target.pathname.replace(/\/$/u, "")) return null;
    } else {
      // A curated calendar is never itself an event. Accept only its actual
      // external event/registration link, not site navigation or a platform root.
      const directoryHosts = ["xiaoyuanvc.com", "hackertrip.space", "github.com", "google.com", "baidu.com"];
      if (directoryHosts.includes(normalized.hostname) || /^\/(?:events|hackathons|ai-hackathons|contest)\/?$/iu.test(normalized.pathname)) return null;
      if (normalized.pathname === "/" && !catalogues.some(source => source.kind === "organizer_page" && new URL(source.url(now)).hostname === normalized.hostname)) return null;
      if (normalized.search && !(normalized.hostname === "www.feishu.cn" && /^\/share\/base\/form\/[a-z0-9]+$/iu.test(normalized.pathname) &&
          [...normalized.searchParams.keys()].every(key => ["share_link_type", "ccm_open_type"].includes(key)))) return null;
    }
    if (selected.id !== "xiaoyuanvc" && normalized.search) return null;
    return { url: normalized.toString(), detailPolicy: pathPolicy(normalized.toString(), timeoutMs) };
  } catch { return null; }
}

function tencentLinks(html: string, now: Date): readonly PublicSearchResult[] {
  const results: PublicSearchResult[] = [];
  const visible = plain(cleanHtml(html));
  // JSON.parse literal server data only. Never eval, load a JS bundle, execute
  // hydration, or invent a /contest/<id> URL that was absent from source data.
  for (const script of html.matchAll(/<script\b[^>]*>([^]*?)<\/script\s*>/giu)) {
    const push = script[1]!.trim().match(/^self\.__next_f\.push\((\[[^]*\])\);?$/u);
    if (!push) continue;
    let payload: unknown;
    try { const data = JSON.parse(push[1]!); payload = Array.isArray(data) && data[0] === 1 ? data[1] : null; } catch { continue; }
    if (typeof payload !== "string" || !payload.includes('"onlineData"')) continue;
    for (const line of payload.split("\n").slice(0, 100)) {
      const frame = line.match(/^[a-z0-9]+:([^]+)$/iu); if (!frame) continue;
      let parsed: unknown; try { parsed = JSON.parse(frame[1]!); } catch { continue; }
      let examined = 0;
      const inspect = (value: unknown, depth = 0): void => {
        if (++examined > 3000 || depth > 12 || !value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        if (Array.isArray(item.bannerData) && Array.isArray(item.onlineData)) {
          for (const banner of item.bannerData.slice(0, 50)) {
            if (!banner || typeof banner.link !== "string") continue;
            const linkedId = banner.link.match(/^https:\/\/tch\.cloud\.tencent\.com\/contest\/([1-9]\d{0,7})\/?$/u)?.[1];
            if (!linkedId) continue;
            const event = item.onlineData.find(candidate => candidate && String(candidate.id) === linkedId);
            if (!event || typeof event.name !== "string" || !visible.includes(event.name.trim())) continue;
            const end = typeof event.endTime === "string" ? event.endTime.match(/^\d{4}-\d{2}-\d{2}/u)?.[0] : null;
            if (end && end < now.toISOString().slice(0, 10)) continue;
            results.push({ url: banner.link, title: event.name.trim().slice(0, 200), description: typeof event.introduce === "string" ? event.introduce.slice(0, 1200) : event.name });
          }
        }
        for (const child of Object.values(item)) inspect(child, depth + 1);
      };
      inspect(parsed);
    }
  }
  return results;
}

/** Read-only public listing hints supplement native discovery. Detail fetching,
 * DSH analysis, deduplication and paid budgets remain owned by its worker. */
export function createDiscoverySourceSupplement(deps: {
  readonly config: ApplicationConfig;
  readonly clock: Clock;
  readonly network: { readonly dns: PublicDnsPort; readonly transport: PinnedFetchPort };
  readonly source?: PublicSearchPort;
}) {
  const worker = deps.config.discovery?.provider === "dsh_native" ? deps.config.discovery.worker : null;
  const timeoutMs = worker ? Math.min(worker.fetchTimeoutMs, MAX_READ_MS) : MAX_READ_MS;
  const provider = worker ? deps.source ?? createOfficialSourceProvider({
    sourceIds: officialSources.map(source => source.id),
    userAgent: worker.userAgent,
    timeoutMs,
    maxBytes: MAX_LIST_BYTES,
    ...deps.network,
  }) : null;

  return {
    async read(input: { readonly signal: AbortSignal; readonly round: number }): Promise<readonly DiscoverySourceHint[]> {
      // This port must never turn the free catalogue supplement into another
      // native/model request. Disabled or cancelled reads have no network work.
      if (!provider || provider.modelCallsPerSearch === 1 || input.signal.aborted ||
          !Number.isSafeInteger(input.round) || input.round < 0) return [];
      const selected = catalogues[input.round % catalogues.length]!;
      const observedAt = deps.clock.now(), startedAt = observedAt.getTime();
      let catalogueUrl = selected.url(observedAt);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let interrupt: () => void = () => {};
      const interrupted = new Promise<null>(resolve => {
        interrupt = () => { controller.abort(); resolve(null); };
        timer = setTimeout(interrupt, timeoutMs);
        input.signal.addEventListener("abort", interrupt, { once: true });
      });
      try {
        const response = await Promise.race<PublicSearchResponse | null>([
          Promise.resolve().then(async () => {
            if (controller.signal.aborted) return null;
            if (deps.source || officialSources.some(source => source.id === selected.id)) return provider.search({ query: selected.id, count: MAX_RESULTS, signal: controller.signal });
            const policy = pathPolicy(catalogueUrl, timeoutMs);
            const transport: PinnedFetchPort = { async request(request) {
              const target = new URL(assertAllowedSourceUrl(request.url, policy)), expected = new URL(catalogueUrl);
              if (target.origin !== expected.origin || target.pathname.replace(/\/$/u, "") !== expected.pathname.replace(/\/$/u, "") || target.search) throw new Error("CATALOGUE_REDIRECT_REJECTED");
              await assertRobotsAllowed({ sourceUrl: request.url, policy, ...deps.network, userAgent: worker!.userAgent, signal: request.signal });
              return deps.network.transport.request(request);
            } };
            const page = await fetchApprovedSource({ url: catalogueUrl, policy, dns: deps.network.dns, transport, signal: controller.signal });
            catalogueUrl = page.finalUrl;
            discoveryPageText(page.body, "text/html"); // actual full-page/login/size validation
            const html = cleanHtml(page.body);
            if (selected.id === "hackertrip") {
              return anchors(section(html, /即将开始|報名中|报名中/u, /往届|往屆|已结束|已結束/u)).map(link => ({ url: new URL(link.href, catalogueUrl).toString(), title: link.title, description: link.description }));
            }
            if (selected.id === "tencent") return tencentLinks(page.body, observedAt);
            if (selected.id === "xiaoyuanvc") {
              const upcoming = section(html, /近期.*(?:报名|報名)/u, /已截止|常年举办|常年舉辦/u);
              const headings = [...upcoming.matchAll(/<h4\b[^>]*>([^]*?)<\/h4\s*>/giu)];
              return headings.flatMap((heading, index) => {
                const title = plain(heading[1]!).trim();
                if (!/黑客松|hackathon|wakeathon|客松/iu.test(title)) return [];
                const card = upcoming.slice(heading.index!, headings[index + 1]?.index ?? upcoming.length);
                return anchors(card).filter(link => /报名|報名|官网|官網|官方|register/iu.test(link.title)).map(link => ({ url: new URL(link.href, catalogueUrl).toString(), title, description: plain(card).slice(0, 1200) }));
              });
            }
            const text = plain(html);
            const titleMarkup = html.match(/<title\b[^>]*>([^]*?)<\/title\s*>/iu)?.[1] ?? html.match(/<h1\b[^>]*>([^]*?)<\/h1\s*>/iu)?.[1];
            const title = titleMarkup ? plain(titleMarkup).trim().slice(0, 200) : "";
            const year = observedAt.getUTCFullYear();
            if (!title || !/黑客松|hackathon|黑客马拉松|黑客馬拉松/iu.test(`${title} ${text}`) ||
                ![String(year), String(year + 1), `${year - 1911}年`, `${year - 1911}新竹`].some(value => text.includes(value))) return [];
            return [{ url: catalogueUrl, title, description: text.slice(0, 1200) }];
          }),
          interrupted,
        ]);
        if (!response || controller.signal.aborted || input.signal.aborted ||
            deps.clock.now().getTime() - startedAt >= timeoutMs) return [];
        const results = Array.isArray(response) ? response : (response as Exclude<PublicSearchResponse, readonly PublicSearchResult[]>).results;
        if (!Array.isArray(results)) return [];
        const found = new Map<string, DiscoverySourceHint>();
        const provenance = { catalogueId: selected.id, catalogueUrl, kind: selected.kind, fetchedAt: deps.clock.now().toISOString() };
        // Bound work even if an injected/provider implementation ignores count.
        for (const result of results.slice(0, 20)) {
          try {
            if (!result || typeof result.url !== "string" || typeof result.title !== "string" || typeof result.description !== "string") continue;
            const detail = safeDetail(selected, result.url, observedAt, timeoutMs);
            if (!detail) continue;
            if (!result.title.trim()) continue;
            const canonicalUrl = detail.url;
            if (!found.has(canonicalUrl)) found.set(canonicalUrl, {
              url: canonicalUrl, title: result.title, description: `线索来源：${catalogueUrl}；${selected.kind === "third_party_listing" ? "第三方目录，需核对主办方" : "官网来源，未人工核验"}。目录文字不是单场正文证据。${result.description}`.slice(0, 1200), detailPolicy: detail.detailPolicy, provenance,
            });
            // No native indexedExcerpt, usage, or caller-supplied network policy
            // is forwarded from a listing. Its hint cannot replace detail text.
            if (found.size >= 20) break;
          } catch {
            // One invalid link cannot suppress other actual official results.
          }
        }
        const candidates = [...found.values()];
        // Rotate deeper catalogue entries on successive visits; always reading
        // the first five would starve Chinese events behind long-lived cards.
        const offset = candidates.length ? (Math.floor(input.round / catalogues.length) * MAX_RESULTS) % candidates.length : 0;
        return [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, MAX_RESULTS);
      } catch {
        // Native results still proceed when a catalogue is unavailable, denies
        // robots, changes structure, or reaches this independent HTTP deadline.
        return [];
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        input.signal.removeEventListener("abort", interrupt);
        controller.abort();
      }
    },
  };
}
