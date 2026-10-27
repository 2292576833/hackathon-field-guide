import { DomainError } from "../../shared/errors.ts";
import { getOfficialTrackCatalog, validateOfficialTrackCatalog } from "./official-tracks.ts";
import type { OfficialTrackCatalog } from "./official-tracks.ts";

export type EventFormat = "online" | "offline" | "hybrid" | "unknown";
export type EventPhase = "registration" | "active" | "awaiting_submission" | "ended" | "unknown";
export type QualityFlag = "needs_recheck" | "source_stale" | "source_failed" | "missing_information";
export interface EventSource {
  id: string;
  eventId: string;
  version: number;
  sourceConfigId: string | null;
  url: string;
  kind: "official" | "user_provided" | "secondary";
  contentHash: string;
  fetchedAt: string;
  trustScope: "official_rules" | "user_claim" | "secondary_report";
  status: "available" | "failed" | "removed" | "stale";
}
export interface RuleEvidence {
  id: string;
  eventId: string;
  version: number;
  sourceId: string;
  fieldKey: string;
  excerpt: string;
  locator: string;
  rawDateText: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  conflictsWith: string[];
}
export interface RuleFact {
  key: string;
  statement: string;
  status: "verified" | "unverified" | "unknown" | "conflicted";
  evidenceIds: string[];
}
export interface RuleMoment {
  rawText: string;
  timeZone: string | null;
  utc: string | null;
  dateOnly: boolean;
  evidenceIds: string[];
}
export interface EventStage {
  id: string;
  stageType: "registration" | "development" | "submission" | "pitch" | "other";
  name: string;
  startsAt: RuleMoment | null;
  endsAt: RuleMoment | null;
  submissionUrl: string | null;
}
export interface SubmissionRequirement {
  id: string;
  label: string;
  necessity: "required" | "optional" | "unknown";
  stageId: string | null;
  evidenceIds: string[];
}
export interface EventRuleVersion {
  eventId: string;
  version: number;
  createdAt: string;
  metadata: { name: string; organizer: string; format: EventFormat; region: string; officialUrl: string };
  sources: EventSource[];
  evidence: RuleEvidence[];
  facts: RuleFact[];
  stages: EventStage[];
  requirements: SubmissionRequirement[];
  qualityFlags: QualityFlag[];
  /** Missing on historical versions means unknown; it never means no official tracks. */
  officialTracks?: OfficialTrackCatalog;
}
/** Paths are JSON pointers keyed by stable child IDs (fact keys for facts). */
export interface RuleChange { path: string; before: unknown; after: unknown }
export const KEY_RULE_FACTS = ["eligibility", "fees", "team_size", "ai_policy"] as const;

