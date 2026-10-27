import { PostgresEventsRepository } from "../modules/events/index.ts";
import type { OfficialRulesPort, PublishedOfficialRules } from "../modules/event-official-links/index.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";

/** M03 remains the owner; scoped repository uses exactly the caller's executor. */
export function createOrganizerOfficialRulesPort(): OfficialRulesPort {
  async function getPublished(sql: SqlExecutor, eventId: string, options?: { forUpdate?: boolean }): Promise<PublishedOfficialRules | null> {
    const scoped: DatabasePort = { query: (query, parameters) => sql.query(query, parameters), transaction: work => work(sql) };
    const repository = new PostgresEventsRepository(scoped);
    const read = async (store: Pick<PostgresEventsRepository, "getEvent" | "getRules">) => {
      const event = await store.getEvent(eventId);
      if (!event || event.publicationStatus !== "published" || !event.publishedVersion) return null;
      const rules = await store.getRules(eventId, event.publishedVersion);
      if (!rules || rules.eventId !== eventId || rules.version !== event.publishedVersion) return null;
      return { eventId, title: rules.metadata.name, publishedVersion: rules.version, status: "published" as const, sourceUrl: rules.metadata.officialUrl };
    };
    return options?.forUpdate ? repository.transaction(read) : read(repository);
  }
  return { getPublished, async listPublished(sql, input) {
    const limit = Math.min(100, Math.max(1, input.limit));
    const rows = await sql.query<{ id: string }>(`SELECT e.id FROM m03_events e JOIN m03_rule_versions r ON r.event_id=e.id AND r.version=(e.body->>'publishedVersion')::integer
      WHERE e.body->>'publicationStatus'='published' AND ($1='' OR position(lower($1) in lower(r.body->'metadata'->>'name'))>0)
      ORDER BY e.id LIMIT $2`, [input.query, limit]);
    const result: PublishedOfficialRules[] = [];
    for (const row of rows.rows) { const value = await getPublished(sql, row.id); if (value) result.push(value); }
    return result;
  } };
}
