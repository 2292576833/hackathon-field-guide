import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { InstallationPlan, InstallationReceipt, Skill, TrackBundle } from "./domain.ts";
import type { SkillsRepository, SkillsTransaction, PlanRecord } from "./ports.ts";
function unit(sql: SqlExecutor): SkillsTransaction {
  return {
    async getSkill(id, lock = false) { return (await sql.query<{ document: Skill }>(`SELECT document FROM skill_catalog WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0]?.document ?? null; },
    async putSkill(value, onlyIfAbsent = false) { await sql.query(`INSERT INTO skill_catalog(id,document) VALUES($1,$2::jsonb) ON CONFLICT(id) ${onlyIfAbsent ? "DO NOTHING" : "DO UPDATE SET document=EXCLUDED.document"}`, [value.id, JSON.stringify(value)]); },
    async getBundle(id, lock = false) { return (await sql.query<{ document: TrackBundle }>(`SELECT document FROM skill_bundles WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0]?.document ?? null; },
    async putBundle(value, onlyIfAbsent = false) { await sql.query(`INSERT INTO skill_bundles(id,document) VALUES($1,$2::jsonb) ON CONFLICT(id) ${onlyIfAbsent ? "DO NOTHING" : "DO UPDATE SET document=EXCLUDED.document"}`, [value.id, JSON.stringify(value)]); },
    async getPlan(id, lock = false) { const row = (await sql.query<{ document: InstallationPlan; bridge_token_hash: string | null }>(`SELECT document,bridge_token_hash FROM skill_installation_plans WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0]; return row ? { plan: row.document, bridgeTokenHash: row.bridge_token_hash } : null; },
    async insertPlan(value) { await sql.query("INSERT INTO skill_installation_plans(id,user_id,revision,document,bridge_token_hash) VALUES($1,$2,$3,$4::jsonb,$5)", [value.plan.planId, value.plan.userId, value.plan.revision, JSON.stringify(value.plan), value.bridgeTokenHash]); },
    async savePlan(value, revision) { const result = await sql.query("UPDATE skill_installation_plans SET revision=$2,document=$3::jsonb,bridge_token_hash=$4 WHERE id=$1 AND revision=$5", [value.plan.planId, value.plan.revision, JSON.stringify(value.plan), value.bridgeTokenHash, revision]); if (!result.rowCount) throw new DomainError("VERSION_CONFLICT", "安装计划已变化，请刷新。", { status: 409 }); },
    async getReceipt(id) { return (await sql.query<{ document: InstallationReceipt }>("SELECT document FROM skill_installation_receipts WHERE id=$1", [id])).rows[0]?.document ?? null; },
    async putReceipt(value, userId) { await sql.query("INSERT INTO skill_installation_receipts(id,plan_id,user_id,document) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document WHERE skill_installation_receipts.plan_id=EXCLUDED.plan_id AND skill_installation_receipts.user_id=EXCLUDED.user_id", [value.id, value.planId, userId, JSON.stringify(value)]); },
    async appendAudit(value) { await sql.query("INSERT INTO skill_audit(id,actor_id,action,target_id,occurred_at,reason) VALUES($1,$2,$3,$4,$5::timestamptz,$6)", [value.id, value.actorId, value.action, value.targetId, value.at, value.reason]); },
  };
}
export function createPostgresSkillsRepository(database: DatabasePort): SkillsRepository {
  return {
    transaction: work => database.transaction(tx => work(unit(tx))),
    async listSkills() { return (await database.query<{ document: Skill }>("SELECT document FROM skill_catalog ORDER BY id")).rows.map(row => row.document); },
    async listBundles() { return (await database.query<{ document: TrackBundle }>("SELECT document FROM skill_bundles ORDER BY id")).rows.map(row => row.document); },
    async listPlans(userId) { return (await database.query<{ document: InstallationPlan }>("SELECT document FROM skill_installation_plans WHERE user_id=$1 ORDER BY document->>'createdAt' DESC LIMIT 100", [userId])).rows.map(row => row.document); },
    async listReceipts(userId) { return (await database.query<{ document: InstallationReceipt }>("SELECT document FROM skill_installation_receipts WHERE user_id=$1 ORDER BY document->>'createdAt' DESC LIMIT 100", [userId])).rows.map(row => row.document); },
  };
}
