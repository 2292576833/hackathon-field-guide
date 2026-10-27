import { randomUUID } from "node:crypto";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AuthorizationStorePort, EncryptedValue, StoredAuthorizationState, StoredGitHubCredential } from "./authorization-types.ts";

const CREDENTIAL_COLUMNS = "user_id,app_id,github_user_id,github_login,encrypted_tokens,access_expires_at,refresh_expires_at,status,revision,refresh_lease_until,checked_at";
const STATE_COLUMNS = "state_hash,user_id,app_id,browser_hash,encrypted_verifier,project_id,return_to,created_at,expires_at,authorization_epoch,flow";
const HASH = /^[a-f0-9]{64}$/u;
const MAX_REVISION = 2_147_483_647;
const ownErrors: Record<string, { message: string; status: number }> = {
  VERSION_CONFLICT: { message: "GitHub 授权记录已更新，请读取最新状态。", status: 409 },
  AUTHORIZATION_EPOCH_CHANGED: { message: "此授权流程已失效，请重新连接 GitHub。", status: 409 },
  AUTHORIZATION_STATE_CONFLICT: { message: "此授权流程已存在，请重新开始授权。", status: 409 },
  GITHUB_REVOCATION_IN_PROGRESS: { message: "GitHub 授权正在解除，请稍后重新连接。", status: 409 },
  GITHUB_ACCOUNT_ALREADY_BOUND: { message: "此 GitHub 账号已绑定其他本站账号，请先解除原绑定。", status: 409 },
  GITHUB_AUTHORIZATION_STORE_INPUT_INVALID: { message: "授权存储输入不符合要求。", status: 422 },
  GITHUB_AUTHORIZATION_STORE_UNAVAILABLE: { message: "授权记录暂时无法读取或保存，请稍后重试。", status: 503 },
};
function failure(code: keyof typeof ownErrors): DomainError {
  const entry = ownErrors[code];
  return new DomainError(code, entry.message, { status: entry.status, recoveryAction: code === "GITHUB_REVOCATION_IN_PROGRESS" ? "retry_later" : code === "AUTHORIZATION_EPOCH_CHANGED" ? "reauthorize_github" : code === "VERSION_CONFLICT" ? "review_latest_version" : undefined });
}
function invalid(): never { throw failure("GITHUB_AUTHORIZATION_STORE_INPUT_INVALID"); }
function finiteInteger(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
}
function boundedText(value: unknown, bytes: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > bytes || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid();
}
function scope(userId: unknown, appId: unknown): void { boundedText(userId, 256); finiteInteger(appId); }
function instant(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 40 || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) invalid();
}
function timestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) invalid();
  return date.toISOString();
}
function integer(value: number | string, minimum = 1): number {
  const number = typeof value === "string" ? Number(value) : value;
  finiteInteger(number, minimum); return number;
}
function envelope(value: EncryptedValue | string): EncryptedValue {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "data,iv,keyId,tag" || typeof object.keyId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(object.keyId)) invalid();
  function field(name: "iv" | "tag" | "data", minimum: number, maximum: number): string {
    const text = object[name];
    if (typeof text !== "string" || text.length > Math.ceil(maximum / 3) * 4 || text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)) invalid();
    const bytes = Buffer.from(text, "base64");
    if (bytes.length < minimum || bytes.length > maximum || bytes.toString("base64") !== text) invalid();
    return text;
  }
  return { keyId: object.keyId, iv: field("iv", 12, 12), tag: field("tag", 16, 16), data: field("data", 1, 65_536) };
}
type StateRow = { state_hash: string; user_id: string; app_id: number | string; browser_hash: string; encrypted_verifier: EncryptedValue | string; project_id: string | null; return_to: string; created_at: string | Date; expires_at: string | Date; authorization_epoch: number | string; flow: StoredAuthorizationState["flow"] };
type CredentialRow = { user_id: string; app_id: number | string; github_user_id: number | string; github_login: string; encrypted_tokens: EncryptedValue | string | null; access_expires_at: string | Date; refresh_expires_at: string | Date; status: StoredGitHubCredential["status"]; revision: number; refresh_lease_until: string | Date | null; checked_at: string | Date };
function readState(row: StateRow): StoredAuthorizationState {
  return { stateHash: row.state_hash, userId: row.user_id, appId: integer(row.app_id), browserHash: row.browser_hash, encryptedVerifier: envelope(row.encrypted_verifier), projectId: row.project_id, returnTo: row.return_to, createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at), authorizationEpoch: integer(row.authorization_epoch, 0), flow: row.flow };
}
function readCredential(row: CredentialRow): StoredGitHubCredential {
  return { userId: row.user_id, appId: integer(row.app_id), githubUserId: integer(row.github_user_id), githubLogin: row.github_login, encryptedTokens: row.encrypted_tokens === null ? null : envelope(row.encrypted_tokens), accessExpiresAt: timestamp(row.access_expires_at), refreshExpiresAt: timestamp(row.refresh_expires_at), status: row.status, revision: integer(row.revision), refreshLeaseUntil: row.refresh_lease_until === null ? null : timestamp(row.refresh_lease_until), checkedAt: timestamp(row.checked_at) };
}
function validateCredential(credential: StoredGitHubCredential, expectedRevision: number | null): EncryptedValue | null {
  scope(credential.userId, credential.appId); finiteInteger(credential.githubUserId); boundedText(credential.githubLogin, 100);
  finiteInteger(credential.revision, 1, MAX_REVISION);
  if (expectedRevision === null ? credential.revision !== 1 : !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || credential.revision !== expectedRevision + 1) throw failure("VERSION_CONFLICT");
  instant(credential.accessExpiresAt); instant(credential.refreshExpiresAt); instant(credential.checkedAt);
  if (!["active", "refreshing", "revoked", "reauthorize_required"].includes(credential.status)) invalid();
  if (credential.refreshLeaseUntil !== null) instant(credential.refreshLeaseUntil);
  if ((credential.status === "refreshing") !== (credential.refreshLeaseUntil !== null)) invalid();
  const hasTokens = credential.status === "active" || credential.status === "refreshing";
  if (hasTokens !== (credential.encryptedTokens !== null)) invalid();
  return credential.encryptedTokens === null ? null : envelope(credential.encryptedTokens);
}

