import type { Actor, Clock } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";

export type ParticipantProfileUpdate = Omit<ParticipantProfile, "userId" | "revision" | "updatedAt"> & {
  expectedRevision: number;
};

export interface ParticipantService {
  get(actor: Actor, guard?: FreshSessionGuard): Promise<ParticipantProfile>;
  /** Full replacement of editable fields; owner, revision and timestamp are server-owned. */
  update(actor: Actor, input: ParticipantProfileUpdate, guard?: FreshSessionGuard): Promise<ParticipantProfile>;
}

export interface ParticipantServiceDependencies {
  database: DatabasePort;
  clock: Clock;
}

const fields = ["expectedRevision", "firstHackathon", "developmentExperience", "city", "skills", "interests", "projectIdea", "availableHoursPerDay", "travelPreference", "presentationExperience"] as const;
const development = ["none", "beginner", "project", "experienced"] as const;
const travel = ["undecided", "rail", "flight", "local"] as const;
const presentation = ["none", "some", "confident"] as const;
const maximumRevision = 2_147_483_646;

function invalid(message: string): never {
  throw new DomainError("PARTICIPANT_PROFILE_INVALID", message, { status: 422, recoveryAction: "check_profile_fields" });
}

function text(value: unknown, label: string, maximum: number, multiline = false): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || /\p{Surrogate}/u.test(value) || (!multiline && /[\r\n\t]/.test(value))) {
    invalid(`${label}格式无效，最多填写 ${maximum} 个字符。`);
  }
  return value.trim();
}

function tags(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 30) invalid(`${label}最多填写 30 项。`);
  const result = Array.from(value, item => text(item, label, 80));
  if (result.some(item => item.length === 0) || new Set(result).size !== result.length) {
    invalid(`${label}不能包含空项或重复项。`);
  }
  return result;
}

function choice<T extends string>(value: unknown, values: readonly T[], label: string, nullable: boolean): T | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !values.includes(value as T)) invalid(`请选择有效的${label}。`);
  return value as T;
}

/** Shared runtime boundary for HTTP and direct service calls; never trusts a TS assertion. */
export function validateParticipantProfileUpdate(value: unknown): ParticipantProfileUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) {
    invalid("画像需要为仅包含支持字段的对象，请重新填写。");
  }
  const input = value as Record<string, unknown>;
  if (fields.some(field => !Object.hasOwn(input, field))) invalid("请提交完整画像和当前资料版本。");
  if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0 || input.expectedRevision > maximumRevision) invalid("当前资料版本无效，请重新读取画像。");
  if (input.firstHackathon !== null && typeof input.firstHackathon !== "boolean") invalid("请选择是否首次参加黑客松。");
  if (input.availableHoursPerDay !== null && (typeof input.availableHoursPerDay !== "number"
    || !Number.isFinite(input.availableHoursPerDay) || input.availableHoursPerDay < 0 || input.availableHoursPerDay > 24)) {
    invalid("每天可投入时间需要为 0 到 24 小时，或暂不填写。");
  }
  return {
    expectedRevision: input.expectedRevision,
    firstHackathon: input.firstHackathon as boolean | null,
    developmentExperience: choice(input.developmentExperience, development, "开发经验", true),
    city: text(input.city, "所在城市", 80),
    skills: tags(input.skills, "技能"),
    interests: tags(input.interests, "兴趣"),
    projectIdea: text(input.projectIdea, "项目想法", 4000, true),
    availableHoursPerDay: input.availableHoursPerDay as number | null,
    travelPreference: choice(input.travelPreference, travel, "出行偏好", false)!,
    presentationExperience: choice(input.presentationExperience, presentation, "演讲经验", true),
  };
}

function emptyProfile(userId: string): ParticipantProfile {
  return {
    userId, revision: 0, firstHackathon: null, developmentExperience: null, city: "",
    skills: [], interests: [], projectIdea: "", availableHoursPerDay: null,
    travelPreference: "undecided", presentationExperience: null, updatedAt: null,
  };
}

interface ProfileRow {
  user_id: string; revision: number; first_hackathon: boolean | null;
  development_experience: ParticipantProfile["developmentExperience"]; city: string;
  skills: string[]; interests: string[]; project_idea: string;
  available_hours_per_day: number | string | null;
  travel_preference: ParticipantProfile["travelPreference"];
  presentation_experience: ParticipantProfile["presentationExperience"];
  updated_at: Date | string;
}

