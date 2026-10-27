import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, PlatformRole } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventOfficialLinksOptions, PublishedOfficialRules, SetOfficialRuleLinkInput } from "./model.ts";
import { createEventOfficialLinksService } from "./service.ts";

const testUsers = { administrator: ["user", "admin"], reviewer: ["user", "reviewer"], organizer: ["user"], outsider: ["user"] } as const;
type UserId = keyof typeof testUsers;
export const officialLinkError = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

export function setInput(overrides: Partial<SetOfficialRuleLinkInput> = {}): SetOfficialRuleLinkInput {
  return { expectedRevision: 0, expectedHostedPublishedRevision: 2, linkedEventId: "rules-a", rulesVersion: 3, auditNote: "人工核对正式赛事身份与规则来源", ...overrides };
}

function scope(eventId: string, organizationId: string, publishedRevision: number): HostedEventScope {
  return {
    eventId, organizationId, organizationName: organizationId === "org-a" ? "主办方甲" : "主办方乙", title: "同名赛事",
    status: "published", revision: publishedRevision + 1, publishedRevision, timezone: "Asia/Shanghai",
    startsAt: "2026-10-20T02:00:00.000Z", endsAt: "2026-10-21T10:00:00.000Z",
    registrationOpensAt: null, registrationClosesAt: null, submissionClosesAt: null,
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: false, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: true, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, linkedEventId: null,
  };
}

