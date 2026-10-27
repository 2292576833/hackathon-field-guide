import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventRuleVersion, SubmissionRequirement } from "./domain.ts";

export type OfficialTrackStatus = "unknown" | "none" | "conflict" | "confirmed";
export interface OfficialTrackDetail { text: string; evidenceIds: string[] }
/** IDs are assigned by the rule curator and kept across rule versions, never resource categories. */
export interface OfficialTrack {
  id: string;
  name: string;
  evidenceIds: string[];
  eligibility: OfficialTrackDetail | null;
  scoringFocus: OfficialTrackDetail | null;
  deliverables: { requirementId: string; evidenceIds: string[] }[];
}
export interface OfficialTrackCatalog {
  status: OfficialTrackStatus;
  evidenceIds: string[];
  tracks: OfficialTrack[];
}
export interface OfficialTrackRulesContext {
  eventId: string;
  rulesVersion: number;
  confirmationRevision: number;
  latestPublishedRulesVersion: number | null;
  catalog: OfficialTrackCatalog;
  requirements: SubmissionRequirement[];
}
/** Caller checks active membership under M02's project lock; this port reads only M03-owned facts. */
export interface ProjectOfficialTrackRulesPort {
  getProjectTrackRules(projectId: string, executor: SqlExecutor): Promise<OfficialTrackRulesContext | null>;
}

/** Old immutable rules are not rewritten or interpreted as a no-track declaration. */
export function getOfficialTrackCatalog(rules: EventRuleVersion): OfficialTrackCatalog {
  return structuredClone(rules.officialTracks ?? { status: "unknown", evidenceIds: [], tracks: [] });
}

type EvidenceVerifier = (rules: EventRuleVersion, evidenceId: string) => boolean;
/** Runs only after the base rule evidence graph has been validated. */
export function validateOfficialTrackCatalog(input: unknown, rules: EventRuleVersion, verified: EvidenceVerifier): OfficialTrackCatalog {
  const fail = (message: string): never => { throw new DomainError("INVALID_RULE_VERSION", `officialTracks：${message}`); };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("必须是对象。");
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max: number): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000]/u.test(value)) fail("文字不能为空或超过长度限制。");
    return (value as string).trim();
  };
  const array = (value: unknown, max: number): unknown[] => {
    if (!Array.isArray(value) || value.length > max) fail("数组超过长度限制或无效。");
    return value as unknown[];
  };
  const evidence = new Map(rules.evidence.map(item => [item.id, item]));
  const ids = (value: unknown): string[] => {
    const refs = array(value, 100).map(item => text(item, 200));
    if (new Set(refs).size !== refs.length || refs.some(id => !evidence.has(id))) fail("证据必须唯一并属于当前规则版本。");
    return refs;
  };
  const value = object(input);
  if (!["unknown", "none", "conflict", "confirmed"].includes(value.status as string)) fail("状态无效。");
  const status = value.status as OfficialTrackStatus;
  const requireOfficial = (refs: string[], label: string, trackId?: string): void => {
    if (refs.length === 0 || refs.some(id => {
      const item = evidence.get(id)!;
      const source = rules.sources.find(source => source.id === item.sourceId);
      const scope = item.fieldKey === "official_tracks" || (trackId !== undefined && (item.fieldKey === `official_tracks.${trackId}` || item.fieldKey.startsWith(`official_tracks.${trackId}.`)));
      return !source || source.kind !== "official" || source.trustScope !== "official_rules" || !scope ||
        !["available", "stale"].includes(source.status) || (status !== "conflict" && !verified(rules, id));
    })) fail(`${label}必须引用对应官方赛道字段的原文证据。`);
  };
  const detail = (input: unknown, trackId: string): OfficialTrackDetail | null => {
    if (input === null) return null;
    const value = object(input); const evidenceIds = ids(value.evidenceIds);
    requireOfficial(evidenceIds, "赛道说明", trackId);
    return { text: text(value.text, 3000), evidenceIds };
  };
  const evidenceIds = ids(value.evidenceIds);
  const tracks: OfficialTrack[] = array(value.tracks, 100).map(input => {
    const item = object(input); const id = text(item.id, 200);
    if (/[\s\p{Cc}]/u.test(id) || id !== item.id) fail("赛道稳定 ID 不能包含空白或控制字符。");
    const evidenceIds = ids(item.evidenceIds);
    requireOfficial(evidenceIds, "赛道名称", id);
    const deliverables = array(item.deliverables, 200).map(input => {
      const item = object(input); const requirementId = text(item.requirementId, 200); const evidenceIds = ids(item.evidenceIds);
      if (!rules.requirements.some(requirement => requirement.id === requirementId)) fail("赛道交付物必须引用当前版本的正式提交要求。");
      requireOfficial(evidenceIds, "赛道必交材料", id);
      return { requirementId, evidenceIds };
    });
    if (new Set(deliverables.map(item => item.requirementId)).size !== deliverables.length) fail("赛道交付物引用不能重复。");
    return { id, name: text(item.name, 300), evidenceIds, eligibility: detail(item.eligibility, id), scoringFocus: detail(item.scoringFocus, id), deliverables };
  });
  if (new Set(tracks.map(item => item.id)).size !== tracks.length) fail("赛道稳定 ID 不能重复。");
  if (status === "unknown" && (tracks.length > 0 || evidenceIds.length > 0)) fail("未知状态不能声明官方赛道或已核验依据。");
  if (status === "none" && tracks.length > 0) fail("主办方未细分赛道时不能保留赛道列表。");
  if (status === "confirmed" && tracks.length === 0) fail("已确认赛道列表不能为空；无细分请使用 none。");
  if (status === "none" || status === "confirmed" || status === "conflict") requireOfficial(evidenceIds, "赛道总体状态");
  if (status === "conflict" && (evidenceIds.length < 2 || !evidenceIds.some(id => evidence.get(id)!.conflictsWith.some(other => evidenceIds.includes(other))))) fail("冲突状态必须保留相互冲突的官方证据。");
  return { status, evidenceIds, tracks };
}
