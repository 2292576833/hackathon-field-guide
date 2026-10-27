import type { Clock, IdGenerator, PlatformRole } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AccountStorePort, AccountTransaction } from "./account-ports.ts";
import type { AccountDeletionRequest, EmailChangeChallenge, StoredDataExport } from "./account-types.ts";
import type { AccountStatus, AuthUserRecord, SessionContext, SessionRecord } from "./types.ts";

type Timestamp = Date | string;
interface UserRow {
  id: string; email: string; display_name: string; timezone: string; status: AccountStatus;
  platform_roles: PlatformRole[]; email_verified_at: Timestamp; created_at: Timestamp; revision: number;
}
interface SessionRow {
  id: string; user_id: string; token_hash: string; created_at: Timestamp; authenticated_at: Timestamp;
  expires_at: Timestamp; revoked_at: Timestamp | null; last_seen_at: Timestamp;
}
interface RateRow { key: string; window_started_at: Timestamp; attempts: number; last_attempt_at: Timestamp | null }
interface BodyRow<T> { body: T | string }
type RateRule = Parameters<AccountTransaction["takeRates"]>[0][number];
const iso = (value: Timestamp): string => new Date(value).toISOString();
const time = (value: Timestamp): number => new Date(value).getTime();
const decode = <T>(row: BodyRow<T>): T => typeof row.body === "string" ? JSON.parse(row.body) as T : row.body;
function userRecord(row: UserRow): AuthUserRecord {
  return { id: row.id, email: row.email, displayName: row.display_name, timezone: row.timezone,
    status: row.status, platformRoles: row.platform_roles, emailVerifiedAt: iso(row.email_verified_at),
    createdAt: iso(row.created_at), revision: row.revision };
}
function sessionRecord(row: SessionRow): SessionRecord {
  return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, createdAt: iso(row.created_at),
    authenticatedAt: iso(row.authenticated_at), expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at), lastSeenAt: iso(row.last_seen_at) };
}
function unauthenticated(): DomainError {
  return new DomainError("AUTH_SESSION_REQUIRED", "登录已失效，请重新登录。", { status: 401, recoveryAction: "login" });
}
function conflict(): DomainError {
  return new DomainError("VERSION_CONFLICT", "账号申请已更新，请查看最新状态后重试。", { status: 409, recoveryAction: "review_latest_version" });
}
function invalid(): DomainError {
  return new DomainError("ACCOUNT_RECORD_INVALID", "账号申请无效，请重新操作。", { status: 422 });
}

/** All owner reads/writes share the root executor and the auth user -> session lock order. */
export class PostgresAccountStore implements AccountStorePort {
  private readonly db: DatabasePort;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  constructor(db: DatabasePort, ids: IdGenerator, clock: Clock = { now: () => new Date() }) {
    this.db = db; this.ids = ids; this.clock = clock;
  }

