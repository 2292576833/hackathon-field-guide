import { createHash } from "node:crypto";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { AccountDeletionImpactPort, OwnDataExportPort } from "../modules/auth/account-ports.ts";
import type { DeletionImpact, JsonValue, OwnDataBundle, OwnDataRecord } from "../modules/auth/account-types.ts";

type Category = keyof OwnDataBundle["records"];
type CollectedRow = { id: string; data: unknown };
type ProjectRow = { id: string; name: string; goal: string; stage: string };
const MAX_PROJECTS = 500;

function tooLarge(): never {
  throw new DomainError("ACCOUNT_EXPORT_TOO_LARGE", "本人资料超过本次导出的数量或大小上限，未生成不完整下载文件。", { status: 422 });
}
function scopeChanged(): never {
  throw new DomainError("ACCOUNT_EXPORT_SCOPE_INVALID", "团队权限已变化，这份导出包含的项目资料已不可读取，请重新申请导出。", { status: 403 });
}
async function assertActor(actor: Actor, sql: SqlExecutor): Promise<void> {
  const account = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
  if (account.rowCount !== 1) throw new DomainError("AUTH_REQUIRED", "请使用当前有效账号重新登录。", { status: 401 });
}

/** Internal field lists, never SQL fragments from the user. */
function fields(column: string, keys: readonly string[]): string {
  return `jsonb_build_object(${keys.map(key => `'${key}',${column}->'${key}'`).join(",")})`;
}

// The domain projections below are the primary boundary. Also remove accidental
// credential/control keys in nested free-form JSON; never export a raw job,
// installation manifest, authentication row, or provider response.
function privateJson(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new DomainError("ACCOUNT_EXPORT_UNSAFE_DATA", "本人资料的结构无法安全导出。", { status: 422 });
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => privateJson(item, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const compact = key.replace(/[_-]/g, "").toLowerCase();
      if (/^(?:.*(?:tokens?|passwords?|secrets?|credentials?)(?:hash)?|authorization|apikey|privatekey|pepper|verificationcode|otp|codehash|requesthash|inputfingerprint|idempotencykey|leaseowner|leaseuntil|activejobid|activerequestid)$/.test(compact)) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      result[key] = privateJson(item, depth + 1);
    }
    return result;
  }
  throw new DomainError("ACCOUNT_EXPORT_UNSAFE_DATA", "本人资料包含无法安全导出的字段。", { status: 422 });
}
function recordId(source: string, id: string): string {
  const value = `${source}:${id}`;
  return value.length <= 200 ? value : `${source}:${createHash("sha256").update(id).digest("hex")}`;
}

/**
 * Root composition port. The database dependency declares its host, but every
 * operation MUST use the caller's executor: M01 already locks user/session and
 * persists the export/deletion receipt in that same transaction.
 */