function invalid(path: string, message: string): never {
  throw new DomainError("INVALID_RULE_VERSION", `${path}：${message}`, {
    recoveryAction: "核对原始规则和证据，保留未知内容后重新保存。",
  });
}
function record(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(path, "必须是对象。");
  return input as Record<string, unknown>;
}
function string(input: unknown, path: string, allowEmpty = false, max = 8000): string {
  if (typeof input !== "string" || input.length > max || (!allowEmpty && !input.trim())) {
    invalid(path, `必须是${allowEmpty ? "有效" : "非空"}文字，且不超过 ${max} 字符。`);
  }
  return input.trim();
}
function optionalString(input: unknown, path: string, max = 8000): string | null {
  return input === null ? null : string(input, path, false, max);
}
function integer(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) invalid(path, "必须是正整数。");
  return input;
}
function choice<T extends string>(input: unknown, allowed: readonly T[], path: string): T {
  if (typeof input !== "string" || !allowed.includes(input as T)) invalid(path, "值不在允许范围内。");
  return input as T;
}
function list<T>(input: unknown, path: string, parse: (value: unknown, path: string) => T, max = 2000): T[] {
  if (!Array.isArray(input) || input.length > max) invalid(path, `必须是数组，且不超过 ${max} 项。`);
  return input.map((value, index) => parse(value, `${path}[${index}]`));
}
function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(path, "ID 或字段键不得重复。");
}
function references(input: unknown, path: string): string[] {
  const result = list(input, path, (value, itemPath) => string(value, itemPath, false, 200));
  unique(result, path);
  return result;
}
function httpUrl(input: unknown, path: string, allowEmpty = false): string {
  const value = string(input, path, allowEmpty, 2000);
  if (allowEmpty && value === "") return value;
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) invalid(path, "必须是无凭据的 HTTP(S) 地址。");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalid(path, "必须是绝对 HTTP(S) 地址。");
  }
  return value;
}
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
/** Date.parse alone normalizes impossible dates such as February 30. */
function instant(input: unknown, path: string): string {
  const value = string(input, path, false, 100);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) invalid(path, "必须是有效且带明确时区偏移的 ISO 8601 时间。");
  if (match[8] !== "Z") {
    const offset = match[8]!.slice(1).split(":").map(Number);
    if (offset[0]! > 23 || offset[1]! > 59) invalid(path, "时区偏移无效。");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(path, "时间无法解析。");
  return new Date(milliseconds).toISOString();
}
function zone(input: unknown, path: string): string {
  const value = string(input, path, false, 100);
  if (/^[+-]/.test(value)) invalid(path, "请提供 IANA 时区名称，不能只使用数字偏移。");
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); }
  catch { invalid(path, "IANA 时区不存在。"); }
  return value;
}
function moment(input: unknown, path: string): RuleMoment | null {
  if (input === null) return null;
  const value = record(input, path);
  if (typeof value.dateOnly !== "boolean") invalid(`${path}.dateOnly`, "必须是布尔值。");
  const result: RuleMoment = {
    rawText: string(value.rawText, `${path}.rawText`),
    timeZone: value.timeZone === null ? null : zone(value.timeZone, `${path}.timeZone`),
    utc: value.utc === null ? null : instant(value.utc, `${path}.utc`),
    dateOnly: value.dateOnly,
    evidenceIds: references(value.evidenceIds, `${path}.evidenceIds`),
  };
  if (result.utc !== null && (result.dateOnly || result.timeZone === null)) invalid(path, "仅有日期或缺少原时区时不能生成精确 UTC 时间。");
  const explicitClock = /(?<![\d+\-])(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)|\b(?:1[0-2]|0?[1-9])\s*(?:a\.?m\.?|p\.?m\.?)\b|(?<!\d)(?:[01]?\d|2[0-3])\s*(?:时|点)|[零〇一二三四五六七八九十两]+(?:时|点)|\b(?:midnight|noon)\b|午夜|正午/iu;
  if (result.utc && !explicitClock.test(result.rawText)) invalid(path, "原始日期文本未明确具体时刻，不能生成精确截止时间。");
  const chineseDate = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(result.rawText);
  if (chineseDate && !isCalendarDate(Number(chineseDate[1]), Number(chineseDate[2]), Number(chineseDate[3]))) invalid(`${path}.rawText`, "原文包含无效日期。");
  // Check recognizable original dates without guessing the meaning of free-form text.
  const raw = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?)?(?:\s+[^\d].*)?$/.exec(result.rawText);
  if (raw) {
    if (!isCalendarDate(Number(raw[1]), Number(raw[2]), Number(raw[3])) || Number(raw[4] ?? 0) > 23 || Number(raw[5] ?? 0) > 59 || Number(raw[6] ?? 0) > 59) invalid(`${path}.rawText`, "原文包含无效日期或时间。");
    if (result.utc && !raw[4]) invalid(path, "只有日期的原文不能补成精确截止时间。");
    if (result.utc && result.timeZone && raw[4]) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: result.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(result.utc));
      const fields = new Map(parts.map(part => [part.type, part.value]));
      const expected = [raw[1], raw[2], raw[3], raw[4], raw[5], raw[6] ?? "00"];
      const actual = ["year", "month", "day", "hour", "minute", "second"].map(key => fields.get(key as Intl.DateTimeFormatPartTypes));
      if (expected.some((part, index) => Number(part) !== Number(actual[index]))) invalid(path, "原时区的本地时间与 UTC 时间不一致，请检查夏令时或转换。");
      if (raw[8]) {
        const original = `${raw[1]}-${raw[2]}-${raw[3]}T${raw[4]}:${raw[5]}:${raw[6] ?? "00"}${raw[7] ? `.${raw[7]}` : ""}${raw[8]}`;
        if (instant(original, `${path}.rawText`) !== result.utc) invalid(path, "原文的明确时区偏移与 UTC 时间不一致。");
      }
    }
  }
  return result;
}

