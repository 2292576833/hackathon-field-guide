import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PILOT_QUESTION_SET, PILOT_RUBRIC, validateQuestionCatalog } from "./catalog.ts";
import type { QuestionSet, RubricVersion } from "./types.ts";
import { invalid, keys, object, revision, string } from "./validation.ts";

export interface CatalogReviewMetadata {
  readonly revision: number;
  readonly contentFingerprint: string;
  readonly seededBy: string;
  readonly seededAt: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
  readonly publishedBy: string | null;
  readonly publishedAt: string | null;
  readonly publicationNote: string | null;
  readonly retiredBy: string | null;
  readonly retiredAt: string | null;
  readonly retirementNote: string | null;
}
export interface CatalogAuditEntry {
  readonly eventId: string;
  readonly questionSetId: string;
  readonly revision: number;
  readonly action: "seeded" | "reviewed" | "published" | "retired";
  readonly actorId: string;
  readonly previousStatus: QuestionSet["status"] | null;
  readonly nextStatus: QuestionSet["status"];
  readonly occurredAt: string;
  readonly note: string;
  readonly contentFingerprint: string;
}
export interface CatalogReviewDetails {
  readonly questionSet: QuestionSet;
  readonly rubric: RubricVersion;
  readonly review: CatalogReviewMetadata;
  readonly audit: readonly CatalogAuditEntry[];
}
export interface AssessmentCatalogAdministrationOptions {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
interface ReviewRow {
  readonly revision: number; readonly content_fingerprint: string; readonly seeded_by: string; readonly seeded_at: string | Date;
  readonly reviewed_by: string | null; readonly reviewed_at: string | Date | null; readonly review_note: string | null;
  readonly published_by: string | null; readonly published_at: string | Date | null; readonly publication_note: string | null;
  readonly retired_by: string | null; readonly retired_at: string | Date | null; readonly retirement_note: string | null;
}
interface CatalogRow { readonly data: unknown; readonly status: QuestionSet["status"]; readonly rubric_data: unknown }
interface AuditRow {
  readonly event_id: string; readonly question_set_id: string; readonly revision: number; readonly action: CatalogAuditEntry["action"];
  readonly actor_id: string; readonly previous_status: QuestionSet["status"] | null; readonly next_status: QuestionSet["status"];
  readonly occurred_at: string | Date; readonly note: string; readonly content_fingerprint: string;
}
function authenticated(actor: Actor): void {
  if (!actor?.userId?.trim()) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
}
function reviewer(actor: Actor): void {
  authenticated(actor);
  if (!actor.platformRoles.some((role) => role === "reviewer" || role === "admin")) throw new DomainError("FORBIDDEN", "需要平台题库审核权限。", { status: 403 });
}
function decode<T>(data: unknown): T {
  try {
    const parsed: unknown = typeof data === "string" ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid catalog data");
    return parsed as T;
  } catch { throw new DomainError("PERSISTENCE_INVALID_DATA", "题库数据暂时无法读取。", { status: 500 }); }
}
function instant(value: string | Date | null): string | null { return value === null ? null : new Date(value).toISOString(); }
function metadata(row: ReviewRow): CatalogReviewMetadata {
  return {
    revision: row.revision, contentFingerprint: row.content_fingerprint, seededBy: row.seeded_by, seededAt: instant(row.seeded_at)!,
    reviewedBy: row.reviewed_by, reviewedAt: instant(row.reviewed_at), reviewNote: row.review_note,
    publishedBy: row.published_by, publishedAt: instant(row.published_at), publicationNote: row.publication_note,
    retiredBy: row.retired_by, retiredAt: instant(row.retired_at), retirementNote: row.retirement_note,
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function fingerprint(set: QuestionSet, rubric: RubricVersion): string {
  return createHash("sha256").update(JSON.stringify(canonical({ questionSet: { ...set, status: "draft" }, rubric }))).digest("hex");
}

/** Uses trusted verified Actors and real parameterized PostgreSQL transactions. */
export class AssessmentCatalogAdministration {
  private readonly options: AssessmentCatalogAdministrationOptions;
  constructor(options: AssessmentCatalogAdministrationOptions) { this.options = options; }
  private now(): string { return this.options.clock.now().toISOString(); }

  private async details(sql: SqlExecutor, questionSetId: string, lock = false): Promise<CatalogReviewDetails> {
    const result = await sql.query<CatalogRow & ReviewRow>(`
      SELECT q.data, q.status, r.data AS rubric_data, m.*
      FROM assessments_question_sets q JOIN assessments_rubrics r ON r.id = q.rubric_version_id
      JOIN assessments_catalog_reviews m ON m.question_set_id = q.id WHERE q.id = $1
      ${lock ? "FOR UPDATE OF q, m" : ""}`, [questionSetId]);
    const row = result.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "未找到带审核记录的题组。", { status: 404 });
    const questionSet = { ...decode<QuestionSet>(row.data), status: row.status };
    const rubric = decode<RubricVersion>(row.rubric_data);
    validateQuestionCatalog(questionSet, rubric);
    const audit = await sql.query<AuditRow>("SELECT * FROM assessments_catalog_audit WHERE question_set_id = $1 ORDER BY revision", [questionSetId]);
    return { questionSet, rubric, review: metadata(row), audit: audit.rows.map((entry) => ({
      eventId: entry.event_id, questionSetId: entry.question_set_id, revision: entry.revision, action: entry.action,
      actorId: entry.actor_id, previousStatus: entry.previous_status, nextStatus: entry.next_status,
      occurredAt: instant(entry.occurred_at)!, note: entry.note, contentFingerprint: entry.content_fingerprint,
    })) };
  }
  private audit(sql: SqlExecutor, actor: Actor, questionSetId: string, version: number, action: CatalogAuditEntry["action"], previous: QuestionSet["status"] | null, next: QuestionSet["status"], note: string, contentFingerprint: string, now: string) {
    return sql.query(`INSERT INTO assessments_catalog_audit
      (event_id, question_set_id, revision, action, actor_id, previous_status, next_status, occurred_at, note, content_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [this.options.ids.next(), questionSetId, version, action, actor.userId, previous, next, now, note, contentFingerprint]);
  }

  /** Import/adopt a draft only. Matching reruns do not reset status, revision or prior actors. */
  async seedDraft(actor: Actor, input: { readonly questionSet: QuestionSet; readonly rubric: RubricVersion } = { questionSet: PILOT_QUESTION_SET, rubric: PILOT_RUBRIC }): Promise<CatalogReviewDetails & { readonly created: boolean }> {
    reviewer(actor);
    const data = object(input, "题库草案"); keys(data, ["questionSet", "rubric"], "题库草案");
    const providedSet = data.questionSet as QuestionSet; const providedRubric = data.rubric as RubricVersion;
    validateQuestionCatalog(providedSet, providedRubric);
    const questionSet = structuredClone(providedSet); const rubric = structuredClone(providedRubric);
    if (questionSet.status !== "draft") throw new DomainError("CATALOG_DRAFT_REQUIRED", "新导入题组必须保持草案，审核与发布需要分别确认。");
    // Capture a detached validated body before awaiting the database.
    const setJson = JSON.stringify(questionSet); const rubricJson = JSON.stringify(rubric);
    const hash = fingerprint(questionSet, rubric);
    return this.options.database.transaction(async (sql) => {
      await sql.query("INSERT INTO assessments_rubrics(id, version, data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING", [rubric.id, rubric.version, rubricJson]);
      const existingRubric = await sql.query<{ matches: boolean }>("SELECT data = $2::jsonb AS matches FROM assessments_rubrics WHERE id = $1", [rubric.id, rubricJson]);
      if (!existingRubric.rows[0]?.matches) throw new DomainError("CATALOG_ID_CONFLICT", "量规版本 ID 已存在不同内容，请建立新的固定版本。", { status: 409 });
      await sql.query(`INSERT INTO assessments_question_sets(id,version,rubric_version_id,status,data)
        VALUES ($1,$2,$3,'draft',$4::jsonb) ON CONFLICT (id) DO NOTHING`, [questionSet.id, questionSet.version, questionSet.rubricVersionId, setJson]);
      const existingSet = await sql.query<{ status: QuestionSet["status"]; matches: boolean }>("SELECT status, (data - 'status') = ($2::jsonb - 'status') AS matches FROM assessments_question_sets WHERE id = $1 FOR UPDATE", [questionSet.id, setJson]);
      const old = existingSet.rows[0];
      if (!old?.matches) throw new DomainError("CATALOG_ID_CONFLICT", "题组版本 ID 已存在不同内容，请建立新的固定版本。", { status: 409 });
      const prior = await sql.query<{ revision: number }>("SELECT revision FROM assessments_catalog_reviews WHERE question_set_id = $1", [questionSet.id]);
      if (prior.rows[0]) return { ...await this.details(sql, questionSet.id), created: false };
      if (old.status !== "draft") throw new DomainError("CATALOG_REVIEW_METADATA_REQUIRED", "已有非草案题组缺少审核记录，不能通过导入补造审核历史。", { status: 409 });
      const now = this.now();
      await sql.query(`INSERT INTO assessments_catalog_reviews(question_set_id,revision,content_fingerprint,seeded_by,seeded_at)
        VALUES ($1,1,$2,$3,$4)`, [questionSet.id, hash, actor.userId, now]);
      await this.audit(sql, actor, questionSet.id, 1, "seeded", null, "draft", "导入待审核草案；题组与量规尚未通过本次人工审核，未宣称科学校准。", hash, now);
      return { ...await this.details(sql, questionSet.id), created: true };
    });
  }

  async listPublishedQuestionSets(actor: Actor): Promise<readonly QuestionSet[]> {
    authenticated(actor);
    const result = await this.options.database.query<CatalogRow>(`
      SELECT q.data,q.status,r.data AS rubric_data FROM assessments_question_sets q
      JOIN assessments_rubrics r ON r.id=q.rubric_version_id JOIN assessments_catalog_reviews m ON m.question_set_id=q.id
      WHERE q.status='published' AND m.reviewed_at IS NOT NULL AND m.published_at IS NOT NULL
      ORDER BY q.id`);
    return result.rows.map((row) => { const set = { ...decode<QuestionSet>(row.data), status: row.status }; validateQuestionCatalog(set, decode<RubricVersion>(row.rubric_data)); return set; });
  }
  async listReviewQueue(actor: Actor): Promise<readonly { readonly questionSetId: string; readonly status: QuestionSet["status"]; readonly revision: number; readonly difficultyLabel: string; readonly seededAt: string; readonly reviewedAt: string | null }[]> {
    reviewer(actor);
    const result = await this.options.database.query<ReviewRow & { id: string; status: QuestionSet["status"]; data: unknown }>(`
      SELECT q.id,q.status,q.data,m.* FROM assessments_question_sets q JOIN assessments_catalog_reviews m ON m.question_set_id=q.id
      WHERE q.status IN ('draft','reviewed') ORDER BY m.seeded_at,q.id`);
    return result.rows.map((row) => ({ questionSetId: row.id, status: row.status, revision: row.revision, difficultyLabel: decode<QuestionSet>(row.data).difficultyLabel, seededAt: instant(row.seeded_at)!, reviewedAt: instant(row.reviewed_at) }));
  }
  async getCatalogDetails(actor: Actor, questionSetId: string): Promise<CatalogReviewDetails> {
    reviewer(actor); const id = string(questionSetId, "题组 ID", 200);
    return this.options.database.transaction((sql) => this.details(sql, id));
  }
  reviewQuestionSet(actor: Actor, id: string, expectedRevision: number, note: string) { return this.transition(actor, id, expectedRevision, note, "reviewed"); }
  publishQuestionSet(actor: Actor, id: string, expectedRevision: number, note: string) { return this.transition(actor, id, expectedRevision, note, "published"); }
  retireQuestionSet(actor: Actor, id: string, expectedRevision: number, note: string) { return this.transition(actor, id, expectedRevision, note, "retired"); }

  private async transition(actor: Actor, questionSetId: string, expectedRevision: number, inputNote: string, next: "reviewed" | "published" | "retired"): Promise<CatalogReviewDetails> {
    reviewer(actor); const id = string(questionSetId, "题组 ID", 200); const expected = revision(expectedRevision); const note = string(inputNote, "审核/发布说明", 5000);
    return this.options.database.transaction(async (sql) => {
      const current = await this.details(sql, id, true);
      if (current.review.revision !== expected) throw new DomainError("VERSION_CONFLICT", "题组审核状态已更新，请查看最新记录。", { status: 409, latestRevision: current.review.revision, recoveryAction: "review_latest_version" });
      const previous = next === "reviewed" ? "draft" : next === "published" ? "reviewed" : "published";
      if (current.questionSet.status !== previous) throw new DomainError("CATALOG_STATE_CONFLICT", "请按草案、审核、发布、停用的顺序操作。", { status: 409 });
      if (fingerprint(current.questionSet, current.rubric) !== current.review.contentFingerprint) throw new DomainError("CATALOG_CONTENT_CHANGED", "题组或量规内容已与审核依据不同，请建立新版本重新审核。", { status: 409 });
      if (next === "published" && (!current.review.reviewedBy || !current.review.reviewedAt || !current.review.reviewNote)) throw new DomainError("CATALOG_REVIEW_REQUIRED", "题组缺少明确的人工审核记录。", { status: 409 });
      const now = this.now();
      const updated = await sql.query(`UPDATE assessments_question_sets SET status=$2 WHERE id=$1 AND status=$3 RETURNING id`, [id, next, previous]);
      if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "题组状态已经更新。", { status: 409 });
      const columns = next === "reviewed" ? ["reviewed_by", "reviewed_at", "review_note"] : next === "published" ? ["published_by", "published_at", "publication_note"] : ["retired_by", "retired_at", "retirement_note"];
      // Column names are fixed service-owned literals, never request/model data.
      const metadataUpdate = await sql.query(`UPDATE assessments_catalog_reviews SET revision=revision+1, ${columns[0]}=$3,${columns[1]}=$4,${columns[2]}=$5 WHERE question_set_id=$1 AND revision=$2 RETURNING revision`, [id, expected, actor.userId, now, note]);
      if (metadataUpdate.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "题组审核状态已经更新。", { status: 409 });
      await this.audit(sql, actor, id, expected + 1, next, previous, next, note, current.review.contentFingerprint, now);
      return this.details(sql, id);
    });
  }
}
export function createAssessmentCatalogAdministration(options: AssessmentCatalogAdministrationOptions) { return new AssessmentCatalogAdministration(options); }

export interface AssessmentCatalogHttpOptions {
  readonly service: AssessmentCatalogAdministration;
  /** Must resolve a verified server session. Root composition owns Origin/CSRF checks. */
  readonly resolveActor: (request: Request) => Promise<Actor | null>;
  readonly requestIds: IdGenerator;
}
export interface CatalogQuestionSetParams { readonly questionSetId: string }
const MAX_BODY_BYTES = 262144;
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 请求。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) invalid("请求内容不能为空。");
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new DomainError("PAYLOAD_TOO_LARGE", "题库请求内容过大。", { status: 413 }); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "题库请求"); }
  catch (error) { if (error instanceof DomainError) throw error; return invalid("题库请求 JSON 格式不正确。"); }
}
export function createAssessmentCatalogHttpHandlers(options: AssessmentCatalogHttpOptions) {
  const respond = async (request: Request, method: "GET" | "POST", action: (actor: Actor) => Promise<unknown>): Promise<Response> => {
    const requestId = options.requestIds.next();
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "此题库接口不支持该请求方法。", { status: 405 });
      const actor = await options.resolveActor(request); if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      return Response.json({ data: await action(actor), requestId }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } }); }
  };
  const change = (operation: "reviewQuestionSet" | "publishQuestionSet" | "retireQuestionSet") => (request: Request, { questionSetId }: CatalogQuestionSetParams) => respond(request, "POST", async (actor) => {
    reviewer(actor); const data = await body(request); keys(data, ["expectedRevision", "note"], "审核/发布请求");
    return options.service[operation](actor, questionSetId, revision(data.expectedRevision), string(data.note, "审核/发布说明", 5000));
  });
  return {
    listPublished: (request: Request) => respond(request, "GET", (actor) => options.service.listPublishedQuestionSets(actor)),
    reviewQueue: (request: Request) => respond(request, "GET", (actor) => options.service.listReviewQueue(actor)),
    details: (request: Request, { questionSetId }: CatalogQuestionSetParams) => respond(request, "GET", (actor) => options.service.getCatalogDetails(actor, questionSetId)),
    seedDraft: (request: Request) => respond(request, "POST", async (actor) => {
      reviewer(actor); const data = await body(request); keys(data, ["questionSet", "rubric"], "草案导入请求");
      if (Object.keys(data).length === 0) return options.service.seedDraft(actor);
      if (!Object.hasOwn(data, "questionSet") || !Object.hasOwn(data, "rubric")) invalid("草案导入必须同时提供题组和量规。");
      return options.service.seedDraft(actor, data as unknown as { questionSet: QuestionSet; rubric: RubricVersion });
    }),
    review: change("reviewQuestionSet"), publish: change("publishQuestionSet"), retire: change("retireQuestionSet"),
  };
}