  /** Server-only retention worker: clear expired private bodies without deleting request metadata. */
  async clearExpiredExportDocuments(maximum = 100): Promise<number> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) {
      throw new DomainError("ACCOUNT_EXPORT_CLEANUP_LIMIT_INVALID", "导出清理批次须为 1 至 1000 条。", { status: 422 });
    }
    return this.db.transaction(async executor => {
      const cutoff = this.clock.now().toISOString();
      // Only export rows are locked. Never acquire auth user/session locks after these rows.
      const expired = await executor.query<{ id: string }>(
        `SELECT id FROM auth_data_exports WHERE expires_at <= $1 AND body->>'status' <> 'expired'
         ORDER BY expires_at ASC, id ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, [cutoff, maximum],
      );
      if (expired.rows.length === 0) return 0;
      const result = await executor.query(
        `UPDATE auth_data_exports SET body = body || jsonb_build_object(
           'status', 'expired', 'document', NULL, 'byteLength', NULL,
           'revision', (body->>'revision')::integer + 1, 'updatedAt', $2::text)
         WHERE id = ANY($1::text[]) AND expires_at <= $3::timestamptz AND body->>'status' <> 'expired'
         RETURNING id`, [expired.rows.map(row => row.id), this.clock.now().toISOString(), cutoff],
      );
      return result.rowCount;
    });
  }

  async withSession<T>(tokenHash: string, work: (transaction: AccountTransaction) => Promise<T>, mailboxLocks: readonly string[] = []): Promise<T> {
    return this.db.transaction(async executor => {
      // This is only a hint: both records are re-read under locks below.
      const hint = (await executor.query<{ user_id: string; email: string }>(
        `SELECT s.user_id, u.email FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
         WHERE s.token_hash = $1`, [tokenHash],
      )).rows[0];
      if (!hint) throw unauthenticated();
      const lockedEmails = new Set<string>();
      if (mailboxLocks.length > 0) {
        for (const email of [...new Set([hint.email, ...mailboxLocks])].sort()) {
          if (email !== email.toLowerCase() || email.length > 254) throw invalid();
          await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`auth-email:${email}`]);
          lockedEmails.add(email);
        }
      }
      const user = (await executor.query<UserRow>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [hint.user_id])).rows[0];
      if (!user || user.status !== "active" || user.email !== hint.email) throw unauthenticated();
      const session = (await executor.query<SessionRow>("SELECT * FROM auth_sessions WHERE token_hash = $1 FOR UPDATE", [tokenHash])).rows[0];
      const now = this.clock.now().toISOString();
      if (!session || session.user_id !== user.id || session.revoked_at !== null || time(session.expires_at) <= time(now)) throw unauthenticated();
      const touched = (await executor.query<{ last_seen_at: Timestamp }>(
        "UPDATE auth_sessions SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz) WHERE id = $1 RETURNING last_seen_at", [session.id, now],
      )).rows[0];
      if (!touched || time(session.expires_at) <= this.clock.now().getTime()) throw unauthenticated();
      const context: SessionContext = { user: userRecord(user), session: { ...sessionRecord(session), lastSeenAt: iso(touched.last_seen_at) } };
      return work(this.transaction(executor, context, lockedEmails, false));
    });
  }

  async withUser<T>(userId: string, work: (transaction: AccountTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async executor => {
      const row = (await executor.query<UserRow>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [userId])).rows[0];
      if (!row || row.status !== "active") throw unauthenticated();
      const now = this.clock.now().toISOString();
      // Never an authentication grant. This context is only accessible to server workers.
      const session: SessionRecord = { id: "", userId, tokenHash: "", createdAt: now, authenticatedAt: now,
        expiresAt: now, revokedAt: null, lastSeenAt: now };
      return work(this.transaction(executor, { user: userRecord(row), session }, new Set(), true));
    });
  }

  private transaction(executor: SqlExecutor, context: SessionContext, lockedEmails: ReadonlySet<string>, serverOnly: boolean): AccountTransaction {
    const owner = context.user.id;
    const own = (record: { readonly userId: string; readonly id: string }): void => {
      if (record.userId !== owner || !record.id || record.id.length > 200) throw invalid();
    };
    const version = (revision: number): void => { if (!Number.isSafeInteger(revision) || revision < 1) throw invalid(); };
    const audit = async (action: string, objectType: string, objectId: string, result: string): Promise<void> => {
      await executor.query(
        "INSERT INTO auth_audit_events (id, actor_id, action, object_type, object_id, result, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [this.ids.next(), owner, action, objectType, objectId, result, this.clock.now().toISOString()],
      );
    };
    return {
      executor, context,
      now: () => this.clock.now().toISOString(),
      assertSession: async () => {
        const user = (await executor.query<UserRow>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [owner])).rows[0];
        if (!user || user.status !== "active") throw unauthenticated();
        if (!serverOnly) {
          const session = (await executor.query<SessionRow>("SELECT * FROM auth_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [context.session.id, owner])).rows[0];
          if (!session || session.token_hash !== context.session.tokenHash || session.revoked_at !== null
            || time(session.expires_at) <= this.clock.now().getTime()) throw unauthenticated();
        }
      },
      takeRates: async rules => {
        const rows = new Map<string, RateRow>();
        const uniqueRules = new Map<string, RateRule>();
        for (const rule of rules) {
          if (!rule.key || uniqueRules.has(rule.key) || !Number.isSafeInteger(rule.maximum) || rule.maximum < 1
            || !Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1
            || (rule.cooldownMs !== undefined && (!Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 0))) throw invalid();
          uniqueRules.set(rule.key, rule);
        }
        for (const key of [...uniqueRules.keys()].sort()) {
          await executor.query("INSERT INTO auth_rate_limits (key, window_started_at, attempts) VALUES ($1, $2, 0) ON CONFLICT (key) DO NOTHING", [key, this.clock.now().toISOString()]);
          const row = (await executor.query<RateRow>("SELECT * FROM auth_rate_limits WHERE key = $1 FOR UPDATE", [key])).rows[0];
          if (!row) throw invalid();
          rows.set(key, row);
        }
        // Recompute after every lock wait, then check every rule before incrementing any.
        const now = this.clock.now().toISOString();
        for (const [key, rule] of uniqueRules) {
          const row = rows.get(key)!;
          const attempts = time(now) - time(row.window_started_at) >= rule.windowMs ? 0 : row.attempts;
          if (attempts >= rule.maximum || (row.last_attempt_at !== null && time(now) - time(row.last_attempt_at) < (rule.cooldownMs ?? 0))) return false;
        }
        for (const key of [...uniqueRules.keys()].sort()) {
          const rule = uniqueRules.get(key)!; const row = rows.get(key)!;
          const reset = time(now) - time(row.window_started_at) >= rule.windowMs;
          await executor.query("UPDATE auth_rate_limits SET window_started_at = $2, attempts = $3, last_attempt_at = $4 WHERE key = $1",
            [key, reset ? now : iso(row.window_started_at), reset ? 1 : row.attempts + 1, now]);
        }
        return true;
      },
      listExports: async () => (await executor.query<BodyRow<StoredDataExport>>(
        `SELECT body - 'document' || '{"document":null}'::jsonb AS body FROM auth_data_exports
         WHERE user_id = $1 ORDER BY created_at DESC, id ASC LIMIT 20`, [owner],
      )).rows.map(decode),
      getExport: async id => {
        const row = (await executor.query<BodyRow<StoredDataExport>>("SELECT body FROM auth_data_exports WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, owner])).rows[0];
        return row ? decode(row) : null;
      },
      saveExport: async record => {
        own(record); version(record.revision);
        const values = [record.id, owner, JSON.stringify(record), record.createdAt, record.expiresAt];
        const result = record.revision === 1
          ? await executor.query("INSERT INTO auth_data_exports (id, user_id, body, created_at, expires_at) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT DO NOTHING RETURNING id", values)
          : await executor.query(
            `UPDATE auth_data_exports SET body = $3::jsonb WHERE id = $1 AND user_id = $2
             AND created_at = $4 AND expires_at = $5 AND (body->>'revision')::integer = $6 RETURNING id`, [...values, record.revision - 1]);
        if (result.rowCount !== 1) throw conflict();
      },
      getDeletion: async id => {
        const row = id === undefined
          ? (await executor.query<BodyRow<AccountDeletionRequest>>("SELECT body FROM auth_deletion_requests WHERE user_id = $1 ORDER BY (status <> 'cancelled') DESC, created_at DESC, id DESC LIMIT 1 FOR UPDATE", [owner])).rows[0]
          : (await executor.query<BodyRow<AccountDeletionRequest>>("SELECT body FROM auth_deletion_requests WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, owner])).rows[0];
        return row ? decode(row) : null;
      },
      saveDeletion: async record => {
        own(record); version(record.revision);
        const values = [record.id, owner, JSON.stringify(record), record.createdAt, record.status];
        const result = record.revision === 1
          ? await executor.query("INSERT INTO auth_deletion_requests (id, user_id, body, created_at, status) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT DO NOTHING RETURNING id", values)
          : await executor.query(
            `UPDATE auth_deletion_requests SET body = $3::jsonb, status = $5 WHERE id = $1 AND user_id = $2
             AND created_at = $4 AND (body->>'revision')::integer = $6 RETURNING id`, [...values, record.revision - 1]);
        if (result.rowCount !== 1) throw conflict();
      },
      getEmailChallenge: async id => {
        const row = (await executor.query<BodyRow<EmailChangeChallenge>>("SELECT body FROM auth_email_change_challenges WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, owner])).rows[0];
        return row ? decode(row) : null;
      },
      saveEmailChallenge: async record => {
        own(record);
        const result = await executor.query(
          `INSERT INTO auth_email_change_challenges (id, user_id, body, old_email, new_email, created_at, expires_at, consumed_at, revoked_at)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, consumed_at = EXCLUDED.consumed_at, revoked_at = EXCLUDED.revoked_at
           WHERE auth_email_change_challenges.user_id = EXCLUDED.user_id
             AND auth_email_change_challenges.old_email = EXCLUDED.old_email AND auth_email_change_challenges.new_email = EXCLUDED.new_email
             AND auth_email_change_challenges.created_at = EXCLUDED.created_at AND auth_email_change_challenges.expires_at = EXCLUDED.expires_at
             AND auth_email_change_challenges.body->>'expectedRevision' = EXCLUDED.body->>'expectedRevision'
             AND auth_email_change_challenges.body->>'currentCodeHash' = EXCLUDED.body->>'currentCodeHash'
             AND auth_email_change_challenges.body->>'newCodeHash' = EXCLUDED.body->>'newCodeHash'
             AND (auth_email_change_challenges.body->>'failedAttempts')::integer <= (EXCLUDED.body->>'failedAttempts')::integer
             AND (auth_email_change_challenges.consumed_at IS NULL OR auth_email_change_challenges.consumed_at = EXCLUDED.consumed_at)
             AND (auth_email_change_challenges.revoked_at IS NULL OR auth_email_change_challenges.revoked_at = EXCLUDED.revoked_at)
             AND ((auth_email_change_challenges.consumed_at IS NULL AND auth_email_change_challenges.revoked_at IS NULL)
               OR auth_email_change_challenges.body = EXCLUDED.body)
             AND (auth_email_change_challenges.body->>'delivery' = 'pending' OR auth_email_change_challenges.body->>'delivery' = EXCLUDED.body->>'delivery')
           RETURNING id`,
          [record.id, owner, JSON.stringify(record), record.oldEmail, record.newEmail, record.createdAt, record.expiresAt, record.consumedAt, record.revokedAt],
        );
        if (result.rowCount !== 1) throw conflict();
      },
      revokeEmailChallenges: async () => {
        await executor.query(
          `UPDATE auth_email_change_challenges SET revoked_at = $2::text::timestamptz,
           body = jsonb_set(body, '{revokedAt}', to_jsonb($2::text))
           WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [owner, this.clock.now().toISOString()],
        );
      },
      changeEmail: async (email, expectedRevision) => {
        if (!lockedEmails.has(context.user.email) || !lockedEmails.has(email)) throw invalid();
        const current = (await executor.query<UserRow>("SELECT * FROM auth_users WHERE id = $1 FOR UPDATE", [owner])).rows[0];
        if (!current || current.status !== "active") throw unauthenticated();
        if (current.revision !== expectedRevision || current.email !== context.user.email) return "version_conflict";
        const other = await executor.query("SELECT id FROM auth_users WHERE email = $1 AND id <> $2", [email, owner]);
        if (other.rowCount > 0) return "email_conflict";
        await executor.query("SAVEPOINT account_email_change");
        let updated: UserRow | undefined;
        try {
          updated = (await executor.query<UserRow>(
            `UPDATE auth_users SET email = $2, email_verified_at = $3, revision = revision + 1
             WHERE id = $1 AND revision = $4 AND status = 'active' RETURNING *`, [owner, email, this.clock.now().toISOString(), expectedRevision],
          )).rows[0];
        } catch (error) {
          await executor.query("ROLLBACK TO SAVEPOINT account_email_change");
          await executor.query("RELEASE SAVEPOINT account_email_change");
          if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return "email_conflict";
          throw error;
        }
        await executor.query("RELEASE SAVEPOINT account_email_change");
        if (!updated) return "version_conflict";
        const now = this.clock.now().toISOString();
        await executor.query("UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [owner, now]);
        await executor.query("UPDATE auth_login_challenges SET revoked_at = $3 WHERE email IN ($1, $2) AND consumed_at IS NULL AND revoked_at IS NULL", [current.email, email, now]);
        return userRecord(updated);
      },
      beginDeletionProcessing: async () => {
        if (!serverOnly) throw invalid();
        const result = await executor.query(
          "UPDATE auth_users SET status = 'deletion_pending', revision = revision + 1 WHERE id = $1 AND status = 'active' RETURNING id", [owner],
        );
        if (result.rowCount !== 1) throw unauthenticated();
        await executor.query("UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [owner, this.clock.now().toISOString()]);
      },
      audit,
    };
  }
}
