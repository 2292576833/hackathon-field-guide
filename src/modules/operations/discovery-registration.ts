import { DomainError } from "../../shared/errors.ts";
import { normalizeSourceUrl } from "./network-policy.ts";
import type { DiscoveryParticipation, DiscoveryRegistration } from "./discovery-types.ts";

export interface RegistrationLinkCandidate extends DiscoveryRegistration { readonly anchorText: string }
const missingRegistration = "未取得可核实的报名链接，请查看原文确认报名入口";
export const REGISTRATION_UNCONFIRMED = missingRegistration;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const malformed = () => new DomainError("DISCOVERY_SCHEMA_INVALID", "赛事参赛建议不符合结构限制。", { status: 422 });

/** No DNS or network requests: this validates only an actual extracted link.
 * The normal source fetcher still owns DNS pinning, robots and redirect checks. */
export function normalizeRegistrationUrl(value: string, sourceUrl?: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\u0000-\u0020\\]/.test(value) || value.startsWith("#")) throw malformed();
  const url = new URL(normalizeSourceUrl(sourceUrl ? new URL(value, normalizeSourceUrl(sourceUrl)).href : value));
  if (/(?:^|\/)(?:login|signin|sign-in|signup|sign-up|oauth|authorize|redirect|redir|jump|out|external|go)(?:\/|$)/i.test(url.pathname)) throw malformed();
  if (["t.cn", "url.cn", "bit.ly", "tinyurl.com", "dwz.cn", "suo.im", "s.id", "buff.ly", "lnkd.in", "cutt.ly"].includes(url.hostname)) throw malformed();
  for (const [key] of [...url.searchParams.entries()]) {
    if (/^(?:access_?token|token|password|session|sessionid|auth|code|apikey|api_key)$/i.test(key) ||
      /^(?:url|target|redirect|redirect_uri|redirect_url|return|returnurl|continue|next|dest|destination|link|u)$/i.test(key)) throw malformed();
    if (/^utm_/i.test(key) || ["fbclid", "gclid", "msclkid"].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}
function decode(value: string): string {
  return value.replace(/&#(x[\da-f]+|\d+);/gi, (_match, number: string) => {
    const point = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : " ";
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name.toLowerCase()]!);
}
const clean = (value: string) => decode(value).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
const registrationPhrase = /[报報]名(?:[链鏈]接|入口|地址|通道|[网網]址)?|注册参赛|註冊參賽|申[请請][参參][赛賽]|参加比赛申请|參加比賽申請|立即[参參][赛賽]|(?:event\s+)?registration|register(?:\s+(?:now|here|for))?|apply\s+(?:now|here|to\s+(?:join|participate))|sign\s*up\s+(?:for|to\s+join)/i;
const eventPhrase = /黑客松|黑客[马馬]拉松|比[赛賽]|[竞競][赛賽]|hackathon|competition|tournament|game\s*jam/i;
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ignoredTags = new Set(["script", "style", "template", "noscript", "svg", "canvas", "iframe", "nav", "header", "footer"]);
const blockTags = /^(?:p|div|section|article|h[1-6]|li|ul|ol|tr|br|hr)$/;
function attributes(tag: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const match of tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) values[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  return values;
}

/** Extract only links present in fetched visible HTML or in a verbatim indexed
 * excerpt. A search result's source URL is never guessed to be a signup URL. */