export function createAccountDataPorts(_dependencies: { readonly database: DatabasePort }): {
  readonly ownData: OwnDataExportPort;
  readonly deletionImpact: AccountDeletionImpactPort;
} {
  async function assertProjectAccess(actor: Actor, projectIds: readonly string[], sql: SqlExecutor): Promise<void> {
    await assertActor(actor, sql);
    if (projectIds.length > MAX_PROJECTS || projectIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) scopeChanged();
    const ids = [...new Set(projectIds)].sort();
    if (!ids.length) return;
    // SHARE on the actual authorization rows serializes leave/removal through
    // commit. Do not acquire M04 heads again after project roots have been held.
    const result = await sql.query<{ project_id: string }>(
      "SELECT m.project_id FROM projects_project_membership m JOIN projects_project p ON p.id=m.project_id WHERE m.user_id=$1 AND m.status='active' AND m.project_id=ANY($2::text[]) ORDER BY m.project_id FOR SHARE OF m",
      [actor.userId, ids],
    );
    if (result.rowCount !== ids.length) scopeChanged();
  }

  async function lockProjectFacts(sql: SqlExecutor, ids: readonly string[]): Promise<void> {
    // Match root planning/M04 -> M02 order. Absent heads remain absent: reading
    // account data must not create a second assignment state.
    for (const id of ids) await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('planning:' || $1,0))", [id]);
    for (const id of ids) await sql.query("SELECT project_id FROM assessments_assignment_heads WHERE project_id=$1 FOR UPDATE", [id]);
    for (const id of ids) await sql.query("SELECT id FROM projects_project WHERE id=$1 FOR UPDATE", [id]);
  }

  const ownData: OwnDataExportPort = {
    assertProjectAccess,
    async collectOwnData(actor, sql, limits) {
      if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 20 * 1024 * 1024) tooLarge();
      await assertActor(actor, sql);
      const initial = await sql.query<{ project_id: string }>("SELECT project_id FROM projects_project_membership WHERE user_id=$1 AND status='active' ORDER BY project_id LIMIT $2", [actor.userId, Math.min(MAX_PROJECTS, limits.maxRecords) + 1]);
      if (initial.rows.length > Math.min(MAX_PROJECTS, limits.maxRecords)) tooLarge();
      const projectIds = initial.rows.map(row => row.project_id);
      await lockProjectFacts(sql, projectIds);
      await assertProjectAccess(actor, projectIds, sql);
      const projectRows = projectIds.length ? (await sql.query<ProjectRow>("SELECT id,name,goal,stage FROM projects_project WHERE id=ANY($1::text[]) ORDER BY id", [projectIds])).rows : [];
      if (projectRows.length !== projectIds.length) scopeChanged();
      const records: Record<Category, OwnDataRecord[]> = { personal: [], conversations: [], generations: [], assessments: [], retrospectives: [], bookmarks: [] };
      // This is an authorized summary, not a raw team-data export. The complete
      // goal (M02 <=4000 characters) plus stage fits M01's 5000-character field.
      const bundle: OwnDataBundle = { records, projects: projectRows.map(row => ({ projectId: row.id, name: row.name, summary: `阶段：${row.stage}\n作品目标：${row.goal}` })) };
      let count = bundle.projects.length;
      let bytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
      if (bytes > limits.maxBytes) tooLarge();
      async function collect(category: Category, source: string, statement: string, parameters: readonly unknown[] = [actor.userId]): Promise<void> {
        const remaining = limits.maxRecords - count;
        const rows = (await sql.query<CollectedRow>(`${statement} LIMIT $${parameters.length + 1}`, [...parameters, remaining + 1])).rows;
        if (rows.length > remaining) tooLarge();
        for (const row of rows) {
          const record = { id: recordId(source, row.id), userId: actor.userId, data: privateJson({ source, ...privateJson(row.data) as Record<string, JsonValue> }) };
          bytes += Buffer.byteLength(JSON.stringify(record), "utf8") + (records[category].length ? 1 : 0);
          if (bytes > limits.maxBytes) tooLarge();
          records[category].push(record); count++;
        }
      }

      await collect("personal", "account_profile", "SELECT id,jsonb_build_object('displayName',display_name,'email',email,'timezone',timezone,'createdAt',created_at) AS data FROM auth_users WHERE id=$1 ORDER BY id");
      await collect("personal", "participant_profile", "SELECT user_id AS id,jsonb_build_object('revision',revision,'firstHackathon',first_hackathon,'developmentExperience',development_experience,'city',city,'skills',skills,'interests',interests,'projectIdea',project_idea,'availableHoursPerDay',available_hours_per_day,'travelPreference',travel_preference,'presentationExperience',presentation_experience,'updatedAt',updated_at) AS data FROM participant_profiles WHERE user_id=$1 ORDER BY user_id");
      await collect("personal", "recruiting_profile", `SELECT user_id AS id,jsonb_build_object('revision',revision,'profile',${fields("data", ["primaryRoles", "supportingRoles", "purposes", "purposeNote", "resume", "workLinks", "mbti", "age"])},'avatarRevision',avatar_revision,'avatarMime',avatar_mime,'avatarBase64',CASE WHEN avatar_bytes IS NULL THEN NULL ELSE encode(avatar_bytes,'base64') END,'updatedAt',updated_at) AS data FROM recruiting_profiles WHERE user_id=$1 ORDER BY user_id`);
      await collect("personal", "recruiting_card", `SELECT id,jsonb_build_object('revision',revision,'status',status,'card',${fields("body", ["id", "headline", "introduction", "primaryRoles", "supportingRoles", "purposes", "purposeNote", "skills", "city", "availableHoursPerDay", "workLinks", "mbti", "age", "publishedAt"])},'avatarMime',avatar_mime,'avatarBase64',CASE WHEN avatar_bytes IS NULL THEN NULL ELSE encode(avatar_bytes,'base64') END,'updatedAt',updated_at) AS data FROM recruiting_cards WHERE user_id=$1 ORDER BY id`);
      await collect("personal", "onboarding", "SELECT user_id AS id,jsonb_build_object('version',version,'stepIndex',step_index,'completedAt',completed_at,'revision',revision,'updatedAt',updated_at) AS data FROM user_onboarding WHERE user_id=$1 ORDER BY user_id");

      await collect("conversations", "navigator_workspace", "SELECT id,jsonb_build_object('createdAt',created_at,'updatedAt',updated_at) AS data FROM personal_dsh_sessions WHERE user_id=$1 ORDER BY id");
      await collect("conversations", "navigator_message", "SELECT m.id::text AS id,jsonb_build_object('sessionId',m.session_id,'projectId',m.project_id,'role',m.role,'content',m.content,'createdAt',m.created_at) AS data FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND (m.project_id IS NULL OR m.project_id=ANY($2::text[])) ORDER BY m.id", [actor.userId, projectIds]);
      await collect("conversations", "space_assistant_conversation", "SELECT project_id AS id,jsonb_build_object('projectId',project_id,'revision',revision,'createdAt',created_at,'updatedAt',updated_at) AS data FROM team_assistant_conversations WHERE user_id=$1 AND project_id=ANY($2::text[]) ORDER BY project_id", [actor.userId, projectIds]);
      await collect("conversations", "space_assistant_message", "SELECT id,jsonb_build_object('projectId',project_id,'role',role,'content',content,'provider',provider,'links',links,'coverage',coverage,'createdAt',created_at) AS data FROM team_assistant_messages WHERE user_id=$1 AND project_id=ANY($2::text[]) ORDER BY sequence", [actor.userId, projectIds]);

      await collect("generations", "personal_ai_artifact", "SELECT a.id,jsonb_build_object('kind',a.kind,'title',a.title,'data',a.data,'createdAt',a.created_at) AS data FROM personal_ai_artifacts a JOIN personal_dsh_sessions s ON s.id=a.session_id AND s.user_id=a.user_id JOIN ai_execution_jobs j ON j.id=a.id AND j.actor_id=a.user_id AND j.status='succeeded' WHERE a.user_id=$1 AND (a.kind NOT IN ('space_assistant_reply','project_feasibility') OR (jsonb_typeof(a.data->'projectId')='string' AND a.data->>'projectId'=ANY($2::text[]))) ORDER BY a.created_at,a.id", [actor.userId, projectIds]);
      await collect("assessments", "assessment_attempt", `SELECT id,${fields("data", ["id", "projectId", "membershipId", "questionSetId", "rubricVersionId", "questionSetSnapshot", "rubricSnapshot", "profile", "answers", "followUps", "sharing", "status", "revision", "latestScoreId", "scoringRuns", "createdAt", "updatedAt", "submittedAt"])} AS data FROM assessments_attempts WHERE user_id=$1 ORDER BY created_at,id`);
      await collect("assessments", "assessment_score", `SELECT s.id,${fields("s.data", ["id", "attemptId", "rubricVersionId", "criterionScores", "limitations", "modelVersion", "promptVersion", "provenance", "status", "supersedesScoreId", "correctionReason", "validatedAt"])} AS data FROM assessments_scores s JOIN assessments_attempts a ON a.id=s.attempt_id WHERE a.user_id=$1 ORDER BY s.validated_at,s.id`);
      await collect("assessments", "role_help", `SELECT id,${fields("data", ["id", "projectId", "membershipId", "status", "revision", "answers", "result", "failureCode", "createdAt", "startedAt", "finishedAt"])} AS data FROM assessments_role_help_jobs WHERE user_id=$1 ORDER BY created_at,id`);

      const documentFields = ["id", "kind", "projectId", "ownerId", "scope", "status", "revision", "content", "generatedDraft", "sourceRetrospective", "sourceCardId", "sourceRevision", "selectedFields", "confirmedAt", "createdAt", "updatedAt", "retrospectiveId", "inputRevision", "result", "failureCode"];
      await collect("retrospectives", "retrospective_document", `SELECT id,${fields("body", documentFields)} AS data FROM m07_documents WHERE owner_id=$1 AND (scope='personal' OR project_id=ANY($2::text[])) ORDER BY created_at,id`, [actor.userId, projectIds]);
      // An old private version remains the author's own words; an old project
      // version additionally needs current project access. Do not rely solely
      // on the current document's visibility after a visibility change.
      await collect("retrospectives", "retrospective_version", `SELECT v.document_id || ':' || v.revision::text AS id,jsonb_build_object('recordedAt',v.recorded_at,'document',${fields("v.body", documentFields)}) AS data FROM m07_document_versions v JOIN m07_documents d ON d.id=v.document_id WHERE d.owner_id=$1 AND v.body->>'ownerId'=$1 AND (v.body->>'scope'='personal' OR (v.body->>'scope'='project' AND d.project_id=ANY($2::text[]))) ORDER BY v.document_id,v.revision`, [actor.userId, projectIds]);
      await collect("retrospectives", "retrospective_edit_draft", "SELECT id,jsonb_build_object('projectId',project_id,'documentId',document_id,'baseDocumentRevision',base_document_revision,'requestedScope',requested_scope,'draftContent',body->'draftContent','revision',revision,'createdAt',created_at,'updatedAt',updated_at) AS data FROM m07_edit_drafts WHERE owner_id=$1 ORDER BY id");
      await collect("bookmarks", "resource_bookmark", "SELECT id,jsonb_build_object('resourceId',resource_id,'purposeNote',purpose_note,'revision',revision,'createdAt',created_at,'updatedAt',updated_at) AS data FROM resource_bookmarks WHERE user_id=$1 ORDER BY created_at,id");

      // M10 manifests and receipts include local paths/bridge data. Only these
      // explicitly selected installation facts are portable account records.
      await collect("personal", "skill_installation_plan", `SELECT id,jsonb_build_object('revision',revision,'installation',${fields("document", ["planId", "agentId", "scope", "bundleId", "bundleVersion", "status", "createdAt", "expiresAt"])},'skillVersionIds',(SELECT COALESCE(jsonb_agg(item->'skillVersionId'),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(document->'items')='array' THEN document->'items' ELSE '[]'::jsonb END) item)) AS data FROM skill_installation_plans WHERE user_id=$1 ORDER BY id`);
      await collect("personal", "skill_installation_receipt", `SELECT r.id,jsonb_build_object('planId',r.plan_id,'installation',${fields("r.document", ["id", "agentId", "status", "fileStatus", "loadStatus", "taskStatus", "evidenceSource", "createdAt"])},'skillVersionIds',(SELECT COALESCE(jsonb_agg(item->'skillVersionId'),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.document->'items')='array' THEN r.document->'items' ELSE '[]'::jsonb END) item)) AS data FROM skill_installation_receipts r JOIN skill_installation_plans p ON p.id=r.plan_id AND p.user_id=r.user_id WHERE r.user_id=$1 ORDER BY r.id`);
      await assertProjectAccess(actor, projectIds, sql);
      if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > limits.maxBytes) tooLarge();
      return bundle;
    },
  };

  const deletionImpact: AccountDeletionImpactPort = {
    async inspectOwnDeletion(actor, sql): Promise<DeletionImpact> {
      await assertActor(actor, sql);
      const initial = await sql.query<{ project_id: string }>("SELECT project_id FROM projects_project_membership WHERE user_id=$1 AND status='active' ORDER BY project_id LIMIT $2", [actor.userId, MAX_PROJECTS + 1]);
      if (initial.rows.length > MAX_PROJECTS) throw new DomainError("ACCOUNT_DELETION_SCOPE_TOO_LARGE", "所属团队数量超过自动核查上限，请联系管理员协助处理。", { status: 422 });
      const ids = initial.rows.map(row => row.project_id);
      await lockProjectFacts(sql, ids);
      const own = ids.length ? (await sql.query<{ project_id: string; role: string }>("SELECT project_id,role FROM projects_project_membership WHERE user_id=$1 AND status='active' AND project_id=ANY($2::text[]) ORDER BY project_id FOR SHARE", [actor.userId, ids])).rows : [];
      const projects = own.length ? (await sql.query<{ id: string; name: string; stage: string }>("SELECT id,name,stage FROM projects_project WHERE id=ANY($1::text[]) ORDER BY id", [own.map(row => row.project_id)])).rows : [];
      const managed = own.filter(row => row.role === "manager").map(row => row.project_id);
      let managers: readonly { project_id: string; user_id: string }[] = [];
      if (managed.length) {
        await sql.query("SELECT membership_id FROM projects_project_membership WHERE project_id=ANY($1::text[]) AND status='active' AND role='manager' ORDER BY project_id,user_id FOR SHARE", [managed]);
        try {
          // M01 has already locked this actor. Never wait on a second actor
          // who could be waiting on our project: NOWAIT makes that a safe retry.
          managers = (await sql.query<{ project_id: string; user_id: string }>("SELECT m.project_id,m.user_id FROM projects_project_membership m JOIN auth_users u ON u.id=m.user_id WHERE m.project_id=ANY($1::text[]) AND m.status='active' AND m.role='manager' AND u.status='active' AND u.email_verified_at IS NOT NULL ORDER BY m.project_id,m.user_id FOR SHARE OF u NOWAIT", [managed])).rows;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "55P03") throw new DomainError("ACCOUNT_DELETION_MANAGER_BUSY", "另一位管理员的账号正在处理，请稍后重新核查团队转交条件。", { status: 409, recoveryAction: "稍后重试，待重新核查完成后再申请处理。" });
          throw error;
        }
      }
      return {
        lastManagerProjects: projects.filter(project => project.stage !== "archived" && managed.includes(project.id) && managers.filter(manager => manager.project_id === project.id).length <= 1)
          .map(project => ({ projectId: project.id, name: project.name, remediationUrl: `/app/projects/${project.id}/team` })),
        notices: [
          "未归档团队的最后一位有效管理员，需要先转交管理员或归档团队，才能处理删除申请。",
          "提交申请不表示资料已经删除；处理时会再次核查团队权限和转交条件。",
          "本人私有资料按删除流程处理；已经共享的团队协作事实及必要审计记录可能依法或按团队记录边界保留。",
          "账号删除申请不会自动删除 GitHub 上的仓库、代码或其他外部服务资料。",
        ],
      };
    },
  };
  return { ownData, deletionImpact };
}
