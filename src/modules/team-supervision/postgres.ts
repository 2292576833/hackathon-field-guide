import type { SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";

export interface SettingsRow { membership_id: string; enabled: boolean; revision: number; hold_request_id: string | null; last_started_at: Date | string | null }
export interface RunRow { request_id: string; facts_fingerprint: string; membership_id: string; status: "running" | "succeeded" | "failed" | "unknown"; started_at: Date | string; expires_at: Date | string; message_id: string | null; response_text: string | null; error_code: string | null }
export async function readClaim(sql: SqlExecutor, userId: string, projectId: string, requestId: string) {
  return (await sql.query<RunRow>("SELECT * FROM team_supervision_runs WHERE user_id=$1 AND project_id=$2 AND request_id=$3",[userId,projectId,requestId])).rows[0]??null;
}
export async function readSettings(sql: SqlExecutor, userId: string, projectId: string, lock = false): Promise<SettingsRow | null> {
  return (await sql.query<SettingsRow>(`SELECT membership_id,enabled,revision,hold_request_id,last_started_at FROM team_supervision_settings WHERE user_id=$1 AND project_id=$2${lock ? " FOR UPDATE" : ""}`, [userId, projectId])).rows[0] ?? null;
}
export async function readLedger(sql: SqlExecutor, userId: string, projectId: string, fingerprint: string, day: string) {
  const row = (await sql.query<{daily_used:number;same_facts:boolean;fact_status:RunRow["status"]|null;pending:RunRow|null;report:RunRow|null}>(`SELECT
    (SELECT count(*)::integer FROM team_supervision_runs WHERE user_id=$1 AND project_id=$2 AND started_at >= $4::timestamptz AND started_at < $4::timestamptz + interval '24 hours') AS daily_used,
    EXISTS(SELECT 1 FROM team_supervision_runs WHERE user_id=$1 AND project_id=$2 AND facts_fingerprint=$3) AS same_facts,
    (SELECT status FROM team_supervision_runs WHERE user_id=$1 AND project_id=$2 AND facts_fingerprint=$3 LIMIT 1) AS fact_status,
    (SELECT row_to_json(r) FROM team_supervision_runs r WHERE user_id=$1 AND project_id=$2 AND status IN ('running','unknown') ORDER BY started_at DESC,request_id DESC LIMIT 1) AS pending,
    (SELECT row_to_json(r) FROM team_supervision_runs r WHERE user_id=$1 AND project_id=$2 AND status='succeeded' AND message_id IS NOT NULL AND response_text IS NOT NULL ORDER BY started_at DESC,request_id DESC LIMIT 1) AS report`, [userId,projectId,fingerprint,`${day}T00:00:00Z`])).rows[0]!;
  return row;
}
export async function saveSettings(sql: SqlExecutor, userId: string, projectId: string, membershipId: string, enabled: boolean, revision: number, now: string) {
  if (revision === 0) return (await sql.query("INSERT INTO team_supervision_settings(user_id,project_id,membership_id,enabled,revision,updated_at) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT DO NOTHING RETURNING revision", [userId, projectId, membershipId, enabled, now])).rowCount === 1;
  return (await sql.query("UPDATE team_supervision_settings SET membership_id=$3,enabled=$4,revision=revision+1,updated_at=$6 WHERE user_id=$1 AND project_id=$2 AND revision=$5 RETURNING revision", [userId, projectId, membershipId, enabled, revision, now])).rowCount === 1;
}
/** Caller must supply a transaction: receipt and cooldown claim commit together. */
export async function claimRun(sql: SqlExecutor, userId: string, projectId: string, membershipId: string, requestId: string, fingerprint: string, now: string, expires: string, expectedRevision: number) {
  const inserted = await sql.query("INSERT INTO team_supervision_runs(user_id,project_id,membership_id,request_id,facts_fingerprint,status,started_at,expires_at) VALUES($1,$2,$3,$4,$5,'running',$6,$7) ON CONFLICT DO NOTHING RETURNING request_id", [userId, projectId, membershipId, requestId, fingerprint, now, expires]);
  if (inserted.rowCount === 0) return false;
  if (inserted.rowCount !== 1) claimConflict();
  const settings = await sql.query(`UPDATE team_supervision_settings SET last_started_at=$3
    WHERE user_id=$1 AND project_id=$2 AND membership_id=$4 AND revision=$5 AND enabled=true AND hold_request_id IS NULL
    AND (last_started_at IS NULL OR last_started_at <= $3::timestamptz - interval '10 minutes') RETURNING revision`, [userId, projectId, now, membershipId, expectedRevision]);
  if (settings.rowCount !== 1) claimConflict();
  return true;
}
export async function hold(sql: SqlExecutor, userId: string, projectId: string, requestId: string) {
  const saved = await sql.query("UPDATE team_supervision_settings SET hold_request_id=COALESCE(hold_request_id,$3) WHERE user_id=$1 AND project_id=$2 RETURNING hold_request_id", [userId, projectId, requestId]);
  if (saved.rowCount !== 1) throw new DomainError("SUPERVISION_HOLD_CONFLICT", "待核查状态未能确认保存，请到空间AI核查。", { status: 409 });
}
/** Settings-first lock order matches claim/settings updates and prevents hold/success races. */
export async function finish(sql: SqlExecutor, userId: string, projectId: string, requestId: string, status: "succeeded" | "failed" | "unknown", now: string, messageId: string | null = null, response: string | null = null, code: string | null = null, expectedRevision?: number) {
  const settings = await readSettings(sql, userId, projectId, true);
  if (!settings || status === "succeeded" && (!settings.enabled || settings.hold_request_id || settings.revision !== expectedRevision)) settlementConflict();
  const saved = await sql.query(`UPDATE team_supervision_runs SET status=$4,finished_at=$5,message_id=$6,response_text=$7,error_code=$8
    WHERE user_id=$1 AND project_id=$2 AND request_id=$3 AND status='running'
    AND ($4 <> 'succeeded' OR (membership_id=$9 AND expires_at > $5::timestamptz)) RETURNING request_id`, [userId, projectId, requestId, status, now, messageId, response, code, settings.membership_id]);
  if (saved.rowCount !== 1) settlementConflict();
  if (status === "unknown") await hold(sql, userId, projectId, requestId);
}
export function instant(value: Date | string): string { return new Date(value).toISOString(); }
function claimConflict(): never { throw new DomainError("SUPERVISION_CLAIM_CONFLICT", "护航设置或检查时间已变化，本次未认领请求。", { status: 409 }); }
function settlementConflict(): never { throw new DomainError("SUPERVISION_SETTLEMENT_CONFLICT", "请求状态已变化，本次未确认结算，请到空间AI核查。", { status: 409 }); }
