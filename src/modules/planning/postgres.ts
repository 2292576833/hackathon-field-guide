import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { PlanningRepository, PlanningTransaction } from "./ports.ts";
import type { PlanningState } from "./types.ts";

interface StateRow { project_id: string; revision: number | string; state_json: string }
interface IdempotencyRow { fingerprint: string; result_json: string }

function emptyState(projectId: string): PlanningState {
  return { projectId, currentPlanVersionId: null, tasksRevision: 0, tasks: [], plans: [], progressUpdates: [], revision: 0 };
}

function persistenceError(): DomainError {
  return new DomainError("PLANNING_PERSISTENCE_INVALID", "已保存的计划数据无法读取，请联系项目维护人员。", { status: 500 });
}

function decodeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw persistenceError(); }
}

function encodeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Undefined JSON");
    return json;
  } catch {
    throw new DomainError("PLANNING_SERIALIZATION_INVALID", "计划数据无法保存，请检查输入。", { status: 422 });
  }
}

function decodeState(row: StateRow): PlanningState {
  const value = decodeJson(row.state_json);
  const revision = Number(row.revision);
  if (typeof value !== "object" || value === null || !Number.isSafeInteger(revision) || revision < 0) throw persistenceError();
  const state = value as PlanningState;
  if (state.projectId !== row.project_id || state.revision !== revision || !Array.isArray(state.tasks)
    || !Array.isArray(state.plans) || !Array.isArray(state.progressUpdates)
    || !Number.isSafeInteger(state.tasksRevision) || state.tasksRevision < 0
    || (state.currentPlanVersionId !== null && typeof state.currentPlanVersionId !== "string")) throw persistenceError();
  return state;
}

function idempotencyConflict(): DomainError {
  return new DomainError("IDEMPOTENCY_CONFLICT", "相同操作标识已用于不同内容，请重新发起操作。", { status: 409, recoveryAction: "use_new_idempotency_key" });
}

function checkRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new DomainError("INVALID_REVISION", "计划版本必须是非负整数。", { status: 422 });
  }
}

/** No pool, credentials, table creation, or external effects are owned by this adapter. */
export function createPostgresPlanningRepository(database: DatabasePort): PlanningRepository {
  return {
    async read(projectId) {
      const result = await database.query<StateRow>(
        "SELECT project_id, revision, state_json::text AS state_json FROM planning_states WHERE project_id = $1",
        [projectId],
      );
      return result.rows.length === 0 ? null : decodeState(result.rows[0]!);
    },
    async transaction(projectId, work) {
      return database.transaction(async (executor) => {
        // A row lock alone cannot serialize first-use initialization when no row exists.
        await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`planning:${projectId}`]);
        await executor.query(
          "INSERT INTO planning_states (project_id, revision, state_json) VALUES ($1, 0, $2::jsonb) ON CONFLICT (project_id) DO NOTHING",
          [projectId, encodeJson(emptyState(projectId))],
        );
        const current = await executor.query<StateRow>(
          "SELECT project_id, revision, state_json::text AS state_json FROM planning_states WHERE project_id = $1 FOR UPDATE",
          [projectId],
        );
        if (current.rows.length !== 1) throw persistenceError();
        const state = decodeState(current.rows[0]!);
        let active = true;
        // Protect callers retaining a transaction after the callback has returned.
        const sql: SqlExecutor = {
          query: async (statement, parameters) => {
            if (!active) throw new DomainError("PLANNING_TRANSACTION_CLOSED", "计划操作已结束，请重新发起操作。", { status: 409 });
            return executor.query(statement, parameters);
          },
        };
        const transaction: PlanningTransaction = {
          sql,
          async getIdempotent<T>(scope: string, key: string, fingerprint: string): Promise<T | null> {
            const result = await sql.query<IdempotencyRow>(
              "SELECT fingerprint, result_json::text AS result_json FROM planning_idempotency WHERE project_id = $1 AND scope = $2 AND idempotency_key = $3",
              [projectId, scope, key],
            );
            const previous = result.rows[0];
            if (!previous) return null;
            if (previous.fingerprint !== fingerprint) throw idempotencyConflict();
            return decodeJson(previous.result_json) as T;
          },
          async putIdempotent(scope, key, fingerprint, result) {
            const inserted = await sql.query(
              "INSERT INTO planning_idempotency (project_id, scope, idempotency_key, fingerprint, result_json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (project_id, scope, idempotency_key) DO NOTHING RETURNING idempotency_key",
              [projectId, scope, key, fingerprint, encodeJson(result)],
            );
            if (inserted.rowCount === 0) {
              // Never overwrite the first result, even when a repeated put has the same fingerprint.
              await transaction.getIdempotent(scope, key, fingerprint);
            }
          },
          async save(next, expectedRevision) {
            if (next.projectId !== projectId) {
              throw new DomainError("PROJECT_MISMATCH", "计划不属于本项目。", { status: 422 });
            }
            checkRevision(expectedRevision);
            checkRevision(next.revision);
            if (next.revision !== expectedRevision + 1) {
              throw new DomainError("INVALID_REVISION", "保存计划时必须递增一个版本。", { status: 422 });
            }
            const saved = await sql.query<{ revision: number | string }>(
              "UPDATE planning_states SET revision = $3, state_json = $4::jsonb WHERE project_id = $1 AND revision = $2 RETURNING revision",
              [projectId, expectedRevision, next.revision, encodeJson(next)],
            );
            if (saved.rowCount !== 1) {
              const latest = await sql.query<{ revision: number | string }>(
                "SELECT revision FROM planning_states WHERE project_id = $1", [projectId],
              );
              const latestRevision = Number(latest.rows[0]?.revision);
              throw new DomainError("VERSION_CONFLICT", "队友已更新这份计划，请对照最新版本后再应用。", {
                status: 409, recoveryAction: "review_latest_version",
                ...(Number.isSafeInteger(latestRevision) ? { latestRevision } : {}),
              });
            }
          },
          async emit(event) {
            if (event.projectId !== projectId) {
              throw new DomainError("PROJECT_MISMATCH", "计划事件不属于本项目。", { status: 422 });
            }
            checkRevision(event.revision);
            // A duplicate event ID is an error: do not silently discard another project's event.
            await sql.query(
              "INSERT INTO planning_outbox (event_id, event_type, project_id, aggregate_id, revision, occurred_at, event_json) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)",
              [event.id, event.type, projectId, event.aggregateId, event.revision, event.occurredAt, encodeJson(event)],
            );
          },
        };
        try { return await work(state, transaction); } finally { active = false; }
      });
    },
  };
}
