import type { SqlExecutor } from "../../shared/persistence.ts";
import type { OnboardingState } from "./model.ts";

interface OnboardingRow {
  version: string;
  step_index: number;
  completed_at: string | Date | null;
  revision: number;
}

function fromRow(row: OnboardingRow): OnboardingState {
  return {
    version: row.version,
    stepIndex: row.step_index,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    revision: row.revision,
  };
}

export async function readOnboarding(sql: SqlExecutor, userId: string): Promise<OnboardingState | null> {
  const result = await sql.query<OnboardingRow>(
    "SELECT version, step_index, completed_at, revision FROM user_onboarding WHERE user_id=$1",
    [userId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function insertOnboarding(sql: SqlExecutor, userId: string, state: OnboardingState, now: string): Promise<OnboardingState | null> {
  const result = await sql.query<OnboardingRow>(
    "INSERT INTO user_onboarding (user_id, version, step_index, completed_at, revision, updated_at) VALUES ($1,$2,$3,$4,1,$5) ON CONFLICT (user_id) DO NOTHING RETURNING version, step_index, completed_at, revision",
    [userId, state.version, state.stepIndex, state.completedAt, now],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function updateOnboarding(sql: SqlExecutor, userId: string, expectedRevision: number, state: OnboardingState, now: string): Promise<OnboardingState | null> {
  const result = await sql.query<OnboardingRow>(
    "UPDATE user_onboarding SET step_index=$3, completed_at=$4, revision=revision+1, updated_at=$5 WHERE user_id=$1 AND revision=$2 AND completed_at IS NULL AND version=$6 RETURNING version, step_index, completed_at, revision",
    [userId, expectedRevision, state.stepIndex, state.completedAt, now, state.version],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}
