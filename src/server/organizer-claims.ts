import type { SqlExecutor } from "../shared/persistence.ts";
import type { OrganizerClaimCandidate, OrganizerClaimDiscoveryPort, OrganizerReadinessEvidencePort } from "../modules/organizer/index.ts";
import type { ReadinessField } from "../modules/organizer/model.ts";
import { discoveryVisibilitySql } from "./discovery.ts";

/** 候选上限：只作提示，不把整库线索倒给主办方。 */
const CANDIDATE_LIMIT = 20;
interface CardRow { readonly id: string; readonly title: string; readonly canonical_url: string; readonly analyzed_at: Date | string | null }

function sourceHostOf(url: string): string | null {
  try { const value = new URL(url); return value.hostname.toLowerCase() || null; } catch { return null; }
}
function instantOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * 根侧只读实现：主办方"认领已发现赛事"的候选与可认领判断（规划25 第10节）。
 * 只读 event_discovery_cards 的公开投影；不写、不删、不改动自动发现历史。
 * 候选匹配只解释"为什么列出来"，不构成归属或授权。
 */
export function createOrganizerClaimDiscoveryPort(): OrganizerClaimDiscoveryPort {
  return {
    async listCandidates(sql: SqlExecutor, options): Promise<OrganizerClaimCandidate[]> {
      // 已被任何机构占用（pending/approved）的线索不再作为候选，避免无效申请。
      // 与既有发现查询一致：可见性谓词只接受占位符名，实际取值由本查询的参数提供。
      const rows = await sql.query<CardRow>(
        `SELECT c.id, coalesce(c.content->>'title','') AS title, c.canonical_url, c.last_analyzed_at AS analyzed_at
           FROM event_discovery_cards c
          WHERE ${discoveryVisibilitySql("$1", "$2")}
            AND ($1::timestamptz IS NOT NULL OR $2::timestamptz IS NULL)
            AND NOT EXISTS (
              SELECT 1 FROM organizer_claim_requests r
               WHERE r.discovery_id = c.id AND r.status IN ('pending','approved')
            )
          ORDER BY c.last_analyzed_at DESC, c.id DESC
          LIMIT $3`,
        // 可见性谓词当前返回固定 SQL；这里用显式类型让占位符在语句中出现，
        // 否则 Postgres 无法推断参数类型（42P18）。
        [new Date().toISOString(), new Date().toISOString(), CANDIDATE_LIMIT],
      );
      const name = options.organizationName.trim();
      return rows.rows.flatMap(row => {
        const host = sourceHostOf(row.canonical_url);
        const title = row.title.trim();
        if (!host || !title) return [];
        // 机构名出现在标题里时给出更明确的匹配原因，便于主办方一眼认出；
        // 两种原因都只是提示，都需要走归属核实才能认领。
        const named = name.length >= 2 && title.toLowerCase().includes(name.toLowerCase());
        return [{ discoveryId: row.id, title, sourceUrl: row.canonical_url, sourceHost: host,
          analyzedAt: instantOrNull(row.analyzed_at), matchReason: named ? "name_conflict" as const : "manual_pick" as const }];
      });
    },
    async getCandidate(sql: SqlExecutor, discoveryId: string): Promise<OrganizerClaimCandidate | null> {
      const rows = await sql.query<CardRow>(
        `SELECT c.id, coalesce(c.content->>'title','') AS title, c.canonical_url, c.last_analyzed_at AS analyzed_at
           FROM event_discovery_cards c
          WHERE c.id = $3 AND ${discoveryVisibilitySql("$1", "$2")}
            AND ($1::timestamptz IS NOT NULL OR $2::timestamptz IS NULL)`,
        [new Date().toISOString(), new Date().toISOString(), discoveryId],
      );
      const row = rows.rows[0];
      if (!row) return null;
      const host = sourceHostOf(row.canonical_url), title = row.title.trim();
      if (!host || !title) return null;
      // 单条线索没有机构名可比对，只能按手工选择呈现：matched 原因保持 manual_pick。
      return { discoveryId: row.id, title, sourceUrl: row.canonical_url, sourceHost: host,
        analyzedAt: instantOrNull(row.analyzed_at), matchReason: "manual_pick" as const };
    },
    async getClaimable(sql: SqlExecutor, discoveryId: string) {
      const rows = await sql.query<CardRow>(
        `SELECT c.id, coalesce(c.content->>'title','') AS title, c.canonical_url, c.last_analyzed_at AS analyzed_at
           FROM event_discovery_cards c
          WHERE c.id = $3 AND ${discoveryVisibilitySql("$1", "$2")}
            AND ($1::timestamptz IS NOT NULL OR $2::timestamptz IS NULL)`,
        [new Date().toISOString(), new Date().toISOString(), discoveryId],
      );
      const row = rows.rows[0];
      if (!row) return null;
      const host = sourceHostOf(row.canonical_url);
      return host ? { discoveryId: row.id, sourceHost: host } : null;
    },
  };
}

interface EvidenceRow { readonly canonical_url: string; readonly content: Record<string, unknown>; readonly analyzed_at: Date | string | null }
function evidenceStrings(value: unknown, limit = 3): string[] {
  const items = Array.isArray(value) ? value : [];
  return items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit);
}
function textOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

/**
 * P03 只读证据：从被认领的发现卡片取出与"待补字段"相关的原文片段。
 * 这些片段只是抓取线索，界面必须与主办方确认的值区分，不得当作已核验事实。
 */
export function createOrganizerReadinessEvidencePort(): OrganizerReadinessEvidencePort {
  return {
    async read(sql, input) {
      const rows = await sql.query<EvidenceRow>(
        `SELECT c.canonical_url, c.content, c.last_analyzed_at AS analyzed_at
           FROM event_discovery_cards c
          WHERE c.id = $1`,
        [input.discoveryId],
      );
      const row = rows.rows[0];
      if (!row) return null;
      const content = row.content ?? {};
      const registrationWindow = (content.registrationWindow ?? null) as { evidence?: unknown } | null;
      const eventWindow = (content.eventWindow ?? null) as { evidence?: unknown } | null;
      const participation = (content.participation ?? null) as { reason?: unknown; suitableFor?: unknown } | null;
      const analysis = (content.analysis ?? null) as { preparation?: unknown; unknowns?: unknown } | null;
      const fields: Partial<Record<ReadinessField, readonly string[]>> = {
        registrationClosesAt: evidenceStrings(registrationWindow?.evidence),
        registrationOpensAt: evidenceStrings(registrationWindow?.evidence),
        startsAt: evidenceStrings(eventWindow?.evidence),
        endsAt: evidenceStrings(eventWindow?.evidence),
        eligibility: [...evidenceStrings(participation?.suitableFor), ...evidenceStrings(analysis?.unknowns)]
          .filter((value, index, all) => all.indexOf(value) === index).slice(0, 3),
        requiredMaterials: evidenceStrings(analysis?.preparation),
        submissionMethod: evidenceStrings(analysis?.preparation),
        aiPolicy: evidenceStrings(analysis?.unknowns),
        fee: evidenceStrings(analysis?.unknowns),
      };
      return { sourceUrl: textOrNull(row.canonical_url), checkedAt: instantOrNull(row.analyzed_at), fields };
    },
  };
}