/** All credential and epoch mutations lock epoch first; no network calls run in these transactions. */
export class PostgresAuthorizationStore implements AuthorizationStorePort {
  readonly #db: DatabasePort;
  constructor(db: DatabasePort) { this.#db = db; }
  private async run<T>(work: () => Promise<T>, duplicateIdentity = false): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (duplicateIdentity && typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw failure("GITHUB_ACCOUNT_ALREADY_BOUND");
      if (error instanceof DomainError && Object.prototype.hasOwnProperty.call(ownErrors, error.code)) throw failure(error.code);
      throw failure("GITHUB_AUTHORIZATION_STORE_UNAVAILABLE");
    }
  }
  private async lockEpoch(sql: SqlExecutor, userId: string, appId: number): Promise<{ epoch: number; revocationInProgress: boolean }> {
    await sql.query("INSERT INTO m06_github_authorization_epochs (user_id,app_id,authorization_epoch) VALUES ($1,$2,0) ON CONFLICT (user_id,app_id) DO NOTHING", [userId, appId]);
    const result = await sql.query<{ authorization_epoch: string | number; revocation_in_progress: boolean }>("SELECT authorization_epoch,revocation_in_progress FROM m06_github_authorization_epochs WHERE user_id=$1 AND app_id=$2 LIMIT 1 FOR UPDATE", [userId, appId]);
    if (!result.rows[0]) throw failure("GITHUB_AUTHORIZATION_STORE_UNAVAILABLE");
    return { epoch: integer(result.rows[0].authorization_epoch, 0), revocationInProgress: result.rows[0].revocation_in_progress };
  }
  private async audit(sql: SqlExecutor, input: { userId: string; appId: number; githubUserId: number | null; revision: number | null; eventType: string; details: Record<string, string | number | null> }): Promise<void> {
    await sql.query("INSERT INTO m06_github_authorization_events (id,user_id,app_id,github_user_id,credential_revision,event_type,details) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)", [randomUUID(), input.userId, input.appId, input.githubUserId, input.revision, input.eventType, JSON.stringify(input.details)]);
  }
  async getAuthorizationEpoch(userId: string, appId: number): Promise<number> {
    scope(userId, appId);
    return this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, userId, appId);
      if (gate.revocationInProgress) throw failure("GITHUB_REVOCATION_IN_PROGRESS");
      return gate.epoch;
    }));
  }
  async insertState(state: StoredAuthorizationState): Promise<void> {
    scope(state.userId, state.appId); finiteInteger(state.authorizationEpoch, 0);
    if (state.flow !== "authorization" && state.flow !== "installation") invalid();
    if (!HASH.test(state.stateHash) || !HASH.test(state.browserHash)) invalid();
    instant(state.createdAt); instant(state.expiresAt);
    if (Date.parse(state.expiresAt) <= Date.parse(state.createdAt)) invalid();
    boundedText(state.returnTo, 2_048);
    if (!state.returnTo.startsWith("/") || state.returnTo.startsWith("//") || state.returnTo.includes("\\")) invalid();
    if (state.projectId !== null) boundedText(state.projectId, 256);
    const encrypted = envelope(state.encryptedVerifier);
    await this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, state.userId, state.appId);
      if (gate.revocationInProgress) throw failure("GITHUB_REVOCATION_IN_PROGRESS");
      if (gate.epoch !== state.authorizationEpoch) throw failure("AUTHORIZATION_EPOCH_CHANGED");
      const inserted = await sql.query("INSERT INTO m06_github_authorization_states (state_hash,user_id,app_id,browser_hash,encrypted_verifier,project_id,return_to,created_at,expires_at,authorization_epoch,flow) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11) ON CONFLICT (state_hash) DO NOTHING RETURNING state_hash", [state.stateHash, state.userId, state.appId, state.browserHash, JSON.stringify(encrypted), state.projectId, state.returnTo, state.createdAt, state.expiresAt, state.authorizationEpoch, state.flow]);
      if (inserted.rowCount !== 1) throw failure("AUTHORIZATION_STATE_CONFLICT");
    }));
  }
  async consumeState(input: { stateHash: string; userId: string; appId: number; browserHash: string; flow: StoredAuthorizationState["flow"]; now: string }): Promise<StoredAuthorizationState | null> {
    scope(input.userId, input.appId); instant(input.now);
    if (!HASH.test(input.stateHash) || !HASH.test(input.browserHash)) invalid();
    if (input.flow !== "authorization" && input.flow !== "installation") invalid();
    return this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, input.userId, input.appId);
      if (gate.revocationInProgress) throw failure("GITHUB_REVOCATION_IN_PROGRESS");
      const result = await sql.query<StateRow>(`DELETE FROM m06_github_authorization_states WHERE state_hash=$1 AND user_id=$2 AND app_id=$3 AND browser_hash=$4 AND expires_at>$5::timestamptz AND flow=$6 RETURNING ${STATE_COLUMNS}`, [input.stateHash, input.userId, input.appId, input.browserHash, input.now, input.flow]);
      return result.rows[0] ? readState(result.rows[0]) : null;
    }));
  }
  async getCredential(userId: string, appId: number): Promise<StoredGitHubCredential | null> {
    scope(userId, appId);
    return this.run(async () => {
      const result = await this.#db.query<CredentialRow>(`SELECT ${CREDENTIAL_COLUMNS} FROM m06_github_authorization_credentials WHERE user_id=$1 AND app_id=$2 LIMIT 1`, [userId, appId]);
      return result.rows[0] ? readCredential(result.rows[0]) : null;
    });
  }
  async saveCredential(credential: StoredGitHubCredential, expectedRevision: number | null, expectedAuthorizationEpoch?: number): Promise<void> {
    const encrypted = validateCredential(credential, expectedRevision);
    if (expectedAuthorizationEpoch !== undefined) finiteInteger(expectedAuthorizationEpoch, 0);
    await this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, credential.userId, credential.appId);
      if (expectedAuthorizationEpoch !== undefined && gate.revocationInProgress) throw failure("GITHUB_REVOCATION_IN_PROGRESS");
      if (expectedAuthorizationEpoch !== undefined && gate.epoch !== expectedAuthorizationEpoch) throw failure("AUTHORIZATION_EPOCH_CHANGED");
      let previousStatus: StoredGitHubCredential["status"] | null = null;
      if (expectedRevision !== null) {
        const prior = await sql.query<{ status: StoredGitHubCredential["status"] }>("SELECT status FROM m06_github_authorization_credentials WHERE user_id=$1 AND app_id=$2 AND revision=$3 LIMIT 1 FOR UPDATE", [credential.userId, credential.appId, expectedRevision]);
        if (!prior.rows[0]) throw failure("VERSION_CONFLICT");
        previousStatus = prior.rows[0].status;
      }
      const values = [credential.userId, credential.appId, credential.githubUserId, credential.githubLogin, encrypted === null ? null : JSON.stringify(encrypted), credential.accessExpiresAt, credential.refreshExpiresAt, credential.status, credential.revision, credential.refreshLeaseUntil, credential.checkedAt];
      const result = expectedRevision === null
        ? await sql.query("INSERT INTO m06_github_authorization_credentials (user_id,app_id,github_user_id,github_login,encrypted_tokens,access_expires_at,refresh_expires_at,status,revision,refresh_lease_until,checked_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7::timestamptz,$8,$9,$10::timestamptz,$11::timestamptz) ON CONFLICT (user_id,app_id) DO NOTHING RETURNING revision", values)
        : await sql.query("UPDATE m06_github_authorization_credentials SET github_user_id=$3,github_login=$4,encrypted_tokens=$5::jsonb,access_expires_at=$6::timestamptz,refresh_expires_at=$7::timestamptz,status=$8,revision=$9,refresh_lease_until=$10::timestamptz,checked_at=$11::timestamptz WHERE user_id=$1 AND app_id=$2 AND revision=$12 RETURNING revision", [...values, expectedRevision]);
      if (result.rowCount !== 1) throw failure("VERSION_CONFLICT");
      const eventType = credential.status === "revoked" ? "GitHubAuthorizationRevoked" : credential.status === "reauthorize_required" ? "GitHubReauthorizationRequired" : previousStatus === "refreshing" && credential.status === "active" ? "GitHubTokensRefreshed" : "GitHubAuthorizationBound";
      await this.audit(sql, { userId: credential.userId, appId: credential.appId, githubUserId: credential.githubUserId, revision: credential.revision, eventType, details: { status: credential.status, previousStatus, authorizationEpoch: gate.epoch } });
    }), true);
  }
  async revokeCredential(userId: string, appId: number, expectedRevision: number | null): Promise<number> {
    scope(userId, appId);
    if (expectedRevision !== null) finiteInteger(expectedRevision, 1, MAX_REVISION - 1);
    return this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, userId, appId);
      const result = await sql.query<{ revision: number; github_user_id: number | string }>("SELECT revision,github_user_id FROM m06_github_authorization_credentials WHERE user_id=$1 AND app_id=$2 LIMIT 1 FOR UPDATE", [userId, appId]);
      const current = result.rows[0];
      if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) throw failure("VERSION_CONFLICT");
      await sql.query("UPDATE m06_github_authorization_epochs SET authorization_epoch=authorization_epoch+1,revocation_in_progress=TRUE WHERE user_id=$1 AND app_id=$2 AND authorization_epoch=$3", [userId, appId, gate.epoch]);
      await sql.query("DELETE FROM m06_github_authorization_states WHERE user_id=$1 AND app_id=$2", [userId, appId]);
      if (current) {
        const updated = await sql.query("UPDATE m06_github_authorization_credentials SET status='revoked',encrypted_tokens=NULL,refresh_lease_until=NULL,revocation_pending=TRUE,revision=revision+1,checked_at=now() WHERE user_id=$1 AND app_id=$2 AND revision=$3 RETURNING revision", [userId, appId, expectedRevision]);
        if (updated.rowCount !== 1) throw failure("VERSION_CONFLICT");
      }
      await this.audit(sql, { userId, appId, githubUserId: current ? integer(current.github_user_id) : null, revision: current ? current.revision + 1 : null, eventType: "GitHubAuthorizationRevoked", details: { status: "revoked", authorizationEpoch: gate.epoch + 1 } });
      return gate.epoch + 1;
    }));
  }
  async finishRevocation(userId: string, appId: number, expectedEpoch: number): Promise<void> {
    scope(userId, appId); finiteInteger(expectedEpoch);
    await this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, userId, appId);
      if (gate.epoch !== expectedEpoch) throw failure("VERSION_CONFLICT");
      if (!gate.revocationInProgress) return;
      const finished = await sql.query("UPDATE m06_github_authorization_epochs SET revocation_in_progress=FALSE WHERE user_id=$1 AND app_id=$2 AND authorization_epoch=$3 AND revocation_in_progress=TRUE RETURNING authorization_epoch", [userId, appId, expectedEpoch]);
      if (finished.rowCount !== 1) throw failure("VERSION_CONFLICT");
      await sql.query("UPDATE m06_github_authorization_credentials SET revocation_pending=FALSE WHERE user_id=$1 AND app_id=$2", [userId, appId]);
    }));
  }
  async claimRefresh(userId: string, appId: number, expectedRevision: number, leaseUntil: string): Promise<StoredGitHubCredential | null> {
    scope(userId, appId); finiteInteger(expectedRevision, 1, MAX_REVISION - 1); instant(leaseUntil);
    return this.run(() => this.#db.transaction(async sql => {
      const gate = await this.lockEpoch(sql, userId, appId);
      const claimed = await sql.query<CredentialRow>(`UPDATE m06_github_authorization_credentials SET status='refreshing',revision=revision+1,refresh_lease_until=$4::timestamptz WHERE user_id=$1 AND app_id=$2 AND revision=$3 AND status='active' AND encrypted_tokens IS NOT NULL RETURNING ${CREDENTIAL_COLUMNS}`, [userId, appId, expectedRevision, leaseUntil]);
      if (!claimed.rows[0]) return null;
      const credential = readCredential(claimed.rows[0]);
      await this.audit(sql, { userId, appId, githubUserId: credential.githubUserId, revision: credential.revision, eventType: "GitHubRefreshClaimed", details: { status: "refreshing", leaseUntil, authorizationEpoch: gate.epoch } });
      return credential;
    }));
  }
  async purgeExpiredStates(now: string): Promise<number> {
    instant(now);
    return this.run(async () => (await this.#db.query("DELETE FROM m06_github_authorization_states WHERE expires_at<=$1::timestamptz", [now])).rowCount);
  }
}
