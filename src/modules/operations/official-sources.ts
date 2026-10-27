import { DomainError } from "../../shared/errors.ts";
import { assertAllowedSourceUrl, fetchApprovedSource, normalizeNetworkPolicy, normalizeSourceUrl, type NetworkPolicy, type PinnedFetchPort, type PublicDnsPort } from "./network-policy.ts";
import { createNodeNetworkPorts } from "./node-network.ts";
import { assertRobotsAllowed } from "./robots-policy.ts";
import type { PublicSearchPort, PublicSearchResult } from "./discovery-types.ts";

export type OfficialSourceId = "ethglobal" | "lablab";
export interface OfficialEventSource {
  readonly id: OfficialSourceId;
  readonly name: string;
  readonly listUrl: string;
  readonly url: string;
  readonly networkPolicy: NetworkPolicy;
  readonly detailLinkRules: {
    readonly hosts: readonly string[];
    readonly pathPrefix: string;
    readonly excludedSlugPrefixes: readonly string[];
    readonly currentCardRule: string;
  };
}
const defaultLimits = { maxRedirects: 2, maxBytes: 1_048_576, timeoutMs: 15_000, acceptedContentTypes: ["text/html"] as readonly string[] };
function definition(id: OfficialSourceId, name: string, listUrl: string, hosts: readonly string[], pathPrefix: string, excludedSlugPrefixes: readonly string[], currentCardRule: string): OfficialEventSource {
  const rules = hosts.map(hostname => Object.freeze({ hostname, pathPrefix }));
  return Object.freeze({ id, name, listUrl, url: listUrl,
    networkPolicy: Object.freeze({ version: 1, ...defaultLimits, rules: Object.freeze(rules), acceptedContentTypes: Object.freeze(["text/html"]) }),
    detailLinkRules: Object.freeze({ hosts: Object.freeze([...hosts]), pathPrefix, excludedSlugPrefixes: Object.freeze([...excludedSlugPrefixes]), currentCardRule }) });
}
/** Source-owned public listings, not a claim that this host can currently reach them.
 * Source references: https://ethglobal.com/events and https://lablab.ai/ai-hackathons.
 * List labels are discovery hints; dates/eligibility still require detail-page evidence. */
export const OFFICIAL_EVENT_SOURCES: readonly OfficialEventSource[] = Object.freeze([
  definition("ethglobal", "ETHGlobal", "https://ethglobal.com/events", ["ethglobal.com", "www.ethglobal.com"], "/events", ["pragma", "ethconf", "co-working", "coworking", "conference"], "Upcoming section AND IRL Hackathon / Online Hackathon / Online card; exclude conference and co-working."),
  definition("lablab", "lablab.ai", "https://lablab.ai/ai-hackathons", ["lablab.ai", "www.lablab.ai"], "/ai-hackathons", [], "Single-event card labelled LIVE / Register / Upcoming / Ongoing; exclude Finished / Completed / Ended."),
]);
export const OFFICIAL_SOURCE_CATALOGUE = OFFICIAL_EVENT_SOURCES;
const sourceFor = (id: string) => OFFICIAL_EVENT_SOURCES.find(source => source.id === id);
const rulesChanged = () => new DomainError("OFFICIAL_SOURCE_RULES_CHANGED", "官方赛事列表没有可识别的近期区域或赛事状态，请人工检查来源规则。", { status: 503, recoveryAction: "review_official_source_rules" });
const linkRejected = () => new DomainError("OFFICIAL_SOURCE_LINK_REJECTED", "官方来源链接超出批准的域名、列表或单场赛事路径。", { status: 422 });

