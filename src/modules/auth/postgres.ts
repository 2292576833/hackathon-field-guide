import { timingSafeEqual } from "node:crypto";
import type { Clock, IdGenerator, PlatformRole } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AuthStorePort, ConsumeChallengeResult, ProfileUpdateResult, RevokeSessionsResult } from "./ports.ts";
import type {
  AccountStatus, AuthPolicy, AuthUserRecord, OwnAccountSnapshot, ProfileUpdate, SessionContext,
  SessionRecord, SessionSummary,
} from "./types.ts";

type Timestamp = string | Date;
interface UserRow {
  id: string; email: string; display_name: string; timezone: string; status: AccountStatus;
  platform_roles: PlatformRole[]; email_verified_at: Timestamp; created_at: Timestamp; revision: number;
}
interface SessionRow {
  id: string; user_id: string; token_hash: string; created_at: Timestamp; authenticated_at: Timestamp;
  expires_at: Timestamp; revoked_at: Timestamp | null;
  last_seen_at: Timestamp;
}
interface ChallengeRow {
  id: string; email: string; email_rate_key: string; code_hash: string; expires_at: Timestamp;
  delivery: string; failed_attempts: number; consumed_at: Timestamp | null; revoked_at: Timestamp | null;
  registration_display_name?: string | null;
}
interface RateRow { key: string; window_started_at: Timestamp; attempts: number; last_attempt_at: Timestamp | null }

const iso = (value: Timestamp): string => new Date(value).toISOString();
const millis = (value: Timestamp): number => new Date(value).getTime();
function userRecord(row: UserRow): AuthUserRecord {
  return {
    id: row.id, email: row.email, displayName: row.display_name, timezone: row.timezone,
    status: row.status, platformRoles: row.platform_roles, emailVerifiedAt: iso(row.email_verified_at),
    createdAt: iso(row.created_at), revision: row.revision,
  };
}
function sessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id, userId: row.user_id, tokenHash: row.token_hash,
    createdAt: iso(row.created_at), authenticatedAt: iso(row.authenticated_at),
    expiresAt: iso(row.expires_at), revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}
function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex"); const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

/** Parameterized adapter. DatabasePort must commit results and roll back exceptions. */
export class PostgresAuthStore implements AuthStorePort {
  private readonly db: DatabasePort;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  constructor(db: DatabasePort, ids: IdGenerator, clock: Clock = { now: () => new Date() }) {
    this.db = db; this.ids = ids; this.clock = clock;
  }

