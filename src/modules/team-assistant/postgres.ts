import type { SqlExecutor } from "../../shared/persistence.ts";
import type { AssistantMessage, AssistantRequestStatus } from "./model.ts";

export interface AssistantSessionRow {
  userId: string;
  projectId: string;
  revision: number;
  activeRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantRequestRow {
  userId: string;
  projectId: string;
  requestId: string;
  requestHash: string;
  message: string;
  status: AssistantRequestStatus;
  responseId: string | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
}

interface StoredSession {
  user_id: string;
  project_id: string;
  revision: number;
  active_request_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface StoredRequest {
  user_id: string;
  project_id: string;
  request_id: string;
  request_hash: string;
  message: string;
  status: AssistantRequestStatus;
  response_id: string | null;
  error_code: string | null;
  created_at: string | Date;
  expires_at: string | Date;
}

interface StoredMessage {
  id: string;
  role: AssistantMessage["role"];
  content: string;
  created_at: string | Date;
  provider: AssistantMessage["provider"];
  links: AssistantMessage["links"] | string;
  coverage: AssistantMessage["coverage"] | string;
}

const sessionColumns = "user_id, project_id, revision, active_request_id, created_at, updated_at";
const requestColumns = "user_id, project_id, request_id, request_hash, message, status, response_id, error_code, created_at, expires_at";
const messageColumns = "id, role, content, created_at, provider, links, coverage";
function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
function sessionFromRow(row: StoredSession): AssistantSessionRow {
  return {
    userId: row.user_id, projectId: row.project_id, revision: row.revision,
    activeRequestId: row.active_request_id, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}
function requestFromRow(row: StoredRequest): AssistantRequestRow {
  return {
    userId: row.user_id, projectId: row.project_id, requestId: row.request_id,
    requestHash: row.request_hash, message: row.message, status: row.status,
    responseId: row.response_id, errorCode: row.error_code,
    createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at),
  };
}
function messageFromRow(row: StoredMessage): AssistantMessage {
  return {
    id: row.id, role: row.role, content: row.content, createdAt: timestamp(row.created_at), provider: row.provider,
    links: typeof row.links === "string" ? JSON.parse(row.links) as AssistantMessage["links"] : row.links,
    coverage: typeof row.coverage === "string" ? JSON.parse(row.coverage) as AssistantMessage["coverage"] : row.coverage,
  };
}

/** Call inside the coordinator's transaction; its row lock lasts until that transaction ends. */
export async function ensureConversation(sql: SqlExecutor, userId: string, projectId: string, now: string): Promise<AssistantSessionRow> {
  await sql.query(
    "INSERT INTO team_assistant_conversations (user_id, project_id, revision, active_request_id, created_at, updated_at) VALUES ($1,$2,0,NULL,$3,$3) ON CONFLICT (user_id, project_id) DO NOTHING",
    [userId, projectId, now],
  );
  const result = await sql.query<StoredSession>(
    `SELECT ${sessionColumns} FROM team_assistant_conversations WHERE user_id=$1 AND project_id=$2 FOR UPDATE`,
    [userId, projectId],
  );
  if (!result.rows[0]) throw new Error("Team assistant conversation disappeared while obtaining its lock");
  return sessionFromRow(result.rows[0]);
}

/** Reads a bounded recent window without pruning any stored messages. */
export async function readMessages(sql: SqlExecutor, userId: string, projectId: string, limit = 100): Promise<AssistantMessage[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Message limit must be a non-negative safe integer");
  const result = await sql.query<StoredMessage>(
    `SELECT ${messageColumns} FROM (SELECT ${messageColumns}, sequence FROM team_assistant_messages WHERE user_id=$1 AND project_id=$2 ORDER BY sequence DESC LIMIT $3) AS recent ORDER BY sequence ASC`,
    [userId, projectId, limit],
  );
  return result.rows.map(messageFromRow);
}

/** Idempotent replies can be replayed even when the answer is outside the recent history window. */
export async function readMessage(sql: SqlExecutor, userId: string, projectId: string, messageId: string): Promise<AssistantMessage | null> {
  const result = await sql.query<StoredMessage>(
    `SELECT ${messageColumns} FROM team_assistant_messages WHERE user_id=$1 AND project_id=$2 AND id=$3`,
    [userId, projectId, messageId],
  );
  return result.rows[0] ? messageFromRow(result.rows[0]) : null;
}

export async function readRequest(sql: SqlExecutor, userId: string, projectId: string, requestId: string): Promise<AssistantRequestRow | null> {
  const result = await sql.query<StoredRequest>(
    `SELECT ${requestColumns} FROM team_assistant_requests WHERE user_id=$1 AND project_id=$2 AND request_id=$3`,
    [userId, projectId, requestId],
  );
  return result.rows[0] ? requestFromRow(result.rows[0]) : null;
}

export async function readLastRequest(sql: SqlExecutor, userId: string, projectId: string): Promise<AssistantRequestRow | null> {
  const result = await sql.query<StoredRequest>(
    `SELECT ${requestColumns} FROM team_assistant_requests WHERE user_id=$1 AND project_id=$2 ORDER BY sequence DESC LIMIT 1`,
    [userId, projectId],
  );
  return result.rows[0] ? requestFromRow(result.rows[0]) : null;
}

export async function readUncertainRequestByHash(sql: SqlExecutor, userId: string, projectId: string, hash: string): Promise<AssistantRequestRow | null> {
  const result = await sql.query<StoredRequest>(
    `SELECT ${requestColumns} FROM team_assistant_requests WHERE user_id=$1 AND project_id=$2 AND request_hash=$3 AND status IN ('running','unknown') ORDER BY sequence DESC LIMIT 1`,
    [userId, projectId, hash],
  );
  return result.rows[0] ? requestFromRow(result.rows[0]) : null;
}

export async function insertRequest(sql: SqlExecutor, row: AssistantRequestRow): Promise<void> {
  await sql.query(
    `INSERT INTO team_assistant_requests (${requestColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.userId, row.projectId, row.requestId, row.requestHash, row.message, row.status,
      row.responseId, row.errorCode, row.createdAt, row.expiresAt],
  );
}

export async function updateSession(sql: SqlExecutor, userId: string, projectId: string, expectedRevision: number, activeRequestId: string | null, now: string): Promise<AssistantSessionRow | null> {
  const result = await sql.query<StoredSession>(
    `UPDATE team_assistant_conversations SET revision=revision+1, active_request_id=$4, updated_at=$5 WHERE user_id=$1 AND project_id=$2 AND revision=$3 RETURNING ${sessionColumns}`,
    [userId, projectId, expectedRevision, activeRequestId, now],
  );
  return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
}

/** Terminal requests are immutable: an unknown result cannot later become a retriable failure. */
export async function finishRequest(sql: SqlExecutor, userId: string, projectId: string, requestId: string, status: AssistantRequestStatus, responseId: string | null, errorCode: string | null): Promise<boolean> {
  if (status === "running") return false;
  const result = await sql.query<{ request_id: string }>(
    "UPDATE team_assistant_requests SET status=$4, response_id=$5, error_code=$6 WHERE user_id=$1 AND project_id=$2 AND request_id=$3 AND status='running' RETURNING request_id",
    [userId, projectId, requestId, status, responseId, errorCode],
  );
  return result.rows.length === 1;
}

/** Insert the user message before its assistant response in the same transaction. */
export async function insertMessage(sql: SqlExecutor, userId: string, projectId: string, requestId: string, message: AssistantMessage): Promise<void> {
  await sql.query(
    "INSERT INTO team_assistant_messages (user_id, project_id, request_id, id, role, content, created_at, provider, links, coverage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)",
    [userId, projectId, requestId, message.id, message.role, message.content, message.createdAt,
      message.provider, JSON.stringify(message.links), message.coverage === null ? null : JSON.stringify(message.coverage)],
  );
}

/** Deliberately retains request hashes, leases and unknown holds after the user clears chat. */
export async function clearMessages(sql: SqlExecutor, userId: string, projectId: string): Promise<void> {
  await sql.query("DELETE FROM team_assistant_messages WHERE user_id=$1 AND project_id=$2", [userId, projectId]);
}