/** A single slug is a detail page. Query/fragment/tracker/auth/navigation links are excluded. */
function detailUrl(source: OfficialEventSource, href: string, base = source.listUrl): string | null {
  try {
    if (!href || href.length > 2048 || /[\u0000-\u0020\\]/u.test(href)) return null;
    const original = new URL(href, base);
    if (original.search || original.hash || original.username || original.password) return null;
    const normalized = new URL(normalizeSourceUrl(original.toString()));
    if (!source.detailLinkRules.hosts.includes(normalized.hostname)) return null;
    const pathname = normalized.pathname.replace(/\/$/u, "");
    const prefix = `${source.detailLinkRules.pathPrefix}/`;
    if (!pathname.startsWith(prefix)) return null;
    const slug = pathname.slice(prefix.length);
    if (!/^[a-z0-9][a-z0-9-]{1,99}$/iu.test(slug) || /^(?:login|signin|sign-in|oauth|authorize|private|past|archive|upcoming|register|registration|events|hackathons|terms|privacy)$/iu.test(slug) || source.detailLinkRules.excludedSlugPrefixes.some(value => slug.toLowerCase().startsWith(value))) return null;
    normalized.hostname = new URL(source.listUrl).hostname; normalized.pathname = pathname;
    return normalized.toString();
  } catch { return null; }
}
/** Restrict a detail to the selected event path, including a canonical www redirect
 * and child routes of that event. Sibling events and third-party login are excluded.
 * robots.txt has its own same-origin exact-path policy in assertRobotsAllowed. */
export function officialSourceDetailPolicy(url: string, limits: { timeoutMs?: number; maxBytes?: number } = {}): NetworkPolicy {
  const source = OFFICIAL_EVENT_SOURCES.find(item => detailUrl(item, url) !== null);
  if (!source) throw linkRejected();
  const canonical = detailUrl(source, url)!;
  return normalizeNetworkPolicy({ ...source.networkPolicy, timeoutMs: limits.timeoutMs ?? defaultLimits.timeoutMs,
    maxBytes: limits.maxBytes ?? defaultLimits.maxBytes,
    rules: source.detailLinkRules.hosts.map(hostname => ({ hostname, pathPrefix: new URL(canonical).pathname })) });
}