/** Official snapshots remain historical evidence when stale; failed/removed ones cannot verify a new fact. */
export function isVerifiedRuleEvidence(version: EventRuleVersion, evidenceId: string): boolean {
  const evidence = version.evidence.find(item => item.id === evidenceId);
  if (!evidence || evidence.eventId !== version.eventId || evidence.version !== version.version ||
      !evidence.verifiedBy || !evidence.verifiedAt || evidence.conflictsWith.length > 0 ||
      version.evidence.some(item => item.conflictsWith.includes(evidenceId))) return false;
  try { instant(evidence.verifiedAt, "evidence.verifiedAt"); } catch { return false; }
  const source = version.sources.find(item => item.id === evidence.sourceId);
  return !!source && source.eventId === version.eventId && source.version === version.version &&
    source.kind === "official" && source.trustScope === "official_rules" && ["available", "stale"].includes(source.status);
}

/** Copies only recognized fields; external or model objects are never trusted by assertion. */
export function validateRuleVersion(input: unknown): EventRuleVersion {
  const value = record(input, "rules");
  const metadata = record(value.metadata, "metadata");
  const result: EventRuleVersion = {
    eventId: string(value.eventId, "eventId", false, 200),
    version: integer(value.version, "version"),
    createdAt: instant(value.createdAt, "createdAt"),
    metadata: {
      name: string(metadata.name, "metadata.name", false, 300),
      organizer: string(metadata.organizer, "metadata.organizer", true, 300),
      format: choice(metadata.format, ["online", "offline", "hybrid", "unknown"], "metadata.format"),
      region: string(metadata.region, "metadata.region", true, 300),
      officialUrl: httpUrl(metadata.officialUrl, "metadata.officialUrl", true),
    },
    sources: list(value.sources, "sources", (input, path) => {
      const item = record(input, path);
      const status = choice(item.status, ["available", "failed", "removed", "stale"], `${path}.status`);
      return {
        id: string(item.id, `${path}.id`, false, 200), eventId: string(item.eventId, `${path}.eventId`, false, 200),
        version: integer(item.version, `${path}.version`), sourceConfigId: optionalString(item.sourceConfigId, `${path}.sourceConfigId`, 200),
        url: httpUrl(item.url, `${path}.url`), kind: choice(item.kind, ["official", "user_provided", "secondary"], `${path}.kind`),
        contentHash: string(item.contentHash, `${path}.contentHash`, status === "failed", 300), fetchedAt: instant(item.fetchedAt, `${path}.fetchedAt`),
        trustScope: choice(item.trustScope, ["official_rules", "user_claim", "secondary_report"], `${path}.trustScope`), status,
      };
    }, 100),
    evidence: list(value.evidence, "evidence", (input, path) => {
      const item = record(input, path);
      return {
        id: string(item.id, `${path}.id`, false, 200), eventId: string(item.eventId, `${path}.eventId`, false, 200),
        version: integer(item.version, `${path}.version`), sourceId: string(item.sourceId, `${path}.sourceId`, false, 200),
        fieldKey: string(item.fieldKey, `${path}.fieldKey`, false, 200), excerpt: string(item.excerpt, `${path}.excerpt`, false, 3000),
        locator: string(item.locator, `${path}.locator`, false, 500), rawDateText: optionalString(item.rawDateText, `${path}.rawDateText`),
        verifiedBy: optionalString(item.verifiedBy, `${path}.verifiedBy`, 200),
        verifiedAt: item.verifiedAt === null ? null : instant(item.verifiedAt, `${path}.verifiedAt`),
        conflictsWith: references(item.conflictsWith, `${path}.conflictsWith`),
      };
    }),
    facts: list(value.facts, "facts", (input, path) => {
      const item = record(input, path);
      return { key: string(item.key, `${path}.key`, false, 200), statement: string(item.statement, `${path}.statement`),
        status: choice(item.status, ["verified", "unverified", "unknown", "conflicted"], `${path}.status`),
        evidenceIds: references(item.evidenceIds, `${path}.evidenceIds`) };
    }),
    stages: list(value.stages, "stages", (input, path) => {
      const item = record(input, path);
      return { id: string(item.id, `${path}.id`, false, 200), stageType: choice(item.stageType, ["registration", "development", "submission", "pitch", "other"], `${path}.stageType`),
        name: string(item.name, `${path}.name`, false, 300), startsAt: moment(item.startsAt, `${path}.startsAt`), endsAt: moment(item.endsAt, `${path}.endsAt`),
        submissionUrl: item.submissionUrl === null ? null : httpUrl(item.submissionUrl, `${path}.submissionUrl`) };
    }, 100),
    requirements: list(value.requirements, "requirements", (input, path) => {
      const item = record(input, path);
      return { id: string(item.id, `${path}.id`, false, 200), label: string(item.label, `${path}.label`, false, 1000),
        necessity: choice(item.necessity, ["required", "optional", "unknown"], `${path}.necessity`),
        stageId: optionalString(item.stageId, `${path}.stageId`, 200), evidenceIds: references(item.evidenceIds, `${path}.evidenceIds`) };
    }),
    qualityFlags: list(value.qualityFlags, "qualityFlags", (input, path) => choice(input, ["needs_recheck", "source_stale", "source_failed", "missing_information"], path), 4),
  };
  unique(result.sources.map(item => item.id), "sources"); unique(result.evidence.map(item => item.id), "evidence");
  unique(result.facts.map(item => item.key), "facts"); unique(result.stages.map(item => item.id), "stages");
  unique(result.requirements.map(item => item.id), "requirements"); unique(result.qualityFlags, "qualityFlags");
  const sources = new Map(result.sources.map(item => [item.id, item]));
  const evidence = new Map(result.evidence.map(item => [item.id, item]));
  const stages = new Set(result.stages.map(item => item.id));
  const requireEvidence = (ids: string[], path: string) => {
    for (const id of ids) if (!evidence.has(id)) invalid(path, `证据 ${id} 不属于此赛事版本。`);
  };
  for (const source of result.sources) {
    if (source.eventId !== result.eventId || source.version !== result.version) invalid(`sources.${source.id}`, "来源快照必须属于同一赛事和版本。");
    const scopes = { official: "official_rules", user_provided: "user_claim", secondary: "secondary_report" };
    if (source.trustScope !== scopes[source.kind]) invalid(`sources.${source.id}.trustScope`, "来源类型与可信范围不一致。");
  }
  for (const item of result.evidence) {
    if (item.eventId !== result.eventId || item.version !== result.version) invalid(`evidence.${item.id}`, "证据必须属于同一赛事和版本。");
    const source = sources.get(item.sourceId);
    if (!source) invalid(`evidence.${item.id}.sourceId`, "来源快照不存在。");
    if ((item.verifiedAt === null) !== (item.verifiedBy === null)) invalid(`evidence.${item.id}`, "核验人和核验时间必须同时提供。");
    if (item.verifiedBy !== null && source.kind !== "official") invalid(`evidence.${item.id}`, "用户陈述或二手来源不能冒充官方核验。");
    requireEvidence(item.conflictsWith, `evidence.${item.id}.conflictsWith`);
    if (item.conflictsWith.includes(item.id)) invalid(`evidence.${item.id}.conflictsWith`, "证据不能与自身冲突。");
  }
  for (const key of KEY_RULE_FACTS) if (!result.facts.some(item => item.key === key)) invalid("facts", `必须明确记录 ${key}，无法确定时使用 unknown。`);
  for (const fact of result.facts) {
    requireEvidence(fact.evidenceIds, `facts.${fact.key}.evidenceIds`);
    if (fact.status === "verified" && (fact.evidenceIds.length === 0 || fact.evidenceIds.some(id => !isVerifiedRuleEvidence(result, id) || evidence.get(id)!.fieldKey !== fact.key))) {
      invalid(`facts.${fact.key}`, "已核验事实必须引用对应字段的官方人工核验证据。");
    }
    if (fact.status === "conflicted" && (fact.evidenceIds.length < 2 || !fact.evidenceIds.some(id => evidence.get(id)!.conflictsWith.some(other => fact.evidenceIds.includes(other))))) {
      invalid(`facts.${fact.key}`, "冲突事实必须提供相互冲突的证据。");
    }
  }
  for (const stage of result.stages) {
    for (const boundary of ["startsAt", "endsAt"] as const) {
      const date = stage[boundary];
      if (date) requireEvidence(date.evidenceIds, `stages.${stage.id}.${boundary}.evidenceIds`);
    }
    if (stage.startsAt?.utc && stage.endsAt?.utc && Date.parse(stage.startsAt.utc) > Date.parse(stage.endsAt.utc)) invalid(`stages.${stage.id}`, "阶段开始不能晚于结束。");
    if (stage.startsAt && stage.endsAt && stage.startsAt.timeZone === stage.endsAt.timeZone) {
      const startDate = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(stage.startsAt.rawText)?.[1];
      const endDate = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(stage.endsAt.rawText)?.[1];
      if (startDate && endDate && startDate > endDate) invalid(`stages.${stage.id}`, "原文中的阶段日期反序，不能保存。");
    }
  }
  for (const item of result.requirements) {
    requireEvidence(item.evidenceIds, `requirements.${item.id}.evidenceIds`);
    if (item.stageId !== null && !stages.has(item.stageId)) invalid(`requirements.${item.id}.stageId`, "引用的阶段不存在。");
  }
  if (value.officialTracks !== undefined) result.officialTracks = validateOfficialTrackCatalog(value.officialTracks, result, isVerifiedRuleEvidence);
  return result;
}