function profile(row: ProfileRow): ParticipantProfile {
  return {
    userId: row.user_id, revision: row.revision, firstHackathon: row.first_hackathon,
    developmentExperience: row.development_experience, city: row.city,
    skills: [...row.skills], interests: [...row.interests], projectIdea: row.project_idea,
    availableHoursPerDay: row.available_hours_per_day === null ? null : Number(row.available_hours_per_day),
    travelPreference: row.travel_preference, presentationExperience: row.presentation_experience,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function unauthenticated(): never {
  throw new DomainError("UNAUTHENTICATED", "请重新登录后读取或保存个人画像。", { status: 401, recoveryAction: "login" });
}

/** Persistent personal data only; this service never invokes a model or reads another profile. */
export function createParticipantService({ database, clock }: ParticipantServiceDependencies): ParticipantService {
  async function authorize(sql: SqlExecutor, actor: Actor, guard?: FreshSessionGuard): Promise<void> {
    if (!actor || typeof actor.userId !== "string" || actor.userId.length === 0 || actor.userId.length > 256
      || /[\u0000-\u001f\u007f]/.test(actor.userId)) unauthenticated();
    // Identity precedes session locks, consistent with the coordinating server.
    // FOR SHARE keeps suspension/deletion from racing the final transaction commit.
    const account = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (account.rowCount === 0) unauthenticated();
    await guard?.(sql);
  }

  async function conflict(sql: SqlExecutor, actor: Actor, guard?: FreshSessionGuard): Promise<never> {
    const current = await sql.query<{ revision: number }>("SELECT revision FROM participant_profiles WHERE user_id=$1", [actor.userId]);
    // A failed CAS can wait for another transaction. Recheck the request before
    // revealing even the caller's latest revision in the conflict envelope.
    await authorize(sql, actor, guard);
    throw new DomainError("PARTICIPANT_PROFILE_CHANGED", "个人画像已经更新，请读取最新内容后再保存。", {
      status: 409, recoveryAction: "reload_profile", latestRevision: current.rows[0]?.revision ?? 0,
    });
  }

  return {
    async get(actor, guard) {
      return database.transaction(async sql => {
        await authorize(sql, actor, guard);
        // A surrounding adoption transaction retains this lock through artifact
        // persistence, preventing a concurrent edit after the revision check.
        const result = await sql.query<ProfileRow>("SELECT * FROM participant_profiles WHERE user_id=$1 FOR SHARE", [actor.userId]);
        await authorize(sql, actor, guard);
        return result.rows[0] ? profile(result.rows[0]) : emptyProfile(actor.userId);
      });
    },
    async update(actor, value, guard) {
      const input = validateParticipantProfileUpdate(value);
      return database.transaction(async sql => {
        await authorize(sql, actor, guard);
        const at = clock.now().toISOString();
        const values = [actor.userId, input.firstHackathon, input.developmentExperience, input.city,
          input.skills, input.interests, input.projectIdea, input.availableHoursPerDay,
          input.travelPreference, input.presentationExperience, at];
        // Absent rows are revision 0. ON CONFLICT and revision-conditioned UPDATE
        // protect both first-save races and later edits without creating a row on GET.
        const result = input.expectedRevision === 0
          ? await sql.query<ProfileRow>(`INSERT INTO participant_profiles
            (user_id,first_hackathon,development_experience,city,skills,interests,project_idea,available_hours_per_day,travel_preference,presentation_experience,updated_at,revision)
            VALUES($1,$2,$3,$4,$5::text[],$6::text[],$7,$8,$9,$10,$11::timestamptz,1)
            ON CONFLICT(user_id) DO NOTHING RETURNING *`, values)
          : await sql.query<ProfileRow>(`UPDATE participant_profiles SET
            first_hackathon=$2,development_experience=$3,city=$4,skills=$5::text[],interests=$6::text[],project_idea=$7,
            available_hours_per_day=$8,travel_preference=$9,presentation_experience=$10,updated_at=$11::timestamptz,revision=revision+1
            WHERE user_id=$1 AND revision=$12 RETURNING *`, [...values, input.expectedRevision]);
        if (!result.rows[0]) return conflict(sql, actor, guard);
        await authorize(sql, actor, guard);
        return profile(result.rows[0]);
      });
    },
  };
}