interface HtmlNode { tag: string; attrs: Readonly<Record<string, string>>; children: HtmlNode[]; text: string; start: number; end: number; parent: HtmlNode | null }
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function decode(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos|nbsp);/giu, (_all, numeric: string | undefined, named: string | undefined) => {
    if (named) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[named.toLowerCase()]!;
    const point = numeric!.toLowerCase().startsWith("x") ? parseInt(numeric!.slice(1), 16) : Number(numeric);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : " ";
  });
}
function htmlTree(input: string): { root: HtmlNode; nodes: HtmlNode[] } {
  const html = input.replace(/<!--[^]*?(?:-->|$)/gu, " ").replace(/<(script|style|template|noscript|svg)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/giu, " ");
  const root: HtmlNode = { tag: "root", attrs: {}, children: [], text: "", start: 0, end: html.length, parent: null };
  const stack = [root], nodes: HtmlNode[] = [];
  let tokens = 0;
  for (const match of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/giu)) {
    if (++tokens > 60_000) throw rulesChanged();
    const part = match[0], parent = stack[stack.length - 1]!;
    if (!part.startsWith("<")) {
      parent.children.push({ tag: "#text", attrs: {}, children: [], text: decode(part), start: match.index!, end: match.index! + part.length, parent });
      continue;
    }
    const tag = part.match(/^<\/?([a-z][a-z0-9-]*)/iu)?.[1]?.toLowerCase(); if (!tag) continue;
    if (part.startsWith("</")) {
      let offset = stack.length - 1;
      while (offset > 0 && stack[offset]!.tag !== tag) offset--;
      if (offset > 0) { for (const node of stack.splice(offset)) node.end = match.index! + part.length; }
      continue;
    }
    if (nodes.length >= 20_000 || stack.length >= 128) throw rulesChanged();
    const attrs: Record<string, string> = Object.create(null);
    const raw = part.slice(part.match(/^<[a-z][a-z0-9-]*/iu)![0].length, -1);
    for (const attribute of raw.matchAll(/([a-z_:][a-z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/giu)) {
      const key = attribute[1]!.toLowerCase();
      if (Object.hasOwn(attrs, key)) { attrs[key] = ""; continue; }
      attrs[key] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    const node: HtmlNode = { tag, attrs, children: [], text: "", start: match.index!, end: html.length, parent };
    parent.children.push(node); nodes.push(node);
    if (!voidTags.has(tag) && !part.endsWith("/>")) stack.push(node); else node.end = match.index! + part.length;
  }
  return { root, nodes };
}
function visible(node: HtmlNode): boolean {
  for (let current: HtmlNode | null = node; current; current = current.parent) {
    if (Object.hasOwn(current.attrs, "hidden") || current.attrs["aria-hidden"] === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(current.attrs.style ?? "")) return false;
  }
  return true;
}
function text(node: HtmlNode, limit = 3000): string {
  if (!visible(node)) return "";
  let result = node.text;
  for (const child of node.children) { if (result.length > limit) break; result += ` ${text(child, limit - Math.min(limit, result.length))}`; }
  return result.replace(/\s+/gu, " ").trim().slice(0, limit);
}
function hasCardLabel(node: HtmlNode, pattern: RegExp): boolean {
  let examined = 0;
  const inspect = (current: HtmlNode): boolean => {
    if (++examined > 1000 || !visible(current)) return false;
    // Require an actual short label, rather than words like "online" or
    // "register" embedded in a description or an unrelated navigation link.
    if (pattern.test(text(current, 100))) return true;
    return current.children.some(inspect);
  };
  return inspect(node);
}
function cardContext(anchor: HtmlNode, source: OfficialEventSource): HtmlNode {
  let current = anchor;
  for (let depth = 0; depth < 5 && current.parent; depth++) {
    const content = text(current);
    const hasLabel = source.id === "ethglobal" ? /\b(?:irl\s+hackathon|online(?:\s+hackathon)?|conference|co[- ]?working|pragma|ethconf)\b/iu.test(content) : /\b(?:live|register|upcoming|ongoing|finished|completed|ended)\b/iu.test(content);
    if (hasLabel) return current;
    const next = current.parent;
    const links = new Set<string>(); let examined = 0;
    const visit = (node: HtmlNode): void => { if (++examined > 1000 || links.size > 1) return; if (node.tag === "a" && node.attrs.href) { const target = detailUrl(source, node.attrs.href); if (target) links.add(target); } for (const child of node.children) visit(child); };
    visit(next);
    if (links.size > 1 || examined > 1000) break;
    current = next;
  }
  return anchor;
}
function cardHeading(anchor: HtmlNode, card: HtmlNode): HtmlNode | null {
  // Both official listings put the event h2 several div/section levels below
  // the anchor. Look through the selected card in document order, never through
  // another card or script, and keep the walk bounded like the label checks.
  const find = (root: HtmlNode): HtmlNode | null => {
    let examined = 0;
    const visit = (node: HtmlNode): HtmlNode | null => {
      if (++examined > 1000 || !visible(node)) return null;
      if (/^h[1-6]$/u.test(node.tag) && text(node, 300)) return node;
      for (const child of node.children) { const heading = visit(child); if (heading) return heading; }
      return null;
    };
    return visit(root);
  };
  return find(anchor) ?? (card === anchor ? null : find(card));
}
/** Extract only source-specific current competition cards; no JS/JSON hydration execution. */
export function extractOfficialEventLinks(sourceId: string, html: string, count = 20, limits: { timeoutMs?: number; maxBytes?: number } = {}): readonly PublicSearchResult[] {
  const source = sourceFor(sourceId);
  if (!source || typeof html !== "string" || Buffer.byteLength(html) > (limits.maxBytes ?? defaultLimits.maxBytes) || !Number.isInteger(count) || count < 1 || count > 20) throw rulesChanged();
  const { nodes } = htmlTree(html);
  const headings = nodes.filter(node => /^h[1-6]$/u.test(node.tag) && visible(node)).map(node => ({ start: node.start, end: node.end, value: text(node, 200).toLowerCase() }));
  const upcoming = headings.find(item => /^upcoming(?:\s+(?:events|hackathons))?(?:\s*\(?\d+\)?)?$/iu.test(item.value));
  if (source.id === "ethglobal" && !upcoming) throw rulesChanged();
  const end = upcoming ? headings.find(item => item.start > upcoming.start && /^(?:past|previous|archive|completed|finished)(?:\s+(?:events|hackathons))?(?:\s*\(?\d+\)?)?$/iu.test(item.value))?.start ?? Infinity : Infinity;
  const results = new Map<string, PublicSearchResult>(); let recognizedCards = 0;
  for (const anchor of nodes) {
    if (anchor.tag !== "a" || !visible(anchor) || !anchor.attrs.href) continue;
    if (upcoming && source.id === "ethglobal" && (anchor.start < upcoming.end || anchor.start >= end)) continue;
    const url = detailUrl(source, anchor.attrs.href); if (!url) continue;
    const card = cardContext(anchor, source), content = text(card);
    const labels = content.toLowerCase();
    if (source.id === "ethglobal") {
      if (!hasCardLabel(card, /^(?:irl\s+hackathon|online(?:\s+hackathon)?)$/iu) || /\b(?:conference|co[- ]?working|pragma|ethconf)\b/iu.test(labels)) continue;
    } else {
      if (hasCardLabel(card, /^(?:live|register(?:\s+now)?|upcoming|ongoing|finished|completed|ended)$/iu)) recognizedCards++;
      if (!hasCardLabel(card, /^(?:live|register(?:\s+now)?|upcoming|ongoing)$/iu) || /\b(?:finished|completed|ended)\b/iu.test(labels)) continue;
    }
    const heading = cardHeading(anchor, card);
    const title = (heading ? text(heading, 300) : anchor.attrs["aria-label"] || anchor.attrs.title || text(anchor, 300) || content).trim().slice(0, 300);
    if (!title || /\b(?:conference|co[- ]?working|pragma|ethconf)\b/iu.test(title)) continue;
    results.set(url, { url, title, description: `${source.name} 官方近期赛事线索；列表标签与日期尚未人工核验。${content.slice(0, 1000)}`,
      detailPolicy: officialSourceDetailPolicy(url, limits) });
    if (results.size >= count) break;
  }
  if (source.id === "lablab" && recognizedCards === 0) throw rulesChanged();
  return [...results.values()];
}

export function createOfficialSourceProvider(config: { readonly sourceIds: readonly string[]; readonly userAgent: string;
  readonly timeoutMs?: number; readonly maxBytes?: number; readonly dns?: PublicDnsPort; readonly transport?: PinnedFetchPort }): PublicSearchPort<readonly PublicSearchResult[]> {
  if (!Array.isArray(config.sourceIds) || config.sourceIds.length < 1 || config.sourceIds.length > 5 || new Set(config.sourceIds).size !== config.sourceIds.length || config.sourceIds.some(id => typeof id !== "string" || !sourceFor(id))) throw new DomainError("INVALID_OFFICIAL_SOURCES", "请选择 1 至 5 个已支持且不重复的官方来源。", { status: 422 });
  const sourceIds = new Set(config.sourceIds), timeoutMs = config.timeoutMs ?? defaultLimits.timeoutMs, maxBytes = config.maxBytes ?? defaultLimits.maxBytes;
  const native = createNodeNetworkPorts({ userAgent: config.userAgent }); const dns = config.dns ?? native.dns, baseTransport = config.transport ?? native.transport;
  const policies = new Map(config.sourceIds.map(id => { const source = sourceFor(id)!; return [id, normalizeNetworkPolicy({ ...source.networkPolicy, timeoutMs, maxBytes })]; }));
  return { resultOrdering: "interleave", async search(input) {
    if (!sourceIds.has(input.query) || !Number.isInteger(input.count) || input.count < 1 || input.count > 20) throw new DomainError("INVALID_OFFICIAL_SOURCE_QUERY", "来源检查只接受已启用的官方来源 ID 和有界结果数量。", { status: 422 });
    const source = sourceFor(input.query)!, policy = policies.get(input.query)!;
    const transport: PinnedFetchPort = { async request(request) {
      const target = new URL(assertAllowedSourceUrl(request.url, policy));
      if (!source.detailLinkRules.hosts.includes(target.hostname) || target.pathname.replace(/\/$/u, "") !== new URL(source.listUrl).pathname || target.search) throw linkRejected();
      await assertRobotsAllowed({ sourceUrl: target.toString(), policy, dns, transport: baseTransport, userAgent: config.userAgent, signal: request.signal });
      return baseTransport.request(request);
    } };
    const listing = await fetchApprovedSource({ url: source.listUrl, policy, dns, transport, signal: input.signal });
    return extractOfficialEventLinks(source.id, listing.body, input.count, { timeoutMs, maxBytes });
  } };
}