export function assertPublishable(input: EventRuleVersion): void {
  const version = validateRuleVersion(input);
  const fail = (message: string): never => { throw new DomainError("RULES_NOT_PUBLISHABLE", message, { recoveryAction: "人工核对关键规则与时间，并明确标记未知、冲突和来源状态。" }); };
  const requireVerified = (ids: string[], label: string) => {
    if (ids.length === 0 || ids.some(id => !isVerifiedRuleEvidence(version, id))) fail(`${label}缺少可用的官方人工核验证据。`);
  };
  let missing = version.metadata.organizer === "" || version.metadata.officialUrl === "" || version.metadata.format === "unknown" || version.stages.length === 0 || version.requirements.length === 0;
  // Historical publications remain valid; new explicit unknown/conflict states retain quality flags.
  if (version.officialTracks?.status === "unknown") missing = true;
  for (const fact of version.facts) if (["unknown", "unverified"].includes(fact.status)) missing = true;
  for (const stage of version.stages) {
    if (!stage.endsAt?.utc) missing = true;
    for (const date of [stage.startsAt, stage.endsAt]) {
      if (!date) continue;
      if (date.utc === null) { missing = true; continue; }
      requireVerified(date.evidenceIds, `阶段“${stage.name}”的时间`);
      if (!date.evidenceIds.some(id => version.evidence.find(item => item.id === id)!.rawDateText === date.rawText)) fail(`阶段“${stage.name}”的时间没有对应原始日期文本。`);
    }
  }
  for (const requirement of version.requirements) {
    if (requirement.necessity === "unknown") missing = true;
    else requireVerified(requirement.evidenceIds, `提交要求“${requirement.label}”`);
  }
  const needs: QualityFlag[] = [];
  if (missing) needs.push("missing_information");
  if (version.officialTracks?.status === "conflict" || version.facts.some(item => item.status === "conflicted") || version.evidence.some(item => item.conflictsWith.length > 0)) needs.push("needs_recheck");
  if (version.sources.some(item => item.status === "stale")) needs.push("source_stale");
  if (version.sources.some(item => item.status === "failed")) needs.push("source_failed");
  for (const flag of needs) if (!version.qualityFlags.includes(flag)) fail(`公开版本必须显式标记 ${flag}。`);
}

const pointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => canonical(item)).sort());
  if (value && typeof value === "object") return JSON.stringify(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return JSON.stringify(value) ?? "undefined";
}
/** Bookkeeping versions/timestamps are omitted; edits to snapshot content are preserved. */
export function diffRuleVersions(beforeInput: EventRuleVersion, afterInput: EventRuleVersion): RuleChange[] {
  const before = validateRuleVersion(beforeInput), after = validateRuleVersion(afterInput);
  if (before.eventId !== after.eventId) throw new DomainError("EVENT_MISMATCH", "只能比较同一赛事的规则版本。");
  const changes: RuleChange[] = [];
  const visit = (path: string, old: unknown, next: unknown) => {
    if (canonical(old) === canonical(next)) return;
    if (old && next && typeof old === "object" && typeof next === "object" && !Array.isArray(old) && !Array.isArray(next)) {
      const left = old as Record<string, unknown>, right = next as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (key === "version" || key === "eventId") continue;
        visit(`${path}/${pointer(key)}`, left[key] ?? null, right[key] ?? null);
      }
    } else changes.push({ path, before: old ?? null, after: next ?? null });
  };
  visit("/metadata", before.metadata, after.metadata);
  visit("/qualityFlags", before.qualityFlags, after.qualityFlags);
  visit("/officialTracks", getOfficialTrackCatalog(before), getOfficialTrackCatalog(after));
  for (const name of ["sources", "evidence", "facts", "stages", "requirements"] as const) {
    const key = name === "facts" ? "key" : "id";
    const old = new Map(before[name].map(item => [(item as unknown as Record<string, string>)[key]!, item] as const));
    const next = new Map(after[name].map(item => [(item as unknown as Record<string, string>)[key]!, item] as const));
    for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) visit(`/${name}/${pointer(id)}`, old.get(id) ?? null, next.get(id) ?? null);
  }
  return changes;
}

