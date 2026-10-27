import type { SqlExecutor } from "../../shared/persistence.ts";
import type { GuanchaAttemptStorePort } from "./ports.ts";
import type { GuanchaLoginAttempt } from "./types.ts";

interface AttemptRow {
  state_hash: string; browser_binding_hash: string; issuer: string; configuration_id: string;
  redirect_uri: string; return_to: string; secret_ciphertext: string;
  created_at: string | Date; expires_at: string | Date;
}

/** Coordinator must use the committed root executor, never an outer transaction
 * kept open across provider I/O. Only this module's state table is touched. */
export class PostgresGuanchaAttemptStore implements GuanchaAttemptStorePort {
  private readonly database: SqlExecutor;
  constructor(database: SqlExecutor) { this.database = database; }

  async save(attempt: GuanchaLoginAttempt): Promise<void> {
    await this.database.query(`INSERT INTO guancha_login_attempts
      (state_hash, browser_binding_hash, issuer, configuration_id, redirect_uri, return_to, secret_ciphertext, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      attempt.stateHash, attempt.browserBindingHash, attempt.issuer, attempt.configurationId,
      attempt.redirectUri, attempt.returnTo, attempt.secretCiphertext, attempt.createdAt, attempt.expiresAt,
    ]);
  }

  async consume(input: Parameters<GuanchaAttemptStorePort["consume"]>[0]): Promise<GuanchaLoginAttempt | null> {
    const result = await this.database.query<AttemptRow>(`WITH candidate AS (
      SELECT * FROM guancha_login_attempts
      WHERE state_hash=$1 AND browser_binding_hash=$2 AND issuer=$3 AND configuration_id=$4
        AND redirect_uri=$5 AND created_at <= $6 AND expires_at > $6 AND consumed_at IS NULL
      FOR UPDATE
    ) UPDATE guancha_login_attempts AS attempts
      SET consumed_at=$6, secret_ciphertext=NULL
      FROM candidate WHERE attempts.state_hash=candidate.state_hash
      RETURNING candidate.state_hash, candidate.browser_binding_hash, candidate.issuer,
        candidate.configuration_id, candidate.redirect_uri, candidate.return_to,
        candidate.secret_ciphertext, candidate.created_at, candidate.expires_at`, [
      input.stateHash, input.browserBindingHash, input.issuer, input.configurationId, input.redirectUri, input.now,
    ]);
    const row = result.rows[0];
    return row ? {
      stateHash: row.state_hash, browserBindingHash: row.browser_binding_hash, issuer: row.issuer,
      configurationId: row.configuration_id, redirectUri: row.redirect_uri, returnTo: row.return_to,
      secretCiphertext: row.secret_ciphertext, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    } : null;
  }
}