export function extractRegistrationLinks(input: { readonly body: string; readonly contentType: string; readonly sourceUrl: string; readonly sourceKind?: "page" | "indexed_excerpt" }): readonly RegistrationLinkCandidate[] {
  let sourceUrl: string;
  try { sourceUrl = normalizeSourceUrl(input.sourceUrl); } catch { return []; }
  const body = input.body.slice(0, 1_048_576);
  const candidates: RegistrationLinkCandidate[] = [];
  const seen = new Set<string>();
  function add(value: string, anchorText: string, evidence: string) {
    if (candidates.length >= 12) return;
    try {
      const url = normalizeRegistrationUrl(value, sourceUrl);
      const excerpt = clean(evidence);
      if (!excerpt || excerpt.length > 500 || seen.has(url)) return;
      const candidate = { url, sourceUrl, anchorText: clean(anchorText).slice(0, 200), evidence: excerpt };
      if (Buffer.byteLength(JSON.stringify([...candidates, candidate]), "utf8") > 24_576) return;
      seen.add(url); candidates.push(candidate);
    } catch { /* An unsafe or ambiguous link is absent, never substituted. */ }
  }
  let visible = "";
  const anchors: { href: string; start: number; end: number; text: string }[] = [];
  if (input.contentType === "text/html" && input.sourceKind !== "indexed_excerpt") {
    const stack: { tag: string; ignored: boolean; anchor?: { href: string; start: number } }[] = [];
    const html = body.replace(/<!--[^]*?(?:-->|$)/g, " ");
    for (const match of html.matchAll(/<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
      const token = match[0];
      if (!token.startsWith("<")) { if (!stack.some(entry => entry.ignored)) visible += decode(token); continue; }
      const name = token.match(/^<\/?\s*([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase();
      if (!name) continue;
      if (token.startsWith("</")) {
        const index = stack.map(entry => entry.tag).lastIndexOf(name);
        if (index !== -1) {
          for (const entry of stack.splice(index)) if (entry.anchor && !entry.ignored) anchors.push({ ...entry.anchor, end: visible.length, text: clean(visible.slice(entry.anchor.start)) });
        }
        if (!stack.some(entry => entry.ignored) && blockTags.test(name)) visible += "\n";
        continue;
      }
      const attrs = attributes(token);
      const ignored = stack.some(entry => entry.ignored) || ignoredTags.has(name) || "hidden" in attrs || "inert" in attrs || attrs["aria-hidden"]?.toLowerCase() === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style ?? "");
      if (!ignored && blockTags.test(name)) visible += "\n";
      if (!voidTags.has(name) && !token.endsWith("/>")) {
        if (stack.length >= 256) return [];
        stack.push({ tag: name, ignored, ...(name === "a" && !ignored && attrs.href ? { anchor: { href: attrs.href, start: visible.length } } : {}) });
      }
    }
    for (const anchor of anchors) {
      const context = clean(visible.slice(Math.max(0, anchor.start - 180), Math.min(visible.length, anchor.end + 180)));
      if (!registrationPhrase.test(anchor.text) || /(?:account|newsletter|sign\s*in|log\s*in|账户|账号|订阅|帳戶|帳號|訂閱)/i.test(anchor.text) || /^(?:register|registration)/i.test(anchor.text) && !eventPhrase.test(context)) continue;
      add(anchor.href, anchor.text, anchor.text);
    }
  } else visible = body.replace(/<!--[^]*?(?:-->|$)/g, " ").replace(/<(script|style|template|noscript)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, " ");

  // Plain text/snippets must contain the actual URL next to a registration
  // instruction; nearby event metadata or a source URL alone is insufficient.
  for (const match of visible.matchAll(/https:\/\/[^\s<>"'）)\]，,。；;]+/gi)) {
    if (candidates.length >= 12) break;
    const start = match.index ?? 0;
    const prefix = visible.slice(Math.max(0, start - 120), start);
    const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
    const instruction = linePrefix.match(/(?:[报報]名(?:[链鏈]接|入口|地址|通道|[网網]址)?|注册参赛|註冊參賽|申[请請][参參][赛賽]|registration(?:\s+(?:link|url|form))?|register(?:\s+(?:here|now|for[^\n:：]{0,60}))?|apply\s+(?:here|now|to\s+participate))[^\n]{0,70}$/i)?.[0];
    if (!instruction) continue;
    const suffix = visible.slice(start + match[0].length, start + match[0].length + 80).split("\n", 1)[0];
    const evidence = clean(`${instruction}${match[0]}${suffix}`);
    if (evidence.length > 500) continue;
    add(match[0], clean(instruction), evidence);
  }
  return candidates;
}

/** Model output can select a complete actual candidate, never invent a URL or
 * change its provenance. Bad/missing output downgrades just the registration. */
export function selectRegistration(value: unknown, candidates: readonly RegistrationLinkCandidate[]): DiscoveryRegistration | null {
  if (!object(value) || Object.keys(value).some(key => !["url", "sourceUrl", "evidence"].includes(key))) return null;
  const found = candidates.find(candidate => candidate.url === value.url && candidate.sourceUrl === value.sourceUrl && candidate.evidence === value.evidence);
  return found ? { url: found.url, sourceUrl: found.sourceUrl, evidence: found.evidence } : null;
}

export function normalizeParticipation(value: unknown): DiscoveryParticipation | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(key => !["recommendation", "reason", "suitableFor", "cautionFor"].includes(key)) || !["consider", "caution", "insufficient_info"].includes(value.recommendation as string)) throw malformed();
  const text = (item: unknown) => {
    if (typeof item !== "string" || !item.trim() || item.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item)) throw malformed();
    const result = item.trim();
    if (/(?:匹配|契合|适合|match|fit)[^。.!！\n]{0,20}\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%[^。.!！\n]{0,20}(?:匹配|契合|适合|match|fit)|保证[^。.!！\n]{0,20}(?:资格|符合报名|可以参赛)|guarantee[^。.!！\n]{0,30}(?:eligib|qualif)/i.test(result)) throw malformed();
    return result;
  };
  const list = (items: unknown) => { if (!Array.isArray(items) || items.length > 8) throw malformed(); return items.map(text); };
  return { recommendation: value.recommendation as DiscoveryParticipation["recommendation"], reason: text(value.reason), suitableFor: list(value.suitableFor), cautionFor: list(value.cautionFor) };
}
