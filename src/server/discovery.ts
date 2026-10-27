import { createHash } from "node:crypto";
import type { DatabasePort } from "../shared/persistence.ts";
import type { Clock } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import { normalizeSourceUrl } from "../modules/operations/index.ts";
import { normalizeParticipation, normalizeRegistrationUrl } from "../modules/operations/discovery-registration.ts";
import type { DiscoveryCandidateCommit, DiscoveryParticipation, DiscoveryRegistration, DiscoveryRegistrationClosureInput } from "../modules/operations/discovery-types.ts";
import { isRegistrationWindowOpen, normalizeRegistrationWindow, registrationWindowYearEvidence, type RegistrationWindow } from "../shared/registration-window.ts";
import { normalizeEventWindow, type EventWindow } from "../shared/event-window.ts";

export interface DiscoveryInput {
  canonicalUrl: string; title: string; summary: string;
  analysis: { fit: readonly string[]; risks: readonly string[]; preparation: readonly string[]; unknowns: readonly string[] };
  sources: readonly { url: string; title: string; excerpt: string; fetchedAt: string; sourceKind?: "page" | "indexed_excerpt" }[];
  discoveredAt: string; lastAnalyzedAt: string; provider: "dsh";
  registration?: DiscoveryRegistration | null;
  participation?: DiscoveryParticipation;
  registrationWindow?: RegistrationWindow;
  eventWindow?: EventWindow;
}
export interface DiscoveryCard extends DiscoveryInput { id: string; revision: number; verificationStatus: "unverified" }
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DomainError("INVALID_DISCOVERY", "比赛发现内容无效。", { status: 422 });
  return value.trim();
}
function instant(value: unknown, now: Date): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now.getTime() + 300_000) throw new DomainError("INVALID_DISCOVERY", "比赛发现时间无效。");
  return new Date(value).toISOString();
}
function canonical(value: string): string {
  const url = new URL(normalizeSourceUrl(value));
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
/** Both public cards and live metadata use this server-clock predicate. Stored
 * instants are normalized UTC ISO strings; date-only deadlines close at the
 * start of that date in UTC+14, the earliest possible local-day boundary. */
export function discoveryVisibilitySql(nowParameter: string, dateParameter: string, _eventDateParameter?: string): string {
  if (!/^\$[1-9]\d*$/.test(nowParameter) || !/^\$[1-9]\d*$/.test(dateParameter)) throw new Error("Invalid discovery SQL parameter.");
  return "status='active'";
}
export function discoveryVisibilityTime(now: Date): readonly [string, string, string] {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return [now.toISOString(), new Date(now.getTime() + 14 * 60 * 60_000).toISOString().slice(0, 10), local];
}
function normalizeSources(sources: DiscoveryInput["sources"], now: Date): DiscoveryInput["sources"] {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 13) throw new DomainError("INVALID_DISCOVERY", "比赛发现来源数量无效。");
  return sources.map(source => {
    if (source.sourceKind !== undefined && !["page", "indexed_excerpt"].includes(source.sourceKind)) throw new DomainError("INVALID_DISCOVERY", "分析依据类型无效。");
    return { url: canonical(source.url), title: text(source.title, 200), excerpt: text(source.excerpt, 500), fetchedAt: instant(source.fetchedAt, now), ...(source.sourceKind ? { sourceKind: source.sourceKind } : {}) };
  });
}
function normalize(input: DiscoveryInput, now: Date): DiscoveryInput {
  if (!input || input.provider !== "dsh" || !input.analysis || typeof input.analysis !== "object") throw new DomainError("INVALID_DISCOVERY", "比赛发现缺少来源或分析。");
  const values = (value: readonly string[]) => { if (!Array.isArray(value) || value.length > 12) throw new DomainError("INVALID_DISCOVERY", "分析条目超过限制。"); return value.map(item => text(item, 600)); };
  const discoveredAt = instant(input.discoveredAt, now), lastAnalyzedAt = instant(input.lastAnalyzedAt, now);
  if (lastAnalyzedAt < discoveredAt) throw new DomainError("INVALID_DISCOVERY", "分析时间早于发现时间。");
  const sources = normalizeSources(input.sources, now);
  let registration: DiscoveryRegistration | null | undefined;
  let participation: DiscoveryParticipation | undefined;
  let registrationWindow: RegistrationWindow | undefined;
  let eventWindow: EventWindow | undefined;
  try {
    if (input.registration === null) registration = null;
    else if (input.registration !== undefined) {
      const value = input.registration;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["url", "sourceUrl", "evidence"].includes(key))) throw new Error();
      const evidence = text(value.evidence, 500), sourceUrl = canonical(normalizeRegistrationUrl(value.sourceUrl));
      registration = { url: normalizeRegistrationUrl(value.url), sourceUrl, evidence };
      if (!sources.some(source => source.url === sourceUrl && source.excerpt.includes(evidence))) throw new Error();
    }
    participation = normalizeParticipation(input.participation);
    if (input.registrationWindow !== undefined) {
      const checkedAt = instant(input.registrationWindow.checkedAt, now);
      if (Date.parse(checkedAt) > now.getTime() || checkedAt > lastAnalyzedAt) throw new Error();
      const normalized = normalizeRegistrationWindow(input.registrationWindow, { texts: sources.map(source => source.excerpt), checkedAt });
      if (!normalized || normalized.status === "open" && !isRegistrationWindowOpen(normalized, now)) throw new Error();
      registrationWindow = normalized;
    }
    if (input.eventWindow !== undefined) {
      const checkedAt = instant(input.eventWindow.checkedAt, now);
      if (Date.parse(checkedAt) > now.getTime() || checkedAt > lastAnalyzedAt) throw new Error();
      const normalized = normalizeEventWindow(input.eventWindow, { texts: sources.map(source => source.excerpt), checkedAt });
      if (!normalized) throw new Error();
      eventWindow = normalized;
    }
  } catch { throw new DomainError("INVALID_DISCOVERY", "报名入口、报名截止或参赛建议缺少有效证据或超出结构限制。", { status: 422 }); }
  return { canonicalUrl: canonical(input.canonicalUrl), title: text(input.title, 200), summary: text(input.summary, 1200),
    analysis: { fit: values(input.analysis.fit), risks: values(input.analysis.risks), preparation: values(input.analysis.preparation), unknowns: values(input.analysis.unknowns) },
    sources, discoveredAt, lastAnalyzedAt, provider: "dsh", ...(registration !== undefined ? { registration } : {}), ...(participation ? { participation } : {}), ...(registrationWindow ? { registrationWindow } : {}), ...(eventWindow ? { eventWindow } : {}) };
}
function decode(row: { id: string; revision: number; content: DiscoveryInput }): DiscoveryCard { return { ...row.content, id: row.id, revision: row.revision, verificationStatus: "unverified" }; }
export const discoveryFeedVersionSql = "md5(coalesce(string_agg(id || ':' || revision::text || ':' || last_analyzed_at::text,',' ORDER BY id),''))";
export function createDiscoveryService(database: DatabasePort, clock: Clock) {
    async function persist(content: DiscoveryInput): Promise<{ id: string; revision: number }> {
      const id = createHash("sha256").update(content.canonicalUrl).digest("hex");
      return database.transaction(async transaction => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`discovery:${id}`]);
        const current = (await transaction.query<{ id: string; revision: number; content_hash: string; content: DiscoveryInput; status: string }>("SELECT id,revision,content_hash,content,status FROM event_discovery_cards WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (current?.status === "withdrawn" || (current && current.content.lastAnalyzedAt > content.lastAnalyzedAt)) return { id, revision: current.revision };
        const stable = { ...content, discoveredAt: current?.content.discoveredAt ?? content.discoveredAt };
        const hash = createHash("sha256").update(JSON.stringify({ ...stable, lastAnalyzedAt: undefined,
          ...(stable.registrationWindow ? { registrationWindow: { ...stable.registrationWindow, checkedAt: undefined } } : {}),
          sources: stable.sources.map(source => ({ ...source, fetchedAt: undefined })) })).digest("hex");
        if (current?.content_hash === hash) {
          await transaction.query("UPDATE event_discovery_cards SET content=$2::jsonb,last_analyzed_at=$3,updated_at=now() WHERE id=$1", [id, JSON.stringify(stable), stable.lastAnalyzedAt]);
          return { id, revision: current.revision };
        }
        const revision = (current?.revision ?? 0) + 1;
        await transaction.query("INSERT INTO event_discovery_cards(id,canonical_url,revision,content_hash,content,discovered_at,last_analyzed_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,content=excluded.content,last_analyzed_at=excluded.last_analyzed_at,updated_at=now()", [id, stable.canonicalUrl, revision, hash, JSON.stringify(stable), stable.discoveredAt, stable.lastAnalyzedAt]);
        await transaction.query("INSERT INTO event_discovery_versions(card_id,revision,content_hash,content) VALUES($1,$2,$3,$4::jsonb)", [id, revision, hash, JSON.stringify(stable)]);
        return { id, revision };
      });
    }
  return {
    /** Trusted worker port only. There is no public ingestion or automatic rules confirmation API. */
    async save(input: DiscoveryInput): Promise<{ id: string; revision: number }> { return persist(normalize(input, clock.now())); },
    /** Close only an existing card after fresh source proof. The supplied commit
     * owns the state/URL lease fence, then this callback locks the durable card. */
    async closeRegistration(input: DiscoveryRegistrationClosureInput, commit: DiscoveryCandidateCommit): Promise<{ id: string; revision: number } | null> {
      const now = clock.now(), canonicalUrl = canonical(input.canonicalUrl), lastAnalyzedAt = instant(input.lastAnalyzedAt, now);
      let sources: DiscoveryInput["sources"], registrationWindow: RegistrationWindow;
      try {
        if (input.provider !== "dsh" || !input.registrationWindow || input.registrationWindow.status !== "closed") throw new Error();
        sources = normalizeSources(input.sources, now);
        const checkedAt = instant(input.registrationWindow.checkedAt, now);
        if (Date.parse(checkedAt) > now.getTime() || checkedAt > lastAnalyzedAt) throw new Error();
        // A model's 'closed' label alone is insufficient: actual closed/full
        // wording or an evidenced deadline already passed must establish it.
        const normalized = normalizeRegistrationWindow({ ...input.registrationWindow, status: "unknown" }, { texts: sources.map(source => source.excerpt), checkedAt });
        if (!normalized || normalized.status !== "closed") throw new Error();
        registrationWindow = normalized;
      } catch { throw new DomainError("INVALID_DISCOVERY", "报名关闭需要本次获取的本场来源证据。", { status: 422 }); }
      const id = createHash("sha256").update(canonicalUrl).digest("hex");
      if (!(await database.query("SELECT id FROM event_discovery_cards WHERE id=$1", [id])).rows.length) return null;
      return commit(() => database.transaction(async tx => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`discovery:${id}`]);
        const current = (await tx.query<{ revision: number; content: DiscoveryInput; status: string }>("SELECT revision,content,status FROM event_discovery_cards WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!current) throw new DomainError("DISCOVERY_UNAVAILABLE", "赛事线索已不可用。", { status: 409 });
        if (current.status === "withdrawn" || current.content.lastAnalyzedAt > lastAnalyzedAt) return { id, revision: current.revision };
        const freshProof = [...new Set([...registrationWindow.evidence, ...registrationWindowYearEvidence(sources.map(source => source.excerpt), registrationWindow.evidence)])].map(excerpt => {
          const source = sources.find(source => source.excerpt.includes(excerpt))!;
          return { ...source, excerpt };
        });
        const oldProof = new Set(current.content.registrationWindow?.evidence ?? []);
        const signup = current.content.registration;
        const signupSource = signup ? current.content.sources.find(source => source.url === signup.sourceUrl && source.excerpt.includes(signup.evidence)) : undefined;
        const retained = [ ...(signupSource ? [signupSource] : []), ...current.content.sources.filter(source => !oldProof.has(source.excerpt)) ];
        const unique = new Map<string, DiscoveryInput["sources"][number]>();
        for (const source of [...freshProof, ...retained]) if (!unique.has(`${source.url}\n${source.excerpt}`)) unique.set(`${source.url}\n${source.excerpt}`, source);
        return persist({ ...current.content, sources: [...unique.values()].slice(0, 13), registrationWindow, lastAnalyzedAt });
      }));
    },
    async list(input: { limit?: number; query?: string; cursor?: string } = {}) {
      const limit = input.limit ?? 24, query = input.query?.trim() ?? "";
      if (!Number.isInteger(limit) || limit < 1 || limit > 60 || query.length > 100) throw new DomainError("INVALID_FILTER", "比赛筛选条件无效。");
      let cursor: { at: string; id: string } | null = null;
      if (input.cursor) { try { if (input.cursor.length > 300) throw new Error(); cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); if (!cursor || !/^[a-f0-9]{64}$/.test(cursor.id) || !Number.isFinite(Date.parse(cursor.at))) throw new Error(); } catch { throw new DomainError("INVALID_CURSOR", "列表位置已失效，请重新加载。"); } }
      const [now, date, eventDate] = discoveryVisibilityTime(clock.now());
      // One PostgreSQL statement gives the page and its feed version the same
      // snapshot, including empty pages. A separate metadata read races updates.
      const snapshot = (await database.query<{ version: string; id: string | null; revision: number; content: DiscoveryInput; last_analyzed_at: Date }>(`SELECT feed.version,page.id,page.revision,page.content,page.last_analyzed_at
        FROM (SELECT ${discoveryFeedVersionSql} AS version FROM event_discovery_cards WHERE ${discoveryVisibilitySql("$5", "$6")}) feed
        LEFT JOIN LATERAL (SELECT id,revision,content,last_analyzed_at FROM event_discovery_cards
          WHERE ${discoveryVisibilitySql("$5", "$6")} AND ($1='' OR strpos(lower(concat(content->>'title',' ',content->>'summary')),lower($1))>0)
          AND ($2::timestamptz IS NULL OR (last_analyzed_at,id)<($2::timestamptz,$3::text))
          ORDER BY last_analyzed_at DESC,id DESC LIMIT $4) page ON true
        ORDER BY page.last_analyzed_at DESC,page.id DESC`, [query, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
      const rows = snapshot.filter((row): row is typeof row & { id: string } => row.id !== null);
      const items = rows.slice(0, limit); const last = items.at(-1);
      return { items: items.map(decode), version: snapshot[0]!.version, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: new Date(last.last_analyzed_at).toISOString(), id: last.id })).toString("base64url") : null };
    },
    async get(id: string) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new DomainError("NOT_FOUND", "比赛发现卡片不存在。", { status: 404 });
      const [now, date, eventDate] = discoveryVisibilityTime(clock.now());
      const row = (await database.query<{ id: string; revision: number; content: DiscoveryInput }>(`SELECT id,revision,content FROM event_discovery_cards WHERE id=$1 AND ${discoveryVisibilitySql("$2", "$3")}`, [id])).rows[0];
      if (!row) throw new DomainError("NOT_FOUND", "比赛发现卡片不存在。", { status: 404 });
      return decode(row);
    },
  };
}