function verifiedInstant(version: EventRuleVersion, date: RuleMoment | null): number | null {
  if (!date?.utc || date.dateOnly || !date.timeZone || date.evidenceIds.length === 0 || date.evidenceIds.some(id => !isVerifiedRuleEvidence(version, id)) ||
      !date.evidenceIds.some(id => version.evidence.find(item => item.id === id)?.rawDateText === date.rawText)) return null;
  return Date.parse(date.utc);
}
export function deriveEventPhase(input: EventRuleVersion, now: Date): EventPhase {
  const version = validateRuleVersion(input);
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new DomainError("INVALID_CLOCK", "当前时间无效。");
  const stages = version.stages.map(stage => ({ type: stage.stageType, start: verifiedInstant(version, stage.startsAt), end: verifiedInstant(version, stage.endsAt) }));
  const currentStage = (type: EventStage["stageType"]) => stages.some(item => item.type === type && item.start !== null && item.end !== null && current >= item.start && current < item.end);
  if (currentStage("development") || currentStage("pitch")) return "active";
  if (currentStage("registration")) return "registration";
  if (stages.some(item => item.type === "submission" && item.end !== null && current < item.end && (item.start === null || current >= item.start))) return "awaiting_submission";
  if (stages.length > 0 && stages.every(item => item.end !== null && current >= item.end)) return "ended";
  return "unknown";
}

export function formatRuleMoment(input: RuleMoment, userTimeZone: string): { original: string; local: string | null; precise: boolean } {
  const date = moment(input, "moment")!;
  const userZone = zone(userTimeZone, "userTimeZone");
  const original = `${date.rawText}${date.timeZone ? `（${date.timeZone}）` : "（时区未注明）"}${date.dateOnly ? " · 仅日期" : ""}`;
  if (!date.utc || date.dateOnly || !date.timeZone) return { original, local: null, precise: false };
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone: userZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(date.utc));
  return { original, local: `${local}（${userZone}）`, precise: true };
}