  async reserveChallenge(input: Parameters<AuthStorePort["reserveChallenge"]>[0]): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { challenge: challenge, policy } = input;
      // Email lock serializes reserve/consume for one mailbox. Send rate rows are
      // sorted; consume's verify-email rate uses a separate namespace.
      await this.lockEmail(tx, challenge.email);
      const rates = await this.lockRates(tx, [input.emailRateKey, input.clientRateKey], challenge.createdAt);
      const actualNow = this.clock.now().toISOString();
      const emailRate = rates.get(input.emailRateKey)!; const clientRate = rates.get(input.clientRateKey)!;
      if (!this.canTake(emailRate, actualNow, policy.rateWindowMs, policy.maxSendsPerEmail, policy.sendCooldownMs)
          || !this.canTake(clientRate, actualNow, policy.rateWindowMs, policy.maxSendsPerClient)) return false;
      await this.incrementRate(tx, emailRate, actualNow, policy.rateWindowMs);
      await this.incrementRate(tx, clientRate, actualNow, policy.rateWindowMs);
      // Only the newest request for an address is usable, including overlapping mail sends.
      await tx.query("UPDATE auth_login_challenges SET revoked_at = $2 WHERE email = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [challenge.email, actualNow]);
      await tx.query(
        `INSERT INTO auth_login_challenges (id, email, email_rate_key, code_hash, created_at, expires_at, delivery, registration_display_name)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [challenge.id, challenge.email, input.emailRateKey, challenge.codeHash, challenge.createdAt, challenge.expiresAt, challenge.registrationDisplayName ?? null],
      );
      await this.audit(tx, null, "login_challenge_requested", "challenge", challenge.id, "accepted", challenge.createdAt);
      return true;
    });
  }

  async markChallengeDelivery(id: string, delivery: "ready" | "failed", now: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE auth_login_challenges SET delivery = $2
         WHERE id = $1 AND delivery = 'pending' AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > $3
         RETURNING id`, [id, delivery, now],
      );
      if (result.rowCount === 0) return false;
      await this.audit(tx, null, "login_email_delivery", "challenge", id, delivery, now);
      return true;
    });
  }

  async takeVerificationSlot(key: string, now: string, policy: AuthPolicy): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const row = (await this.lockRates(tx, [key], now)).get(key)!;
      const actualNow = this.clock.now().toISOString();
      if (!this.canTake(row, actualNow, policy.rateWindowMs, policy.maxVerificationsPerClient)) return false;
      await this.incrementRate(tx, row, actualNow, policy.rateWindowMs);
      return true;
    });
  }

  async consumeChallenge(input: Parameters<AuthStorePort["consumeChallenge"]>[0]): Promise<ConsumeChallengeResult> {
    return this.db.transaction(async (tx) => {
      // Read without a row lock to discover the email lock; then re-read under that lock.
      const hint = await tx.query<{ email: string }>("SELECT email FROM auth_login_challenges WHERE id = $1", [input.challengeId]);
      if (!hint.rows[0]) return { status: "invalid" };
      await this.lockEmail(tx, hint.rows[0].email);
      const result = await tx.query<ChallengeRow>("SELECT * FROM auth_login_challenges WHERE id = $1 FOR UPDATE", [input.challengeId]);
      const challenge = result.rows[0];
      let actualNow = this.clock.now().toISOString();
      if (!challenge || challenge.delivery !== "ready" || challenge.consumed_at !== null || challenge.revoked_at !== null
          || millis(challenge.expires_at) <= millis(actualNow) || challenge.failed_attempts >= input.policy.maxCodeFailures) return { status: "invalid" };
      // This mailbox limit survives resends, so replacing a code cannot reset guesses.
      const rateKey = `verify-email:${challenge.email_rate_key}`;
      const rate = (await this.lockRates(tx, [rateKey], actualNow)).get(rateKey)!;
      actualNow = this.clock.now().toISOString();
      if (millis(challenge.expires_at) <= millis(actualNow) || !this.canTake(rate, actualNow, input.policy.rateWindowMs, input.policy.maxVerificationsPerEmail)) return { status: "invalid" };
      await this.incrementRate(tx, rate, actualNow, input.policy.rateWindowMs);
      if (!sameHash(challenge.code_hash, input.codeHash)) {
        await tx.query("UPDATE auth_login_challenges SET failed_attempts = failed_attempts + 1 WHERE id = $1", [challenge.id]);
        await this.audit(tx, null, "login_verification", "challenge", challenge.id, "denied", actualNow);
        // Return, never throw here: failed-attempt writes must commit.
        return { status: "invalid" };
      }
      await tx.query("SAVEPOINT auth_verification_account");
      await tx.query(
        `INSERT INTO auth_users (id, email, display_name, display_name_customized, timezone, status, platform_roles, email_verified_at, created_at)
         VALUES ($1, $2, $4, false, 'Asia/Shanghai', 'active', ARRAY['user']::text[], $3, $3)
         ON CONFLICT (email) DO NOTHING`, [input.newUserId, challenge.email, actualNow, challenge.registration_display_name ?? "参赛新人"],
      );
      const users = await tx.query<UserRow>("SELECT * FROM auth_users WHERE email = $1 FOR UPDATE", [challenge.email]);
      const user = users.rows[0];
      actualNow = this.clock.now().toISOString();
      if (millis(challenge.expires_at) <= millis(actualNow)) {
        // Keep the rate fact, but do not create an account for an expired challenge.
        await tx.query("ROLLBACK TO SAVEPOINT auth_verification_account");
        await tx.query("RELEASE SAVEPOINT auth_verification_account");
        return { status: "invalid" };
      }
      if (!user || user.status !== "active") {
        await tx.query("UPDATE auth_login_challenges SET revoked_at = $2 WHERE id = $1", [challenge.id, actualNow]);
        await this.audit(tx, user?.id ?? null, "login_verification", "challenge", challenge.id, "denied", actualNow);
        return { status: "invalid" };
      }
      await tx.query("UPDATE auth_login_challenges SET consumed_at = $2 WHERE id = $1", [challenge.id, actualNow]);
      const session = input.newSession;
      const sessionExpiry = new Date(millis(actualNow) + millis(session.expiresAt) - millis(session.createdAt)).toISOString();
      await tx.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, authenticated_at, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $4)`,
        [session.id, user.id, session.tokenHash, actualNow, actualNow, sessionExpiry],
      );
      await this.audit(tx, user.id, "login_verified", "session", session.id, "succeeded", actualNow);
      await tx.query("RELEASE SAVEPOINT auth_verification_account");
      return { status: "verified", user: userRecord(user), session: { ...session, userId: user.id, createdAt: actualNow, authenticatedAt: actualNow, expiresAt: sessionExpiry, lastSeenAt: actualNow } };
    });
  }

  async getSessionContext(tokenHash: string, now: string): Promise<SessionContext | null> {
    // Check/touch under the same user -> session lock order used by revocation.
    return this.db.transaction((tx) => this.lockContext(tx, tokenHash, now));
  }

  async revokeSessionByToken(tokenHash: string, now: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const hint = await tx.query<{ user_id: string }>("SELECT user_id FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
      if (!hint.rows[0]) return;
      await tx.query("SELECT id FROM auth_users WHERE id = $1 FOR UPDATE", [hint.rows[0].user_id]);
      const result = await tx.query<{ id: string; user_id: string }>(
        "UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, user_id", [tokenHash, now],
      );
      if (result.rows[0]) await this.audit(tx, result.rows[0].user_id, "session_revoked", "session", result.rows[0].id, "succeeded", now);
    });
  }

  async revokeOwnSessions(input: Parameters<AuthStorePort["revokeOwnSessions"]>[0]): Promise<RevokeSessionsResult> {
    return this.db.transaction(async (tx) => {
      const context = await this.lockContext(tx, input.currentTokenHash, input.now);
      if (!context) return { status: "unauthenticated" };
      const actualNow = this.clock.now().toISOString();
      const elapsed = millis(actualNow) - millis(input.now);
      if (input.authenticatedAfter !== null && millis(context.session.authenticatedAt) < millis(input.authenticatedAfter) + elapsed) return { status: "reauthentication_required" };
      const result = await tx.query<{ id: string }>(
        `UPDATE auth_sessions SET revoked_at = $2
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND ($3::text IS NULL OR id = $3) RETURNING id`,
        [context.user.id, actualNow, input.targetSessionId],
      );
      for (const row of result.rows) await this.audit(tx, context.user.id, "session_revoked", "session", row.id, "succeeded", actualNow);
      // Foreign/nonexistent session IDs are indistinguishable idempotent no-ops.
      return { status: "revoked", revoked: result.rows.length > 0, currentSessionRevoked: result.rows.some((row) => row.id === context.session.id) };
    });
  }

  async listOwnSessions(tokenHash: string, now: string): Promise<readonly SessionSummary[] | null> {
    const snapshot = await this.getOwnAccountSnapshot(tokenHash, now);
    return snapshot?.sessions ?? null;
  }

  async getOwnAccountSnapshot(tokenHash: string, now: string): Promise<OwnAccountSnapshot | null> {
    return this.db.transaction(async (tx) => {
      const context = await this.lockContext(tx, tokenHash, now);
      if (!context) return null;
      const actualNow = this.clock.now().toISOString();
      const result = await tx.query<SessionRow>(
        "SELECT * FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC, id ASC", [context.user.id, actualNow],
      );
      const resultTime = this.clock.now().getTime();
      if (millis(context.session.expiresAt) <= resultTime) return null;
      const sessions = result.rows.filter((row) => millis(row.expires_at) > resultTime).map((row) => ({
        id: row.id, createdAt: iso(row.created_at), authenticatedAt: iso(row.authenticated_at), expiresAt: iso(row.expires_at), current: row.id === context.session.id,
        lastSeenAt: row.id === context.session.id ? context.session.lastSeenAt : iso(row.last_seen_at),
      }));
      return { user: context.user, currentSession: context.session, sessions };
    });
  }

  async updateOwnProfile(tokenHash: string, input: ProfileUpdate, now: string): Promise<ProfileUpdateResult> {
    return this.db.transaction(async (tx) => {
      const context = await this.lockContext(tx, tokenHash, now);
      if (!context) return { status: "unauthenticated" };
      if (context.user.revision !== input.expectedRevision) return { status: "conflict", latestRevision: context.user.revision };
      const result = await tx.query<UserRow>(
        "UPDATE auth_users SET display_name = $2, display_name_customized = true, timezone = $3, revision = revision + 1 WHERE id = $1 AND revision = $4 RETURNING *",
        [context.user.id, input.displayName, input.timezone, input.expectedRevision],
      );
      await this.audit(tx, context.user.id, "profile_updated", "user", context.user.id, "succeeded", this.clock.now().toISOString());
      return { status: "updated", user: userRecord(result.rows[0]!) };
    });
  }

  private async lockEmail(tx: SqlExecutor, email: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`auth-email:${email}`]);
  }

  private async lockContext(tx: SqlExecutor, tokenHash: string, now: string): Promise<SessionContext | null> {
    const hint = await tx.query<{ user_id: string }>("SELECT user_id FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
    if (!hint.rows[0]) return null;
    // User first, then session: same order as login and all-device revocation.
    const users = await tx.query<UserRow>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [hint.rows[0].user_id]);
    const user = users.rows[0];
    if (!user || user.status !== "active") return null;
    const sessions = await tx.query<SessionRow>("SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE", [tokenHash]);
    const session = sessions.rows[0];
    const actualNow = this.clock.now().toISOString();
    if (!session || session.revoked_at !== null || millis(session.expires_at) <= millis(actualNow)) return null;
    const touched = await tx.query<{ last_seen_at: Timestamp }>(
      "UPDATE auth_sessions SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz) WHERE id = $1 RETURNING last_seen_at", [session.id, actualNow],
    );
    if (millis(session.expires_at) <= this.clock.now().getTime()) return null;
    return { user: userRecord(user), session: { ...sessionRecord(session), lastSeenAt: iso(touched.rows[0]!.last_seen_at) } };
  }

  private async lockRates(tx: SqlExecutor, keys: readonly string[], now: string): Promise<Map<string, RateRow>> {
    const rows = new Map<string, RateRow>();
    for (const key of [...new Set(keys)].sort()) {
      await tx.query("INSERT INTO auth_rate_limits (key, window_started_at, attempts) VALUES ($1, $2, 0) ON CONFLICT (key) DO NOTHING", [key, now]);
      const result = await tx.query<RateRow>("SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE", [key]);
      rows.set(key, result.rows[0]!);
    }
    return rows;
  }

  private canTake(row: RateRow, now: string, windowMs: number, max: number, cooldownMs = 0): boolean {
    const attempts = millis(now) - millis(row.window_started_at) >= windowMs ? 0 : row.attempts;
    return attempts < max && (row.last_attempt_at === null || millis(now) - millis(row.last_attempt_at) >= cooldownMs);
  }

  private async incrementRate(tx: SqlExecutor, row: RateRow, now: string, windowMs: number): Promise<void> {
    const reset = millis(now) - millis(row.window_started_at) >= windowMs;
    await tx.query("UPDATE auth_rate_limits SET window_started_at = $2, attempts = $3, last_attempt_at = $4 WHERE key = $1", [row.key, reset ? now : iso(row.window_started_at), reset ? 1 : row.attempts + 1, now]);
  }

  private async audit(tx: SqlExecutor, actorId: string | null, action: string, objectType: string, objectId: string, result: string, now: string): Promise<void> {
    await tx.query(
      "INSERT INTO auth_audit_events (id, actor_id, action, object_type, object_id, result, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [this.ids.next(), actorId, action, objectType, objectId, result, now],
    );
  }
}