/** Isolated real SQL engine; no environment, filesystem database, workers or external services. */
export async function officialLinksFixture(t: TestContext) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec(`
    CREATE TABLE auth_users(id text PRIMARY KEY, active boolean NOT NULL, platform_roles text[] NOT NULL);
    CREATE TABLE official_link_test_sessions(id text PRIMARY KEY, user_id text NOT NULL REFERENCES auth_users(id), active boolean NOT NULL);
    CREATE TABLE organizer_organizations(id text PRIMARY KEY, name text NOT NULL, status text NOT NULL, active boolean NOT NULL);
    CREATE TABLE organizer_hosted_events(id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizer_organizations(id), document jsonb NOT NULL, UNIQUE(id,organization_id));
    CREATE TABLE official_link_test_rules(event_id text PRIMARY KEY, title text NOT NULL, published_version integer NOT NULL, status text NOT NULL, source_url text);
  `);
  await engine.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  const statements: string[] = [];
  function executor(query: (statement: string, parameters: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>, record = true): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      if (record) statements.push(statement);
      const result = await query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    } };
  }
  const direct = executor((statement, parameters) => engine.query(statement, parameters), false);
  const recorded = executor((statement, parameters) => engine.query(statement, parameters));
  const database: DatabasePort = {
    query: recorded.query,
    transaction: work => engine.transaction(tx => work(executor((statement, parameters) => tx.query(statement, parameters)))),
  };
  for (const [id, roles] of Object.entries(testUsers)) {
    await direct.query("INSERT INTO auth_users VALUES($1,true,$2::text[])", [id, [...roles]]);
    await direct.query("INSERT INTO official_link_test_sessions VALUES($1,$2,true)", [`session-${id}`, id]);
  }
  for (const [id, name] of [["org-a", "主办方甲"], ["org-b", "主办方乙"]]) {
    await direct.query("INSERT INTO organizer_organizations VALUES($1,$2,'approved',true)", [id, name]);
  }
  for (const item of [scope("hosted-a", "org-a", 2), scope("hosted-b", "org-b", 5)]) {
    await direct.query("INSERT INTO organizer_hosted_events VALUES($1,$2,$3)", [item.eventId, item.organizationId, JSON.stringify(item)]);
  }
  for (const [id, version, status] of [["rules-a", 3, "published"], ["rules-b", 7, "published"], ["rules-draft", 1, "draft"]] as const) {
    await direct.query("INSERT INTO official_link_test_rules VALUES($1,$2,$3,$4,$5)", [id, "同名赛事", version, status, `https://official.example/${id}`]);
  }
  const getHostedEvent: EventOfficialLinksOptions["getHostedEvent"] = async (sql, id, options = {}) => {
    const preliminary = await sql.query<{ organization_id: string }>("SELECT organization_id FROM organizer_hosted_events WHERE id=$1", [id]);
    if (!preliminary.rows[0]) return null;
    const organizationId = preliminary.rows[0].organization_id;
    const organization = await sql.query<{ status: string; active: boolean }>(`SELECT status,active FROM organizer_organizations WHERE id=$1${options.forUpdate ? " FOR UPDATE" : ""}`, [organizationId]);
    if (!organization.rows[0]?.active || organization.rows[0].status !== "approved") return null;
    const event = await sql.query<{ organization_id: string; document: HostedEventScope }>(`SELECT organization_id,document FROM organizer_hosted_events WHERE id=$1${options.forUpdate ? " FOR UPDATE" : ""}`, [id]);
    if (!event.rows[0] || event.rows[0].organization_id !== organizationId) return null;
    return event.rows[0].document;
  };
  const getPublished: EventOfficialLinksOptions["rulesPort"]["getPublished"] = async (sql, eventId, options = {}) => {
    const found = await sql.query<{ event_id: string; title: string; published_version: number; source_url: string | null }>(`SELECT event_id,title,published_version,source_url FROM official_link_test_rules WHERE event_id=$1 AND status='published'${options.forUpdate ? " FOR SHARE" : ""}`, [eventId]);
    const row = found.rows[0];
    return row ? { eventId: row.event_id, title: row.title, publishedVersion: row.published_version, status: "published", ...(row.source_url ? { sourceUrl: row.source_url } : {}) } : null;
  };
  const listPublished: NonNullable<EventOfficialLinksOptions["rulesPort"]["listPublished"]> = async (sql, input) => {
    const found = await sql.query<{ event_id: string }>("SELECT event_id FROM official_link_test_rules WHERE status='published' AND title ILIKE $1 ORDER BY event_id LIMIT $2", [`%${input.query}%`, input.limit]);
    const result: PublishedOfficialRules[] = [];
    for (const row of found.rows) { const item = await getPublished(sql, row.event_id); if (item) result.push(item); }
    return result;
  };
  let nextId = 0;
  const options: EventOfficialLinksOptions = { database, clock: { now: () => new Date("2026-10-11T04:00:00.000Z") }, ids: { next: () => `official-link-history-${++nextId}` }, getHostedEvent, rulesPort: { getPublished, listPublished } };
  const service = createEventOfficialLinksService(options);
  function principal(id: UserId, customization: { readonly failAt?: number; readonly actor?: Actor; readonly beforeGuard?: (sql: SqlExecutor, calls: number) => Promise<void> } = {}): OrganizerPrincipal {
    let calls = 0;
    const actor = customization.actor ?? { userId: id, platformRoles: [...testUsers[id]] as PlatformRole[] };
    return { actor, async guard(sql) {
      calls += 1; await customization.beforeGuard?.(sql, calls);
      const result = await sql.query<{ id: string; active: boolean; platform_roles: string[]; session_active: boolean }>(
        "SELECT u.id,u.active,u.platform_roles,s.active AS session_active FROM auth_users u JOIN official_link_test_sessions s ON s.user_id=u.id WHERE s.id=$1", [`session-${id}`],
      );
      const row = result.rows[0];
      if (calls === customization.failAt || !row?.active || !row.session_active || row.id !== actor.userId
        || JSON.stringify([...row.platform_roles].sort()) !== JSON.stringify([...actor.platformRoles].sort())) {
        throw new DomainError("AUTH_SESSION_INVALID", "当前账号或请求会话已失效。", { status: 401 });
      }
    } };
  }
  const users = Object.fromEntries(Object.keys(testUsers).map(id => [id, principal(id as UserId)])) as Record<UserId, OrganizerPrincipal>;
  async function hosted(id = "hosted-a") { return (await direct.query<{ document: HostedEventScope }>("SELECT document FROM organizer_hosted_events WHERE id=$1", [id])).rows[0]!.document; }
  async function changeHosted(id: string, patch: Partial<HostedEventScope>, sql: SqlExecutor = direct) {
    const row = (await sql.query<{ document: HostedEventScope }>("SELECT document FROM organizer_hosted_events WHERE id=$1", [id])).rows[0]!.document;
    await sql.query("UPDATE organizer_hosted_events SET document=$1 WHERE id=$2", [JSON.stringify({ ...row, ...patch }), id]);
  }
  async function counts() {
    const result = await direct.query<{ heads: number; history: number }>("SELECT (SELECT count(*)::integer FROM event_official_links) AS heads,(SELECT count(*)::integer FROM event_official_link_history) AS history");
    return result.rows[0]!;
  }
  return { engine, direct, database, statements, service, users, principal, hosted, changeHosted, counts, options, serviceWith: (overrides: Partial<EventOfficialLinksOptions>) => createEventOfficialLinksService({ ...options, ...overrides }) };
}
