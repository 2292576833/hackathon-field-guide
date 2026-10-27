import type { DatabasePort } from "../shared/persistence.ts";

export type AiExecutionKind = "m03_analysis" | "m04_scoring" | "m04_role_help" | "assignment_suggestion" | "m05_planning" | "m07_retrospective";
export interface AiExecutionMetadata {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  errorCode: string | null;
  sourceRevision: number;
  updatedAt: string;
}
const kinds: readonly string[] = ["m03_analysis", "m04_scoring", "m04_role_help", "assignment_suggestion", "m05_planning", "m07_retrospective"];
const statuses: readonly string[] = ["queued", "running", "succeeded", "failed", "cancelled", "unknown"];
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

/**
 * Call only AFTER an authorized module's single-job GET handler has succeeded.
 * This is a response decorator, not an authorization check or an independent
 * job lookup. In particular, never use it to serve an arbitrary client-supplied
 * ID or wrap lists, mutations or error responses.
 *
 * Coordinator rejection can leave a domain job queued. That state is preserved;
 * execution describes its separate durable coordinator result. A new queued
 * revision is never polluted by an earlier execution rejected before dispatch.
 */
export async function attachAiExecutionStatus(database: DatabasePort, kind: AiExecutionKind, response: Response): Promise<Response> {
  if (!response.ok || response.bodyUsed || !kinds.includes(kind) || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return response;
  let envelope: Record<string, unknown> | null;
  try { envelope = object(await response.clone().json()); }
  catch { return response; }
  if (!envelope || Object.hasOwn(envelope, "error")) return response;
  const data = object(envelope.data);
  if (!data || typeof data.id !== "string" || !data.id.trim() || data.id.length > 200 || /[\u0000-\u001f]/.test(data.id) || !revision(data.revision)) return response;

  const result = await database.query<{
    status: string; error_code: string | null; source_revision: number; updated_at: string | Date;
  }>(`SELECT status,error_code,source_revision,updated_at FROM ai_execution_jobs
    WHERE kind=$1 AND module_job_id=$2 AND source_revision${data.status === "queued" ? "=" : "<="}$3
    ORDER BY source_revision DESC,updated_at DESC,id DESC LIMIT 1`, [kind, data.id, data.revision]);
  const row = result.rows[0];
  if (!row || !statuses.includes(row.status) || !revision(row.source_revision)) return response;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  if (!Number.isFinite(updatedAt.getTime())) return response;
  const execution: AiExecutionMetadata = {
    status: row.status as AiExecutionMetadata["status"],
    errorCode: row.error_code === null ? null : /^[A-Z][A-Z0-9_]{0,63}$/.test(row.error_code) ? row.error_code : "AI_EXECUTION_FAILED",
    sourceRevision: row.source_revision,
    updatedAt: updatedAt.toISOString(),
  };
  const headers = new Headers(response.headers);
  // The serialized body changed; an original length cannot describe this response.
  headers.delete("content-length");
  headers.delete("etag");
  return Response.json({ ...envelope, data: { ...data, execution } }, { status: response.status, statusText: response.statusText, headers });
}
