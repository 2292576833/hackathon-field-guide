import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventRuleVersion } from "./domain.ts";
import { validateRuleVersion } from "./domain.ts";
import type { EventRecord, ProjectRuleConfirmation } from "./model.ts";
import { getOfficialTrackCatalog } from "./official-tracks.ts";
import type { OfficialTrackRulesContext, ProjectOfficialTrackRulesPort } from "./official-tracks.ts";

/** Bound to the caller's transaction. Never opens another connection or writes M02 state. */
export class PostgresOfficialTrackRulesPort implements ProjectOfficialTrackRulesPort {
  async getProjectTrackRules(projectId: string, executor: SqlExecutor): Promise<OfficialTrackRulesContext | null> {
    const result = await executor.query<{ body: ProjectRuleConfirmation }>("SELECT body FROM m03_project_rules WHERE id = $1 FOR UPDATE", [projectId]);
    const confirmation = result.rows[0]?.body;
    if (!confirmation) return null;
    const ruleResult = await executor.query<{ body: EventRuleVersion }>("SELECT body FROM m03_rule_versions WHERE event_id = $1 AND version = $2", [confirmation.eventId, confirmation.rulesVersion]);
    const raw = ruleResult.rows[0]?.body;
    if (!raw) throw new Error("Confirmed official rule snapshot missing");
    const rules = validateRuleVersion(raw);
    const eventResult = await executor.query<{ body: EventRecord }>("SELECT body FROM m03_events WHERE id = $1", [confirmation.eventId]);
    return {
      eventId: rules.eventId, rulesVersion: rules.version, confirmationRevision: confirmation.revision,
      latestPublishedRulesVersion: eventResult.rows[0]?.body.publishedVersion ?? null,
      catalog: getOfficialTrackCatalog(rules), requirements: structuredClone(rules.requirements),
    };
  }
}
